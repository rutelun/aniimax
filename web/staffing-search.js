import {refineElectricStaffing, keepsProduction} from './electric-staffing.js';

const total = (terms, values) => terms.reduce((sum, [v, coefficient]) => sum + coefficient * values[v], 0);
const expression = terms => terms.map(([v, c]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} x${v}`).join(' ');

// Reassign a completed shift inside the same continuous-production and dispatch model.
// Holding the totals across worker variants preserves every harvest, sale, RV reserve,
// production rate and physical recipe choice. A faster worker can still change how long
// a kiln runs, provided its input availability and every competing job remain feasible.
export async function refineStaffing(problem, incumbent, solve, context) {
    const input=context?.input;
    const measured=Object.keys(input?.roster?.dispatch??{}).length>0;
    // Crop travel and workshop phase loads depend on the placed buildings.
    // Keep the audited production shift for layout, then staff the measured map.
    if(input?.map_dispatch_pending && input.roster && !measured && input.always_running
        && input.priorities?.[0]==='level_up' && Object.values(input.season_crop_minimums??{}).some(n=>n>0))return incumbent;
    if(!context?.report)
        return refineShift(problem,incumbent,solve,context);
    const reports=new Map();
    const report=values=>{
        if(!reports.has(values))reports.set(values,context.report(values));
        return reports.get(values);
    };
    let candidate=await refineShift(problem,incumbent,solve,{...context,report});
    if(candidate!==incumbent && !keepsProduction(report(incumbent.values),report(candidate.values)))candidate=incumbent;
    return input?.roster ? preferOwnedPostWorkers(problem,candidate,context.input,report) : candidate;
}

// An owned pool can have a grower in the field and a second, completely idle
// copy. Swap only full-time posts. The mobile crew and its routes stay intact.
function preferOwnedPostWorkers(problem,shift,input,report){
    const members=input.roster.members;
    if(!members?.length || !problem.variable_keys || !problem.staffing_pools)return shift;
    const pools=problem.staffing_pools,posts=new Map();
    const climateSkills=new Map(problem.climate_skills);
    for(const [member,pool] of pools.entries())for(const v of pool.anchors){
        const key=problem.variable_keys[v];
        if(!key.startsWith('staff:'))continue;
        const building=key.split(':')[1];
        if(!posts.has(building))posts.set(building,[]);
        posts.get(building).push({member,pool,v});
    }
    const deployed=(pool,values)=>Math.max(Math.ceil(total(pool.work,values)-1e-6),
        Math.round(pool.anchors.reduce((n,v)=>n+values[v],0)));
    for(const options of posts.values())options.sort((a,b)=>Number(a.pool.reserve)-Number(b.pool.reserve)
        || (climateSkills.get(a.v)??0)-(climateSkills.get(b.v)??0));
    for(const options of posts.values())for(const source of options){
        if(shift.values[source.v]<0.5)continue;
        for(const dest of options){
            if(dest.pool.reserve || !members[dest.member])continue;
            // Climate output is fixed by the mode. Leave the more versatile
            // owned worker free when a less skilled one can cover the same post.
            if(!source.pool.reserve && !(climateSkills.get(dest.v)<climateSkills.get(source.v)))continue;
            const capacity=members[dest.member].count-(input.crop_peak_helpers?.[dest.member]??0);
            while(shift.values[source.v]>0.5 && deployed(dest.pool,shift.values)<capacity){
                const values=shift.values.slice();
                values[source.v]--;values[dest.v]++;
                for(const p of [source.pool,dest.pool])if(p.active!=null)values[p.active]=deployed(p,values);
                if(!keepsProduction(report(shift.values),report(values)))break;
                shift={...shift,values};
            }
        }
    }
    return shift;
}

// Minimize climate buildings (and avoid redundant overlapping pairs or empty units)
// while holding every recipe, site, route, power and sale variable fixed.
async function refineClimate(problem, incumbent, solve) {
    const keys = problem?.variable_keys, original = incumbent?.values;
    if (!keys?.length || original?.length !== problem.variables || !problem.lp) return incumbent;
    const envVars = [], pairVars = [], pairRelaxVars = [], climateStaff = [], activeVars = [];
    for (let v = 0; v < keys.length; v++) {
        const key = keys[v];
        if (key.startsWith('environment:')) envVars.push(v);
        else if (key.startsWith('pair:')) pairVars.push(v);
        else if (key.startsWith('pair_relax:')) pairRelaxVars.push(v);
        else if (key.startsWith('staff:') && !key.startsWith('staff:Crackle Generator:')) climateStaff.push(v);
        else if (key.startsWith('active:')) activeVars.push(v);
    }
    if (!envVars.length && !pairVars.length) return incumbent;
    const hasActiveClimate = envVars.some(v => original[v] > 0.5) || pairVars.some(v => original[v] > 0.5);
    if (!hasActiveClimate) return incumbent;

    const pools = problem.staffing_pools ?? [];
    const reserves = pools.filter(pool => pool.reserve);
    const reserveWork = reserves.flatMap(pool => pool.work);
    const reserveTime = total(reserveWork, original);
    const growers = pools.filter(pool => pool.crop.some(v => original[v] > 1e-9));
    const headcount = (team, values) => team.reduce((sum, pool) => sum + Math.max(0,
        Math.ceil(total(pool.work, values) - 1e-6),
        Math.round(pool.anchors.reduce((n, v) => n + values[v], 0))), 0);
    const people = headcount(pools, original), extra = headcount(reserves, original);
    const reserveStaffSet = new Set();
    const ownedClimateBuilding = new Set();
    for (const pool of pools) {
        for (const v of pool.anchors) {
            const key = keys[v];
            if (!key?.startsWith('staff:') || key.startsWith('staff:Crackle Generator:')) continue;
            if (pool.reserve) reserveStaffSet.add(v);
            else ownedClimateBuilding.add(key.split(':')[1]);
        }
    }
    const climateSkills = new Map(problem.climate_skills ?? []);
    const costs = new Map();
    for (const v of envVars) {
        const mode = keys[v].split(':')[2];
        costs.set(v, mode === 'Scorching' || mode === 'Freeze' ? -1.01 : -1.0);
    }
    for (const v of pairVars) costs.set(v, -2.05);
    for (const v of climateStaff) {
        if (reserveStaffSet.has(v)) costs.set(v, (costs.get(v) || 0) - 100);
        else {
            const skills = climateSkills.get(v) ?? 0;
            if (skills > 0) costs.set(v, (costs.get(v) || 0) - 1e-4 * skills);
        }
    }
    for (const pool of reserves) {
        if (pool.active != null) costs.set(pool.active, (costs.get(pool.active) || 0) - 1000);
    }
    const climateScore = values => {
        let s = 0;
        for (const [v, c] of costs) s += c * (values[v] ?? 0);
        return s;
    };

    const rows = [];
    if (pools.length) {
        if (reserveWork.length) rows.push(` climate_reserve_work: ${expression(reserveWork)} <= ${reserveTime + 1e-9}`);
        growers.forEach((pool, i) => rows.push(` climate_grower_${i}: ${expression(pool.work)} <= ${total(pool.work, original) + 1e-9}`));
        for (const [name, team, limit] of [['team', pools, people], ['reserves', reserves, extra]]) {
            const active = team.filter(pool => pool.active != null).map(pool => [pool.active, 1]);
            if (active.length) rows.push(` climate_people_${name}: ${expression(active)} <= ${limit}`);
        }
    }
    const generalSection = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const integers = new Set([...(generalSection?.[1] ?? '').matchAll(/\bx(\d+)\b/g)].map(m => Number(m[1])));
    const baseFree = new Set([...envVars, ...(pools.length ? [...climateStaff, ...activeVars] : [])]);
    const runClimate = async (allowPairs, warm) => {
        const free = allowPairs ? new Set([...baseFree, ...pairVars]) : baseFree;
        const forceZero = new Set(allowPairs ? pairRelaxVars : [...pairVars, ...pairRelaxVars]);
        let lp = problem.lp.replace(/^Maximize\n[^\n]+/, 'Maximize\n obj: ' + expression([...costs]));
        if (rows.length) lp = lp.replace('\nBounds\n', '\n' + rows.join('\n') + '\nBounds\n');
        lp = lp.replace(/^ (?:[^\n]+ <= x(\d+) <= [^\n]+|x(\d+) >= [^\n]+)$/gm, (line, a, b) => {
            const v = Number(a ?? b);
            if (free.has(v)) return line;
            if (forceZero.has(v)) return ` 0 <= x${v} <= 0`;
            const raw = original[v] ?? 0;
            const val = integers.has(v) ? Math.round(raw) : Math.max(0, raw);
            return ` ${val} <= x${v} <= ${val}`;
        });
        const sub = { ...problem, lp, primary_objective: [...costs], tiebreak: [] };
        try {
            return await solve(sub, { mip_max_nodes: 256, mipIterations: 12000, mip_rel_gap: 0, mip_abs_gap: 0 }, undefined, warm);
        } catch (error) {
            console.warn('Keeping the checked climate layout after a climate solve error.', error);
            return null;
        }
    };
    const isValid = values => {
        if (values?.length !== original.length || !values.every(Number.isFinite)) return false;
        if (!pools.length) return true;
        return total(reserveWork, values) <= reserveTime + 1e-8
            && headcount(pools, values) <= people
            && headcount(reserves, values) <= extra
            && !growers.some(pool => total(pool.work, values) > total(pool.work, original) + 1e-8);
    };

    const hasOriginalPair = pairVars.some(v => original[v] > 0.5);
    let bestValues = original, bestScore = climateScore(original);
    const standalone = await runClimate(false, hasOriginalPair ? undefined : original);
    let standaloneOk = false;
    if (standalone?.values && isValid(standalone.values)) {
        standaloneOk = true;
        const s = climateScore(standalone.values);
        if (s > bestScore + 1e-6) {
            bestValues = standalone.values;
            bestScore = s;
        }
    }
    let needPairs = pairVars.length > 0 && !standaloneOk;
    if (!needPairs && pairVars.length > 0 && standaloneOk) {
        const tempModes = new Set();
        for (const v of envVars) {
            if (standalone.values[v] <= 0.5) continue;
            const mode = keys[v].split(':')[2];
            if (mode === 'Warm' || mode === 'Scorching' || mode === 'Cool' || mode === 'Freeze') tempModes.add(mode);
        }
        const reserveHF = climateStaff.some(v =>
            reserveStaffSet.has(v) && standalone.values[v] > 0.5 && keys[v].startsWith('staff:Heat Furnace:'));
        const reserveCU = climateStaff.some(v =>
            reserveStaffSet.has(v) && standalone.values[v] > 0.5 && keys[v].startsWith('staff:Cooling Unit:'));
        const pairCanSaveReserve = (reserveHF && ownedClimateBuilding.has('Cooling Unit'))
            || (reserveCU && ownedClimateBuilding.has('Heat Furnace'));
        if (tempModes.size >= 3 || pairCanSaveReserve) needPairs = true;
    }
    if (needPairs) {
        const paired = await runClimate(true, standaloneOk ? standalone.values : original);
        if (paired?.values && isValid(paired.values)) {
            const s = climateScore(paired.values);
            if (s > bestScore + 1e-6) {
                bestValues = paired.values;
                bestScore = s;
            }
        }
    }
    return bestValues === original ? incumbent : { ...incumbent, values: bestValues };
}

async function refineShift(problem, incumbent, solve, context) {
    incumbent = await refineClimate(problem, incumbent, solve);
    try {
        incumbent=await refineElectricStaffing(problem,incumbent,solve,context);
    } catch (error) {
        console.warn('Keeping the checked power settings after a staffing solve error.',error);
    }
    const pools = problem.staffing_pools, groups = problem.staffing_groups;
    if (!pools?.length || !groups?.length || incumbent?.values?.length !== problem.variables) return incumbent;
    const work = pools.flatMap(pool => pool.work);
    if (!work.length) return incumbent;
    const original = incumbent.values;
    const retained = groups.map(group => group.reduce((sum, v) => sum + original[v], 0));
    const rows = groups.map((group, i) => ` retain_shift_${i}: ${group.map(v => 'x'+v).join(' + ')} = ${retained[i]}`);
    const reserves = pools.filter(pool => pool.reserve);
    const reserve = reserves.flatMap(pool => pool.work);
    const reserveTime = total(reserve, original);
    if (reserve.length) rows.push(` retain_owned_team: ${expression(reserve)} <= ${reserveTime + 1e-9}`);
    const growers = pools.filter(pool => pool.crop.some(v => original[v] > 1e-9));
    growers.forEach((pool,i) => rows.push(` retain_harvest_${i}: ${expression(pool.work)} <= ${total(pool.work,original)+1e-9}`));
    const headcount = (team, values) => team.reduce((sum, pool) => sum + Math.max(0,
        Math.ceil(total(pool.work, values) - 1e-6),
        Math.round(pool.anchors.reduce((n,v) => n+values[v], 0))), 0);
    const people = headcount(pools, original), extra = headcount(reserves, original);
    for (const [name, team, limit] of [['team', pools, people], ['reserves', reserves, extra]]) {
        const active = team.filter(pool => pool.active != null).map(pool => [pool.active, 1]);
        if (active.length) rows.push(` retain_people_${name}: ${expression(active)} <= ${limit}`);
    }
    const climate = problem.climate_skills || [];
    const costs = new Map();
    // Before routes are measured, the model can still move work between all
    // eligible operators. Prefer an owned shift before measuring a reserve's route.
    const workDays = total(work, original);
    for (const pool of reserves) {
        if (pool.active != null) costs.set(pool.active, -(1 + Math.ceil(workDays)));
        for (const [v, days] of pool.work) costs.set(v, (costs.get(v) || 0) - days);
    }
    for (const [v, days] of work) costs.set(v, (costs.get(v) || 0) - days);
    for (const [v, skills] of climate) costs.set(v, (costs.get(v) || 0) - 1e-6 * skills);
    const lp = problem.lp.replace(/^Maximize\n[^\n]+/, 'Maximize\n obj: '+expression([...costs]))
        .replace('\nBounds\n', '\n'+rows.join('\n')+'\nBounds\n');
    const staffing = {...problem, lp, primary_objective:[...costs], tiebreak:[]};
    let result;
    try {
        result = await solve(staffing, {mip_max_nodes:256, mipIterations:12000, mip_rel_gap:0, mip_abs_gap:0}, undefined, original);
    } catch (error) {
        console.warn('Keeping the checked production shift after a staffing solve error.',error);
        return incumbent;
    }
    const values = result?.values;
    if (values?.length !== original.length || !values.every(Number.isFinite)) return incumbent;
    const sameShift = groups.every((group, i) =>
        Math.abs(group.reduce((sum, v) => sum + values[v], 0) - retained[i]) <= 1e-9 * Math.max(1, Math.abs(retained[i])));
    if (!sameShift || total(reserve, values) > reserveTime + 1e-8) return incumbent;
    if (headcount(pools, values) > people || headcount(reserves, values) > extra
        || growers.some(pool => total(pool.work, values) > total(pool.work, original) + 1e-8)) return incumbent;
    const saved = workDays - total(work, values);
    if (headcount(reserves, values) < extra || saved > 1e-8 || (saved >= -1e-9 &&
        (total(reserve, values) < reserveTime - 1e-8 || total(climate, original) - total(climate, values) > 0.5))) {
        // The secondary solve's score and bound concern staffing. Retain the production proof.
        return {...incumbent, values};
    }
    return incumbent;
}
