// Refit only the production decisions affected by the requested throughput.
// Each fit retains the exact crew, power, hauling and continuous-site rows.
import {materialChains,switchingWorkshops} from './material-flow-schedule.js';
import {generatorLimit} from './facility-config.js';
import {optimizeWorkshopSources,workshopDemand} from './workshop-demand.js';
import {prefersWorkshopPlan} from './recipe-switch-search.js';
import {priorityCeiling} from './priority-ceilings.js';
import {productionObjective} from './priority-search.js';
import {solveWithIncumbent,polishSolution} from './highs-solve.js';
import {refineElectricStaffing,keepsProduction} from './electric-staffing.js';
import {refineClimate} from './staffing-search.js';

const DAY=86400;
const options={mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-7,primal_feasibility_tolerance:1e-10};
const asMap=seed=>new Map(seed.keys.map((key,i)=>[key,seed.values[i]]));
const expression=terms=>terms.map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');
const addRows=(lp,rows)=>lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n');

// Size automatic Crackle Generators to cover physical switching power draw,
// matching `GeneratorLimits::staffing` in `src/power.rs`.
function sizeAutomaticGenerators(plan, input, minGenerators = 0, minWatts = 0) {
    if (input.roster) return plan;
    const tiers = plan.generator_tiers_by_lightning;
    const lightning = input.aniimo_levels?.Lightning ?? (input.aniimo?.startsWith('best3') ? 3 : 4);
    const outputs = plan.generator_watts_by_lightning?.slice(0, lightning);
    if (!outputs?.length || !tiers?.length) return plan;
    const maxTier = Math.max(...tiers);
    const operators = outputs.flatMap((watts, i) => watts > 0 && tiers[i] === maxTier && maxTier > 0
        ? [{ tier: maxTier, level: i + 1, watts }] : []);
    if (!operators.length) return plan;
    const maxWatts = operators.at(-1).watts;
    const cap = input.e_mode_rv >= 12 ? generatorLimit(input.e_mode_rv) : Infinity;
    const wattsNeeded = Math.max(0, minWatts, plan.power_used ?? 0);
    const count = Math.max(minGenerators, wattsNeeded > 1e-6 ? Math.ceil((wattsNeeded - 1e-6) / maxWatts) : 0);
    if (count > cap) return plan;
    let remaining = wattsNeeded;
    const levels = [];
    for (let others = count - 1; others >= 0; others--) {
        const picked = operators.find(op => op.watts + others * maxWatts + 1e-6 >= remaining) ?? operators.at(-1);
        levels.push([picked.tier, picked.level]);
        remaining -= picked.watts;
    }
    const power_generated = levels.reduce((sum, [, lv]) => sum + (outputs[lv - 1] ?? 0), 0);
    return { ...plan, power_generators: count, power_generator_levels: levels, power_generated };
}

function checkedRecipes(plan) {
    // An occupied site can be starved for its ingredient. Preserve its
    // continuous operating rule even when the production report omits it.
    return [...(plan.active_continuous_recipes??[]),
        ...(plan.coin_items??[]).filter(r=>r.status==='producing').map(r=>r.item_name)];
}

// A slower or inaccessible building tier cannot cover a faster, higher-tier
// job. Reserve the least flexible jobs first when checking dedicated sites.
function needsSharedSite(input,chain,problem,catalog) {
    const sites=input.facilities[chain.facility].flatMap(t=>Array(t.count).fill(t.level)).sort((a,b)=>a-b);
    for(const job of [...chain.jobs].reverse()){
        if(!(job.rate>0))continue;
        const cycles=problem.recipe_options.filter(([,name])=>name===job.recipe).map(o=>o[5]);
        if(!cycles.length)return false;
        const count=Math.ceil(job.rate*Math.min(...cycles)-1e-8);
        for(let i=0;i<count;i++){
            const at=sites.findIndex(level=>level>=catalog.get(job.recipe).facility_level);
            if(at<0)return true;
            sites.splice(at,1);
        }
    }
    return false;
}

