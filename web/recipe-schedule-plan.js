import {materialChains} from './material-flow-schedule.js';
import {completeFixedSchedule,validateRecipeSchedule} from './recipe-schedule.js';
import {physicalPlanPower} from './physical-power.js';
export {physicalPlanPower};
const DAY=86400, EPS=1e-7;
const add=(map,key,value)=>{map[key]=(map[key]||0)+value;};

// A private feed has one consumer and no surplus or sales. Its replenishing
// stock and the operator's remaining time determine the fixed recipe's rate.
function privateFeed(source,sources,inputs,outputs) {
    for(const [item,quantity] of source.inputs) {
        if(!(quantity>0) || sources.some(other=>other.rate>EPS && (
            (other!==source && other.inputs.some(([r])=>r===item)) || (other.turns && other.outputs.some(([r])=>r===item)))))continue;
        const used=source.rate*quantity;
        if(Math.abs((inputs[item]||0)-used)*DAY<EPS && Math.abs((outputs[item]||0)-used)*DAY<EPS)return item;
    }
    return null;
}

// Even if all of this operator's processors run flat out together, a spare
// copy can cover a switch. Charge the entire background shift as well. Crop
// visits and hauling can have additional peaks, so leave their pools tracked.
function operatorsWithSpareCapacity(plan, sources, buildings, siteCounts, capacity, productionSeconds) {
    const peak = new Map();
    for (const source of sources) {
        if (source.crew == null || source.rate <= EPS || !(capacity[source.crew] > 1)) continue;
        const sites = source.turns ? buildings.filter(b => b.facility === source.facility).length
            : siteCounts.get(`${source.facility}|${source.item}`);
        const load = sites > 0 && source.cycle > 0 ? sites * productionSeconds(source) / source.cycle : Infinity;
        peak.set(source.crew, (peak.get(source.crew) ?? 0) + load);
    }
    const spare = new Set();
    for (const [crew, load] of peak) {
        if (plan.roster_routes?.some(r => r.member === crew && r.jobs.some(([name]) => name))
            || plan.crop_assignments?.some(([, , member, work]) => member === crew && work > 0)
            || plan.hauling_staffing?.some(([member, work]) => member === crew && work > 0)) continue;
        if (plan.roster_workload?.[crew] + load < capacity[crew] - EPS) spare.add(crew);
    }
    return spare;
}

