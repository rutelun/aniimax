// The native column order follows the LP parser, not the x0/x1/... numbering. Map names
// before supplying an incumbent, and dispose every native model even on a failed solve.
export function solveWithIncumbent(highs, problem, options, incumbent) {
    const model = highs.createModel({ format: 'lp', data: problem.lp });
    try {
        model.options.set(options);
        const names = Array.from({ length: model.getDimensions().numCols }, (_, i) => model.getColName(i));
        if (incumbent?.length === problem.variables) {
            const values = names.map(name => incumbent[Number(name.slice(1))] ?? 0);
            if (values.every(Number.isFinite)) model.setSolution({ colValue: values });
        }
        model.run();
        const status = model.getModelStatus();
        const statuses = highs.constants.modelStatus;
        if (status === statuses.infeasible) return { Status: 'Infeasible' };
        if (status !== statuses.optimal && status !== statuses.timeLimit) return { Status: 'No solution' };
        // A timeout without a feasible incumbent must never be treated as a production plan.
        if (model.info.get('primal_solution_status') !== highs.constants.solutionStatus.feasible) {
            return { Status: 'No solution' };
        }
        const solution = model.getSolution();
        return {
            Status: status === statuses.optimal ? 'Optimal' : 'Time limit reached',
            ObjectiveValue: model.getObjectiveValue(),
            UpperBound: status === statuses.optimal ? model.getObjectiveValue()
                : /\nGeneral\n\s*x\d/.test(problem.lp) ? model.info.get('mip_dual_bound') : undefined,
            Columns: Object.fromEntries(names.map((name, i) => [name, { Primal: solution.colValue[i] }])),
        };
    } finally {
        model.dispose();
    }
}

// A MIP's feasibility tolerance is looser than the independent native check. Refit just
// its continuous rates with the selected whole buildings/workplaces fixed. This cheap LP
// avoids restarting the much slower native simplex solely to repair MIP rounding noise.
// It supplies no new global proof, and the native bounds/flow/workplace checks still run.
export function polishSolution(highs, problem, result, timeLimit = .5) {
    if (!result?.values || result.values.length !== problem.variables) return result;
    const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    if (!section) return result;
    const integers = [...section[1].matchAll(/\bx(\d+)\b/g)].map(m=>Number(m[1]));
    if (!integers.every(v=>Number.isFinite(result.values[v]) && Math.abs(result.values[v]-Math.round(result.values[v]))<=1e-7)) return result;
    const fixed = integers.map(v=>` final_fix_${v}: x${v} = ${Math.round(result.values[v])}`).join('\n');
    const lp = problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`).replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd');
    const refined = highs.solve(lp,{time_limit:timeLimit,primal_feasibility_tolerance:1e-10,dual_feasibility_tolerance:1e-10});
    if (refined.Status !== 'Optimal' || !Number.isFinite(refined.ObjectiveValue) || !refined.Columns) return result;
    const values = Array.from({length:problem.variables},(_,i)=>refined.Columns['x'+i]?.Primal ?? 0);
    if (!integers.every(v=>Math.abs(values[v]-Math.round(values[v]))<=1e-7)) return result;
    const objective = refined.ObjectiveValue+(problem.tiebreak || []).reduce((sum,[v,w])=>sum+w*values[v],0);
    return {...result,values,objective};
}
