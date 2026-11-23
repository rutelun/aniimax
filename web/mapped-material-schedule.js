// Check a measured shift with a permanent manual raw processor and electric
// downstream recipes. Only the courier workload can vary between its phases.
import {materialChains,materialFlowSchedules} from './material-flow-schedule.js';
import {scheduleInputForPlan,attachRecipeSchedule} from './recipe-schedule-plan.js';
import {improvesPlan} from './recipe-switch-search.js';
import {cropPeakInput,selectCropPeakTeam} from './crop-peaks.js';
import {prepareRecurringCropWork} from './recurring-crops.js';
import {draftMaterialPlans} from './material-plan-draft.js';
import {siteSchedule} from './recipe-timeline.js';
import {buildReactiveDispatch,measuredDispatchWork,attachDeliveryFlows,permanentWorkers} from './reactive-dispatch.js';

function keepsCropTime(seconds,reference){
    return Number.isFinite(seconds) && (seconds<reference.targetSeconds || seconds<=reference.completion+1e-8);
}

export function checkMappedMaterialDraft(input,plan,base,context,limit){
    if(!Number.isFinite(base.crop_peaks?.completion) || !context?.layout || !improvesPlan(plan,base))return null;
    const data=scheduleInputForPlan(input,plan,{materialSites:true,steadyMaterialCrew:true});
    const jobs=new Map(data.jobs.map(j=>[j.id,j]));
    const manual=data.jobs.filter(j=>j.electric_level==null);
    if(!manual.length || !manual.every(j=>j.recipe===materialChains[j.facility]?.[0]
        && Math.abs(j.batches*j.seconds-data.daySeconds)<1e-6))return null;
    const members=input.roster.members.slice();
    for(const [i,ability,level,count,family] of plan.assumed_aniimo??[])
        members[i]={abilities:{[ability]:level},count,assumed:true,family};
    const counts=base.crop_peaks.counts;
    if(counts.length!==members.length || counts.reduce((n,c)=>n+c,0)>limit)return null;
    const permanent=permanentWorkers(plan,members,new Set(input.roster.residents));
    const alternatives=[...materialFlowSchedules(data)];
    const checkTeam=allocation=>{
        for(const schedule of alternatives){
            let candidate;
            try{candidate=attachRecipeSchedule(plan,data,schedule);}catch{continue;}
            const verified=candidate.recipe_schedule;
            let worst=null,valid=true;
            for(const [index,phase] of verified.phases.entries()){
                // Every manual operator keeps exactly the same job and hours.
                const work=new Map();
                for(const a of phase.assignments)work.set(a.job,(work.get(a.job)??0)+a.batches*jobs.get(a.job).seconds);
                if(manual.some(j=>Math.abs((work.get(j.id)??0)-phase.duration)>1e-6)){valid=false;break;}
                const delivery=(plan.hauling_staffing??[]).map(([id,n])=>[id,n*verified.haulingProfiles[id][index]]);
                const haul=new Map(delivery);
                const busy=members.map((_,i)=>verified.workerProfiles[i][index]-(haul.get(i)??0));
                // An unsaturated courier cannot starve any of the unchanged
                // processors. Reserve enough of each existing copy in every phase.
                if(busy.some((n,i)=>n+(haul.get(i)??0)>allocation[i]+1e-8)
                    || delivery.some(([i,n])=>n>0 && busy[i]+n>=allocation[i]-1e-7)){valid=false;break;}
                const crop=cropPeakInput({...context,members,routes:plan.roster_routes,permanent,busy,delivery,limit});
                if(crop.jobs.some(j=>!(j.cycle>0))){valid=false;break;}
                const peak=prepareRecurringCropWork(crop)(allocation,true);
                if(peak.uncovered || !keepsCropTime(peak.completion,base.crop_peaks)){valid=false;break;}
                if(!worst||peak.completion>worst.completion)worst=peak;
            }
            if(valid&&worst)return {...candidate,crop_peaks:{...base.crop_peaks,...worst,counts:allocation,targetMet:worst.completion<base.crop_peaks.targetSeconds},
                recipe_schedule:{...verified,cropCompletion:worst.completion}};
        }
    };
    const current=checkTeam(counts);
    if(current)return current;
    const growers=new Set((plan.roster_routes??[]).filter(r=>r.jobs?.some(([name])=>name&&name!=='Watering')).map(r=>r.member));
    const available=[...growers].filter(i=>counts[i]>0 && counts[i]<members[i].count);
    const people=counts.reduce((n,c)=>n+c,0);
    if(people<limit)for(const i of available){
        const team=counts.slice();
        team[i]++;
        const candidate=checkTeam(team);
        if(candidate)return candidate;
    }
    const full=counts.slice();
    for(const i of available)full[i]=members[i].count;
    if(full.reduce((n,c)=>n+c,0)<=limit && full.some((n,i)=>n>counts[i])){
        let candidate=checkTeam(full);
        if(candidate){
            for(const i of available)while(full[i]>counts[i]){
                full[i]--;
                const smaller=checkTeam(full.slice());
                if(!smaller){full[i]++;break;}
                candidate=smaller;
            }
            return candidate;
        }
    }
    return null;
}