// Convert effective solver recipes (including crew speed and electric tiers),
// not the catalog's nominal recipe times, into physical daily scheduling work.
export function scheduleInputForPlan(input,plan) {
    const sources=plan.schedule_sources||[], selected=sources.filter(s=>s.turns&&s.rate>EPS);
    if(!selected.length)throw new Error('No workshop recipes to schedule');
    const buildings=[],workerCapacity={},backgroundWorkers={};
    const backgroundInputs={},backgroundOutputs={};
    const makeJob=s=>({...s,recipe:s.item,batches:s.rate*DAY,seconds:s.cycle,
        inputs:Object.fromEntries(s.inputs),outputs:Object.fromEntries(s.outputs),workers:{},haulingWorkers:{}});
    const jobs=selected.map(makeJob), fixedProduction=[];
    for(const s of sources.filter(s=>!s.turns)) {
        for(const [r,n] of s.inputs)add(backgroundInputs,r,n*s.rate);
        for(const [r,n] of s.outputs)add(backgroundOutputs,r,n*s.rate);
    }
    for(const [r,n] of Object.entries(input.quest_income_per_day||{}))add(backgroundOutputs,r.toLowerCase().replaceAll(' ','_'),n/DAY);
    for(const s of plan.income_streams||[])add(backgroundInputs,s.item_name,s.units_per_second||0);
    // A powered site's tier and mode are fixed throughout the day. It cannot
    // silently turn into an extra normal site in another interval.
    const workshops=new Set(selected.map(s=>s.facility));
    for(const facility of workshops) {
        const owned=(input.facilities?.[facility]||[]).flatMap(t=>Array.from({length:t.count},()=>({level:t.level}))).sort((a,b)=>a.level-b.level);
        const group=jobs.filter(j=>j.facility===facility), powered=new Map();
        for(const j of group)if(j.electric_level!=null)powered.set(j.electric_level,(powered.get(j.electric_level)||0)+j.rate*j.cycle);
        let serial=0;
        const site=(tier,electric)=>{
            const allowed=group.filter(j=>electric!=null?j.electric_level===electric:j.electric_level==null&&j.facility_level<=tier.level);
            buildings.push({id:`${facility}:${++serial}`,facility,level:tier.level,electric_level:electric,
                recipes:[...new Set(allowed.map(j=>j.recipe))],jobs:allowed.map(j=>j.id)});
        };
        for(const [level,busy] of powered)for(let n=0;n<Math.ceil(busy-EPS);n++) {
            const at=owned.findIndex(t=>t.level===level);
            if(at<0)throw new Error(`Insufficient powered ${facility} sites`);
            site(owned.splice(at,1)[0],level);
        }
        for(const tier of owned)site(tier,null);
    }
    const productionSeconds=j=>{
        const matches=plan.roster_routes?.filter(r=>r.member===j.crew&&r.item===j.item&&r.facility===j.facility&&!r.jobs.some(([name])=>name));
        const matchingRate=sources.filter(s=>s.crew===j.crew&&s.item===j.item&&s.facility===j.facility).reduce((v,s)=>v+s.rate,0);
        const walking=(matches||[]).reduce((v,r)=>v+(r.walking||0),0);
        return j.cycle+(matchingRate>0?walking/matchingRate:0);
    };
    const assignRosterWork=j=>{
        if(j.crew!=null)add(j.workers,String(j.crew),productionSeconds(j));
        for(const [member,load] of plan.hauling_staffing||[]) {
            const total=sources.reduce((v,s)=>v+s.rate*(s.hauling_seconds?.[member]||0),0);
            if(total>EPS){const seconds=load*(j.hauling_seconds?.[member]||0)/total;add(j.workers,String(member),seconds);j.haulingWorkers[member]=seconds;}
        }
    };

    if(input.roster) {
        input.roster.members.forEach((m,i)=>workerCapacity[i]=m.count);
        for(const [member,, ,count] of plan.assumed_aniimo||[])workerCapacity[member]=count;
        jobs.forEach(assignRosterWork);
    } else {
        // Generated teams are materialized with phase profiles on the UI side.
        // Here each exact ability/trait requirement has an independent pool.
        for(const j of jobs) {
            if(j.electric_level!=null)continue;
            const row=(plan.coin_items||[]).find(s=>s.item_name===j.item&&s.facility===j.facility&&s.electric_level==null);
            const task=row?.aniimo_tasks?.find(t=>!t.jobs?.length)||row?.aniimo;
            if(!task)throw new Error(`Missing Aniimo requirement for ${j.item}`);
            const key=`generated:${task.ability}:${task.level}:${task.personality_bonus?j.facility:''}`;
            j.workers[key]=j.cycle;
            workerCapacity[key]=buildings.filter(b=>b.electric_level==null).length;
        }
    }
    if(input.always_running) {
        // Trace interference through shared ingredients and operators. Fixed
        // recipes that can be fed and staffed per phase enter the schedule.
        const resources=new Set(jobs.flatMap(j=>[...Object.keys(j.inputs),...Object.keys(j.outputs)]));
        const members=new Set(jobs.flatMap(j=>Object.keys(j.workers)));
        const groups=new Map(), siteCounts=new Map();
        for(const source of sources) {
            if(source.turns||source.rate<=EPS)continue;
            const key=`${source.facility}|${source.item}`;
            if(!groups.has(key))groups.set(key,[]);
            groups.get(key).push(source);
        }
        for(const row of plan.coin_items||[]) {
            if(row.status!=='producing')continue;
            const key=`${row.facility}|${row.item_name}`;
            siteCounts.set(key,(siteCounts.get(key)||0)+row.facility_count);
        }
        const spare = operatorsWithSpareCapacity(plan,sources,buildings,siteCounts,workerCapacity,productionSeconds);
        const affected=new Set();
        let changed=true;
        while(changed) {
            changed=false;
            for(const [key,group] of groups) {
                if(affected.has(key))continue;
                const sharedWorkers=group.some(s=>(s.crew!=null&&!spare.has(s.crew)&&members.has(String(s.crew)))
                    || (s.hauling_seconds||[]).some((seconds,i)=>seconds>0&&members.has(String(i))));
                // A change in the downstream demand for a product cannot stall
                // its producer when its own ingredients and crew are unchanged.
                if(!sharedWorkers&&!group.some(s=>s.inputs.some(([r])=>resources.has(r))))continue;
                const work=group.reduce((n,s)=>n+s.rate*s.cycle,0), sites=siteCounts.get(key)||0;
                if(!sites||work<sites-EPS*Math.max(1,sites)) {
                    const source=group[0];
                    const feed=input.roster && sites>0 && group.length===1 && source.crew!=null
                        && privateFeed(source,sources,backgroundInputs,backgroundOutputs);
                    if(!feed)throw new Error(`Switching changes availability for ${source.item}; its phase production is not verified.`);
                    const job=makeJob(source);
                    assignRosterWork(job);
                    fixedProduction.push({...job,feed,sites});
                    for(const worker of Object.keys(job.workers))members.add(worker);
                }
                // A full-rate source with independent workers produces the
                // same batch even if demand for one of its outputs changes.
                // The phase inventory check still accounts for every output.
                if(!sharedWorkers&&group.every(s=>!s.inputs.length))continue;
                affected.add(key);changed=true;
                for(const peer of group) {
                    for(const [r] of [...peer.inputs,...peer.outputs])resources.add(r);
                    if(peer.crew!=null)members.add(String(peer.crew));
                }
            }
        }
    }
    if(input.roster) {
        const daily={};
        for(const j of [...jobs,...fixedProduction])for(const [member,seconds] of Object.entries(j.workers))add(daily,member,seconds*j.rate);
        for(const member of Object.keys(workerCapacity)) {
            const haul=(plan.hauling_staffing||[]).filter(([i])=>String(i)===member).reduce((v,[,n])=>v+n,0);
            backgroundWorkers[member]=Math.max(0,(plan.roster_workload?.[member]||0)+haul-(daily[member]||0));
            // Keep the same availability for critical crop work as in the
            // original candidate; workshop bursts may not eat that headroom.
            const critical=plan.roster_routes?.some(r=>String(r.member)===member&&r.jobs.some(([name])=>name&&name!=='Watering'));
            if(critical)workerCapacity[member]=Math.min(workerCapacity[member],backgroundWorkers[member]+(daily[member]||0));
        }
    }
    // Each workshop type can change its recipes once, at its own time.
    return {powerPercent:input.e_mode_rv>=12?120:Math.min(120,Math.max(1,input.electricity?.percent??120)),alwaysRunning:!!input.always_running,daySeconds:DAY,approximate:true,maxBuildings:buildings.length,maxSwitches:workshops.size,oneChangePerFacility:true,
        buildings,jobs,fixedProduction,workerCapacity,backgroundWorkers,backgroundInputs,backgroundOutputs,haulingLoads:Object.fromEntries(plan.hauling_staffing||[])};
}

