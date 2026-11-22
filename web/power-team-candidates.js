import {recommendBestTeam, protectedShift, distractionCount} from './best-team.js';
import {productionTeamJobs} from './production-team-jobs.js';
import {ratedSiteWatts, physicalPlanPower} from './physical-power.js';
import {FACILITIES, generatorLimit} from './facility-config.js';
import {materialChains, processStage} from './material-flow-schedule.js';
import {scheduleInputForPlan, attachRecipeSchedule} from './recipe-schedule-plan.js';

const EPS = 1e-7;
const DAY = 86400;
const siteWatts = site => site.electric_level == null ? 0 : 1.2 * ratedSiteWatts(site);
const facilities = new Map(FACILITIES.map(f => [f.name, f]));
const sitesNeeded = busy => Math.ceil(busy - EPS);

function* combinations(menus, prefix = []) {
    if (prefix.length === menus.length) {
        yield prefix;
        return;
    }
    for (const value of menus[prefix.length]) yield* combinations(menus, [...prefix, value]);
}

function nativeModes(problem, definitions) {
    const modes = new Map();
    for (const [index, item, , , electric, cycle] of problem.recipe_options ?? []) {
        const id = problem.variable_keys?.[index];
        if (!(cycle > 0) || !id?.startsWith('rate:') || !id.endsWith('#0')) continue;
        const recipeId = id.slice(5, -2);
        const level = electric ? Number(recipeId.split('__electric')[1]) : null;
        if (recipeId !== (electric ? item + '__electric' + level : item)) continue;
        const levelRequired = level ?? definitions.get(item)?.facility_level;
        if (!(levelRequired > 0)) continue;
        if (!modes.has(item)) modes.set(item, []);
        modes.get(item).push({id: recipeId, electric_level: level, facility_level: levelRequired, cycle});
    }
    return modes;
}

function productionRow(base, source, definitions, input) {
    const {facility, item, electric_level, cycle, rate} = source;
    const busy = cycle * rate;
    let role = null;
    if (electric_level == null) {
        const [ability, required] = definitions.get(item)?.aniimo ?? [];
        role = base.aniimo ?? (ability && {ability, level: input.aniimo_levels?.[ability] ?? required,
            personality_bonus: !!facilities.get(facility)?.personality});
        if (!role) return null;
    }
    return {...base, electric_level, cycle_time: cycle, busy_units: busy, facility_count: sitesNeeded(busy),
        aniimo: role, aniimo_tasks: role ? [{...role, busy, jobs: []}] : []};
}

// Keep both extremes. Fractional manual work and the number of opportunities
// for diversions need not rank two equal-capacity configurations in the same order.
function retainState(next, key, state) {
    const lean = next.get(key);
    if (!lean || state.work < lean.work - EPS ||
        (Math.abs(state.work - lean.work) <= EPS && state.risk < lean.risk)) next.set(key,state);
    const safeKey = key + '|safe', safe = next.get(safeKey);
    if (!safe || state.risk < safe.risk ||
        (state.risk === safe.risk && state.work < safe.work - EPS)) next.set(safeKey,state);
}