// Choose the downstream recipe that saves the most manual work on the one
// powered site shared with the extra raw lane. Both jobs must fit in its day.
function sharedElectricRecipe(chain,rateColumns) {
    const raw=chain.jobs[0],options=rateColumns.get(raw.recipe)??[];
    const cycle=(variants,electric)=>Math.min(...variants.filter(v=>v.electric===electric).map(v=>v.seconds));
    const extra=Math.max(0,raw.rate-1/cycle(options,false));
    const rawLoad=extra>0?extra*cycle(options,true):0;
    let selected,largest=0;
    for(const job of chain.jobs.slice(1)){
        const variants=rateColumns.get(job.recipe)??[];
        const saved=job.rate*cycle(variants,false);
        if(job.rate>0 && rawLoad+job.rate*cycle(variants,true)<=1+1e-8 && saved>largest){
            largest=saved;
            selected=job.recipe;
        }
    }
    return selected;
}

function fitCapacity(pkg,highs,trial,baseline,background,demand,moving,mode,stage,catalog,problem) {
    const payload=JSON.stringify(trial),stageJson=JSON.stringify(stage);
    problem??=JSON.parse(pkg.exact_problem(payload,stageJson));
    if(!problem.lp)return null;
    const original=asMap(baseline.comparison_seed),source=background.comparison_seed?asMap(background.comparison_seed):original;
    const rows=[],pace=problem.variable_keys.indexOf('pace#0');
    if(pace<0)return null;
    const rateColumns=new Map(),movingRecipes=new Set(moving.flatMap(f=>materialChains[f]));
    const retained=(key,recipe)=>materialChains[catalog.get(recipe)?.facility]?original.get(key):source.get(key);
    for(const [v,name,facility,,electric,seconds] of problem.recipe_options){
        const key=problem.variable_keys[v];
        if(!moving.includes(facility)){
            const rate=retained(key,name)??0;
            if(rate>0){
                // The reported incumbent can contain rounded background rates.
                rows.push(' source_lo_'+v+': x'+v+' >= '+Math.max(0,rate-1e-9),
                    ' source_hi_'+v+': x'+v+' <= '+(rate+1e-9));
            }else rows.push(' source_off_'+v+': x'+v+' = 0');
            continue;
        }
        if(!rateColumns.has(name))rateColumns.set(name,[]);
        rateColumns.get(name).push({v,electric,seconds});
    }
    for(const [v,name] of problem.recipe_variables){
        const key=problem.variable_keys[v];
        if(!movingRecipes.has(name)&&/^(units|continuous_site):/.test(key)){
            const val=retained(key,name)??0;
            rows.push(' fixed_site_'+v+': x'+v+' = '+(Math.abs(val-Math.round(val))<1e-6?Math.round(val):val));
        }
    }
    for(const [v,key] of problem.variable_keys.entries()){
        if(/^(environment:|pair:|staff:)/.test(key) && !key.startsWith('staff:Crackle Generator:')){
            rows.push(' fixed_post_'+v+': x'+v+' = '+Math.round(source.get(key)??0));
        }
    }
    if(mode!=='fixed'){
        for(const chain of demand.chains.filter(c=>moving.includes(c.facility))){
            const shared=mode==='mixed'?sharedElectricRecipe(chain,rateColumns):null;
            for(const [index,job] of chain.jobs.entries()){
                const variants=rateColumns.get(job.recipe)??[];
                if(!variants.length)continue;
                // Limit surplus in the quicker chain. The next fit maximizes
                // achievable pace if either shared crew or site capacity binds.
                const work=expression(variants.map(({v})=>[v,1]));
                rows.push(' needed_'+variants[0].v+': '+work+' <= '+job.rate);
                for(const {v,electric} of variants){
                    const powered=mode==='electric'||mode==='mixed' && job.recipe===shared;
                    if(mode==='manual'?electric:index>0 && electric!==powered)
                        rows.push(' mode_'+v+': x'+v+' = 0');
                }
                if((mode==='electric'||mode==='mixed') && index===0 && chain.jobs.filter(j=>j.rate>0).length===4){
                    // The electric lane temporarily shares its downstream site.
                    // A separate manual lane continues running throughout both phases.
                    const manual=variants.filter(o=>!o.electric).map(({v,seconds})=>[v,seconds]);
                    if(manual.length && job.rate*Math.min(...manual.map(([,s])=>s))>1+1e-8)
                        rows.push(' steady_'+variants[0].v+': '+expression(manual)+' = 1');
                }
            }
        }
    }
    rows.push(' demand_pace: x'+pace+' <= '+Math.min(DAY,DAY/demand.seconds));
    const currency=trial.currency??'coins',priorities=trial.priorities??[];
    const lp=addRows(problem.lp,rows);
    const fastest=lp.replace(/Maximize\n[\s\S]*?\nSubject To\n/,'Maximize\n obj: x'+pace+'\nSubject To\n');
    const run=(lp,seed)=>{
        let result=solveWithIncumbent(highs,{...problem,lp},options,seed,false);
        if(result.Status==='Infeasible')
            result=solveWithIncumbent(highs,{...problem,lp},{...options,presolve:'off'},seed,false);
        return result;
    };
    const speed=run(fastest);
    if(speed.Status!=='Optimal'||!(speed.ObjectiveValue>0))return null;
    const read=solution=>problem.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0);
    const seed=read(speed);
    const finishing=[' reached_pace: x'+pace+' >= '+seed[pace]];
    // If sites or staffing set a later ETA, recalculate every chain at that
    // horizon with the same one-off stocks and recurring background inputs.
    const seconds=DAY/seed[pace];
    if(mode!=='fixed' && seconds>demand.seconds*(1+1e-8)){
        const resized=workshopDemand(trial,background,catalog,{},seconds);
        for(const chain of resized?.chains??[])for(const job of chain.jobs){
            const variants=rateColumns.get(job.recipe);
            if(variants?.length)finishing.push(' final_need_'+variants[0].v+': '+
                expression(variants.map(({v})=>[v,1]))+' <= '+job.rate);
        }
    }
    const finalLp=addRows(lp,finishing);
    const second=run(finalLp,seed);
    for(const result of [second,speed]){
        if(result.Status!=='Optimal')continue;
        const values=polishSolution(highs,{...problem,lp:finalLp},{values:read(result)}).values;
        const plan=JSON.parse(pkg.exact_plan(payload,stageJson,JSON.stringify({values,proven:false,bound:0,verify_only:true})));
        if(!plan.success)continue;
        const active=[...new Set(problem.recipe_variables.filter(([v])=>values[v]>1e-8).map(([,name])=>name))];
        if(active.some(name=>!trial.always_running_recipes.includes(name)))continue;
        const counts={};
        for(const [name,terms] of problem.integer_groups??[])
            counts[name]=(counts[name]??0)+Math.round(terms.reduce((n,[v,c])=>n+values[v]*c,0));
        for(const [v,name] of problem.recipe_variables)if(problem.variable_keys[v].startsWith('continuous_site:'))
            counts[name]=(counts[name]??0)+Math.round(values[v]);
        return {...plan,upper_bound:null,proven_optimal:false,continuous_production_checked:!!trial.always_running,
            active_continuous_recipes:active,continuous_checked_recipes:trial.always_running_recipes,continuous_site_counts:counts,
            comparison_seed:{keys:problem.variable_keys,values},comparison_scores:{crop_variety:stage.crop_variety},
            comparison_goals:{currency,currency_value:plan.rate_per_second,crop_variety:stage.crop_variety,
                pace:priorities.includes('level_up')?values[pace]:null,
                floors:(plan.priorities??[]).filter(p=>p.target!=='level_up').map(p=>[p.target,p.per_second])}};
    }
    return null;
}

