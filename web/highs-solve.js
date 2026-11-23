import * as reuse from './highs-reuse.js';
const configuredOptions = new WeakMap();
const FULL_PLAN_EFFORT = 30;
const FULL_PLAN_NODE_LIMIT = 2048;

// Main-plan passes use a fixed branch-and-bound effort. LPs run to completion.
// A slower computer therefore explores the same tree before returning an incumbent.
export function planSearchOptions({time_limit: effort = FULL_PLAN_EFFORT, ...options}) {
    // Keep the short witness and repair passes cheap before the full search.
    const nodes = effort >= FULL_PLAN_EFFORT ? FULL_PLAN_NODE_LIMIT : Math.max(1, Math.ceil(effort / 2));
    return {mip_max_nodes: nodes, ...options};
}

// A single MIP node may itself solve many LPs. Count their iterations as well
// as nodes so two equally large trees cannot differ arbitrarily in cost.
export function runPlanModel(model, highs, mipIterations, reachesCeiling) {
    if (!mipIterations && !reachesCeiling) return model.run();
    let attained=false;
    const callback=highs.constants.callbackType;
    const events={[callback.mipInterrupt]:event=>{
        if(attained || (mipIterations && event.data.mip_total_lp_iterations>=mipIterations))event.interrupt();
    }};
    if(reachesCeiling)events[callback.mipImprovingSolution]=({data})=>{
        attained=reachesCeiling(data.mip_solution);
    };
    return model.run(events);
}

export function searchStopped(status, statuses) {
    return [statuses.timeLimit, statuses.iterationLimit, statuses.solutionLimit, statuses.interrupted].includes(status);
}

function applyOptions(model, options) {
    let state = configuredOptions.get(model);
    if (!state) { state={defaults:new Map(),previous:[]}; configuredOptions.set(model,state); }
    const next = {...options};
    for (const name of state.previous) if (!(name in next)) {
        const value=state.defaults.get(name);
        // The JS setter rejects non-finite numbers. HiGHS accepts its native
        // option spelling when restoring an unbounded target on a reused model.
        next[name]=value===-Infinity?'-inf':value===Infinity?'inf':value;
    }
    for (const name of Object.keys(options)) if (!state.defaults.has(name)) state.defaults.set(name,model.options.get(name));
    // Reset only caller-controlled options. resetOptions() would also reset the WASM
    // wrapper's protected single-thread settings and change subsequent search behavior.
    model.options.set(next);
    state.previous=Object.keys(options);
}

