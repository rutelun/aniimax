import { dispatchLocations } from './task-switching.js';
import { siteHaulingTrips } from './hauling.js';
import { workerTravelSeconds } from './worker-travel.js';
import { deliveryRouting, deliveryApproach } from './delivery-routing.js';
import { FACILITIES, FACILITY_CATEGORY_BY_NAME } from './facility-config.js';

const center=r=>[r.x+r.w/2,r.y+r.h/2];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
export const dispatchKey=(facility,item,ability)=>`${facility}|${item}|${ability}`;
const productionTraits=new Map(FACILITIES.map(f=>[f.name,f.personality]));

// When a processor can start another batch, its previous batch has finished.
// Other work (including hauling) still occupies the worker. Weight only copies
// actually in the team; the rest of an owned or assumed pool is not on site.
function productionPickup(recipe,eligible,ownRoutes,members,busy,permanent){
    const ownWork=new Map(),trait=productionTraits.get(recipe.facility);
    for(const r of ownRoutes){
        const load=r.jobs.reduce((sum,[,work])=>sum+work,0);
        ownWork.set(r.member,(ownWork.get(r.member)||0)+load);
    }
    const available=[],onShift=[],speeds=new Set();
    for(const {member} of eligible){
        const m=members[member],load=busy[member]||0;
        speeds.add(m.abilities[recipe.aniimo[0]]+'|'+Boolean(trait&&m.personalities?.includes(trait)));
        const copies=Math.min(m.count,Math.ceil(load-1e-6));
        const fixed=permanent[member]||0;
        if(copies<=fixed)continue;
        onShift.push({member,share:copies-fixed});
        const away=Math.max(fixed,load-(ownWork.get(member)||0));
        const free=copies-away;
        if(free<=1e-9)continue;
        available.push({member,share:free});
    }
    if(speeds.size<2)return null;
    return available.length ? available : onShift;
}

// A dispatch policy covers every copy of a recipe. Reserve the actual output
// of continuously staffed copies before distributing requests from open ones.
function keepStaffedSites(entries,sites,eligible) {
    if (!sites?.some(s=>s.occupied && eligible.has(s.crew))) return entries;
    const rate=sites.reduce((sum,s)=>sum+s.rate,0);
    const reserved=new Map();
    for (const site of sites) {
        if (site.occupied && eligible.has(site.crew)) {
            reserved.set(site.crew,(reserved.get(site.crew)??0)+site.rate/rate);
        }
    }
    const free=1-[...reserved.values()].reduce((sum,n)=>sum+n,0);
    const total=entries.reduce((sum,e)=>sum+e.share,0);
    const remainder=entries.map(e=>({...e,share:Math.max(0,e.share/total-(reserved.get(e.member)??0))}));
    const available=remainder.reduce((sum,e)=>sum+e.share,0);
    if (free>1e-12 && available>0) for (const e of remainder) {
        if (e.share>0) reserved.set(e.member,(reserved.get(e.member)??0)+free*e.share/available);
    }
    return [...reserved].map(([member,share])=>({member,share}));
}

