import {availableRecipes} from './opportunity-comparison.js?v=protected-comparisons';

const count = tiers => (tiers || []).reduce((n,t)=>n+t.count,0);
const capacity = (input,recipe) => (input.facilities?.[recipe.facility] || [])
    .filter(t=>t.level >= (recipe.facility_level || 1)).reduce((n,t)=>n+t.count,0);
const itemName = name => name.replace(/^quick_/, '');

function activeProduction(plan, recipes) {
    const byName = new Map(recipes.map(recipe => [recipe.name, recipe]));
    return (plan?.coin_items || []).flatMap(step => {
        if (step.status !== 'producing' || !step.item_name || !(step.cycle_time > 0)) return [];
        const rate = (step.busy_units ?? step.facility_count) / step.cycle_time;
        return rate > 1e-9 ? [{ step, rate, recipe: byName.get(step.item_name) }] : [];
    });
}

function allocatedIngredients(plan, recipes) {
    const produced = new Map(), consumed = new Map();
    const add = (rates, name, rate) => {
        const key = itemName(name);
        rates.set(key, (rates.get(key) || 0) + rate);
    };
    for (const { rate, recipe } of activeProduction(plan, recipes)) {
        if (!recipe) return new Set();
        add(produced, recipe.name, rate * (recipe.yieldAmount ?? recipe.yield_amount ?? 1));
        if (recipe.byproduct && recipe.byproductAmount) add(produced, recipe.byproduct, rate * recipe.byproductAmount);
        (recipe.ingredients || recipe.raw_materials || []).forEach((ingredient, i) =>
            add(consumed, ingredient, rate * (recipe.amounts?.[i] ?? recipe.required_amount?.[i] ?? 1)));
    }
    return new Set([...produced].filter(([name, rate]) =>
        rate > 1e-9 && (consumed.get(name) || 0) >= rate - Math.max(1e-9, rate * 1e-6)).map(([name]) => name));
}

// Explain what changes before solving. Static omissions require an unchanged usable
// recipe set/capacity; an idle job or a small observed gain is never a pruning proof.
export function opportunityEffect(base, candidate, recipes, plan = {}, allocated = allocatedIngredients(plan, recipes)) {
    const input = candidate.input;
    const before = availableRecipes(base,recipes), after = availableRecipes(input,recipes);
    const known = new Set(before.map(r=>r.name));
    const unlocked = after.filter(r=>!known.has(r.name)).map(r=>r.name);
    const sameRecipes = before.length===after.length && !unlocked.length;
    // For pruning, compare structural eligibility as well as reachability. Even a recipe
    // with missing inputs can change generated worker variants, so do not omit that change.
    const eligible = state => recipes.filter(r=>(!r.season || r.season===state.season) && !state.exclude?.includes(r.name)
        && capacity(state,r)>0 && (!r.module_requirement || (state.modules?.[r.module_requirement[0]] || 0)>=r.module_requirement[1]));
    const eligibleBefore=eligible(base),eligibleAfter=eligible(input),eligibleNames=new Set(eligibleBefore.map(r=>r.name));
    const sameEligible=eligibleBefore.length===eligibleAfter.length&&eligibleAfter.every(r=>eligibleNames.has(r.name));
    const modules = Object.keys(input.modules || {}).filter(name=>input.modules[name] !== base.modules?.[name]);
    const facilities = Object.keys(input.facilities || {}).filter(name=>JSON.stringify(input.facilities[name]) !== JSON.stringify(base.facilities?.[name]));
    const otherChanged = [...new Set([...Object.keys(base),...Object.keys(input)])].some(key=>key!=='modules'&&key!=='facilities'
        && JSON.stringify(base[key])!==JSON.stringify(input[key]));
    const lines = [];
    let skip = null;
    if (!otherChanged && modules.length && !facilities.length && sameRecipes && sameEligible
        && modules.every(name=>['ecological_module','kitchen_module','resource_detector','crafting_module'].includes(name)))
        skip = 'No additional usable recipes at this module level.';
    for (const facility of facilities) {
        const processing = recipes.some(r=>r.facility===facility && (r.raw_materials || r.ingredients || []).length>0);
        if (!otherChanged && !modules.length && facilities.length===1 && processing && !eligibleAfter.some(r=>r.facility===facility)) skip = 'No reachable production chain uses this facility.';
        const oldCount = count(base.facilities[facility]), newCount = count(input.facilities[facility]);
        if (!otherChanged && !modules.length && facilities.length===1 && processing && oldCount === newCount && !base.electricity && !input.electricity && sameRecipes && sameEligible
            && eligibleAfter.filter(r=>r.facility===facility).every(r=>capacity(base,r) === capacity(input,r)))
            skip = 'Usable recipe capacity is unchanged at this level.';
        const assigned = (plan.coin_items || []).filter(s=>s.facility===facility && s.status==='producing')
            .reduce((n,s)=>n+s.facility_count,0);
        if (newCount > oldCount) lines.push({kind:'capacity',facility,assigned,owned:oldCount});
        else if (!unlocked.length && input.electricity) lines.push({kind:'electric',facility});
        else if (!unlocked.length) lines.push({kind:'level',facility});
    }
    if (unlocked.length) lines.unshift({kind:'unlocks',recipes:unlocked});
    const change = candidate.change;
    if (change?.kind === 'ability' || change?.kind === 'personality') {
        const member = input.roster?.members[change.member];
        const compatible = recipe => member && (!recipe.family || recipe.family===member.family)
            && recipe.aniimo && (member.abilities[recipe.aniimo[0]] || 0)>=recipe.aniimo[1];
        const affected = after.filter(recipe=>change.kind==='ability'
            ? compatible(recipe)&&recipe.aniimo[0]===change.ability
                || (recipe.jobs || []).some(([,ability,level])=>ability===change.ability && member?.abilities[ability]>=level)
            : compatible(recipe)&&input.roster.personalities?.[recipe.facility]===change.trait);
        const names = [...new Set(affected.map(r=>r.facility))];
        if (names.length) lines.push({kind:change.kind,ability:change.ability,trait:change.trait,facilities:names});
    }
    const affectedFacilities = new Set(lines.flatMap(line => line.facilities || (line.facility ? [line.facility] : [])));
    for (const facility of affectedFacilities) {
        const inputs = after.filter(recipe => recipe.facility === facility)
            .flatMap(recipe => recipe.ingredients || recipe.raw_materials || []).map(itemName);
        const ingredients = [...new Set(inputs.filter(name => allocated.has(name)))];
        if (ingredients.length) {
            lines.push({ kind: 'allocated', facility, ingredients });
            break;
        }
    }
    return {lines,skip};
}

