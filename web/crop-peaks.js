import { workerTravelSeconds } from './worker-travel.js';
import { dispatchLocations } from './task-switching.js';
import { prepareRecurringCropWork, REGROWTH_TARGET_SECONDS } from './recurring-crops.js';

const EPS=1e-8;
export const CROP_PEAK_TARGET_SECONDS=100;
export const criticalCropJob = name => ['Reaping','Logging','Collecting','Reclaiming','Sowing'].includes(name);

export function cropPeakInput({layout,recipes,members,busy,permanent=[],routes=[],limit=Infinity,delivery=[]}) {
    const locations=dispatchLocations(layout),byRecipe=new Map(recipes.map(r=>[`${r.facility}|${r.name}`,r]));
    const outside=members.map(()=>({busy:0,seconds:0,origins:[]}));
    const critical=members.map(()=>0),reference=new Map(),assigned=new Map();
    for(const r of routes){
        if(!(r.job_rate>0)||!outside[r.member])continue;
        const recipe=byRecipe.get(`${r.facility}|${r.item}`);
        const work=(r.jobs||[]).reduce((sum,[,n])=>sum+n,0)+(r.walking||0);
        const urgent=(r.jobs||[]).some(([name])=>criticalCropJob(name));
        if(urgent)critical[r.member]+=work;
        else {outside[r.member].busy+=work;outside[r.member].seconds+=work*work/(r.visits||r.job_rate);}
        for(const [name,load] of r.jobs||[]){
            const job=recipe?.jobs?.find(j=>j[0]===name);
            if(!job||!criticalCropJob(name))continue;
            const [,ability,level]=job,skill=members[r.member].abilities?.[ability]||0;
            const speed=1+.25*(level-1)+.5*(skill-level);
            const canonical=recipe.job_workloads?.find(([job])=>job===name)?.[1];
            reference.set(`${r.facility}|${r.item}|${name}`,canonical ?? load/(r.job_rate/r.jobs.length)*speed);
            const key=`${r.facility}|${r.item}|${ability}`;
            if(!assigned.has(key))assigned.set(key,new Set());
            assigned.get(key).add(r.member);
        }
        for(const site of locations.get(`${r.facility}|${r.item}`)||[])outside[r.member].origins.push({point:site.point,weight:site.rate});
    }
    const loads=busy.map((n,i)=>n+(delivery.find(([id])=>id===i)?.[1]||0));
    const sources=layout.pieces.flatMap(p=>p.members.flatMap(s=>(s.jobs||[{item:s.crop,rate:(s.batchWeight??s.weight??0)/3600}])
        .filter(j=>j.rate>0).map(j=>({point:[s.x+s.w/2,s.y+s.h/2],rate:j.rate})))),stores=layout.storages||[];
    const point=s=>[s.x+s.w/2,s.y+s.h/2];
    outside.forEach((o,i)=>{
        const measured=o.busy;
        const hauling=delivery.find(([id])=>id===i)?.[1]||0;
        o.otherSeconds=measured>0?o.seconds/measured:0;
        o.hauling=hauling;
        if(hauling>0&&stores.length&&sources.length){
            // A courier can finish at any storage then take any new pickup.
            // Use complete trips, never workload-per-production-batch as duration.
            let trip=0,total=0;
            for(const source of sources){
                const distances=stores.map(s=>workerTravelSeconds(Math.hypot(point(s)[0]-source.point[0],point(s)[1]-source.point[1])));
                trip+=source.rate*(Math.min(...distances)+distances.reduce((a,b)=>a+b,0)/distances.length);
                total+=source.rate;
            }
            const duration=total>0?trip/total:0;
            o.tripSeconds=duration;
            o.storageOrigins=stores.map(store=>({point:point(store),weight:1}));
            o.seconds+=hauling*duration;
            for(const store of stores)o.origins.push({point:point(store),weight:duration>0?hauling/duration/stores.length:0});
        }
        o.seconds=measured+hauling>0?o.seconds/(measured+hauling):0;
        // Watering and deliveries consume availability, but never create urgent jobs.
        o.busy=Math.max(0,loads[i]-(permanent[i]||0)-critical[i]);
        if(!o.origins.length)o.origins=[...locations.values()].flat().map(s=>({point:s.point,weight:s.rate}));
    });
    const jobs=[];
    for(const [key,sites] of locations){
        const recipe=byRecipe.get(key);
        if(!recipe||!['Farmland','Woodland'].includes(recipe.facility))continue;
        const stages=[...(recipe.jobs||[])].filter(([name])=>criticalCropJob(name))
            .sort((a,b)=>['Reaping','Logging','Collecting','Reclaiming','Sowing'].indexOf(a[0])-['Reaping','Logging','Collecting','Reclaiming','Sowing'].indexOf(b[0]));
        for(const [plot,site] of sites.entries()){
            let previous=null;
            for(const [name,ability,level] of stages){
                const work=reference.get(`${key}|${name}`);
                if(!(work>0))continue;
                const id=`${key}|${plot}|${name}`;
                jobs.push({id,previous,key:`${key}|${ability}`,name,ability,level,point:site.point,order:plot,cycle:site.cycle||1/site.rate,
                    eligibleMembers:[...(assigned.get(`${key}|${ability}`)||[])],
                    weight:site.rate,seconds:members.map(m=>(m.abilities?.[ability]||0)>=level
                        ?work/(1+.25*(level-1)+.5*(m.abilities[ability]-level)):Infinity)});
                previous=id;
            }
        }
    }
    const counts=loads.map((n,i)=>Math.min(members[i].count,Math.max(permanent[i]||0,Math.ceil(n-1e-6))));
    // Preserve the solver's checked mean allocation. Only duplicate copies of
    // real crop pools can be activated; an unrelated idle pool needs a new solve.
    const candidates=members.map((m,i)=>({...m,count:critical[i]>0?m.count:Math.min(m.count,counts[i])}));
    return {members:candidates,counts,permanent,jobs,outside,limit};
}