// Identical recipes do not imply one worker visits every physical building.
// Bind only unambiguous single-copy, single-task workers. Mobile workers and
// couriers retain the full set of possible origins/destinations.
function activeOutputs(sites){
    return new Set(sites.flatMap(s=>(s.jobs||[{item:s.crop,rate:s.batchWeight??s.weight,electric_level:s.electric_level}])
        .filter(j=>j.item&&j.rate>0).flatMap(j=>{
            const prefix=`${s.facility}|${j.item}`;
            return [`${prefix}|Hauling`,...(j.electric_level==null?[`${prefix}|Production`]:[]),
                ...(['Farmland','Woodland'].includes(s.facility)?[`${prefix}|Crop`]:[])];
        })));
}
function focusedWorkers(sites,members,routes,policy){
    const active=activeOutputs(sites), workers=new Map(), mobile=new Set();
    for(const route of routes){
        const id=route.member;
        if(!(route.job_rate>0)||members[id]?.count!==1||mobile.has(id))continue;
        const key=dispatchKey(route.facility,route.item,'Production'), worker=workers.get(id);
        if(route.jobs?.some(([name])=>name)||(worker&&worker.key!==key)){
            workers.delete(id);
            mobile.add(id);
        }else workers.set(id,{key,rate:(worker?.rate||0)+route.job_rate});
    }
    for(const [key,entries] of Object.entries(policy)){
        if(!active.has(key)&&!active.has(key.slice(0,key.lastIndexOf('|'))+'|Crop'))continue;
        for(const e of entries)if(e.share>1e-12&&workers.get(e.member)?.key!==key)workers.delete(e.member);
    }
    return workers;
}
function taskSites(targets,member,facility,item,workers){
    const key=dispatchKey(facility,item,'Production');
    if(workers.get(member)?.key!==key)return targets;
    const rateOf=id=>workers.get(id).rate;
    const siteRate=s=>s.jobs?s.jobs.filter(j=>j.item===item&&j.electric_level==null).reduce((sum,j)=>sum+(j.rate||0),0):(s.batchWeight??s.weight??0)/3600;
    const matches=(id,s)=>Math.abs(rateOf(id)-siteRate(s))<=1e-9+Math.max(rateOf(id),siteRate(s))*1e-6;
    const own=targets.filter(s=>s.crew===member||s.jobs?.some(j=>j.item===item&&j.crew===member));
    if(own.length===1&&matches(member,own[0]))return own;
    if(targets.some(s=>s.crew!=null||s.jobs?.some(j=>j.item===item&&j.crew!=null)))return targets;
    const peers=[...workers.keys()].filter(id=>workers.get(id).key===key).sort((a,b)=>a-b);
    if(peers.length!==targets.length)return targets;
    const remaining=[...targets],assigned=new Map();
    for(const id of peers){
        const index=remaining.findIndex(s=>matches(id,s));
        if(index<0)return targets;
        assigned.set(id,remaining.splice(index,1)[0]);
    }
    return [assigned.get(member)];
}

