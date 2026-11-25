//! Fluid, work-conserving production. Availability is shared by all consumers,
//! never chosen independently for each profitable recipe.
use super::*;

fn variable(model: &mut Model, integer: bool, maximum: f64) -> usize {
    model.add(0.0, (0.0, maximum), integer, VarKind::Extra)
}

/// Availability may fall below one only when the corresponding capacity is
/// exhausted. `remaining` is supply minus consumption, BEFORE optional sales.
fn availability(model: &mut Model, remaining: Vec<(usize, f64)>, constant: f64, maximum: f64) -> usize {
    let factor = variable(model, false, 1.0);
    let depleted = variable(model, true, 1.0);
    model.constrain(vec![(factor, 1.0), (depleted, 1.0)], ComparisonOp::Ge, 1.0);
    let mut terms = remaining;
    terms.push((depleted, maximum));
    model.constrain(terms, ComparisonOp::Le, maximum - constant);
    factor
}

/// Exact binary expansion of integer capacity times a continuous availability.
fn capacity_product(model: &mut Model, bits: &[(usize, f64)], factor: usize) -> Vec<(usize, f64)> {
    bits.iter().map(|&(bit, weight)| {
        let product = variable(model, false, 1.0);
        model.constrain(vec![(product, 1.0), (bit, -1.0)], ComparisonOp::Le, 0.0);
        model.constrain(vec![(product, 1.0), (factor, -1.0)], ComparisonOp::Le, 0.0);
        model.constrain(vec![(product, 1.0), (factor, -1.0), (bit, -1.0)], ComparisonOp::Ge, -1.0);
        (product, weight)
    }).collect()
}

// A rate/allocation can never exceed its physical building's natural rate.
// Prove abundant worker pools cannot saturate, before creating depletion binaries.
fn workload_upper(model: &Model, terms: &[(usize,f64)], counts: &FacilityCounts) -> f64 {
    let mut recipes=HashMap::<&str,(&str,f64)>::new();
    let mut independent=0.0;
    for &(v,c) in terms {
        let recipe=match &model.kinds[v] {
            VarKind::Rate(r)|VarKind::WorkRoute{recipe:r,..}|VarKind::HaulingStaff{recipe:r,..}=>Some((*r,c/r.production_time)),
            VarKind::Units(r)=>Some((*r,c)),
            _=>None,
        };
        if let Some((r,load))=recipe {
            recipes.entry(&r.name).or_insert((&r.facility,0.0)).1+=load;
        } else { independent+=c*model.bounds[v].1; }
    }
    let mut facilities=HashMap::<&str,f64>::new();
    for (_, (facility,load)) in recipes { let value=facilities.entry(facility).or_default();*value=value.max(load); }
    independent+facilities.into_iter().map(|(f,load)|load*counts.get_count(f) as f64).sum::<f64>()
}

// Any free eligible worker can take an unassigned support job. Fixed dispatch
// shares instead require every participating worker to sustain its share.
fn pool_availability(model: &mut Model, mut factors: Vec<usize>) -> usize {
    factors.sort_unstable(); factors.dedup();
    if let Some(&factor)=factors.iter().find(|&&v|model.bounds[v].0==1.0) { return factor; }
    if factors.len()==1 { return factors[0]; }
    let maximum=variable(model,false,if factors.is_empty(){0.0}else{1.0});
    // Convex-hull upper bound for max on the unit cube. Selector binaries
    // alone otherwise permit an artificially large fractional availability.
    let mut envelope=vec![(maximum,1.0)];
    envelope.extend(factors.iter().map(|&factor|(factor,-1.0)));
    model.constrain(envelope,ComparisonOp::Le,0.0);
    let mut reasons=Vec::new();
    for factor in factors {
        model.constrain(vec![(maximum,1.0),(factor,-1.0)],ComparisonOp::Ge,0.0);
        let chosen=variable(model,true,1.0);reasons.push((chosen,1.0));
        model.constrain(vec![(maximum,1.0),(factor,-1.0),(chosen,1.0)],ComparisonOp::Le,1.0);
    }
    if !reasons.is_empty() { model.constrain(reasons,ComparisonOp::Eq,1.0); }
    maximum
}

