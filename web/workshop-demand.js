// Size the physical workshops for one RV upgrade. All quantities are
// fractional batches, as in the exact production model.
import {materialChains} from './material-flow-schedule.js';
import {CURRENCY_GAP_FACTOR,CURRENCY_RELATIVE_GAP,productionObjective} from './priority-search.js';
import {obbtSiteLimits,solveEconomicBound,suggestEconomicScope} from './economic-bound.js';
import {priorityCeiling} from './priority-ceilings.js';
import {planSearchOptions,polishSolution,runPlanModel} from './highs-solve.js';
import {questIncome} from './quest-income.js';

const DAY=86400;
const rawResources={wood_block:'Wood Blocks',mineral_sand:'Mineral Sand'};

function amounts(entries){
    const result=new Map();
    for(const [name,n] of entries??[])result.set(name,(result.get(name)??0)+n);
    return result;
}

function workshopInputs(input,catalog){
    const excluded=new Set(input.exclude??[]);
    return Object.entries(materialChains).map(([facility,names])=>{
        const raw=facility==='Woodworking Bench'?'wood_block':'mineral_sand';
        const sites=input.facilities?.[facility]??[];
        const jobs=names.map((recipe,i)=>{
            const item=catalog.get(recipe), feed=i?names[i-1]:raw;
            if(item?.raw_materials?.length!==1 || item.raw_materials[0]!==feed ||
                !(item.required_amount?.[0]>0 && item.yield_amount>0))return null;
            return {recipe,input:feed,quantity:item.required_amount[0],yield:item.yield_amount,
                open:!excluded.has(recipe)&&sites.some(t=>t.count>0 && t.level>=item.facility_level)};
        });
        return {facility,raw,names,jobs};
    });
}

function backgroundRates(input,plan,catalog){
    const rates=new Map(),quest=questIncome(input.quest_income_per_day);
    for(const [raw,resource] of Object.entries(rawResources)){
        const produced=(plan.byproduct_rates??[]).reduce((sum,[name,n])=>sum+(name===resource?n:0),0);
        rates.set(raw,produced+(quest[raw]??0)/DAY);
    }
    for(const row of plan.coin_items??[]){
        if(row.status!=='producing' || materialChains[row.facility]?.includes(row.item_name))continue;
        const item=catalog.get(row.item_name);
        if(!item)return null;
        for(const [i,feed] of (item.raw_materials??[]).entries()){
            if(!(row.cycle_time>0 && row.busy_units>=0))return null;
            rates.set(feed,(rates.get(feed)??0)-item.required_amount[i]*row.busy_units/row.cycle_time);
        }
    }
    return rates;
}

// A downstream shortfall is the maximum of zero and a few affine functions
// of elapsed time. Pass every term upstream so stock at one tier can never
// pay both its direct cost and the same units in the next recipe.
export function workshopDemand(input,plan,catalog,capacity={},minimumSeconds=1){
    const target=input.level_up??input.level_up_preview;
    if(!target?.cost?.length || !plan)return null;
    const stock=amounts(target.stock),cost=amounts(target.cost);
    if([...cost].every(([name,n])=>n<=(stock.get(name)??0)))return null;
    const chains=workshopInputs(input,catalog),rates=backgroundRates(input,plan,catalog);
    if(!rates)return null;
    const report=plan.level_up_preview??plan.level_up;
    const otherRates=new Map((report?.requirements??[]).map(r=>[r.name,r.per_second]));
    const currency=plan.currency??input.currency??'coins';
    if(currency==='coins')otherRates.set('coins',plan.rate_per_second);
    else if(!otherRates.has('coins'))otherRates.set('coins',plan.priorities?.find(p=>p.target==='coins')?.per_second??0);
    const materials=new Set(chains.flatMap(c=>[c.raw,...c.names]));
    let earliest=Math.max(1,minimumSeconds),latest=Infinity;
    // Every constraint has the form amount <= perSecond * horizon.
    const constrain=(amount,perSecond)=>{
        if(perSecond>0)earliest=Math.max(earliest,amount/perSecond);
        else if(perSecond<0)latest=Math.min(latest,amount/perSecond);
        else if(amount>0)earliest=Infinity;
    };
    const deficit=name=>(cost.get(name)??0)-(stock.get(name)??0);
    for(const [name] of cost){
        if(!materials.has(name))constrain(deficit(name),otherRates.get(name)??0);
    }
    for(const chain of chains){
        let downstream=[[0,0]];
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i],name=chain.names[i];
            const net=rates.get(name)??0;
            const work=downstream.map(([n,r])=>[n+deficit(name),r-net]);
            const max=job?.open?(capacity[name]??Infinity):0;
            if(Number.isFinite(max)){
                for(const [n,r] of work)constrain(n,max*(job?.yield??1)-r);
            }
            downstream=job?[[0,0],...work.map(([n,r])=>[n*job.quantity/job.yield,r*job.quantity/job.yield])]:[[0,0]];
        }
        chain.supply=rates.get(chain.raw)??0;
        for(const [n,r] of downstream)constrain(n+deficit(chain.raw),chain.supply-r);
    }
    if(!Number.isFinite(earliest)||earliest>latest)return null;
    const seconds=earliest;
    for(const chain of chains){
        let downstream=0;
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i];
            if(!job)continue;
            const items=Math.max(0,downstream+deficit(job.recipe)-(rates.get(job.recipe)??0)*seconds);
            job.batches=items/job.yield;
            job.rate=job.batches/seconds;
            downstream=job.batches*job.quantity;
        }
        chain.jobs=chain.jobs.filter(job=>job?.open);
    }
    return {seconds,chains};
}

