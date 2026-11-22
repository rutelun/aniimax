// Repair the optimistic production plan with its selected workers and all
// electric alternatives. Availability constraints remain exact for every site.
// This is a search neighborhood, not a proof of the unrestricted optimum.
export function continuousNeighborhood(problem, recipes, seed) {
    if (!recipes?.length || !seed?.keys?.length || !problem.recipe_options || !problem.recipe_variables) return problem;
    const allowed = new Set(recipes);
    // Discovery can omit upgrade chains entirely when maximizing only coins.
    // A material search must be able to introduce those chains; the outer
    // availability-validation pass will then constrain newly selected recipes.
    if (problem.continuousMaterialSearch && problem.recipe_options.some(([,name,facility]) =>
        ['Woodworking Bench','Chimney Kiln'].includes(facility) && !allowed.has(name))) return problem;
    const variants = new Set(seed.keys.filter((key,i) => /^(rate|units):/.test(key) && seed.values[i] > 1e-9)
        .map(key => key.replace(/^(rate|units):/,'')));
    if (!variants.size) return problem;
    const shared=sharedSites(problem);
    for (const [v,name,facility,,electric] of problem.recipe_options) {
        if ((electric || facility === 'Phonolfactory Table' || shared.has(name)) && allowed.has(name)) variants.add(problem.variable_keys[v].replace(/^rate:/,''));
    }
    const zero = new Set(problem.recipe_variables.filter(([v,name]) => !allowed.has(name)
        || (/^(rate|units):/.test(problem.variable_keys[v]) && !variants.has(problem.variable_keys[v].replace(/^(rate|units):/,''))))
        .map(([v]) => v));
    if (!zero.size) return problem;
    const fixed = [...zero].map(v => ` continuous_neighborhood_${v}: x${v} = 0`).join('\n');
    return {...problem, continuousRestricted:true, lp:problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`)};
}

// These sites have a single physical commitment across multiple worker rates.
// Dropping a crew column required by a measured share forces all its peers to zero.
function sharedSites(problem){
    return new Set(problem.recipe_variables.filter(([v])=>problem.variable_keys[v].startsWith('continuous_site:')).map(([,name])=>name));
}

export function neighborhoodResult(result, restricted) {
    return result && restricted ? {...result, restricted:true, searchProven:result.proven, proven:false, upper:undefined} : result;
}

// Repair contested workshops together. Keep the discovered number of raw
// producers, allow their output to change, and let workshops share workers
// across recipes. A near-income floor prunes branches with unusable output.
export function incomeRepairNeighborhood(problem, recipes, seed, target) {
    if (!(target > 0) || !problem.production_only || !problem.primary_objective?.length
        || !recipes?.length || !seed?.keys?.length || !problem.recipe_options || !problem.integer_groups) return null;
    const allowed = new Set(recipes);
    const previous = new Map(seed.keys.map((key,i)=>[key,seed.values[i]]));
    const variants = new Set(), sources = new Set(), crews = new Map();
    for (const [v,name,facility,source] of problem.recipe_options) {
        const key = problem.variable_keys[v];
        if (source || facility === 'Farmland' || facility === 'Woodland') sources.add(name);
        if (!(previous.get(key)>1e-9)) continue;
        variants.add(key.slice(5));
        const worker = key.split('__by')[1];
        if (!source && worker) {
            if (!crews.has(facility)) crews.set(facility,new Set());
            crews.get(facility).add(worker);
        }
    }
    const shared=sharedSites(problem);
    for (const [v,name,facility,source,electric] of problem.recipe_options) {
        const key = problem.variable_keys[v];
        if (allowed.has(name) && (electric || facility === 'Phonolfactory Table' || shared.has(name) || (!source && (key.includes('__byreserve:') || crews.get(facility)?.has(key.split('__by')[1])))))
            variants.add(key.slice(5));
    }
    const rows = [];
    for (const [v,name] of problem.recipe_variables) {
        const key = problem.variable_keys[v];
        if (!allowed.has(name) || (/^(rate|units):/.test(key) && !variants.has(key.replace(/^(rate|units):/,''))))
            rows.push(` income_off_${v}: x${v} = 0`);
    }
    for (const [name,terms] of problem.integer_groups) {
        if (!sources.has(name) || !allowed.has(name)) continue;
        const count = terms.reduce((s,[v,c])=>s+c*(previous.get(problem.variable_keys[v]) || 0),0);
        rows.push(` income_sites_${terms[0][0]}: ${terms.map(([v,c])=>`${c} x${v}`).join(' + ')} = ${Math.round(count)}`);
    }
    const earnings = problem.primary_objective.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    rows.push(` income_target: ${earnings} >= ${target}`);
    return {...problem,continuousRestricted:true,lp:problem.lp.replace('\nBounds\n',`\n${rows.join('\n')}\nBounds\n`)};
}

// A restricted witness solves the same rows with additional zero assignments.
// It is also feasible in the parent. Only the parent search supplies a dual bound.
export function keepProductionWitness(parent, witness) {
    if (!witness?.values || parent?.proven || (parent && parent.objective >= witness.objective)) return parent;
    return {...witness, proven:false, searchProven:false, upper:parent?.upper};
}
