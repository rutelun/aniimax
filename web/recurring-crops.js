import {workerTravelSeconds} from './worker-travel.js';

const HOUR=3600, SAMPLES=8;
export const REGROWTH_TARGET_SECONDS=21;
export const MAX_GROWER_OUTSIDE=0.10;
const fraction = value => value-Math.floor(value);

function locationAt(origins,phase,fallback) {
    if(!origins.length)return fallback;
    const mark=phase*origins.at(-1).end;
    let low=0,high=origins.length-1;
    while(low<high){
        const mid=(low+high)>>>1;
        if(origins[mid].end<mark)low=mid+1;
        else high=mid;
    }
    return origins[low].point;
}

function originDistribution(points,pointIndex) {
    let end=0;
    return (points??[]).filter(p=>p.weight>0).map(p=>({point:pointIndex(p.point),end:end+=p.weight}));
}

// A free worker can pick up another job while the plot grows. Model the measured
// share and duration as alternating busy/free intervals, staggered per copy.
// A crop request arriving during a trip waits for the outstanding trip and
// approaches from the worker's last workplace or storage.
function availability(worker,release) {
    if(release<=worker.ready)return worker.ready;
    if(!worker.occupied || !worker.duration)return release;
    const elapsed=release-worker.ready-worker.freeInterval;
    if(elapsed<0)return release;
    return release+Math.max(0,worker.duration-(elapsed<worker.period?elapsed:elapsed%worker.period));
}

function currentPoint(worker,release) {
    const elapsed=release-worker.ready-worker.freeInterval;
    if(elapsed<0 || !worker.occupied || !worker.duration || release<=worker.ready)return worker.point;
    const visits=Math.floor(elapsed/worker.period)+1;
    const phase=fraction(worker.phase+visits*.61803398875+worker.served*.38196601125);
    const delivered=worker.stores.length && fraction(worker.phase+visits*.38196601125+worker.served*.61803398875)<worker.deliveryFraction;
    return locationAt(delivered?worker.stores:worker.origins,phase,worker.point);
}

// Workshop shifts are packed first. If the measured plot work fits on the
// remaining copies, the grower need never leave for the workshop. Deliveries
// use residual capacity and can delay a crop request in the simulation.
export function firstGrowerCopy(mobile,other) {
    if(!mobile || !(other.workshop>0))return 0;
    const workshop=Math.min(mobile,other.workshop);
    const clean=Math.max(0,mobile-Math.ceil(workshop-1e-9));
    const free=mobile-workshop;
    const afterHauling=free>0?Math.max(0,1-(other.hauling||0)/free):0;
    if(clean && clean*afterHauling >= other.plotWork-1e-9)return mobile-clean;
    return Math.min(mobile-1,Math.floor(workshop+1e-9));
}

function prepareWorker(id,copy,other,fixed,base,mobile) {
    // Production is packed into the busy copies. Any copy with free capacity
    // can take this pool's deliveries; preserve the pool's total hauling load.
    const hauling=other.hauling??0;
    const otherBusy=Math.max(0,(other.busy||0)-hauling);
    const work=Math.min(1,Math.max(0,otherBusy-copy));
    const haulingShare=(1-work)*Math.min(1,hauling/Math.max(1e-12,mobile-otherBusy));
    const occupied=work+haulingShare;
    const duration=occupied ? (work*(other.otherSeconds??other.seconds??0)+haulingShare*(other.tripSeconds??0))/occupied : 0;
    const origins=other.origins;
    const starting=copy+fixed>=base && other.hasPeakOrigins ? other.peakOrigins:origins;
    const period=occupied?duration/occupied:Infinity;
    return {id,copy:copy+fixed,mobileCopy:copy,starting,home:other.point,phase:0,occupied,duration,period,origins,served:0,
        stores:other.storageOrigins,deliveryFraction:occupied?haulingShare/occupied:0,
        ready:0,point:0,freeInterval:0};
}

