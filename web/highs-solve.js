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
            Columns: Object.fromEntries(names.map((name, i) => [name, { Primal: solution.colValue[i] }])),
        };
    } finally {
        model.dispose();
    }
}
