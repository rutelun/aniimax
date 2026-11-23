import {processStage} from './material-flow-schedule.js';

// Within a phase, workshop rates and remaining worker capacities are constant.
// A fixed processor runs until it exhausts its private ingredient or its crew.
// Split at depletion so neither a queue nor a peak workload is averaged away.
export function fixedProductionPhases(input,schedule) {
    const fixed=input.fixedProduction;
    const jobs=new Map(input.jobs.map(j=>[j.id,j]));
    const backgroundInputs={...input.backgroundInputs},backgroundOutputs={...input.backgroundOutputs};
    for(const j of fixed)for(const [rates,amounts] of [[backgroundInputs,j.inputs],[backgroundOutputs,j.outputs]]) {
        for(const [r,n] of Object.entries(amounts))rates[r]=Math.max(0,(rates[r]||0)-n*j.rate);
    }
    let start=0;
    let periods=[];
    for(const phase of schedule.phases||[]) {
        if(!Number.isFinite(phase.duration)||phase.duration<0)return null;
        if(!phase.duration){if(phase.assignments?.some(a=>a.batches>0))return null;continue;}
        const workers={...input.backgroundWorkers};
        for(const a of phase.assignments||[]){
            const job=jobs.get(a.job);
            if(!job||!Number.isFinite(a.batches)||a.batches<0)return null;
            for(const [w,n] of Object.entries(job.workers))workers[w]=(workers[w]||0)+n*a.batches/phase.duration;
        }
        periods.push({start,end:start+phase.duration,phase,workers,inputs:backgroundInputs,outputs:backgroundOutputs,fixedRates:{}});
        start+=phase.duration;
    }
    if(!periods.length)return null;
    const initialStock={...schedule.initialStock};
    const pending=new Set(fixed);
    while(pending.size){
        const job=[...pending].find(j=>![...pending].some(other=>other.outputs[j.feed]>0));
        if(!job)return null;
        pending.delete(job);
        const supply=periods.map(p=>({...p,rate:p.outputs[job.feed]||0}));
        const capacity=p=>{
            let rate=job.sites/job.seconds;
            for(const [w,n] of Object.entries(job.workers))if(n>0)rate=Math.min(rate,((input.workerCapacity[w]||0)-(p.workers[w]||0))/n);
            return Math.max(0,rate);
        };
        const shift=processStage(supply,capacity,job.inputs[job.feed]);
        if(!shift)return null;
        const batches=shift.intervals.reduce((n,s)=>n+(s.end-s.start)*s.rate,0);
        if(Math.abs(batches-job.batches)>1e-6*Math.max(1,job.batches))return null;
        initialStock[job.feed]=shift.initial;
        let index=0;
        periods=shift.intervals.map(({start,end,rate})=>{
            while(index+1<supply.length && start>=supply[index].end)index++;
            const p=supply[index];
            const charged=(base,terms)=>{
                const result={...base};
                for(const [k,n] of Object.entries(terms))result[k]=(result[k]||0)+n*rate;
                return result;
            };
            return {...p,start,end,workers:charged(p.workers,job.workers),inputs:charged(p.inputs,job.inputs),
                outputs:charged(p.outputs,job.outputs),fixedRates:{...p.fixedRates,[job.id]:rate}};
        });
    }
    const phases=periods.map(p=>{
        const duration=p.end-p.start;
        return {duration,assignments:p.phase.assignments.map(a=>({...a,batches:a.batches*duration/p.phase.duration})),fixedRates:p.fixedRates};
    });
    return {phases,periods,initialStock};
}