// Column names preserve worker identity while a native model is updated between stages.
// Reuse is bounded to one model per runtime; unsupported LP syntax takes a fresh model.
export function solveWithIncumbent(highs, problem, options, incumbent, reuseModel = true) {
    const {model,names,persistent} = reuse.acquireModel(highs,problem,reuseModel);
    try {
        const integerModel = /\nGeneral\n\s*x\d/.test(problem.lp);
        if (integerModel) model.clearSolver();
        model.zeroAllClocks();
        const {mipIterations,primaryCeiling,...nativeOptions} = options;
        applyOptions(model,nativeOptions);
        if (incumbent?.length === problem.variables) {
            const values = names.map(name => incumbent[Number(name.slice(1))] ?? 0);
            if (values.every(Number.isFinite)) model.setSolution({ colValue: values });
        }
        let reachesCeiling, primaryAttained=false;
        if(Number.isFinite(primaryCeiling) && problem.primary_objective?.length && integerModel){
            const indices=new Map(names.map((name,i)=>[Number(name.slice(1)),i]));
            const terms=problem.primary_objective.map(([v,c])=>[indices.get(v),c]);
            reachesCeiling=values=>{
                const produced=terms.reduce((sum,[i,c])=>sum+c*values[i],0);
                primaryAttained=Math.abs(produced-primaryCeiling)<=1e-9;
                return primaryAttained;
            };
        }
        runPlanModel(model,highs,mipIterations,reachesCeiling);
        const status = model.getModelStatus();
        const statuses = highs.constants.modelStatus;
        if (status === statuses.infeasible) return { Status: 'Infeasible' };
        const reachedTarget = (Number.isFinite(options.objective_target) && status === statuses.objectiveTarget)
            || (primaryAttained && status === statuses.interrupted);
        if (status !== statuses.optimal && !reachedTarget && !searchStopped(status,statuses)) return { Status: 'No solution' };
        // A timeout without a feasible incumbent must never be treated as a production plan.
        if (model.info.get('primal_solution_status') !== highs.constants.solutionStatus.feasible) {
            return { Status: 'No solution' };
        }
        const solution = model.getSolution();
        const objective = model.getObjectiveValue();
        // HiGHS also reports optimal when the requested relative gap is met.
        // Later priorities need the actual dual bound until the gap closes.
        const dual = integerModel && (status !== statuses.optimal || options.mip_rel_gap > 0)
            ? model.info.get('mip_dual_bound') : undefined;
        const rounding = 32 * Number.EPSILON * Math.max(1, Math.abs(objective));
        const openGap = status === statuses.optimal && integerModel && options.mip_rel_gap > 0
            && (!Number.isFinite(dual) || Math.abs(dual - objective) > rounding);
        return {
            Status: openGap ? 'Gap target reached' : status === statuses.optimal ? 'Optimal'
                : reachedTarget ? 'Objective target reached' : status === statuses.timeLimit ? 'Time limit reached' : 'Search limit reached',
            ObjectiveValue: objective,
            UpperBound: status === statuses.optimal && !openGap ? objective : dual,
            Columns: Object.fromEntries(names.map((name, i) => [name, { Primal: solution.colValue[i] }])),
        };
    } catch (error) {
        if (persistent) reuse.discardReusableModel(highs);
        throw error;
    } finally {
        if (!persistent) model.dispose();
    }
}

// A MIP's feasibility tolerance is looser than the independent native check. Refit just
// its continuous rates with the selected whole buildings/workplaces fixed. This cheap LP
// avoids restarting the much slower native simplex solely to repair MIP rounding noise.
// It supplies no new global proof, and the native bounds/flow/workplace checks still run.
export function polishSolution(highs, problem, result, trailingRows = []) {
    if (!result?.values || result.values.length !== problem.variables) return result;
    const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    if (!section) return result;
    const integers = [...section[1].matchAll(/\bx(\d+)\b/g)].map(m=>Number(m[1]));
    if (!integers.every(v=>Number.isFinite(result.values[v]) && Math.abs(result.values[v]-Math.round(result.values[v]))<=1e-7)) return result;
    let refit = reuse.refitNativeShift(highs, problem, integers,
        integers.map(v=>Math.round(result.values[v])), trailingRows);
    if (!refit) {
        const fixed = integers.map(v=>` final_fix_${v}: x${v} = ${Math.round(result.values[v])}`).join('\n');
        const lp = problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`).replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd');
        const refined = highs.solve(lp,{primal_feasibility_tolerance:1e-10,dual_feasibility_tolerance:1e-10});
        if (refined.Status !== 'Optimal' || !Number.isFinite(refined.ObjectiveValue) || !refined.Columns) return result;
        refit = {score:refined.ObjectiveValue,values:Array.from({length:problem.variables},(_,i)=>refined.Columns['x'+i]?.Primal ?? 0)};
    }
    const {values,score} = refit;
    if (!Number.isFinite(score)) return result;
    if (!integers.every(v=>Math.abs(values[v]-Math.round(values[v]))<=1e-7)) return result;
    const objective = score+(problem.tiebreak || []).reduce((sum,[v,w])=>sum+w*values[v],0);
    return {...result,values,objective,polished:true};
}

// HiGHS can accept a small overload in an integer solution. Refit the rates
// with the same whole sites and workers before another goal locks in that rate.
export function attainablePriority(highs, problem, result) {
    const checked = polishSolution(highs, problem, result);
    const tolerance = 1e-10 * Math.max(1, Math.abs(result.objective));
    if (!checked.polished || checked.objective >= result.objective - tolerance) return result;
    return {...checked, proven:false, searchProven:false,
        upper:result.proven ? Math.max(result.upper ?? result.objective, result.objective) : result.upper};
}
