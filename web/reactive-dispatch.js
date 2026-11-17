import { dispatchLocations } from './task-switching.js';
import { haulingBatchTrips, pickupStockLimit } from './hauling.js';
import { workerTravelSeconds } from './worker-travel.js';

const center=r=>[r.x+r.w/2,r.y+r.h/2];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export const dispatchKey=(facility,item,ability)=>`${facility}|${item}|${ability}`;

// Expected random dispatch among eligible free workers. A policy allocates ONE
// original request across workers; it never adds a second copy of its execution.
// Arrival estimates start at previous work sites, not at the new request site.
export function buildReactiveDispatch({layout,recipes,members,busy=[],permanent=[],routes=[],previous=null}){
    const locations=dispatchLocations(layout),sites=layout.pieces.flatMap(p=>p.members);
    const byFacility=new Map();
    for(const r of sites){
        if(!byFacility.has(r.facility))byFacility.set(r.facility,[]);
        byFacility.get(r.facility).push(r);
    }
    const fallback=sites.filter(r=>(r.batchWeight??r.weight)>0).map(r=>({point:center(r),rate:r.batchWeight??r.weight}));
    const homes=members.map(()=>[]);
    for(const route of routes){
        if(!(route.job_rate>0)||!homes[route.member])continue;
        const positions=locations.get(`${route.facility}|${route.item}`)||[];
        const total=positions.reduce((s,p)=>s+p.rate,0);
        for(const p of positions)if(total>0)homes[route.member].push({point:p.point,rate:route.job_rate*p.rate/total});
    }
    const approach=(member,point)=>{
        const from=homes[member].length?homes[member]:fallback;
        const total=from.reduce((s,p)=>s+p.rate,0);
        return total>0?from.reduce((s,p)=>s+p.rate*workerTravelSeconds(distance(p.point,point)),0)/total:0;
    };
    const policy={};
    const planned=new Map();
    for(const route of routes){
        if(!(route.job_rate>0)||!route.jobs?.length)continue;
        const key=routeDispatchKey(route,recipes);
        if(!key)continue;
        if(!planned.has(key))planned.set(key,[]);
        planned.get(key).push(route);
    }
    for(const recipe of recipes){
        const physical=byFacility.get(recipe.facility);
        if(!physical?.length)continue;
        const positions=physical.filter(r=>r.crop===recipe.name||r.jobs?.some(j=>j.item===recipe.name));
        const targets=positions.length?positions:physical;
        const roles=recipe.aniimo?[['Production',recipe.aniimo[0],recipe.aniimo[1]]]
            :[...new Map((recipe.jobs||[]).map(([,a,l])=>[a,[a,a,l]])).values()];
        roles.push(['Hauling','Hauling',1]);
        for(const [keyAbility,ability,level] of roles){
            const key=dispatchKey(recipe.facility,recipe.name,keyAbility);
            const eligible=members.flatMap((member,i)=>{
                const capacity=member.assumed?Math.ceil((busy[i]||0)-1e-6):member.count;
                const mobile=Math.max(0,capacity-(permanent[i]||0));
                if(!mobile||!(member.abilities?.[ability]>=level)||ability==='Leisure'&&recipe.family&&member.family!==recipe.family)return [];
                return [{member:i,weight:Math.max(0,capacity-(busy[i]||0)),mobile}];
            });
            if(!eligible.length)continue;
            let total=eligible.reduce((s,m)=>s+m.weight,0);
            // If all are busy, requests wait for a worker to finish. Preserve
            // demand instead of making the task disappear at zero availability.
            if(total<=1e-9){for(const e of eligible)e.weight=e.mobile;total=eligible.reduce((s,e)=>s+e.weight,0);}
            const valid=new Set(eligible.map(e=>e.member));
            let entries=previous?.[key]?.filter(e=>valid.has(e.member)&&Number.isFinite(e.share)&&e.share>0);
            if(!entries?.length&&planned.has(key)){
                const own=planned.get(key).filter(r=>valid.has(r.member));
                const rate=own.reduce((s,r)=>s+r.job_rate,0);
                if(rate>0){
                    const assigned=new Map();
                    for(const r of own){
                        const row=assigned.get(r.member)||{share:0,work:0};
                        row.share+=r.job_rate/rate;
                        row.work+=r.jobs.reduce((s,[,work])=>s+work,0)+(r.walking||0);
                        assigned.set(r.member,row);
                    }
                    let captured=0;
                    const weights=new Map();
                    for(const [member,row] of assigned){
                        const mobile=eligible.find(e=>e.member===member).mobile;
                        const elsewhere=Math.max(0,(busy[member]||0)-(permanent[member]||0)-row.work);
                        const diverted=row.share*Math.min(1,elsewhere/mobile);
                        weights.set(member,row.share-diverted);
                        captured+=diverted;
                    }
                    // Being busy doing THIS task is not a reason to lose it.
                    // Only overlapping other work exposes its requests to pickup.
                    for(const e of eligible)weights.set(e.member,(weights.get(e.member)||0)+captured*e.weight/total);
                    entries=[...weights].filter(([,share])=>share>1e-12).map(([member,share])=>({member,share}));
                }
            }
            if(!entries?.length)entries=eligible.filter(e=>e.weight>0).map(e=>({member:e.member,share:e.weight/total}));
            const shares=entries.reduce((s,e)=>s+e.share,0);
            policy[key]=entries.map(e=>{
                let travel=0;
                for(const target of targets){
                    const point=center(target),walk=approach(e.member,point);
                    if(keyAbility==='Hauling'){
                        const stores=layout.storages||[];
                        const loaded=stores.length?Math.min(...stores.map(s=>workerTravelSeconds(distance(point,center(s))))):0;
                        const trips=haulingBatchTrips(recipe,members[e.member].abilities.Hauling,pickupStockLimit(target),recipe.facility);
                        travel+=(walk+loaded)*trips;
                    }else travel+=walk;
                }
                return {member:e.member,share:e.share/shares,travel_seconds:travel/targets.length};
            });
        }
    }
    return policy;
}