function startSample(worker,sample) {
    const phase=((sample+.5)/SAMPLES+worker.mobileCopy*.61803398875+worker.id*.38196601125)%1;
    worker.phase=phase;
    worker.served=0;
    worker.ready=phase<worker.occupied?worker.duration*(1-phase/worker.occupied):0;
    worker.point=locationAt(worker.starting,phase,worker.home);
    worker.freeInterval=(worker.period-worker.duration)*(1-phase);
}

function normalizedShares(tallies,copy) {
    const shares={};
    for(const [key,row] of tallies){
        const total=[...row.values()].reduce((a,b)=>a+b.count,0);
        shares[key]=[...row].map(([index,value])=>copy?[index,value.count/total]:{member:index,share:value.count/total});
    }
    return shares;
}

function shareCounter(tallies,key,index) {
    let row=tallies.get(key);
    if(!row)tallies.set(key,row=new Map());
    let counter=row.get(index);
    if(!counter)row.set(index,counter={count:0});
    return counter;
}

// When several plots become ready simultaneously, keep their original order.
function earlier(a,b) {
    return a.release<b.release || (a.release===b.release && a.order<b.order);
}

// Only the earliest event changes. Its next operation is always at or after
// its previous release, so restoring the heap needs a single downward pass.
function advance(events,event,finished) {
    if(finished){
        event=events.pop();
        if(!events.length)return;
    }
    let i=0;
    while(2*i+1<events.length){
        let child=2*i+1;
        if(child+1<events.length && earlier(events[child+1],events[child]))child++;
        if(!earlier(events[child],event))break;
        events[i]=events[child];i=child;
    }
    events[i]=event;
}

// Each plot owns its next maturity timestamp. The observation window is
// selected by maturity time, so late completions aren't silently dropped.
export function prepareRecurringCropWork({jobs,members,counts,permanent,outside}) {
    // The location catalog and travel times are fixed across all helper
    // allocations and all eight dispatch samples for this map.
    const indices=new Map(),points=[];
    function pointIndex(point) {
        const key=point[0]+','+point[1];
        if(!indices.has(key)){indices.set(key,points.length);points.push(point);}
        return indices.get(key);
    }
    const outsideWork=members.map((_,id)=>{
        const other=outside[id]??{};
        return {...other,hasPeakOrigins:!!other.peakOrigins?.length,point:pointIndex(other.point??[0,0]),origins:originDistribution(other.origins,pointIndex),
            peakOrigins:originDistribution(other.peakOrigins,pointIndex),storageOrigins:originDistribution(other.storageOrigins,pointIndex)};
    });
    const plots=[],byJob=new Map(),travel=new Map();
    for(const job of jobs){
        let plot=byJob.get(job.previous);
        if(!plot){plot={cycle:job.cycle,steps:[]};plots.push(plot);}
        const point=pointIndex(job.point);
        if(!travel.has(point))travel.set(point,[]);
        plot.steps.push({job,point,travel:travel.get(point),eligibleMembers:members.flatMap((m,id)=>
            Number.isFinite(job.seconds[id]) && (m.abilities?.[job.ability]||0)>=job.level &&
            (!job.eligibleMembers || job.eligibleMembers.includes(id)) ? [id]:[])});
        byJob.set(job.id,plot);
    }
    for(const [at,row] of travel){
        const dest=points[at];
        for(const origin of points)
            row.push(workerTravelSeconds(Math.hypot(origin[0]-dest[0],origin[1]-dest[1])));
    }
    const end=HOUR+Math.max(23*HOUR,...plots.map(p=>2*p.cycle));
    return (allocation,trackShares=true)=>simulateDay(plots,end,counts,permanent,outsideWork,allocation,trackShares);
}

