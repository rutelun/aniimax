// Fast path for the explicit priority list. Global ceilings use all unlocked
// recipes. Candidate models check work conservation on every occupied site.
import {cachedEconomicBound} from './economic-bound-cache.js';
import {priorityCeiling} from './priority-ceilings.js';
import {productionObjective, CURRENCY_RELATIVE_GAP, CURRENCY_GAP_FACTOR} from './priority-search.js';
import {solveEconomicBound,suggestEconomicScope} from './economic-bound.js';
import {polishSolution} from './highs-solve.js';
import {refineStaffing} from './staffing-search.js';
import {continuousNeighborhood} from './continuous-neighborhood.js';
import {economicRecipeCounts,economicCountNeighborhood} from './economic-recipe-counts.js';
import {searchProductionSites} from './production-site-search.js';
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
    let result;
    if(cover.length) result=await solveModel(addRows(fixed,cover),options(1),undefined,warm);
    if(!result?.values) result=await solveModel(fixed,options(1),undefined,warm);
    if(!result?.values)return null;
    return polishSolution(highs,fixed,result);
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

export async function tryPriorityPlan(pkg,input,{highs,solveModel,step=()=>{},first=()=>{},initialWitness,
    evaluateBound,evaluateCounts,onIncumbent} = {}) {
    const currency=input.currency||'coins', priorities=[...(input.priorities??[])];
    if(!priorities.includes(currency))priorities.push(currency);
    const pos=priorities.indexOf(currency);
    // Switching first needs an ordinary fixed-recipe plan for comparison.
    // Shared-site trials have different capacity rules and use the full solver.
    if (!input.always_running || input.level_up_strategy || input.prioritize_byproducts
        || input.recipe_switching_relaxation || input.level_up || !highs || !solveModel) return null;
    const witnessSeed=initialWitness?.seed??initialWitness?.comparison_seed;
    const oldGoals=initialWitness?.goals??initialWitness?.comparison_goals;
    const oldScores=initialWitness?.scores??initialWitness?.comparison_scores;
    const witnessNames=initialWitness?.recipes??initialWitness?.continuous_checked_recipes??[];
    const payloadFor=(scope,restricted=false)=>JSON.stringify({...input,always_running_recipes:[...scope],
        restrict_to_checked_recipes:restricted});
    const relaxed=payloadFor([]);
    const priority=(payload,stage,key)=>key==='crop_variety'?JSON.parse(pkg.exact_crop_variety_problem(payload))
        :productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),key)));
    const exact=(payload,stage)=>JSON.parse(pkg.exact_problem(payload,JSON.stringify(stage)));
    const stage={floors:[]}, bounds=[], early=[];
    const dispatched=Object.keys(input.roster?.dispatch??{}).length>0;
    let integerPace=false;
    const prefix=[...(input.crop_variety||input.season?['crop_variety']:[]),...priorities.slice(0,pos)];
    for(const key of prefix){
        const p=priority(relaxed,stage,key);
        if(!p.lp && key==='level_up')continue;
        if(!p.lp)return null;
        let upper=priorityCeiling(highs,p,key);
        if(!Number.isFinite(upper))return null;
        if(key==='level_up' && dispatched && witnessSeed && witnessNames.length && upper>0) {
            // Walking can make the fractional upgrade pace impossible with
            // whole posts. Enforcing the previous shift's operating rules
            // still leaves every recipe available, so its optimum bounds the
            // fully checked plan. Only refine a bound the old shift cannot meet.
            const measured=priority(payloadFor(witnessNames),stage,key);
            const warm=align(measured,witnessSeed);
            const refit=warm && polishSolution(highs,measured,{values:warm});
            if(measured.production_only && !(refit?.polished && close(refit.objective,upper))) {
                const solution=highs.solve(measured.lp,{mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
                if(solution.Status==='Optimal' && solution.ObjectiveValue>0 && solution.ObjectiveValue<upper && !close(solution.ObjectiveValue,upper)) {
                    upper=solution.ObjectiveValue;
                    integerPace=true;
                }
            }
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
    const lpCeiling=priorityCeiling(highs,raw,currency);
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
        if(!Number.isFinite(objective)||objective<=0)return;
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
    const checkedCandidate=async (seed,fixed=true,sourceModel)=>{
        if(!seed||!names.size)return;
        const payload=payloadFor(names,true), p=restrict(priority(payload,currencyStage,currency),names), warm=align(p,seed);
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
    const repairModes=async (countsHint)=>{
        if(!best)return;
        const p=restrict(priority(payloadFor(names,true),currencyStage,currency),names);
        const warm=align(p,best),counts=countsHint??siteCounts(p,warm);
        const occupied=new Map(Object.entries(counts).filter(([,n])=>n>0));
        // Keep the whole number of sites per recipe but let electric and
        // worker-operated variants trade places across every facility.
        // Keep the incumbent feasible while maximizing income. Requiring a
        // strict gain can make an already optimal shift numerically infeasible.
        const local=economicCountNeighborhood(highs,p,occupied,Math.max(0,best.objective-1e-8));
        if(!local)return;
        const result=await solveModel(local,options(1.5));
        if(!result?.values)return;
        const polished=polishSolution(highs,p,result);
        if(!polished.polished)return;
        const objective=sum(p.primary_objective,polished.values);
        if(objective>best.objective+1e-8)remember(p.variable_keys,polished.values,objective);
    };
    const fullPayload=JSON.stringify({...input,always_running_recipes:undefined,restrict_to_checked_recipes:false});
    const localBound = (p,o)=>solveEconomicBound(highs,p,o);
    const bound = (p,o)=>cachedEconomicBound(p,o,evaluateBound ?? localBound);
    let fullIncome;
    const scopedModel = recipes => priority(payloadFor(recipes),currencyStage,currency);
    let siteSearch, verifiedIncomeValues;
    if(integerPace) {
        // Price income at the attainable pace in the same relaxation. An
        // optimum that also works in the full catalogue closes both searches.
        const model=scopedModel(witnessNames);
        const exactOptions={mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9};
        const solution=highs.solve(model.lp,exactOptions);
        if(solution.Status!=='Optimal' || !solution.Columns || !Number.isFinite(solution.ObjectiveValue))return null;
        const values=model.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0);
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
            const compact=priority(payloadFor(occupied.keys(),true),currencyStage,currency);
            const local=economicCountNeighborhood(highs,compact,occupied);
            if(!local)return null;
            const result=await solveModel(local,options(2));
            if(!result?.values)return null;
            const polished=polishSolution(highs,local,result);
            if(!polished.polished)return null;
            return restoreCatalogue(highs,solveModel,fullIncome,{keys:compact.variable_keys,values:polished.values});
        };
        let witness=await refitCounts(oldCounts);
        if(!witness)witness=await restoreCatalogue(highs,solveModel,fullIncome,witnessSeed);
        let earned=witness ? sum(fullIncome.primary_objective,witness.values) : -Infinity;
        let proofSeed=witness?{keys:fullIncome.variable_keys,values:witness.values}:witnessSeed;
        let initialScope=true;
        let firstProposal;
        for (;;) {
            const model=scopedModel([...proofScope]);
            // HiGHS presolve can incorrectly declare a smaller optimum when a
            // redundant currency floor duplicates the objective on a dispatch model.
            const proofOptions={scope:[...proofScope],exact:true,seed:proofSeed,
                relativeGap:CURRENCY_RELATIVE_GAP, incomeTarget:witness && earned>0 ? earned*CURRENCY_GAP_FACTOR : undefined};
            let bound=await exactBound(model,proofOptions);
            if(!Number.isFinite(bound?.upper) || !bound.values)break;
            if(initialScope)firstProposal=bound;
            proofSeed={keys:bound.keys,values:bound.values};
            if(!witness || !close(earned,bound.upper)){
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
            if(witness && earned > 0 && bound.upper >= earned - 1e-7 && bound.upper <= earned*CURRENCY_GAP_FACTOR){
                for(const name of active(fullIncome,witness.values))names.add(name);
                remember(fullIncome.variable_keys,witness.values,earned);
                verifiedIncomeValues=witness.values;
                upper=Math.max(earned,bound.upper);
                ceilings.push(upper);
                siteSearch={best,upper};
                break;
            }
            // A first cut on competing consumers can establish the same bound
            // without introducing every occupied site's availability binaries.
            let next=initialScope?suggestEconomicScope(model,bound.values,proofScope).filter(n=>!proofScope.has(n)):[];
            initialScope=false;
            if(!next.length)next=[...new Set([...bound.occupiedRecipes,...bound.activeRecipes])].filter(n=>!proofScope.has(n));
            if(!next.length)break;
            for(const name of next)proofScope.add(name);
        }
    }
    const seasonalSites = input.season && !input.roster && !witnessSeed;
    let sitesAttempted=false;
    const priceSitePatterns=async()=>{
        sitesAttempted=true;
        fullIncome??=priority(fullPayload,currencyStage,currency);
        siteSearch=await searchProductionSites(highs,raw,fullIncome,scopedModel,
            (model,settings)=>cachedEconomicBound(model,settings,localBound));
        if (siteSearch) {
            const candidate=siteSearch.best;
            remember(candidate.keys,candidate.values,candidate.objective);
            for (const name of candidate.activeRecipes) names.add(name);
            ceilings.push(siteSearch.upper);
            upper=Math.min(upper,siteSearch.upper);
        }
    };
    if (!input.roster && !input.season && !witnessSeed) await priceSitePatterns();
    if (!siteSearch || siteSearch.upper > siteSearch.best.objective * CURRENCY_GAP_FACTOR + 1e-7) {
        const initialModel=scope.length ? priority(payloadFor(scope),currencyStage,currency) : raw;
        const discovery=scope.length>0 && !witnessSeed;
        const masterOptions={seed:witnessSeed,scope,timeLimit:discovery?3:2,discovery};
        const priceSitesFirst = input.roster && stage.pace && !witnessSeed && !dispatched;
        let pending=!priceSitesFirst && evaluateBound?{model:initialModel,result:bound(initialModel,masterOptions)}:null;
        const countOptions={input,timeLimit:2};
        let countJob;
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
                const compact=priority(payloadFor(allowed,true),currencyStage,currency);
                // This dual bound prices all building patterns. When this
                // particular pattern falls short, still test its feasible income.
                const target=(counts.upper??0)/CURRENCY_GAP_FACTOR;
                for(const floor of target>0 ? [target,0] : [0]){
                    const local=economicCountNeighborhood(highs,compact,counts,floor);
                    if(!local)continue;
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
        if(seasonalSites && !best) await priceSitePatterns();
        const preparingMap=priceSitesFirst && input.map_dispatch_pending && best;
        if(preparingMap && upper>best.objective*CURRENCY_GAP_FACTOR){
            await repairModes();
            await checkedCandidate(best,false);
        }
        const pricedWithinGap = (priceSitesFirst || seasonalSites) && best && upper >= best.objective-1e-7
            && upper <= best.objective*CURRENCY_GAP_FACTOR;
        if ((preparingMap || (priceSitesFirst && pricedWithinGap)) && !close(upper,best.objective)) await repairModes();
        for(let round=0;!measuredClosed && !preparingMap && !pricedWithinGap && round<3;round++){
            const model=pending?.model??(round===0?initialModel:priority(payloadFor(scope),currencyStage,currency));
            const settings=round===0?masterOptions:{seed:best??witnessSeed,scope,timeLimit:5};
            const result=pending?await pending.result:await bound(model,settings);
            pending=null;
            if(Number.isFinite(result?.upper)){ceilings.push(result.upper);upper=Math.min(upper,result.upper);}
            if(result?.values){
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
            if(!round && seasonalSites && !sitesAttempted){
                await priceSitePatterns();
                if(best && upper<=best.objective*CURRENCY_GAP_FACTOR)break;
            }
            if(!result?.values)break;
            if(round&&next.length===scope.length)break;
            scope=next;
        }
    }
    if(!best || !Number.isFinite(upper))return null;
    fullIncome ??= priority(fullPayload,currencyStage,currency);
    let restored=null;
    for(const candidate of contenders.sort((a,b)=>b.objective-a.objective)){
        const actual=verifiedIncomeValues && candidate.values===verifiedIncomeValues ? candidate :
            await restoreCatalogue(highs,solveModel,fullIncome,candidate);
        if(!actual?.values)continue;
        const objective=sum(fullIncome.primary_objective,actual.values);
        const compatible=ceilings.filter(ceiling=>ceiling>=objective-1e-7);
        if(!compatible.length)continue;
        upper=Math.max(objective,Math.min(...compatible));
        restored={keys:fullIncome.variable_keys,values:actual.values,objective};
        break;
    }
    if(!restored)return null;
    best=restored;
    // The provisional map will be measured and solved again. On the final
    // map, compare the restored shift against this map's own income ceiling.
    const routeDraft=input.map_dispatch_pending && input.roster && !dispatched && !initialWitness;
    const needsWiderSearch=!routeDraft && upper>best.objective*CURRENCY_GAP_FACTOR;
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
    const payload=payloadFor(names,true);
    const localIncome=priority(payload,currencyStage,currency);
    let seed=best,materialPace=null,materialWork=null,last,materialNote=null;
    // Each lower priority is optimized with the previous objective floors.
    // Restricted search can provide a feasible value but never a global bound.
    for(const key of priorities.slice(pos+1)){
        const all=priority(relaxed,stage,key);
        if(!all.lp&&key==='level_up')continue;
        if(!all.lp)return null;
        const ceiling=priorityCeiling(highs,all,key);
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
        let r=await solveModel(commitments.length?addRows(local,commitments):fixPhysical(local,warm),
            options(commitments.length?2:1),undefined,warm);
        if(!r?.values)r=await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
        if(!r?.values)r=await solveModel(local,options(2),undefined,warm);
        if(!r?.values)return null;
        r=polishSolution(highs,local,r);
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
    const {request}=last, p=exact(fullPayload,request);
    const local=keepRawIncome(restrict(p,names),fullIncome,minRate);
    if(!local)return null;
    const compactSeed={keys:last.p.variable_keys,values:last.r.values};
    let r=await restoreCatalogue(highs,solveModel,local,compactSeed);
    if(!r?.values){
        const warm=align(local,compactSeed);
        r=await solveModel(fixPhysical(local,warm,true),options(2),undefined,warm);
        if(!r?.values)return null;
        r=polishSolution(highs,local,r);
    }
    if(request.maximize_material_work)materialWork=sum(p.primary_objective,r.values);
    // Staffing compares validated production and worker totals. Only the final
    // shift needs display coordinates for its climate buildings and plots.
    const audit=(values,summaryOnly=false)=>JSON.parse(pkg.exact_plan(fullPayload,JSON.stringify(request),
        JSON.stringify({values,proven:false,bound:upper,verify_only:true,summary_only:summaryOnly})));
    const refined=await refineStaffing(local,r,solveModel,{pkg,input,report:values=>audit(values,true)});
    let final=refined,plan=audit(final.values);
    if(!plan.success&&refined!==r){final=r;plan=audit(final.values);}
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
    const used=active(p,final.values);
    if(used.some(name=>!names.has(name)))return null;
    const verified=new Map(p.variable_keys.map((key,v)=>[key,final.values[v]]));
    for(const entry of early){
        const {key,terms}=entry;
        let earned=terms.length&&terms.every(([name])=>verified.has(name))
            ?terms.reduce((total,[name,c])=>total+c*verified.get(name),0):null;
        // Later priorities use the native floor slack. Recover the earlier
        // score with the checked sites before claiming it reaches its ceiling.
        if(!close(earned,entry.upper)){
            const checked=restrict(priority(payload,entry.before,key),names);
            const warm=align(checked,{keys:p.variable_keys,values:final.values});
            const audit=await solveModel(fixPhysical(checked,warm),options(.7),undefined,warm);
            if(audit?.values)earned=Math.max(earned??-Infinity,audit.objective);
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