pub(super) fn constrain<'a>(model: &mut Model<'a>, rates: &[(&'a ProductionItem, usize)],
    sites: &[(&'a ProductionItem, usize)], balances: &BTreeMap<&str, Vec<(usize, f64)>>,
    busy: &[Vec<(usize, f64)>], counts: &FacilityCounts) {
    // Only occupied whole sites participate in the work-conservation equations.
    // Fractional switch reservations are checked by the phase scheduler.
    let checked_sites: Vec<_> = sites.iter().copied().filter(|(recipe, units)|
        model.integer[*units] && model.bounds[*units].1 > 0.0 && counts.checks_continuous_recipe(&recipe.name)
    ).collect();
    let switching = counts.recipe_switching_relaxation();
    if switching && checked_sites.is_empty() { return; }
    let recipes: HashMap<usize, &ProductionItem> = rates.iter().map(|(r,v)|(*v,*r)).collect();
    let resource_sites = if switching { checked_sites.as_slice() } else { rates };
    let ingredients: std::collections::BTreeSet<&str> = resource_sites.iter()
        .filter(|(recipe,_)| counts.checks_continuous_recipe(&recipe.name))
        .flat_map(|(r,_)| r.raw_materials.iter().flatten().map(String::as_str)).collect();
    let mut resources = BTreeMap::new();
    for name in ingredients {
        let terms = balances.get(name).cloned().unwrap_or_default();
        let income = counts.quest_income().get(name).copied().unwrap_or(0.0);
        // Worker/electric variants share the same physical buildings. Summing
        // their independent maxima makes big-M needlessly loose by 10-100x.
        let mut capacity = HashMap::<&str,f64>::new();
        for (v,c) in terms.iter().filter(|(_,c)|*c>0.0) {
            if let Some(recipe)=recipes.get(v) {
                let best=capacity.entry(&recipe.facility).or_default();
                *best=best.max(c / recipe.production_time * counts.get_count(&recipe.facility) as f64);
            }
        }
        let maximum = income + capacity.values().sum::<f64>();
        resources.insert(name, availability(model, terms, income, maximum.max(1e-9)));
    }
    let uses_seeds = checked_sites.iter().any(|(r,_)| r.season.is_some_and(|s| s.seed_cost > 0.0));
    let season = (!switching || uses_seeds).then(|| season_budget(rates)).flatten().map(|(budget,spent)| {
        let per_second = budget / PACE_UNIT;
        availability(model, spent.into_iter().map(|(v,c)|(v,-c)).collect(), per_second, per_second.max(1e-9))
    });
    let mut workers = HashMap::new();
    if let Some(crew) = counts.crew() {
        for (member, terms) in busy.iter().enumerate() {
            let capacity = crew.members[member].count as f64;
            if terms.is_empty() || capacity == 0.0 { continue; }
            let factor=if workload_upper(model,terms,counts)<capacity-1e-8 {
                model.add(0.0,(1.0,1.0),false,VarKind::Extra)
            } else { availability(model, terms.iter().map(|(v,c)|(*v,-c)).collect(), capacity, capacity) };
            workers.insert(member,factor);
        }
    }
    let mut support_factors=BTreeMap::<Vec<usize>,usize>::new();
    let mut minimum_factors=BTreeMap::<Vec<usize>,usize>::new();
    // All variants draw on the same physical stock of buildings. Their joint
    // capacity times an availability factor bounds their combined workload.
    let mut shared_loads = BTreeMap::<(&str,usize),Vec<(usize,f64)>>::new();
    // The staffing columns exist before availability constraints are added.
    // Index them once instead of scanning a growing model for every variant.
    let mut support_by_recipe = HashMap::<&str,Vec<(String,usize)>>::new();
    let mut crop_workers = BTreeMap::<(String,u32),Vec<usize>>::new();
    for kind in &model.kinds {
        let task = match kind {
            VarKind::HaulingStaff {recipe,member,seconds} if *seconds > 0.0 =>
                Some((*recipe, "Hauling", member)),
            VarKind::WorkRoute {recipe,member,crop:Some((ability,_)),..} =>
                Some((*recipe, ability.as_str(), member)),
            VarKind::CropStaff {ability,level,member} if !counts.uses_work_routes() => {
                if let Some(&factor) = workers.get(member) {
                    crop_workers.entry((ability.clone(),*level)).or_default().push(factor);
                }
                None
            }
            _ => None,
        };
        if let Some((recipe,ability,member)) = task {
            if let Some(&factor) = workers.get(member) {
                support_by_recipe.entry(&recipe.name).or_default().push((ability.to_owned(),factor));
            }
        }
    }
    for d in &model.dispatched_work_routes {
        if let Some((ability, _)) = &d.crop {
            if let Some(&factor) = workers.get(&d.member) {
                support_by_recipe.entry(&d.recipe.name).or_default().push((ability.clone(), factor));
            }
        }
    }
    for d in &model.dispatched_hauling {
        if d.seconds > 0.0 {
            if let Some(&factor) = workers.get(&d.member) {
                support_by_recipe.entry(&d.recipe.name).or_default().push(("Hauling".to_owned(), factor));
            }
        }
    }
    // Dispatched worker variants share a site. Index the production rates once
    // and retain their input order when building each site's load constraints.
    let mut rates_by_site = HashMap::<(&str, &str, bool), Vec<_>>::new();
    let site_key = |r: &'a ProductionItem| {
        let dispatched = counts.dispatch_production(r);
        let name = if dispatched { crate::models::base_item_name(&r.name) } else { r.name.as_str() };
        (r.facility.as_str(), name, dispatched)
    };
    for &(recipe, rate) in rates {
        rates_by_site.entry(site_key(recipe)).or_default().push((recipe, rate));
    }
    for (recipe, units) in checked_sites {
        let max = model.bounds[units].1;
        let selected = &rates_by_site[&site_key(recipe)];
        let load: Vec<_> = selected.iter().map(|(r,v)|(*v,r.production_time)).collect();
        let mut factors: Vec<usize> = recipe.raw_materials.iter().flatten()
            .filter_map(|name|resources.get(name.as_str()).copied()).collect();
        if recipe.season.is_some_and(|s|s.seed_cost > 0.0) {
            if let Some(factor) = season { factors.push(factor); }
        }
        // Permanent residents produce throughout their occupied shift; their
        // reservation is not a reason for lowering their own production.
        if recipe.raw_materials.is_some() && !counts.crew().is_some_and(|c|c.residents.contains(&recipe.facility)) {
            if counts.dispatch_production(recipe) {
                let policy = counts.dispatch(recipe, "Production").unwrap();
                factors.extend(policy.iter().filter(|p|p.share>0.0)
                    .filter_map(|p|workers.get(&p.member).copied()));
            } else if let Some(member) = recipe.crew {
                if let Some(&factor) = workers.get(&member) { factors.push(factor); }
            }
        }
        let mut support=BTreeMap::<String,Vec<usize>>::new();
        for &(variant,_) in selected {
            for (ability,factor) in support_by_recipe.get(variant.name.as_str()).into_iter().flatten() {
                support.entry(ability.clone()).or_default().push(*factor);
            }
            if !crop_workers.is_empty() {
                if let Some(steps) = counts.grower_steps() {
                    for job in steps.get(&variant.name) {
                        if let Some(pool) = crop_workers.get(&(job.ability.clone(),job.min_level)) {
                            support.entry(job.ability.clone()).or_default().extend(pool);
                        }
                    }
                }
            }
        }
        for (ability,mut pool) in support {
            if counts.dispatch(recipe,&ability).is_some() { factors.extend(pool); }
            else {
                pool.sort_unstable();pool.dedup();
                let factor=*support_factors.entry(pool.clone()).or_insert_with(||pool_availability(model,pool));
                factors.push(factor);
            }
        }
        factors.retain(|&v|model.bounds[v].0!=1.0);
        if factors.is_empty() {
            let mut terms=load; terms.push((units,-1.0));
            model.constrain(terms,ComparisonOp::Eq,0.0);
            continue;
        }
        factors.sort_unstable();
        factors.dedup();
        for &factor in &factors {
            shared_loads.entry((&recipe.facility,factor)).or_default().extend_from_slice(&load);
        }
        let relax_reasons = counts.relax_min_reasons();
        // A single physical building already supplies the activation binary.
        // Avoid introducing a product column and three product constraints for
        // each ingredient when conditional bounds express the same minimum.
        if max == 1.0 {
            // min(a_i) >= sum(a_i) - (n - 1), gated by the occupied site.
            // This remains valid for every feasible integer solution and stops
            // fractional selector reasons from inventing idle capacity.
            let mut envelope=load.clone();
            envelope.push((units,-1.0));
            envelope.extend(factors.iter().map(|&factor|(factor,-1.0)));
            model.constrain(envelope,ComparisonOp::Ge,-(factors.len() as f64));
            let mut reasons=Vec::new();
            for factor in factors.iter().copied() {
                let mut upper=load.clone();upper.push((factor,-1.0));
                model.constrain(upper.clone(),ComparisonOp::Le,0.0);
                if factors.len() == 1 {
                    upper.push((units, -1.0));
                    model.constrain(upper, ComparisonOp::Ge, -1.0);
                } else if !relax_reasons {
                    let reason = variable(model, true, 1.0);
                    upper.push((reason, -1.0));
                    model.constrain(upper, ComparisonOp::Ge, -1.0);
                    reasons.push((reason, 1.0));
                }
            }
            if factors.len() > 1 && !relax_reasons {
                reasons.push((units,-1.0));
                model.constrain(reasons,ComparisonOp::Eq,0.0);
            }
            continue;
        }
        let mut bits=Vec::new();
        let mut weight=1.0;
        while weight <= max { bits.push((variable(model,true,1.0),weight)); weight*=2.0; }
        let mut capacity=bits.clone();capacity.push((units,-1.0));
        model.constrain(capacity,ComparisonOp::Eq,0.0);
        let minimum=if factors.len()==1 { factors[0] } else {
            *minimum_factors.entry(factors.clone()).or_insert_with(|| {
                let minimum=variable(model,false,1.0);
                let mut envelope=vec![(minimum,1.0)];
                envelope.extend(factors.iter().map(|&factor|(factor,-1.0)));
                model.constrain(envelope,ComparisonOp::Ge,1.0-factors.len() as f64);
                let mut reasons=Vec::new();
                for factor in factors {
                    model.constrain(vec![(minimum,1.0),(factor,-1.0)],ComparisonOp::Le,0.0);
                    if !relax_reasons {
                        let reason=variable(model,true,1.0);reasons.push((reason,1.0));
                        model.constrain(vec![(minimum,1.0),(factor,-1.0),(reason,-1.0)],ComparisonOp::Ge,-1.0);
                    }
                }
                if !relax_reasons {
                    model.constrain(reasons,ComparisonOp::Eq,1.0);
                }
                minimum
            })
        };
        // The binary weights can sum to more than the physical maximum (e.g.
        // 1+2+4 for four buildings). Use the actual bound in the relaxation.
        if weight - 1.0 > max {
            let mut lower = load.clone();
            lower.extend([(units,-1.0),(minimum,-max)]);
            model.constrain(lower,ComparisonOp::Ge,-max);
            let mut upper = load.clone();
            upper.push((minimum,-max));
            model.constrain(upper,ComparisonOp::Le,0.0);
        }
        let mut terms=load;
        terms.extend(capacity_product(model,&bits,minimum).into_iter().map(|(v,c)|(v,-c)));
        model.constrain(terms,ComparisonOp::Eq,0.0);
    }
    for ((facility,factor),mut load) in shared_loads {
        if load.len() > 1 {
            load.push((factor,-(counts.get_count(facility) as f64)));
            model.constrain(load,ComparisonOp::Le,0.0);
        }
    }
}
