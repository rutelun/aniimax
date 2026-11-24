// Web Worker hosting the wasm optimizer and the HiGHS solver. Solving can take long enough that
// running it on the main thread would freeze the page's own rendering, which is what makes the
// browser offer to kill the tab; every wasm call is dispatched through here instead, so the main
// thread stays free to paint a progress indicator while a solve is in flight. See `web/app.js`'s
// `callWorker` for the request/response contract this expects.
// The page, worker and planner WASM share a build tag so browsers can reuse the same
// response across production and layout workers without mixing deployed versions.
// The message handler below is installed right away and waits on this, so no request can arrive
// before there's a handler for it.
import { autoMaximizeSeasonPoints, hasSeasonCropMinimums } from './season-planning.js?v=optional-season-points';
import {continuousProduction,withCompetingConsumers} from './continuous-production.js';
import {continuousNeighborhood, incomeRepairNeighborhood, neighborhoodResult, keepProductionWitness} from './continuous-neighborhood.js';
import {comparisonConcurrency} from './comparison-queue.js';
import {switchingWorkshops} from './material-flow-schedule.js';
import {searchRecipeSwitches,validateWorkshopCapacity} from './recipe-switch-search.js?v=workshop-capacity';
import {refineStaffing} from './staffing-search.js';
import {economicWorkers} from './economic-parallel.js';
import {comparePlans} from './opportunity-comparison.js';

const plannerWorkerUrl = import.meta.url;
const load = new URL(plannerWorkerUrl).search;
const incumbentSolver = import('./highs-solve.js');
const materialSearch = import('./material-search.js');
const comparisonSearch = import('./comparison-search.js');
const prioritySearch = import('./priority-search.js');
let priorityPlanner;
function loadPriorityPlanner() {
    return priorityPlanner ??= import('./continuous-priority-plan.js').catch(error=>{
        priorityPlanner=null;
        throw error;
    });
}
const boundTightening = import('./bound-tightening.js');
const ready = import(new URL('./pkg/aniimax.js' + load, import.meta.url).href).then(async (pkg) => {
    await pkg.default({ module_or_path: fetch(new URL('./pkg/aniimax_bg.wasm'+load, import.meta.url)) });
    return pkg;
});

// Handlers taking a single string argument and returning one; `find_plan` and
// `rank_improvements` are handled separately below since they report progress.
const HANDLER_NAMES = ['time_to_reach', 'get_version', 'get_all_items'];

// Reuse the WASM runtime within a worker. The bundled solve() creates/destroys its native
// model and frees its LP file and allocations in finally, so consecutive solves stay isolated
// without repeatedly instantiating WASM and allocating another linear memory.
let highsBytes = null;
let highsRuntime = null;
async function newHighs() {
    if (!highsBytes) {
        highsBytes = fetch(new URL('./vendor/highs/highs.wasm', import.meta.url)).then(r => {
            if (!r.ok) throw new Error(`Could not load HiGHS (${r.status})`);
            return r.arrayBuffer();
        });
    }
    if (!highsRuntime) {
        highsRuntime = (async () => {
            const { default: highsModule } = await import(new URL('./vendor/highs/highs.mjs' + load, import.meta.url).href);
            return highsModule({ wasmBinary: await highsBytes, print: () => {}, printErr: line => console.warn(line) });
        })().catch(error => { highsRuntime = null; throw error; });
    }
    return highsRuntime;
}

// Seconds HiGHS may search before settling for the best plan found so far.
const EXACT_TIME_LIMIT = 30;

// The season's points as a priority target (`SEASON_POINTS` in src/models.rs).
const SEASON_POINTS = 'season_points';

// HiGHS options for every solve.
const SOLVE_OPTIONS = { mip_rel_gap: 0, time_limit: EXACT_TIME_LIMIT };

// A tighter feasibility tolerance, used only to solve again when the plan built from an answer
// doesn't hold up: HiGHS can otherwise lean on rounding noise, a hair of negative production
// making something from nothing (seen at RV 9 with Coins then Aniimo EXP). It isn't the default
// because on a big model it can have HiGHS call a perfectly feasible plan infeasible (seen on the
// RV 17 level-up).
const STRICT_OPTIONS = { ...SOLVE_OPTIONS, mip_feasibility_tolerance: 1e-9 };

// Solves one exact-planner model with HiGHS: `{ values, proven, objective }`, or null if HiGHS
// found no plan at all. `objective` leaves out the model's tie-break (see `BUILDING_TIE_BREAK` in
// exact.rs), so it's what the plan really makes and can be a floor for a later solve.
async function solveModel(problem, options = SOLVE_OPTIONS, infeasibleMessage, incumbent, timed = false) {
    let result;
    try {
        const highs = await newHighs();
        const {solveWithIncumbent:run,planSearchOptions} = await incumbentSolver;
        if (!timed) options = planSearchOptions(options);
        result = run(highs, problem, options, incumbent);
        if (result.Status === 'Infeasible') {
            // Presolve can call a tightly constrained model infeasible when it isn't.
            result = run(highs, problem, { ...options, presolve: 'off' }, incumbent);
        }
    } catch (error) {
        // A WASM trap must not poison subsequent requests handled by this worker.
        highsRuntime = null;
        throw error;
    }
    if (result.Status === 'Infeasible' && infeasibleMessage) throw new Error(infeasibleMessage);
    const proven = result.Status === 'Optimal';
    if (!proven && result.Status !== 'Objective target reached' && result.Status !== 'Gap target reached' && result.Status !== 'Time limit reached' && result.Status !== 'Search limit reached') return null;
    // Out of time before finding any plan at all.
    if (!Number.isFinite(result.ObjectiveValue) || !result.Columns) return null;
    const values = columnValues(problem, result);
    return { values, proven, objective: result.ObjectiveValue + tiebreakOf(problem, values), upper:result.UpperBound,
        ...(Number.isFinite(options.primaryCeiling) && result.Status==='Objective target reached' ? {atPrimaryCeiling:true} : {}) };
}

function hasMaterialProcessors(input) {
    return ['Woodworking Bench', 'Chimney Kiln'].some(facility =>
        (input.facilities?.[facility] ?? [{ count: 1 }]).some(tier => tier.count > 0));
}

function columnValues(problem, result) {
    return Array.from({ length: problem.variables }, (_, i) => result.Columns?.['x' + i]?.Primal ?? 0);
}

function physicalRecipeColumns(model) {
    const groups = new Map((model.integer_groups || []).map(([name,terms]) => [name, terms.map(([v]) => v)]));
    for (const [v,name] of model.recipe_variables || []) {
        if (model.variable_keys[v].startsWith('continuous_site:')) {
            if (!groups.has(name)) groups.set(name,[]);
            groups.get(name).push(v);
        }
    }
    return groups;
}

// What the model's tie-break (see `BUILDING_TIE_BREAK` in exact.rs) took off an objective.
function tiebreakOf(problem, values) {
    return (problem.tiebreak || []).reduce((sum, [v, weight]) => sum + weight * (values[v] || 0), 0);
}