function facilityStates(menus, tiers, definitions, maximum, protectedWorkers) {
    const levels = [...new Set(tiers.map(t => t.level))].sort((a, b) => a - b);
    const owned = levels.map(level => tiers.filter(t => t.level === level).reduce((n, t) => n + t.count, 0));
    const options = menus.map(menu => menu.map((pick, i) => {
        const {row} = pick, electric = row.electric_level != null;
        const recipe = definitions.get(row.item_name), required = recipe?.facility_level ?? 1;
        const risk = !electric && !(row.busy_units>=row.facility_count-EPS) && recipe?.aniimo && facilities.get(row.facility)?.category !== 'Aniimo Materials'
            ? protectedWorkers.reduce((sum,entry) => sum + distractionCount(entry,[{
                ability:recipe.aniimo[0],level:recipe.aniimo[1],family:recipe.family,siteCount:row.facility_count,
            }]),0) : 0;
        return {pick, risk, changed: i !== 0, ability: i ? row.aniimo?.ability : null, electric,
            tier: electric ? levels.indexOf(row.electric_level) : levels.findIndex(level => level >= required),
            count: row.facility_count, watts: siteWatts(row) * row.facility_count, work: electric ? 0 : row.busy_units};
    }));
    const baseline = {changes: [], watts: 0, work: 0, risk: 0};
    for (const [first] of options) {
        baseline.watts += first.watts;
        baseline.work += first.work;
        baseline.risk += first.risk;
    }
    if (options.every(menu => menu.length === 1)) return [baseline];
    let states = [{...baseline, watts: 0, work: 0, risk: 0, abilities: [], powered: levels.map(() => 0), manual: levels.map(() => 0)}];
    for (const menu of options) {
        const next = new Map();
        let order = 0;
        for (const state of states) for (const option of menu) {
            order++;
            const watts = state.watts + option.watts;
            if (watts > maximum + EPS || option.tier < 0) continue;
            const powered = option.electric ? state.powered.slice() : state.powered;
            const manual = option.electric ? state.manual : state.manual.slice();
            (option.electric ? powered : manual)[option.tier] += option.count;
            if (powered[option.tier] > owned[option.tier]) continue;
            // A higher-tier manual site can run every lower-tier manual recipe.
            let spare = 0;
            for (let i = levels.length - 1; i >= 0; i--) {
                spare += owned[i] - powered[i] - manual[i];
                if (spare < 0) break;
            }
            if (spare < 0) continue;
            const abilities = option.ability && !state.abilities.includes(option.ability)
                ? [...state.abilities, option.ability].sort() : state.abilities;
            const changed = !!state.changes.length || option.changed;
            const key = [powered.join(','), manual.join(','), changed, abilities.join(',')].join('|');
            const work = state.work + option.work;
            const changes = option.changed ? [...state.changes, option.pick] : state.changes;
            retainState(next,key,{watts, work, risk:state.risk + option.risk, changes, abilities, powered, manual, order});
        }
        // Preserve the input recipe order for equally good final assignments.
        states = [...new Set(next.values())].sort((a, b) => a.order - b.order);
    }
    return [baseline, ...states.filter(s => s.changes.length)];
}

function ordinaryMenus(plan, input, modes, definitions) {
    const modeKey = (name, level) => name + '|' + (level ?? '');
    const rows = new Map(plan.coin_items.filter(r => r.status === 'producing').map(r => [modeKey(r.item_name, r.electric_level), r]));
    const counts = new Map();
    for (const s of plan.schedule_sources) counts.set(s.item, 1 + (counts.get(s.item) ?? 0));
    const groups = new Map();
    const scheduled = new Set(plan.recipe_schedule?.jobs.map(j => j.item));
    // Preserve the certified background around a material schedule. Changing
    // the capacity of even an upstream supplier can change a phase's feed.
    const resources = new Set(plan.schedule_sources.filter(s => scheduled.has(s.item))
        .flatMap(s => [...s.inputs, ...s.outputs].map(([resource]) => resource)));
    const connected = new Set();
    for (let previous = -1; previous !== connected.size;) {
        previous = connected.size;
        for (const s of plan.schedule_sources) {
            if (scheduled.has(s.item) || connected.has(s.item)) continue;
            const terms = [...s.inputs, ...s.outputs];
            if (!terms.some(([resource]) => resources.has(resource))) continue;
            connected.add(s.item);
            if (s.inputs.length) for (const [resource] of terms) resources.add(resource);
        }
    }
    for (const source of plan.schedule_sources.filter(s => !scheduled.has(s.item))) {
        const row = rows.get(modeKey(source.item, source.electric_level));
        if (!row) return null;
        const choices = [{source, row}];
        // Keep every always-running site required by the native solution. An
        // extra active site can affect competition for a shared ingredient.
        if (counts.get(source.item) === 1 && !connected.has(source.item) && row.facility_count === sitesNeeded(row.busy_units) && !row.is_grower &&
            !(row.aniimo_tasks ?? []).some(t => t.jobs?.length)) {
            for (const mode of modes.get(source.item) ?? []) {
                if (mode.id === source.id) continue;
                const next = {...source, ...mode};
                const changed = productionRow(row, next, definitions, input);
                if (changed) choices.push({source: next, row: changed});
            }
        }
        if (!groups.has(source.facility)) groups.set(source.facility, []);
        groups.get(source.facility).push(choices);
    }
    return groups;
}

