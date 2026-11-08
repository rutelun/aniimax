// Fast comparisons use the same model and checker as planning. Only their search budget is
// smaller. A continuous upper bound can certify an earlier goal without another integer search;
// the completed plan must still meet that goal and pass the native independent check.
import {comparePlans} from './opportunity-comparison.js?v=protected-comparisons';

export function createComparisonSearch(basePlan, solve, { detailed = false, warmStart = true, now = () => performance.now() } = {}) {
    const cache = new Map();
    let cacheSize = 0, deadline = Infinity, useBounds = true, usedBounds = false, earlierImproved = false;
    const stats = { cached: 0, bounded: 0, warm: 0, polished: 0 };
    const profile = basePlan.comparison_seed;
    // Building/parsing a large roster model is outside HiGHS' per-solve limit. Allow that
    // overhead; the one-second integer searches remain bounded independently.
    const quickBudgetMs = 8_000 + Math.min(16_000, (profile?.keys?.length || 0) * 2);
    const seedByKey = warmStart && Array.isArray(profile?.keys) && profile.keys.length === profile?.values?.length
        ? new Map(profile.keys.map((key,i)=>[key,profile.values[i]])) : null;
    const options = { mip_rel_gap: 0, time_limit: detailed ? 30 : 1 };
    const run = async (problem, requested = options, message, incumbent) => {
        const key = `${problem.variables}|${requested.mip_feasibility_tolerance ?? 'default'}|${JSON.stringify(problem.tiebreak || [])}|${problem.lp}`;
        if (cache.has(key)) { stats.cached++; return cache.get(key); }
        const remaining = (deadline - now()) / 1000;
        if (remaining <= 0) throw new Error('Quick check reached its time budget. Use Detailed search for this alternative.');
        let seed = incumbent;
        if (seed?.length !== problem.variables && seedByKey && problem.variable_keys?.length === problem.variables
            && /\nGeneral\n\s*x\d/.test(problem.lp)) {
            seed = problem.variable_keys.map(key=>seedByKey.get(key) ?? 0);
            stats.warm++;
            // Refit continuous production/work times to the changed worker while keeping
            // the baseline's discrete placement. This is only a feasible start; the complete
            // unrestricted integer model below still has to find/prove the final optimum.
            const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
            const integers = [...(section?.[1] || '').matchAll(/\bx(\d+)\b/g)].map(m=>Number(m[1]));
            const fixed = integers.map(v=>` warm_fix_${v}: x${v} = ${Math.round(seed[v])}`).join('\n');
            const local = {...problem,lp:problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`)
                .replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd')};
            const remaining = (deadline-now())/1000;
            if (remaining > .05) {
                const polished = await solve(local,{...requested,time_limit:Math.min(.3,remaining)},undefined,seed);
                if (polished?.values && integers.every(v=>Math.abs(polished.values[v]-Math.round(polished.values[v]))<1e-6)) {
                    seed = polished.values; stats.polished++;
                }
            }
        }
        const left = (deadline-now())/1000;
        if (left <= 0) throw new Error('Quick check reached its time budget. Use Detailed search for this alternative.');
        const result = await solve(problem, { ...requested, time_limit: Math.min(requested.time_limit ?? options.time_limit, left) }, message, seed);
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
        if (goal === (goals?.currency || basePlan.currency || 'coins')) {
            return goals?.currency_value ?? goals?.floors?.find(([name])=>name===goal)?.[1] ?? basePlan.rate_per_second;
        }
        return goals?.floors?.find(([name])=>name===goal)?.[1];
    };
    const objectiveText = problem => problem.primary_objective
        .map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    return {
        options, solve: run, stats,
        inconclusive(plan, beforeInput, afterInput) {
            return comparePlans(basePlan, plan, beforeInput, afterInput).inconclusiveLoss;
        },
        begin() { deadline = detailed ? Infinity : now() + quickBudgetMs; useBounds = true; usedBounds = false; earlierImproved = false; },
        get usedBounds() { return usedBounds; },
        disableBounds() { useBounds = false; },
        protect(problem, goal) {
            const expected = goalValue(goal);
            if (detailed || earlierImproved || !(expected > 0) || !problem.primary_objective?.length) return problem;
            // A one-second search must not redefine the baseline downward. A matching
            // incumbent is not necessarily found in time; then this comparison is unknown.
            // Use the planner's own floor tolerance, including for scores and RV pace.
            const floor = goal === 'crop_variety' ? expected : expected * (1 - 1e-4);
            return { ...problem, lp: problem.lp.replace('\nBounds\n',
                `\n comparison_baseline: ${objectiveText(problem)} >= ${floor}\nBounds\n`) };
        },
        observe(goal, result) {
            const expected = goalValue(goal);
            if (Number.isFinite(expected) && result?.objective > expected + Math.max(1e-8, Math.abs(expected)*1e-3)) {
                earlierImproved = true;
            }
        },
        async bound(problem, goal) {
            // Coins need a feasible vector for the final plan, not only an objective bound.
            if (!useBounds || goal === (basePlan.currency || 'coins')) return null;
            const expected = goalValue(goal);
            if (!Number.isFinite(expected) || !problem.primary_objective?.length) return null;
            const objective = objectiveText(problem);
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