export function attachRecipeSchedule(plan,input,schedule) {
    if(input.fixedProduction?.length && !schedule.phases.some(p=>p.fixedRates))schedule=completeFixedSchedule(input,schedule);
    const checked=validateRecipeSchedule(input,schedule);
    if(!checked.valid)throw new Error(checked.errors.join('; '));
    if(checked.fixed)schedule={...schedule,phases:checked.fixed.phases};
    const jobs=new Map(input.jobs.map(j=>[j.id,j]));
    const sites=input.buildings.map(b=>{
        const totals=new Map();
        for(const phase of schedule.phases)for(const a of phase.assignments)if(a.building===b.id)totals.set(a.job,(totals.get(a.job)||0)+a.batches);
        const peakLoad=Math.max(0,...schedule.phases.map(p=>p.assignments.filter(a=>a.building===b.id).reduce((v,a)=>v+a.batches*jobs.get(a.job).seconds,0)/Math.max(EPS,p.duration)));
        return {...b,peakLoad,jobs:[...totals].map(([id,batches])=>{const j=jobs.get(id);return {item:j.item,cycle:j.seconds,rate:batches/DAY,crew:j.crew,electric_level:j.electric_level};})};
    });
    const phaseLoad=(phase,member,field)=>phase.assignments.reduce((load,a)=>
        load+(jobs.get(a.job)[field]?.[member]||0)*a.batches,0)/Math.max(phase.duration,EPS);
    const workerProfiles=Object.fromEntries(Object.keys(input.workerCapacity).map(id=>{
        const profile=checked.fixed ? checked.fixed.periods.map(p=>p.workers[id]||0)
            : schedule.phases.map(p=>(input.backgroundWorkers[id]||0)+phaseLoad(p,id,'workers'));
        return [id,profile];
    }));
    const fixedJobs=input.fixedProduction||[];
    const haulingProfiles=Object.fromEntries(Object.entries(input.haulingLoads||{}).filter(([,n])=>n>EPS).map(([id,total])=>{
        const scheduled=[...input.jobs,...fixedJobs].reduce((n,j)=>n+(j.haulingWorkers?.[id]||0)*j.rate,0);
        const background=Math.max(0,total-scheduled);
        return [id,schedule.phases.map(p=>{
            const fixed=fixedJobs.reduce((n,j)=>n+(p.fixedRates?.[j.id]||0)*(j.haulingWorkers?.[id]||0),0);
            return (background+fixed+phaseLoad(p,id,'haulingWorkers'))/total;
        })];
    }));
    const result={...plan,proven_optimal:false,recipe_schedule:{...schedule,approximate:true,sites,
        jobs:input.jobs,fixedProduction:input.fixedProduction,buildings:input.buildings,workerProfiles,haulingProfiles,switchedBuildings:checked.switchedBuildings,switches:checked.switches}};
    const draw=physicalPlanPower(plan,sites,input.powerPercent);
    if(!Number.isFinite(draw)||draw>(plan.power_generated??0)+EPS)throw new Error('Scheduled E-mode demand exceeds available generation');
    if(draw>0||plan.power_used!=null)result.power_used=draw;
    delete result.recipe_switching_candidate;
    return result;
}