function solveBoundedMax(highs,problem,cutoff,{stopOnFeasible=false}={}) {
    if(!highs?.createModel){
        const lp=problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd');
        const relaxation=highs.solve(lp);
        if(relaxation.Status!=='Optimal' || !(relaxation.ObjectiveValue>0) || (cutoff>0 && relaxation.ObjectiveValue<=cutoff))
            return {provedBelow:true};
        const solution=highs.solve(problem.lp,{mip_rel_gap:0,mip_abs_gap:0});
        if(solution.Status!=='Optimal' || !(solution.ObjectiveValue>0) || !solution.Columns)return null;
        if(cutoff>0 && solution.ObjectiveValue<=cutoff)return {provedBelow:true};
        return {objective:solution.ObjectiveValue,values:problem.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0)};
    }
    const model=highs.createModel({format:'lp',data:problem.lp});
    const statuses=highs.constants.modelStatus;
    try{
        const lpData=model.getLp();
        const numCols=lpData.numCols;
        const indices=Array.from({length:numCols},(_,i)=>Number(model.getColName(i).slice(1)));
        if(indices.some(v=>!Number.isInteger(v)||v<0||v>=problem.variables))return null;
        const origIntegrality=lpData.integrality.slice();
        const integerCols=[];
        for(let i=0;i<numCols;i++)if(origIntegrality[i]===1)integerCols.push(i);
        // Solve LP relaxation first; when a baseline cutoff exists, iteratively
        // fix integer bounds whose reduced cost strictly exceeds (LP - cutoff).
        if(integerCols.length){
            model.changeColsIntegrality({kind:'set',indices:integerCols},integerCols.map(()=>0));
        }
        model.options.set({primal_feasibility_tolerance:1e-9,dual_feasibility_tolerance:1e-9});
        model.run();
        const lpStatus=model.getModelStatus();
        if(lpStatus===statuses.infeasible)return {provedBelow:true};
        if(lpStatus===statuses.optimal){
            const lpObj=model.getObjectiveValue();
            if(!(lpObj>0) || (cutoff>0 && lpObj<=cutoff))return {provedBelow:true};
        }
        if(integerCols.length){
            model.changeColsIntegrality({kind:'set',indices:integerCols},integerCols.map(()=>1));
        }
        const runMip=()=>{
            model.clearSolver();
            model.options.set({mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9,primal_feasibility_tolerance:1e-9});
            if(!(cutoff>0))return model.run();
            return model.run({[highs.constants.callbackType.mipInterrupt]:event=>{
                const dual=event.data.mip_dual_bound,primal=event.data.mip_primal_bound;
                if(Number.isFinite(dual) && dual<=cutoff)event.interrupt();
                else if(stopOnFeasible && Number.isFinite(primal) && primal>cutoff)event.interrupt();
            }});
        };
        runMip();
        if(model.getModelStatus()===statuses.infeasible){
            model.options.set({presolve:'off'});
            runMip();
        }
        const status=model.getModelStatus();
        if(status===statuses.infeasible)return {provedBelow:true};
        const dual=status===statuses.optimal ? model.getObjectiveValue() : model.info.get('mip_dual_bound');
        if(cutoff>0 && Number.isFinite(dual) && dual<=cutoff)return {provedBelow:true};
        const hasFeasible=model.info.get('primal_solution_status')===highs.constants.solutionStatus.feasible;
        if(!hasFeasible)return null;
        const objective=model.getObjectiveValue();
        if(!stopOnFeasible && status!==statuses.optimal)return null;
        if(!(objective>0) || (cutoff>0 && objective<=cutoff))return {provedBelow:true};
        const native=model.getSolution().colValue;
        const values=Array(problem.variables).fill(0);
        for(let i=0;i<numCols;i++)values[indices[i]]=native[i];
        const polished=polishSolution(highs,problem,{objective,values});
        return {objective:polished.objective,values:polished.values};
    }finally{
        model.dispose();
    }
}

function unguardedRecipes(problem,values,scope){
    if(scope==null || !Array.isArray(problem.recipe_variables))return [];
    const checked=new Set(scope),missing=new Set();
    for(const [v,name] of problem.recipe_variables){
        if(values[v]>1e-9 && !checked.has(name))missing.add(name);
    }
    return [...missing];
}

