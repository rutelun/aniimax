// Fast path for the explicit priority list. Global ceilings use all unlocked
// recipes. Candidate models check work conservation on every occupied site.
import {excludesIncomeFloor} from './bound-tightening.js';
import {cachedEconomicBound} from './economic-bound-cache.js';
import {priorityCeiling,requiredSiteCapacity,applyRequiredSites} from './priority-ceilings.js';
import {productionObjective, CURRENCY_RELATIVE_GAP, CURRENCY_GAP_FACTOR} from './priority-search.js';
import {obbtSiteLimits,solveEconomicBound,suggestEconomicScope} from './economic-bound.js';
import {planSearchOptions,polishSolution,runPlanModel} from './highs-solve.js';
import {refineStaffing, refineClimate} from './staffing-search.js';
import {keepsProduction} from './electric-staffing.js';
import {continuousNeighborhood} from './continuous-neighborhood.js';
import {economicRecipeCounts,economicCountNeighborhood,priceIdleWorkshop} from './economic-recipe-counts.js';
import {switchingWorkshops} from './material-flow-schedule.js';
import {searchProductionSites,fitWorkshopIncome} from './production-site-search.js';
import {hasSeasonCropMinimums,reservedSeasonScore} from './season-planning.js';
import {measuredProductionShift} from './measured-production.js';

const options = seconds => ({time_limit:seconds,mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
const close = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a));
const stageKey = (key,stage) => JSON.stringify([key,stage],(_,v)=>typeof v==='number'?Number(v.toPrecision(12)):v);
const sum = (terms,values) => terms.reduce((total,[v,c])=>total+c*values[v],0);
const expression = terms => terms.map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');

function align(problem,seed) {
    if (!seed?.keys || seed.keys.length!==seed.values?.length) return;
    const previous = new Map(seed.keys.map((key,i)=>[key,seed.values[i]]));
    return problem.variable_keys.map(key=>key.startsWith('extra#')?0:previous.get(key)??0);
}

function restrict(problem,names) {
    const off = new Set(problem.recipe_variables.filter(([,name])=>!names.has(name)).map(([v])=>v));
    if(!off.size)return {...problem,continuousRestricted:true};
    const lp = problem.lp.replace(/^ (?:0 <= x(\d+) <= [^\n]+|x(\d+) >= 0)$/gm,
        (line,a,b)=>off.has(Number(a??b))?` 0 <= x${a??b} <= 0`:line);
    return {...problem,lp,continuousRestricted:true};
}