function simulateDay(plots,end,counts,permanent,outside,allocation,trackShares) {
    const assigned=new Map(),copies=new Map();
    let total=0,observations=0,totalWait=0,latest=0;
    const workers=allocation.map((n,id)=>{
        const fixed=permanent[id]||0, mobile=Math.max(0,n-fixed);
        const first=firstGrowerCopy(mobile,outside[id]);
        return Array.from({length:mobile-first},(_,i)=>prepareWorker(id,first+i,outside[id],fixed,counts[id],mobile));
    });
    const mobileWorkers=workers.flat();
    mobileWorkers.forEach((worker,index)=>{worker.index=index;});
    const countersByJob=new Map();
    const templates=plots.map(({steps,cycle},order)=>{
        const stations=steps.map(step=>{
            const key=step.job.key;
            if(trackShares && !countersByJob.has(key))countersByJob.set(key,[]);
            return {job:step.job,point:step.point,travel:step.travel,first:null,
                counters:countersByJob.get(key),eligible:step.eligibleMembers.flatMap(id=>workers[id]??[])};
        });
        const firstPlant=steps.findIndex(s=>s.job.name==='Reclaiming'||s.job.name==='Sowing');
        return {stations,cycle,order,step:Math.max(0,firstPlant),release:0,ripe:0};
    });
    const uncovered=templates.reduce((n,e)=>n+e.stations.filter(s=>!s.eligible.length).length,0);
    if(uncovered)return {uncovered,wait:Infinity,completion:Infinity,worstCompletion:Infinity,shares:{},copyShares:{}};
    for(let sample=0;sample<SAMPLES;sample++){
        for(const worker of mobileWorkers)startSample(worker,sample);
        // The rotated first choice depends only on the sample and station.
        const events=templates.map(({stations,cycle,order,step})=>{
            for(const station of stations){
                const index=(sample+(station.job.order||0))%station.eligible.length;
                station.first=station.eligible[index];
            }
            return {stations,cycle,order,step,release:0,ripe:0};
        });
        while(events.length){
            const event=events[0];
            const {job,eligible,point,travel,counters,first}=event.stations[event.step], release=event.release;
            let worker=first,ready=availability(worker,release);
            // No worker can start before release. Preserve the rotated first
            // choice and existing tie tolerance as soon as that bound is reached.
            if (release < ready-1e-8) for(const w of eligible){
                if (w.ready>=ready-1e-8) continue;
                const t=availability(w,release);
                if(t<ready-1e-8){
                    worker=w;ready=t;
                    if (!(release < ready-1e-8)) break;
                }
            }
            const from=currentPoint(worker,release);
            const approach=travel[from];
            worker.ready=ready+approach+job.seconds[worker.id];
            worker.point=point;
            if (worker.duration && worker.occupied) {
                worker.served++;
                worker.freeInterval=(worker.period-worker.duration)*(1-fraction(worker.phase+worker.served*.61803398875));
            }
            if(event.ripe>=HOUR){
                totalWait+=ready+approach-release;
                if (trackShares) {
                    // Repeated visits increment the same two counters. Register
                    // them on first service to preserve dispatch tie ordering.
                    const pair=counters[worker.index]??(counters[worker.index]=[
                        shareCounter(assigned,job.key,worker.id),
                        shareCounter(copies,job.key+'|'+worker.id,worker.copy)]);
                    pair[0].count++;
                    pair[1].count++;
                }
            }
            if(++event.step<event.stations.length){
                event.release=worker.ready;
            }else{
                if(event.ripe>=HOUR){
                    observations++;const elapsed=worker.ready-event.ripe;
                    total+=elapsed;latest=Math.max(latest,elapsed);
                }
                event.step=0;event.ripe=worker.ready+event.cycle;event.release=event.ripe;
            }
            advance(events,event,event.ripe>=end);
        }
    }
    return {completion:observations?total/observations:(plots.length?Infinity:0),wait:observations?totalWait/observations:0,
        worstCompletion:latest,observations,shares:normalizedShares(assigned,false),copyShares:normalizedShares(copies,true)};
}

export function recurringCropWork(input,allocation) {
    return prepareRecurringCropWork(input)(allocation);
}
