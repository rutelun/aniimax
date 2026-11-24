// Check a measured shift with a permanent manual raw processor and electric
// downstream recipes. Only the courier workload can vary between its phases.
import {materialChains,materialFlowSchedules} from './material-flow-schedule.js';
import {scheduleInputForPlan,attachRecipeSchedule} from './recipe-schedule-plan.js';
import {improvesPlan} from './recipe-switch-search.js';
import {cropPeakInput,growerOutsideLoad,keepsGrowerAvailability,selectCropPeakTeam} from './crop-peaks.js';
import {prepareRecurringCropWork} from './recurring-crops.js';
import {draftMaterialPlans,materialUpgradeBound} from './material-plan-draft.js';
import {siteSchedule} from './recipe-timeline.js';
import {buildReactiveDispatch,measuredDispatchWork,attachDeliveryFlows,permanentWorkers,routeDispatchKey} from './reactive-dispatch.js';

// Fitting a shift can leave a few ulps of delivery on a full-time operator.
export function courierNeedsSpare(load,used,capacity){
    return load>32*Number.EPSILON*Math.max(1,capacity) && used>=capacity-1e-7;
}

function keepsCropTime(seconds,reference){
    return Number.isFinite(seconds) && (seconds<reference.targetSeconds || seconds<=reference.completion+1e-8);
}

