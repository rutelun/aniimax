// Try the material chains against the current production shift. Build their
// physical timetables first, then fit the same outputs to the measured roster.
import {materialChains,materialFlowSchedule,switchingWorkshops} from './material-flow-schedule.js';

const DAY=86400;

function availableRawMaterial(plan,catalog,chain,raw){
    if(!raw)return null;
    const source={wood_block:'Wood Blocks',mineral_sand:'Mineral Sand'}[raw];
    if(!source)return null;
    let supply=(plan.byproduct_rates??[]).reduce((n,[name,rate])=>n+(name===source?rate:0),0);
    for(const step of plan.coin_items??[]){
        if(step.status!=='producing'||chain.includes(step.item_name))continue;
        const item=catalog.get(step.item_name);
        if(!item)return null;
        if(item.raw_materials?.some(r=>chain.includes(r)))return null;
        for(const [i,r] of (item.raw_materials??[]).entries()){
            if(r===raw)supply-=item.required_amount[i]*step.busy_units/step.cycle_time;
        }
    }
    return supply;
}

// With the rest of the production shift held fixed, the raw material stream
// bounds the best possible finish time regardless of crew and switch times.
export function materialUpgradeBound(plan,catalog){
    let seconds=0;
    for(const need of plan.level_up_preview?.requirements??[]){
        if(need.have>=need.need)continue;
        const chain=Object.values(materialChains).find(chain=>chain.at(-1)===need.name);
        if(!chain){
            // A workshop-only draft retains every other requirement's rate.
            if(need.per_second>0)seconds=Math.max(seconds,(need.need-need.have)/need.per_second);
            continue;
        }
        const raw=catalog.get(chain[0])?.raw_materials?.[0];
        let rate=availableRawMaterial(plan,catalog,chain,raw);
        if(!(rate>0))continue;
        let feed=raw;
        for(const name of chain){
            const item=catalog.get(name);
            if(item?.raw_materials?.length!==1 || item.raw_materials[0]!==feed ||
                !(item.required_amount?.[0]>0) || item.yield_amount!==1){rate=0;break;}
            rate/=item.required_amount[0];feed=name;
        }
        // A single-workshop draft may keep the other chain's existing
        // output, including deliveries from outside that workshop.
        if(rate>0)seconds=Math.max(seconds,(need.need-need.have)/Math.max(rate,need.per_second??0));
    }
    return seconds;
}

function draftChain(input,plan,catalog,cycles,facility,powered=false){
    const chain=materialChains[facility], raw=catalog.get(chain[0])?.raw_materials?.[0];
    const supply=availableRawMaterial(plan,catalog,chain,raw);
    if(!(supply>0))return null;
    const buildings=input.facilities[facility].flatMap((t,tier)=>Array.from({length:t.count},(_,i)=>({
        facility,level:t.level,id:facility+' '+tier+' '+i,
        recipes:chain.filter(name=>catalog.get(name)?.facility_level<=t.level),
    })));
    const downstream=plan.coin_items.filter(s=>s.status==='producing'&&s.facility===facility&&chain.slice(1).includes(s.item_name));
    const levels=new Set(downstream.map(s=>s.electric_level));
    const tier=downstream[0]?.electric_level;
    if(powered){
        if(!tier||levels.size!==1||new Set(downstream.map(s=>s.item_name)).size!==3)return null;
        const compatible=buildings.filter(b=>b.level===tier);
        if(compatible.length<3)return null;
        for(const site of compatible.slice(0,3))site.electric_level=tier;
    }
    let rate=supply;
    const jobs=[];
    for(const [i,name] of chain.entries()){
        const item=catalog.get(name),feed=i?chain[i-1]:raw;
        if(item?.raw_materials?.length!==1||item.raw_materials[0]!==feed||
            item.yield_amount!==1||!(item.required_amount[0]>0))return null;
        const electric=name+'__electric'+tier;
        let variant=electric, key='rate:'+electric+'#0';
        if(!powered||i===0){
            const route=input.roster.dispatch[facility+'|'+name+'|Production'];
            if(route?.length!==1||route[0].share!==1)return null;
            const id=route[0].member,reserve=plan.assumed_aniimo?.find(([n])=>n===id);
            if(reserve?.[4]!=null)return null;
            const suffix=reserve?`reserve:{${JSON.stringify(reserve[1])}: ${reserve[2]}}:None`:'owned:'+id;
            variant=name+'__by'+id;
            key='rate:'+name+'__by'+suffix+'#0';
        }
        const seconds=cycles.get(variant);
        if(!(seconds>0))return null;
        rate/=item.required_amount[0];
        jobs.push({id:key,facility,recipe:name,rate,seconds,batches:rate*DAY,
            inputs:{[feed]:item.required_amount[0]},outputs:{[name]:1},electric_level:powered&&i?tier:null});
        if(powered&&i===0){
            const extra=cycles.get(electric);
            if(!(extra>0) || rate<=1/seconds)return null;
            const steady=jobs[0];
            steady.rate=1/seconds;steady.batches=steady.rate*DAY;
            jobs.push({...steady,id:'rate:'+electric+'#0',electric_level:tier,seconds:extra,
                rate:rate-steady.rate,batches:(rate-steady.rate)*DAY});
        }
    }
    return {facility,powered,jobs,buildings,backgroundOutputs:{[raw]:supply}};
}