// A small manual job can occupy a whole specialist. Check individual switches
// on the shortlisted physical schedules even when aggregate work estimates tie.
export function* singleWorkshopUpgrades(plan,input,problem,recipes) {
    if (!(plan.power_generated>plan.power_used)) return;
    const definitions=new Map(recipes.map(r=>[r.name,r]));
    const groups=ordinaryMenus(plan,input,nativeModes(problem,definitions),definitions);
    for (const [facility,menus] of groups ?? []) {
        for (const menu of menus) {
            if (menu.length<2 || menu[0].row.electric_level!=null) continue;
            const choices=menus.map(other=>other===menu?menu:[other[0]]);
            const states=facilityStates(choices,input.facilities[facility] ?? [],definitions,plan.power_generated,[]);
            for (const state of states) {
                if (!state.changes.length) continue;
                const candidate=substituteOrdinary(plan,state.changes,input);
                const used=physicalPlanPower(candidate);
                if (used<=plan.power_generated+EPS) yield {...candidate,power_used:used};
            }
        }
    }
}

function ordinaryStates(plan, input, modes, definitions, maximum, protectedWorkers) {
    const groups=ordinaryMenus(plan,input,modes,definitions);
    if (!groups) return [];
    // Combine one facility at a time. At a given draw, retain the allocation
    // with the least manual work as well as the unmodified native allocation.
    let states = [{watts: 0, work: 0, risk: 0, changes: []}];
    for (const [facility, menus] of groups) {
        const entries = facilityStates(menus, input.facilities[facility] ?? [], definitions, maximum, protectedWorkers);
        const next = new Map();
        for (const state of states) for (const part of entries) {
            const watts = state.watts + part.watts, work = state.work + part.work;
            if (watts > maximum + EPS) continue;
            const unchanged = !state.changes.length && !part.changes.length;
            const abilities = new Set([...(state.abilities ?? []), ...part.changes.filter(c => c.row.aniimo).map(c => c.row.aniimo.ability)]);
            const key = [watts, unchanged, [...abilities].sort().join(',')].join('|');
            retainState(next,key,{watts, work, risk:state.risk + part.risk, abilities, changes:state.changes.concat(part.changes)});
        }
        states = [...new Set(next.values())];
    }
    return states.sort((a, b) => a.work - b.work || a.watts - b.watts);
}