export function prepareOpportunities(base, candidates, recipes, plan) {
    const kept = [], omitted = [];
    const allocated = allocatedIngredients(plan, recipes);
    for (const candidate of candidates) {
        const effect = opportunityEffect(base,candidate,recipes,plan,allocated);
        (effect.skip ? omitted : kept).push({...candidate,effect});
    }
    return {candidates:kept,omitted};
}

// Describe one recipe that runs faster in the compared plan. Compare output,
// including quick variants and every worker assigned to the same recipe.
export function increasedProcessing(before, after, recipes, effects) {
    const facilities = new Set(effects.flatMap(line => line.facilities || (line.facility ? [line.facility] : [])));
    if (!facilities.size) return null;
    const rates = plan => {
        const output = new Map();
        for (const { step, recipe, rate } of activeProduction(plan, recipes)) {
            if (step.is_grower || !recipe || !facilities.has(step.facility)) continue;
            const item = itemName(step.item_name), key = `${step.facility}|${item}`;
            const entry = output.get(key) || { item, facility: step.facility, rate: 0 };
            entry.rate += rate * (recipe.yieldAmount ?? recipe.yield_amount ?? 1);
            output.set(key, entry);
        }
        return output;
    };
    const old = rates(before);
    let best = null;
    for (const [key, entry] of rates(after)) {
        const previous = old.get(key)?.rate;
        if (!previous || entry.rate - previous <= Math.max(1 / 86400, previous * .001)) continue;
        if (!best || entry.rate - previous > best.after - best.before) {
            best = { item: entry.item, facility: entry.facility, before: previous, after: entry.rate };
        }
    }
    return best;
}

export function startedProcessing(before, after) {
    const active = plan => (plan?.coin_items || []).filter(step=>step.status==='producing' && !step.is_grower
        && step.item_name && step.cycle_time>0 && (step.busy_units ?? step.facility_count)/step.cycle_time>1e-9)
        .map(step=>step.item_name.replace(/^quick_/,''));
    const existing = new Set(active(before));
    return [...new Set(active(after))].filter(name=>!existing.has(name));
}
