import {productionObjective} from './priority-search.js';
import {priorityCeiling} from './priority-ceilings.js';
import {polishSolution} from './highs-solve.js';
import {buildReactiveDispatch,measuredDispatchWork} from './reactive-dispatch.js';
import {cropPeakInput,selectCropPeakTeam} from './crop-peaks.js';

const EPS=1e-8;
const slots=load=>Math.max(0,Math.ceil(load-1e-6));

function workshopJobs(context){
    const recipes=new Map(context.recipes.map(r=>[r.facility+'|'+r.name,r]));
    const jobs=new Map();
    for(const r of context.routes){
        const key=r.facility+'|'+r.item,recipe=recipes.get(key);
        if(!(r.job_rate>0)||!recipe?.ingredients?.length||!recipe.aniimo||r.jobs.some(([action])=>action))continue;
        if(!jobs.has(key))jobs.set(key,{key:key+'|Production',recipe,routes:[]});
        jobs.get(key).routes.push(r);
    }
    return [...jobs.values()];
}

function retirementSets(context,jobs,delivery){
    const processing=new Set(jobs.flatMap(j=>j.routes));
    const candidates=context.members.flatMap((m,id)=>{
        const work=context.routes.filter(r=>r.member===id&&r.job_rate>0);
        if(context.permanent[id]||delivery.get(id)>EPS||!work.length||!work.every(r=>processing.has(r)))return [];
        return [id];
    }).sort((a,b)=>Number(!!context.members[b].assumed)-Number(!!context.members[a].assumed)||context.busy[a]-context.busy[b]);
    const activeAbilities=context.members.map((_,id)=>new Set(jobs.filter(job=>job.routes.some(r=>r.member===id))
        .map(job=>job.recipe.aniimo[0])));
    const removed=new Set();
    function stillStaffed({recipe,routes}){
        if(!routes.some(r=>removed.has(r.member)))return true;
        const [ability,level]=recipe.aniimo;
        return context.members.some((m,i)=>!removed.has(i) && activeAbilities[i].has(ability)
            && m.abilities[ability]>=level && context.busy[i]<slots(context.busy[i])-1e-6);
    }
    for(const id of candidates){
        removed.add(id);
        if(!jobs.every(stillStaffed))removed.delete(id);
    }
    const all=[...removed];
    return [all,all.filter(id=>context.members[id].assumed),...candidates.map(id=>[id])].filter((a,i,sets)=>
        a.length&&sets.findIndex(b=>String(a)===String(b))===i).slice(0,5);
}

function redistribute(context,jobs,removed,previous,delivery,cycleTimes){
    const changed=jobs.filter(j=>j.routes.some(r=>removed.has(r.member)));
    const original=new Set(changed.flatMap(j=>j.routes));
    const routes=context.routes.filter(r=>!original.has(r));
    const loads=context.busy.map((n,i)=>n+(delivery.get(i)||0));
    const copies=loads.map(slots);
    for(const r of original)loads[r.member]-=r.jobs.reduce((s,[,w])=>s+w,0)+r.walking;
    const policies=Object.fromEntries(Object.entries(previous).map(([key,entries])=>[key,entries.filter(e=>!removed.has(e.member))]));
    const shifts=[];
    for(const {key,recipe,routes:old} of changed){
        const total=old.reduce((s,r)=>s+r.job_rate,0),[ability,level]=recipe.aniimo;
        const eligible=context.members.flatMap((m,i)=>{
            if(removed.has(i)||copies[i]<=context.permanent[i]||m.abilities[ability]<level||!m.abilities[ability]
                ||loads[i]>=copies[i]-1e-6)return [];
            const match=old.find(r=>r.member===i);
            const seconds=match?match.jobs[0][1]/match.job_rate:cycleTimes.get(key+'|'+i);
            if(!(seconds>0))return [];
            const walk=previous[key]?.find(e=>e.member===i)?.travel_seconds??0;
            return [{member:i,seconds,walk,share:0}];
        });
        if(!eligible.length)return null;
        shifts.push({key,total,old,eligible});
    }
    // A finished batch frees its operator. Other recipes still compete for the
    // same copies. Rebalance these simultaneous requests before pricing walks.
    for(let pass=0;pass<16;pass++)for(const {eligible,total} of shifts){
        for(const e of eligible)loads[e.member]-=e.share*total*(e.seconds+e.walk);
        const weights=eligible.map(e=>Math.max(0,copies[e.member]-loads[e.member]));
        const sum=weights.reduce((s,n)=>s+n,0);
        if(sum<=EPS)weights.fill(1);
        for(const [i,e] of eligible.entries()){
            e.share=weights[i]/(sum>EPS?sum:weights.length);
            loads[e.member]+=e.share*total*(e.seconds+e.walk);
        }
    }
    for(const {eligible,key,old,total} of shifts){
        policies[key]=eligible.filter(e=>e.share>EPS).map(({member,share})=>({member,share}));
        for(const e of eligible)if(e.share>EPS){
            const rate=total*e.share;
            routes.push({...old[0],member:e.member,visits:rate,job_rate:rate,jobs:[['',rate*e.seconds]],walking:rate*e.walk});
        }
    }
    const members=context.members.map((m,i)=>removed.has(i)?{...m,count:0,assumed:false}:m);
    return buildReactiveDispatch({...context,members,routes,previous:policies});
}

