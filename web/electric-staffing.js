import {FACILITIES, opposedPersonality} from './facility-config.js';
import {recommendBestTeam} from './best-team.js';

const sum=(terms,values)=>terms.reduce((n,[v,c])=>n+c*values[v],0);
const expression=terms=>terms.map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');
const facilities=new Map(FACILITIES.map(f=>[f.name,f]));
const catalogs=new WeakMap();

function minimumWorkers(jobs){
    const groups=new Map();
    for(const job of jobs){
        const key=[job.ability,job.level,job.personality,job.family].join('|');
        const group=groups.get(key);
        if(group)group.busy+=job.busy;
        else groups.set(key,{...job,key});
    }
    const hosts=[];
    let count=0;
    for(const job of [...groups.values()].sort((a,b)=>b.level-a.level
        || Number(!!b.personality)-Number(!!a.personality) || a.key.localeCompare(b.key))){
        const host=hosts.find(h=>h.ability===job.ability && h.family===job.family && h.level>=job.level
            && h.spare>=job.busy-1e-6 && (!job.personality||!h.traits.has(opposedPersonality(job.personality))));
        if(host){
            host.spare-=job.busy;
            if(job.personality)host.traits.add(job.personality);
        }else{
            const copies=Math.max(1,Math.ceil(job.busy-1e-6));
            count+=copies;
            hosts.push({...job,spare:copies-job.busy,traits:new Set(job.personality?[job.personality]:[])});
        }
    }
    return count;
}
function generatedScore(plan,input,definitions){
    const jobs=[];
    for(const step of plan.coin_items??[]){
        if(step.status!=='producing'||step.electric_level!=null)continue;
        const facility=facilities.get(step.facility);
        for(const task of step.aniimo_tasks??[]){
            const fixed=facility?.category==='Aniimo Materials';
            jobs.push({ability:task.ability,level:task.level,personality:task.personality_bonus?facility?.personality:null,
                family:definitions.get(step.item_name)?.family,fixed,growing:!!task.jobs?.length,
                busy:fixed?step.facility_count:task.busy,label:step.facility+'|'+step.item_name+'|'+task.ability});
        }
    }
    // Environment posts stay fixed by the LP. Count generators separately
    // because each one needs a dedicated Lightning worker for its whole shift.
    const generators=plan.power_generators??plan.power_generator_levels?.length??0;
    const work=jobs.reduce((n,j)=>n+j.busy,0)+generators;
    if(input.aniimo?.startsWith('best')){
        return {people:recommendBestTeam(jobs,plan.hauling_busy||0).shifts.length+generators,work};
    }
    return {people:minimumWorkers(jobs)+generators+Math.max(0,Math.ceil((plan.hauling_busy||0)-1e-6)),work};
}