// Each chain uses one full-day raw processor. A second raw processor runs
// until it has made the balance of the day's raw batches, then changes recipe.
// Once a stock buffer empties, downstream processors follow the feed rate.
function chainMenu(plan, facility, items, modes, background) {
    const old = items.map(item => plan.schedule_sources.find(s => s.item === item && s.turns));
    if (old.some(s => !s)) return [];
    const sites = plan.recipe_schedule.sites.filter(s => s.facility === facility);
    const required = old.map(s => modes.get(s.item)?.find(m => m.electric_level == null)?.facility_level);
    const menus = [], seen = new Set();
    for (const switchedStage of [2, 3]) {
        const other = switchedStage === 2 ? 3 : 2;
        // Match the hardest unlocks first. Equal-tier sites are interchangeable.
        const order = [other, switchedStage, 1, 0];
        const assignments = [];
        function assign(index, remaining, chosen) {
            if (index === order.length) { assignments.push(chosen); return; }
            const stage = order[index], tiers = new Set();
            for (const site of remaining) {
                if (tiers.has(site.level) || !(site.level >= required[stage])) continue;
                tiers.add(site.level);
                assign(index + 1, remaining.filter(s => s !== site), {...chosen, [stage]: site});
            }
        }
        assign(0, sites, {});
        for (const assigned of assignments) {
            const siteFor = [assigned[0], assigned[switchedStage], assigned[1], assigned[2], assigned[3]];
            const originals = [old[0], ...old];
            const choices = originals.map((s, i) => (modes.get(s.item) ?? []).filter(m =>
                m.electric_level == null || m.electric_level === siteFor[i].level));
            // The full-day processor supplies the steady manual baseline.
            choices[0] = choices[0].filter(m => m.electric_level == null);
            for (const selected of combinations(choices)) {
                if (selected[1].electric_level !== selected[switchedStage + 1].electric_level) continue;
                const key = [switchedStage, ...selected.map(s => s.id)].join('|');
                if (seen.has(key)) continue;
                seen.add(key);
                const lanes = selected.map((mode, i) => ({...originals[i], ...mode}));
                const [raw, extra] = lanes;
                const change = (old[0].rate - 1/raw.cycle) * DAY * extra.cycle;
                if (!(change > EPS && change < DAY - EPS)) continue;
                const profiles = [[{start:0, end:DAY, rate:1/raw.cycle}], [{start:0, end:change, rate:1/extra.cycle}]];
                let feed = [{start:0, end:change, rate:1/raw.cycle + 1/extra.cycle}, {start:change, end:DAY, rate:1/raw.cycle}];
                const [[resource, quantity]] = raw.inputs;
                const income = background.backgroundOutputs[resource] ?? 0;
                if (income + EPS/DAY < old[0].rate * quantity) continue;
                const stock = {[resource]: Math.max(0, (feed[0].rate * quantity - income) * change)};
                for (let stage = 1; stage < old.length; stage++) {
                    const lane = lanes[stage + 1], [[ingredient, amount]] = lane.inputs;
                    const fit = processStage(feed, p => stage === switchedStage && p.start < change - EPS ? 0 : 1/lane.cycle, amount);
                    if (!fit) break;
                    feed = fit.intervals;
                    if (fit.initial > EPS) stock[ingredient] = fit.initial;
                    profiles.push(stage === switchedStage ? feed.filter(p => p.start >= change - EPS) : feed);
                }
                if (profiles.length !== lanes.length) continue;
                const sources = new Map();
                lanes.forEach((s, i) => {
                    const rate = profiles[i].reduce((sum, p) => sum + (p.end - p.start) * p.rate / DAY, 0);
                    sources.set(s.id, {...s, rate: rate + (sources.get(s.id)?.rate ?? 0)});
                });
                if (old.some(s => Math.abs([...sources.values()].filter(t => t.item === s.item)
                    .reduce((sum, t) => sum + t.rate, 0) - s.rate) * DAY > EPS)) continue;
                const buildings = sites.map(site => {
                    const jobs = lanes.filter((_, i) => siteFor[i] === site);
                    return {...site, electric_level: jobs[0]?.electric_level ?? null,
                        recipes: [...new Set(jobs.map(j => j.item))], jobs: jobs.map(j => j.id)};
                });
                menus.push({lanes, profiles, siteFor, stock, buildings, sources: [...sources.values()],
                    watts: buildings.reduce((n, b) => n + siteWatts(b), 0)});
            }
        }
    }
    return menus;
}