// A fixed-recipe income bound carries across a stronger set of earlier
// priority floors. For an unlimited generated team and income before RV pace,
// dropping optional workshop jobs preserves every economic recipe and its
// ingredients. Check the catalogue before transferring that proof to switching.
function incomeBound(pkg,highs,input,base,plan,catalog,facilities,source=null) {
    const currency=input.currency??'coins',priorities=input.priorities??[];
    const pos=priorities.indexOf(currency),prefix=pos<0?priorities:priorities.slice(0,pos);
    const previous=new Map(base.comparison_goals.floors),achieved=new Map(plan.comparison_goals.floors);
    const keepsFloors=prefix.every(goal=>goal==='level_up'?
        plan.comparison_goals.pace>=(base.comparison_goals.pace??0)-1e-9:
        (achieved.get(goal)??0)>=(previous.get(goal)??0)-1e-9);
    const products=new Set(Object.values(materialChains).flat());
    const resources=new Set(['wood_block','mineral_sand',...products]);
    const sinks=!input.roster && !prefix.includes('level_up') && [...catalog.values()].every(item=>
        products.has(item.name)?!item.sell_value&&!item.byproduct:!item.raw_materials?.some(r=>resources.has(r)));
    if(keepsFloors && (!plan.recipe_schedule || sinks) && Number.isFinite(base.upper_bound) &&
        base.upper_bound>=plan.rate_per_second-1e-8)return Math.max(base.upper_bound,plan.rate_per_second);

    // When the workshop-free source solve proved a tighter MIP dual bound at
    // this exact pace and higher-priority floors, it also bounds every valid
    // physical switching schedule that matches or beats those goals.
    const sourcePlan=source?.plan??source;
    let bestUpper=null;
    if(sourcePlan){
        const sourceFloors=new Map((sourcePlan.priorities??[]).map(p=>[p.target,p.per_second]));
        const matchesSource=prefix.every(goal=>goal==='level_up'
            ? Number.isFinite(sourcePlan.source_pace) && plan.comparison_goals.pace>=sourcePlan.source_pace*(1-1e-5)
            : (achieved.get(goal)??0)>=(sourceFloors.get(goal)??0)*(1-1e-5));
        if(matchesSource){
            let sourceUpper=sourcePlan.source_upper_bound;
            if(source?.proveSourceBound && (!Number.isFinite(sourceUpper) || sourceUpper>plan.rate_per_second*1.001+1e-7)){
                const tightened=source.proveSourceBound(plan.rate_per_second);
                if(Number.isFinite(tightened))sourceUpper=Number.isFinite(sourceUpper)?Math.min(sourceUpper,tightened):tightened;
            }
            if(Number.isFinite(sourceUpper) && sourceUpper>=plan.rate_per_second-1e-7){
                bestUpper=Math.max(sourceUpper,plan.rate_per_second);
            }
        }
    }

    // Switching can change the feasible economic shifts. Price the entire
    // catalogue with fractional sites and all switchable workshops for a bound.
    const relaxed={...input,always_running_recipes:[],restrict_to_checked_recipes:false,
        recipe_switching_relaxation:true,recipe_switching_facilities:facilities};
    const stage={floors:plan.comparison_goals.floors.filter(([name])=>prefix.includes(name)),
        crop_variety:plan.comparison_scores.crop_variety,
        pace:prefix.includes('level_up')?plan.comparison_goals.pace:null};
    const p=productionObjective(JSON.parse(pkg.exact_problem(JSON.stringify(relaxed),JSON.stringify(stage))));
    const upper=priorityCeiling(highs,p,currency);
    if(upper!=null && upper>=plan.rate_per_second-1e-8){
        const lpBound=Math.max(upper,plan.rate_per_second);
        bestUpper=bestUpper!=null ? Math.min(bestUpper,lpBound) : lpBound;
    }
    return bestUpper;
}

