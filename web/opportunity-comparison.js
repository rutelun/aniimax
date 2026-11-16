// Counterfactual inputs are copies: comparisons never edit My Aniimo or saved settings.
export function changeOneMember(input, index, changes) {
    const original = input.roster.members[index];
    const changed = { ...original, ...changes, count: 1 };
    const members = original.count > 1
        ? [...input.roster.members.map((m, i) => i === index ? { ...m, count: m.count - 1 } : m), changed]
        : input.roster.members.map((m, i) => i === index ? changed : m);
    return { ...input, roster: { ...input.roster, members } };
}

export function personalityInput(input, index, personality, pairs) {
    const pair = pairs.find(p => p.names.includes(personality));
    if (!pair) throw new Error('Unknown personality');
    const personalities = (input.roster.members[index].personalities || []).filter(p => !pair.names.includes(p));
    return changeOneMember(input, index, { personalities: [...personalities, personality] });
}

// Only shortlist real forms suited to the jobs most recently assigned to a member.
// The score selects what to check first; it is never displayed as a production gain.
export function replacementCandidates(input, plan, recipes, catalog, pairs, limit = 10) {
    if (!input.roster) return [];
    const { members, personalities = {} } = input.roster;
    const activeMembers = [...members];
    for (const [index, ability, level, count, family] of plan.assumed_aniimo || []) {
        activeMembers[index] = { count, abilities: { [ability]: level }, family, assumed: true };
    }
    const byRecipe = new Map(recipes.map(recipe => [`${recipe.facility}|${recipe.name}`, recipe]));
    const roles = Array.from({ length: activeMembers.length }, () => []);
    const usage = workerUsage(plan, input);
    const add = (member, ability, level, load, trait, family, facility, post = null) => {
        if (roles[member] && ability && load > 0) roles[member].push({ ability, level, load, trait, family, facility, post });
    };
    for (const step of plan.coin_items || []) {
        if (step.status !== 'producing' || step.crew == null || step.electric_level != null) continue;
        const recipe = byRecipe.get(`${step.facility}|${step.item_name}`);
        if (!recipe?.aniimo) continue;
        const [ability, level] = recipe.aniimo;
        add(step.crew, ability, level, step.busy_units ?? step.facility_count,
            personalities[step.facility], recipe.family, step.facility);
    }
    for (const [ability, level, member, load] of plan.crop_assignments || []) add(member, ability, level, load);
    for (const [facility, member, load] of plan.staffing || []) {
        const power = facility === 'Crackle Generator';
        const ability = power ? 'Lightning' : input.roster.environment?.[facility];
        add(member, ability, 1, load, null, null, facility, power ? 'generator' : 'climate');
    }
    for (const [member, load] of [...(plan.delivery_assignments || plan.hauling_staffing || []), ...(plan.dedicated_delivery || [])]) {
        add(member, 'Hauling', 1, load);
    }
    const candidates = [];
    const flexible = new Set(roles.flat().filter(role => !role.post).map(role => role.ability));
    const watts = level => plan.generator_watts_by_lightning?.[level - 1];
    for (const [index, member] of activeMembers.entries()) {
        const work = roles[index];
        if (!work.length || !(member?.count > 0)) continue;
        const hasFlexibleWork = work.some(role => !role.post);
        const runsGenerator = work.some(role => role.post === 'generator');
        const currentWatts = watts(member.abilities.Lightning);
        if (!hasFlexibleWork && (!runsGenerator || !(watts(4) > currentWatts))) continue;
        const traits = new Map();
        for (const role of work) if (role.trait) traits.set(role.trait, (traits.get(role.trait) || 0) + role.load);
        const desired = pairs.map(pair => [...pair.names].sort((a,b) => (traits.get(b) || 0) - (traits.get(a) || 0))[0])
            .filter(trait => traits.has(trait));
        const oldTraits = member.personalities || [];
        const improvement = entry => work.reduce((sum, role) => {
            const level = entry.abilities[role.ability];
            const levels = level - (member.abilities[role.ability] || 0);
            if (role.post === 'climate') return sum;
            if (role.post === 'generator') return sum + (currentWatts > 0 ? role.load * ((watts(level) ?? currentWatts) / currentWatts - 1) : 0);
            const trait = role.trait ? Number(desired.includes(role.trait)) - Number(oldTraits.includes(role.trait)) : 0;
            return sum + role.load * (.2 * levels + .15 * trait);
        }, 0);
        const unique = new Set();
        const options = [];
        for (const entry of catalog) {
            if (!work.every(({ ability, level, family }) => entry.abilities[ability] >= level && (!family || entry.family === family))) continue;
            if (runsGenerator) {
                const next = entry.abilities.Lightning;
                if (currentWatts == null ? next < member.abilities.Lightning : watts(next) < currentWatts) continue;
            }
            if (Object.keys(entry.abilities).length === Object.keys(member.abilities).length
                && Object.entries(entry.abilities).every(([ability, level]) => member.abilities[ability] === level)
                && (entry.family || null) === (member.family || null)) continue;
            const profile = JSON.stringify([Object.entries(entry.abilities).sort(), entry.family || null, desired]);
            if (unique.has(profile)) continue;
            unique.add(profile);
            const extra = hasFlexibleWork ? Object.keys(entry.abilities).filter(a => flexible.has(a) && entry.abilities[a] > (member.abilities[a] || 0)).length : 0;
            const score = improvement(entry) + .04 * extra;
            if (score > 0) options.push({ entry, score });
        }
        options.sort((a, b) => b.score - a.score);
        for (const { entry, score } of options.slice(0, 2)) {
            const replacement = { abilities: entry.abilities, family: entry.family || null, personalities: desired };
            const alternative = member.assumed ? { ...input, roster: { ...input.roster,
                members: [...members, { ...replacement, count: 1 }] } } : changeOneMember(input, index, replacement);
            candidates.push({ index, entry, traits: desired, score: score + .02 * Math.min(1, usage?.busy.get(index) || 0),
                changedMember: member.assumed || member.count > 1 ? members.length : index,
                facilities: [...new Set(work.map(role => role.facility).filter(Boolean))],
                input: alternative });
        }
    }
    return candidates.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Conservative reachability: remove only recipes blocked by a missing building, level,
// module, season, unlock, or an ingredient with no available producer. Never prune a job
// merely because it is idle in the current solution: an upgrade can make it worthwhile.
export function availableRecipes(input, recipes) {
    let available = recipes.filter(r => {
        if (r.season && r.season !== input.season || input.exclude?.includes(r.name)) return false;
        if (!(input.facilities[r.facility] || []).some(t=>t.count>0 && t.level >= (r.facility_level || 1))) return false;
        if (r.module_requirement && (input.modules?.[r.module_requirement[0]] || 0) < r.module_requirement[1]) return false;
        return true;
    });
    let previous;
    const stock = [...(input.level_up?.stock || []), ...(input.level_up_preview?.stock || [])]
        .filter(([,amount])=>amount>0).map(([name])=>name);
    do {
        previous = available.length;
        const made = new Set(available.flatMap(r=>[r.name,
            r.name.startsWith('quick_') ? r.name.slice(6) : r.name,
            r.byproduct_item || r.byproduct]).filter(x=>typeof x==='string'));
        stock.forEach(name=>made.add(name));
        available = available.filter(r=>(r.raw_materials || r.ingredients || []).every(name=>made.has(name)));
    } while (available.length !== previous);
    return available;
}

export function usefulUpgrade(input, change, recipes) {
    if (!change || !recipes.length) return true;
    const available = availableRecipes(input,recipes);
    if (change.kind === 'recipe') return available.some(r=>r.name === change.name);
    const member = input.roster?.members[change.member];
    if (!member) return true;
    const compatible = r => (!r.family || r.family === member.family)
        && r.aniimo && (member.abilities[r.aniimo[0]] || 0) >= r.aniimo[1];
    if (change.kind === 'personality') return available.some(r=>r.workload != null && compatible(r)
        && input.roster.personalities?.[r.facility] === change.trait);
    if (change.kind === 'ability') return available.some(r=>(r.workload != null && compatible(r) && r.aniimo[0] === change.ability)
        || (r.jobs || []).some(([,ability,level])=>ability===change.ability && member.abilities[ability]>=level));
    return true;
}

export function workerUsage(plan, input) {
    if (!input.roster || plan.comparison_workload_valid === false) return null;
    const busy = new Map();
    const anchored = new Map(plan.workplace_anchors || []);
    const add = (member, share) => {
        if (member != null && Number.isFinite(share) && share > 0) busy.set(member, (busy.get(member) || 0) + share);
    };
    const residents = new Set(input.roster.residents || []);
    for (const step of plan.coin_items || []) {
        if (step.crew != null && step.status === 'producing' && residents.has(step.facility)) {
            anchored.set(step.crew, (anchored.get(step.crew) || 0) + step.facility_count);
        }
    }
    for (const [, member, share] of plan.staffing || []) {
        anchored.set(member, (anchored.get(member) || 0) + share);
    }
    if (plan.roster_workload?.length) {
        plan.roster_workload.forEach((share, member) => add(member, share));
    } else {
        for (const step of plan.coin_items || []) if (step.status === 'producing') {
            add(step.crew, residents.has(step.facility) ? step.facility_count : step.busy_units ?? step.facility_count);
        }
        for (const [, member, share] of plan.staffing || []) add(member, share);
        for (const [, , member, share] of plan.crop_assignments || []) add(member, share);
        for (const [member, travel] of plan.movement_staffing || []) add(member, travel);
    }
    for (const [member, share] of plan.layout_walking || []) {
        if (Number.isFinite(share)) busy.set(member, Math.max(0, (busy.get(member) || 0) + share));
    }
    for (const [member, share] of plan.job_switching || []) add(member, share);
    for (const [member, share] of plan.delivery_assignments || plan.hauling_staffing || []) add(member, share);
    const heads = (member, load) => Math.max(anchored.get(member) ?? 0, Math.ceil(load - 1e-6));
    const dedicated = new Map(plan.dedicated_delivery || []);
    const assignments = new Map([...new Set([...busy.keys(), ...dedicated.keys()])].map(member => {
        const regular = heads(member, busy.get(member) || 0), delivery = Math.ceil((dedicated.get(member) || 0) - 1e-6);
        return [member, regular + delivery];
    }));
    const peakOf = ([member, load]) => Math.min(1, Math.max(load / Math.max(1, heads(member, load)),
        (dedicated.get(member) || 0) / Math.max(1, Math.ceil(dedicated.get(member) || 0))));
    const loads = plan.comparison_workloads?.flat().filter(Number.isFinite);
    const peak = loads ? Math.max(0, ...loads) : Math.max(0, ...[...busy].map(peakOf), ...[...dedicated].map(([member]) => peakOf([member, 0])));
    for (const [member, load] of dedicated) add(member, load);
    return { busy, assignments, loads: plan.comparison_workloads, peak, working: [...assignments.values()].reduce((n, count) => n + count, 0),
        additional: [...assignments].filter(([i]) => i >= input.roster.members.length).reduce((n, [, count]) => n + count, 0),
        hours: [...busy.values()].reduce((n, b) => n + b * 24, 0) };
}

export function reserveLevelFourInputs(input, plan, cap = () => 4) {
    if (!input.roster) return [];
    const used = new Set((plan.coin_items || []).filter(s => s.status === 'producing').map(s => s.crew));
    for (const [, , member, share] of plan.crop_assignments || []) if (share > 1e-9) used.add(member);
    // Staffing a generator/climate building alone never benefits from a higher ability level.
    return (plan.assumed_aniimo || []).filter(([i, ability, level]) => used.has(i) && level < 4 && cap(ability) >= 4 && ability !== 'Hauling')
        .map(([, ability, , , family]) => ({ ability, family,
            input: { ...input, roster: { ...input.roster, members: [...input.roster.members,
                { count: 1, abilities: { [ability]: 4 }, personalities: [], family: family || null }] } } }));
}

const rateOf = (plan, target) => target === 'coins' ? plan.rate_per_second || 0
    : target === 'season_points' ? plan.season_points || 0
    : plan.priorities?.find(p => p.target === target)?.per_second || 0;
const reportOf = plan => plan.level_up || plan.level_up_preview;

function direction(before, after, lower, kind) {
    if (before == null || after == null) {
        if (kind !== 'duration' || before === after) return 0;
        return before == null ? 1 : -1;
    }
    const tolerance = kind === 'count' ? .5 : Math.max(1e-8, Math.abs(before) * 1e-3);
    if (Math.abs(after - before) <= tolerance) return 0;
    return (after > before ? 1 : -1) * (lower ? -1 : 1);
}

// Preserve the optimizer's ordering. A gain in a lower priority cannot hide a loss above it.
export function comparePlans(beforePlan, afterPlan, beforeInput, afterInput = beforeInput) {
    const rows = [], objectives = [];
    const add = (id, kind, before, after, lower = false, objective = false) => {
        const row = { id, kind, before, after, lower, direction: direction(before, after, lower, kind) };
        rows.push(row);
        if (objective) objectives.push(row);
        return row;
    };
    const score = (name, kind = 'score') => {
        const before = beforePlan.comparison_scores?.[name], after = afterPlan.comparison_scores?.[name];
        if (before != null && after != null) {
            const row = { id: name, kind, before, after, lower: false, direction: direction(before, after, false, kind) };
            objectives.push(row);
            if (name === 'crop_variety') rows.push(row);
        }
    };
    score('crop_variety', 'count');
    const levelUp = !!beforeInput.level_up_strategy;
    if (levelUp) {
        add('rv_time', 'duration', reportOf(beforePlan)?.seconds ?? null, reportOf(afterPlan)?.seconds ?? null, true, true);
        if (beforeInput.season) add('season_points', 'rate', rateOf(beforePlan,'season_points'),rateOf(afterPlan,'season_points'),false,true);
    }
    const targets = levelUp ? [] : beforeInput.priorities || [];
    for (const target of [...new Set([...targets, 'coins'])]) {
        if (target === 'level_up') add('rv_time','duration',reportOf(beforePlan)?.seconds ?? null,reportOf(afterPlan)?.seconds ?? null,true,true);
        else add(target,'rate',rateOf(beforePlan,target),rateOf(afterPlan,target),false,true);
    }
    score('material_pace');
    score('material_work');
    score('stock');
    if (!levelUp && !targets.includes('level_up')) add('rv_time','duration',reportOf(beforePlan)?.seconds ?? null,reportOf(afterPlan)?.seconds ?? null,true);
    const a = reportOf(beforePlan), b = reportOf(afterPlan);
    for (const name of new Set([...(a?.requirements || []), ...(b?.requirements || [])].map(r=>r.name).filter(n=>n!=='coins'))) {
        add(`item:${name}`,'rate',a?.requirements.find(r=>r.name===name)?.per_second || 0,b?.requirements.find(r=>r.name===name)?.per_second || 0);
    }
    const beforeWork = workerUsage(beforePlan,beforeInput), afterWork = workerUsage(afterPlan,afterInput);
    if (beforeWork && afterWork) {
        add('working_aniimo','count',beforeWork.working,afterWork.working,true);
        add('additional_aniimo','count',beforeWork.additional,afterWork.additional,true);
        add('work_hours','work',beforeWork.hours,afterWork.hours,true);
    }
    const first = objectives.findIndex(row=>row.direction !== 0);
    const decisive = first < 0 ? null : objectives[first];
    const relative = decisive?.before > 0 ? Math.abs(decisive.after - decisive.before) / decisive.before : 1;
    const approximate = beforePlan.proven_optimal !== true || afterPlan.proven_optimal !== true;
    return {rows, decisive, direction:decisive?.direction || 0,
        inconclusiveLoss: approximate && decisive?.direction < 0,
        score:decisive?.direction > 0 ? (32-first)*1e6 + Math.min(1e5,relative) : 0,
        approximate};
}

// A timeout or a weaker incumbent on a repeat check must not replace an already checked
// better solution for the same alternative and the same base plan.
export function keepBetterComparison(previous, next, input) {
    if (!previous?.plan?.success) return next;
    if (!next?.plan?.success) return { ...previous, retained: true };
    const comparison = comparePlans(previous.plan, next.plan, input, input);
    if (comparison.direction < 0 || (comparison.direction === 0 && previous.plan.proven_optimal && !next.plan.proven_optimal)) {
        return { ...previous, retained: true };
    }
    return next;
}

export function compareRecommendations(before, after, input, alternative) {
    const report = comparePlans(before, after, input, alternative);
    const goals = new Set(['coins', 'crop_variety', ...(input.priorities || []).map(id => id === 'level_up' ? 'rv_time' : id)]);
    if (input.level_up_strategy) goals.add('rv_time');
    const protectedLoss = report.rows.find(row => goals.has(row.id) && row.direction < 0);
    const income = report.rows.find(row => row.id === 'coins');
    const count = report.rows.find(row => row.id === 'working_aniimo');
    const work = report.rows.find(row => row.id === 'work_hours');
    const start = workerUsage(before, input), finish = workerUsage(after, alternative);
    const peak = start && finish ? { id: 'peak_workload', kind: 'percent', before: start.peak, after: finish.peak,
        direction: direction(start.peak, finish.peak, true, 'work') } : null;
    if (peak) report.rows.push(peak);
    const order = [income, count, peak, work];
    const group = order.findIndex(row => row && row.direction !== 0);
    const main = protectedLoss || order[group];
    const gain = main?.direction > 0;
    return { ...report, workloadUnavailable: after.comparison_workload_valid === false, income, decisive: main, direction: main?.direction || 0,
        score: gain ? (4 - group) * 1e6 + Math.abs(main.after - main.before) : 0, start, finish,
        inconclusiveLoss: report.approximate && main?.direction < 0 };
}