// Only growers on a phase's dispatch routes participate in its crop queue.
function cropTimeForTeam(crop){
    if(crop.jobs.some(j=>!(j.cycle>0)))return null;
    const simulate=prepareRecurringCropWork(crop);
    const growers=[...new Set(crop.jobs.flatMap(job=>job.eligibleMembers.filter(i=>Number.isFinite(job.seconds[i]))))];
    const peaks=new Map();
    return team=>{
        const key=growers.map(i=>team[i]).join(',');
        if(!peaks.has(key))peaks.set(key,simulate(team,false));
        return peaks.get(key);
    };
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
    const alternatives=[...materialFlowSchedules(data)].map(schedule=>({schedule}));
    // Site loads, hauling and the map are shared by every candidate crew.
    // Prepare each phase on first use, including schedules that fail validation.
    function prepare(alternative){
        let candidate;
        try{candidate=attachRecipeSchedule(plan,data,alternative.schedule);}catch{return null;}
        const verified=candidate.recipe_schedule;
        const phases=[];
        for(const [index,phase] of verified.phases.entries()){
            const work=new Map();
            for(const a of phase.assignments)work.set(a.job,(work.get(a.job)??0)+a.batches*jobs.get(a.job).seconds);
            if(manual.some(j=>Math.abs((work.get(j.id)??0)-phase.duration)>1e-6))return null;
            const delivery=(plan.hauling_staffing??[]).map(([id,n])=>[id,n*verified.haulingProfiles[id][index]]);
            const haul=new Map(delivery);
            const busy=members.map((_,i)=>verified.workerProfiles[i][index]-(haul.get(i)??0));
            phases.push({delivery,busy,load:members.map((_,i)=>busy[i]+(haul.get(i)??0))});
        }
        return {candidate,phases};
    }
    const checkTeam=allocation=>{
        for(const alternative of alternatives){
            if(alternative.prepared===undefined)alternative.prepared=prepare(alternative);
            if(!alternative.prepared)continue;
            const {candidate,phases}=alternative.prepared;
            let worst=null,valid=true;
            for(const phase of phases){
                if(phase.load.some((n,i)=>n>allocation[i]+1e-8)
                    || phase.delivery.some(([i,n])=>courierNeedsSpare(n,phase.load[i],allocation[i]))){valid=false;break;}
                if(phase.simulate===undefined){
                    const crop=cropPeakInput({...context,members,routes:plan.roster_routes,permanent,
                        busy:phase.busy,delivery:phase.delivery,limit});
                    phase.simulate=cropTimeForTeam(crop);
                }
                // The measured map computes dispatch shares for the winning crew.
                const peak=phase.simulate?.(allocation);
                if(!peak || peak.uncovered || !keepsCropTime(peak.completion,base.crop_peaks)){valid=false;break;}
                if(!worst||peak.completion>worst.completion)worst=peak;
            }
            if(valid&&worst)return {...candidate,crop_peaks:{...base.crop_peaks,...worst,counts:allocation,targetMet:worst.completion<base.crop_peaks.targetSeconds},
                recipe_schedule:{...candidate.recipe_schedule,cropCompletion:worst.completion}};
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
function checkMappedPhases(plan,map,policy,context,limit,reference,checkPrices=false){
    const schedule=plan.recipe_schedule, counts=reference.counts.slice(), members=context.members;
    const needed=context.permanent.slice(), growers=new Set();
    for(const [,id,n] of plan.roster_posts??[])needed[id]+=n;
    const delivery=new Map(), phases=[], profiles={}, daily=new Map(plan.hauling_staffing);
    let worst,worstCrop,worstSimulator,maxOutside=0;
    const key=(facility,item,variant)=>JSON.stringify([facility,item,variant??null]);
    const fixed=schedule.fixedProduction??[], allJobs=[...schedule.jobs,...fixed];
    for(const [index,phase] of schedule.phases.entries()){
        const layout=structuredClone(map), work=new Map(),rates=new Map(),manual=new Map();
        for(const a of phase.assignments)work.set(a.job,(work.get(a.job)??0)+a.batches/phase.duration);
        for(const job of allJobs){
            const k=key(job.facility,job.item,job.electric_level);
            const rate=phase.fixedRates?.[job.id]??work.get(job.id)??0;
            rates.set(k,(rates.get(k)??0)+rate);
            if(job.crew!=null){
                const workerKey=key(job.facility,job.item,job.crew),total=manual.get(workerKey)??[0,0];
                total[0]+=rate;
                total[1]+=job.rate;
                manual.set(workerKey,total);
            }
        }
        const fixedByRecipe=new Map(fixed.map(j=>[key(j.facility,j.item,j.electric_level),j]));
        for(const site of layout.pieces.flatMap(p=>p.members)){
            if(site.scheduleId && site.jobs?.length){
                for(const job of site.jobs)job.rate=site.schedulePhases[index].rates[job.item]??0;
                site.batchWeight=site.jobs.reduce((n,j)=>n+j.rate*3600,0);
            }else{
                const job=fixedByRecipe.get(key(site.facility,site.crop,site.electric_level));
                if(job)site.batchWeight=(site.batchWeight??site.weight??0)*(phase.fixedRates?.[job.id]??0)/job.rate;
            }
        }
        const steps=plan.coin_items.map(s=>{
            const k=key(s.facility,s.item_name,s.electric_level);
            if(s.status!=='producing' || !rates.has(k))return s;
            // Dispatched copies may have several rows for the same product.
            // Its combined delivery rate is charged once.
            const rate=rates.get(k);
            rates.set(k,0);
            return {...s,busy_units:rate*s.cycle_time};
        });
        const workerRoutes=(plan.roster_routes??[]).map(route=>{
            const scale=manual.get(key(route.facility,route.item,route.member));
            if(!scale || !checkPrices)return route;
            const share=scale[0]/scale[1];
            return {...route,visits:route.visits*share,walking:route.walking*share,job_rate:route.job_rate*share,
                jobs:route.jobs.map(([name,n])=>[name,n*share])};
        });
        const shift={...context,layout,busy:plan.roster_workload,routes:workerRoutes};
        const routes=buildReactiveDispatch({...shift,previous:policy});
        const phasePlan={...plan,coin_items:steps,roster_routes:workerRoutes};
        if(checkPrices && !keepsWorkRoutes(phasePlan,routes,context.recipes))return false;
        const measured=measuredDispatchWork(phasePlan,routes,context.recipes);
        const walked=new Map(measured.walking),haul=new Map(measured.delivery);
        const busy=members.map((_,i)=>schedule.workerProfiles[i][index]
            -(daily.get(i)??0)*(schedule.haulingProfiles[i]?.[index]??0)+(walked.get(i)??0));
        if(busy.some((n,i)=>!Number.isFinite(n)||n+(haul.get(i)??0)>counts[i]+1e-7)
            || measured.delivery.some(([i,n])=>courierNeedsSpare(n,busy[i]+n,counts[i])))return false;
        const crop=cropPeakInput({...shift,busy,delivery:measured.delivery,limit});
        maxOutside=Math.max(maxOutside,growerOutsideLoad(crop,counts));
        if(!keepsGrowerAvailability(maxOutside,reference.growerOutsideLoad))return false;
        if(crop.jobs.some(j=>!(j.cycle>0)))return false;
        for(const job of crop.jobs)for(const i of job.eligibleMembers)growers.add(i);
        for(const [i,n] of busy.entries()){
            const hauling=haul.get(i)??0,load=n+hauling;
            const workers=Math.max(Number(load>32*Number.EPSILON),Math.ceil(load-1e-7));
            needed[i]=Math.max(needed[i],workers+Number(courierNeedsSpare(hauling,load,workers)));
        }
        const simulate=prepareRecurringCropWork(crop);
        const peak=simulate(counts,true);
        if(peak.uncovered || !keepsCropTime(peak.completion,reference))return false;
        if(!worst||peak.completion>worst.completion){worst=peak;worstCrop=crop;worstSimulator=simulate;}
        for(const [i,n] of measured.delivery)delivery.set(i,(delivery.get(i)??0)+n*phase.duration/86400);
        for(const [i,n] of busy.entries())(profiles[i]??=[]).push(n+(haul.get(i)??0));
        phases.push(haul);
    }
    if(!worst || needed.some((n,i)=>n>counts[i]))return false;
    // A dedicated operator can replace the original shared raw-material crew.
    // Release idle copies outside every crop queue after checking all phases.
    for(const [i,n] of counts.entries())if(!growers.has(i))counts[i]=Math.min(n,needed[i]);
    schedule.workerProfiles=profiles;
    schedule.haulingProfiles=Object.fromEntries([...delivery].filter(([,n])=>n>0).map(([i,n])=>[i,phases.map(haul=>(haul.get(i)??0)/n)]));
    schedule.cropCompletion=worst.completion;
    const report=selectCropPeakTeam({...worstCrop,counts,targetSeconds:reference.targetSeconds,
        members:worstCrop.members.map((m,i)=>({...m,count:counts[i]}))});
    const baseCounts=counts.map((n,i)=>Math.min(n,Math.max(context.permanent[i]||0,
        Math.ceil((plan.roster_workload[i]||0)+(delivery.get(i)||0)-1e-6))));
    const withoutHelper=counts.map((n,i)=>{
        if(n<=baseCounts[i])return null;
        if(!growers.has(i))return worst.completion;
        const remaining=counts.slice();
        remaining[i]--;
        return worstSimulator(remaining,false).completion;
    });
    plan.crop_peaks={...report,...worst,growerOutsideLoad:maxOutside,counts,baseCounts,withoutHelper,targetMet:worst.completion<reference.targetSeconds};
    plan.delivery_assignments=[...delivery];
    return true;
}

// Compare individual visits. Opposite walking errors on two jobs performed
// by one worker would otherwise cancel in the daily workload.
function keepsWorkRoutes(plan,policy,recipes){
    for(const route of plan.roster_routes??[]){
        if(!(route.visits>0))continue;
        const key=routeDispatchKey(route,recipes);
        const entry=policy[key]?.find(e=>e.member===route.member && e.share>0);
        if(!entry || Math.abs(entry.travel_seconds*route.visits-route.walking)>1e-7)return false;
    }
    return true;
}

export function verifyMappedWorkshopCandidate(plan,context,limit,reference){
    const {layout,recipes,members}=context;
    if(!Number.isFinite(reference?.completion)||layout.unplaced?.length || layout.power?.disconnected)return false;
    const policy=buildReactiveDispatch({...context,previous:plan.roster_dispatch});
    if(!keepsWorkRoutes(plan,policy,recipes))return false;
    const measured=measuredDispatchWork(plan,policy,recipes);
    const charged=new Map(plan.hauling_staffing),delivery=new Map(measured.delivery);
    for(const id of new Set([...charged.keys(),...delivery.keys()])){
        if(Math.abs((charged.get(id)??0)-(delivery.get(id)??0))>1e-7)return false;
    }
    const crop=cropPeakInput({...context,delivery:measured.delivery,limit});
    const counts=crop.counts.map((n,i)=>Math.max(n,Math.ceil(Math.max(
        context.busy[i]+(delivery.get(i)??0),...(plan.recipe_schedule?.workerProfiles?.[i]??[]))-1e-7)));
    if(counts.some((n,i)=>!Number.isFinite(n) || n>members[i].count) || counts.reduce((a,b)=>a+b,0)>limit)return false;
    const peak=selectCropPeakTeam({...crop,counts});
    if(peak.uncovered || !keepsCropTime(peak.completion,reference) ||
        !keepsGrowerAvailability(peak.growerOutsideLoad,reference.growerOutsideLoad))return false;
    if(plan.recipe_schedule){
        if(!checkMappedPhases(plan,layout,policy,context,limit,{...reference,counts:peak.counts},true))return false;
    }else{
        plan.crop_peaks=peak;
        plan.delivery_assignments=measured.delivery;
    }
    plan.reactive_dispatch=policy;
    attachDeliveryFlows(layout,policy,recipes,members,plan.roster_routes);
    return true;
}

function fitMappedMaterialPlan(pkg,highs,{plan:base,input,context,limit},catalog){
    if(!Number.isFinite(base.crop_peaks?.completion)||!base.comparison_seed||base.recipe_schedule||input.priorities?.[0]!=='level_up')return null;
    const baselineInput={...input,roster:{...input.roster,dispatch:base.roster_dispatch}};
    const propose=(settings,map)=>draftMaterialPlans(pkg,highs,settings,base,
        (i,p,b)=>checkMappedMaterialDraft(i,p,b,{...context,layout:map},limit),[true],catalog);
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
    const permanent=permanentWorkers(result,context.members,new Set(input.roster.residents));
    if(!checkMappedPhases(result,finalMap,priced,{...context,permanent},limit,{...base.crop_peaks,counts:result.crop_peaks.counts}))return null;
    attachDeliveryFlows(finalMap,priced,context.recipes,context.members,result.roster_routes);
    for(const s of finalMap.pieces.flatMap(p=>p.members))if(s.scheduleId)s.weight=s.deliveryWorkers.reduce((n,[,load])=>n+load,0);
    return {plan:{...result,roster_dispatch:priced},layout:finalMap};
}

// Keep the existing operator's other recipes running when the raw material
// lane needs an uninterrupted shift. Refit and measure the replacement's routes.
function* rawOperatorShifts({plan,context,limit}){
    const {counts}=plan.crop_peaks;
    const delivery=new Map(plan.delivery_assignments);
    const total=counts.reduce((a,b)=>a+b,0);
    for(const [facility,[name]] of Object.entries(materialChains)){
        const key=facility+'|'+name+'|Production', old=plan.roster_dispatch?.[key];
        const step=plan.coin_items.find(r=>r.status==='producing'&&r.facility===facility&&r.item_name===name&&r.electric_level==null);
        if(!step || !old?.length || (old.length===1 && step.busy_units>=1-1e-7))continue;
        const recipe=context.recipes.find(r=>r.facility===facility&&r.name===name);
        if(!recipe?.aniimo)continue;
        const [ability,level]=recipe.aniimo;
        for(const [id,member] of context.members.entries()){
            if((old.length===1 && id===old[0].member) || !(member.abilities[ability]>=level))continue;
            const working=(context.busy[id]||0)+(delivery.get(id)||0);
            const needed=Math.max(Math.ceil(working-1e-7),context.permanent[id]||0)+1;
            if(needed>member.count || total+Math.max(0,needed-counts[id])>limit)continue;
            const team=counts.slice();team[id]=Math.max(needed,team[id]);
            const busy=context.busy.slice();busy[id]=(busy[id]||0)+1;
            const policy=buildReactiveDispatch({...context,busy,previous:{...plan.roster_dispatch,[key]:[{member:id,share:1}]}});
            if(policy[key]?.length!==1 || policy[key][0].member!==id)continue;
            // A dedicated copy starts at this site. Both subsequent fits
            // must reproduce its actual walking and pickup costs on the map.
            policy[key][0].travel_seconds=0;
            yield {id,name,plan:{...plan,roster_dispatch:policy,crop_peaks:{...plan.crop_peaks,counts:team}}};
        }
    }
}

export function mappedMaterialPlan(pkg,highs,payload){
    const {plan,context,limit,input}=payload;
    if(!Number.isFinite(plan.crop_peaks?.completion) || !plan.comparison_seed ||
        plan.recipe_schedule || input.priorities?.[0]!=='level_up')return null;
    const catalog=new Map(JSON.parse(pkg.get_all_items()).map(item=>[item.name,item]));
    const bound=materialUpgradeBound(plan,catalog);
    if(bound>0 && bound>=plan.level_up_preview.seconds*(1-2e-5))return null;
    let best=fitMappedMaterialPlan(pkg,highs,payload,catalog);
    const reached=()=>best && bound>0 && best.plan.level_up_preview.seconds<=bound*(1+1e-5);
    if(reached())return best;
    for(const shift of rawOperatorShifts(payload)){
        const candidate=fitMappedMaterialPlan(pkg,highs,{...payload,plan:shift.plan},catalog);
        if(candidate?.plan.roster_routes.some(route=>route.member===shift.id&&route.item===shift.name&&route.job_rate>0)
            && improvesPlan(candidate.plan,best?.plan??plan))best=candidate;
        if(reached())return best;
    }
    const counts=plan.crop_peaks.counts;
    if(counts.reduce((n,c)=>n+c,0)>=limit)return best;
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
            crop_peaks:{...plan.crop_peaks,counts:team}}},catalog);
        if(candidate && candidate.plan.roster_workload[id]>0 && improvesPlan(candidate.plan,best?.plan??plan))best=candidate;
        if(reached())return best;
    }
    return best;
}