export function draftMaterialPlans(pkg,highs,input,base,check,modes=[false],catalog){
    if(!input.always_running||input.fixed_homeland||input.level_up||input.level_up_strategy||
        input.priorities?.[0]!=='level_up'||!input.roster||!Object.keys(input.roster.dispatch??{}).length||
        !base?.comparison_seed||!base?.comparison_goals||!base.level_up_preview?.requirements||
        input.level_up_preview?.stock?.some(([,n])=>n>0))return base;
    const facilities=switchingWorkshops(input).filter(f=>input.facilities[f].reduce((n,t)=>n+t.count,0)>=4);
    if(!facilities.length)return base;
    catalog??=new Map(JSON.parse(pkg.get_all_items()).map(item=>[item.name,item]));
    const settings={...input,recipe_switching_relaxation:true,recipe_switching_normal_only:true};
    const stage={floors:base.comparison_goals.floors,crop_variety:base.comparison_scores?.crop_variety??null};
    const cycles=new Map(JSON.parse(pkg.material_recipe_cycles(JSON.stringify({...settings,
        recipe_switching_facilities:facilities,recipe_switching_normal_only:false,always_running_recipes:[]}))));
    const original=new Map(base.comparison_seed.keys.map((k,i)=>[k,base.comparison_seed.values[i]]));
    let best=base;
    const choices=[];
    for(const powered of modes){
        if(powered && !(input.e_mode_rv>=12 || input.electricity))continue;
        const drafts=facilities.map(f=>draftChain(input,base,catalog,cycles,f,powered)).filter(Boolean);
        if(drafts.length>1)choices.push(drafts);
        choices.push(...drafts.map(d=>[d]));
    }
    for(const choice of choices){
        const switched=choice.map(d=>d.facility),rates=new Map(choice.flatMap(d=>d.jobs.map(j=>[j.id,j.rate])));
        const outputs=new Map(choice.map(d=>[d.jobs.at(-1).recipe,d.jobs.at(-1).rate]));
        const seconds=Math.max(...base.level_up_preview.requirements.filter(r=>r.need>r.have)
            .map(r=>(r.need-r.have)/(outputs.get(r.name)??r.per_second)));
        if(!(seconds>0&&seconds<best.level_up_preview.seconds*(1-2e-5)))continue;
        // When the other chain sets the upgrade time, process only the material
        // this upgrade needs. The oversupply need not occupy a second worker.
        let physical=true;
        for(const draft of choice){
            const last=draft.jobs.at(-1),target=base.level_up_preview.requirements.find(r=>r.name===last.recipe);
            if(!target)continue;
            const scale=(target.need-target.have)/(seconds*last.rate);
            const raw=draft.jobs[0];
            if(draft.powered && scale>0&&scale<1){
                const extra=draft.jobs[1];
                rates.set(extra.id,(raw.rate+extra.rate)*scale-raw.rate);
                for(const job of draft.jobs.slice(2))rates.set(job.id,job.rate*scale);
            }else if(!draft.powered && scale>0&&scale<1&&raw.rate*scale*raw.seconds>1){
                for(const job of draft.jobs)rates.set(job.id,job.rate*scale);
            }
            const jobs=draft.jobs.map(j=>({...j,batches:rates.get(j.id)*DAY}));
            if(jobs.some(j=>!(j.batches>0)) || !materialFlowSchedule({...draft,jobs,alwaysRunning:true,
                approximate:true,daySeconds:DAY,maxBuildings:1,maxSwitches:1}))physical=false;
        }
        if(!physical)continue;
        const goal={...stage,pace:DAY/seconds*(1-1e-8)};
        const trial={...settings,recipe_switching_normal_only:!choice[0].powered,recipe_switching_facilities:switched};
        const payload=JSON.stringify(trial),stageJson=JSON.stringify(goal);
        const model=JSON.parse(pkg.exact_problem(payload,stageJson));
        const available=new Set(model.recipe_options.map(([v])=>model.variable_keys[v]));
        if([...rates.keys()].some(key=>!available.has(key)))continue;
        const rows=model.recipe_options.map(([v,,facility])=>{
            const key=model.variable_keys[v],value=(switched.includes(facility)?rates:original).get(key)??0;
            // The incumbent's independently rounded background rates can leave a
            // small daily ingredient deficit. Reconcile active rates in the fit
            // before checking the actual phase inventory and retained income.
            if(!switched.includes(facility) && value>0){
                return ' draft_rate_lo_'+v+': x'+v+' >= '+Math.max(0,value-1e-8)
                    +'\n draft_rate_hi_'+v+': x'+v+' <= '+(value+1e-8);
            }
            return ' draft_rate_'+v+': x'+v+' = '+Math.max(0,value);
        });
        if(choice[0].powered){
            const moving=new Set(switched.flatMap(f=>materialChains[f]));
            const fixedSites=new Set(model.recipe_variables.filter(([v,name])=>!moving.has(name)
                && /^(units:|continuous_site:)/.test(model.variable_keys[v])).map(([v])=>v));
            for(const [v,key] of model.variable_keys.entries()){
                if(fixedSites.has(v)||/^(staff:|environment:|pair:|generators#)/.test(key))rows.push(' draft_post_'+v+': x'+v+' = '+(original.get(key)??0));
            }
        }
        const lp=model.lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n');
        const fit=highs.solve(lp,{mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-10,primal_feasibility_tolerance:1e-10});
        if(fit.Status!=='Optimal'||!fit.Columns)continue;
        const values=model.variable_keys.map((_,v)=>fit.Columns['x'+v]?.Primal??0);
        const plan=JSON.parse(pkg.exact_plan(payload,stageJson,JSON.stringify({values,verify_only:true,proven:false,bound:base.upper_bound})));
        if(!plan.success||plan.rate_per_second<base.rate_per_second-1e-8)continue;
        plan.comparison_scores={crop_variety:stage.crop_variety};
        plan.upper_bound=null;
        const verified=check(trial,plan,best);
        if(verified)best=verified;
    }
    return best;
}