// A bounded stress scenario, not a reconstruction of the game's hidden queue.
// All plots release critical work together. Watering remains average demand.
// Workers finish an already-started job before approaching a new request. Equal
// availability rotates across samples; proximity is never a dispatch priority.
export function selectCropPeakTeam({members,counts,permanent=[],jobs,outside=[],limit=Infinity,targetSeconds,recommend=true}) {
    jobs=jobs.filter(j=>j.ability!=='Water' && j.name!=='Watering');
    const recurring=jobs.every(j=>Number.isFinite(j.cycle)&&j.cycle>0);
    targetSeconds??=recurring?REGROWTH_TARGET_SECONDS:CROP_PEAK_TARGET_SECONDS;
    const meetsTarget=seconds=>recurring ? seconds<targetSeconds : seconds<=targetSeconds+EPS;
    const active=members.map((m,i)=>Math.max(counts[i]||0,permanent[i]||0));
    const simulate=allocation=>{
        if(!jobs.length)return {wait:0,completion:0,worstCompletion:0,shares:{},copyShares:{}};
        let totalWait=0,weight=0;
        const completions=[];
        const assigned=new Map(),byCopy=new Map();
        for(let sample=0;sample<8;sample++){
            const workers=[];
            allocation.forEach((count,id)=>{
                const mobile=Math.max(0,count-(permanent[id]||0)),other=outside[id]||{};
                for(let copy=0;copy<mobile;copy++){
                    // Stratified phases are reproducible and shared by all candidates.
                    const phase=((sample+.5)/8+copy*.61803398875+id*.38196601125)%1;
                    // Match the normal-work packing: an extra copy starts free,
                    // rather than splitting a long factory job across all copies.
                    const occupied=Math.min(1,Math.max(0,(other.busy||0)-copy));
                    const remaining=phase<occupied ? (other.seconds||0)*(1-phase/occupied) : 0;
                    let point=other.point||[0,0];
                    const origins=(copy+(permanent[id]||0)>=(counts[id]||0) && other.peakOrigins?.length ? other.peakOrigins : other.origins)||[],total=origins.reduce((n,p)=>n+p.weight,0);
                    let position=phase*total;
                    for(const origin of origins){point=origin.point;position-=origin.weight;if(position<=0)break;}
                    workers.push({id,copy:copy+(permanent[id]||0),ready:remaining,point});
                }
            });
            let completion=0;
            const finished=new Map();
            const pending=[...jobs];
            while(pending.length){
                let next=-1,earliest=Infinity;
                for(let i=0;i<pending.length;i++){
                    const j=pending[i];if(j.previous&&!finished.has(j.previous))continue;
                    const release=Math.max(j.release||0,finished.get(j.previous)||0);
                    if(release<earliest){next=i;earliest=release;}
                }
                if(next<0)return {wait:Infinity,completion:Infinity,worstCompletion:Infinity,shares:{},copyShares:{}};
                const [job]=pending.splice(next,1);
                const eligible=workers.filter(w=>(!job.eligibleMembers||job.eligibleMembers.includes(w.id))
                    &&(members[w.id].abilities?.[job.ability]||0)>=job.level
                    && Number.isFinite(job.seconds[w.id]));
                if(!eligible.length)return {wait:Infinity,completion:Infinity,worstCompletion:Infinity,shares:{},copyShares:{}};
                const release=Math.max(job.release||0,finished.get(job.previous)||0);
                let chosen=eligible[(sample+(job.order||0))%eligible.length];
                for(const w of eligible)if(Math.max(release,w.ready)<Math.max(release,chosen.ready)-EPS)chosen=w;
                const travel=workerTravelSeconds(Math.hypot(chosen.point[0]-job.point[0],chosen.point[1]-job.point[1]));
                const start=Math.max(release,chosen.ready)+travel;
                const frequency=job.weight||1;
                totalWait+=(start-release)*frequency;weight+=frequency;
                chosen.ready=start+job.seconds[chosen.id];chosen.point=job.point;
                completion=Math.max(completion,chosen.ready);
                if(job.id!=null)finished.set(job.id,chosen.ready);
                if(!assigned.has(job.key))assigned.set(job.key,new Map());
                const values=assigned.get(job.key);values.set(chosen.id,(values.get(chosen.id)||0)+frequency);
                const copyKey=`${job.key}|${chosen.id}`;
                if(!byCopy.has(copyKey))byCopy.set(copyKey,new Map());
                const copies=byCopy.get(copyKey);copies.set(chosen.copy,(copies.get(chosen.copy)||0)+frequency);
            }
            completions.push(completion);
        }
        const shares={};
        for(const [key,values] of assigned){
            const sum=[...values.values()].reduce((a,b)=>a+b,0);
            shares[key]=[...values].map(([member,value])=>({member,share:value/sum}));
        }
        const copyShares={};
        for(const [key,values] of byCopy){
            const sum=[...values.values()].reduce((a,b)=>a+b,0);
            copyShares[key]=[...values].map(([copy,n])=>[copy,n/sum]);
        }
        return {wait:totalWait/weight,completion:completions.reduce((a,b)=>a+b,0)/8,worstCompletion:Math.max(...completions),shares,copyShares};
    };
    // Candidate selection, pruning and the removal tooltip revisit the same
    // team. All eight scenarios share fixed inputs throughout this search.
    const recurringWork=recurring && prepareRecurringCropWork({jobs,members,counts,permanent,outside});
    const scenariosByTeam=new Map();
    const evaluate=(allocation,trackShares=false)=>{
        const key=allocation.join(',');
        if(!scenariosByTeam.has(key))scenariosByTeam.set(key,recurring?
            recurringWork(allocation,trackShares):simulate(allocation));
        return scenariosByTeam.get(key);
    };
    const originalTeam=active.join(',');
    let result=evaluate(active,true);const beforeWait=result.wait,beforeCompletion=result.completion;
    const better=(a,b)=>(a.uncovered||0)<(b.uncovered||0) || a.completion<b.completion-EPS
        || (Math.abs(a.completion-b.completion)<=EPS && a.wait<b.wait-EPS);
    const improve=(allocation,initial,available,floor=counts,cap=limit)=>{
        let current=initial;
        // Each pass adds one copy. Stop at the deadline, not at the smallest wait.
        // The finite safety bound also covers callers without an RV limit.
        const ceiling=Number.isFinite(cap)?cap:allocation.reduce((a,b)=>a+b,0)+jobs.length;
        while(!meetsTarget(current.completion) && allocation.reduce((a,b)=>a+b,0)<ceiling){
            let best=null;
            for(let id=0;id<members.length;id++){
                if(!available(id,allocation) || !jobs.some(j=>(!j.eligibleMembers||j.eligibleMembers.includes(id)) && Number.isFinite(j.seconds[id])))continue;
                allocation[id]++;const candidate=evaluate(allocation);allocation[id]--;
                if(better(candidate,current)&&(!best||better(candidate,best.result)))best={id,result:candidate};
            }
            if(!best)break;
            allocation[best.id]++;current=best.result;
        }
        // Remove any now-redundant additions, without touching mean-production staff.
        for(let id=0;id<members.length;id++)while(allocation[id]>(floor[id]||0)){
            allocation[id]--;const candidate=evaluate(allocation);
            if(meetsTarget(candidate.completion))current=candidate;
            else {allocation[id]++;break;}
        }
        return current;
    };
    result=improve(active,result,(id,allocation)=>!members[id].assumed&&allocation[id]<members[id].count);
    // Measure a single removal with the final team and the same eight arrival
    // scenarios. Copies of a pool are interchangeable for this comparison.
    const withoutHelper=active.map((n,id)=>{
        if(n<=counts[id])return null;
        const remaining=[...active];
        remaining[id]--;
        return evaluate(remaining).completion;
    });
    const proposed=[...active];
    const recommendation=recommend&&!meetsTarget(result.completion)
        ?improve(proposed,result,(id)=>true,active):result;
    const required=[...proposed];
    const shortfall = recommend && !meetsTarget(recommendation.completion)
        ? improve(required,recommendation,()=>true,proposed,required.reduce((a,b)=>a+b,0)+8) : recommendation;
    // Candidate comparisons only consume timing. Materialize the full dispatch
    // shares once if a different team supplied the accepted timing.
    if (recurring && active.join(',')!==originalTeam)
        result=recurringWork(active,true);
    return {...result,recurring,counts:active,baseCounts:[...counts],withoutHelper,beforeWait,beforeCompletion,targetSeconds,
        targetMet:meetsTarget(result.completion),
        additions:proposed.flatMap((n,member)=>n>active[member]?[{member,count:n-active[member]}]:[]),
        shortfall:required.flatMap((n,member)=>n>proposed[member]?[{member,count:n-proposed[member],abilities:members[member].abilities}]:[]),
        shortfallCompletion:shortfall.completion,
        recommendedCompletion:recommendation.completion,recommendedTargetMet:meetsTarget(recommendation.completion)};
}

