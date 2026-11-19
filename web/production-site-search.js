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

function relaxCoverage(problem) {
    const climate = new Set(problem.variable_keys.flatMap((key, v) => /^(environment|pair):/.test(key) ? [v] : []));
    if (!climate.size) return problem;
    const [head, rest] = problem.lp.split('\nSubject To\n');
    const [body, bounds] = rest.split('\nBounds\n');
    const kept = body.split('\n').filter(row => {
        for (const match of row.matchAll(/\bx(\d+)/g)) {
            if (climate.has(Number(match[1]))) return false;
        }
        return true;
    });
    return {...problem, lp:head + '\nSubject To\n' + kept.join('\n') + '\nBounds\n' + bounds};
}

function fixSiteCounts(full, proposal) {
    const sites = new Map(proposal.keys.map((key, i) => [key, proposal.values[i]]));
    const rows = full.recipe_variables.flatMap(([v]) => {
        const key = full.variable_keys[v];
        return key.startsWith('units:') ? [` selected_site_${v}: x${v} = ${Math.round(sites.get(key) ?? 0)}`] : [];
    });
    return {...full, lp:full.lp.replace('\nBounds\n', '\n' + rows.join('\n') + '\nBounds\n')};
}

// Removing coverage and recipe constraints gives a global upper bound. Fixing a
// proposed site pattern in the complete model only gives a feasible lower bound.
export function searchProductionSites(highs, raw, full, scopedModel) {
    let scope = recipesWithoutInputs(raw);
    if (!scope) return null;
    let upper = Infinity;
    let best;
    for (let round = 0; round < 5; round++) {
        const model = scope.length ? scopedModel(scope) : raw;
        const proposal = solveEconomicBound(highs, relaxCoverage(model), {timeLimit:4});
        if (Number.isFinite(proposal?.upper)) upper = Math.min(upper, proposal.upper);
        if (!proposal?.values) break;
        const checked = solveEconomicBound(highs, fixSiteCounts(full, proposal), {timeLimit:1});
        if (checked?.values && (!best || checked.objective > best.objective)) best = checked;
        if (best && Math.abs(upper - best.objective) <= 1e-8 * Math.max(1, best.objective)) break;
        const next = suggestEconomicScope(model, proposal.values, scope);
        if (next.length === scope.length) {
            for (const name of proposal.activeRecipes) if (!next.includes(name)) next.push(name);
        }
        if (next.length === scope.length) break;
        scope = next;
    }
    if (!best || !Number.isFinite(upper) || upper < best.objective - 1e-7) return null;
    return {best, upper:Math.max(best.objective, upper)};
}