export function permanentWorkers(plan,members,residents){
    const fixed=members.map(()=>0);
    for(const [,member,count] of plan.staffing||[])if(fixed[member]!=null)fixed[member]+=count;
    for(const step of plan.coin_items||[]){
        if(step.status==='producing'&&residents.has(step.facility)&&fixed[step.crew]!=null)fixed[step.crew]+=step.facility_count;
    }
    return fixed;
}

export function routeDispatchKey(route,recipes){
    const names=route.jobs?.map(([name])=>name).filter(Boolean)||[];
    const recipe=recipes.find(r=>r.name===route.item&&r.facility===route.facility);
    const ability=names.length?recipe?.jobs?.find(([name])=>names.includes(name))?.[1]:'Production';
    return ability?dispatchKey(route.facility,route.item,ability):null;
}

// Replace only previously charged travel. Actual execution is already allocated
// by the solver's conserved dispatch shares; the signed delta is not another job.
export function measuredDispatchWork(plan,policy,recipes){
    const walking=new Map(),delivery=new Map();
    for(const route of plan.roster_routes||[]){
        const entry=policy[routeDispatchKey(route,recipes)]?.find(e=>e.member===route.member);
        if(!entry)continue;
        const actual=entry.travel_seconds*route.visits;
        walking.set(route.member,(walking.get(route.member)||0)+actual-route.walking);
    }
    for(const step of plan.coin_items||[]){
        if(step.status!=='producing'||!(step.cycle_time>0))continue;
        const rate=(step.busy_units??step.facility_count)/step.cycle_time;
        const entries=policy[dispatchKey(step.facility,step.item_name,'Hauling')];
        for(const e of entries||[])delivery.set(e.member,(delivery.get(e.member)||0)+rate*e.share*e.travel_seconds);
    }
    return {walking:[...walking],delivery:[...delivery]};
}
