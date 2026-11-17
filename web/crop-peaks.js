import { workerTravelSeconds } from './worker-travel.js';
import { dispatchLocations } from './task-switching.js';

const EPS=1e-8;
export const criticalCropJob = name => ['Reaping','Logging','Reclaiming','Sowing'].includes(name);

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
            reference.set(`${r.facility}|${r.item}|${name}`,load/r.job_rate*speed);
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
            .sort((a,b)=>['Reaping','Logging','Reclaiming','Sowing'].indexOf(a[0])-['Reaping','Logging','Reclaiming','Sowing'].indexOf(b[0]));
        for(const [plot,site] of sites.entries()){
            let previous=null;
            for(const [name,ability,level] of stages){
                const work=reference.get(`${key}|${name}`);
                if(!(work>0))continue;
                const id=`${key}|${plot}|${name}`;
                jobs.push({id,previous,key:`${key}|${ability}`,name,ability,level,point:site.point,order:plot,
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
export function selectCropPeakTeam({members,counts,permanent=[],jobs,outside=[],limit=Infinity}) {
    jobs=jobs.filter(j=>j.ability!=='Water' && j.name!=='Watering');
    const active=members.map((m,i)=>Math.max(counts[i]||0,permanent[i]||0));
    const evaluate=allocation=>{
        if(!jobs.length)return {wait:0,shares:{},copyShares:{}};
        let totalWait=0,weight=0;
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
                    const origins=other.origins||[],total=origins.reduce((n,p)=>n+p.weight,0);
                    let position=phase*total;
                    for(const origin of origins){point=origin.point;position-=origin.weight;if(position<=0)break;}
                    workers.push({id,copy:copy+(permanent[id]||0),ready:remaining,point});
                }
            });
            const finished=new Map();
            const pending=[...jobs];
            while(pending.length){
                let next=-1,earliest=Infinity;
                for(let i=0;i<pending.length;i++){
                    const j=pending[i];if(j.previous&&!finished.has(j.previous))continue;
                    const release=Math.max(j.release||0,finished.get(j.previous)||0);
                    if(release<earliest){next=i;earliest=release;}
                }
                if(next<0)return {wait:Infinity,shares:{}};
                const [job]=pending.splice(next,1);
                const eligible=workers.filter(w=>(!job.eligibleMembers||job.eligibleMembers.includes(w.id))
                    &&(members[w.id].abilities?.[job.ability]||0)>=job.level
                    && Number.isFinite(job.seconds[w.id]));
                if(!eligible.length)return {wait:Infinity,shares:{}};
                const release=Math.max(job.release||0,finished.get(job.previous)||0);
                let chosen=eligible[(sample+(job.order||0))%eligible.length];
                for(const w of eligible)if(Math.max(release,w.ready)<Math.max(release,chosen.ready)-EPS)chosen=w;
                const travel=workerTravelSeconds(Math.hypot(chosen.point[0]-job.point[0],chosen.point[1]-job.point[1]));
                const start=Math.max(release,chosen.ready)+travel;
                const frequency=job.weight||1;
                totalWait+=(start-release)*frequency;weight+=frequency;
                chosen.ready=start+job.seconds[chosen.id];chosen.point=job.point;
                if(job.id!=null)finished.set(job.id,chosen.ready);
                if(!assigned.has(job.key))assigned.set(job.key,new Map());
                const values=assigned.get(job.key);values.set(chosen.id,(values.get(chosen.id)||0)+frequency);
                const copyKey=`${job.key}|${chosen.id}`;
                if(!byCopy.has(copyKey))byCopy.set(copyKey,new Map());
                const copies=byCopy.get(copyKey);copies.set(chosen.copy,(copies.get(chosen.copy)||0)+frequency);
            }
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
        return {wait:totalWait/weight,shares,copyShares};
    };
    let result=evaluate(active);const beforeWait=result.wait;
    // Only existing spare copies, and only a measured improvement. No arbitrary
    // reserve percentage, extra workload, or expansion of the RV population cap.
    while(active.reduce((a,b)=>a+b,0)<limit){
        let best=null;
        for(let id=0;id<members.length;id++){
            if(members[id].assumed || active[id]>=members[id].count || !jobs.some(j=>(members[id].abilities?.[j.ability]||0)>=j.level))continue;
            active[id]++;const candidate=evaluate(active);active[id]--;
            if(candidate.wait<result.wait-EPS && (!best || candidate.wait<best.result.wait-EPS))best={id,result:candidate};
        }
        if(!best)break;
        active[best.id]++;result=best.result;
    }
    return {...result,counts:active,baseCounts:[...counts],beforeWait};
}