function certifiedSchedule(plan, input, chains, definitions, lowestDraw, maximum) {
    const material = chains.flatMap(c => c.sources), items = new Set(material.map(s => s.item));
    const rows = new Map(plan.coin_items.filter(r => r.status === 'producing').map(r => [r.item_name, r]));
    const changed = material.map(s => productionRow(rows.get(s.item), s, definitions, input));
    if (changed.some(r => !r)) return null;
    const facilities = new Set(material.map(s => s.facility));
    const candidate = {...plan, schedule_sources: [...plan.schedule_sources.filter(s => !s.turns), ...material],
        coin_items: [...plan.coin_items.filter(r => !items.has(r.item_name) && !(r.status === 'idle' && facilities.has(r.facility))), ...changed]};
    const buildings = chains.flatMap(c => c.buildings);
    for (const facility of facilities) {
        const idle = buildings.filter(b => b.facility === facility && !b.jobs.length).length;
        if (idle) candidate.coin_items.push({facility, facility_count: idle, status: 'idle', item_name: null});
    }
    const cuts = [...new Set(chains.flatMap(c => c.profiles.flatMap(parts => parts.map(p => p.end))))].sort((a, b) => a - b);
    const phases = [];
    let start = 0;
    for (const end of cuts) {
        if (end - start < EPS && end < DAY) continue;
        const duration = end - start, mid = (start + end)/2, assignments = [];
        for (const chain of chains) chain.profiles.forEach((parts, i) => {
            const interval = parts.find(p => mid >= p.start && mid < p.end);
            if (interval) assignments.push({building: chain.siteFor[i].id, job: chain.lanes[i].id, batches: interval.rate * duration});
        });
        phases.push({duration, assignments});
        start = end;
    }
    try {
        const test = {...substituteOrdinary(candidate, lowestDraw.changes, input), power_generated: maximum};
        const scheduleInput = {...scheduleInputForPlan(input, test), buildings};
        const certified = attachRecipeSchedule(test, scheduleInput, {approximate: true, materialFlow: true, phases,
            initialStock: Object.assign({}, ...chains.map(c => c.stock))});
        return {...candidate, proven_optimal: false, recipe_schedule: certified.recipe_schedule};
    } catch {
        // Reject candidates that do not certify the entire repeated day.
        return null;
    }
}

function substituteOrdinary(plan, changes, input) {
    if (!changes.length) return plan;
    const changed = new Map(changes.map(c => [c.source.item, c]));
    const facilities = new Set(changes.map(c => c.source.facility));
    const rows = plan.coin_items.filter(r => !facilities.has(r.facility) || r.status !== 'idle')
        .map(r => r.status === 'producing' && changed.has(r.item_name) ? changed.get(r.item_name).row : r);
    for (const facility of facilities) {
        const total = input.facilities[facility].reduce((n, t) => n + t.count, 0);
        const used = rows.filter(r => r.facility === facility && r.status === 'producing').reduce((n, r) => n + r.facility_count, 0);
        if (used < total) rows.push({facility, facility_count: total - used, status: 'idle', item_name: null});
    }
    return {...plan, coin_items: rows, schedule_sources: plan.schedule_sources.map(s => changed.get(s.item)?.source ?? s)};
}

function* generatorTeams(count, used, operators) {
    if (!count) { if (!used) yield []; return; }
    const strongest = operators.at(-1);
    if (!used || strongest.watts * count < used - EPS) return;
    // Compare eligible operators at the same building tier, including a mixed team.
    const seen = new Set();
    for (const strong of [count - 1, 0, count]) {
        let remaining = used;
        const team = [];
        for (let i = 0; i < count; i++) {
            const operator = i < strong ? strongest : operators.find(o =>
                o.watts + (count - i - 1) * strongest.watts >= remaining - EPS);
            remaining -= operator.watts;
            team.push([operator.tier, operator.level]);
        }
        team.sort((a, b) => b[1] - a[1]);
        const key = team.map(pair => pair[1]).join(',');
        if (!seen.has(key)) { seen.add(key); yield team; }
    }
}