async function minimizeClimate(pkg,solve,problem,payload,stageJson,plan,values,{relaxPairs=false}={}) {
    let curProblem=problem, curPayload=payload, curValues=values, curPlan=plan, changed=false;
    if(curProblem?.lp && curValues?.length===curProblem.variables){
        const cleaned=await refineClimate(curProblem,{values:curValues},solve);
        if(cleaned?.values && cleaned.values!==curValues){
            const checked=JSON.parse(pkg.exact_plan(curPayload,stageJson,
                JSON.stringify({values:cleaned.values,verify_only:true,proven:false,bound:0})));
            if(keepsProduction(curPlan,checked)){
                curValues=cleaned.values;
                curPlan=checked;
                changed=true;
            }
        }
    }
    if(relaxPairs && curProblem?.variable_keys?.length && curValues?.length===curProblem.variables){
        const tempModes=new Set((curPlan.environment_assignments??[])
            .map(a=>a.mode).filter(m=>m==='Warm'||m==='Scorching'||m==='Cool'||m==='Freeze'));
        const pools=curProblem.staffing_pools??[];
        const reserveHF=pools.some(pool=>pool.reserve && pool.anchors.some(v=>
            curProblem.variable_keys[v]?.startsWith('staff:Heat Furnace:') && curValues[v]>0.5));
        const reserveCU=pools.some(pool=>pool.reserve && pool.anchors.some(v=>
            curProblem.variable_keys[v]?.startsWith('staff:Cooling Unit:') && curValues[v]>0.5));
        const hasOwnedCU=pools.some(pool=>!pool.reserve && pool.anchors.some(v=>
            curProblem.variable_keys[v]?.startsWith('staff:Cooling Unit:')));
        const hasOwnedHF=pools.some(pool=>!pool.reserve && pool.anchors.some(v=>
            curProblem.variable_keys[v]?.startsWith('staff:Heat Furnace:')));
        if(tempModes.size>=3 || (reserveHF && hasOwnedCU) || (reserveCU && hasOwnedHF)){
            const exactPayload=JSON.stringify({...JSON.parse(curPayload),relax_pair_coverage:false});
            const exactP=JSON.parse(pkg.exact_problem(exactPayload,stageJson));
            if(exactP?.lp && exactP.variable_keys?.some(k=>k.startsWith('pair:'))){
                const byKey=new Map(curProblem.variable_keys.map((k,i)=>[k,curValues[i]]));
                const oldExtras=curProblem.variable_keys.flatMap((k,i)=>k.startsWith('extra#')?[i]:[]);
                const newExtras=exactP.variable_keys.flatMap((k,i)=>k.startsWith('extra#')?[i]:[]);
                const extraShift=oldExtras.length-newExtras.length;
                const aligned=exactP.variable_keys.map(k=>byKey.get(k)??0);
                if(extraShift>=0){
                    for(let i=0;i<newExtras.length;i++)aligned[newExtras[i]]=curValues[oldExtras[i+extraShift]];
                }
                const baseExact=JSON.parse(pkg.exact_plan(exactPayload,stageJson,
                    JSON.stringify({values:aligned,verify_only:true,proven:false,bound:0,summary_only:true})));
                if(baseExact.success){
                    const cleaned=await refineClimate(exactP,{values:aligned},solve);
                    if(cleaned?.values && cleaned.values!==aligned){
                        const checked=JSON.parse(pkg.exact_plan(exactPayload,stageJson,
                            JSON.stringify({values:cleaned.values,verify_only:true,proven:false,bound:0})));
                        if(keepsProduction(curPlan,checked)){
                            curProblem=exactP;
                            curPayload=exactPayload;
                            curValues=cleaned.values;
                            curPlan=checked;
                            changed=true;
                        }
                    }
                }
            }
        }
    }
    return {plan:curPlan,problem:curProblem,payload:curPayload,values:curValues,changed};
}

