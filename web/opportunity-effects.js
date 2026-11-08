import {availableRecipes} from './opportunity-comparison.js?v=protected-comparisons';

const count = tiers => (tiers || []).reduce((n,t)=>n+t.count,0);
const capacity = (input,recipe) => (input.facilities?.[recipe.facility] || [])
    .filter(t=>t.level >= (recipe.facility_level || 1)).reduce((n,t)=>n+t.count,0);

// Explain what changes before solving. Static omissions require an unchanged usable
// recipe set/capacity; an idle job or a small observed gain is never a pruning proof.
export function opportunityEffect(base, candidate, recipes, plan = {}) {
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
        const produced = after.filter(r=>r.facility===facility);
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
    return {lines,skip};
}

export function prepareOpportunities(base, candidates, recipes, plan) {
    const kept = [], omitted = [];
    for (const candidate of candidates) {
        const effect = opportunityEffect(base,candidate,recipes,plan);
        (effect.skip ? omitted : kept).push({...candidate,effect});
    }
    return {candidates:kept,omitted};
}

export function startedProcessing(before, after) {
    const active = plan => (plan?.coin_items || []).filter(step=>step.status==='producing' && !step.is_grower
        && step.item_name && step.cycle_time>0 && (step.busy_units ?? step.facility_count)/step.cycle_time>1e-9)
        .map(step=>step.item_name.replace(/^quick_/,''));
    const existing = new Set(active(before));
    return [...new Set(active(after))].filter(name=>!existing.has(name));
}
