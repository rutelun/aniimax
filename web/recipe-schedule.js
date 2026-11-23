import {fixedProductionPhases} from './fixed-production-phases.js';
import {independentMaterialChains} from './material-flow-schedule.js';

// A certificate for a repeating day of completed batches. Inputs for a phase
// are reserved at its start and outputs become available at its end. This is
// conservative but never borrows tomorrow's production or interrupts a batch.
const EPS=1e-6;
const sum=(xs)=>xs.reduce((a,b)=>a+b,0);
const entries=(x)=>Object.entries(x||{});
// Aggregate seconds are only a relaxation: three six-second batches do not
// fit two workers into a ten-second window. Construct actual, uninterrupted
// jobs before accepting a solution. Reserving a worker for the whole batch
// is conservative when its work occupies only part of the machine cycle.
function packPhase(phase,jobs,capacity) {
    const machines=new Map(),workers=new Map(entries(capacity).map(([id,n])=>[id,Array(Math.floor(n)).fill(0)]));
    const pending=(phase.assignments||[]).map(a=>({...a,remaining:a.batches}));
    const execution=[];
    while(pending.some(a=>a.remaining>0)) {
        let best=null;
        for(const a of pending) {
            if(a.remaining<=0)continue;
            const job=jobs.get(a.job),used=[];
            let start=machines.get(a.building)||0;
            const duration=Math.max(job.seconds,...entries(job.workers).map(([,n])=>n));
            for(const [id,n] of entries(job.workers)) {
                if(!n)continue;
                const slots=workers.get(id)||[];
                if(!slots.length)return null;
                let copy=0;
                for(let k=1;k<slots.length;k++)if(slots[k]<slots[copy])copy=k;
                start=Math.max(start,slots[copy]);used.push({id,copy});
            }
            const end=start+duration;
            if(!best||end<best.end)best={assignment:a,start,end,used};
        }
        if(!best||best.end>phase.duration+EPS)return null;
        best.assignment.remaining--;
        machines.set(best.assignment.building,best.end);
        for(const {id,copy} of best.used)workers.get(id)[copy]=best.end;
        execution.push({building:best.assignment.building,job:best.assignment.job,start:best.start,end:best.end,workers:best.used});
    }
    return execution;
}
function checkInput(input) {
    for(const key of ['maxBuildings','maxSwitches']) if(!Number.isSafeInteger(input[key])||input[key]<0) throw new Error(`Invalid ${key}`);
    if(!Number.isFinite(input.daySeconds)||input.daySeconds<=0) throw new Error('Invalid day length');
    if(input.maxSwitches>24) throw new Error('At most 24 shared changes are supported');
    for(const collection of [input.jobs,input.buildings]) {
        if(!Array.isArray(collection)||new Set(collection.map(x=>x.id)).size!==collection.length) throw new Error('Duplicate or missing IDs');
    }
    for(const j of input.jobs) {
        if(!j.recipe||!(input.approximate?Number.isFinite(j.batches):Number.isSafeInteger(j.batches))||j.batches<0||!Number.isFinite(j.seconds)||j.seconds<=0) throw new Error('Invalid job');
        for(const map of [j.inputs,j.outputs,j.workers]) for(const [,v] of entries(map)) if(!Number.isFinite(v)||v<0) throw new Error('Invalid job coefficient');
    }
    for(const [,v] of entries(input.workerCapacity)) if(!Number.isFinite(v)||v<0) throw new Error('Invalid worker capacity');
    for(const b of input.buildings) if(!Array.isArray(b.recipes)) throw new Error('Missing compatible recipes');
}