// Expected random dispatch among eligible free workers. A policy allocates ONE
// original request across workers; it never adds a second copy of its execution.
// Arrival estimates start at previous work sites, not at the new request site.
export function buildReactiveDispatch({layout,recipes,members,busy=[],permanent=[],routes=[],previous=null,deliveryCopies=[]}){
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
        const roles=FACILITY_CATEGORY_BY_NAME.get(recipe.facility)==='Aniimo Materials'?[]:recipe.aniimo?[['Production',recipe.aniimo[0],recipe.aniimo[1]]]
            :[...new Map((recipe.jobs||[]).map(([,a,l])=>[a,[a,a,l]])).values()];
        roles.push(['Hauling','Hauling',1]);
        for(const [keyAbility,ability,level] of roles){
            const key=dispatchKey(recipe.facility,recipe.name,keyAbility);
            const eligible=members.flatMap((member,i)=>{
                let capacity=member.count;
                if(member.assumed){
                    capacity=Math.ceil((busy[i]||0)-1e-6);
                    if(keyAbility==='Hauling'){
                        const retained=previous?.[key]?.some(entry=>entry.member===i && entry.share>0);
                        capacity=Math.min(member.count,Math.max(capacity,deliveryCopies[i]||0,Number(!!retained)));
                    }
                }
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
            if(!entries?.length&&keyAbility==='Production'&&recipe.ingredients?.length){
                entries=productionPickup(recipe,eligible,planned.get(key)||[],members,busy,permanent);
            }
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
            if (keyAbility==='Production') entries=keepStaffedSites(entries,locations.get(`${recipe.facility}|${recipe.name}`),valid);
            const shares=entries.reduce((s,e)=>s+e.share,0);
            // Shares determine delivery origins. Price each route once, after
            // those origins and the destinations of loaded trips are known.
            policy[key]=entries.map(e=>({member:e.member,share:e.share/shares,travel_seconds:0}));
        }
    }
    const routed={storages:layout.storages,pieces:layout.pieces.map(p=>({...p,members:p.members.map(m=>({...m}))}))};
    const focused=focusedWorkers(sites,members,routes,policy);
    attachDeliveryFlows(routed,policy,recipes,members,routes,focused);
    const flow=deliveryRouting(routed);
    // A worker approaches a physical site from the same distribution of
    // origins for every recipe. Its loaded trip also ends at the same depot.
    const tripsBySite=new Map();
    const tripTo=site=>{
        let trip=tripsBySite.get(site);
        if(!trip){
            const point=center(site);
            trip={point,walks:new Map()};
            tripsBySite.set(site,trip);
        }
        return trip;
    };
    const walkTo=(member,site)=>{
        const trip=tripTo(site);
        if(!trip.walks.has(member)){
            const walk=deliveryApproach(flow,member,trip.point);
            trip.walks.set(member,walk==null?null:workerTravelSeconds(walk));
        }
        return trip.walks.get(member);
    };
    for(const recipe of recipes){
        const physical=byFacility.get(recipe.facility);if(!physical?.length)continue;
        const exact=physical.filter(r=>r.crop===recipe.name||r.jobs?.some(j=>j.item===recipe.name));
        const targets=exact.length?exact:physical;
        const workTargets=targets.filter(s=>s.jobs?s.jobs.some(j=>j.item===recipe.name&&j.electric_level==null):s.electric_level==null);
        const abilities=recipe.aniimo?['Production']:[...new Set((recipe.jobs||[]).map(([,ability])=>ability))];
        for(const ability of abilities)for(const e of policy[dispatchKey(recipe.facility,recipe.name,ability)]||[]){
            const workerTargets=workTargets.length&&ability==='Production'?taskSites(workTargets,e.member,recipe.facility,recipe.name,focused):workTargets;
            const values=workerTargets.map(s=>walkTo(e.member,s));
            e.travel_seconds=values.length&&values.every(v=>v!=null)
                ?values.reduce((sum,v)=>sum+v,0)/values.length
                :targets.reduce((sum,target)=>sum+approach(e.member,center(target)),0)/targets.length;
        }
        for(const e of policy[dispatchKey(recipe.facility,recipe.name,'Hauling')]||[]){
            const rates=exact.some(s=>s.schedulePhases?.length)?targets.map(s=>s.jobs?s.jobs.filter(j=>j.item===recipe.name).reduce((n,j)=>n+j.rate,0)
                :(s.batchWeight??s.weight??0)/3600):[];
            const total=rates.reduce((n,r)=>n+r,0);
            e.travel_seconds=targets.reduce((sum,target,index)=>{
                const trip=tripTo(target),walk=walkTo(e.member,target);
                trip.loaded??=workerTravelSeconds(layout.storages?.length
                    ?Math.min(...layout.storages.map(s=>distance(trip.point,center(s)))):0);
                return sum+((walk??approach(e.member,trip.point))+trip.loaded)
                    *siteHaulingTrips(target,recipe.name,recipe,members[e.member].abilities.Hauling)*(total>0?rates[index]/total:1/targets.length);
            },0);
        }
    }
    return policy;
}

// Rates are completed trips/jobs per hour. Coordinates can be assigned later by
// the layout worker; worker identities travel with each physical building.
export function attachDeliveryFlows(layout,policy,recipes,members,routes=[],focused){
    const recipeOf=new Map(recipes.map(r=>[r.name,r]));
    const sites=layout.pieces.flatMap(p=>p.members);
    focused??=focusedWorkers(sites,members,routes,policy);
    for(const s of sites){
        s.deliveryWorkers=[];s.deliveryOrigins=[];
        const weights=new Map();
        for(const job of s.jobs||[{item:s.crop,rate:(s.batchWeight??s.weight??0)/3600}]){
            const recipe=recipeOf.get(job.item);
            const entries=policy[dispatchKey(s.facility,job.item,'Hauling')];
            for(const e of entries||[]){
                const trips=job.rate*3600*e.share*siteHaulingTrips(s,job.item,recipe,members[e.member]?.abilities.Hauling||3);
                weights.set(e.member,(weights.get(e.member)||0)+trips);
            }
        }
        s.deliveryWorkers=[...weights].filter(([,rate])=>rate>0);
    }
    for(const route of routes){
        if(!(route.job_rate>0))continue;
        let targets=sites.filter(s=>s.facility===route.facility&&(s.jobs
            ?s.jobs.some(j=>j.item===route.item&&j.electric_level==null):s.crop===route.item&&s.electric_level==null));
        if(routeDispatchKey(route,recipes)===dispatchKey(route.facility,route.item,'Production')){
            targets=taskSites(targets,route.member,route.facility,route.item,focused);
        }
        const rates=targets.map(s=>s.jobs?s.jobs.filter(j=>j.item===route.item&&j.electric_level==null)
            .reduce((sum,j)=>sum+Math.max(0,j.rate||0),0):Math.max(0,s.batchWeight??s.weight??0)/3600);
        const total=rates.reduce((sum,rate)=>sum+rate,0);
        targets.forEach((s,i)=>{if(total>0&&rates[i]>0)s.deliveryOrigins.push([route.member,route.job_rate*3600*rates[i]/total]);});
    }
}

export function permanentWorkers(plan,members,residents){
    const fixed=members.map(()=>0);
    for(const [,member,count] of plan.staffing||[])if(fixed[member]!=null)fixed[member]+=count;
    for(const step of plan.coin_items||[]){
        if(step.status==='producing'&&residents.has(step.facility)&&fixed[step.crew]!=null)fixed[step.crew]+=step.facility_count;
    }
    return fixed.map(count=>Math.max(0,Math.ceil(count-1e-6)));
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


// Measurement precedes the solver pass that adds a dedicated Hauling pool.
// Use the same trailing pool index as the solver when pricing that first route.
export function measureRosterDispatch(context,plan,previous,reserveLimit){
    const {members,busy,permanent,recipes}=context;
    function measure(candidate,deliveryCopies=[]){
        const policy=buildReactiveDispatch({...candidate,previous,deliveryCopies});
        return {context:candidate,policy,...measuredDispatchWork(plan,policy,recipes)};
    }
    const initial=measure(context);
    if(previous || !(reserveLimit>0) || !Number.isFinite(reserveLimit))return initial;
    const walking=new Map(initial.walking);
    const occupied=members.map((_,i)=>Math.max(permanent[i]||0,Math.ceil((busy[i]||0)+(walking.get(i)||0)-1e-6)));
    const free=reserveLimit-occupied.reduce((total,count)=>total+count,0);
    if(free<=0)return initial;
    let excess=0;
    for(const [i,load] of initial.delivery){
        const capacity=members[i].assumed?occupied[i]:members[i].count;
        const spare=Math.max(0,capacity-(busy[i]||0)-(walking.get(i)||0));
        excess+=Math.max(0,load-spare);
    }
    const unassigned=plan.coin_items?.some(step=>step.status==='producing' && step.cycle_time>0 &&
        (step.busy_units??step.facility_count)>0 && !initial.policy[dispatchKey(step.facility,step.item_name,'Hauling')]?.length);
    const needed=Math.min(free,Math.max(Number(!!unassigned),Math.ceil(excess-1e-7)));
    if(needed<=0)return initial;
    let id=members.findIndex(member=>member?.assumed && member.abilities?.Hauling);
    let candidate=context;
    if(id<0){
        id=members.length;
        candidate={...context,members:[...members,{assumed:true,count:needed,abilities:{Hauling:3},personalities:[]}],
            busy:[...busy,0],permanent:[...permanent,0]};
    }
    const copies=[];
    copies[id]=Math.min(candidate.members[id].count,(occupied[id]||0)+needed);
    const proposed=measure(candidate,copies);
    return proposed.delivery.some(([member,load])=>member===id && load>0)?proposed:initial;
}
