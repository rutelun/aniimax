export function siteSchedule(schedule,site) {
 if(!schedule)return undefined;
 const jobs=new Map(schedule.jobs.map(j=>[j.id,j]));
 return schedule.phases.map(p=>({duration:p.duration,rates:Object.fromEntries([...new Set(p.assignments.filter(a=>a.building===site).map(a=>jobs.get(a.job).item))].map(item=>[item,p.assignments.filter(a=>a.building===site&&jobs.get(a.job).item===item).reduce((v,a)=>v+a.batches,0)/Math.max(p.duration,1e-8)]))}));
}
export function scheduledRate(phases,item,seconds) {
 if(!phases)return undefined;
 const day=phases.reduce((n,p)=>n+p.duration,0);let at=((seconds%day)+day)%day;
 for(const p of phases){if(at<p.duration)return p.rates[item]||0;at-=p.duration;}
 return 0;
}
