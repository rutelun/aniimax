import {workerTravelSeconds} from './worker-travel.js';

const HOUR=3600, SAMPLES=8;
export const REGROWTH_TARGET_SECONDS=21;

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

function originDistribution(points) {
    let end=0;
    return (points??[]).filter(p=>p.weight>0).map(p=>({point:p.point,end:end+=p.weight}));
}

// A free worker can pick up another job while the plot grows. Model the measured
// share and duration as alternating busy/free intervals, staggered per copy.
// A crop request arriving during a trip waits for the outstanding trip and
// approaches from the worker's last workplace or storage.
function availability(worker,release) {
    if(release<=worker.ready || !worker.occupied || !worker.duration)return Math.max(release,worker.ready);
    const elapsed=release-worker.ready-worker.freeInterval;
    if(elapsed<0)return release;
    return release+Math.max(0,worker.duration-elapsed%worker.period);
}

function currentPoint(worker,release) {
    const elapsed=release-worker.ready-worker.freeInterval;
    if(elapsed<0 || !worker.occupied || !worker.duration || release<=worker.ready)return worker.point;
    const visits=Math.floor(elapsed/worker.period)+1;
    const phase=(worker.phase+visits*.61803398875+worker.served*.38196601125)%1;
    const delivered=worker.stores.length && (worker.phase+visits*.38196601125+worker.served*.61803398875)%1<worker.deliveryFraction;
    return locationAt(delivered?worker.stores:worker.origins,phase,worker.point);
}

function prepareWorker(id,copy,sample,other,fixed,base,mobile) {
    const phase=((sample+.5)/SAMPLES+copy*.61803398875+id*.38196601125)%1;
    // Production is packed into the busy copies. Any copy with free capacity
    // can take this pool's deliveries; preserve the pool's total hauling load.
    const hauling=other.hauling??0;
    const otherBusy=Math.max(0,(other.busy||0)-hauling);
    const work=Math.min(1,Math.max(0,otherBusy-copy));
    const haulingShare=(1-work)*Math.min(1,hauling/Math.max(1e-12,mobile-otherBusy));
    const occupied=work+haulingShare;
    const duration=occupied ? (work*(other.otherSeconds??other.seconds??0)+haulingShare*(other.tripSeconds??0))/occupied : 0;
    const origins=originDistribution(other.origins);
    const starting=copy+fixed>=base && other.peakOrigins?.length ? originDistribution(other.peakOrigins):origins;
    const period=occupied?duration/occupied:Infinity;
    return {id,copy:copy+fixed,phase,occupied,duration,period,origins,served:0,
        stores:originDistribution(other.storageOrigins),deliveryFraction:occupied?haulingShare/occupied:0,
        ready:phase<occupied?duration*(1-phase/occupied):0,
        point:locationAt(starting,phase,other.point??[0,0]),freeInterval:(period-duration)*(1-phase)};
}

function normalizedShares(tallies,copy) {
    const shares={};
    for(const [key,row] of tallies){
        const total=[...row.values()].reduce((a,b)=>a+b,0);
        shares[key]=[...row].map(([index,value])=>copy?[index,value/total]:{member:index,share:value/total});
    }
    return shares;
}

function record(tallies,key,index) {
    let row=tallies.get(key);
    if(!row)tallies.set(key,row=new Map());
    row.set(index,(row.get(index)||0)+1);
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
export function recurringCropWork({jobs,members,counts,permanent,outside},allocation) {
    const plots=[],byJob=new Map();
    for(const job of jobs){
        let plot=byJob.get(job.previous);
        if(!plot){plot={cycle:job.cycle,steps:[]};plots.push(plot);}
        plot.steps.push(job);
        byJob.set(job.id,plot);
    }
    const end=HOUR+Math.max(23*HOUR,...plots.map(p=>2*p.cycle));
    const assigned=new Map(),copies=new Map();
    let total=0,observations=0,totalWait=0,latest=0;
    for(let sample=0;sample<SAMPLES;sample++){
        const workers=allocation.flatMap((n,id)=>{
            const fixed=permanent[id]||0, mobile=Math.max(0,n-fixed);
            return Array.from({length:mobile},(_,copy)=>prepareWorker(id,copy,sample,outside[id]||{},fixed,counts[id],mobile));
        });
        const events=plots.map(({steps,cycle},order)=>{
            const stations=steps.map(job=>({job,eligible:workers.filter(w=>Number.isFinite(job.seconds[w.id])
                && (members[w.id].abilities?.[job.ability]||0)>=job.level
                && (!job.eligibleMembers || job.eligibleMembers.includes(w.id)))}));
            const firstPlant=steps.findIndex(j=>j.name==='Reclaiming'||j.name==='Sowing');
            return {stations,cycle,order,step:Math.max(0,firstPlant),release:0,ripe:0};
        });
        const uncovered=events.reduce((n,e)=>n+e.stations.filter(s=>!s.eligible.length).length,0);
        if(uncovered)return {uncovered,wait:Infinity,completion:Infinity,worstCompletion:Infinity,shares:{},copyShares:{}};
        while(events.length){
            const event=events[0];
            const {job,eligible}=event.stations[event.step], release=event.release;
            let worker=eligible[(sample+(job.order||0))%eligible.length],ready=availability(worker,release);
            for(const w of eligible){
                const t=availability(w,release);
                if(t<ready-1e-8){worker=w;ready=t;}
            }
            const from=currentPoint(worker,release);
            const approach=workerTravelSeconds(Math.hypot(from[0]-job.point[0],from[1]-job.point[1]));
            worker.ready=ready+approach+job.seconds[worker.id];
            worker.point=job.point;worker.served++;
            worker.freeInterval=(worker.period-worker.duration)*(1-(worker.phase+worker.served*.61803398875)%1);
            if(event.ripe>=HOUR){
                totalWait+=ready+approach-release;
                record(assigned,job.key,worker.id);
                record(copies,job.key+'|'+worker.id,worker.copy);
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
