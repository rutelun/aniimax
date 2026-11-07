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

export function workerUsage(plan, input) {
    if (!input.roster) return null;
    const busy = new Map();
    const add = (member, share) => {
        if (member != null && Number.isFinite(share) && share > 0) busy.set(member, (busy.get(member) || 0) + share);
    };
    const residents = new Set(input.roster.residents || []);
    for (const step of plan.coin_items || []) if (step.status === 'producing') {
        add(step.crew, residents.has(step.facility) ? step.facility_count : step.busy_units ?? step.facility_count);
    }
    for (const [, member, share] of plan.staffing || []) add(member, share);
    for (const [, , member, share] of plan.crop_assignments || []) add(member, share);
    for (const [member, travel, idle] of plan.movement_staffing || []) add(member, travel + idle);
    for (const [member, share] of plan.delivery_assignments || plan.hauling_staffing || []) add(member, share);
    const heads = n => Math.max(0, Math.ceil(n - 1e-6));
    return { busy, working: [...busy.values()].reduce((n, b) => n + heads(b), 0),
        additional: [...busy].filter(([i]) => i >= input.roster.members.length).reduce((n, [, b]) => n + heads(b), 0),
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
        add(target,'rate',rateOf(beforePlan,target),rateOf(afterPlan,target),false,true);
    }
    score('material_pace');
    score('material_work');
    score('stock');
    if (!levelUp) add('rv_time','duration',reportOf(beforePlan)?.seconds ?? null,reportOf(afterPlan)?.seconds ?? null,true);
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
    return {rows, decisive, direction:decisive?.direction || 0,
        score:decisive?.direction > 0 ? (32-first)*1e6 + Math.min(1e5,relative) : 0,
        approximate:beforePlan.proven_optimal !== true || afterPlan.proven_optimal !== true};
}