// The exact planner (see `exact_problem` in wasm.rs): builds the model in wasm, solves it with
// HiGHS, and turns the answer back into a plan. With "prioritize byproducts" on, it first finds
// the most of each byproduct the facilities can make and requires the plan to keep that much.
// With priorities (coins, Aniimo EXP, Aniipods, Wood Blocks, Mineral Sand), it makes as much of
// each as the ones before it allow, then earns coins with what's left.
// For the level-up strategy, it first finds the soonest level-up and requires the plan to keep
// that pace; if the facilities can't make the level-up at all, the plan is for coins and says so.
// If no seasonal plots are reserved, the level-up strategy also maximizes season points at
// that pace before optimizing coins.
// Returns the plan's JSON, or throws with the reason it couldn't, so the caller can fall back to
// `find_plan` and say why. `step(key, state, proven)` reports each solve as it starts and ends,
// and whether it proved its answer, for the page's progress card: `priority:<target>`,
// `level_up`, `season`, `final`, `stock_up` and `check`. `first(top)` gets the plan's first solve with
// nothing before it, `{ measure, objective, proven }`: the most of its first priority, its
// level-up pace, or its Home Coins. The page's Opportunities solve that same model for the plan
// as it stands, so they take it from here.
async function exactPlanJson(pkg, payload, step = () => {}, first = () => {}, comparison = null,
    deadline = null, routeWitness = null, workshopProof = null) {
    const input = JSON.parse(payload);
    if (input.always_running && !pkg.supports_continuous_production?.()) {
        throw new Error('The production solver is outdated. Reload the page to load the current version.');
    }
    // Comparisons use the full model: their summary may omit the active recipe list.
    if (!input.always_running || comparison) return exactPlanJsonOnce(pkg, payload, step, first, comparison, deadline);
    let top = null, seed = null, checkedShift = null;
    step('continuous_production', 'start');
    // Small fleets can also have a hard joint solve when several workers qualify
    // for the same jobs. Price site counts for both the starting and measured maps.
    if (deadline == null) {
        let accelerated;
        const workers = economicWorkers(load);
        try {
            const {tryPriorityPlan} = await loadPriorityPlanner();
            accelerated = await tryPriorityPlan(pkg,input,{
                highs:await newHighs(), solveModel, step, first, initialWitness:routeWitness, workshopProof, ...workers.callbacks,
                onIncumbent:plan=>{ checkedShift=plan; },
            });
            if (!accelerated && routeWitness) accelerated = await repairDispatchPlan(pkg,input,routeWitness);
            if(accelerated?.success && checkedShift && comparePlans(checkedShift,accelerated,input,input,1e-8).direction<0){
                accelerated=null;
            }
        } catch (error) {
            console.warn('Continuing with the full production model.',error);
        } finally {
            workers.close();
        }
        if (accelerated?.success) {
            step('continuous_production','done',accelerated.proven_optimal);
            return JSON.stringify(accelerated);
        }
    }
    // A measured shift that passed the full audit is a starting solution for
    // the wider search. Its open proof gap is not a reason to discard it.
    const searchInput=checkedShift ? {...input,always_running_recipes:checkedShift.active_continuous_recipes} : input;
    if(checkedShift)seed={...checkedShift.comparison_seed,goals:checkedShift.comparison_goals,
        currencyTarget:checkedShift.rate_per_second,upperBounds:checkedShift.continuous_upper_bounds};
    let plan = await continuousProduction(searchInput, async (trial, pass) => {
        top = null;
        if (pass === 1 && seed?.goals && input.aniimo?.startsWith('roster') && !Object.keys(input.roster?.dispatch || {}).length
            && !input.level_up_strategy && !input.prioritize_byproducts && !switchingWorkshops(input).length) {
            step('final','start');
            try {
                const joint = await repairProductionPriorities(pkg,trial,seed);
                if (joint) {
                    step('final','done',false);
                    step('check','done',false);
                    return joint;
                }
            } catch (error) {
                console.warn('Joint priorities need the full production search.',error);
            }
        }
        const solveTrial = async settings => JSON.parse(await exactPlanJsonOnce(pkg, JSON.stringify(settings),
            (key,state,proof) => {
                // The discovery pass only identifies candidate recipes. Report
                // priority timings and proofs from the constrained search.
                if (pass > 0 || trial.always_running_recipes?.length) step(key,state,proof);
            }, value => { top ||= value; }, null, deadline, seed));
        const currencyIndex=input.priorities?.indexOf(input.currency||'coins')??-1;
        if(pass===1 && trial.always_running_recipes?.length && input.roster && input.recipe_switching_relaxation
            && deadline==null && input.priorities?.[0]==='level_up' && currencyIndex>0 && currencyIndex<input.priorities.length-1){
            // Each newly occupied recipe can force a fresh income search
            // before the next resource priority. Price all operating rules
            // together using the discovery pass as the starting shift.
            try{
                const full=await solveTrial({...trial,always_running_recipes:undefined});
                if(full?.success && full.continuous_production_checked)return full;
            }catch(error){console.warn('Retrying the workshop plan with incremental recipe checks.',error);}
            top=null;
        }
        const plan=await solveTrial(trial);
        seed = plan.comparison_seed ? {...plan.comparison_seed, upperBounds:plan.continuous_upper_bounds,
            currencyTarget:plan.comparison_goals?.currency_value, goals:plan.comparison_goals} : null;
        return plan;
    }).catch(error=>{
        if(!checkedShift)throw error;
        console.warn('Keeping the validated shift after a wider search failed.',error);
        top=null;
        return checkedShift;
    });
    if(checkedShift && (!plan.success || comparePlans(checkedShift,plan,input,input,1e-8).direction<0)){
        plan=checkedShift;
        top=null;
    }
    if (plan.success && top) first(top);
    step('continuous_production', plan.success ? 'done' : 'fail');
    return JSON.stringify(plan);
}