export function buildRecipeSchedule(input) {
    checkInput(input);
    const D=input.daySeconds, phases=input.maxSwitches+1;
    const bounds=[],integers=[],objective=[],constraints=[];
    const add=(upper,integer=false,cost=0)=>{const v=bounds.length;bounds.push(upper);if(integer)integers.push(v);if(cost)objective.push([v,cost]);return v;};
    const row=(terms,op,rhs)=>constraints.push({terms,op,rhs});
    const durations=Array.from({length:phases},()=>add(D));
    row(durations.map(v=>[v,1]),'=',D);
    const changed=[], cells=[], facilityChanges=new Map();
    if(input.oneChangePerFacility && phases>2) {
        for(const facility of new Set(input.buildings.map(b=>b.facility))) {
            const changes=Array.from({length:phases-1},()=>add(1,true));
            row(changes.map(v=>[v,1]),'<=',1);
            facilityChanges.set(facility,changes);
        }
    }
    for(const b of input.buildings) {
        const allowed=input.jobs.filter(j=>b.recipes.includes(j.recipe)&&(!b.jobs||b.jobs.includes(j.id))&&j.batches>0);
        if(!allowed.length)continue;
        const recipes=[...new Set(allowed.map(j=>j.recipe))];
        const switched=add(1,true,1e-4); changed.push(switched);
        const selections=[];
        const active=input.alwaysRunning?add(1,true):null;
        for(let p=0;p<phases;p++) {
            const selected=new Map(recipes.map(r=>[r,add(1,true)])); selections.push(selected);
            row([...selected.values()].map(v=>[v,1]).concat(active==null?[]:[[active,-1]]),'=',active==null?1:0);
            if(p) for(const recipe of recipes) {
                const boundary=facilityChanges.get(b.facility)?.[p-1];
                if(boundary!=null)row([[selected.get(recipe),1],[selections[p-1].get(recipe),-1],[boundary,-1]],'<=',0);
                row([[selected.get(recipe),1],[selections[0].get(recipe),-1],[switched,-1]],'<=',0);
                row([[selected.get(recipe),-1],[selections[0].get(recipe),1],[switched,-1]],'<=',0);
            }
            if(b.phaseRecipes?.[p])for(const [recipe,v] of selected)if(!b.phaseRecipes[p].includes(recipe))row([[v,1]],'=',0);
            const work=[];
            for(const job of allowed) {
                const batches=add(job.batches,!input.approximate);
                row([[batches,1],[selected.get(job.recipe),-job.batches]],'<=',0);
                work.push([batches,job.seconds]);
                cells.push({building:b.id,phase:p,job:job.id,variable:batches});
            }
            row([...work,[durations[p],-1]],'<=',0);
            if(active!=null)row([...work,[durations[p],-1],[active,-D]],'>=',-D);
        }
    }
    row(changed.map(v=>[v,1]),'<=',input.maxBuildings);
    for(const j of input.jobs) row(cells.filter(c=>c.job===j.id).map(c=>[c.variable,1]),'=',j.batches);
    const jobs=new Map(input.jobs.map(j=>[j.id,j]));
    for(let p=0;p<phases;p++) for(const [worker,capacity] of entries(input.workerCapacity)) {
        row([...cells.filter(c=>c.phase===p).map(c=>[c.variable,jobs.get(c.job).workers?.[worker]||0]),[durations[p],-(capacity-(input.backgroundWorkers?.[worker]||0))]],'<=',0);
    }
    // Missing a capacity is not equivalent to an infinite supply of that worker.
    for(const j of input.jobs) for(const [worker,amount] of entries(j.workers)) {
        if(amount>0&&!(worker in (input.workerCapacity||{}))) throw new Error(`Missing capacity for ${worker}`);
    }
    const resources=[...new Set([...input.jobs.flatMap(j=>[...Object.keys(j.inputs||{}),...Object.keys(j.outputs||{})]),...Object.keys(input.backgroundInputs||{}),...Object.keys(input.backgroundOutputs||{})])];
    const stocks=new Map();
    for(const resource of resources) {
        const bgIn=input.backgroundInputs?.[resource]||0,bgOut=input.backgroundOutputs?.[resource]||0;
        const max=sum(input.jobs.map(j=>j.batches*(j.inputs?.[resource]||0)))+D*Math.max(0,bgIn-bgOut);
        const initial=add(max,false,1);stocks.set(resource,initial);
        for(let p=0;p<phases;p++) {
            const terms=[[initial,1],[durations[p],Math.min(0,bgOut-bgIn)],...durations.slice(0,p).map(v=>[v,bgOut-bgIn])];
            for(const c of cells) {
                const job=jobs.get(c.job);
                if(c.phase<p)terms.push([c.variable,(job.outputs?.[resource]||0)-(job.inputs?.[resource]||0)]);
                if(c.phase===p)terms.push([c.variable,-(job.inputs?.[resource]||0)]);
            }
            row(terms,'>=',0);
        }
        row(cells.map(c=>{const j=jobs.get(c.job);return[c.variable,(j.outputs?.[resource]||0)-(j.inputs?.[resource]||0)];}),'>=',D*(bgIn-bgOut));
    }
    const expression=(terms)=>{
        const combined=new Map();for(const [v,c] of terms)combined.set(v,(combined.get(v)||0)+c);
        return [...combined].filter(([,c])=>c!==0).map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ')||'0 x0';
    };
    const lp=`Minimize\n obj: ${expression(objective)}\nSubject To\n${constraints.map((c,i)=>` c${i}: ${expression(c.terms)} ${c.op} ${c.rhs}`).join('\n')}\nBounds\n${bounds.map((u,i)=>` 0 <= x${i} <= ${u}`).join('\n')}\nGeneral\n ${integers.map(i=>`x${i}`).join(' ')}\nEnd`;
    return {lp,input,durations,cells,stocks,variables:bounds.length};
}