// Keep the existing plots, power connections and workers on their measured
// map. A powered site keeps its downstream recipe after the daily change.
function placeMaterialSchedule(layout,plan){
    const placed=structuredClone(layout);
    const sites=placed.pieces.flatMap(piece=>piece.members);
    const used=new Set();
    for(const lane of plan.recipe_schedule.sites){
        if(!lane.jobs.length)continue;
        const current=sites.find(s=>!used.has(s)&&s.facility===lane.facility
            && (s.electric_level??null)===(lane.electric_level??null) && lane.jobs.some(j=>j.item===s.crop));
        if(!current)return null;
        used.add(current);
        current.jobs=lane.jobs;
        current.scheduleId=lane.id;
        current.schedulePeak=lane.peakLoad;
        current.schedulePhases=siteSchedule(plan.recipe_schedule,lane.id);
        current.batchWeight=3600*lane.jobs.reduce((n,j)=>n+j.rate,0);
    }
    return placed;
}

// When a raw recipe runs on two sites their delivery distances can differ.
// Measure the active lanes again in each phase, using their actual batch rates.
function checkMappedPhases(plan,map,policy,context,limit,reference){
    const schedule=plan.recipe_schedule, counts=reference.counts, members=context.members;
    const delivery=new Map(), phases=[], profiles={}, daily=new Map(plan.hauling_staffing);
    let worst,worstCrop;
    const jobs=new Map(schedule.jobs.map(j=>[j.id,j]));
    for(const [index,phase] of schedule.phases.entries()){
        const layout=structuredClone(map),rates=new Map(schedule.jobs.map(j=>[JSON.stringify([j.facility,j.item,j.electric_level]),0]));
        for(const a of phase.assignments){
            const j=jobs.get(a.job),key=JSON.stringify([j.facility,j.item,j.electric_level]);
            rates.set(key,(rates.get(key)??0)+a.batches/phase.duration);
        }
        for(const s of layout.pieces.flatMap(p=>p.members))if(s.scheduleId){
            for(const job of s.jobs)job.rate=s.schedulePhases[index].rates[job.item]??0;
            s.batchWeight=s.jobs.reduce((n,j)=>n+j.rate*3600,0);
        }
        const steps=plan.coin_items.map(s=>{
            const key=JSON.stringify([s.facility,s.item_name,s.electric_level]);
            return rates.has(key)?{...s,busy_units:rates.get(key)*s.cycle_time}:s;
        });
        const shift={...context,layout,busy:plan.roster_workload,routes:plan.roster_routes};
        const routes=buildReactiveDispatch({...shift,previous:policy});
        const measured=measuredDispatchWork({...plan,coin_items:steps},routes,context.recipes);
        const walked=new Map(measured.walking),haul=new Map(measured.delivery);
        const busy=members.map((_,i)=>schedule.workerProfiles[i][index]
            -(daily.get(i)??0)*(schedule.haulingProfiles[i]?.[index]??0)+(walked.get(i)??0));
        if(busy.some((n,i)=>!Number.isFinite(n)||n+(haul.get(i)??0)>counts[i]+1e-7)
            || measured.delivery.some(([i,n])=>n>0 && busy[i]+n>=counts[i]-1e-7))return false;
        const crop=cropPeakInput({...shift,busy,delivery:measured.delivery,limit});
        if(crop.jobs.some(j=>!(j.cycle>0)))return false;
        const peak=prepareRecurringCropWork(crop)(counts,true);
        if(peak.uncovered || !keepsCropTime(peak.completion,reference))return false;
        if(!worst||peak.completion>worst.completion){worst=peak;worstCrop=crop;}
        for(const [i,n] of measured.delivery)delivery.set(i,(delivery.get(i)??0)+n*phase.duration/86400);
        for(const [i,n] of busy.entries())(profiles[i]??=[]).push(n+(haul.get(i)??0));
        phases.push(haul);
    }
    if(!worst)return false;
    schedule.workerProfiles=profiles;
    schedule.haulingProfiles=Object.fromEntries([...delivery].filter(([,n])=>n>0).map(([i,n])=>[i,phases.map(haul=>(haul.get(i)??0)/n)]));
    schedule.cropCompletion=worst.completion;
    const report=selectCropPeakTeam({...worstCrop,counts,targetSeconds:reference.targetSeconds,
        members:worstCrop.members.map((m,i)=>({...m,count:counts[i]}))});
    const baseCounts=counts.map((n,i)=>Math.min(n,Math.max(context.permanent[i]||0,
        Math.ceil((plan.roster_workload[i]||0)+(delivery.get(i)||0)-1e-6))));
    const simulate=prepareRecurringCropWork(worstCrop);
    const withoutHelper=counts.map((n,i)=>{
        if(n<=baseCounts[i])return null;
        const remaining=counts.slice();
        remaining[i]--;
        return simulate(remaining).completion;
    });
    plan.crop_peaks={...report,...worst,counts,baseCounts,withoutHelper,targetMet:worst.completion<reference.targetSeconds};
    plan.delivery_assignments=[...delivery];
    return true;
}

