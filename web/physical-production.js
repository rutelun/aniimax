// A dispatched summary can average unequal worker rates across identical sites.
// Preserve per-worker batches whenever each pool fits into whole physical sites;
// otherwise keep the shared-site representation (do not invent more buildings).
export function splitProductionSites(step,routes=[]){
    if(step.status!=='producing'||step.crew!=null||step.electric_level!=null||!(step.cycle_time>0))return null;
    const assigned=new Map();
    for(const r of routes){
        if(r.facility!==step.facility||r.item!==step.item_name||!(r.job_rate>0)||r.jobs?.some(([name])=>name))continue;
        const v=assigned.get(r.member)||{rate:0,work:0};
        v.rate+=r.job_rate;v.work+=(r.jobs||[]).reduce((s,[,n])=>s+n,0);assigned.set(r.member,v);
    }
    const expected=(step.busy_units??step.facility_count)/step.cycle_time;
    const total=[...assigned.values()].reduce((s,v)=>s+v.rate,0);
    if(!assigned.size||Math.abs(total-expected)>1e-9+expected*1e-6)return null;
    const result=[];
    for(const [crew,{rate,work}] of assigned){
        const n=Math.ceil(work-1e-6);if(n<1)return null;
        for(let i=0;i<n;i++)result.push({crew,rate:rate/n,cycle:work/rate,load:work/n});
    }
    return result.length===step.facility_count?result:null;
}

// An active recipe can divert other workers only while its physical station
// has room for work. Peak load alone does not describe a whole shift.
export function fullyStaffed(site,item,phases=site.schedulePhases) {
    if (site.facility==='Farmland' || site.facility==='Woodland') return false;
    if (!site.jobs?.length) return site.load>=1-1e-6;
    const manual=site.jobs.filter(j=>j.electric_level==null);
    const active=phases?.filter(p=>p.duration>0 && p.rates[item]>0);
    if (active?.length) {
        return active.every(p=>manual.reduce((load,j)=>load+(p.rates[j.item]??0)*j.cycle,0)>=1-1e-6);
    }
    return manual.reduce((load,j)=>load+(j.load??j.rate*j.cycle),0)>=1-1e-6;
}