export function* powerTeamCandidates(plan, input, problem, recipes) {
    if (!plan?.schedule_sources?.length || !input?.e_mode_rv || input.roster || input.fixed_homeland) return;
    const sources = plan.schedule_sources;
    const definitions = recipes instanceof Map ? recipes : new Map(recipes.map(r => [r.name, r]));
    const modes = nativeModes(problem, definitions), rv = input.e_mode_rv;
    const limit = generatorLimit(rv), lightning = input.aniimo_levels?.Lightning ?? (input.aniimo?.startsWith('best3') ? 3 : 4);
    const outputs = plan.generator_watts_by_lightning?.slice(0, lightning);
    const tiers = plan.generator_tiers_by_lightning;
    if (!limit || !outputs?.length || !tiers?.length) return;
    const maxTier = Math.max(...tiers);
    const operators = outputs.flatMap((watts,i) => watts > 0 && tiers[i] === maxTier && maxTier > 0
        ? [{tier:maxTier,level:i+1,watts}] : []);
    if (!operators.length) return;
    const strongest = operators.at(-1);
    const jobs = productionTeamJobs(plan,[...definitions.values()]);
    for (const [,level] of plan.power_generator_levels?.length ? plan.power_generator_levels : [[null,strongest.level]]) {
        jobs.push({ability:'Lightning',level,busy:1,fixed:true,facility:'Crackle Generator',label:'Generator'});
    }
    const crew = recommendBestTeam(jobs,plan.hauling_busy ?? 0).shifts.filter(protectedShift).map(s=>s.entry);
    const ordinary = ordinaryStates(plan, input, modes, definitions, limit * strongest.watts,crew);
    if (!ordinary.length) return;
    const lowestDraw = ordinary.reduce((a, b) => a.watts < b.watts ? a : b);
    const menus = [];
    if (plan.recipe_schedule?.materialFlow && new Set(sources.map(s => s.item)).size === sources.length) {
        const background = scheduleInputForPlan(input, plan);
        for (const facility of new Set(sources.filter(s => s.turns).map(s => s.facility))) {
            const items = materialChains[facility];
            if (!items) return;
            menus.push(chainMenu(plan, facility, items, modes, background));
        }
    }
    // Equal power budgets occur across many changeover patterns. Their best
    // ordinary recipes depend only on how many watts remain.
    const safestFirst = [...ordinary].sort((a,b) => a.risk-b.risk || a.work-b.work || a.watts-b.watts);
    const budgets = new Map();
    function ordinaryWithin(watts) {
        if (budgets.has(watts)) return budgets.get(watts);
        const selected = new Map();
        for (const state of ordinary) {
            if (state.watts > watts + EPS) continue;
            const key = [...state.abilities ?? []].sort().join(',');
            if (!selected.has(key)) selected.set(key, state);
            if (selected.size === 4) break;
        }
        const safest = safestFirst.find(p => p.watts <= watts + EPS);
        if (safest && ![...selected.values()].some(p => p.risk <= safest.risk)) selected.set('safe',safest);
        const unchanged = ordinary.find(p => !p.changes.length && p.watts <= watts + EPS);
        if (unchanged) selected.set('incumbent', unchanged);
        const result = [...new Set(selected.values())];
        budgets.set(watts, result);
        return result;
    }
    function* configurations() {
        yield []; // Include ordinary changes on the already-verified site schedule.
        if (menus.length) yield* combinations(menus);
    }
    for (const chains of configurations()) {
        const base = chains.length ? certifiedSchedule(plan, input, chains, definitions, lowestDraw, limit * strongest.watts) : plan;
        if (!base) continue;
        const chainWatts = chains.length ? chains.reduce((n, c) => n + c.watts, 0)
            : (plan.recipe_schedule?.sites ?? []).reduce((sum, site) => sum + (site.jobs.length ? siteWatts(site) : 0), 0);
        const candidates = new Map();
        for (let count = 0; count <= limit; count++) {
            const budget = count * strongest.watts - chainWatts;
            for (const state of ordinaryWithin(budget)) {
                if (!candidates.has(state)) candidates.set(state, substituteOrdinary(base, state.changes, input));
                const candidate = candidates.get(state), used = chainWatts + state.watts;
                for (const levels of generatorTeams(count, used, operators))
                    yield {...candidate, power_used: used, power_generators: count, power_generator_levels: levels,
                        power_generated: levels.reduce((n, [, l]) => n + outputs[l - 1], 0)};
            }
        }
    }
}