function fixedProduction(pkg,highs,input,plan,dispatch,retired){
    const {pace,floors,crop_variety}=plan.comparison_goals;
    const stage=JSON.stringify({pace,floors,crop_variety,material_pace:plan.comparison_scores?.material_pace,
        maximize_material_work:plan.comparison_scores?.material_work!=null});
    const payload=JSON.stringify({...input,always_running_recipes:plan.continuous_checked_recipes,roster:{...input.roster,dispatch}});
    const model=JSON.parse(pkg.exact_problem(payload,stage));
    if(!model.staffing_groups?.length)return null;
    const seed=plan.comparison_seed,prior=new Map(seed.keys.map((k,i)=>[k,seed.values[i]]));
    const times=new Map(model.recipe_options.filter(([,name,facility,gathering,electric])=>
        !gathering&&!electric&&dispatch[facility+'|'+name+'|Production']?.length)
        .map(([v,,,,,seconds])=>[model.variable_keys[v],seconds]));
    const rows=[];
    for(const group of model.staffing_groups){
        // A dispatchable fixed-site variable measures busy time. Hold the
        // batches at that physical site even when the new worker is faster.
        const terms=group.map(v=>{
            const key=model.variable_keys[v],rateKey=key.replace(/^site:\d+:/,'rate:');
            const seconds=key.startsWith('site:')&&key.includes('__by')?times.get(rateKey):null;
            return [v,seconds?1/seconds:1];
        });
        const amount=terms.reduce((n,[v,c])=>n+c*(prior.get(model.variable_keys[v])??0),0);
        rows.push(' hold_'+group[0]+': '+terms.map(([v,c])=>c+' x'+v).join(' + ')+' = '+amount);
    }
    for(const [i,pool] of model.staffing_pools.entries()){
        // Keep the physical posts and the available copies of each pool. A
        // retired worker must be idle across every task including deliveries.
        for(const v of pool.anchors)rows.push(' post_'+v+': x'+v+' = '+(prior.get(model.variable_keys[v])??0));
        const max=retired.has(i)?0:(plan.crop_peaks.counts[i]||0);
        if(pool.work.length)rows.push(' capacity_'+i+': '+pool.work.map(([v,c])=>c+' x'+v).join(' + ')+' <= '+max);
    }
    const lp=model.lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n');
    const result=highs.solve(lp,{mip_max_nodes:8,mip_feasibility_tolerance:1e-9,mip_rel_gap:0});
    if(result.Status!=='Optimal')return null;
    const raw=model.variable_keys.map((_,v)=>result.Columns['x'+v]?.Primal??0);
    const {values}=polishSolution(highs,{...model,lp},{values:raw});
    const next=JSON.parse(pkg.exact_plan(payload,stage,JSON.stringify({values,proven:false,verify_only:true,bound:0})));
    if(!next.success||next.rate_per_second+1e-9<plan.rate_per_second)return null;
    for(const key of ['level_up','level_up_preview'])if(plan[key]?.seconds!=null&&!(next[key]?.seconds<=plan[key].seconds+1e-5))return null;
    const priorities=new Map(next.priorities.map(p=>[p.target,p.per_second]));
    if(plan.priorities.some(p=>!(priorities.get(p.target)>=p.per_second-1e-9)))return null;
    if(plan.comparison_scores?.material_work!=null&&model.primary_objective.reduce((s,[v,c])=>s+values[v]*c,0)+1e-7<plan.comparison_scores.material_work)return null;
    return {...plan,...next,comparison_seed:{keys:model.variable_keys,values},
        roster_dispatch:dispatch};
}