// The deferred fixed recipes can require a different replenishing dawn stock
// from the provisional model, which only knows their daily average rates.
export function completeFixedSchedule(input,schedule) {
    if(!input.fixedProduction?.length)return schedule;
    const fixed=fixedProductionPhases(input,schedule);
    if(!fixed)throw new Error('Fixed production cannot sustain its daily batches with the available crew');
    return {...schedule,phases:fixed.phases,initialStock:fixed.initialStock};
}

function sameWorkshopRates(a,b) {
    const rates=p=>{
        const result=new Map();
        for(const assignment of p.assignments)if(assignment.batches>0){
            const key=JSON.stringify([assignment.building,assignment.job]);
            result.set(key,(result.get(key)||0)+assignment.batches/p.duration);
        }
        return result;
    };
    const left=rates(a),right=rates(b);
    return left.size===right.size && [...left].every(([key,v])=>right.has(key)&&Math.abs(v-right.get(key))<=1e-9*Math.max(1,Math.abs(v)));
}

export function readRecipeSchedule(model,result) {
    if(!result?.Columns)throw new Error('No schedule solution');
    const value=v=>result.Columns[`x${v}`]?.Primal||0;
    const phases=model.durations.map((v,p)=>({duration:value(v),assignments:model.cells.filter(c=>c.phase===p&&value(c.variable)>EPS)
        .map(c=>({building:c.building,job:c.job,batches:model.input.approximate?value(c.variable):Math.round(value(c.variable))}))}));
    const schedule=completeFixedSchedule(model.input,{approximate:!!model.input.approximate,phases,initialStock:Object.fromEntries([...model.stocks].filter(([,v])=>value(v)>EPS).map(([r,v])=>[r,value(v)]))});
    const checked=validateRecipeSchedule(model.input,schedule);
    if(!checked.valid)throw new Error(`Invalid recipe schedule: ${checked.errors.join('; ')}`);
    return {...schedule,switchedBuildings:checked.switchedBuildings,switches:checked.switches};
}