// Hold every recipe's combined output and every sale exactly at their
// incumbent values. Whole sites, electric tiers, generators and their staff
// remain in the native model, including competition for scarce ingredients.
export async function refineElectricStaffing(problem,incumbent,solve,{pkg,input,report}={}){
    const options=problem.recipe_options??[], keys=problem.variable_keys;
    if(!keys || incumbent?.values?.length!==keys.length || !options.length || input?.fixed_homeland || input?.recipe_switching_relaxation)return incumbent;
    const original=incumbent.values, groups=new Map(), pools=problem.staffing_pools??[];
    // The first roster draft supplies dispatch weights to the income search.
    // Change its support posts only after those rates have been measured.
    const provisional=input?.roster && !Object.keys(input.roster.dispatch??{}).length;
    for(const option of options){
        const list=groups.get(option[1])??[];
        list.push(option);groups.set(option[1],list);
    }
    const switches=new Set([...groups].filter(([,g])=>g.some(o=>o[4])&&g.some(o=>!o[4])&&g.some(o=>original[o[0]]>1e-10)).map(([name])=>name));
    if(!switches.size && !(pools.length && input && !provisional))return incumbent;
    if(!pools.length && (!pkg?.get_all_items || !report))return incumbent;
    const rows=[],warm=[...original],added=[],working=[],counts=[],integer=[],reserveCounts=[];
    const row=(terms,op,value)=>rows.push(' power_shift_'+rows.length+': '+expression(terms)+' '+op+' '+value);
    const fix=(v)=>row([[v,1]],'=',Math.abs(original[v])<1e-12?0:original[v]);
    // Free equivalent worker variants even for residents and other buildings
    // that cannot use E-mode. Keep their recipe, physical tier and output.
    const transferable=new Set();
    const held=new Set((problem.recipe_variables??[]).filter(([,name])=>!switches.has(name)).map(([v])=>v));
    for(const group of provisional?[]:(problem.staffing_groups??[])){
        if(group.length<2 || !group.every(v=>held.has(v)))continue;
        const terms=group.map(v=>[v,1]);
        row(terms,'=',sum(terms,original));
        group.forEach(v=>transferable.add(v));
    }
    for(const [name,group] of groups){
        const terms=group.map(([v])=>[v,1]);
        if(switches.has(name))row(terms,'=',sum(terms,original));
        else group.forEach(([v])=>{if(!transferable.has(v))fix(v);});
    }
    for(const [v,name] of problem.recipe_variables??[]){
        if(!switches.has(name)&&!keys[v].startsWith('rate:')&&!transferable.has(v))fix(v);
    }
    const coverage=new Map();
    keys.forEach((key,v)=>{
        if(key.startsWith('environment:') && pools.length && !provisional){
            const mode=key.split(':',3).join(':');
            if(!coverage.has(mode))coverage.set(mode,[]);
            coverage.get(mode).push([v,1]);
        }else if(/^(sold:|pace#|material_pace#|environment:|pair:|crop_variety#|lower_level_plots#)/.test(key))fix(v);
    });
    // The native coverage rows still require sufficient light/heat/cold for
    // every plot. The discovery layout can have surplus climate posts.
    for(const terms of coverage.values())row(terms,'<=',Math.round(sum(terms,original)));
    if(problem.primary_objective?.length)row(problem.primary_objective,'>=',sum(problem.primary_objective,original)-1e-9);
    const scorePool=(p,vals)=>Math.max(0,Math.ceil(sum(p.work,vals)-1e-6),Math.round(p.anchors.reduce((n,v)=>n+vals[v],0)));
    function countFor(terms,base,anchors=[],existing=null){
        const index=existing??warm.length;
        if(existing==null){warm.push(base);added.push(' 0 <= x'+index);integer.push(' x'+index);}
        row([...terms,[index,-1]],'<=',0);
        if(anchors.length)row([...anchors.map(v=>[v,1]),[index,-1]],'<=',0);
        counts.push([index,1]);working.push(...terms);
        return index;
    }
    let score,baseline,definitions;
    if(pools.length){
        const reserveWork=[];
        for(const p of pools){
            if(!p.work.length&&!p.anchors.length)continue;
            const count=countFor(p.work,scorePool(p,original),p.anchors,p.active);
            if(p.reserve){reserveCounts.push([count,1]);reserveWork.push(...p.work);}
            if(p.crop.some(v=>original[v]>1e-9))row(p.work,'<=',sum(p.work,original)+1e-9);
        }
        if(reserveCounts.length){
            row(reserveCounts,'<=',pools.filter(p=>p.reserve).reduce((n,p)=>n+scorePool(p,original),0));
            row(reserveWork,'<=',sum(reserveWork,original)+1e-9);
        }
        score=values=>({people:pools.reduce((n,p)=>n+scorePool(p,values),0),work:sum(working,values),
            reserves:pools.reduce((n,p)=>n+(p.reserve?scorePool(p,values):0),0)});
        baseline=score(original);
    }else{
        if(!catalogs.has(pkg))catalogs.set(pkg,new Map(JSON.parse(pkg.get_all_items()).map(r=>[r.name,r])));
        definitions=catalogs.get(pkg);
        const before=report(original);
        if(!before?.success)return incumbent;
        baseline=generatedScore(before,input,definitions);
        const byAbility=new Map(),fixedDemand=new Map();
        for(const step of before.coin_items??[])if(step.status==='producing'&&!switches.has(step.item_name)){
            for(const t of step.aniimo_tasks??[])fixedDemand.set(t.ability,(fixedDemand.get(t.ability)||0)+t.busy);
        }
        for(const name of switches){
            const ability=definitions.get(name)?.aniimo?.[0];
            if(!ability)return incumbent;
            const terms=byAbility.get(ability)??[];
            for(const [v,,,,electric,seconds] of groups.get(name))if(!electric)terms.push([v,seconds]);
            byAbility.set(ability,terms);
        }
        for(const [ability,terms] of byAbility){
            const fixed=fixedDemand.get(ability)||0;
            const v=countFor(terms,Math.ceil(sum(terms,original)+fixed-1e-6));
            if(fixed)row([...terms,[v,-1]],'<=',-fixed);
        }
        const generator=keys.indexOf('generators#0');
        if(generator>=0){counts.push([generator,1]);working.push([generator,1]);}
        score=values=>{
            const plan=report(values);
            return plan?.success&&plan.rate_per_second>=before.rate_per_second-1e-9?generatedScore(plan,input,definitions):null;
        };
    }
    if(!counts.length)return incumbent;
    const weight=1+Math.ceil(Math.max(sum(working,original),baseline.work,baseline.people));
    const costs=new Map();
    for(const [v,c] of working)costs.set(v,(costs.get(v)||0)-c);
    const headWeight=weight*(1+(provisional?0:baseline.reserves||0));
    for(const [v] of counts)costs.set(v,(costs.get(v)||0)-headWeight);
    if(!provisional)for(const [v] of reserveCounts)costs.set(v,(costs.get(v)||0)-weight);
    const objective=[...costs];
    const lp=problem.lp.replace(/^Maximize\n[^\n]+/,'Maximize\n obj: '+expression(objective))
        .replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n'+(added.length?added.join('\n')+'\n':''))
        .replace('\nGeneral\n','\nGeneral\n'+(integer.length?integer.join('\n')+'\n':''));
    const model={...problem,lp,variables:warm.length,variable_keys:keys.concat(integer.map((_,i)=>'power_team:'+i)),
        tiebreak:[],primary_objective:objective};
    const precision=provisional?{}:{mip_feasibility_tolerance:1e-9,primal_feasibility_tolerance:1e-9};
    const result=await solve(model,{mip_max_nodes:2147483647,mip_rel_gap:0,mip_abs_gap:0,...precision},undefined,warm);
    if(!result?.values)return incumbent;
    const values=result.values.slice(0,original.length);
    if(values.length!==original.length||!values.every(Number.isFinite))return incumbent;
    const primary=problem.primary_objective??[];
    if(keys.some((key,v)=>key.startsWith('sold:')&&Math.abs(original[v]-values[v])>1e-9)
        || sum(primary,values)<sum(primary,original)-1e-8)return incumbent;
    for(const g of groups.values()){
        if(Math.abs(g.reduce((n,[v])=>n+values[v]-original[v],0))>1e-9)return incumbent;
    }
    const after=score(values);
    if(!after || !(after.people<baseline.people || (after.people===baseline.people &&
        ((!provisional && after.reserves<baseline.reserves) || ((provisional || after.reserves===baseline.reserves) && after.work<baseline.work-1e-8)))))return incumbent;
    return {...incumbent,values};
}