export function compactMeasuredTeam(pkg,highs,{plan,context,input,limit}){
    if(!plan.continuous_production_checked||!plan.comparison_seed||!plan.crop_peaks||plan.recipe_schedule)return null;
    const jobs=workshopJobs(context),delivery=new Map(plan.delivery_assignments??plan.hauling_staffing);
    const old=plan.crop_peaks;
    const alternatives=retirementSets(context,jobs,delivery);
    if(!alternatives.length)return null;
    const baseline=JSON.parse(pkg.exact_problem(JSON.stringify({...input,roster:{...input.roster,dispatch:plan.roster_dispatch}}),'{}'));
    const cycleTimes=new Map();
    for(const [v,name,facility,,,seconds] of baseline.recipe_options){
        const worker=baseline.variable_keys[v].match(/__byowned:(\d+)/);
        if(worker)cycleTimes.set(facility+'|'+name+'|Production|'+worker[1],seconds);
    }
    for(const ids of alternatives){
        const retired=new Set(ids);
        const policy=redistribute(context,jobs,retired,plan.reactive_dispatch,delivery,cycleTimes);
        if(!policy)continue;
        let next=fixedProduction(pkg,highs,input,plan,policy,retired);
        if(!next)continue;
        const reduced=context.members.map((m,i)=>retired.has(i)?{...m,count:0,assumed:false}:m);
        const priced=buildReactiveDispatch({...context,members:reduced,busy:next.roster_workload,routes:next.roster_routes,previous:policy});
        next=fixedProduction(pkg,highs,input,plan,priced,retired);
        if(!next)continue;
        const nextContext={...context,busy:next.roster_workload,routes:next.roster_routes};
        const measured=measuredDispatchWork(next,priced,context.recipes);
        const peaks=selectCropPeakTeam(cropPeakInput({...nextContext,delivery:measured.delivery,limit}));
        if(!(peaks.completion<old.targetSeconds||peaks.completion<=old.completion+EPS)
            ||peaks.counts.reduce((s,n)=>s+n,0)>=old.counts.reduce((s,n)=>s+n,0))continue;
        // A ceiling from the previous dispatch can depend on its workers.
        // Reprice each priority under the new policy, using the full-precision
        // floors from the solve. The serialized keys round floats for lookup.
        const goals=plan.comparison_goals,actualFloors=new Map(goals.floors);
        const relaxed=JSON.stringify({...input,always_running_recipes:[],restrict_to_checked_recipes:false,
            roster:{...input.roster,dispatch:priced}});
        const bounds=[];
        let upper,top;
        for(const [key] of plan.continuous_upper_bounds||[]){
            const [target,prefix]=JSON.parse(key);
            prefix.floors=(prefix.floors||[]).map(([name,rate])=>[name,actualFloors.get(name)??rate]);
            if(prefix.pace!=null)prefix.pace=goals.pace;
            const model=target==='crop_variety'?JSON.parse(pkg.exact_crop_variety_problem(relaxed)):
                productionObjective(JSON.parse(pkg.exact_priority_problem(relaxed,JSON.stringify(prefix),target)));
            const ceiling=priorityCeiling(highs,model,target);
            if(!Number.isFinite(ceiling))continue;
            bounds.push([key,ceiling]);
            if(target===goals.currency)upper=ceiling;
            if(target===plan.measure_top?.measure)top=ceiling;
        }
        if(!(upper>=next.rate_per_second-1e-7))continue;
        const measure=plan.measure_top;
        return {...next,upper_bound:Math.max(upper,next.rate_per_second),proven_optimal:false,continuous_upper_bounds:bounds,
            measure_top:measure?{...measure,proven:Number.isFinite(top)&&Math.abs(top-measure.objective)<=EPS}:undefined,
            crop_peaks:peaks,reactive_dispatch:priced,layout_walking:measured.walking,
            delivery_assignments:measured.delivery,hauling_busy:measured.delivery.reduce((s,[,n])=>s+n,0)};
    }
    return null;
}