export async function searchWorkshopCapacity(pkg,highs,input,baseline,{validate,progress=()=>{}}) {
    const facilities=switchingWorkshops(input);
    // Upgrades are the only selected goal that consumes these unsold products.
    // With no upgrade the ordinary shift already optimizes the actual goals.
    if(!baseline?.success || !baseline.comparison_seed || !baseline.comparison_goals || !facilities.length ||
        !input.level_up_preview?.cost?.length)return baseline;
    const catalog=new Map(JSON.parse(pkg.get_all_items()).map(item=>[item.name,item]));
    const solve=async(model,settings,_,warm)=>{
        let r=solveWithIncumbent(highs,model,settings,warm,false);
        if(r.Status==='Infeasible')r=solveWithIncumbent(highs,model,{...settings,presolve:'off'},warm,false);
        if(r.Status!=='Optimal'||!r.Columns)return null;
        return {values:Array.from({length:model.variables},(_,v)=>r.Columns['x'+v]?.Primal??0),
            objective:r.ObjectiveValue,proven:true};
    };
    progress('recipe_switching','start');
    let best=baseline, source=null, bestContext=null, bestFromSource=false;
    const consolidateSource=async(src)=>{
        if(!src?.plan?.comparison_seed?.values || !src.problem || !src.payload || !src.stage)return src;
        try{
            // The tiebreak-free source solve can split plots across redundant climate buildings.
            // Consolidate climate before fitCapacity freezes climate posts and their workers.
            const refined=await minimizeClimate(pkg,solve,src.problem,src.payload,JSON.stringify(src.stage),
                src.plan,src.plan.comparison_seed.values,{relaxPairs:src.relaxPairs});
            if(refined.changed){
                const nextPlan={...refined.plan,
                    comparison_seed:{keys:refined.problem.variable_keys,values:refined.values},
                    active_continuous_recipes:src.plan.active_continuous_recipes};
                for(const key of ['source_upper_bound','source_pace','upper_bound']){
                    if(Object.hasOwn(src.plan,key))nextPlan[key]=src.plan[key];
                }
                return {...src,plan:nextPlan,problem:refined.problem,payload:refined.payload};
            }
        }catch{
            // Keep the verified source shift if climate consolidation fails.
        }
        return src;
    };
    const evaluateBackground=async(background,fromSource)=>{
        const demand=workshopDemand(input,background,catalog);
        if(!demand || !demand.chains.some(c=>c.jobs.some(j=>j.rate>0)))return;
        const before=best.level_up_preview?.seconds;
        if(!fromSource && Number.isFinite(before) && before<demand.seconds*(1-1e-5))return;
        const active=demand.chains.filter(c=>facilities.includes(c.facility)&&c.jobs.some(j=>j.rate>0));
        if(!active.length)return;
        const recipes=[...new Set([...checkedRecipes(baseline),...checkedRecipes(background),...active.flatMap(c=>c.jobs.map(j=>j.recipe))])];
        const fixed={...input,always_running_recipes:recipes,restrict_to_checked_recipes:false,recipe_switching_relaxation:false};
        const priorities=input.priorities??[],rv=priorities.indexOf('level_up');
        const earlier=new Set(rv<0?priorities:priorities.slice(0,rv));
        // A zero floor keeps the secondary currency's sale columns in the
        // report while leaving a higher-ranked improvement free to win.
        const stage={pace:0,crop_variety:baseline.comparison_scores?.crop_variety??null,
            floors:(baseline.comparison_goals?.floors??[]).map(([name,n])=>[name,earlier.has(name)?n:0])};
        const fixedProblem=JSON.parse(pkg.exact_problem(JSON.stringify(fixed),JSON.stringify(stage)));
        const moving=active.map(c=>c.facility);
        const consider=async(trial,facilities,mode,problem)=>{
            const draft=fitCapacity(pkg,highs,trial,baseline,background,demand,facilities,mode,stage,catalog,problem);
            if(!draft)return;
            const verified=await validate(trial,draft,baseline);
            if(verified && prefersWorkshopPlan(verified,best)){
                best=verified;
                bestContext={trial,stage,problem,moving:facilities};
                bestFromSource=fromSource;
            }
            return verified;
        };
        await consider(fixed,moving,'fixed',fixedProblem);
        if(Number.isFinite(best.level_up_preview?.seconds) && best.level_up_preview.seconds<=demand.seconds*(1+1e-5))return;
        const required=active.filter(c=>needsSharedSite(input,c,fixedProblem,catalog)).map(c=>c.facility);
        // A shared worker or power constraint can make dedicated recipes
        // too slow even when the building count alone permits the shift.
        const groups=required.length && required.length<moving.length ? [required,moving] : [moving];
        for(const shared of groups){
            const trial={...fixed,recipe_switching_relaxation:true,recipe_switching_facilities:shared};
            const problem=JSON.parse(pkg.exact_problem(JSON.stringify(trial),JSON.stringify(stage)));
            await consider(trial,shared,'manual',problem);
            if(problem.recipe_options?.some(([,name,f,,electric])=>electric&&shared.includes(f)&&materialChains[f].includes(name))){
                const powered=await consider(trial,shared,'electric',problem);
                if(!Number.isFinite(powered?.level_up_preview?.seconds) || powered.level_up_preview.seconds>demand.seconds*(1+1e-5))
                    await consider(trial,shared,'mixed',problem);
            }
            if(Number.isFinite(best.level_up_preview?.seconds) && best.level_up_preview.seconds<=demand.seconds*(1+1e-5))break;
        }
    };
    try{
        source=await consolidateSource(optimizeWorkshopSources(pkg,highs,input,baseline,catalog,{proveBound:false}));
        if(source)await evaluateBackground(source.plan,true);
        await evaluateBackground(baseline,false);
        // If a custom-roster switching plan actually beat baseline using the
        // lightweight source pass, run the full source recipe-discovery pass
        // so newly unlocked secondary-income recipes are never missed.
        if(best!==baseline && bestFromSource && input.roster && source?.proveSourceBound){
            const fullSource=await consolidateSource(optimizeWorkshopSources(pkg,highs,input,baseline,catalog,{proveBound:true}));
            if(fullSource){
                const prevCoins=source.plan.rate_per_second??0;
                source=fullSource;
                if((fullSource.plan.rate_per_second??0)>prevCoins+1e-6){
                    await evaluateBackground(fullSource.plan,true);
                }
            }
        }
    }finally{progress('recipe_switching','done',false);}
    if(best!==baseline){
        // Switch-workshop backgrounds come from the tiebreak-free source solve.
        // Consolidate climate buildings and refine E-mode on non-switching recipes
        // while strictly preserving occupied Aniimo, priorities, income and schedule.
        if(bestContext && best.comparison_seed?.values){
            const {trial,stage,problem,moving}=bestContext;
            const payload=JSON.stringify(trial),stageJson=JSON.stringify(stage);
            const acceptRefined=async(values)=>{
                const rebuilt=JSON.parse(pkg.exact_plan(payload,stageJson,
                    JSON.stringify({values,proven:false,bound:0,verify_only:true})));
                if(!keepsProduction(best,rebuilt))return false;
                const active=[...new Set(problem.recipe_variables.filter(([v])=>values[v]>1e-8).map(([,name])=>name))];
                const counts={};
                for(const [name,terms] of problem.integer_groups??[])
                    counts[name]=(counts[name]??0)+Math.round(terms.reduce((n,[v,c])=>n+values[v]*c,0));
                for(const [v,name] of problem.recipe_variables)if(problem.variable_keys[v].startsWith('continuous_site:'))
                    counts[name]=(counts[name]??0)+Math.round(values[v]);
                const pace=problem.variable_keys.indexOf('pace#0');
                const genCol=problem.variable_keys.indexOf('generators#0');
                const plannedGens=!trial.roster && genCol>=0 ? Math.round(values[genCol]??0) : 0;
                const currency=trial.currency??'coins',priorities=trial.priorities??[];
                let candidate={...rebuilt,upper_bound:null,proven_optimal:false,continuous_production_checked:!!trial.always_running,
                    active_continuous_recipes:active,continuous_checked_recipes:trial.always_running_recipes,continuous_site_counts:counts,
                    comparison_seed:{keys:problem.variable_keys,values},comparison_scores:{crop_variety:stage.crop_variety},
                    comparison_goals:{currency,currency_value:rebuilt.rate_per_second,crop_variety:stage.crop_variety,
                        pace:priorities.includes('level_up')&&pace>=0?values[pace]:null,
                        floors:(rebuilt.priorities??[]).filter(p=>p.target!=='level_up').map(p=>[p.target,p.per_second])}};
                if(plannedGens>(candidate.power_generators??0)){
                    candidate=sizeAutomaticGenerators(candidate,trial,plannedGens,candidate.power_used??0);
                }
                let verified=await validate(trial,candidate,baseline);
                if(verified && !trial.roster && verified.power_used!=null && verified.generator_watts_by_lightning?.length){
                    verified=sizeAutomaticGenerators(verified,trial,0,verified.power_used);
                }
                if(verified && keepsProduction(best,verified)
                    && (verified.recipe_schedule?.switches?.length??0)<=(best.recipe_schedule?.switches?.length??0)){
                    best=verified;
                    return true;
                }
                return false;
            };
            try{
                const climate=await refineClimate(problem,{values:best.comparison_seed.values},solve);
                if(climate?.values && climate.values!==best.comparison_seed.values)await acceptRefined(climate.values);
            }catch{
                // Keep the already-certified workshop plan if climate refinement fails.
            }
            if(input.e_mode_rv>=12 || input.electricity){
                try{
                    const fixedRecipes=best.recipe_schedule ? new Set(moving.flatMap(f=>materialChains[f])) : undefined;
                    const seedValues=best.comparison_seed.values;
                    const kept=new Set([...(best.active_continuous_recipes??[]),...(fixedRecipes??[]),
                        ...(problem.recipe_variables??[]).filter(([v])=>Math.abs(seedValues[v]??0)>1e-12).map(([,name])=>name)]);
                    const off=new Set((problem.recipe_variables??[]).filter(([,name])=>!kept.has(name)).map(([v])=>v));
                    const rawReport=values=>JSON.parse(pkg.exact_plan(payload,stageJson,
                        JSON.stringify({values,proven:false,bound:0,verify_only:true,summary_only:true})));
                    let refinedLp=off.size ? problem.lp.replace(/^ (?:0 <= x(\d+) <= [^\n]+|x(\d+) >= 0)$/gm,
                        (line,a,b)=>off.has(Number(a??b))?` 0 <= x${a??b} <= 0`:line) : problem.lp;
                    let extraWatts=0;
                    const genCol=problem.variable_keys.indexOf('generators#0');
                    if(best.recipe_schedule){
                        // Physical switching sites draw whole-building watts while the LP
                        // prices fractional site shares. Reserve that exact watt overhead
                        // so background E-mode switches never exceed the physical grid.
                        const lpPower=rawReport(seedValues)?.power_used??0;
                        extraWatts=Math.max(0,(best.power_used??lpPower)-lpPower);
                        if(extraWatts>1e-6){
                            const genCols=problem.variable_keys.flatMap((k,v)=>
                                k==='generators#0'||k.startsWith('staff:Crackle Generator:')?[v]:[]);
                            if(genCols.length){
                                const genRe=new RegExp(` - \\d+(?:\\.\\d+)? x(?:${genCols.join('|')})\\b`);
                                const lines=refinedLp.split('\n');
                                for(let i=0;i<lines.length;i++){
                                    const genIdx=lines[i].search(genRe);
                                    if(genIdx<0 || !lines[i].endsWith(' <= 0'))continue;
                                    const drawPrefix=lines[i].slice(lines[i].indexOf(':')+1,genIdx);
                                    lines[i]=lines[i].slice(0,-5)+' <= '+(-extraWatts);
                                    for(let j=i-1;j>=0;j--){
                                        const prev=lines[j].match(/^ c\d+:(.+) <= (\d+(?:\.\d+)?)$/);
                                        if(prev && prev[1]===drawPrefix){
                                            lines[j]=lines[j].slice(0,-prev[2].length)+Math.max(0,Number(prev[2])-extraWatts);
                                            break;
                                        }
                                    }
                                    break;
                                }
                                refinedLp=lines.join('\n');
                            }
                        }
                    }
                    const report=extraWatts>1e-6 && !trial.roster && genCol>=0
                        ? values=>{
                            const rep=rawReport(values);
                            if(!rep?.success)return rep;
                            const planned=Math.max(Math.round(values[genCol]??0), values===seedValues ? (best.power_generators??0) : 0);
                            return planned>(rep.power_generators??0) ? {...rep,power_generators:planned} : rep;
                        }
                        : rawReport;
                    const restricted=refinedLp!==problem.lp ? {...problem,lp:refinedLp} : problem;
                    const refined=await refineElectricStaffing(restricted,{values:best.comparison_seed.values},solve,
                        {pkg,input:trial,report,fixedRecipes});
                    if(refined?.values && refined.values!==best.comparison_seed.values){
                        let nextValues=refined.values;
                        try{
                            const climate=await refineClimate(problem,{values:nextValues},solve);
                            if(climate?.values && climate.values!==nextValues && keepsProduction(report(nextValues),report(climate.values)))
                                nextValues=climate.values;
                        }catch{}
                        await acceptRefined(nextValues);
                    }
                }catch{
                    // Keep the already-certified workshop plan if E-mode refinement fails.
                }
            }
        }
        best.upper_bound=incomeBound(pkg,highs,input,baseline,best,catalog,facilities,source);
        if(Number.isFinite(best.upper_bound) && best.upper_bound<=best.rate_per_second*(1+1e-7))
            best.proven_optimal=true;
    }
    return best;
}