// Give the source model just the net raw cost of the upgrade. It can vary
// all gathering and income together while keeping shared workers, crops,
// seasonal minimums, stations, power and earlier priorities in the same model.
export function optimizeWorkshopSources(pkg,highs,input,base,catalog,{proveBound=true}={}){
    const target=input.level_up??input.level_up_preview;
    if(!target?.cost?.length || input.fixed_homeland)return null;
    const cost=amounts(target.cost),stock=amounts(target.stock),facilities={...input.facilities};
    let needsGathering=false;
    for(const chain of workshopInputs(input,catalog)){
        let needed=0;
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i],name=chain.names[i];
            needed=Math.max(0,needed+(cost.get(name)??0)-(stock.get(name)??0));
            if(needed && !job?.open)return null;
            needed=needed* (job?job.quantity/job.yield:0);
            cost.delete(name);
            stock.delete(name);
        }
        const rawCost=needed+(cost.get(chain.raw)??0);
        if(rawCost)cost.set(chain.raw,rawCost);
        needsGathering ||= rawCost>(stock.get(chain.raw)??0);
        facilities[chain.facility]=[{count:0,level:1}];
    }
    if(!needsGathering)return null;
    const sourceInput={...input,currency:'coins',facilities,level_up:null,level_up_preview:{cost:[...cost],stock:[...stock]}};
    const priorities=input.priorities??[],rv=priorities.indexOf('level_up');
    const protectedGoals=new Set(rv<0?priorities:priorities.slice(0,rv));
    if(input.prioritize_byproducts)for(const resource of Object.values(rawResources))protectedGoals.add(resource);
    const floors=new Map((base.comparison_goals?.floors??[]).filter(([name])=>protectedGoals.has(name)));
    for(const {target,per_second} of base.priorities??[]){
        if(protectedGoals.has(target))floors.set(target,per_second);
    }
    // Rust allows 1e-4 slack on currency floors and 1e-6 on byproduct floors
    // between stages. Undo that allowance for every protected goal so releasing
    // the workshops cannot spend any higher-ranked priority.
    const currency=base.currency??input.currency??'coins';
    if(protectedGoals.has(currency) || rv<0)floors.set(currency,base.rate_per_second);
    const coinFloorRaw=floors.get('coins');
    const byproductTargets=new Set(Object.values(rawResources));
    const floorSlack=name=>byproductTargets.has(name)?1e-6:1e-4;
    for(const [name,val] of [...floors]){
        if(val>0)floors.set(name,val*(1-1e-8)/(1-floorSlack(name)));
    }
    const stage={floors:[...floors],crop_variety:base.comparison_scores?.crop_variety??null};
    const current=workshopDemand(input,base,catalog);
    const currentPace=current ? DAY/(current.seconds*(1-1e-8)) : 0;
    // When level_up is already a selected priority, baseline's stage pace
    // already reflects the non-switching optimum before exact.rs's 1e-4 stage
    // slack. Require beating that pace so releasing workshops never trades away
    // lower priorities just to reclaim 0.01% of inter-stage slack.
    const baseGoalPace=rv>=0 && Number.isFinite(base.comparison_goals?.pace) && base.comparison_goals.pace>0
        ? base.comparison_goals.pace*(1+1e-7) : 0;
    const minPace=Math.max(currentPace,baseGoalPace);
    // Leave a tiny safety margin below minPace so floating-point noise never prunes a borderline gain.
    const cutoff=minPace>0 ? minPace*(1-1e-10) : 0;

    // When coin income is already protected at its maximum, screening
    // "max coins s.t. pace >= cutoff" has a sharp reduced-cost gap and
    // proves impossibility orders of magnitude faster than maximizing pace.
    const useCoinScreen=highs?.createModel && cutoff>0 && coinFloorRaw>0 && currency==='coins';
    const coinScreenThreshold=useCoinScreen ? coinFloorRaw*(1-1e-9) : 0;
    const flipStage=useCoinScreen ? {
        floors:[...floors].filter(([name])=>name!=='coins'),
        crop_variety:stage.crop_variety,
        pace:cutoff/(1-1e-4),
    } : null;

    // Lazily introduce always_running constraints only for recipes that become
    // occupied. Every partial scope is a strict relaxation of the full model,
    // so an upper bound <= cutoff immediately proves no faster source exists.
    let scope=sourceInput.always_running ? [] : null;
    let relaxPairs=!sourceInput.relax_pair_coverage;
    for(let round=0;round<9;round++){
        const trialInput=scope==null
            ? {...sourceInput,compact_dispatch:true,relax_pair_coverage:relaxPairs,always_running_recipes:undefined,restrict_to_checked_recipes:false}
            : {...sourceInput,compact_dispatch:true,relax_pair_coverage:relaxPairs,always_running_recipes:scope,restrict_to_checked_recipes:false};
        const payload=JSON.stringify(trialInput);
        if(useCoinScreen){
            const screenPayload=scope==null ? payload : JSON.stringify({...trialInput,relax_min_reasons:true});
            const screenProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(screenPayload,JSON.stringify(flipStage),'coins')));
            if(screenProblem.lp){
                const screened=solveBoundedMax(highs,screenProblem,coinScreenThreshold,{stopOnFeasible:true});
                if(!screened || screened.provedBelow)return null;
                const missing=unguardedRecipes(screenProblem,screened.values,scope);
                if(missing.length){
                    const suggested=suggestEconomicScope(screenProblem,screened.values,[...scope,...missing]);
                    scope=round<6 ? [...new Set([...scope,...missing,...suggested])] : null;
                    continue;
                }
            }
        }
        let problem=productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),'level_up')));
        if(!problem.lp)return null;
        const solved=solveBoundedMax(highs,problem,cutoff);
        if(!solved || solved.provedBelow)return null;
        let {objective,values}=solved;
        if(current && DAY/objective>=current.seconds*(1-1e-8))return null;
        const missing=unguardedRecipes(problem,values,scope);
        if(missing.length){
            const suggested=suggestEconomicScope(problem,values,[...scope,...missing]);
            scope=round<6 ? [...new Set([...scope,...missing,...suggested])] : null;
            continue;
        }
        if(relaxPairs && problem.variable_keys.some((key,v)=>key.startsWith('pair_relax:') && values[v]>0.5)){
            relaxPairs=false;
            continue;
        }
        // Optimize every priority that follows level_up in lexicographic order
        // (including implicit currency when not listed), instead of returning an
        // arbitrary tied shift that discards intermediate goals or coin income.
        let finalPayload=payload;
        let finalStage={...stage,pace:objective};
        let finalRelaxPairs=relaxPairs;
        let currencyUpper=Infinity;
        let proveSourceBound=null;
        const postPriorities=rv>=0 ? [...priorities.slice(rv+1)] : [];
        if(rv>=0 && !priorities.includes(currency))postPriorities.push(currency);
        if(postPriorities.length && highs?.createModel){
            const postStage={...stage,floors:[...stage.floors],pace:objective*(1-1e-6)/(1-1e-4)};
            const workshopRecipes=new Set(Object.values(materialChains).flat());
            const baseRecipes=(base.active_continuous_recipes??[]).filter(name=>!workshopRecipes.has(name));
            const levelUpActive=(problem.recipe_variables??[]).filter(([v])=>values[v]>1e-9).map(([,name])=>name);
            let postScope=sourceInput.always_running ? [...new Set([...(scope??levelUpActive),...baseRecipes])] : null;
            let postRelaxPairs=relaxPairs;
            let currentValues=values, currentKeys=problem.variable_keys;
            const buildWarm=(p,prevKeys,prevValues)=>{
                if(!prevKeys || !prevValues || prevKeys.length!==prevValues.length)return null;
                const byKey=new Map(prevKeys.map((k,i)=>[k,prevValues[i]]));
                const warm=p.variable_keys.map(k=>k.startsWith('extra#')?0:(byKey.get(k)??0));
                return warm.every(Number.isFinite)?warm:null;
            };
            const solvePost=(pProblem,warm,{nodes,iters,relGap})=>{
                const cm=highs.createModel({format:'lp',data:pProblem.lp});
                const statuses=highs.constants.modelStatus;
                try{
                    const lpData=cm.getLp();
                    const numCols=lpData.numCols;
                    const idx=Array.from({length:numCols},(_,i)=>Number(cm.getColName(i).slice(1)));
                    cm.options.set({mip_max_nodes:nodes,mip_rel_gap:relGap,mip_abs_gap:0});
                    if(warm){
                        const hasExtra=pProblem.variable_keys.some(k=>k.startsWith('extra#'));
                        const allExtraZero=hasExtra && pProblem.variable_keys.every((k,v)=>!k.startsWith('extra#') || Math.abs(warm[v]??0)<=1e-12);
                        try{
                            if(hasExtra && allExtraZero){
                                const sparse={indices:[],values:[]};
                                for(let i=0;i<numCols;i++){
                                    const v=idx[i], key=pProblem.variable_keys[v], val=warm[v];
                                    if(lpData.integrality[i]===1 && !key.startsWith('extra#') && Number.isFinite(val)
                                        && Math.abs(val-Math.round(val))<1e-6){
                                        const r=Math.round(val);
                                        if(r>=lpData.colLower[i]-1e-7 && r<=lpData.colUpper[i]+1e-7){
                                            sparse.indices.push(i);sparse.values.push(r);
                                        }
                                    }
                                }
                                if(sparse.indices.length)cm.setSolution(sparse);
                            }else{
                                const colValue=idx.map(v=>warm[v]??0);
                                cm.setSolution({colValue});
                            }
                        }catch{}
                    }
                    runPlanModel(cm,highs,undefined,undefined,iters);
                    if(cm.getModelStatus()===statuses.infeasible){
                        cm.clearSolver();
                        cm.options.set({presolve:'off'});
                        if(warm)cm.setSolution({colValue:idx.map(v=>warm[v]??0)});
                        runPlanModel(cm,highs,undefined,undefined,iters);
                    }
                    const st=cm.getModelStatus();
                    let dual=null;
                    try{
                        const rawDual=cm.info.get('mip_dual_bound');
                        if(Number.isFinite(rawDual))dual=rawDual;
                    }catch{}
                    if(st===statuses.optimal && relGap===0){
                        const optObj=cm.getObjectiveValue();
                        if(Number.isFinite(optObj))dual=optObj;
                    }
                    if(cm.info.get('primal_solution_status')!==highs.constants.solutionStatus.feasible){
                        return {values:null,obj:null,dual};
                    }
                    const native=cm.getSolution().colValue;
                    let pValues=Array(pProblem.variables).fill(0);
                    for(let i=0;i<numCols;i++)pValues[idx[i]]=native[i];
                    const rawObj=pProblem.primary_objective.reduce((s,[v,c])=>s+c*pValues[v],0);
                    const polished=polishSolution(highs,pProblem,{objective:rawObj,values:pValues});
                    pValues=polished.values;
                    const pObj=pProblem.primary_objective.reduce((s,[v,c])=>s+c*pValues[v],0);
                    if(st===statuses.optimal && Number.isFinite(dual) && dual<pObj)dual=pObj;
                    return {values:pValues,obj:pObj,dual};
                }finally{
                    cm.dispose();
                }
            };
            const usesRelaxPair=(pProblem,pValues)=>Boolean(pValues && pProblem.variable_keys.some((key,v)=>key.startsWith('pair_relax:') && pValues[v]>0.5));
            const liftFixedSites=(targetInput,target,sourceKeys,sourceValues,{noRelaxPair=false}={})=>{
                const lPayload=JSON.stringify(targetInput);
                const lProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(lPayload,JSON.stringify(postStage),target)));
                if(!lProblem.lp)return null;
                const byKey=new Map(sourceKeys.map((k,i)=>[k,sourceValues[i]]));
                const cm=highs.createModel({format:'lp',data:lProblem.lp});
                const statuses=highs.constants.modelStatus;
                try{
                    const {numCols}=cm.getDimensions();
                    const idx=Array.from({length:numCols},(_,i)=>Number(cm.getColName(i).slice(1)));
                    const warm=[];
                    for(let i=0;i<numCols;i++){
                        const v=idx[i], key=lProblem.variable_keys[v];
                        const val=byKey.get(key)??0;
                        warm.push(key.startsWith('extra#')?0:val);
                        if(/^(units:|continuous_site:)/.test(key)){
                            const fixed=Math.max(0,Math.round(val));
                            cm.changeColBounds(i,fixed,fixed);
                        }else if(noRelaxPair && key.startsWith('pair_relax:')){
                            cm.changeColBounds(i,0,0);
                        }
                    }
                    cm.options.set({mip_max_nodes:32,mip_rel_gap:target===currency?CURRENCY_RELATIVE_GAP:0,mip_abs_gap:0});
                    if(warm.every(Number.isFinite))cm.setSolution({colValue:warm});
                    runPlanModel(cm,highs,undefined,undefined,8000);
                    if(cm.getModelStatus()===statuses.infeasible){
                        cm.clearSolver();
                        cm.options.set({presolve:'off'});
                        runPlanModel(cm,highs,undefined,undefined,8000);
                    }
                    if(cm.info.get('primal_solution_status')!==highs.constants.solutionStatus.feasible)return null;
                    const native=cm.getSolution().colValue;
                    const rawValues=Array(lProblem.variables).fill(0);
                    for(let i=0;i<numCols;i++)rawValues[idx[i]]=native[i];
                    const rawObj=lProblem.primary_objective.reduce((s,[v,c])=>s+c*rawValues[v],0);
                    const polished=polishSolution(highs,lProblem,{objective:rawObj,values:rawValues});
                    const lValues=polished.values;
                    const lPaceCol=lProblem.variable_keys.indexOf('pace#0');
                    if(lPaceCol>=0 && lValues[lPaceCol]<objective*(1-1e-5))return null;
                    if(noRelaxPair && usesRelaxPair(lProblem,lValues))return null;
                    const lObj=lProblem.primary_objective.reduce((s,[v,c])=>s+c*lValues[v],0);
                    return {values:lValues,obj:lObj,problem:lProblem,payload:lPayload};
                }finally{
                    cm.dispose();
                }
            };
            const fullPostBudget=planSearchOptions({time_limit:30,mip_rel_gap:CURRENCY_RELATIVE_GAP,mip_abs_gap:0});
            for(const target of postPriorities){
                let bestValues=null, bestProblem=null, bestPayload=null, bestObj=null;
                const relGap=target===currency ? CURRENCY_RELATIVE_GAP : 0;
                if(target===currency && sourceInput.always_running){
                    const activePrior=(problem.recipe_variables??[]).filter(([v])=>currentValues[v]>1e-9).map(([,name])=>name);
                    const restrictedCache=new Map();
                    const currencyPostStage=structuredClone(postStage);
                    const runBoundRounds=({rawProblem,proofScope,seedRecipes,initialWitness,relaxPairsFlag,maxRounds,floorOverride=0,updateWitness=true})=>{
                        let witness=initialWitness, earned=Math.max(initialWitness?.obj??-Infinity, floorOverride>0 ? floorOverride : -Infinity);
                        let relaxedBound=true, prevBoundObj=null, flatRelaxedRounds=0;
                        let obbtLimits={}, obbtFloor=0;
                        const obbtProbed=new Set();
                        const solveRes=(recipes,warmKeys,warmVals)=>{
                            const rScope=[...recipes].sort();
                            const cacheKey=`${relaxPairsFlag?1:0}:${rScope.join('\0')}`;
                            if(restrictedCache.has(cacheKey))return restrictedCache.get(cacheKey);
                            const rInput={...sourceInput,compact_dispatch:true,relax_pair_coverage:relaxPairsFlag,
                                always_running_recipes:rScope,restrict_to_checked_recipes:true};
                            const rPayload=JSON.stringify(rInput);
                            const rProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(
                                rPayload,JSON.stringify(currencyPostStage),target)));
                            if(!rProblem.lp){restrictedCache.set(cacheKey,null);return null;}
                            const rWarm=buildWarm(rProblem,warmKeys,warmVals);
                            const rSolved=solvePost(rProblem,rWarm,{nodes:64,iters:16000,relGap:CURRENCY_RELATIVE_GAP});
                            const paceCol=rProblem.variable_keys.indexOf('pace#0');
                            const res=!rSolved.values || (paceCol>=0 && rSolved.values[paceCol]<objective*(1-1e-5))
                                ? null : {values:rSolved.values,obj:rSolved.obj,problem:rProblem,payload:rPayload,scope:rScope};
                            restrictedCache.set(cacheKey,res);
                            return res;
                        };
                        for(let round=0;round<maxRounds;round++){
                            const incomeTarget=earned>0 ? earned*CURRENCY_GAP_FACTOR : undefined;
                            if(earned>0 && Number.isFinite(currencyUpper) && currencyUpper<=incomeTarget+1e-7)break;
                            if(earned>0 && incomeTarget>0 && proofScope.size){
                                const needReprobe=earned>obbtFloor+1e-7;
                                const toProbe=needReprobe ? [...proofScope] : [...proofScope].filter(n=>!obbtProbed.has(n));
                                if(toProbe.length){
                                    const tightened=obbtSiteLimits(highs,rawProblem,toProbe,incomeTarget,obbtLimits);
                                    if(tightened?.infeasible){
                                        currencyUpper=Math.min(currencyUpper,incomeTarget);
                                        break;
                                    }
                                    if(tightened?.limits)obbtLimits=tightened.limits;
                                    if(needReprobe){obbtFloor=earned;obbtProbed.clear();}
                                    for(const n of toProbe)obbtProbed.add(n);
                                }
                            }
                            const hasLimits=Object.keys(obbtLimits).length>0;
                            const bInput={...sourceInput,compact_dispatch:true,relax_pair_coverage:relaxPairsFlag,
                                always_running_recipes:[...proofScope],restrict_to_checked_recipes:false,
                                ...(hasLimits ? {recipe_site_limits:obbtLimits} : {}),
                                ...(relaxedBound ? {relax_min_reasons:true} : {})};
                            const bPayload=JSON.stringify(bInput);
                            const bProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(
                                bPayload,JSON.stringify(currencyPostStage),target)));
                            if(!bProblem.lp)break;
                            const effort=round===0 ? 4 : 8;
                            const bound=solveEconomicBound(highs,bProblem,{
                                scope:[...proofScope],exact:false,timeLimit:effort,maxNodes:256,
                                relativeGap:CURRENCY_RELATIVE_GAP,incomeTarget,floorCertify:false,
                            });
                            if(Number.isFinite(bound?.upper))currencyUpper=Math.min(currencyUpper,bound.upper);
                            if(earned>0 && Number.isFinite(currencyUpper) && currencyUpper<=earned*CURRENCY_GAP_FACTOR+1e-7)break;
                            if(!bound?.values)break;
                            const missing=unguardedRecipes(bProblem,bound.values,[...proofScope]);
                            if(updateWitness){
                                if(!missing.length && !relaxedBound){
                                    const polished=polishSolution(highs,bProblem,bound);
                                    const paceCol=bProblem.variable_keys.indexOf('pace#0');
                                    if(polished.polished && (paceCol<0 || polished.values[paceCol]>=objective*(1-1e-5))){
                                        const bObj=bProblem.primary_objective.reduce((s,[v,c])=>s+c*polished.values[v],0);
                                        if(bObj>earned+1e-8){
                                            witness={values:polished.values,obj:bObj,problem:bProblem,payload:bPayload,scope:[...proofScope]};
                                            earned=bObj;
                                        }
                                    }
                                }else if(bound.activeRecipes?.length){
                                    const activeList=[...new Set(bound.activeRecipes)];
                                    const activeInput={...sourceInput,compact_dispatch:true,relax_pair_coverage:relaxPairsFlag,
                                        always_running_recipes:activeList,restrict_to_checked_recipes:true};
                                    let cand=liftFixedSites(activeInput,target,bProblem.variable_keys,bound.values);
                                    if(!cand || cand.obj<=earned+1e-8){
                                        const combined=new Set([...seedRecipes,...activeList]);
                                        const alt=solveRes(combined.size<=28 ? combined : activeList,bProblem.variable_keys,bound.values);
                                        if(alt && (!cand || alt.obj>cand.obj))cand=alt;
                                    }
                                    if(cand && cand.obj>earned+1e-8){
                                        witness={...cand,scope:cand.scope??activeList};
                                        earned=cand.obj;
                                    }
                                }
                            }
                            const newTarget=earned>0 ? earned*CURRENCY_GAP_FACTOR : undefined;
                            if(earned>0 && Number.isFinite(currencyUpper) && currencyUpper<=newTarget+1e-7)break;
                            let next=(bound.throttledRecipes??[]).filter(n=>!proofScope.has(n));
                            if(!next.length || round>=2){
                                const suggested=suggestEconomicScope(bProblem,bound.values,proofScope).filter(n=>!proofScope.has(n));
                                next=[...new Set([...next,...suggested])];
                            }
                            if(!next.length){
                                next=[...new Set([...missing,...(bound.occupiedRecipes??[]),...(bound.activeRecipes??[])])].filter(n=>!proofScope.has(n));
                            }
                            if(relaxedBound && Number.isFinite(bound.objective) && prevBoundObj!=null
                                && bound.objective>=prevBoundObj-5e-4*Math.max(1,Math.abs(prevBoundObj))){
                                flatRelaxedRounds++;
                            }else{
                                flatRelaxedRounds=0;
                            }
                            prevBoundObj=bound.objective;
                            for(const n of next)proofScope.add(n);
                            if(relaxedBound && flatRelaxedRounds>=1){
                                relaxedBound=false;
                                flatRelaxedRounds=0;
                                continue;
                            }
                            if(!next.length){
                                if(relaxedBound){relaxedBound=false;continue;}
                                break;
                            }
                        }
                        return {witness,earned};
                    };
                    for(let pairPass=0;pairPass<2;pairPass++){
                        const rawInput={...sourceInput,compact_dispatch:true,relax_pair_coverage:postRelaxPairs,
                            always_running_recipes:[],restrict_to_checked_recipes:false};
                        const rawProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(
                            JSON.stringify(rawInput),JSON.stringify(currencyPostStage),target)));
                        if(!rawProblem.lp)break;
                        const lpUpper=priorityCeiling(highs,rawProblem,target);
                        if(Number.isFinite(lpUpper))currencyUpper=Math.min(currencyUpper,lpUpper);
                        // Seed the primal witness with baseRecipes + active prior recipes in a
                        // tiny restricted solve, while keeping the dual-bound proofScope minimal
                        // (starting from reserved season crops only) so solveEconomicBound stays small.
                        const proofScope=new Set(Object.keys(sourceInput.season_crop_minimums??{}));
                        const seedRecipes=new Set([...activePrior,...baseRecipes,...proofScope]);
                        const solveRestricted=(recipes,warmKeys,warmVals)=>{
                            const rScope=[...recipes].sort();
                            const cacheKey=`${postRelaxPairs?1:0}:${rScope.join('\0')}`;
                            if(restrictedCache.has(cacheKey))return restrictedCache.get(cacheKey);
                            const rInput={...sourceInput,compact_dispatch:true,relax_pair_coverage:postRelaxPairs,
                                always_running_recipes:rScope,restrict_to_checked_recipes:true};
                            const rPayload=JSON.stringify(rInput);
                            const rProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(
                                rPayload,JSON.stringify(currencyPostStage),target)));
                            if(!rProblem.lp){restrictedCache.set(cacheKey,null);return null;}
                            const rWarm=buildWarm(rProblem,warmKeys,warmVals);
                            const rSolved=solvePost(rProblem,rWarm,{nodes:64,iters:16000,relGap:CURRENCY_RELATIVE_GAP});
                            const paceCol=rProblem.variable_keys.indexOf('pace#0');
                            const res=!rSolved.values || (paceCol>=0 && rSolved.values[paceCol]<objective*(1-1e-5))
                                ? null : {values:rSolved.values,obj:rSolved.obj,problem:rProblem,payload:rPayload,scope:rScope};
                            restrictedCache.set(cacheKey,res);
                            return res;
                        };
                        let witness=solveRestricted(seedRecipes,currentKeys,currentValues);
                        let earned=witness ? witness.obj : -Infinity;
                        // Defer the multi-round dual-bound proof when proveBound=false
                        // (used by searchWorkshopCapacity before fitCapacity verifies whether
                        // a switching schedule actually wins). Keep 1 discovery round if no
                        // restricted witness was found or on non-roster setups where the
                        // workshop-free source may unlock a new recipe cheaply.
                        const eagerRounds=proveBound ? (pairPass===0 ? 3 : 2)
                            : (!witness || !sourceInput.roster ? 1 : 0);
                        if(eagerRounds>0){
                            const ran=runBoundRounds({rawProblem,proofScope,seedRecipes,initialWitness:witness,
                                relaxPairsFlag:postRelaxPairs,maxRounds:eagerRounds});
                            witness=ran.witness;
                            earned=ran.earned;
                        }
                        if(witness && postRelaxPairs && usesRelaxPair(witness.problem,witness.values)){
                            const sameNoRelax=liftFixedSites(JSON.parse(witness.payload),target,
                                witness.problem.variable_keys,witness.values,{noRelaxPair:true});
                            const needsTightLift=proveBound && Number.isFinite(currencyUpper);
                            if(sameNoRelax && sameNoRelax.obj>=earned-1e-7
                                && (!needsTightLift || currencyUpper<=sameNoRelax.obj*CURRENCY_GAP_FACTOR+1e-7)){
                                witness={...sameNoRelax,scope:witness.scope};
                                earned=sameNoRelax.obj;
                            }else{
                                const exactInput={...JSON.parse(witness.payload),relax_pair_coverage:false};
                                const exactLift=liftFixedSites(exactInput,target,
                                    witness.problem.variable_keys,witness.values);
                                if(exactLift && exactLift.obj>=earned-1e-7
                                    && (!needsTightLift || currencyUpper<=exactLift.obj*CURRENCY_GAP_FACTOR+1e-7)){
                                    witness={...exactLift,scope:witness.scope};
                                    earned=exactLift.obj;
                                    postRelaxPairs=false;
                                }else{
                                    postScope=[...proofScope];
                                    postRelaxPairs=false;
                                    continue;
                                }
                            }
                        }
                        if(witness){
                            bestValues=witness.values;
                            bestProblem=witness.problem;
                            bestPayload=witness.payload;
                            bestObj=witness.obj;
                            postScope=[...proofScope];
                            if(!proveBound && !(Number.isFinite(currencyUpper) && currencyUpper<=earned*CURRENCY_GAP_FACTOR+1e-7)){
                                const lazyRelax=postRelaxPairs, lazyScope=new Set(proofScope);
                                proveSourceBound=(floorHint=0)=>{
                                    runBoundRounds({rawProblem,proofScope:lazyScope,seedRecipes,initialWitness:witness,
                                        relaxPairsFlag:lazyRelax,maxRounds:3,floorOverride:Math.max(earned,floorHint),
                                        updateWitness:false});
                                    return currencyUpper;
                                };
                            }
                        }
                        break;
                    }
                }else{
                for(let pr=0;pr<10;pr++){
                    const pInput=postScope==null
                        ? {...sourceInput,compact_dispatch:true,relax_pair_coverage:postRelaxPairs,always_running_recipes:undefined,restrict_to_checked_recipes:false}
                        : {...sourceInput,compact_dispatch:true,relax_pair_coverage:postRelaxPairs,always_running_recipes:postScope,restrict_to_checked_recipes:false};
                    const pPayload=JSON.stringify(pInput);
                    const pProblem=productionObjective(JSON.parse(pkg.exact_priority_problem(pPayload,JSON.stringify(postStage),target)));
                    if(!pProblem.lp)break;
                    const warm=buildWarm(pProblem,currentKeys,currentValues);
                    let solvedPost=solvePost(pProblem,warm,{nodes:96,iters:24000,relGap});
                    if(target===currency && Number.isFinite(solvedPost.dual))
                        currencyUpper=Math.min(currencyUpper,solvedPost.dual);
                    let {values:pValues,obj:pObj}=solvedPost;
                    const paceCol=pProblem.variable_keys.indexOf('pace#0');
                    if(!pValues || (paceCol>=0 && pValues[paceCol]<objective*(1-1e-5)))break;
                    const pMissing=unguardedRecipes(pProblem,pValues,postScope);
                    if(pMissing.length){
                        const suggested=suggestEconomicScope(pProblem,pValues,[...postScope,...pMissing]);
                        postScope=pr<8 ? [...new Set([...postScope,...pMissing,...suggested])] : null;
                        continue;
                    }
                    if(postRelaxPairs && usesRelaxPair(pProblem,pValues)){
                        const exactLift=liftFixedSites({...pInput,relax_pair_coverage:false},target,pProblem.variable_keys,pValues);
                        if(exactLift && exactLift.obj>=pObj-1e-7){
                            bestValues=exactLift.values;
                            bestProblem=exactLift.problem;
                            bestPayload=exactLift.payload;
                            bestObj=exactLift.obj;
                            postRelaxPairs=false;
                            break;
                        }
                        postRelaxPairs=false;
                        continue;
                    }
                    // Close the income gap to <= 0.1% on the verified scope when
                    // the quick node budget left a wider gap open.
                    if(target===currency && pObj>0 && (!Number.isFinite(currencyUpper) || currencyUpper>pObj*CURRENCY_GAP_FACTOR+1e-7)){
                        const tighter=solvePost(pProblem,pValues,{
                            nodes:fullPostBudget.mip_max_nodes,
                            iters:fullPostBudget.incumbentIterations,
                            relGap:CURRENCY_RELATIVE_GAP,
                        });
                        if(Number.isFinite(tighter.dual))
                            currencyUpper=Math.min(currencyUpper,tighter.dual);
                        if(tighter.values && (paceCol<0 || tighter.values[paceCol]>=objective*(1-1e-5)) && tighter.obj>pObj+1e-8){
                            pValues=tighter.values;
                            pObj=tighter.obj;
                            const nextMissing=unguardedRecipes(pProblem,pValues,postScope);
                            if(nextMissing.length){
                                const suggested=suggestEconomicScope(pProblem,pValues,[...postScope,...nextMissing]);
                                postScope=pr<8 ? [...new Set([...postScope,...nextMissing,...suggested])] : null;
                                continue;
                            }
                            if(postRelaxPairs && usesRelaxPair(pProblem,pValues)){
                                postRelaxPairs=false;
                                continue;
                            }
                        }
                    }
                    bestValues=pValues;
                    bestProblem=pProblem;
                    bestPayload=pPayload;
                    bestObj=pObj;
                    break;
                }
                }
                if(!bestValues)break;
                problem=bestProblem;
                values=bestValues;
                currentValues=bestValues;
                currentKeys=bestProblem.variable_keys;
                finalPayload=bestPayload;
                if(Number.isFinite(bestObj) && bestObj>1e-9){
                    if(target==='crop_variety'){
                        postStage.crop_variety=Math.floor(bestObj+1e-6);
                    }else{
                        const slack=floorSlack(target);
                        postStage.floors.push([target,bestObj*(1-1e-6)/(1-slack)]);
                    }
                }
            }
            finalStage={...postStage,pace:objective*(1-1e-6)};
            finalRelaxPairs=postRelaxPairs;
        }
        const verified=JSON.parse(pkg.exact_plan(finalPayload,JSON.stringify(finalStage),
            JSON.stringify({values,verify_only:true,proven:false,bound:0})));
        if(!verified.success)return null;
        verified.source_pace=objective;
        if(Number.isFinite(currencyUpper) && currencyUpper>=verified.rate_per_second-1e-7){
            verified.source_upper_bound=Math.max(verified.rate_per_second,currencyUpper);
            verified.upper_bound=verified.source_upper_bound;
        }
        verified.comparison_seed={keys:problem.variable_keys,values};
        verified.active_continuous_recipes=[...new Set((problem.recipe_variables??problem.recipe_options).filter(([v])=>values[v]>1e-9).map(([,name])=>name))];
        return {plan:verified,problem,payload:finalPayload,stage:finalStage,relaxPairs:finalRelaxPairs,proveSourceBound};
    }
    return null;
}