async function exactPlanJsonOnce(pkg, payload, step = () => {}, first = () => {}, comparison = null, deadline = null, initialSeed = null) {
    const { exact_byproduct_problems, exact_priority_problem, exact_level_up_problem, exact_problem, exact_plan } = pkg;
    const input = JSON.parse(payload);
    if (input.recipe_switching_relaxation && input.roster && input.always_running_recipes?.length
        && !comparison && deadline == null) {
        input.always_running_recipes = withCompetingConsumers(JSON.parse(pkg.get_all_items()), input.always_running_recipes);
        payload = JSON.stringify(input);
    }
    const discoveryPass = input.always_running && input.always_running_recipes?.length === 0;
    const maximizeBenchAndKiln = !discoveryPass && (input.maximize_material_work ?? !input.fixed_homeland);
    const stage = { floors: [] };
    let incumbent = initialSeed ? {values:initialSeed.values} : null;
    // Auxiliary columns depend on which recipes are constrained in this pass.
    let incumbentKeys = initialSeed?.keys.map((key,i)=>key.startsWith('extra') ? `discarded:${i}` : key) ?? null;
    let lastCurrencySolve = null;
    let retainedCurrency = null;
    let currencyMaximumGlobal = false;
    let retainedCurrencyPace;
    let currencyCeiling = Infinity;
    let materialWorkNote = null;
    const options = comparison?.options || SOLVE_OPTIONS;
    const {productionObjective,productionCertificate,withProductionBounds,CURRENCY_RELATIVE_GAP,CURRENCY_GAP_FACTOR} = await prioritySearch;
    const certificates = [];
    let nearCertifiedCurrencyCeiling = false, nearDiscoveryIncome = false;
    const stageUpperBounds=new Map(initialSeed?.upperBounds||[]);
    const search = comparison?.solve || (deadline == null ? solveModel : (p,o,message,seed)=>solveModel(p,o,message,seed,true));
    const searchModel = (model, settings, message, seed) => search(model,
        model.finalSwitchIncome ? {...settings, mip_rel_gap:CURRENCY_RELATIVE_GAP} : settings, message, seed);
    const runModel = async (problem,...args)=>{
        if(deadline!=null){
            const remaining=(deadline-performance.now())/1000;
            if(remaining<.05)throw new Error('Recipe switching search time exhausted');
            args[0]={...(args[0]||options),time_limit:Math.min(remaining,2)};
        }
        const bounded = withProductionBounds(problem,certificates);
        const local = input.continuous_fast_neighborhood
            ? continuousNeighborhood(bounded,input.always_running_recipes,initialSeed) : bounded;
        const localArgs = [...args];
        if (local.continuousRestricted) localArgs[1] = undefined;
        // Downstream priorities inherit the currency floor. Once a verified
        // witness is close to its global ceiling, spend a short pass on each
        // remaining objective. Retry with the normal budget if no witness exists.
        const shortPass = (nearCertifiedCurrencyCeiling || nearDiscoveryIncome) && !comparison && deadline == null
            && (localArgs[0]?.time_limit ?? options.time_limit) > 2;
        const searchArgs = shortPass ? [{...(localArgs[0] || options),time_limit:2}, undefined, localArgs[2]] : localArgs;
        let result = await searchModel(local,...searchArgs);
        if (!result && shortPass) result = await searchModel(local,...localArgs);
        if (!result && local.continuousRestricted) return searchModel(bounded,...args);
        return neighborhoodResult(result,local.continuousRestricted);
    };
    const solveOnce = async (problem, goal) => {
        const certified = goal && await comparison?.bound(problem, goal);
        if (certified && !certified.values) return certified;
        let seed = incumbent?.values;
        if (seed && incumbentKeys?.length === seed.length && problem.variable_keys?.length === problem.variables
            && (seed.length !== problem.variables || incumbentKeys.some((key,i)=>key!==problem.variable_keys[i]))) {
            const previous = new Map(incumbentKeys.map((key,i)=>[key,seed[i]]));
            seed = problem.variable_keys.map(key=>previous.get(key) ?? 0);
        }
        const structuralSeed=seed;
        // HiGHS can accept a zero-output MIP start as optimal for a small new
        // production objective, even when a cold solve finds a positive rate.
        // An incumbent which makes none of the newly prioritized output isn't useful.
        if (seed && problem.production_only
            && problem.primary_objective.reduce((value, [i, coefficient]) => value + coefficient * (seed[i] ?? 0), 0) <= 0) {
            seed = undefined;
        }
        const message = hasSeasonCropMinimums(input) && !stage.floors.length && !stage.pace
            ? 'The minimum event crop plots cannot be met. Check plot levels, growing conditions, and the seed budget.'
            : undefined;
        const protectedProblem=comparison?.protect(problem,goal)||problem;
        const boundKey=JSON.stringify([goal,stage],(_,value)=>typeof value==='number'?Number(value.toPrecision(12)):value);
        const knownUpper=stageUpperBounds.get(boundKey);
        let repaired=null;
        if(input.always_running&&structuralSeed&&Number.isFinite(knownUpper)&&(problem.production_only||goal==='crop_variety')) {
            const general=problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
            const integers=[...(general?.[1]||'').matchAll(/\bx(\d+)\b/g)].map(m=>Number(m[1]));
            const fixed=integers.filter(v=>!problem.variable_keys[v].startsWith('extra'))
                .map(v=>` continuous_seed_${v}: x${v} = ${Math.round(structuralSeed[v])}`).join('\n');
            if(fixed) {
                const local={...protectedProblem,lp:protectedProblem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`)};
                repaired=await runModel(local,{...options,time_limit:Math.min(2,options.time_limit)},undefined,seed);
                if(repaired?.values&&(goal==='crop_variety'?Math.round(repaired.objective)===Math.round(knownUpper):Math.abs(repaired.objective-knownUpper)<=1e-8*Math.max(1,Math.abs(knownUpper)))) {
                    incumbent={...repaired,proven:true};incumbentKeys=problem.variable_keys;
                    return incumbent;
                }
                if(repaired?.values)seed=repaired.values;
            }
        }
        // Fixing the entire team can rule out a worker swap that is necessary
        // under the measured dispatch policy. Keep the active recipes flexible
        // and try to reach the same certified upper bound before branching over
        // all buildings. Failure simply leaves a warm start for the full search.
        if (input.always_running && initialSeed && goal !== (input.currency || 'coins')
            && problem.production_only && Number.isFinite(knownUpper)) {
            const local = continuousNeighborhood(withProductionBounds(protectedProblem,certificates),
                input.always_running_recipes,initialSeed);
            if (local.continuousRestricted) {
                const witness = await searchModel(local,{...options,time_limit:Math.min(1,options.time_limit)},undefined,seed);
                if (witness && (!repaired || witness.objective > repaired.objective)) {
                    repaired = neighborhoodResult(witness,true);
                    seed = repaired.values;
                    if (Math.abs(repaired.objective-knownUpper) <= 1e-8*Math.max(1,Math.abs(knownUpper))) {
                        incumbent = {...repaired,proven:true,upper:knownUpper};
                        incumbentKeys = problem.variable_keys;
                        return incumbent;
                    }
                }
            }
        }
        let result;
        if (certified) result = certified;
        else if(!(input.always_running && initialSeed) && (!comparison || options.time_limit>=EXACT_TIME_LIMIT) && goal===(input.currency||'coins') && problem.production_only
            && problem.variables>=1000 && problem.integer_groups?.length){
            const initial=await runModel(protectedProblem,{...options,time_limit:Math.min(2,options.time_limit)},message,seed);
            if(initial?.proven || initial?.searchProven || (discoveryPass && initial?.objective > 0
                && Number.isFinite(initial.upper) && initial.upper >= initial.objective - 1e-8
                && initial.upper <= initial.objective * 1.005))result=initial;
            else {
                let refined=initial;
                if(initial?.values){
                    const bounded=withProductionBounds(protectedProblem,certificates);
                    refined=(await incumbentSolver).polishSolution(await newHighs(),bounded,{...initial,polished:false});
                    if(refined.polished){
                        try {
                            const cuts=(await boundTightening).tightenIntegerBounds(await newHighs(),bounded,
                                {...refined,objective:Math.min(initial.objective,refined.objective)});
                            certificates.push(...cuts);
                        } catch(error) {
                            console.warn('Skipping LP bound tightening:',error.message||error);
                            highsRuntime=null;
                        }
                    }
                }
                result=await runModel(protectedProblem,options,message,initial?.values||seed);
                if(refined && (!result || (!result.proven && refined.objective>result.objective)))result={...refined,proven:false};
            }
        }else if (!input.continuous_fast_neighborhood && initialSeed && goal === (input.currency || 'coins') && problem.production_only) {
            const bounded = withProductionBounds(protectedProblem, certificates);
            const local = continuousNeighborhood(bounded, input.always_running_recipes, initialSeed);
            const witness = local.continuousRestricted
                ? await searchModel(local, {...options,time_limit:Math.min(4,options.time_limit)}, undefined, seed)
                : null;
            let bestSeed = witness && (!repaired || witness.objective > repaired.objective) ? witness : repaired;
            const target = initialSeed.currencyTarget / CURRENCY_GAP_FACTOR;
            const nearCeiling = shift => Number.isFinite(knownUpper) && shift?.objective > 0
                && shift.objective <= knownUpper + 1e-8
                && knownUpper - shift.objective <= CURRENCY_RELATIVE_GAP * shift.objective;
            const priceFull = async infeasibleMessage => {
                const full = problem.switchIncome ? (await boundTightening).withWorkshopCapacityCuts(protectedProblem) : protectedProblem;
                return runModel(full, options, infeasibleMessage, bestSeed?.values ?? seed);
            };
            let priced;
            if (input.aniimo?.startsWith('roster') && target > 0 && !(bestSeed?.objective >= target)) {
                const alternative = incomeRepairNeighborhood(bounded,input.always_running_recipes,initialSeed,target);
                if (alternative) {
                    // The repair adds a minimum income to a subset of this same
                    // workshop model. The full search can rule it out while
                    // pricing the shift we already have.
                    if (problem.switchIncome && bestSeed?.values && !nearCertifiedCurrencyCeiling
                        && !nearDiscoveryIncome && !nearCeiling(bestSeed)) priced = await priceFull();
                    const excluded = !priced?.restricted && Number.isFinite(priced?.upper) && priced.upper >= priced.objective
                        && priced.upper < target - 1e-6*Math.max(1,target);
                    if (!excluded) {
                        const candidate = await searchModel(alternative,{...options,time_limit:Math.min(3,options.time_limit)},undefined,seed);
                        if (candidate && (!bestSeed || candidate.objective > bestSeed.objective)) {
                            bestSeed = candidate;
                            priced = null;
                        }
                    }
                }
            }
            nearCertifiedCurrencyCeiling = nearCeiling(bestSeed);
            nearDiscoveryIncome = bestSeed?.objective > 0 && initialSeed.currencyTarget > 0
                && bestSeed.objective >= initialSeed.currencyTarget / CURRENCY_GAP_FACTOR;
            // The discovery relaxation already bounded the unrestricted
            // objective for these exact priority floors. A feasible witness
            // within the search tolerance needs no second branch-and-bound
            // pass. Never promote its local proof to a global one.
            if (nearCertifiedCurrencyCeiling) {
                result = {...bestSeed, proven:false, searchProven:false, upper:knownUpper};
            } else {
                result = keepProductionWitness(priced ?? await priceFull(message), bestSeed);
            }
            if (result && Number.isFinite(knownUpper) && knownUpper >= result.objective)
                result.upper = Math.min(result.upper ?? Infinity, knownUpper);
        }else {
            // Reserve the second income search for a switching proof that can
            // replace the fixed plan. Tied provisional incomes can lead to
            // different delivery routes and different final roster incomes.
            if (input.prove_early_switch && !comparison && deadline==null && !input.continuous_fast_neighborhood
                && stage.pace>0 && initialSeed && seed && goal===(input.currency||'coins') && problem.recipe_options?.length) {
                try{
                    const {resourceBounds}=await import('./resource-bounds.js');
                    const highs=await newHighs();
                    const witness=(await incumbentSolver).polishSolution(highs,protectedProblem,{values:seed});
                    const bounded=witness.polished && resourceBounds(highs,protectedProblem,witness);
                    if(bounded?.pricedColumns) {
                        const priced=await runModel(bounded.problem,options,undefined,witness.values);
                        // A different branch order can earn less at the node
                        // limit. Only replace the ordinary search with a proof.
                        if(priced?.proven)result=priced;
                    }
                }catch(error){
                    console.warn('Continuing the ordinary income search.',error);
                }
            }
            result??=await runModel(protectedProblem,options,message,seed);
        }
        // A repair fixes whole buildings. Only the parent solve can supply a
        // bound that later priorities may reuse across different buildings.
        result = keepProductionWitness(result,repaired);
        if (result) { incumbent = result; incumbentKeys = problem.variable_keys; }
        if(result?.proven&&(problem.production_only||goal==='crop_variety')) {
            stageUpperBounds.set(boundKey,result.objective);
        } else if (problem.production_only && Number.isFinite(result?.upper) && result.upper >= result.objective) {
            stageUpperBounds.set(boundKey,Math.min(stageUpperBounds.get(boundKey) ?? Infinity,result.upper));
        }
        const certificate = productionCertificate(problem,result);
        if (certificate) certificates.push({...certificate, continuousStable:true});
        comparison?.observe(goal, result);
        return result;
    };
    const solveCatalogue = async (problem, goal, rebuild) => {
        // A relaxed candidate may use a new recipe. Keep the previous priority's
        // physical shift until the newly occupied recipes pass their full constraints.
        const previous = incumbent?.values && incumbentKeys ? {keys:incumbentKeys, values:incumbent.values} : null;
        if (problem.switchIncome && input.always_running_recipes?.length && deadline == null) {
            try {
                // Price the checked recipes first. Refit their shift against the
                // unrestricted model before offering it as a starting solution.
                const compactPayload = JSON.stringify({...input, restrict_to_checked_recipes:true});
                const compact = JSON.parse(pkg.exact_priority_problem(compactPayload, JSON.stringify(stage), goal));
                // This restricted solve only supplies a starting shift for the
                // full currency model. Price its raw earnings at the same gap.
                const local = await solveModel(productionObjective(compact), {...options,mip_rel_gap:CURRENCY_RELATIVE_GAP});
                if (local?.values) {
                    const {restoreCatalogue} = await loadPriorityPlanner();
                    const restored = await restoreCatalogue(await newHighs(), solveModel, problem,
                        {keys:compact.variable_keys, values:local.values});
                    if (restored?.polished) {
                        incumbent = restored;
                        incumbentKeys = problem.variable_keys;
                    }
                }
            } catch (error) {
                console.warn('Continuing the full switching search after a failed warm start.', error);
            }
        }
        for(let pass=0;;pass++) {
            let result=await solveOnce(problem,goal);
            if (!result && pass > 0 && previous && !comparison && deadline == null) {
                const {restoreCatalogue} = await loadPriorityPlanner();
                const recovered = await restoreCatalogue(await newHighs(), runModel, problem, previous);
                if (recovered) {
                    result = {...recovered, proven:false, upper:undefined};
                    incumbent = result;
                    incumbentKeys = problem.variable_keys;
                }
            }
            if(!result?.values || !input.always_running || discoveryPass || !Array.isArray(input.always_running_recipes) || !rebuild)return result;
            if(!Array.isArray(problem.recipe_variables))throw new Error('Missing recipe variables for continuous production');
            const checked=new Set(input.always_running_recipes);
            const producing=new Set(problem.recipe_variables.filter(([v])=>problem.variable_keys[v].startsWith('rate:')&&result.values[v]>1e-9).map(([,name])=>name));
            if(problem.recipe_variables.some(([v,name])=>result.values[v]>1e-9&&!checked.has(name)&&!producing.has(name))) {
                // Pure priority objectives leave arbitrary unused sites selected.
                // Remove those only if a smaller model reproduces the achieved
                // objective; this preserves the original upper-bound certificate.
                const zero=new Set(problem.recipe_variables.filter(([,name])=>!producing.has(name)).map(([v])=>v));
                const local={...problem,lp:problem.lp.replace(/^ (?:0 <= x(\d+) <= [^\n]+|x(\d+) >= 0)$/gm,
                    (line,a,b)=>zero.has(Number(a??b))?` 0 <= x${a??b} <= 0`:line)};
                const sparse=await runModel(local,{...options,time_limit:Math.min(2,options.time_limit)},undefined,result.values.map((v,i)=>zero.has(i)?0:v));
                if(sparse?.values&&sparse.objective>=result.objective-1e-8*Math.max(1,Math.abs(result.objective))) {
                    result={...sparse,proven:result.proven,searchProven:result.searchProven,upper:result.upper};incumbent=result;incumbentKeys=problem.variable_keys;
                }
            }
            const missing=problem.recipe_variables.filter(([v,name])=>result.values[v]>1e-9&&!checked.has(name));
            if(!missing.length)return result;
            for(const [,name] of missing)checked.add(name);
            input.always_running_recipes=pass<7?[...checked]:undefined;
            payload=JSON.stringify(input);
            // Auxiliary identities shift when new availability constraints appear.
            incumbentKeys=incumbentKeys?.map((key,i)=>key.startsWith('extra')?`discarded:${i}`:key);
            const stable=certificates.filter(c=>c.continuousStable&&c.terms.every(([key])=>!key.startsWith('extra')));
            certificates.splice(0,certificates.length,...stable);
            Object.assign(problem,rebuild());
        }
    };
    const solve = async (problem, goal, rebuild) => {
        const result = await solveCatalogue(problem, goal, rebuild);
        if (!result?.values || !(result.objective > 0) || goal === 'crop_variety') return result;
        const {attainablePriority} = await incumbentSolver;
        const checked = attainablePriority(await newHighs(), problem, result);
        if (checked !== result) {
            incumbent = checked;
            incumbentKeys = problem.variable_keys;
        }
        return checked;
    };
    let allProven = true;
    if (!input.level_up_strategy && (input.crop_variety || input.season)) {
        step('crop_variety', 'start');
        const model = JSON.parse(pkg.exact_crop_variety_problem(payload));
        const most = model.lp ? await solve(model, 'crop_variety',()=>JSON.parse(pkg.exact_crop_variety_problem(payload))) : { objective: 0, proven: true };
        if (!most) throw new Error('no plan found for crop and tree variety');
        stage.crop_variety = Math.round(most.objective);
        allProven &&= most.proven;
        step('crop_variety', 'done', most.proven);
    }
    for (const problem of JSON.parse(exact_byproduct_problems(payload))) {
        const most = await solve(problem, problem.resource);
        if (!most) throw new Error(`no plan found for the most ${problem.resource}`);
        allProven &&= most.proven;
        stage.floors.push([problem.resource, most.objective]);
    }
    // The player's priorities, in order: each is made as much as the ones before it allow, and
    // the coin solve after them has to keep all of it up.
    const priorities = input.priorities || [];
    for (let priorityIndex=0;priorityIndex<priorities.length;priorityIndex++) {
        const target = priorities[priorityIndex];
        step(`priority:${target}`, 'start');
        const alone = stage.floors.length === 0 && !stage.pace;
        let priority = JSON.parse(exact_priority_problem(payload, JSON.stringify(stage), target));
        if (target === 'level_up' && !priority.lp) {
            step('priority:level_up', 'skip');
            continue;
        }
        if (!priority.lp) throw new Error('this setup isn\'t covered by the exact planner');
        // Keep the final currency stage's preferences, since its full solution is reused.
        // Earlier priorities get their true production maximum; the final solve chooses
        // owned workers, E-mode and compact layouts while retaining all those maxima.
        const finalCurrency = priorityIndex === priorities.length-1 && target === (input.currency || 'coins');
        // Price raw income at the fixed upgrade pace during discovery as well.
        // Its dual bound remains valid when later passes constrain more recipes.
        const switchIncome = target === (input.currency || 'coins') && input.recipe_switching_relaxation && input.roster
            && input.always_running && !comparison && stage.pace > 0;
        const pricePriority = model => {
            if (switchIncome) return {...productionObjective(model,{prune:!finalCurrency}), switchIncome:true, finalSwitchIncome:finalCurrency};
            return finalCurrency ? model : productionObjective(model,{prune:!comparison});
        };
        priority = pricePriority(priority);
        // The final currency needs an actual feasible vector for the subsequent material solve.
        const most = await solve(priority, target,()=>{
            const rebuilt=JSON.parse(exact_priority_problem(payload,JSON.stringify(stage),target));
            return pricePriority(rebuilt);
        });
        lastCurrencySolve = finalCurrency ? most : null;
        step(`priority:${target}`, 'done', most?.proven);
        if (!most) throw new Error(`no plan found for the most ${target}`);
        if (target === (input.currency || 'coins') && priority.production_only) {
            const dual = most.proven ? most.objective : most.upper;
            if (Number.isFinite(dual) && dual >= most.objective - 1e-9)
                currencyCeiling = Math.min(currencyCeiling, dual);
        }
        const closedSwitchBound = switchIncome && !most.restricted && Number.isFinite(most.upper)
            && most.upper >= most.objective && most.upper-most.objective <= 1e-8*Math.max(1,most.objective);
        if (target === (input.currency || 'coins') && (most.proven || most.searchProven || discoveryPass || nearCertifiedCurrencyCeiling || nearDiscoveryIncome || closedSwitchBound) && priority.production_only) {
            retainedCurrency = most.objective;
            currencyMaximumGlobal = most.proven;
            retainedCurrencyPace = stage.pace;
        }
        if (alone) first({ measure: target, objective: most.objective, proven: most.proven });
        allProven &&= most.proven;
        if (target === 'level_up') {
            if (most.objective > 1e-9) stage.pace = most.objective;
        } else {
            stage.floors.push([target, Math.max(0, most.objective)]);
        }
    }

    let levelUpNote = null;
    const levelUp = JSON.parse(exact_level_up_problem(payload));
    if (levelUp.lp) {
        step('level_up', 'start');
        const fastest = await solve(levelUp, 'level_up',()=>JSON.parse(exact_level_up_problem(payload)));
        step('level_up', 'done', fastest?.proven);
        if (!fastest) throw new Error('no plan found for the level-up');
        if (stage.floors.length === 0) first({ measure: 'level_up', objective: fastest.objective, proven: fastest.proven });
        if (fastest.objective > 1e-9) {
            allProven &&= fastest.proven;
            stage.pace = fastest.objective;
        } else {
            levelUpNote = 'unreachable';
        }
    }
    if (autoMaximizeSeasonPoints(input)) {
        step('season', 'start');
        const most = await solve(JSON.parse(exact_priority_problem(payload, JSON.stringify(stage), SEASON_POINTS)), SEASON_POINTS,()=>JSON.parse(exact_priority_problem(payload,JSON.stringify(stage),SEASON_POINTS)));
        step('season', 'done', most?.proven);
        if (!most) throw new Error('no plan found for the most season points');
        allProven &&= most.proven;
        if (most.objective > 1e-12) stage.floors.push([SEASON_POINTS, most.objective]);
    }
    let stageJson = JSON.stringify(stage);
    let problem = JSON.parse(exact_problem(payload, stageJson));
    if (!problem.lp) throw new Error('this setup isn\'t covered by the exact planner');
    const alone = stage.floors.length === 0 && !stage.pace;
    let solved = null;
    if (lastCurrencySolve && !input.level_up_strategy) {
        // The last priority already optimized this currency with every preceding floor.
        // Adding its own achieved floor cannot improve the result. Validate the completed
        // plan once, after material allocation, rather than rebuilding this intermediate one.
        solved = lastCurrencySolve;
    }
    if (!solved && !comparison && retainedCurrency != null && retainedCurrencyPace === stage.pace && !input.level_up_strategy
        && (discoveryPass || (maximizeBenchAndKiln && hasMaterialProcessors(input))) && incumbent?.values && incumbentKeys?.length === incumbent.values.length
        && problem.variable_keys?.length === problem.variables
        && (discoveryPass || JSON.parse(exact_problem(payload,JSON.stringify({...stage,maximize_material_work:true}))).lp)) {
        // The currency already has a feasible target under the current RV pace. The material
        // stage below retains max(final currency, that priority), so another currency MIP
        // can reuse that target. Map the latest feasible priority plan directly into that
        // stage instead of spending another search merely to obtain an incumbent.
        const previous = new Map(incumbentKeys.map((key,i)=>[key,incumbent.values[i]]));
        solved = {values:problem.variable_keys.map(key=>previous.get(key) ?? 0),
            objective:retainedCurrency,proven:currencyMaximumGlobal};
    }
    const finalReused = !!solved;
    step('final', finalReused ? 'skip' : 'start');
    solved ||= await solve(problem, input.currency || 'coins',()=>JSON.parse(exact_problem(payload,stageJson)));
    if (!solved) throw new Error('the solver found no plan');
    if (alone) first({ measure: 'coins', objective: solved.objective, proven: solved.proven });
    let proven = solved.proven && allProven;
    let bound = solved.objective;
    if (!proven) {
        // The same model without whole units: the most any plan could earn.
        if (!comparison && Number.isFinite(currencyCeiling) && currencyCeiling >= bound - 1e-9) {
            // Subsequent priorities only add requirements. A certified ceiling
            // on raw currency still bounds the final plan's raw earnings.
            bound = Math.max(bound, currencyCeiling);
        } else if (!comparison) {
            // Maximize raw earnings directly. Removing the tie-break from the
            // value at a penalized LP optimum need not bound raw earnings.
            const raw = productionObjective(problem);
            const relaxed = (await newHighs()).solve(raw.lp.replace(/\nGeneral\n[\s\S]*\nEnd/, '\nEnd'), {});
            if (relaxed.Status === 'Optimal' && Number.isFinite(relaxed.ObjectiveValue))
                bound = Math.max(bound, relaxed.ObjectiveValue);
        }
    }
    if (!finalReused) step('final', 'done', solved.proven);
    const coins = solved.objective;
    const levelUpStrategyPace = stage.pace && input.level_up;
    let materialWork;
    let materialPace;
    if (hasMaterialProcessors(input)) {
        const currency = input.currency || 'coins';
        const coinFloor = Math.max(coins, ...stage.floors.filter(([name]) => name === currency).map(([, amount]) => amount));
        const workStage = levelUpStrategyPace ? { ...stage, coins } : {
            ...stage, floors: [...stage.floors.filter(([name]) => name !== currency), [currency, coinFloor]],
        };
        // A workload maximum alone can fill both Benches with Rough Lumber and make no
        // Standard Planks. First reserve balanced net production of the RV's actual costs.
        const preview = input.level_up_preview;
        if (!stage.pace && preview?.cost.some(([name, amount]) => name !== currency
            && amount > (preview.stock || []).filter(([item]) => item === name).reduce((n, [, value]) => n + value, 0))) {
            step('materials', 'start');
            const stockJson = JSON.stringify({ ...workStage, maximize_upgrade_materials: true });
            const stockProblem = JSON.parse(exact_problem(payload, stockJson));
            const seed = stockProblem.variables === solved.values.length + 1 ? [...solved.values, 0] : undefined;
            const stocked = await (await materialSearch).searchMaterials({...stockProblem,continuousMaterialSearch:true}, seed, runModel, options);
            if (!stocked) throw new Error('no plan found for the RV upgrade materials');
            workStage.material_pace = stocked.objective;
            materialPace = stocked.objective;
            allProven &&= stocked.proven;
            proven &&= stocked.proven;
            if (!stocked.proven) materialWorkNote = 'unproven';
            solved = stocked;
        }
        const workJson = JSON.stringify({ ...workStage, maximize_material_work: true });
        const workProblem = maximizeBenchAndKiln ? JSON.parse(exact_problem(payload, workJson)) : {};
        const keepMaterialStock = () => {
            stageJson = JSON.stringify({ ...workStage, material_pace: undefined, maximize_upgrade_materials: true });
            problem = JSON.parse(exact_problem(payload, stageJson));
        };
        if (workProblem.lp) {
            step('materials', 'start');
            const worked = await (await materialSearch).searchMaterials({...workProblem,continuousMaterialSearch:true}, solved.values, runModel, options);
            step('materials', worked ? 'done' : 'fail', worked?.proven);
            if (worked) {
                allProven &&= solved.proven;
                materialWork = worked.objective;
                stageJson = workJson;
                problem = workProblem;
                solved = worked;
                proven &&= worked.proven;
                if (!worked.proven) materialWorkNote = 'unproven';
            } else {
                // Keep the feasible priority plan when the extra workload search times out.
                materialWorkNote = 'unavailable';
                if (materialPace != null) keepMaterialStock();
            }
        } else if (materialPace != null) {
            // Preserve useful upgrade output without filling the remaining machine time.
            keepMaterialStock();
            step('materials', 'done', solved.proven);
        }
    }
    const finish = (plan, stock = null, seedProblem = problem, seedSolved = solved) => {
        plan.continuous_upper_bounds = [...stageUpperBounds];
        plan.continuous_checked_recipes = input.always_running_recipes;
        plan.continuous_production_checked = !!input.always_running && input.always_running_recipes == null;
        plan.active_continuous_recipes = seedProblem.recipe_variables?.filter(([v])=>seedSolved.values[v]>1e-9).map(([,name])=>name);
        if (input.always_running && !comparison && input.aniimo?.startsWith('roster')) {
            plan.continuous_site_counts = Object.fromEntries([...physicalRecipeColumns(seedProblem)].map(([name,columns]) =>
                [name,Math.round(columns.reduce((total,v) => total + seedSolved.values[v],0))]));
        }
        plan.level_up_note = levelUpNote;
        plan.material_work_note = materialWorkNote;
        plan.comparison_scores = { crop_variety: stage.crop_variety ?? null,
            material_pace: materialPace ?? null, material_work: materialWork ?? null, stock };
        plan.comparison_goals = { crop_variety: stage.crop_variety ?? null, floors: stage.floors, pace: stage.pace ?? null,
            currency: input.currency || 'coins', currency_value: coins };
        if (!comparison && Array.isArray(seedProblem.variable_keys) && seedProblem.variable_keys.length === seedSolved.values?.length) {
            plan.comparison_seed = { keys: seedProblem.variable_keys, values: seedSolved.values };
        }
        return JSON.stringify(plan);
    };
    if (levelUpStrategyPace) {
        // Prefer the materials the level-up needs while keeping the maximum workload.
        const stockStage = { ...stage, coins, material_work: materialWork };
        const stockJson = JSON.stringify(stockStage);
        step('stock_up', 'start');
        const stockProblem = JSON.parse(exact_problem(payload, stockJson));
        let stocked = await runModel(stockProblem, options);
        step('stock_up', 'done', stocked?.proven);
        step('check', 'start');
        if (stocked) {
            stocked = (await incumbentSolver).polishSolution(await newHighs(),stockProblem,stocked);
            if (input.always_running && !discoveryPass && !comparison && deadline == null) {
                stocked = await verifiedStaffing(pkg,payload,stockJson,stockProblem,stocked);
            }
        }
        const stockedPlan = stocked
            && JSON.parse(exact_plan(payload, stockJson, JSON.stringify({ values: stocked.values, proven: proven && stocked.proven, bound, summary_only:!!comparison })));
        if (stockedPlan && stockedPlan.success) {
            step('check', 'done');
            return finish(stockedPlan, stocked.objective, stockProblem, stocked);
        }
        console.warn('Level-up stock solve found no usable plan; keeping the plan without it.');
    }
    step('check', 'start');
    solved = (await incumbentSolver).polishSolution(await newHighs(),problem,solved);
    if (input.always_running && !discoveryPass && !comparison && deadline == null) {
        solved = await verifiedStaffing(pkg,payload,stageJson,problem,solved);
    }
    let json = exact_plan(payload, stageJson, JSON.stringify({ values: solved.values, proven, bound, summary_only:!!comparison }));
    let plan = JSON.parse(json);
    if (!plan.success) {
        // The answer didn't survive being rebuilt exactly; solve again, this time refusing the
        // rounding noise it may have leaned on.
        const strict = await runModel(problem, { ...STRICT_OPTIONS, time_limit: options.time_limit }, undefined, solved.values);
        if (strict) {
            json = exact_plan(payload, stageJson, JSON.stringify({ values: strict.values, proven: strict.proven && allProven, bound, summary_only:!!comparison }));
            plan = JSON.parse(json);
            if (plan.success) solved = strict;
        }
    }
    if (!plan.success) throw new Error(plan.error || 'the plan failed its check');
    step('check', 'done');
    return finish(plan);
}

// The optional secondary staffing solve keeps the original production witness
// if rebuilding its replacement would invalidate any native constraint.
async function verifiedStaffing(pkg,payload,stage,problem,incumbent) {
    const report=values=>JSON.parse(pkg.exact_plan(payload,stage,JSON.stringify({
        values,proven:false,bound:0,summary_only:true,verify_only:true,
    })));
    const refined = await refineStaffing(problem,incumbent,solveModel,{pkg,input:JSON.parse(payload),report});
    if (refined === incumbent) return incumbent;
    const validation = report(refined.values);
    return validation.success ? refined : incumbent;
}

// Aim for the optimistic priority targets in a single feasible staffing plan.
// The unmodified multi-stage search handles any missing or infeasible target.
async function repairProductionPriorities(pkg,input,seed) {
    const {currency,pace,crop_variety,floors} = seed.goals;
    if (!pace || !floors.some(([name])=>name===currency) || !hasMaterialProcessors(input)) return null;
    const currencyIndex = floors.findIndex(([name])=>name===currency);
    const prefix = {floors:floors.slice(0,currencyIndex)};
    if (crop_variety != null) prefix.crop_variety = crop_variety;
    if (input.priorities.indexOf('level_up') > input.priorities.indexOf(currency)) return null;
    prefix.pace = pace;
    const boundKey = JSON.stringify([currency,prefix],(_,v)=>typeof v==='number'?Number(v.toPrecision(12)):v);
    const upper = new Map(seed.upperBounds).get(boundKey);
    if (!Number.isFinite(upper) || !(seed.currencyTarget > 0)) return null;
    const payload = JSON.stringify(input);
    const stage = {crop_variety,pace,floors:floors.filter(([name])=>name!==currency)};
    const {productionObjective,CURRENCY_GAP_FACTOR} = await prioritySearch;
    const model = productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),currency)));
    const local = incomeRepairNeighborhood(model,input.always_running_recipes,seed,seed.currencyTarget/CURRENCY_GAP_FACTOR);
    if (!local) return null;
    const previous = new Map(seed.keys.map((key,i)=>[key,seed.values[i]]));
    const warmIncome = local.variable_keys.map(key=>key.startsWith('extra')?0:previous.get(key)??0);
    // Try the discovery plan's grid and climate before reopening the full
    // production neighborhood. Buildings, recipes and worker choices stay free.
    const general = local.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const infrastructure = [];
    for (const match of (general?.[1] ?? '').matchAll(/\bx(\d+)\b/g)) {
        const v = Number(match[1]), key = local.variable_keys[v];
        if (!/^(environment:|pair:|generators#)/.test(key) || !previous.has(key)) continue;
        infrastructure.push(` shift_${v}: x${v} = ${Math.round(previous.get(key))}`);
    }
    const search = {...SOLVE_OPTIONS,mip_max_nodes:32};
    let found;
    if (infrastructure.length) {
        const fixed = {...local,lp:local.lp.replace('\nBounds\n','\n'+infrastructure.join('\n')+'\nBounds\n')};
        found = await solveModel(fixed,search,undefined,warmIncome);
    }
    found ??= await solveModel(local,search,undefined,warmIncome);
    if (!found || found.objective < seed.currencyTarget/CURRENCY_GAP_FACTOR || found.objective > upper+1e-7) return null;
    stage.floors = floors.map(([name,value])=>[name,name===currency?found.objective:value]);
    stage.maximize_material_work = true;
    const stageJson = JSON.stringify(stage);
    const work = JSON.parse(pkg.exact_problem(payload,stageJson));
    const valuesByKey = new Map(model.variable_keys.map((key,i)=>[key,found.values[i]]));
    const warm = work.variable_keys.map(key=>valuesByKey.get(key)??0);
    const checked = new Set(input.always_running_recipes);
    const rows = work.recipe_variables.filter(([,name])=>!checked.has(name)).map(([v])=>` inactive_${v}: x${v} = 0`);
    for (const v of work.material_fixed || []) rows.push(` retain_${v}: x${v} = ${Math.round(warm[v])}`);
    const fixed = {...work,lp:work.lp.replace('\nBounds\n',`\n${rows.join('\n')}\nBounds\n`)};
    const worked = await solveModel(fixed,{...SOLVE_OPTIONS,time_limit:1},undefined,warm);
    if (!worked) return null;
    const polished = (await incumbentSolver).polishSolution(await newHighs(),fixed,worked);
    const result = work.staffing_pools?.length
        ? await verifiedStaffing(pkg,payload,stageJson,work,polished) : polished;
    if (work.recipe_variables.some(([v,name])=>result.values[v]>1e-9&&!checked.has(name))) return null;
    const plan = JSON.parse(pkg.exact_plan(payload,stageJson,JSON.stringify({values:result.values,proven:false,bound:upper})));
    if (!plan.success || plan.rate_per_second < seed.currencyTarget/CURRENCY_GAP_FACTOR) return null;
    return {...plan,continuous_production_checked:true,continuous_checked_recipes:[...checked],
        active_continuous_recipes:work.recipe_variables.filter(([v])=>result.values[v]>1e-9).map(([,name])=>name),
        continuous_site_counts:Object.fromEntries([...physicalRecipeColumns(work)].map(([name,vs])=>
            [name,Math.round(vs.reduce((n,v)=>n+result.values[v],0))])),
        continuous_upper_bounds:seed.upperBounds,comparison_goals:{...seed.goals,floors:stage.floors,currency_value:found.objective},
        comparison_seed:{keys:work.variable_keys,values:result.values},material_work_note:'unproven',
        comparison_scores:{crop_variety,material_pace:null,material_work:result.objective,stock:null}};
}

// Recheck a completed shift against the dispatch policy measured on its map.
// Both its worker assignments and its bounds must be rebuilt for that policy.
async function repairDispatchPlan(pkg, input, witness) {
    if (!input.always_running || !pkg.supports_continuous_production?.() || !input.roster?.dispatch || !witness?.recipes?.length
        || !witness.seed?.keys?.length || !witness.goals?.pace || witness.scores?.material_work == null
        || switchingWorkshops(input).length || input.level_up_strategy || input.prioritize_byproducts) return null;
    const {productionObjective,CURRENCY_RELATIVE_GAP,CURRENCY_GAP_FACTOR} = await prioritySearch;
    const {pace, floors, crop_variety, currency} = witness.goals;
    if (!floors.some(([name]) => name === currency) || witness.scores.material_pace != null) return null;
    const recipes = new Set(witness.recipes);
    const payload = JSON.stringify({...input, always_running_recipes:[...recipes]});
    // Measured travel can change the best power mode or require two normal
    // buildings where one faster worker previously sufficed. Retain the
    // earlier priorities, then optimize actual earnings inside this roster.
    const stage = JSON.stringify({floors:floors.map(([name,value])=>[name,name===currency?value/CURRENCY_GAP_FACTOR:value]),
        pace, crop_variety, material_work:witness.scores.material_work});
    const model = JSON.parse(pkg.exact_problem(payload, stage));
    if (!model.recipe_variables || !model.lp) return null;
    const zeros = model.recipe_variables.filter(([,name]) => !recipes.has(name))
        .map(([v]) => ` route_scope_${v}: x${v} = 0`).join('\n');
    const counts = [...physicalRecipeColumns(model)].filter(([name]) => recipes.has(name)
        && Number.isInteger(witness.counts?.[name])).map(([name,columns],i) =>
        ` route_sites_${i}: ${columns.map(v => 'x'+v).join(' + ')} >= ${witness.counts[name]}`).join('\n');
    const local = {...model, lp:model.lp.replace('\nBounds\n', `\n${zeros}\n${counts}\nBounds\n`)};
    const previous = new Map(witness.seed.keys.map((key,i) => [key,witness.seed.values[i]]));
    const seedFor = p => p.variable_keys.map(key => key.startsWith('extra') ? 0 : previous.get(key) ?? 0);
    const found = await solveModel(local, {...SOLVE_OPTIONS,time_limit:1}, undefined, seedFor(model));
    if (!found) return null;
    const highs = await newHighs();
    const polished = (await incumbentSolver).polishSolution(highs,local,found);
    const solved = model.staffing_pools?.length
        ? await verifiedStaffing(pkg,payload,stage,model,polished) : polished;
    if (model.recipe_variables.some(([v,name]) => !recipes.has(name) && solved.values[v] > 1e-9)) return null;
    const work = JSON.parse(pkg.exact_problem(payload,JSON.stringify({floors,pace,crop_variety,maximize_material_work:true})));
    const byKey = new Map(model.variable_keys.map((key,i)=>[key,solved.values[i]]));
    const materialWork = work.primary_objective.reduce((value,[v,c])=>value+c*(byKey.get(work.variable_keys[v])??0),0);
    if (materialWork < witness.scores.material_work - 1e-6) return null;

    const relaxed = JSON.stringify({...input, always_running_recipes:[]});
    const thresholds = new Map(floors);
    thresholds.set(currency,solved.objective);
    const stages = {floors:[]};
    const upperBounds = [];
    let currencyUpper;
    for (const key of [...(crop_variety == null ? [] : ['crop_variety']), ...input.priorities]) {
        const target = key === 'crop_variety' ? crop_variety : key === 'level_up' ? pace : thresholds.get(key);
        if (!Number.isFinite(target)) return null;
        const p = key === 'crop_variety' ? JSON.parse(pkg.exact_crop_variety_problem(relaxed))
            : productionObjective(JSON.parse(pkg.exact_priority_problem(relaxed,JSON.stringify(stages),key)));
        if (!p.lp || (key !== 'crop_variety' && !p.production_only)) return null;
        const lp = p.lp.replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd');
        const result = highs.solve(lp);
        let upper = result.Status === 'Optimal' ? result.ObjectiveValue : Infinity;
        const tolerance = key === currency ? CURRENCY_RELATIVE_GAP * target : 1e-8 * Math.max(1,Math.abs(target));
        if (upper > target + tolerance) {
            const mip = await solveModel(p,{...SOLVE_OPTIONS,time_limit:2},undefined,seedFor(p));
            if (Number.isFinite(mip?.upper)) upper = Math.min(upper,mip.upper);
        }
        if (!Number.isFinite(upper) || upper < target - 1e-7 || upper > target + tolerance) return null;
        upperBounds.push([JSON.stringify([key,stages],(_,v)=>typeof v === 'number' ? Number(v.toPrecision(12)) : v), upper]);
        if (key === currency) currencyUpper = upper;
        if (key === 'crop_variety') stages.crop_variety = target;
        else if (key === 'level_up') stages.pace = target;
        else stages.floors.push([key,target]);
    }
    if (!Number.isFinite(currencyUpper)) return null;
    const plan = JSON.parse(pkg.exact_plan(payload, stage, JSON.stringify({values:solved.values, proven:false, bound:currencyUpper})));
    if (!plan.success || currencyUpper - plan.rate_per_second > CURRENCY_RELATIVE_GAP * plan.rate_per_second) return null;
    return {...plan, continuous_production_checked:true, continuous_checked_recipes:[...recipes],
        active_continuous_recipes:model.recipe_variables.filter(([v])=>solved.values[v]>1e-9).map(([,name])=>name),
        continuous_upper_bounds:upperBounds, comparison_seed:{keys:model.variable_keys,values:solved.values},
        comparison_goals:{...witness.goals,floors:[...thresholds],currency_value:plan.rate_per_second},
        comparison_scores:{crop_variety,material_pace:null,material_work:materialWork,stock:null},
        material_work_note:'unproven'};
}

async function canFillWorkshop(pkg,trial,baseline) {
    const {canFillSwitchingWorkshop}=await import('./recipe-switch-bound.js');
    return canFillSwitchingWorkshop(pkg,await newHighs(),trial,baseline);
}

function usesWorkshopCapacitySearch(input) {
    return !input.level_up && !input.level_up_strategy && !input.prioritize_byproducts;
}

async function withRecipeSwitches(pkg,input,baseline,progress=()=>{},timed=false,workshopProof) {
    if(!timed && baseline.success && usesWorkshopCapacitySearch(input)){
        try{
            const {searchWorkshopCapacity}=await import('./workshop-capacity.js');
            const highs=await newHighs();
            const validate=(trial,plan,previous)=>validateWorkshopCapacity(trial,plan,previous,model=>highs.solve(model.lp,{mip_rel_gap:0}));
            const selected=await searchWorkshopCapacity(pkg,highs,input,baseline,{validate,progress});
            if(input.roster && selected!==baseline)return {...selected,workshop_route_fallback:baseline};
            return selected;
        }catch(error){
            console.warn('Keeping the ordinary workshop plan after a capacity fit failed.',error);
            return {...baseline,recipe_switching_note:'Keeping the verified ordinary workshop plan.',
                recipe_switching_detail:String(error.message||error)};
        }
    }
    const deadline=timed ? performance.now()+10000 : null;
    // A switch changes the workshop constraints while preserving the measured
    // routes. Refit the ordinary shift in each trial; its previous upper bound
    // cannot certify income with the new constraints.
    const routeWitness=!timed && Object.keys(input.roster?.dispatch??{}).length
        && baseline.continuous_production_checked && baseline.comparison_seed ? {
            recipes:baseline.active_continuous_recipes,counts:baseline.continuous_site_counts,
            seed:baseline.comparison_seed,goals:baseline.comparison_goals,scores:baseline.comparison_scores,
        } : null;
    const workshopBaseline=!timed && input.always_running ? {success:baseline.success,
        workshopProof,routeWitness,comparison_scores:{crop_variety:baseline.comparison_scores?.crop_variety},
        priorities:baseline.priorities?.slice(0,1),level_up_preview:{seconds:baseline.level_up_preview?.seconds}} : null;
    return searchRecipeSwitches(input,baseline,{workshopBaseline,
        canFillWorkshop:workshopBaseline ? trial=>canFillWorkshop(pkg,trial,workshopBaseline) : null,
        parallel:globalThis.navigator?.hardwareConcurrency>=8 && globalThis.navigator?.deviceMemory>=8
            ? 4 : comparisonConcurrency(globalThis.navigator,4),
        createWorker:!timed && typeof Worker==='function'?()=>new Worker(plannerWorkerUrl,{type:'module'}):null,
        candidate:async trial=>JSON.parse(await exactPlanJson(pkg,JSON.stringify(trial),undefined,undefined,null,deadline,routeWitness,workshopProof)),
        solve:async model=>(await newHighs()).solve(model.lp,timed ? {time_limit:Math.max(.05,Math.min(3,(deadline-performance.now())/1000)),mip_rel_gap:0} : {mip_max_nodes:128,mip_rel_gap:0}),progress,
    });
}

// A queue worker handles one alternative at a time. Share only proved results for
// identical solver models across its requests. Incumbents and cuts stay per request.
const comparisonMemo = { entries: new Map(), size: 0 };

// Ranks changes the player could make with the same complete optimizer, preserving planting,
// every priority, E-mode and RV material production. They run only on explicit request.
async function rankImprovements(pkg, payload, report, memo) {
    const { base, basePlan, candidates, detailed = false, warm_start = true } = JSON.parse(payload);
    const original = basePlan?.success ? basePlan : JSON.parse(await exactPlanJson(pkg, JSON.stringify(base)));
    report({ index: -1, plan: original });
    const comparison = (await comparisonSearch).createComparisonSearch(original, (p,o,message,seed)=>solveModel(p,o,message,seed,true), {
        detailed, warmStart: warm_start, baseInput: base, memo,
    });
    for (const [index, input] of candidates.entries()) {
        try {
            comparison.begin(input);
            if(switchingWorkshops(input).length)comparison.disableBounds();
            const search = () => exactPlanJson(pkg, JSON.stringify(input),
                (step, state, proven) => report({ index, step, state, proven }), () => {}, comparison);
            let json;
            try { json = await search(); }
            catch (error) {
                // Matching LP upper bounds cannot establish integer feasibility. A trait
                // replacement can make the baseline's floors unattainable. Detailed mode
                // must then find that alternative's own goals rather than reject it.
                if (!detailed || !comparison.usedBounds) throw error;
                comparison.disableBounds();
                json = await search();
            }
            const plan = switchingWorkshops(input).length?await withRecipeSwitches(pkg,input,JSON.parse(json),undefined,true):JSON.parse(json);
            if (plan.success && comparison.inconclusive(plan, base, input)) {
                report({index, error:'The search did not match the current plan. This does not show that the upgrade reduces production. Use Detailed search.', detailed});
                continue;
            }
            report(plan.success ? { index, plan, detailed, stats: { ...comparison.stats } }
                : { index, error: plan.error || 'No plan found', detailed });
        } catch (error) {
            report({ index, error: error.message || String(error), detailed });
        }
    }
}

self.onmessage = async (event) => {
    const { id, type, payload } = event.data;
    try {
        const pkg = await ready;
        if (type === 'switch_candidate') {
            if (event.data.workshopBaseline) {
                let possible=true;
                try {
                    possible=await canFillWorkshop(pkg,JSON.parse(payload),event.data.workshopBaseline);
                } catch { /* A missing bound leaves the full search eligible. */ }
                if (!possible) {
                    self.postMessage({id,ok:true,result:JSON.stringify({success:false})});
                    return;
                }
            }
            const {workshopProof,routeWitness}=event.data.workshopBaseline??{};
            self.postMessage({id,ok:true,result:await exactPlanJson(pkg,payload,undefined,undefined,null,null,routeWitness,workshopProof)});
            return;
        }
        if (type === 'protect_crops') {
            const {cropProtectionPlans}=await import('./power-team-validation.js');
            const result=cropProtectionPlans(pkg,await newHighs(),payload);
            self.postMessage({id,ok:true,result});
            return;
        }
        if (type === 'power_teams') {
            const {shortlistPowerTeams}=await import('./power-team-search.js');
            const result=await shortlistPowerTeams(pkg,await newHighs(),payload.plan,payload.input);
            self.postMessage({id,ok:true,result});
            return;
        }
        if (type === 'mapped_material_plan') {
            const {mappedMaterialPlan}=await import('./mapped-material-schedule.js');
            self.postMessage({id,ok:true,result:mappedMaterialPlan(pkg,await newHighs(),payload)});
            return;
        }
        if (type === 'compact_team') {
            const {compactMeasuredTeam} = await import('./measured-team.js');
            const plan = compactMeasuredTeam(pkg,await newHighs(),payload);
            self.postMessage({id,ok:true,result:plan});
            return;
        }
        if (type === 'rank_improvements') {
            await rankImprovements(pkg, payload, result => self.postMessage({ id, type: 'progress', count: result }), comparisonMemo);
            self.postMessage({ id, ok: true, result: null });
            return;
        }
        if (type === 'find_plan') {
            let result = null;
            let fallbackReason = null;
            // Each solve's start and end go to the page as progress, as `{ step, state, proven }`.
            const step = (key, state, proven) => self.postMessage({ id, type: 'progress', count: { step: key, state, proven } });
            const switchingInput = JSON.parse(payload);
            const workshopProof={};
            // A roster's provisional plan exists to place its buildings and
            // measure the actual routes. Search the daily workshop changes with
            // those routes once they are known, including an empty dispatch.
            const measureFirst = switchingInput.map_dispatch_pending && switchingInput.roster
                && !Object.keys(switchingInput.roster.dispatch || {}).length
                && switchingInput.always_running && switchingWorkshops(switchingInput).length>0;
            try {
                let top = null;
                result = await exactPlanJson(pkg, payload, step, found => { top ||= found; },
                    null,null,event.data.routeWitness,workshopProof);
                if (top) {
                    const plan = JSON.parse(result);
                    plan.measure_top = top;
                    result = JSON.stringify(plan);
                }
            } catch (error) {
                fallbackReason = error && error.message ? error.message : String(error);
                // The backup planner doesn't know the player's roster, so a roster plan stops here.
                const input = JSON.parse(payload);
                if (input.always_running || input.fixed_homeland || input.e_mode_rv >= 12 || input.electricity || Object.values(input.quest_income_per_day||{}).some(n=>n>0) || hasSeasonCropMinimums(input) || hasMaterialProcessors(input)
                    || (!input.level_up_strategy && (input.crop_variety || input.season || input.priorities?.includes('level_up')))) {
                    result = JSON.stringify({ success: false, error: fallbackReason });
                } else if (input.aniimo?.startsWith('roster')) {
                    console.warn('Exact planner failed on a roster:', error);
                    result = JSON.stringify({ success: false, error: `No plan found with these Aniimo: ${fallbackReason}.` });
                } else {
                    step('backup', 'start');
                    console.warn('Exact planner failed; using the backup planner instead:', error);
                }
            }
            if (!result) {
                // Forwarded straight from the wasm solver's own real trial-solve count (see
                // `find_plan`'s doc comment in wasm.rs); a `type: 'progress'` message, distinct
                // from the final `{ ok, result }` response below, so `app.js`'s `callWorker` can
                // relay it to a live progress bar without resolving the request early.
                const onProgress = (count) => self.postMessage({ id, type: 'progress', count });
                const plan = JSON.parse(pkg.find_plan(payload, onProgress));
                plan.fallback_reason = fallbackReason;
                result = JSON.stringify(plan);
            }
            if(switchingWorkshops(switchingInput).length){
                const ordinary=JSON.parse(result);
                if(measureFirst && ordinary.success){
                    self.postMessage({id,ok:true,result:JSON.stringify({...ordinary,pending_workshop_routes:true})});
                    return;
                }
                const measuredLayout=!!event.data.routeWitness && !switchingInput.map_dispatch_pending;
                if (ordinary.success && ordinary.continuous_production_checked && (switchingInput.map_dispatch_pending || measuredLayout)
                    && switchingInput.roster && !switchingInput.fixed_homeland && switchingInput.priorities?.[0]==='level_up'
                    && comparisonConcurrency(globalThis.navigator,2)>1) {
                    self.postMessage({id,type:'progress',count:{ordinaryForMap:result,layoutOnly:measuredLayout}});
                }
                const selected=await withRecipeSwitches(pkg,switchingInput,ordinary,step,false,workshopProof);
                result=JSON.stringify(selected);
            }
            self.postMessage({ id, ok: true, result });
            return;
        }
        const handler = HANDLER_NAMES.includes(type) ? pkg[type] : null;
        if (!handler) {
            throw new Error(`Unknown worker request type: ${type}`);
        }
        // Download and compile the shared solver while the player edits the setup.
        // A failed warm-up is retried by the normal find_plan path.
        if (type === 'get_version') {
            newHighs().catch(()=>{ highsBytes=null; });
            loadPriorityPlanner().catch(()=>{});
        }
        const result = payload === undefined ? handler() : handler(payload);
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
    }
};
