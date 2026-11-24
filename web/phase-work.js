// Split a pool of identical Aniimo into concrete copies for common time phases.
// Keep background posts first, then assign work to the available copy in that
// phase. Daily totals are reconstructed with duration weights, never divided
// equally between copies.
export function splitPhaseTasks(tasks,durations,minimum=0) {
    const day=durations.reduce((a,b)=>a+b,0);
    const demand=durations.map((_,p)=>tasks.reduce((n,t)=>n+t.busy*(t.profile?.[p]??1),0));
    const count=Math.max(minimum,Math.ceil(Math.max(0,...demand)-1e-6));
    const shifts=Array.from({length:count},()=>({busy:0,tasks:new Map(),phaseBusy:Array(durations.length).fill(0),profiles:new Map()}));
    const order=t=>t.delivery?2:t.crop?1:0;
    const ordered=[...tasks].sort((a,b)=>Number(!!b.fixed)-Number(!!a.fixed)||order(a)-order(b)||Number(!!a.profile)-Number(!!b.profile)||b.busy-a.busy);
    durations.forEach((duration,p)=>{
        let growers;
        for(const task of ordered) {
            let work=task.busy*(task.profile?.[p]??1);
            if(task.crop)growers??=[...shifts].sort((a,b)=>a.phaseBusy[p]-b.phaseBusy[p]);
            for(const shift of task.crop?growers:shifts) {
                const part=Math.min(work,Math.max(0,1-shift.phaseBusy[p]));
                if(part>1e-10){
                    shift.phaseBusy[p]+=part;
                    const average=part*duration/day;
                    shift.busy+=average;shift.tasks.set(task.label,(shift.tasks.get(task.label)||0)+average);
                    if(!shift.profiles.has(task.label))shift.profiles.set(task.label,Array(durations.length).fill(0));
                    shift.profiles.get(task.label)[p]+=part;work-=part;
                }
                if(work<1e-9)break;
            }
        }
    });
    return shifts.map(s=>({...s,profiles:new Map([...s.profiles].map(([label,values])=>[label,values.map(v=>v/s.tasks.get(label))]))}));
}