function addRows(problem,rows) {
    return rows.length?{...problem,lp:problem.lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n')}:problem;
}

function keepRawIncome(problem,income,minimum) {
    if (!(minimum>0)) return problem;
    const index = new Map(problem.variable_keys.map((key,i)=>[key,i]));
    const terms = income.primary_objective.map(([v,c])=>[index.get(income.variable_keys[v]),c]);
    if (terms.some(([v])=>v===undefined)) return null;
    return addRows(problem,[' retain_currency: '+expression(terms)+' >= '+(minimum-1e-8)]);
}

function siteCounts(problem,values) {
    const groups = new Map();
    for (const [name,terms] of problem.integer_groups??[]) {
        groups.set(name,[...(groups.get(name)??[]),...terms]);
    }
    for (const [v,name] of problem.recipe_variables) if (problem.variable_keys[v].startsWith('continuous_site:')) {
        groups.set(name,[...(groups.get(name)??[]),[v,1]]);
    }
    return Object.fromEntries([...groups].map(([name,terms])=>[name,Math.round(sum(terms,values))]));
}

// A compact catalogue can change material aliases or climate coverage choices.
// Lift the production shift. Recompute sales from its material balances:
// a prior stage can reserve a rounded amount of an output, while the full
// model accounts for every remaining unit. Its priority floors still apply.
export async function restoreCatalogue(highs,solveModel,problem,seed) {
    const previous=new Map(seed.keys.map((key,v)=>[key,seed.values[v]]));
    const rows=[];
    for(let v=0;v<problem.variables;v++){
        const key=problem.variable_keys[v];
        if(!/^(rate:|units:|continuous_site:|pace#|material_pace#)/.test(key))continue;
        const value=previous.get(key)??0;
        if(!Number.isFinite(value))return null;
        rows.push(` actual_shift_${v}: x${v} = ${Math.max(0,value)}`);
    }
    const fixed=addRows(problem,rows);
    const warm=align(problem,seed);
    // Try the physical coverage from this candidate first. A different
    // catalogue or dispatch may require other coverage, so retry freely.
    const cover=problem.variable_keys.flatMap((key,v)=>
        /^(environment|pair):/.test(key) && previous.has(key)
            ? [` shift_cover_${v}: x${v} = ${Math.round(warm[v])}`] : []);
    const noRelaxPair=problem.variable_keys.flatMap((key,v)=>
        key.startsWith('pair_relax:') ? [` no_relax_pair_${v}: x${v} = 0`] : []);
    let result, extra=[];
    if(cover.length || noRelaxPair.length){
        extra=[...cover,...noRelaxPair];
        result=await solveModel(addRows(fixed,extra),options(1),undefined,warm);
    }
    if(!result?.values && cover.length && noRelaxPair.length){
        extra=noRelaxPair;
        result=await solveModel(addRows(fixed,extra),options(1),undefined,warm);
    }
    if(!result?.values){
        extra=[];
        result=await solveModel(fixed,options(1),undefined,warm);
    }
    if(!result?.values)return null;
    return polishSolution(highs,fixed,result,extra);
}

function fixPhysical(problem,warm,recipeSitesOnly=false) {
    if (!warm) return problem;
    const general=problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const rows=[];
    for (const match of (general?.[1]??'').matchAll(/\bx(\d+)\b/g)) {
        const v=Number(match[1]);
        const key=problem.variable_keys[v];
        if (recipeSitesOnly?!/^(?:units|continuous_site):/.test(key):key.startsWith('extra#'))continue;
        rows.push(` site_fix_${v}: x${v} = ${Math.round(warm[v])}`);
    }
    return addRows(problem,rows);
}

async function tryPriorityPlanOnce(pkg,input,options={},meta) {
    const paceProof={};
    const plan=await searchPriorityPlan(pkg,input,options,paceProof,meta);
    if(plan)return plan;
    const attainable=paceProof.attainable??paceProof.refine?.();
    return attainable==null ? null : searchPriorityPlan(pkg,input,options,{attainable},meta);
}

export async function tryPriorityPlan(pkg,input,options={}) {
    const compactInput=input.compact_dispatch ? input : {...input,compact_dispatch:true};
    const dispatched=Object.keys(compactInput.roster?.dispatch??{}).length>0;
    const routeDraft=compactInput.map_dispatch_pending && compactInput.roster && !dispatched && !options.initialWitness;
    if(!compactInput.relax_pair_coverage && !routeDraft) {
        const meta={usedPairRelax:false};
        let fastIncumbent=null;
        const fast=await tryPriorityPlanOnce(pkg,{...compactInput,relax_pair_coverage:true},
            {...options,onIncumbent:options.onIncumbent ? p=>{fastIncumbent=p;} : undefined},meta);
        if(fast)return fast;
        // Relaxed pair coverage is a strict relaxation of exact pair coverage.
        // If no solve ever used a relaxed pair variable (pair_relax = 0),
        // retrying with 400+ exact pair variables cannot succeed or tighten bounds.
        if(!meta.usedPairRelax){
            if(fastIncumbent)options.onIncumbent?.(fastIncumbent);
            return null;
        }
    }
    return tryPriorityPlanOnce(pkg,compactInput,options);
}

async function searchPriorityPlan(pkg,input,{highs,solveModel,step=()=>{},first=()=>{},initialWitness,
    evaluateBound,evaluateCounts,onIncumbent,workshopProof},paceProof,meta) {
    const currency=input.currency||'coins', priorities=[...(input.priorities??[])];
    if(!priorities.includes(currency))priorities.push(currency);
    const pos=priorities.indexOf(currency);
    // A generated team's currency-only switch trial uses the same income
    // bound and full-catalogue audit as ordinary production. The caller then
    // verifies the daily schedule before comparing it with the fixed plan.
    const compactSwitch=!input.roster && priorities.length===1 && priorities[0]===currency;
    // A measured roster can also price the material-first switch proposal.
    // The caller compares the checked plan only after constructing its actual
    // schedule. A missing certificate falls back to the ordinary search.
    const measuredSwitch=input.roster && priorities[0]==='level_up' && Object.keys(input.roster.dispatch??{}).length>0;
    if (!input.always_running || input.level_up_strategy || input.prioritize_byproducts
        || (input.recipe_switching_relaxation && !compactSwitch && !measuredSwitch) || input.level_up || !highs || !solveModel) return null;
    const witnessSeed=initialWitness?.seed??initialWitness?.comparison_seed;
    const oldGoals=initialWitness?.goals??initialWitness?.comparison_goals;
    const oldScores=initialWitness?.scores??initialWitness?.comparison_scores;
    const witnessNames=initialWitness?.recipes??initialWitness?.continuous_checked_recipes??[];
    let activeInput=input;
    let payloadFor=(scope,restricted=false,counts)=>JSON.stringify({...activeInput,always_running_recipes:[...scope],
        recipe_site_limits:counts && Object.fromEntries(counts),
        restrict_to_checked_recipes:restricted});
    let relaxed=payloadFor([]);
    const notePairRelax=(keys,values)=>{
        if(!meta || !input.relax_pair_coverage || meta.usedPairRelax || !keys || !values)return;
        for(let i=0;i<keys.length;i++){
            if(keys[i].startsWith('pair_relax:') && values[i]>1e-6){meta.usedPairRelax=true;return;}
        }
    };
    const priority=(payload,stage,key)=>key==='crop_variety'?JSON.parse(pkg.exact_crop_variety_problem(payload))
        :productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),key)));
    const exact=(payload,stage)=>JSON.parse(pkg.exact_problem(payload,JSON.stringify(stage)));
    const stage={floors:[]}, bounds=[], early=[];
    const dispatched=Object.keys(input.roster?.dispatch??{}).length>0;
    let integerPace=false;
    const prefix=[...(input.crop_variety||input.season?['crop_variety']:[]),...priorities.slice(0,pos)];
    for(const key of prefix){
        let p,upper=key==='crop_variety'?reservedSeasonScore(pkg,input):null;
        if(upper==null){
            p=priority(relaxed,stage,key);
            if(!p.lp && key==='level_up')continue;
            if(!p.lp)return null;
            upper=priorityCeiling(highs,p,key);
        }
        if(!Number.isFinite(upper))return null;
        if(key==='level_up' && dispatched && witnessSeed && witnessNames.length && upper>0) {
            // Walking can make the fractional upgrade pace impossible with
            // whole posts. Enforcing the previous shift's operating rules
            // still leaves every recipe available, so its optimum bounds the
            // fully checked plan. Only refine a bound the old shift cannot meet.
            const before=structuredClone(stage), ceiling=upper;
            const refine=()=>{
                const measured=priority(payloadFor(witnessNames),before,key);
                const warm=align(measured,witnessSeed);
                const refit=warm && polishSolution(highs,measured,{values:warm});
                if(!measured.production_only || (refit?.polished && close(refit.objective,ceiling)))return null;
                const solution=highs.solve(measured.lp,{mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
                if(solution.Columns && input.relax_pair_coverage && meta && !meta.usedPairRelax){
                    if(measured.variable_keys.some((k,v)=>k.startsWith('pair_relax:') && (solution.Columns['x'+v]?.Primal??0)>1e-6))
                        meta.usedPairRelax=true;
                }
                const value=solution.ObjectiveValue;
                return solution.Status==='Optimal' && value>0 && value<ceiling && !close(value,ceiling) ? value : null;
            };
            let attainable=paceProof.attainable;
            if(attainable==null){
                // A full income shift at the relaxation ceiling also proves its
                // upgrade pace. Only search for a smaller integer ceiling if
                // the measured shift cannot certify the first priority itself.
                if(oldGoals?.pace>=ceiling-1e-9 && priorities[0]==='level_up')paceProof.refine=refine;
                else attainable=refine();
            }
            if(attainable!=null){upper=attainable;integerPace=true;}
        }
        const before=structuredClone(stage);
        early.push({key,before,upper,terms:(key==='crop_variety'?[]:p.primary_objective??[]).map(([v,c])=>[p.variable_keys[v],c])});
        bounds.push([stageKey(key,stage),upper]);
        if(key==='crop_variety')stage.crop_variety=upper;
        else if(key==='level_up'){if(upper>1e-9)stage.pace=upper;}
        else stage.floors.push([key,upper]);
    }
    // With no upgrade-material pace, many ore/wood and electric assignments
    // have the same provisional income. Explore more of those cheap branches
    // before the map fixes the dispatch shares for the second solve.
    if (input.roster && !stage.pace && !witnessSeed) {
        const solveIncomeShift = solveModel;
        solveModel = (model,settings,message,seed) => {
            const effort = settings?.time_limit ?? 2;
            return solveIncomeShift(model,{mip_max_nodes:Math.ceil(128*effort),mipIterations:4000*effort,...settings},message,seed);
        };
    }
    const currencyStage=structuredClone(stage), raw=priority(relaxed,stage,currency);
    if(!raw.production_only || !raw.recipe_variables?.length)return null;
    // The first roster layout needs both the whole-site proposal and the
    // income ceiling. The proposal depends only on this same completed model.
    const priceSitesFirst=input.roster && stage.pace && !witnessSeed && !dispatched;
    const countOptions={input,timeLimit:2};
    let countJob=priceSitesFirst && evaluateCounts ? evaluateCounts(raw,countOptions) : null;
    const lpCeiling=priorityCeiling(highs,raw,currency,input.relax_pair_coverage && meta ? model=>{
        const sol=model.getSolution()?.colValue;
        if(!sol || meta.usedPairRelax)return;
        for(let i=0;i<sol.length;i++){
            if(sol[i]<=1e-6)continue;
            const v=Number(model.getColName(i).slice(1));
            if(raw.variable_keys[v]?.startsWith('pair_relax:')){meta.usedPairRelax=true;return;}
        }
    } : undefined);
    const ceilings=Number.isFinite(lpCeiling)?[lpCeiling]:[];
    let upper=Number.isFinite(lpCeiling)?lpCeiling:Infinity;
    const priorSales=new Set(early.flatMap(({terms})=>terms.filter(([key,c])=>c>0&&key.startsWith('sold:'))
        .map(([key])=>key.slice(5).replace(/#\d+$/,''))));
    // Reserved crops and earlier sales already impose demand. Include their
    // continuous-operation rules in the first roster proposal so that the
    // planting pattern and processor counts reflect that demand together.
    // At a fixed upgrade pace both upgrade chains also reserve worker time.
    // Start with the joint relaxation to let their staffed and electric sites
    // trade places before measuring routes. On the measured map these prior
    // demands can immediately tighten the income bound.
    let scope=input.roster && (!stage.pace || witnessSeed)
        ? [...new Set([...Object.keys(input.season_crop_minimums??{}),...priorSales])] : [];
    let best;
    const contenders=[];
    const remember=(keys,values,objective)=>{
        if(!Number.isFinite(objective)||objective<0||(!early.length&&objective<=0))return;
        const candidate={keys,values,objective};
        contenders.push(candidate);
        if(!best||objective>best.objective+1e-9)best=candidate;
    };
    const names=new Set(witnessNames);
    const active=(p,values)=>p.recipe_variables.filter(([v])=>values[v]>1e-9).map(([,name])=>name);
    const addActive=(p,seed)=>{
        if(!seed)return;
        const values=align(p,seed);
        if(values)for(const n of active(p,values))names.add(n);
    };
    addActive(raw,witnessSeed);
    let checkedPayload, checkedModel;
    const checkedIncomeModel=()=>{
        const payload=payloadFor(names,true);
        if(payload!==checkedPayload){
            checkedModel=restrict(priority(payload,currencyStage,currency),names);
            checkedPayload=payload;
        }
        return checkedModel;
    };
    const checkedCandidate=async (seed,fixed=true,sourceModel)=>{
        if(!seed||!names.size)return;
        const p=checkedIncomeModel(), warm=align(p,seed);
        let model=fixed?fixPhysical(p,warm):continuousNeighborhood(p,[...names],seed);
        if(sourceModel) {
            // Excluding inactive crops can renumber climate choices. Retain
            // recipe and worker rates, and let the full model assign coverage.
            const from=new Map(seed.keys.map((k,i)=>[k,seed.values[i]]));
            const rows=p.recipe_variables.flatMap(([v])=>{
                const key=p.variable_keys[v],value=from.get(key);
                return Number.isFinite(value)?[` restore_${v}: x${v} = ${value}`]:[];
            });
            model=addRows(p,rows);
        }
        // Leave the incumbent feasible while looking for a better shift.
        // Requiring a strict improvement turns an already optimal neighborhood
        // into an infeasibility proof and triggers a second solve without presolve.
        if(!fixed&&best)model=keepRawIncome(model,p,best.objective);
        let candidate=await solveModel(model,options(fixed?1:2),undefined,warm);
        if(!candidate?.values&&fixed&&!sourceModel) {
            model=fixPhysical(p,warm,true);
            candidate=await solveModel(model,options(1),undefined,warm);
        }
        if(!candidate?.values)return;
        const polished=polishSolution(highs,p,candidate);
        const objective=sum(p.primary_objective,polished.values);
        remember(p.variable_keys,polished.values,objective);
    };
    const oldCurrency=oldGoals?.currency_value;
    let previousRepair;
    const repairModes=async (countsHint)=>{
        if(!best)return;
        const p=checkedIncomeModel();
        const counts=countsHint??siteCounts(p,align(p,best));
        const occupied=new Map(Object.entries(counts).filter(([,n])=>n>0));
        // Keep the whole number of sites per recipe but let electric and
        // worker-operated variants trade places across every facility.
        // Keep the incumbent feasible while maximizing income. Requiring a
        // strict gain can make an already optimal shift numerically infeasible.
        const local=economicCountNeighborhood(highs,p,occupied,Math.max(0,best.objective-1e-8));
        if(!local)return;
        // Only the draft uses this local tolerance. The measured map still
        // prices every competing recipe against its own global income bound.
        if(input.map_dispatch_pending && !dispatched && hasSeasonCropMinimums(input)
            && Number.isFinite(local.localIncomeUpper) && local.localIncomeUpper>=best.objective-1e-8
            && local.localIncomeUpper<=best.objective*CURRENCY_GAP_FACTOR)return;
        // Rebuilding an identical neighborhood with the same solver options
        // repeats the same search. Any earlier gain is already in best.
        if(previousRepair?.lp===local.lp && previousRepair.model===p.lp)return;
        previousRepair={lp:local.lp,model:p.lp};
        const result=await solveModel(local,options(1.5));
        if(!result?.values)return;
        const polished=polishSolution(highs,p,result);
        if(!polished.polished)return;
        const objective=sum(p.primary_objective,polished.values);
        if(objective>best.objective+1e-8)remember(p.variable_keys,polished.values,objective);
    };
    const fitIdleWorkshop=async()=>{
        const p=checkedIncomeModel(),counts=siteCounts(p,align(p,best));
        const occupied=new Map(Object.entries(counts).filter(([,n])=>n>0));
        const proposal=priceIdleWorkshop(highs,p,occupied,Math.max(0,best.objective-1e-8));
        if(!proposal || proposal.estimatedIncome<=best.objective+1e-7)return false;
        // If both the incumbent and the relaxed shift use the same whole
        // post or pairing, keep it in the first fit of this workshop pattern.
        // Other assignments remain available if the fit cannot realize it.
        const local=proposal.model;
        const relaxed=highs.solve(local.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd'));
        const incumbent=new Map(best.keys.map((key,i)=>[key,best.values[i]]));
        const fixed=[];
        if(relaxed.Status==='Optimal' && relaxed.Columns){
            const integers=local.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/)?.[1]??'';
            for(const [column] of integers.matchAll(/\bx\d+\b/g)){
                const v=Number(column.slice(1)),key=p.variable_keys[v];
                if(!key.startsWith('post:') && !key.startsWith('pair:'))continue;
                const value=relaxed.Columns[column]?.Primal;
                if(Number.isFinite(value) && Math.abs(value-Math.round(value))<1e-8
                    && Math.abs(value-(incumbent.get(key)??0))<1e-8)
                    fixed.push(' keep_post_'+v+': '+column+' = '+Math.round(value));
            }
        }
        // Keep each reserve pool within the number of copies already in the shift.
        for(const [id,pool] of (p.staffing_pools??[]).entries()){
            if(!pool.reserve || !pool.work.length)continue;
            const n=Math.ceil(pool.work.reduce((n,[v,c])=>n+c*(incumbent.get(p.variable_keys[v])??0),0)-1e-6);
            fixed.push(' within_reserve_'+id+': '+expression(pool.work)+' <= '+n);
        }
        let result=await solveModel(addRows(local,fixed),options(1.5));
        if(!result?.values && fixed.length)result=await solveModel(local,options(1.5));
        if(!result?.values)return false;
        const polished=polishSolution(highs,p,result);
        if(!polished.polished)return false;
        const objective=sum(p.primary_objective,polished.values);
        if(objective<=best.objective+1e-8 || proposal.estimatedIncome>objective*CURRENCY_GAP_FACTOR)return false;
        remember(p.variable_keys,polished.values,objective);
        return true;
    };
    let fullPayload=JSON.stringify({...input,always_running_recipes:undefined,restrict_to_checked_recipes:false});
    const localBound = (p,o)=>solveEconomicBound(highs,p,o);
    const bound = (p,o)=>cachedEconomicBound(p,o,evaluateBound ?? localBound);
    let fullIncome;
    const siteCapacity=stage.pace>0 && dispatched && !input.recipe_switching_relaxation && requiredSiteCapacity(raw);
    const scopedModel = (recipes, extraLimits, relaxReasons = false) => {
        const mergedLimits = extraLimits
            ? {...(siteCapacity?.limits ?? {}), ...extraLimits}
            : siteCapacity?.limits;
        return applyRequiredSites(priority(mergedLimits || relaxReasons
            ? JSON.stringify({...input,always_running_recipes:[...recipes],restrict_to_checked_recipes:false,
                ...(mergedLimits ? {recipe_site_limits:mergedLimits} : {}),
                ...(relaxReasons ? {relax_min_reasons:true} : {})})
            : payloadFor(recipes),currencyStage,currency),siteCapacity);
    };
    let siteSearch, verifiedIncomeValues;
    if(integerPace) {
        // Price income at the attainable pace in the same relaxation. An
        // optimum that also works in the full catalogue closes both searches.
        const model=scopedModel(witnessNames);
        const exactOptions={mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9};
        const solution=highs.solve(model.lp,exactOptions);
        if(solution.Status!=='Optimal' || !solution.Columns || !Number.isFinite(solution.ObjectiveValue))return null;
        const values=model.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0);
        notePairRelax(model.variable_keys,values);
        fullIncome=priority(fullPayload,currencyStage,currency);
        let actual=await restoreCatalogue(highs,solveModel,fullIncome,{keys:model.variable_keys,values});
        if(!actual?.values) {
            // Tied shifts can use different recipes. Enforce the operating
            // rules for this shift and try to realize the same income.
            const recipes=new Set([...witnessNames,...active(model,values)]);
            const compact=priority(payloadFor(recipes,true),currencyStage,currency);
            const refit=highs.solve(compact.lp,exactOptions);
            if(refit.Status!=='Optimal' || !refit.Columns || !close(refit.ObjectiveValue,solution.ObjectiveValue))return null;
            const rates=compact.variable_keys.map((_,v)=>refit.Columns['x'+v]?.Primal??0);
            actual=await restoreCatalogue(highs,solveModel,fullIncome,{keys:compact.variable_keys,values:rates});
        }
        if(!actual?.values)return null;
        const earned=sum(fullIncome.primary_objective,actual.values);
        if(!close(earned,solution.ObjectiveValue))return null;
        for(const name of active(fullIncome,actual.values))names.add(name);
        remember(fullIncome.variable_keys,actual.values,earned);
        verifiedIncomeValues=actual.values;
        upper=Math.max(earned,solution.ObjectiveValue);
        ceilings.push(upper);
        siteSearch={best,upper};
    }
    if (!siteSearch && dispatched && witnessSeed) {
        // A route measurement changes the feasible shifts. Keep every recipe
        // and worker in the catalogue, adding operating rules only as needed.
        // The relaxed optimum bounds every executable shift on this dispatch.
        fullIncome=priority(fullPayload,currencyStage,currency);
        const proofScope=new Set(scope);
        const exactBound=bound;
        const oldCounts=initialWitness.counts??initialWitness.continuous_site_counts;
        const refitCounts=async(counts)=>{
            if(!counts)return null;
            const occupied=new Map(Object.entries(counts).filter(([,n])=>n>0));
            if(!occupied.size)return null;
            const compact=priority(payloadFor(occupied.keys(),true,occupied),currencyStage,currency);
            const local=economicCountNeighborhood(highs,compact,occupied);
            if(!local)return null;
            const result=await solveModel(local,options(2));
            if(!result?.values)return null;
            const polished=polishSolution(highs,local,result);
            if(!polished.polished)return null;
            return restoreCatalogue(highs,solveModel,fullIncome,{keys:compact.variable_keys,values:polished.values});
        };
        // Try the recipes from both shifts together. Reuse the fitted shift
        // across thresholds rather than re-solving the identical restricted model.
        let joint;
        const jointCache=new Map();
        const priceJoint=(parent,recipes,minimum=0,warmSeed=null)=>{
            const payload=payloadFor([...recipes].sort(),true);
            if(jointCache.has(payload)){joint=jointCache.get(payload);return;}
            const compact=priority(payload,currencyStage,currency);
            const result={payload};
            if(compact.variables<parent.variables){
                if(highs?.createModel){
                    const model=highs.createModel({format:'lp',data:compact.lp});
                    try{
                        const {numCols}=model.getDimensions();
                        const indices=Array.from({length:numCols},(_,i)=>Number(model.getColName(i).slice(1)));
                        const {incumbentIterations,...nativeOpts}=planSearchOptions({
                            time_limit:4,mip_max_nodes:8,mip_rel_gap:CURRENCY_RELATIVE_GAP,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
                        model.options.set(nativeOpts);
                        if(warmSeed?.keys?.length===warmSeed?.values?.length){
                            const previous=new Map(warmSeed.keys.map((k,i)=>[k,warmSeed.values[i]]));
                            const section=compact.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
                            const integers=new Set(Array.from((section?.[1]??'').matchAll(/\bx(\d+)\b/g),m=>Number(m[1])));
                            const warm={indices:[],values:[]};
                            indices.forEach((v,i)=>{
                                const key=compact.variable_keys[v],val=previous.get(key);
                                if(integers.has(v) && !key.startsWith('extra#') && Number.isFinite(val) && Math.abs(val-Math.round(val))<1e-6){
                                    warm.indices.push(i);warm.values.push(Math.round(val));
                                }
                            });
                            if(warm.indices.length)model.setSolution(warm);
                        }
                        runPlanModel(model,highs,undefined,undefined,incumbentIterations);
                        if(model.info.get('primal_solution_status')===highs.constants.solutionStatus.feasible){
                            const obj=model.getObjectiveValue();
                            if(Number.isFinite(obj)){
                                const native=model.getSolution().colValue;
                                const values=Array(compact.variables).fill(0);
                                for(let i=0;i<numCols;i++)values[indices[i]]=native[i];
                                result.value=obj;
                                result.seed={keys:compact.variable_keys,values};
                            }
                        }
                    }finally{
                        model.dispose();
                    }
                }else{
                    const fit=highs.solve(compact.lp,{mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
                    if(fit.Status==='Optimal' && fit.Columns){
                        result.value=fit.ObjectiveValue;
                        result.seed={keys:compact.variable_keys,values:compact.variable_keys.map((_,v)=>fit.Columns['x'+v]?.Primal??0)};
                    }
                }
            }
            jointCache.set(payload,result);
            joint=result;
        };
        const fitJoint=async(parent,proposal,priorValues,minimum)=>{
            const warmSeed=priorValues?{keys:fullIncome.variable_keys,values:priorValues}:witnessSeed;
            priceJoint(parent,new Set([...proposal.activeRecipes,...active(fullIncome,priorValues)]),minimum,warmSeed);
            if(!joint.seed || !(joint.value>minimum))return null;
            joint.checked??=restoreCatalogue(highs,solveModel,fullIncome,joint.seed);
            return joint.checked;
        };
        let relaxedBound=Boolean(highs?.createModel);
        const refitPrior=async()=>await refitCounts(oldCounts) ?? await restoreCatalogue(highs,solveModel,fullIncome,witnessSeed);
        const jointFirst=hasSeasonCropMinimums(input) && oldCurrency>0 && !input.recipe_switching_relaxation;
        let witness=jointFirst?null:await refitPrior();
        let earned=witness ? sum(fullIncome.primary_objective,witness.values) : -Infinity;
        let proofSeed=witness?{keys:fullIncome.variable_keys,values:witness.values}:witnessSeed;
        let initialScope=true;
        let round=0;
        let firstProposal;
        let bestBoundUpper=Infinity;
        let prevBoundObj=null, flatRelaxedRounds=0, retryFloorCertify=false;
        for (;;) {
            const targetIncome=witness ? earned : initialScope && jointFirst ? oldCurrency : 0;
            const incomeTarget=targetIncome>0 ? targetIncome*CURRENCY_GAP_FACTOR : undefined;
            const floorCertify=(retryFloorCertify || !relaxedBound) && Boolean(witness && earned>0 && incomeTarget>0);
            retryFloorCertify=false;
            let extraLimits=null;
            if(witness && earned>0 && incomeTarget>0 && proofScope.size){
                const tightened=obbtSiteLimits(highs,raw,proofScope,incomeTarget,siteCapacity?.limits??{});
                if(tightened?.infeasible){
                    for(const name of active(fullIncome,witness.values))names.add(name);
                    remember(fullIncome.variable_keys,witness.values,earned);
                    verifiedIncomeValues=witness.values;
                    upper=Math.max(earned,incomeTarget);
                    ceilings.push(upper);
                    siteSearch={best,upper};
                    break;
                }
                if(tightened?.limits)extraLimits=tightened.limits;
            }
            const model=scopedModel([...proofScope],extraLimits,relaxedBound);
            // HiGHS presolve can incorrectly declare a smaller optimum when a
            // redundant currency floor duplicates the objective on a dispatch model.
            // Previous-map income only steers the bound search. Closing this
            // map always requires a physically checked shift at its own prices.
            const proofOptions={scope:[...proofScope],exact:true,seed:proofSeed,
                relativeGap:CURRENCY_RELATIVE_GAP, incomeTarget,
                ...(floorCertify ? {floorCertify:true} : {})};
            if(initialScope && jointFirst && evaluateBound){
                const prior=align(fullIncome,witnessSeed);
                const retained=prior && active(fullIncome,prior);
                let previous;
                if(retained)proofOptions.onRecipes=items=>{
                    if(joint)return;
                    const recipes=new Set([...items,...retained]);
                    // An improving incumbent that needs fewer recipes can be
                    // fitted while the other worker finishes its income proof.
                    // fitJoint reuses it only for the identical final model.
                    if(previous && recipes.size<previous.size && [...recipes].every(k=>previous.has(k))){
                        try {
                            priceJoint(model,recipes);
                            if(!joint?.seed)joint=null;
                        } catch {
                            joint=null;
                        }
                    }
                    previous=recipes;
                };
            }
            let bound=await exactBound(model,proofOptions);
            if(bound?.values)notePairRelax(bound.keys,bound.values);
            if(!Number.isFinite(bound?.upper))break;
            ceilings.push(bound.upper);
            bestBoundUpper=Math.min(bestBoundUpper,bound.upper);
            if(witness && earned > 0 && !bound.values && bestBoundUpper <= earned*CURRENCY_GAP_FACTOR){
                for(const name of active(fullIncome,witness.values))names.add(name);
                remember(fullIncome.variable_keys,witness.values,earned);
                verifiedIncomeValues=witness.values;
                upper=Math.max(earned,bestBoundUpper);
                ceilings.push(upper);
                siteSearch={best,upper};
                break;
            }
            if(!bound.values)break;
            if(initialScope)firstProposal=bound;
            proofSeed={keys:bound.keys,values:bound.values};
            let jointCloses=false;
            if(initialScope && jointFirst){
                const priorValues=align(fullIncome,witnessSeed);
                if(priorValues){
                    const fit=await fitJoint(model,bound,priorValues,bestBoundUpper/CURRENCY_GAP_FACTOR-1e-8);
                    const value=fit?.polished && sum(fullIncome.primary_objective,fit.values);
                    if(value>0 && value<=bestBoundUpper+1e-7 && value*CURRENCY_GAP_FACTOR>=bestBoundUpper){
                        witness=fit;earned=value;jointCloses=true;
                    }
                }
                if(!jointCloses){
                    witness=await refitPrior();
                    if(witness)earned=sum(fullIncome.primary_objective,witness.values);
                }
            }
            if(!jointCloses && (!witness || !close(earned,bound.upper))){
                const warm=align(fullIncome,bound);
                const pattern=fixPhysical(fullIncome,warm,true);
                const shifted=await solveModel(pattern,options(1),undefined,warm);
                let fit=shifted?.values && polishSolution(highs,pattern,shifted);
                if(!fit?.polished || !close(sum(fullIncome.primary_objective,fit.values),bound.upper)){
                    const alt=await refitCounts(siteCounts(model,bound.values));
                    if(alt && (!fit?.polished || sum(fullIncome.primary_objective,alt.values)>sum(fullIncome.primary_objective,fit.values)))fit=alt;
                }
                if(!fit?.polished)fit=await restoreCatalogue(highs,solveModel,fullIncome,bound);
                if(!fit&&!initialScope&&bound.upper>0){
                    // Try to attain the relaxed ceiling with those building
                    // counts while refitting all crew shares and power modes.
                    const counts=new Map(Object.entries(siteCounts(model,bound.values)).filter(([,n])=>n>0));
                    const fixed=economicCountNeighborhood(highs,fullIncome,counts,bound.upper-1e-8);
                    if(fixed){
                        const shifted=await solveModel(fixed,options(2),undefined,align(fullIncome,bound));
                        if(shifted?.values){
                            const polished=polishSolution(highs,fullIncome,shifted);
                            if(polished.polished)fit=polished;
                        }
                    }
                }
                // If successive relaxations cannot staff their proposed sites,
                // repair the first pattern on the measured map. A nearby feasible
                // shift lets the full model price all competing recipes at once.
                if(!fit && !initialScope && !witness && firstProposal){
                    for(const name of firstProposal.activeRecipes)names.add(name);
                    await checkedCandidate(firstProposal);
                    if(best && bound.upper>best.objective*CURRENCY_GAP_FACTOR){
                        await repairModes(initialWitness.counts??initialWitness.continuous_site_counts);
                    }
                    firstProposal=null;
                    const repaired=best && await restoreCatalogue(highs,solveModel,fullIncome,best);
                    if(repaired){
                        fit=repaired;
                    }
                }
                const value=fit && sum(fullIncome.primary_objective,fit.values);
                if(fit && value>earned){witness=fit;earned=value;}
            }
            if(witness && earned>0 && bound.upper>earned*CURRENCY_GAP_FACTOR){
                // A relaxation can pick the right recipes but assign too many
                // sites to the wrong ones. Reallocate sites across the two
                // working shifts before widening the catalogue.
                const checked=await fitJoint(model,bound,witness.values,earned+1e-8);
                if(checked?.polished){
                    const income=sum(fullIncome.primary_objective,checked.values);
                    if(income>earned){witness=checked;earned=income;}
                }
            }
            // Refitting the physical shift can raise the income we need to
            // certify. If that target now lies inside this model's open gap,
            // retry this same smaller scope at the higher target before adding
            // more recipe constraints.
            const target=earned*CURRENCY_GAP_FACTOR;
            if(witness && earned>0 && bound.objective<=target && target<bestBoundUpper
                && (proofOptions.incomeTarget==null || target>proofOptions.incomeTarget+1e-7)){
                if(initialScope){
                    const precise=await exactBound(model,{scope:[...proofScope],exact:true});
                    if(Number.isFinite(precise?.upper) && precise.upper>=Math.max(earned,bound.objective)-1e-7 && precise.upper<bound.upper){
                        bound={...bound,upper:precise.upper};
                        ceilings.push(precise.upper);
                        bestBoundUpper=Math.min(bestBoundUpper,precise.upper);
                    }
                }else{
                    retryFloorCertify=true;
                    continue;
                }
            }
            if(witness && earned > 0 && bestBoundUpper >= earned - 1e-7 && bestBoundUpper <= earned*CURRENCY_GAP_FACTOR){
                for(const name of active(fullIncome,witness.values))names.add(name);
                remember(fullIncome.variable_keys,witness.values,earned);
                verifiedIncomeValues=witness.values;
                upper=Math.max(earned,bestBoundUpper);
                ceilings.push(upper);
                siteSearch={best,upper};
                break;
            }
            // Enforce work conservation only on throttled recipes first to
            // avoid flooding the bound with high-cardinality full-load sites.
            // From an empty initial scope, start with the unexplained recipes
            // from suggestEconomicScope when strictly smaller.
            let next=(bound.throttledRecipes??[]).filter(n=>!proofScope.has(n));
            let usedCompactSuggestion=false;
            if(initialScope && proofScope.size<=2 && next.length){
                const suggested=suggestEconomicScope(model,bound.values,proofScope).filter(n=>!proofScope.has(n));
                if(suggested.length && suggested.length<next.length){
                    next=suggested;
                    usedCompactSuggestion=true;
                }
            }
            if(round>=2){
                const extra=suggestEconomicScope(model,bound.values,proofScope).filter(n=>!proofScope.has(n));
                if(extra.length)next=[...new Set([...next,...extra])];
            }
            if(!next.length && initialScope)next=suggestEconomicScope(model,bound.values,proofScope).filter(n=>!proofScope.has(n));
            if(!next.length)next=[...new Set([...bound.occupiedRecipes,...bound.activeRecipes])].filter(n=>!proofScope.has(n));
            // If widening proofScope under relax_min_reasons fails to lower the
            // relaxed objective, switch to the exact availability formulation.
            if(relaxedBound && Number.isFinite(bound.objective) && prevBoundObj!=null
                && bound.objective>=prevBoundObj-1e-6*Math.max(1,Math.abs(bound.objective))){
                flatRelaxedRounds++;
            }else{
                flatRelaxedRounds=0;
            }
            prevBoundObj=bound.objective;
            initialScope=false;
            round++;
            if(relaxedBound && flatRelaxedRounds>=1){
                relaxedBound=false;
                flatRelaxedRounds=0;
                continue;
            }
            if(!next.length){
                if(relaxedBound){relaxedBound=false;continue;}
                break;
            }
            for(const name of next)proofScope.add(name);
            // A small compact suggestion from the initial scope (e.g. 5-9
            // unexplained recipes) stays flat under relax_min_reasons; enforce
            // exact availability on it directly instead of burning a flat round.
            if(relaxedBound && usedCompactSuggestion && proofScope.size<=12){
                relaxedBound=false;
            }
        }
    }
    const generatedSites = !input.roster && !witnessSeed;
    let sitesAttempted=false;
    const priceSitePatterns=async()=>{
        sitesAttempted=true;
        fullIncome??=priority(fullPayload,currencyStage,currency);
        const solve=(model,settings)=>cachedEconomicBound(model,settings,localBound);
        let shared;
        if (workshopProof && compactSwitch && !input.season && !input.crop_variety
            && (!input.recipe_switching_relaxation || workshopProof.assignment !== undefined)) {
            const facilities=switchingWorkshops(input);
            if (facilities.length) {
                const broad={...input,recipe_switching_relaxation:true,
                    recipe_switching_facilities:facilities,recipe_switching_normal_only:false};
                const modelFor=recipes=>priority(JSON.stringify({...broad,always_running_recipes:recipes,
                    restrict_to_checked_recipes:false}),currencyStage,currency);
                shared=await fitWorkshopIncome(highs,workshopProof,fullIncome,modelFor,solve);
            }
        }
        siteSearch=shared ?? await searchProductionSites(highs,raw,fullIncome,scopedModel,solve,
            {relativeGap:CURRENCY_RELATIVE_GAP, initialFloor:best?.objective??0, initialUpper:upper});
        if (siteSearch) {
            if (siteSearch.best) {
                const candidate=siteSearch.best;
                remember(candidate.keys,candidate.values,candidate.objective);
                for (const name of candidate.activeRecipes) names.add(name);
            }
            ceilings.push(siteSearch.upper);
            upper=Math.min(upper,siteSearch.upper);
        }
    };
    if (generatedSites && !input.season && workshopProof && compactSwitch) await priceSitePatterns();
    const siteSearchClosed = siteSearch && best && siteSearch.upper <= best.objective * CURRENCY_GAP_FACTOR + 1e-7;
    if (!siteSearchClosed) {
        const initialModel=scope.length ? priority(payloadFor(scope),currencyStage,currency) : raw;
        const discovery=scope.length>0 && !witnessSeed;
        const masterOptions={seed:witnessSeed,scope,timeLimit:discovery?3:2,discovery};
        let pending=!priceSitesFirst && evaluateBound?{model:initialModel,result:bound(initialModel,masterOptions)}:null;
        const startCounts=()=>{countJob??=evaluateCounts(raw,countOptions);};
        // With measured shares the strict master can settle the income stage on
        // its first solve. Try its actual staffing before searching alternative
        // building counts or fixing plots from the provisional map.
        let measuredClosed=false, nextBound=null;
        if(witnessSeed && dispatched && scope.length){
            const measuredBound=pending?await pending.result:await bound(initialModel,masterOptions);
            pending={model:initialModel,result:measuredBound};
            if(measuredBound?.values && Number.isFinite(measuredBound.upper)){
                for(const name of measuredBound.activeRecipes)names.add(name);
                await checkedCandidate(measuredBound);
                measuredClosed=best && close(best.objective,measuredBound.upper);
                if(measuredClosed){
                    ceilings.push(measuredBound.upper);
                    upper=Math.min(upper,measuredBound.upper);
                }else if(evaluateBound){
                    const next=suggestEconomicScope(initialModel,measuredBound.values,scope);
                    if(next.length>scope.length){
                        const model=scopedModel(next);
                        nextBound={model,scope:next,result:bound(model,{seed:best??witnessSeed,scope:next,timeLimit:5})};
                    }
                }
            }
        }
        if(!measuredClosed && evaluateCounts)startCounts();
        if(witnessSeed && !measuredClosed){
            await checkedCandidate(witnessSeed);
            if(!best)await checkedCandidate(witnessSeed,true,raw);
            await repairModes(initialWitness.counts??initialWitness.continuous_site_counts);
            if(dispatched&&(!best||oldCurrency>best.objective*CURRENCY_GAP_FACTOR)){
                const measured=await measuredProductionShift({modelFor:scope=>priority(payloadFor(scope),currencyStage,currency),
                    counts:initialWitness.counts??initialWitness.continuous_site_counts,checked:witnessNames,seed:witnessSeed,solveModel,highs});
                if(measured){
                    for(const name of measured.checked)names.add(name);
                    // This search already used the complete catalogue; retain its
                    // alternative even if a compact candidate provisionally wins.
                    remember(measured.keys,measured.values,measured.objective);
                }
            }
        }
        if(!measuredClosed){
            const counts=countJob?await countJob:economicRecipeCounts(highs,raw,countOptions);
            if(counts?.size&&economicCountNeighborhood){
                const allowed=new Set(counts.keys());
                for(const name of allowed)names.add(name);
                const compact=priority(payloadFor(allowed,true,counts),currencyStage,currency);
                // This dual bound prices all building patterns. When this
                // particular pattern falls short, still test its feasible income.
                const target=(counts.upper??0)/CURRENCY_GAP_FACTOR;
                for(const floor of target>0 ? [target,0] : [0]){
                    const local=economicCountNeighborhood(highs,compact,counts,floor);
                    if(!local || (floor>0 && excludesIncomeFloor(highs,local,floor)))continue;
                    const found=await solveModel(local,{time_limit:2,mip_rel_gap:0});
                    if(!found?.values)continue;
                    const fit=polishSolution(highs,local,found);
                    await checkedCandidate({keys:compact.variable_keys,values:fit.values},true,compact);
                    break;
                }
                if(Number.isFinite(counts.upper)){ceilings.push(counts.upper);upper=Math.min(upper,counts.upper);}
            }
        }
        // An independently priced building pattern may already meet the
        // preliminary income tolerance. The full catalogue and measured map
        // are still checked below and in the dispatch pass.
        // If crop reservations leave the proposed building counts infeasible,
        // search alternative site patterns before repairing the relaxed rates.
        if(generatedSites && (!best || upper>best.objective*CURRENCY_GAP_FACTOR) && !sitesAttempted) await priceSitePatterns();
        const preparingMap=priceSitesFirst && input.map_dispatch_pending && best;
        // Seasonal plots reserve crew time across workshops. Try moving the
        // existing crew between recipes before changing their building counts.
        const crewSeed=preparingMap && hasSeasonCropMinimums(input) && upper>best.objective*CURRENCY_GAP_FACTOR ? best : null;
        if(crewSeed)await checkedCandidate(crewSeed,false);
        const shortFit=preparingMap && upper>best.objective*CURRENCY_GAP_FACTOR && await fitIdleWorkshop();
        if(!shortFit && preparingMap && (!crewSeed || best===crewSeed) && upper>best.objective*CURRENCY_GAP_FACTOR){
            await repairModes();
            if(best!==crewSeed)await checkedCandidate(best,false);
        }
        const pricedWithinGap = (priceSitesFirst || generatedSites) && best && upper >= best.objective-1e-7
            && upper <= best.objective*CURRENCY_GAP_FACTOR;
        if (!shortFit && (preparingMap || (priceSitesFirst && pricedWithinGap)) && !close(upper,best.objective)) await repairModes();
        if (generatedSites && pricedWithinGap && best && !close(upper,best.objective)) {
            await checkedCandidate(best,false);
            if (!close(upper,best.objective)) await repairModes();
        }
        for(let round=0;!measuredClosed && !preparingMap && !pricedWithinGap && round<3;round++){
            const model=pending?.model??(round?scopedModel(scope):initialModel);
            const result=pending?await pending.result:await bound(model,round?{seed:best??witnessSeed,scope,timeLimit:5}:masterOptions);
            pending=null;
            if(Number.isFinite(result?.upper)){ceilings.push(result.upper);upper=Math.min(upper,result.upper);}
            if(result?.values){
                notePairRelax(result.keys,result.values);
                for(const n of result.activeRecipes)names.add(n);
            }
            const nearFloorOnly=best&&upper-best.objective<=1e-6*Math.max(1,best.objective);
            const required=new Set(scope);
            if(!nearFloorOnly)for(const name of Object.keys(input.season_crop_minimums??{}))required.add(name);
            for(const name of result?.activeRecipes??[])if(priorSales.has(name))required.add(name);
            const next=result?.values?suggestEconomicScope(model,result.values,required,{nearFloorOnly}):scope;
            if(evaluateBound&&dispatched&&round<2&&(!best||!close(upper,best.objective))
                &&next.length>scope.length){
                if(nextBound && next.length===nextBound.scope.length && next.every((name,i)=>name===nextBound.scope[i])){
                    pending=nextBound;
                }else{
                    const narrowed=scopedModel(next);
                    pending={model:narrowed,result:bound(narrowed,{seed:best??witnessSeed,scope:next,timeLimit:5})};
                }
                nextBound=null;
            }
            if(result?.values)await checkedCandidate(result);
            if(!witnessSeed&&!round&&best&&!close(best.objective,upper))await repairModes();
            if((!best || upper-best.objective>(dispatched?1e-7:CURRENCY_RELATIVE_GAP*best.objective))&&round===0)await checkedCandidate(best??result??witnessSeed,false);
            if(best&&close(upper,best.objective))break;
            if(nearFloorOnly&&next.length===scope.length)break;
            if(!dispatched&&best&&upper<=best.objective*CURRENCY_GAP_FACTOR)break;
            // Crop reservations often close on the first pricing round. If they
            // leave a material gap, price complete site patterns before widening.
            if(!round && generatedSites && !sitesAttempted){
                await priceSitePatterns();
                if(best && upper<=best.objective*CURRENCY_GAP_FACTOR)break;
            }
            if(!result?.values || (round&&next.length===scope.length))break;
            scope=next;
        }
    }
    if(!best || !Number.isFinite(upper))return null;
    fullIncome ??= priority(fullPayload,currencyStage,currency);
    const usesPairRelax=(keys,values)=>Boolean(activeInput.relax_pair_coverage && keys?.some((key,i)=>key.startsWith('pair_relax:') && values[i]>0.5));
    let restored=null;
    for(const candidate of contenders.sort((a,b)=>b.objective-a.objective)){
        const actual=verifiedIncomeValues && candidate.values===verifiedIncomeValues && !usesPairRelax(fullIncome.variable_keys,candidate.values)
            ? candidate : await restoreCatalogue(highs,solveModel,fullIncome,candidate);
        if(!actual?.values)continue;
        const objective=sum(fullIncome.primary_objective,actual.values);
        const compatible=ceilings.filter(ceiling=>ceiling>=objective-1e-7);
        if(!compatible.length)continue;
        upper=Math.max(objective,Math.min(...compatible));
        restored={keys:fullIncome.variable_keys,values:actual.values,objective};
        break;
    }
    if(!restored)return null;
    notePairRelax(restored.keys,restored.values);
    if(usesPairRelax(restored.keys,restored.values)){
        // Pass 1's dual bound from relax_pair_coverage=true is a valid global
        // upper bound for exact pair coverage. Lift the primal shift directly
        // onto the exact pair model to avoid repeating the bound loop.
        const exactInput={...activeInput,relax_pair_coverage:false};
        const exactFullPayload=JSON.stringify({...exactInput,always_running_recipes:undefined,restrict_to_checked_recipes:false});
        const exactFullIncome=priority(exactFullPayload,currencyStage,currency);
        const exactActual=exactFullIncome?.lp ? await restoreCatalogue(highs,solveModel,exactFullIncome,restored) : null;
        if(!exactActual?.values)return null;
        const exactObj=sum(exactFullIncome.primary_objective,exactActual.values);
        const compatible=ceilings.filter(ceiling=>ceiling>=exactObj-1e-7);
        if(!compatible.length)return null;
        const exactUpper=Math.max(exactObj,Math.min(...compatible));
        if(exactUpper>exactObj*CURRENCY_GAP_FACTOR)return null;
        activeInput=exactInput;
        payloadFor=(scope,restricted=false,counts)=>JSON.stringify({...activeInput,always_running_recipes:[...scope],
            recipe_site_limits:counts && Object.fromEntries(counts),restrict_to_checked_recipes:restricted});
        relaxed=payloadFor([]);
        fullPayload=exactFullPayload;
        fullIncome=exactFullIncome;
        upper=exactUpper;
        restored={keys:exactFullIncome.variable_keys,values:exactActual.values,objective:exactObj};
    }
    best=restored;
    // The provisional map will be measured and solved again. On the final
    // map, compare the restored shift against this map's own income ceiling.
    const routeDraft=input.map_dispatch_pending && input.roster && !dispatched && !initialWitness;
    let needsWiderSearch=!routeDraft && upper>best.objective*CURRENCY_GAP_FACTOR;
    // The wider search can start with this shift once all remaining
    // priorities and the full catalogue have been checked below.
    if(needsWiderSearch && !onIncumbent)return null;
    const income=best.objective;
    bounds.push([stageKey(currency,currencyStage),upper]);
    stage.floors.push([currency,income]);
    // Each lower material goal may need another level of the upgrade chain,
    // including a formula that did not earn currency in the income plan.
    for(const [,name,facility] of raw.recipe_options){
        if(facility==='Woodworking Bench'||facility==='Chimney Kiln')names.add(name);
    }
    let payload=payloadFor(names,true);
    let localIncome=priority(payload,currencyStage,currency);
    let seed=best,materialPace=null,materialWork=null,last,materialNote=null;
    // Each lower priority is optimized with the previous objective floors.
    // Restricted search can provide a feasible value but never a global bound.
    for(const key of priorities.slice(pos+1)){
        const all=priority(relaxed,stage,key);
        if(!all.lp&&key==='level_up')continue;
        if(!all.lp)return null;
        // Include recipes active in the relaxed priority optimum (as well as
        // dedicated producer facilities for this target) so priorities after
        // currency are not forced to zero when their recipes were unused in coins.
        const added=[];
        const ceiling=priorityCeiling(highs,all,key,model=>{
            const sol=model.getSolution()?.colValue;
            if(!sol)return;
            const rateByCol=new Map(all.recipe_options.map(([v,name])=>[v,name]));
            for(let i=0;i<sol.length;i++){
                if(sol[i]<=1e-9)continue;
                const v=Number(model.getColName(i).slice(1));
                const name=rateByCol.get(v);
                if(name && !names.has(name)){names.add(name);added.push(name);}
            }
        });
        for(const [,name,facility] of raw.recipe_options){
            if((key==='aniimo_exp' && facility==='Dance Pad Polisher')
                || (key==='aniipods' && facility==='Aniipod Maker')
                || ((key==='Wood Blocks' || key==='level_up') && facility==='Woodland')
                || ((key==='Mineral Sand' || key==='level_up') && facility==='Mine')){
                if(!names.has(name)){names.add(name);added.push(name);}
            }
        }
        if(added.length){
            payload=payloadFor(names,true);
            localIncome=priority(payload,currencyStage,currency);
        }
        const checked=priority(payload,stage,key),local=keepRawIncome(restrict(checked,names),localIncome,income);
        if(!local)return null;
        const warm=align(local,seed);
        let fit=await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
        if(!fit?.values||!close(sum(checked.primary_objective,fit.values),ceiling)){
            const alternative=await solveModel(local,options(2),undefined,fit?.values??warm);
            if(alternative?.values&&(!fit?.values||sum(checked.primary_objective,alternative.values)>sum(checked.primary_objective,fit.values)))fit=alternative;
        }
        if(!fit?.values)return null;
        const objective=sum(checked.primary_objective,fit.values);
        const prior=initialWitness?.success?new Map(oldGoals?.floors??[]).get(key):null;
        if(Number.isFinite(prior)&&objective+1e-8<prior&&Number.isFinite(oldCurrency)&&income<=oldCurrency+1e-7)return null;
        if(Number.isFinite(ceiling))bounds.push([stageKey(key,stage),ceiling]);
        if(key==='level_up'){if(objective>1e-9)stage.pace=objective;}
        else stage.floors.push([key,objective]);
        seed={keys:checked.variable_keys,values:fit.values};
    }
    const canWork=raw.recipe_options.some(([, ,facility])=>facility==='Woodworking Bench'||facility==='Chimney Kiln');
    const needsStock=canWork&&!stage.pace&&input.level_up_preview?.cost?.some(([key,amount])=>key!==currency&&amount>
        (input.level_up_preview.stock??[]).filter(([name])=>name===key).reduce((total,[,n])=>total+n,0));
    const work=canWork&&(input.maximize_material_work??!input.fixed_homeland);
    const minRate=Math.max(income,Number.isFinite(initialWitness?.rate_per_second)?initialWitness.rate_per_second:0);
    const finalStage=async (request)=>{
        const p=exact(payload,request);
        if(!p.lp)return null;
        let local=keepRawIncome(restrict(p,names),localIncome,minRate);
        if(!local)return null;
        const paceColumn=p.variable_keys.indexOf('material_pace#0');
        const target=request.maximize_upgrade_materials&&paceColumn>=0?[[paceColumn,1]]:p.primary_objective;
        // The map's measured travel can change which material scores are
        // attainable. Only a completed plan supplies a comparable minimum.
        const retained=!initialWitness?.success?null:request.maximize_material_work?oldScores?.material_work:request.maximize_upgrade_materials?oldScores?.material_pace:null;
        if(retained>0&&income<=oldCurrency+1e-7&&target?.length) {
            local=addRows(local,[' retain_material: '+expression(target)+' >= '+(retained-1e-7)]);
        }
        const warm=align(p,seed);
        const commitments=local.material_fixed?.map(v=>` material_commit_${v}: x${v} = ${Math.round(warm[v])}`)??[];
        const committed=commitments.length?addRows(local,commitments):fixPhysical(local,warm);
        let fixedSeed=null,r=null,ceiling=null,polished=null;
        const draftMaterial=routeDraft && request.maximize_material_work && commitments.length && target?.length;
        // Seasonal reservations can distinguish shifts with the same output
        // through their climate crew. Retain that staffing tie-break.
        const finishAtCeiling=draftMaterial && !hasSeasonCropMinimums(input);
        if(draftMaterial && seed===best) {
            fixedSeed=await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
            if(fixedSeed?.values){
                ceiling=priorityCeiling(highs,productionObjective(committed),'material_work');
                if(Number.isFinite(ceiling) && Math.abs(sum(target,fixedSeed.values)-ceiling)<=1e-9)r=fixedSeed;
            }
        }
        const settings=options(commitments.length?2:1);
        if(!r && finishAtCeiling){
            ceiling??=priorityCeiling(highs,productionObjective(committed),'material_work');
            if(Number.isFinite(ceiling)){
                r=await solveModel(committed,{...settings,primaryCeiling:ceiling},undefined,warm);
                if(r?.atPrimaryCeiling){
                    const checked=polishSolution(highs,local,r);
                    if(checked.polished && Math.abs(sum(target,checked.values)-ceiling)<=1e-9)polished=checked;
                    else r=null;
                }
            }
        }
        if(!r)r=await solveModel(committed,settings,undefined,warm);
        if(r?.values && request.maximize_upgrade_materials && target?.length && sum(target,r.values)<=1e-9){
            if(!r.proven){
                const mpCeiling=priorityCeiling(highs,productionObjective(committed),'material_pace');
                if(Number.isFinite(mpCeiling) && mpCeiling>1e-8){
                    const positiveCommitted=addRows(committed,[' positive_material_pace: '+expression(target)+' >= '+Math.min(1e-5,mpCeiling*0.01)]);
                    const deeper=await solveModel(positiveCommitted,options(6));
                    if(deeper?.values && sum(target,deeper.values)>sum(target,r.values))r=deeper;
                }
            }
            if(sum(target,r.values)<=1e-9 && commitments.length){
                const localCeiling=priorityCeiling(highs,productionObjective(local),'material_pace');
                if(Number.isFinite(localCeiling) && localCeiling>1e-8){
                    const positive=addRows(local,[' positive_material_pace: '+expression(target)+' >= '+Math.min(1e-5,localCeiling*0.01)]);
                    const alt=await solveModel(positive,options(8));
                    if(alt?.values && sum(target,alt.values)>sum(target,r.values))r=alt;
                }
            }
        }
        if(!r?.values)r=fixedSeed??await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
        if(!r?.values)r=await solveModel(local,options(2),undefined,warm);
        if(!r?.values)return null;
        r=polished??polishSolution(highs,local,r);
        seed={keys:p.variable_keys,values:r.values};
        last={request,local,p,r};
        return target?.length?sum(target,r.values):r.objective;
    };
    if(needsStock){
        materialPace=await finalStage({...stage,maximize_upgrade_materials:true});
        if(materialPace==null)return null;
        stage.material_pace=materialPace;
    }
    if(work){
        materialWork=await finalStage({...stage,maximize_material_work:true});
        if(materialWork==null){
            // A feasible earlier material-pace or income shift survives a
            // timeout while filling the remaining bench and kiln hours.
            if(!last&&await finalStage(stage)==null)return null;
            materialNote='unavailable';
        } else materialNote='unproven';
    }else if(!last&&await finalStage(stage)==null)return null;
    if(initialWitness?.success&&oldScores?.material_pace!=null&&materialPace+1e-8<oldScores.material_pace&&income<=oldCurrency+1e-7)return null;
    if(initialWitness?.success&&oldScores?.material_work!=null&&materialWork+1e-8<oldScores.material_work&&income<=oldCurrency+1e-7)return null;
    const {request}=last;
    let p=exact(fullPayload,request);
    const local=keepRawIncome(restrict(p,names),fullIncome,minRate);
    if(!local)return null;
    const compactSeed={keys:last.p.variable_keys,values:last.r.values};
    const scopedPayload=payload;
    const scopedP=input.roster && last.p && last.p.variables < p.variables ? last.p : null;
    const scopedLocal=scopedP ? last.local : null;
    const liftToFull=async(source)=>{
        let lifted=await restoreCatalogue(highs,solveModel,local,source);
        if(!lifted?.values){
            const warm=align(local,source);
            lifted=await solveModel(fixPhysical(local,warm,true),options(2),undefined,warm);
            if(!lifted?.values)return null;
            lifted=polishSolution(highs,local,lifted);
        }
        return lifted;
    };
    const audit=(values,summaryOnly=false)=>JSON.parse(pkg.exact_plan(fullPayload,JSON.stringify(request),
        JSON.stringify({values,proven:false,bound:upper,verify_only:true,summary_only:summaryOnly})));
    let r, refined, fallbackSource = null;
    if(scopedLocal){
        const scopedAudit=(values,summaryOnly=false)=>JSON.parse(pkg.exact_plan(scopedPayload,JSON.stringify(request),
            JSON.stringify({values,proven:false,bound:upper,verify_only:true,summary_only:summaryOnly})));
        const sr=last.r;
        if(sr?.values){
            const sRefined=await refineStaffing(scopedLocal,sr,solveModel,{pkg,input,report:values=>scopedAudit(values,true)});
            // Preserve the refined staffing choices (posts, climate staff, generators) when lifting to fullPayload.
            const source={keys:scopedP.variable_keys,values:sRefined.values};
            const prev=new Map(source.keys.map((key,v)=>[key,source.values[v]]));
            const staffRows=[];
            for(let v=0;v<local.variables;v++){
                const key=local.variable_keys[v];
                if(!/^(staff:|post:|generators#|active:)/.test(key) || !prev.has(key))continue;
                const val=prev.get(key);
                if(Number.isFinite(val) && Math.abs(val-Math.round(val))<1e-6)
                    staffRows.push(` keep_staff_${v}: x${v} = ${Math.round(val)}`);
            }
            const liftedRefined=staffRows.length
                ? await restoreCatalogue(highs,solveModel,addRows(local,staffRows),source) : null;
            refined=liftedRefined?.values ? liftedRefined : await liftToFull(source);
            if(refined?.values){
                const climateCount=(keys,vals)=>{
                    let b=0,p=0;
                    for(let v=0;v<keys.length;v++){
                        const val=Math.round(vals[v]??0);
                        if(val<=0)continue;
                        if(keys[v].startsWith('environment:'))b+=val;
                        else if(keys[v].startsWith('pair:')){b+=2*val;p+=val;}
                    }
                    return {b,p};
                };
                const beforeLift=climateCount(scopedP.variable_keys,sRefined.values);
                const afterLift=climateCount(local.variable_keys,refined.values);
                if(afterLift.b>beforeLift.b || (afterLift.b===beforeLift.b && afterLift.p>beforeLift.p)){
                    const cleaned=await refineClimate(local,refined,solveModel);
                    if(cleaned!==refined && keepsProduction(audit(refined.values,true),audit(cleaned.values,true)))
                        refined=cleaned;
                }
            }
            r=refined;
            if(sRefined!==sr)fallbackSource={keys:scopedP.variable_keys,values:sr.values};
        }
    }
    if(!r?.values){
        r=await liftToFull(compactSeed);
        if(!r?.values)return null;
        refined=await refineStaffing(local,r,solveModel,{pkg,input,report:values=>audit(values,true)});
    }
    if(request.maximize_material_work){
        materialWork=sum(p.primary_objective,r.values);
        if(materialNote==='unproven' && Number.isFinite(materialWork)){
            // Verify against the catalogue-wide LP relaxation at the achieved
            // priorities and raw income floor. Matching this global upper bound
            // proves no higher Bench/Kiln workload exists anywhere.
            const globalWork=exact(relaxed,request);
            const boundedWork=globalWork?.lp ? keepRawIncome(productionObjective(globalWork),raw,minRate) : null;
            const workCeiling=boundedWork ? priorityCeiling(highs,boundedWork,'material_work') : null;
            if(Number.isFinite(workCeiling) && materialWork>=workCeiling-1e-6*Math.max(1,workCeiling)){
                materialNote=null;
            }
        }
    }
    let final=refined,plan=audit(final.values);
    if(!plan.success && fallbackSource){
        const unrefined=await liftToFull(fallbackSource);
        if(unrefined?.values){final=unrefined;plan=audit(final.values);}
    } else if(!plan.success&&refined!==r){final=r;plan=audit(final.values);}
    if(!plan.success||!Number.isFinite(plan.rate_per_second)||plan.rate_per_second+1e-7<minRate||plan.rate_per_second>upper+1e-7)return null;
    if (materialPace != null && plan.level_up_preview?.requirements && request.maximize_material_work) {
        // Material work can improve the pace even after the prior stage has
        // fixed its minimum. Verify that additional pace with the native model.
        const needed=plan.level_up_preview.requirements.filter(row=>row.name!==currency && row.need>row.have);
        const paceColumn=p.variable_keys.indexOf('material_pace#0');
        if (needed.length && paceColumn>=0) {
            const pace=Math.min(86400,...needed.map(row=>86400*row.per_second/(row.need-row.have)));
            if (Number.isFinite(pace) && pace>materialPace+1e-8) {
                const values=final.values.slice();
                values[paceColumn]=pace;
                const lifted={...final,values};
                const checked=audit(lifted);
                if (checked.success && checked.rate_per_second>=minRate-1e-7 && checked.rate_per_second<=upper+1e-7) {
                    final=lifted;
                    plan=checked;
                    materialPace=pace;
                }
            }
        }
    }
    if (activeInput.relax_pair_coverage) {
        // Relaxed pair coverage omits exact pair:* columns. When the final plan uses
        // 3+ temperature modes (or a reserve climate worker with an owned opposite),
        // check exact overlapping pairs via the compact climate solver.
        const tempModes = new Set((plan.environment_assignments ?? [])
            .map(a => a.mode).filter(m => m === 'Warm' || m === 'Scorching' || m === 'Cool' || m === 'Freeze'));
        const pools = p.staffing_pools ?? [];
        const reserveHF = pools.some(pool => pool.reserve && pool.anchors.some(v =>
            p.variable_keys[v]?.startsWith('staff:Heat Furnace:') && final.values[v] > 0.5));
        const reserveCU = pools.some(pool => pool.reserve && pool.anchors.some(v =>
            p.variable_keys[v]?.startsWith('staff:Cooling Unit:') && final.values[v] > 0.5));
        const hasOwnedCU = pools.some(pool => !pool.reserve && pool.anchors.some(v =>
            p.variable_keys[v]?.startsWith('staff:Cooling Unit:')));
        const hasOwnedHF = pools.some(pool => !pool.reserve && pool.anchors.some(v =>
            p.variable_keys[v]?.startsWith('staff:Heat Furnace:')));
        if (tempModes.size >= 3 || (reserveHF && hasOwnedCU) || (reserveCU && hasOwnedHF)) {
            const exactPayload = JSON.stringify({ ...JSON.parse(fullPayload), relax_pair_coverage: false });
            const exactP = exact(exactPayload, request);
            if (exactP?.lp && exactP.variable_keys?.some(k => k.startsWith('pair:'))) {
                const byKey = new Map(p.variable_keys.map((k, i) => [k, final.values[i]]));
                const oldExtras = p.variable_keys.flatMap((k, i) => k.startsWith('extra#') ? [i] : []);
                const newExtras = exactP.variable_keys.flatMap((k, i) => k.startsWith('extra#') ? [i] : []);
                const extraShift = oldExtras.length - newExtras.length;
                const aligned = exactP.variable_keys.map(k => byKey.get(k) ?? 0);
                if (extraShift >= 0) {
                    for (let i = 0; i < newExtras.length; i++) {
                        aligned[newExtras[i]] = final.values[oldExtras[i + extraShift]];
                    }
                }
                const exactAudit = (values, summaryOnly = false) => JSON.parse(pkg.exact_plan(exactPayload, JSON.stringify(request),
                    JSON.stringify({ values, proven: false, bound: upper, verify_only: true, summary_only: summaryOnly })));
                const baseExact = exactAudit(aligned, true);
                if (baseExact.success) {
                    const cleaned = await refineClimate(exactP, { ...final, values: aligned }, solveModel);
                    if (cleaned !== final && cleaned.values !== aligned) {
                        const checked = exactAudit(cleaned.values);
                        if (checked.success && keepsProduction(plan, checked)
                            && checked.rate_per_second >= minRate - 1e-7 && checked.rate_per_second <= upper + 1e-7) {
                            p = exactP;
                            payload = JSON.stringify({ ...JSON.parse(payload), relax_pair_coverage: false });
                            final = cleaned;
                            plan = checked;
                        }
                    }
                }
            }
        }
    }
    const used=active(p,final.values);
    if(used.some(name=>!names.has(name)))return null;
    const verified=new Map(p.variable_keys.map((key,v)=>[key,final.values[v]]));
    for(const entry of early){
        const {key,terms}=entry;
        let earned=terms.length&&terms.every(([name])=>verified.has(name))
            ?terms.reduce((total,[name,c])=>total+c*verified.get(name),0):null;
        // The full catalogue just verified the integer crop score as a hard
        // minimum. Unlike the pace and sales floors, it has no priority slack.
        if(key==='crop_variety' && request.crop_variety===entry.upper)earned=entry.upper;
        // Later priorities use the native floor slack. Recover the earlier
        // score with the checked sites before claiming it reaches its ceiling.
        if(!close(earned,entry.upper)){
            const checked=restrict(priority(payload,entry.before,key),names);
            const warm=align(checked,{keys:p.variable_keys,values:final.values});
            let audit=await solveModel(fixPhysical(checked,warm),options(.7),undefined,warm);
            if(!audit?.values)audit=await solveModel(fixPhysical(checked,warm,true),options(.7),undefined,warm);
            if(audit?.values)earned=Math.max(earned??-Infinity,audit.objective);
        }
        if(key==='level_up' && paceProof.refine){
            if(!close(earned,entry.upper)){
                paceProof.attainable=paceProof.refine();
                paceProof.refine=null;
                if(paceProof.attainable!=null || !onIncumbent)return null;
                // Later objectives retain the native pace floor. A verified
                // shift at that floor can seed the full priority search.
                needsWiderSearch=true;
            }
            paceProof.refine=null;
        }
        entry.earned=earned;
        step(key==='crop_variety'?key:'priority:'+key,'done',close(earned,entry.upper));
    }
    const achievedIncome=Math.max(income,plan.rate_per_second);
    upper=Math.max(upper,achievedIncome);
    step('priority:'+currency,'done',close(achievedIncome,upper));
    step('check','done',true);
    const top=early.find(({key})=>key!=='crop_variety');
    if(top&&Number.isFinite(top.earned))first({measure:top.key,objective:top.earned,proven:close(top.earned,top.upper)});
    else if(!top)first({measure:currency,objective:achievedIncome,proven:close(achievedIncome,upper)});
    const verifiedPlan={...plan,continuous_production_checked:true,continuous_checked_recipes:[...names],
        active_continuous_recipes:[...new Set(used)],continuous_site_counts:siteCounts(p,final.values),
        continuous_upper_bounds:bounds,comparison_seed:{keys:p.variable_keys,values:final.values},
        comparison_goals:{currency,currency_value:achievedIncome,
            floors:stage.floors.map(([name,value])=>[name,name===currency?achievedIncome:value]),
            pace:stage.pace??null,crop_variety:stage.crop_variety??null},
        comparison_scores:{crop_variety:stage.crop_variety??null,material_pace:materialPace,material_work:materialWork,stock:null},
        material_work_note:materialNote};
    if(needsWiderSearch){
        onIncumbent(verifiedPlan);
        return null;
    }
    return verifiedPlan;
}