export function scheduleProfiles(plan, manualOnly = false) {
    const schedule=plan.recipe_schedule, profiles=new Map();
    if(!schedule)return profiles;
    const jobs=new Map(schedule.jobs.map(j=>[j.id,j]));
    const totals=new Map();
    for(const j of jobs.values())if(!manualOnly||j.electric_level==null)addTo(totals,`${j.facility}|${j.item}`,j.batches);
    for(const key of totals.keys())profiles.set(key,schedule.phases.map(p=>p.assignments.reduce((v,a)=>{
        const j=jobs.get(a.job);return v+((!manualOnly||j.electric_level==null)&&`${j.facility}|${j.item}`===key?a.batches:0);
    },0)/Math.max(p.duration,EPS)*DAY/totals.get(key)));
    for(const j of schedule.fixedProduction||[])if(!manualOnly||j.electric_level==null){
        profiles.set(`${j.facility}|${j.item}`,schedule.phases.map(p=>(p.fixedRates?.[j.id]||0)/j.rate));
    }
    return profiles;
}
function addTo(map,key,value){map.set(key,(map.get(key)||0)+value);}

export function haulingScheduleProfile(plan,hauling,level=3) {
    if(!plan.recipe_schedule||!hauling?.jobs?.length)return undefined;
    const profiles=scheduleProfiles(plan),total=hauling.jobs.reduce((n,j)=>n+j.rate*j.seconds[level],0);
    if(total<=EPS)return undefined;
    return plan.recipe_schedule.phases.map((_,p)=>hauling.jobs.reduce((n,j)=>n+j.rate*j.seconds[level]*(profiles.get(j.key)?.[p]??1),0)/total);
}
// Fast, easy-to-follow chain: two raw processors in the morning, then one
// switches to tier 3. Tier 2 and (if present) tier 4 retain their recipes.
export function materialChainSchedule(input) {
    if(!input.maxSwitches||input.buildings.some(b=>b.electric_level!=null)||input.jobs.some(j=>!materialChains[j.facility]?.includes(j.recipe)))return null;
    const buildings=input.buildings.map(b=>({...b}));
    const facilities=new Set(input.jobs.map(j=>j.facility));
    const maxSwitches=Math.min(input.maxSwitches,facilities.size);
    for(const facility of facilities){
        const chain=materialChains[facility],sites=buildings.filter(b=>b.facility===facility);
        const hasLast=input.jobs.some(j=>j.facility===facility&&j.recipe===chain[3]);
        if(sites.length<(hasLast?4:3))return null;
        sites.forEach((b,i)=>{
            const fixed=i===2?chain[1]:i===3&&hasLast?chain[3]:chain[0];
            b.phaseRecipes=Array.from({length:maxSwitches+1},(_,phase)=>{
                if(i!==1)return [fixed];
                if(phase===0)return [chain[0]];
                return phase===maxSwitches?[chain[2]]:[chain[0],chain[2]];
            });
        });
    }
    return {...input,buildings,maxSwitches};
}
