import {refineElectricStaffing} from './electric-staffing.js';

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
    if(!context?.report || !measured)
        return refineShift(problem,incumbent,solve,context);
    const reports=new Map();
    const report=values=>{
        if(!reports.has(values))reports.set(values,context.report(values));
        return reports.get(values);
    };
    let candidate=await refineShift(problem,incumbent,solve,{...context,report});
    if(candidate!==incumbent && !keepsProduction(report(incumbent.values),report(candidate.values)))candidate=incumbent;
    return fillReservePosts(problem,candidate,context.input,report);
}

function keepsProduction(before,after){
    if(!before?.success||!after?.success||!Number.isFinite(before.rate_per_second)||!Number.isFinite(after.rate_per_second)
        ||after.rate_per_second<before.rate_per_second-1e-9)return false;
    for(const key of ['level_up','level_up_preview']){
        if(Number.isFinite(before[key]?.seconds)&&(!Number.isFinite(after[key]?.seconds)||after[key].seconds>before[key].seconds+1e-5))
            return false;
    }
    const achieved=new Map((after.priorities??[]).map(p=>[p.target,p.per_second]));
    return (before.priorities??[]).every(p=>achieved.get(p.target)>=p.per_second-1e-9);
}

// An owned pool can have a grower in the field and a second, completely idle
// copy. Swap only full-time posts. The mobile crew and its routes stay intact.
function fillReservePosts(problem,shift,input,report){
    const members=input.roster.members;
    if(!members?.length || !problem.variable_keys || !problem.staffing_pools)return shift;
    const pools=problem.staffing_pools,posts=new Map();
    for(const [member,pool] of pools.entries())for(const v of pool.anchors){
        const key=problem.variable_keys[v];
        if(!key.startsWith('staff:'))continue;
        const building=key.split(':')[1];
        if(!posts.has(building))posts.set(building,[]);
        posts.get(building).push({member,pool,v});
    }
    const deployed=(pool,values)=>Math.max(Math.ceil(total(pool.work,values)-1e-6),
        Math.round(pool.anchors.reduce((n,v)=>n+values[v],0)));
    for(const options of posts.values())for(const source of options){
        if(!source.pool.reserve || shift.values[source.v]<0.5)continue;
        for(const dest of options){
            if(dest.pool.reserve || !members[dest.member])continue;
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

async function refineShift(problem, incumbent, solve, context) {
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
    const saved = total(work, original) - total(work, values);
    if (saved > 1e-8 || (saved >= -1e-9 && total(climate, original) - total(climate, values) > 0.5)) {
        // The secondary solve's score and bound concern staffing. Retain the production proof.
        return {...incumbent, values};
    }
    return incumbent;
}
