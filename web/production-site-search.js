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

function siteAssignment(proposal) {
    return proposal.keys.flatMap((key, i) => key.startsWith('units:') && proposal.values[i] > 0
        ? [[key, proposal.values[i]]] : []);
}

function fixSiteCounts(full, assignment) {
    const sites = new Map(assignment);
    const rows = full.recipe_variables.flatMap(([v]) => {
        const key = full.variable_keys[v];
        return key.startsWith('units:') ? [` selected_site_${v}: x${v} = ${Math.round(sites.get(key) ?? 0)}`] : [];
    });
    return {...full, lp:full.lp.replace('\nBounds\n', '\n' + rows.join('\n') + '\nBounds\n')};
}

// A relaxed recipe mix can already earn its ceiling once its whole buildings
// trade staffed and electric modes. Fix the total batches of each recipe in
// the full model and let its work-conservation and climate rows choose the sites.
function fixRecipeRates(full, proposal) {
    const rates = new Map(proposal.keys.map((key, i) => [key, proposal.values[i]]));
    const groups = new Map();
    for (const [v, name, facility] of full.recipe_options) {
        const rate = rates.get(full.variable_keys[v]);
        if (!Number.isFinite(rate) || rate < -1e-8) return null;
        const key = JSON.stringify([facility, name]);
        if (!groups.has(key)) groups.set(key, {variables:[], total:0});
        const group = groups.get(key);
        group.variables.push(v);
        group.total += Math.max(0, rate);
    }
    const rows = [...groups.values()].map(({variables, total}, i) =>
        ` selected_rate_${i}: ${variables.map(v => 'x' + v).join(' + ')} = ${total}`);
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
        const checked = await solve(fixSiteCounts(full, siteAssignment(proposal)), {timeLimit:1});
        if (checked?.objective > (best?.objective ?? 0)) best = checked;
        if (best && Math.abs(upper - best.objective) <= 1e-8 * Math.max(1, best.objective)) break;
        if (round === 0 && proposal.objective > 0 && Math.abs(upper - proposal.objective) <= 1e-8 * Math.max(1, upper)) {
            const fixedRates = fixRecipeRates(full, proposal);
            const fitted = fixedRates && await solve(fixedRates, {timeLimit:1});
            if (fitted?.values && Math.abs(upper - fitted.objective) <= 1e-8 * Math.max(1, upper)) {
                best = fitted;
                break;
            }
        }
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

// A generated team's dedicated workshop counts are feasible in the model
// that lets both workshops share staffed or electric capacity. Its income
// ceiling therefore also bounds each individual scheduling choice. Only
// the bound and a proposed site assignment travel to sibling workers.
export async function fitWorkshopIncome(highs, proof, full, broadModel, solve) {
    if (proof.assignment === undefined) {
        const result = await searchProductionSites(highs, broadModel([]), broadModel(), broadModel, solve);
        proof.assignment = result ? siteAssignment(result.best) : null;
        proof.upper = result?.upper;
    }
    if (!proof.assignment || !Number.isFinite(proof.upper)) return null;
    const best = await solve(fixSiteCounts(full, proof.assignment), {exact:true});
    if (!best?.values || !Number.isFinite(best.objective)
        || Math.abs(best.objective - proof.upper) > 1e-8 * Math.max(1, Math.abs(proof.upper))) return null;
    return {best, upper:Math.max(best.objective, proof.upper)};
}
