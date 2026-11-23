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
export function runPlanModel(model, highs, mipIterations) {
    if (!mipIterations) return model.run();
    return model.run({[highs.constants.callbackType.mipInterrupt]: event => {
        if (event.data.mip_total_lp_iterations >= mipIterations) event.interrupt();
    }});
}

export function searchStopped(status, statuses) {
    return [statuses.timeLimit, statuses.iterationLimit, statuses.solutionLimit, statuses.interrupted].includes(status);
}

function applyOptions(model, options) {
    let state = configuredOptions.get(model);
    if (!state) { state={defaults:new Map(),previous:[]}; configuredOptions.set(model,state); }
    const next = {...options};
    for (const name of state.previous) if (!(name in next)) next[name]=state.defaults.get(name);
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
        if (/\nGeneral\n\s*x\d/.test(problem.lp)) model.clearSolver();
        model.zeroAllClocks();
        const {mipIterations,...nativeOptions} = options;
        applyOptions(model,nativeOptions);
        if (incumbent?.length === problem.variables) {
            const values = names.map(name => incumbent[Number(name.slice(1))] ?? 0);
            if (values.every(Number.isFinite)) model.setSolution({ colValue: values });
        }
        runPlanModel(model,highs,mipIterations);
        const status = model.getModelStatus();
        const statuses = highs.constants.modelStatus;
        if (status === statuses.infeasible) return { Status: 'Infeasible' };
        if (status !== statuses.optimal && !searchStopped(status,statuses)) return { Status: 'No solution' };
        // A timeout without a feasible incumbent must never be treated as a production plan.
        if (model.info.get('primal_solution_status') !== highs.constants.solutionStatus.feasible) {
            return { Status: 'No solution' };
        }
        const solution = model.getSolution();
        const objective = model.getObjectiveValue();
        const integerModel = /\nGeneral\n\s*x\d/.test(problem.lp);
        // HiGHS also reports optimal when the requested relative gap is met.
        // Later priorities need the actual dual bound until the gap closes.
        const dual = integerModel && (status !== statuses.optimal || options.mip_rel_gap > 0)
            ? model.info.get('mip_dual_bound') : undefined;
        const rounding = 32 * Number.EPSILON * Math.max(1, Math.abs(objective));
        const openGap = status === statuses.optimal && integerModel && options.mip_rel_gap > 0
            && (!Number.isFinite(dual) || Math.abs(dual - objective) > rounding);
        return {
            Status: openGap ? 'Gap target reached' : status === statuses.optimal ? 'Optimal'
                : status === statuses.timeLimit ? 'Time limit reached' : 'Search limit reached',
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
export function polishSolution(highs, problem, result) {
    if (!result?.values || result.values.length !== problem.variables) return result;
    const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    if (!section) return result;
    const integers = [...section[1].matchAll(/\bx(\d+)\b/g)].map(m=>Number(m[1]));
    if (!integers.every(v=>Number.isFinite(result.values[v]) && Math.abs(result.values[v]-Math.round(result.values[v]))<=1e-7)) return result;
    const fixed = integers.map(v=>` final_fix_${v}: x${v} = ${Math.round(result.values[v])}`).join('\n');
    const lp = problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`).replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd');
    const refined = highs.solve(lp,{primal_feasibility_tolerance:1e-10,dual_feasibility_tolerance:1e-10});
    if (refined.Status !== 'Optimal' || !Number.isFinite(refined.ObjectiveValue) || !refined.Columns) return result;
    const values = Array.from({length:problem.variables},(_,i)=>refined.Columns['x'+i]?.Primal ?? 0);
    if (!integers.every(v=>Math.abs(values[v]-Math.round(values[v]))<=1e-7)) return result;
    const objective = refined.ObjectiveValue+(problem.tiebreak || []).reduce((sum,[v,w])=>sum+w*values[v],0);
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
