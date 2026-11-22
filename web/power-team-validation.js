import {physicalPlanPower} from './physical-power.js';
import {scheduleInputForPlan, attachRecipeSchedule} from './recipe-schedule-plan.js';

// The native report supplies the effective worker level, personality and task
// mix. Multiple variants of a crop can share the same report label, so keep
// their individual physical rows when the report cannot identify one match.
function physicalRowsWithCheckedStaff(candidate, checked) {
    const key = row => JSON.stringify([row.facility, row.item_name, row.electric_level ?? null]);
    const nativeRows = new Map(), physicalCounts = new Map();
    for (const row of checked.coin_items ?? []) {
        if (row.status !== 'producing') continue;
        const id = key(row);
        nativeRows.set(id, nativeRows.has(id) ? null : row);
    }
    for (const row of candidate.coin_items) {
        if (row.status !== 'producing') continue;
        const id = key(row);
        physicalCounts.set(id, (physicalCounts.get(id) ?? 0) + 1);
    }
    return candidate.coin_items.map(row => {
        if (row.status !== 'producing') return row;
        const id = key(row), native = nativeRows.get(id);
        return native && physicalCounts.get(id) === 1
            ? {...row, aniimo: native.aniimo, aniimo_tasks: native.aniimo_tasks} : row;
    });
}

// Keep the original shift's sales and climate assignments while checking its
// new electric modes against the native resource, crop and staffing constraints.
export function createPowerTeamValidator(pkg, highs, plan, input) {
    const seed = plan.comparison_seed, goals = plan.comparison_goals;
    if (!seed?.keys || !goals || !plan.schedule_sources?.length) return null;
    const facilities = [...new Set(plan.schedule_sources.filter(s => s.turns).map(s => s.facility))];
    const switching = plan.recipe_schedule ? {
        recipe_switching_relaxation: true, recipe_switching_normal_only: false,
        recipe_switching_facilities: facilities, maximize_material_work: false,
    } : {};
    const payload = JSON.stringify({...input, ...switching,
        always_running_recipes: plan.continuous_checked_recipes,
        restrict_to_checked_recipes: !!plan.continuous_checked_recipes});
    const materialWork = plan.comparison_scores?.material_work;
    const stage = JSON.stringify({floors: goals.floors, pace: goals.pace, crop_variety: goals.crop_variety,
        material_pace: plan.comparison_scores?.material_pace, maximize_material_work: materialWork != null});
    const problem = JSON.parse(pkg.exact_problem(payload, stage));
    if (!problem.recipe_options?.length) return null;
    const keys = problem.variable_keys, generator = keys.indexOf('generators#0');
    if (generator < 0) return null;
    const prior = new Map(seed.keys.map((key, i) => [key, seed.values[i]]));
    const options = new Map(problem.recipe_options.map(option => [keys[option[0]], option]));
    const fixed = (v, value) => ' hold_' + v + ': x' + v + ' = ' + value;
    const retained = keys.flatMap((key, v) => /^(environment:|pair:|crop_variety#|lower_level_plots#|sold:)/.test(key)
        ? [fixed(v, prior.get(key) ?? 0)] : []);

    function validate(candidate) {
        const draw = physicalPlanPower(candidate);
        if (!candidate.schedule_sources?.length || !Number.isInteger(candidate.power_generators)
            || candidate.power_generators < 0 || !Number.isFinite(draw) || !Number.isFinite(candidate.power_used)
            || Math.abs(draw - candidate.power_used) > 1e-6 || !(draw <= candidate.power_generated + 1e-7)) return null;
        const rates = new Map();
        for (const source of candidate.schedule_sources) {
            const option = options.get('rate:' + source.id + '#0');
            if (!option || option[1] !== source.item || option[2] !== source.facility
                || option[4] !== (source.electric_level != null) || !(Math.abs(source.cycle - option[5]) < 1e-7)
                || !Number.isFinite(source.rate) || source.rate < 0) return null;
            rates.set(option[0], (rates.get(option[0]) ?? 0) + source.rate);
        }
        const fixes = [...retained, fixed(generator, candidate.power_generators),
            ...problem.recipe_options.map(([v]) => fixed(v, rates.get(v) ?? 0))];
        const lp = problem.lp.replace('\nBounds\n', '\n' + fixes.join('\n') + '\nBounds\n');
        const result = highs.solve(lp, {mip_feasibility_tolerance: 1e-9, primal_feasibility_tolerance: 1e-9});
        if (result.Status !== 'Optimal' || !result.Columns) return null;
        const values = keys.map((_, v) => result.Columns['x' + v]?.Primal ?? 0);
        const checked = JSON.parse(pkg.exact_plan(payload, stage, JSON.stringify({
            values, verify_only: true, proven: false, bound: plan.upper_bound ?? plan.rate_per_second,
        })));
        if (!checked.success || !(checked.rate_per_second >= plan.rate_per_second - 1e-7)) return null;
        for (const field of ['level_up', 'level_up_preview']) {
            if (plan[field]?.seconds != null && !(checked[field]?.seconds <= plan[field].seconds + 1e-5)) return null;
        }
        const earned = new Map(checked.priorities.map(p => [p.target, p.per_second]));
        if (plan.priorities?.some(p => !(earned.get(p.target) >= p.per_second - 1e-7))) return null;
        if (materialWork != null && problem.primary_objective.reduce((sum, [v, w]) => sum + values[v] * w, 0) < materialWork - 1e-7) return null;
        const physicalRows = physicalRowsWithCheckedStaff(candidate, checked);
        if (candidate.recipe_schedule) {
            // Ordinary mode changes can alter the background jobs that share
            // workers and ingredients with a previously certified chain.
            const schedule = candidate.recipe_schedule;
            try {
                const scheduleInput = {...scheduleInputForPlan(input, {...checked, coin_items: physicalRows}),
                    buildings: schedule.buildings};
                candidate = attachRecipeSchedule(candidate, scheduleInput, schedule);
            } catch {
                return null;
            }
        }
        // The native report can pool whole sites between modes. Retain the
        // checked day schedule's physical sites, power draw and generator tiers.
        const verified = {...candidate, ...checked, coin_items: physicalRows, recipe_schedule: candidate.recipe_schedule,
            power_used: candidate.power_used, power_generated: candidate.power_generated,
            power_generators: candidate.power_generators, power_generator_levels: candidate.power_generator_levels,
            proven_optimal: false, comparison_seed: {keys, values}};
        for (const key of ['continuous_checked_recipes', 'continuous_production_checked', 'continuous_upper_bounds']) {
            if (Object.hasOwn(plan, key)) verified[key] = plan[key];
        }
        verified.active_continuous_recipes = [...new Set(problem.recipe_options.filter(([v]) => values[v] > 1e-9).map(([, item]) => item))];
        if (plan.continuous_site_counts) {
            const counts = new Map();
            for (const [item, terms] of problem.integer_groups ?? []) {
                counts.set(item, (counts.get(item) ?? 0) + terms.reduce((sum, [v, w]) => sum + values[v] * w, 0));
            }
            for (const [v, item] of problem.recipe_variables) {
                if (keys[v].startsWith('continuous_site:')) counts.set(item, (counts.get(item) ?? 0) + values[v]);
            }
            verified.continuous_site_counts = Object.fromEntries([...counts].map(([item, count]) => [item, Math.round(count)]));
        }
        delete verified.recipe_switching_candidate;
        return verified;
    }
    return {problem, validate};
}
