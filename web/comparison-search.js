// Fast comparisons use the same model and checker as planning. Only their search budget is
// smaller. A continuous upper bound can certify an earlier goal without another integer search;
// the completed plan must still meet that goal and pass the native independent check.
import {comparePlans} from './opportunity-comparison.js?v=income-aware-chains';

function integerColumns(problem) {
    const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    return [...(section?.[1] || '').matchAll(/\bx(\d+)\b/g)].map(match => Number(match[1]));
}

function respectsIntegrality(result, problem, integers) {
    return result?.proven && result.values?.length === problem.variables
        && integers.every(v => Math.abs(result.values[v] - Math.round(result.values[v])) <= 1e-7);
}

export function createComparisonSearch(basePlan, solve, {
    detailed = false, warmStart = true, baseInput = null, now = () => performance.now(),
    memo = { entries: new Map(), size: 0 },
} = {}) {
    const cache = memo.entries;
    let deadline = Infinity, useBounds = true, usedBounds = false, earlierImproved = false;
    let splitMembers = new Set();
    const stats = { cached: 0, bounded: 0, warm: 0, polished: 0, certified: 0 };
    const profile = basePlan.comparison_seed;
    // Building/parsing a large roster model is outside HiGHS' per-solve limit. Allow that
    // overhead; the one-second integer searches remain bounded independently.
    const quickBudgetMs = 8_000 + Math.min(16_000, (profile?.keys?.length || 0) * 2);
    const seedByKey = warmStart && Array.isArray(profile?.keys) && profile.keys.length === profile?.values?.length
        ? new Map(profile.keys.map((key,i)=>[key,profile.values[i]])) : null;
    const options = { mip_rel_gap: 0, time_limit: detailed ? 30 : 1 };
    const clipInactive = (problem,values) => {
        const zero = [...problem.lp.matchAll(/^ 0 <= x(\d+) <= 0$/gm)].map(m=>Number(m[1]));
        if (!zero.some(v=>values[v] !== 0)) return values;
        const clipped = [...values]; zero.forEach(v=>clipped[v]=0); return clipped;
    };
    const run = async (problem, requested = options, message, incumbent) => {
        const tolerances = [requested.mip_feasibility_tolerance, requested.primal_feasibility_tolerance,
            requested.dual_feasibility_tolerance];
        const key = `${problem.variables}|${JSON.stringify(tolerances)}|${JSON.stringify(problem.tiebreak || [])}|${problem.lp}`;
        if (cache.has(key)) { stats.cached++; return cache.get(key); }
        const remaining = (deadline - now()) / 1000;
        if (remaining <= 0) throw new Error('Quick check reached its time budget. Use Detailed search for this alternative.');
        let seed = incumbent;
        const mapped = seedByKey && problem.variable_keys?.length === problem.variables
            && /\nGeneral\n\s*x\d/.test(problem.lp) ? clipInactive(problem,problem.variable_keys.map(key=>seedByKey.get(key) ?? 0)) : null;
        const value = values => (problem.primary_objective || []).reduce((sum,[v,c])=>sum+c*(values[v]||0),0);
        if (mapped && (seed?.length !== problem.variables || (!earlierImproved && value(mapped)>value(seed)+1e-9))) {
            seed = mapped;
            stats.warm++;
            // Refit continuous production/work times to the changed worker while keeping
            // the baseline's discrete placement. This is only a feasible start; the complete
            // unrestricted integer model below still has to find/prove the final optimum.
            const integers = integerColumns(problem);
            // Training one of several identical Aniimo splits that pool. Its old discrete
            // assignments may exceed the remaining count; repair only the split members,
            // retaining all other baseline choices as a small initial subproblem.
            const flexible = new Set(integers.filter(v=>[...(problem.variable_keys[v] || '').matchAll(/owned:(\d+)/g)]
                .some(m=>splitMembers.has(Number(m[1])))));
            const fixed = integers.filter(v=>!flexible.has(v)).map(v=>` warm_fix_${v}: x${v} = ${Math.round(seed[v])}`).join('\n');
            const local = {...problem,lp:problem.lp.replace('\nBounds\n',`\n${fixed}\nBounds\n`)
                .replace(/\nGeneral\n[\s\S]*\nEnd/,flexible.size ? `\nGeneral\n${[...flexible].map(v=>` x${v}`).join('\n')}\nEnd` : '\nEnd')};
            const remaining = (deadline-now())/1000;
            if (remaining > .05) {
                const polished = await solve(local,{...requested,time_limit:Math.min(flexible.size ? 1 : .3,remaining)},undefined,seed);
                if (polished?.values && integers.every(v=>Math.abs(polished.values[v]-Math.round(polished.values[v]))<1e-6)) {
                    seed = polished.values; stats.polished++;
                }
                if (problem.compareCurrency && respectsIntegrality(polished, problem, integers)) {
                    const left = (deadline - now()) / 1000;
                    if (left > .1) {
                        const relaxed = { ...problem, lp: problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/, '\nEnd') };
                        const upper = await solve(relaxed, { ...requested, time_limit: Math.min(.25, left) });
                        if (upper?.proven && Math.abs(upper.objective - polished.objective) <= 1e-9) {
                            stats.certified++;
                            return { ...polished, upper: upper.objective };
                        }
                        if (respectsIntegrality(upper, problem, integers)) {
                            stats.certified++;
                            return upper;
                        }
                    }
                }
            }
        }
        if (seed?.length === problem.variables) seed = clipInactive(problem,seed);
        const left = (deadline-now())/1000;
        if (left <= 0) throw new Error('Quick check reached its time budget. Use Detailed search for this alternative.');
        const result = await solve(problem, { ...requested, time_limit: Math.min(requested.time_limit ?? options.time_limit, left) }, message, seed);
        // Never cache a timeout as an optimum, and bound memory for large homeland models.
        if (result?.proven && key.length <= 8_000_000) {
            while (memo.size + key.length > 8_000_000 && cache.size) {
                const oldest = cache.keys().next().value;
                memo.size -= oldest.length; cache.delete(oldest);
            }
            cache.set(key, result); memo.size += key.length;
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
        begin(input) {
            deadline = detailed ? Infinity : now() + quickBudgetMs; useBounds = true; usedBounds = false; earlierImproved = false;
            const before=baseInput?.roster?.members,after=input?.roster?.members;
            splitMembers=new Set();
            if (before && after?.length === before.length+1 && after.at(-1).count === 1) {
                before.forEach((m,i)=>{if(m.count>1 && after[i].count===m.count-1)splitMembers.add(i);});
                if(splitMembers.size)splitMembers.add(before.length);
            }
        },
        get usedBounds() { return usedBounds; },
        disableBounds() { useBounds = false; },
        protect(problem, goal) {
            const expected = goalValue(goal);
            if (detailed || earlierImproved || !(expected > 0) || !problem.primary_objective?.length) return problem;
            // A one-second search must not redefine the baseline downward. A matching
            // incumbent is not necessarily found in time; then this comparison is unknown.
            // Use the planner's own floor tolerance, including for scores and RV pace.
            const floor = goal === 'crop_variety' ? expected : expected * (1 - 1e-4);
            return { ...problem, compareCurrency: problem.production_only && goal === (basePlan.currency || 'coins'),
                lp: problem.lp.replace('\nBounds\n',
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
            if (Math.abs(upper - expected) > Math.max(1e-9, Math.abs(expected)*1e-7)) {
                // Some relaxed optima already use whole buildings. Retain the vector
                // when the original objective has no secondary staffing penalties.
                if (problem.production_only && respectsIntegrality(bound, problem, integerColumns(problem))) {
                    stats.certified++;
                    return bound;
                }
                return null;
            }
            stats.bounded++;
            usedBounds = true;
            return { objective: expected, proven: true };
        },
    };
}