function fitMappedMaterialPlan(pkg,highs,{plan:base,input,context,limit}){
    if(!Number.isFinite(base.crop_peaks?.completion)||!base.comparison_seed||base.recipe_schedule||input.priorities?.[0]!=='level_up')return null;
    const baselineInput={...input,roster:{...input.roster,dispatch:base.roster_dispatch}};
    const propose=(settings,map)=>draftMaterialPlans(pkg,highs,settings,base,
        (i,p,b)=>checkMappedMaterialDraft(i,p,b,{...context,layout:map},limit),[true]);
    const first=propose(baselineInput,context.layout);
    if(first===base)return null;
    const map=placeMaterialSchedule(context.layout,first);
    if(!map)return null;
    const measure=(layout,plan,previous)=>buildReactiveDispatch({...context,layout,
        busy:plan.roster_workload,routes:plan.roster_routes,previous});
    const policy=measure(map,first,base.roster_dispatch);
    const result=propose({...baselineInput,roster:{...input.roster,dispatch:policy}},map);
    if(result===base)return null;
    const finalMap=placeMaterialSchedule(context.layout,result);
    if(!finalMap)return null;
    const priced=measure(finalMap,result,policy);
    const charged=measuredDispatchWork(result,priced,context.recipes);
    const loads=new Map(result.hauling_staffing);
    if(charged.walking.some(([,delta])=>Math.abs(delta)>1e-7)
        || charged.delivery.some(([id,n])=>Math.abs(n-(loads.get(id)??0))>1e-7))return null;
    if(!checkMappedPhases(result,finalMap,priced,context,limit,{...base.crop_peaks,counts:result.crop_peaks.counts}))return null;
    attachDeliveryFlows(finalMap,priced,context.recipes,context.members,result.roster_routes);
    for(const s of finalMap.pieces.flatMap(p=>p.members))if(s.scheduleId)s.weight=s.deliveryWorkers.reduce((n,[,load])=>n+load,0);
    return {plan:{...result,roster_dispatch:priced},layout:finalMap};
}

export function mappedMaterialPlan(pkg,highs,payload){
    const {plan,context,limit,input}=payload;
    const fitted=fitMappedMaterialPlan(pkg,highs,payload);
    if(fitted || !Number.isFinite(plan.crop_peaks?.completion) || !plan.comparison_seed ||
        plan.recipe_schedule || input.priorities?.[0]!=='level_up')return fitted;
    const counts=plan.crop_peaks.counts;
    if(counts.reduce((n,c)=>n+c,0)>=limit)return null;
    const crop=cropPeakInput({...context,delivery:plan.delivery_assignments,limit});
    for(const [id,ability] of plan.assumed_aniimo??[]){
        if(!(context.members[id]?.count>counts[id]))continue;
        const jobs=crop.jobs.filter(j=>j.ability===ability && Number.isFinite(j.seconds[id]));
        if(!jobs.length)continue;
        const eligible=new Set(jobs);
        const team=counts.slice();
        team[id]++;
        const trial={...crop,jobs:crop.jobs.map(j=>eligible.has(j) && !j.eligibleMembers.includes(id)?{...j,eligibleMembers:[...j.eligibleMembers,id]}:j)};
        const peak=prepareRecurringCropWork(trial)(team,true);
        if(peak.uncovered)continue;
        const previous={...plan.roster_dispatch};
        const busy=context.busy.slice();
        for(const job of jobs){
            const shares=peak.shares[job.key];
            const helper=shares?.find(s=>s.member===id);
            if(!helper)continue;
            previous[job.key]=shares;
            busy[id]+=helper.share*job.weight*job.seconds[id];
        }
        if(!(busy[id]>context.busy[id]))continue;
        const policy=buildReactiveDispatch({...context,busy,previous});
        const candidate=fitMappedMaterialPlan(pkg,highs,{...payload,plan:{...plan,roster_dispatch:policy,
            crop_peaks:{...plan.crop_peaks,counts:team}}});
        if(candidate && candidate.plan.roster_workload[id]>0)return candidate;
    }
    return null;
}