export function validateRecipeSchedule(input,schedule) {
    checkInput(input);
    const errors=[],jobs=new Map(input.jobs.map(j=>[j.id,j])),buildings=new Map(input.buildings.map(b=>[b.id,b]));
    const fixed=input.fixedProduction?.length ? fixedProductionPhases(input,schedule) : null;
    if(input.fixedProduction?.length && !fixed)errors.push('Fixed production cannot sustain its daily batches with the available crew');
    const phases=fixed?.phases??schedule.phases??[];
    // Within a continuous material chain, an empty buffer changes production
    // rates without requiring the player to change any recipe.
    const flow=schedule.materialFlow===true&&!!independentMaterialChains(input,true);
    if(schedule.materialFlow&&!flow)errors.push('Unsupported material flow schedule');
    if(!phases.length)errors.push('Too many phases');
    if(!flow && phases.length>input.maxSwitches+1) {
        const workshopPhases=fixed ? phases.filter((p,i)=>i===0||!sameWorkshopRates(p,phases[i-1])).length : phases.length;
        if(workshopPhases>input.maxSwitches+1)errors.push('Too many phases');
    }
    if(phases.some(p=>!Number.isFinite(p.duration)||p.duration<0)||Math.abs(sum(phases.map(p=>p.duration))-input.daySeconds)>EPS)errors.push('Invalid phase durations');
    const depletedInputs=new Set();
    const initialStock=schedule.initialStock;
    if(fixed && input.fixedProduction.some(j=>Math.abs((initialStock?.[j.feed]||0)-fixed.initialStock[j.feed])>EPS))errors.push('Incorrect replenishing stock for fixed production');
    const inventory={...initialStock},totals=new Map(),seen=new Map(),last=new Map(),switches=[],execution=[];
    if(entries(inventory).some(([,v])=>!Number.isFinite(v)||v<0))errors.push('Invalid initial stock');
    const changedAt=new Map();
    let elapsed=0;
    for(const [phaseIndex,phase] of phases.entries()) {
        const backgroundInputs=fixed?.periods[phaseIndex].inputs??input.backgroundInputs;
        const backgroundOutputs=fixed?.periods[phaseIndex].outputs??input.backgroundOutputs;
        const work=new Map(),workers=new Map(),recipes=new Map(),assignedJobs=new Map(),
            consumed=Object.fromEntries(entries(backgroundInputs).map(([r,n])=>[r,Math.max(0,n-(backgroundOutputs?.[r]||0))*phase.duration])),
            produced=Object.fromEntries(entries(backgroundOutputs).map(([r,n])=>[r,Math.max(0,n-(backgroundInputs?.[r]||0))*phase.duration]));
        let changed=false;
        for(const a of phase.assignments||[]) {
            const j=jobs.get(a.job),b=buildings.get(a.building);
            if(!j||!b||!b.recipes.includes(j.recipe)||(b.jobs&&!b.jobs.includes(j.id))||!(input.approximate?Number.isFinite(a.batches):Number.isSafeInteger(a.batches))||(flow?a.batches<0:a.batches<=0)) {errors.push('Invalid assignment');continue;}
            if((j.electric_level??null)!==(b.electric_level??null)||j.facility_level>b.level||
                (b.electric_level!=null&&b.electric_level!==b.level))errors.push('Incompatible building level or power mode');
            if(b.phaseRecipes?.[phaseIndex]&&!b.phaseRecipes[phaseIndex].includes(j.recipe))errors.push('Recipe violates prescribed phase');
            if(recipes.has(b.id)&&recipes.get(b.id)!==j.recipe)errors.push('Two recipes in one building phase');
            recipes.set(b.id,j.recipe);
            if(flow)assignedJobs.set(b.id,j);
            totals.set(j.id,(totals.get(j.id)||0)+a.batches);
            work.set(b.id,(work.get(b.id)||0)+j.seconds*a.batches);
            for(const [w,n] of entries(j.workers))workers.set(w,(workers.get(w)||0)+n*a.batches);
            for(const [r,n] of entries(j.inputs))consumed[r]=(consumed[r]||0)+n*a.batches;
            for(const [r,n] of entries(j.outputs))produced[r]=(produced[r]||0)+n*a.batches;
        }
        for(const [b,r] of recipes) {
            if(!seen.has(b))seen.set(b,new Set());seen.get(b).add(r);
            if(last.has(b)&&last.get(b)!==r) {
                changed=true;
                const facility=buildings.get(b).facility;
                if(input.oneChangePerFacility && changedAt.has(facility) && changedAt.get(facility)!==elapsed)
                    errors.push('Workshop changes recipes more than once');
                changedAt.set(facility,elapsed);
            }
            last.set(b,r);
        }
        if(changed)switches.push(elapsed);
        for(const [site,time] of work){
            if(time>phase.duration+EPS)errors.push('Building overloaded');
            if(!input.alwaysRunning||time>=phase.duration-EPS)continue;
            const job=assignedJobs.get(site);
            if(!job||[...recipes.values()].filter(recipe=>recipe===job.recipe).length!==1){
                errors.push('Active recipe manually throttled');
                continue;
            }
            // A sole consumer can wait if its input is empty throughout
            // this constant-rate interval. The same shortage must recur
            // tomorrow, even if unrelated resources accumulate today.
            const ingredient=Object.keys(job.inputs)[0];
            const before=inventory[ingredient]||0;
            const after=before+(produced[ingredient]||0)-(consumed[ingredient]||0);
            if(Math.abs(before)>EPS||Math.abs(after)>EPS)errors.push('Active recipe manually throttled');
            depletedInputs.add(ingredient);
        }
        if(fixed)for(const [w,load] of entries(fixed.periods[phaseIndex].workers)) {
            if(load>(input.workerCapacity[w]||0)+1e-8)errors.push('Worker overloaded');
        }
        for(const [w,time] of workers)if(time>((input.workerCapacity?.[w]||0)-(input.backgroundWorkers?.[w]||0))*phase.duration+EPS)errors.push('Worker overloaded');
        if(!errors.length&&!input.approximate) {
            const packed=packPhase(phase,jobs,input.workerCapacity||{});
            if(!packed)errors.push('No uninterrupted batch packing found');
            else execution.push(packed);
        }
        for(const [r,n] of entries(consumed)) {inventory[r]=(inventory[r]||0)-n;if(!flow&&inventory[r]<-EPS)errors.push(`Insufficient ${r} at phase start`);}
        for(const [r,n] of entries(produced))inventory[r]=(inventory[r]||0)+n;
        if(flow&&entries(inventory).some(([,n])=>n < -EPS))errors.push('Material flow exhausted its stock');
        elapsed+=phase.duration;
    }
    if(input.alwaysRunning)for(const id of seen.keys())if(phases.some(p=>p.duration>EPS&&!p.assignments?.some(a=>a.building===id&&(flow||a.batches>EPS))))errors.push('Active building paused between phases');
    for(const j of input.jobs)if(Math.abs((totals.get(j.id)||0)-j.batches)>EPS*Math.max(1,j.batches))errors.push(`Wrong daily batches for ${j.id}`);
    for(const [r,start] of entries(initialStock))if((inventory[r]||0)<start-EPS)errors.push(`Stock does not replenish: ${r}`);
    for(const r of depletedInputs)if(Math.abs((inventory[r]||0)-(initialStock?.[r]||0))>EPS)errors.push(`Material shortage does not repeat: ${r}`);
    const switchedBuildings=[...seen].filter(([,rs])=>rs.size>1).map(([b])=>b);
    if(switchedBuildings.length>input.maxBuildings)errors.push('Too many switching buildings');
    if(switches.length>input.maxSwitches)errors.push('Too many common changes');
    return {valid:errors.length===0,errors,switchedBuildings,switches,finalStock:inventory,execution,fixed};
}
