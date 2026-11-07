// Fast comparisons use the same model and checker as planning. Only their search budget is
// smaller. A continuous upper bound can certify an earlier goal without another integer search;
// the completed plan must still meet that goal and pass the native independent check.
export function createComparisonSearch(basePlan, solve, { detailed = false, now = () => performance.now() } = {}) {
    const cache = new Map();
    let cacheSize = 0, deadline = Infinity, useBounds = true, usedBounds = false;
    const stats = { cached: 0, bounded: 0 };
    const options = { mip_rel_gap: 0, time_limit: detailed ? 30 : 1 };
    const run = async (problem, requested = options, message, incumbent) => {
        const key = `${problem.variables}|${requested.mip_feasibility_tolerance ?? 'default'}|${JSON.stringify(problem.tiebreak || [])}|${problem.lp}`;
        if (cache.has(key)) { stats.cached++; return cache.get(key); }
        const remaining = (deadline - now()) / 1000;
        if (remaining <= 0) throw new Error('Quick check reached its time budget. Use Detailed search for this alternative.');
        const result = await solve(problem, { ...requested, time_limit: Math.min(requested.time_limit ?? options.time_limit, remaining) }, message, incumbent);
        // Never cache a timeout as an optimum, and bound memory for large homeland models.
        if (result?.proven && key.length <= 8_000_000) {
            while (cacheSize + key.length > 8_000_000 && cache.size) {
                const oldest = cache.keys().next().value;
                cacheSize -= oldest.length; cache.delete(oldest);
            }
            cache.set(key, result); cacheSize += key.length;
        }
        return result;
    };
    const goalValue = goal => {
        const goals = basePlan.comparison_goals;
        if (goal === 'crop_variety') return goals?.crop_variety;
        if (goal === 'level_up') return goals?.pace;
        return goals?.floors?.find(([name])=>name===goal)?.[1];
    };
    return {
        options, solve: run, stats,
        begin() { deadline = detailed ? Infinity : now() + 8_000; useBounds = true; usedBounds = false; },
        get usedBounds() { return usedBounds; },
        disableBounds() { useBounds = false; },
        async bound(problem, goal) {
            if (!useBounds) return null;
            const expected = goalValue(goal);
            if (!Number.isFinite(expected) || !problem.primary_objective?.length) return null;
            const objective = problem.primary_objective.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
            const relaxed = { ...problem, tiebreak: [], lp: problem.lp
                .replace(/Maximize\n[\s\S]*?\nSubject To\n/, `Maximize\n obj: ${objective}\nSubject To\n`)
                .replace(/\nGeneral\n[\s\S]*\nEnd/, '\nEnd') };
            const bound = await run(relaxed, { ...options, time_limit: .3 });
            if (!bound?.proven) return null;
            const upper = goal === 'crop_variety' ? Math.floor(bound.objective + 1e-7) : bound.objective;
            if (Math.abs(upper - expected) > Math.max(1e-9, Math.abs(expected)*1e-7)) return null;
            stats.bounded++;
            usedBounds = true;
            return { objective: expected, proven: true };
        },
    };
}
