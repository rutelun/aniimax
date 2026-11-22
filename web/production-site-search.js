import {parseLinearLp} from './highs-reuse.js';
import {solveEconomicBound, suggestEconomicScope} from './economic-bound.js';

function recipesWithoutInputs(problem) {
    const rows = parseLinearLp(problem.lp, problem.variables)?.rows;
    if (!rows) return null;
    const recipes = new Map(problem.recipe_options.map(([column, name]) => [column, name]));
    const sources = new Set(recipes.values());
    for (const {coefficients} of rows) {
        if (!coefficients.every(([v]) => recipes.has(v) || problem.variable_keys[v].startsWith('sold:'))) continue;
        if (!coefficients.some(([v, c]) => recipes.has(v) && c > 0)) continue;
        for (const [v, c] of coefficients) {
            if (c < 0 && recipes.has(v)) sources.delete(recipes.get(v));
        }
    }
    return [...sources];
}

function fixSiteCounts(full, proposal) {
    const sites = new Map(proposal.keys.map((key, i) => [key, proposal.values[i]]));
    const rows = full.recipe_variables.flatMap(([v]) => {
        const key = full.variable_keys[v];
        return key.startsWith('units:') ? [` selected_site_${v}: x${v} = ${Math.round(sites.get(key) ?? 0)}`] : [];
    });
    return {...full, lp:full.lp.replace('\nBounds\n', '\n' + rows.join('\n') + '\nBounds\n')};
}

// Keep every recipe and climate constraint in the search. Introduce the
// continuous-operation constraints for competing recipes as their rates reveal
// contention. Each relaxation bounds income; only the full model can earn it.
export async function searchProductionSites(highs, raw, full, scopedModel, solve = (p,o)=>solveEconomicBound(highs,p,o)) {
    let scope = recipesWithoutInputs(raw);
    if (!scope) return null;
    let seed;
    let upper = Infinity;
    let best;
    for (let round = 0; round < 5; round++) {
        const model = scope.length ? scopedModel(scope) : raw;
        // The standard full-plan effort prices alternative site counts on each relaxation.
        const proposal = await solve(model, {seed, timeLimit:30});
        if (Number.isFinite(proposal?.upper)) upper = Math.min(upper, proposal.upper);
        if (!proposal?.values) break;
        const checked = await solve(fixSiteCounts(full, proposal), {timeLimit:1});
        if (checked?.objective > (best?.objective ?? 0)) best = checked;
        if (best && Math.abs(upper - best.objective) <= 1e-8 * Math.max(1, best.objective)) break;
        let next = suggestEconomicScope(model, proposal.values, scope);
        if (next.length === scope.length) {
            next = [...new Set([...scope, ...proposal.occupiedRecipes, ...proposal.activeRecipes])];
        }
        if (next.length === scope.length) break;
        scope = next;
        seed = proposal;
    }
    if (!best || !Number.isFinite(upper) || upper < best.objective - 1e-7) return null;
    return {best, upper:Math.max(best.objective, upper)};
}