// Generated teams retain each shift's real production allocation. Peak helpers
// duplicate eligible crop pools; permanent posts are never treated as free staff.
export function plannedCropPeakTeam({layout,recipes,pools,limit=Infinity}) {
    const locations=dispatchLocations(layout);
    const members=pools.map(p=>({count:p.count,abilities:p.abilities}));
    const permanent=pools.map(p=>Math.round((p.allocations||[]).filter(a=>a.fixed).reduce((n,a)=>n+a.busy,0)));
    const stores=layout.storages||[];
    const sources=layout.pieces.flatMap(piece=>piece.members.flatMap(site=>(site.jobs||[{item:site.crop,rate:(site.batchWeight??site.weight??0)/3600}])
        .filter(job=>job.rate>0).map(job=>({point:[site.x+site.w/2,site.y+site.h/2],rate:job.rate}))));
    let courierSeconds=0,courierWeight=0;
    for(const source of sources){
        const distances=stores.map(s=>workerTravelSeconds(Math.hypot(source.point[0]-s.x-s.w/2,source.point[1]-s.y-s.h/2)));
        if(!distances.length)continue;
        courierSeconds+=source.rate*(Math.min(...distances)+distances.reduce((a,b)=>a+b,0)/distances.length);courierWeight+=source.rate;
    }
    courierSeconds=courierWeight?courierSeconds/courierWeight:0;
    const outside=pools.map(p=>{
        let busy=0,weighted=0;const origins=[];
        for(const a of p.allocations||[]){
            if(!a.fixed&&!a.critical){busy+=a.busy;weighted+=a.busy*(a.ability==='Hauling'?courierSeconds:(a.duration||0));}
            if(a.ability==='Hauling')for(const store of stores)origins.push({point:[store.x+store.w/2,store.y+store.h/2],weight:stores.length? a.busy/stores.length:0});
            const sites=a.point?[{point:a.point,rate:1}]:(locations.get(a.siteKey)||[]);
            for(const site of sites)origins.push({point:site.point,weight:site.rate});
        }
        const accounted=(p.allocations||[]).reduce((sum,a)=>sum+a.busy,0);
        const switching=Math.max(0,(p.busy||0)-accounted);
        if(switching>EPS){
            let duration=0,total=0;
            for(const recipe of recipes){
                const requirements=recipe.aniimo?[recipe.aniimo]:(recipe.jobs||[]).map(([,ability,level])=>[ability,level]);
                if(!requirements.some(([ability,level])=>(p.abilities[ability]||0)>=level))continue;
                for(const site of (locations.get(`${recipe.facility}|${recipe.name}`)||[]).filter(s=>!s.occupied))for(const origin of origins){
                    const weight=site.rate*origin.weight;
                    duration+=weight*2*workerTravelSeconds(Math.hypot(site.point[0]-origin.point[0],site.point[1]-origin.point[1]));total+=weight;
                }
            }
            busy+=switching;weighted+=switching*(total?duration/total:0);
        }
        const hauling=(p.allocations||[]).filter(a=>!a.fixed&&!a.critical&&a.ability==='Hauling').reduce((sum,a)=>sum+a.busy,0);
        const storageOrigins=stores.map(s=>({point:[s.x+s.w/2,s.y+s.h/2],weight:1}));
        return {busy,seconds:busy>0?weighted/busy:0,hauling,tripSeconds:courierSeconds,storageOrigins,
            otherSeconds:busy>hauling?(weighted-hauling*courierSeconds)/(busy-hauling):0,origins};
    });
    const jobs=[];
    for(const recipe of recipes){
        if(!['Farmland','Woodland'].includes(recipe.facility))continue;
        const key=`${recipe.facility}|${recipe.name}`,sites=locations.get(key)||[];
        const work=new Map(recipe.job_workloads||[]);
        const order=['Reaping','Logging','Collecting','Reclaiming','Sowing'];
        const stages=(recipe.jobs||[]).filter(([name])=>criticalCropJob(name)).toSorted((a,b)=>order.indexOf(a[0])-order.indexOf(b[0]));
        for(const [plot,site] of sites.entries()){
            let previous=null;
            for(const [name,ability,level] of stages){
                const duration=work.get(name);
                if(!(duration>0))throw new Error(`Missing crop workload: ${recipe.name}/${name}`);
                const id=`${key}|${plot}|${name}`;
                const eligibleMembers=pools.flatMap((p,i)=>(p.abilities[ability]||0)>=level && (p.count>permanent[i] || (p.count===0 && !permanent[i]))?[i]:[]);
                jobs.push({id,previous,key:`${key}|${ability}`,name,ability,level,point:site.point,order:plot,cycle:site.cycle||1/site.rate,weight:site.rate,eligibleMembers,
                    seconds:members.map(m=>(m.abilities[ability]||0)>=level?duration/(1+.25*(level-1)+.5*(m.abilities[ability]-level)):Infinity)});
                previous=id;
            }
        }
    }
    pools.forEach((pool,i)=>{
        outside[i].peakOrigins=jobs.filter(j=>(pool.abilities[j.ability]||0)>=j.level).map(j=>({point:j.point,weight:j.weight||1}));
        if(!outside[i].origins.length)outside[i].origins=outside[i].peakOrigins;
    });
    return selectCropPeakTeam({members,counts:pools.map(p=>p.count),permanent,outside,jobs,limit});
}
