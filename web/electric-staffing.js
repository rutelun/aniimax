import {FACILITIES, opposedPersonality} from './facility-config.js';
import {switchingWorkshops} from './material-flow-schedule.js';
import {recommendBestTeam} from './best-team.js';
import {permanentWorkers} from './reactive-dispatch.js';

const sum=(terms,values)=>terms.reduce((n,[v,c])=>n+c*values[v],0);
const expression=terms=>terms.map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');
const facilities=new Map(FACILITIES.map(f=>[f.name,f]));
const catalogs=new WeakMap();

// The draft objective charges headWeight per worker plus total workload.
// At the minimum headcount, each pool works at most its assigned headcount.
// Once that workload is below headWeight, adding a worker cannot improve the score.
async function solveDraftShift(model, settings, solve, warm, counts, workload, headWeight) {
    const minimize = terms => {
        const objective = terms.map(([v, cost]) => [v, -cost]);
        return {...model, primary_objective: objective,
            lp: model.lp.replace(/^Maximize\n[^\n]+/, 'Maximize\n obj: ' + expression(objective))};
    };
    // Price the two objectives with auxiliary integer selectors relaxed.
    // Their combined bound gives the original model an early stopping target.
    const countModel=minimize(counts);
    const relaxSelectors=lp=>lp.replace(/\nGeneral\n([\s\S]*?)\nEnd/,(_,section)=>{
        const kept=section.trim().split(/\s+/).filter(name=>
            !model.variable_keys[Number(name.slice(1))]?.startsWith('extra#'));
        return (kept.length?'\nGeneral\n '+kept.join('\n '):'')+'\nEnd';
    });
    countModel.lp=relaxSelectors(countModel.lp);
    const minimum = await solve(countModel, settings, undefined, warm);
    if (!minimum?.proven || !minimum.values) return null;
    const team = Math.round(-minimum.objective);
    if (!Number.isSafeInteger(team) || team < 0 || team >= headWeight
        || Math.abs(team + minimum.objective) > 1e-7) return null;
    const workModel = minimize(workload);
    workModel.lp = relaxSelectors(workModel.lp).replace('\nBounds\n',
        '\n minimum_team: ' + expression(counts) + ' <= ' + team + '\nBounds\n');
    const work = await solve(workModel, settings, undefined, minimum.values);
    if (!work?.proven || !work.values || !Number.isFinite(work.objective)
        || Math.abs(sum(counts, work.values) - team) > 1e-7) return null;
    const target = -headWeight * team + work.objective;
    const tolerance = 64 * Number.EPSILON * Math.max(1, Math.abs(target));
    // Replay the original search to preserve its choice between equally scoring
    // physical layouts. That choice affects the next pass's measured routes.
    const replay = await solve(model, {...settings, objective_target: target - tolerance}, undefined, warm);
    // A feasible shift below the relaxed target has already used the original
    // model's search budget. Pass it to the same production and staffing checks.
    return replay?.values ? replay : null;
}

function contestedShifts(plan,catalog,roster){
    const members=roster.members.slice();
    for(const [i,ability,level,count] of plan.assumed_aniimo??[])members[i]={abilities:{[ability]:level},count};
    const posts=permanentWorkers(plan,members,new Set(roster.residents));
    const active=new Map();
    for(const step of plan.coin_items??[]){
        if(step.status!=='producing'||!(step.busy_units>0&&step.cycle_time>0))continue;
        const spareBatches=Math.max(0,step.facility_count-step.busy_units)/step.cycle_time;
        active.set(step.item_name,(active.get(step.item_name)||0)+spareBatches);
    }
    const recipes=[...active.keys()].map(name=>catalog.get(name)).filter(Boolean);
    const demand=new Map();
    for(const recipe of recipes)for(const ingredient of new Set(recipe.raw_materials))demand.set(ingredient,(demand.get(ingredient)||0)+1);
    const sold=new Map();
    for(const stream of plan.income_streams??[])sold.set(stream.item_name,(sold.get(stream.item_name)||0)+stream.units_per_second);
    return recipes.filter(r=>{
        const spare=active.get(r.name);
        if(!r.aniimo||!r.raw_materials?.some((ingredient,i)=>demand.get(ingredient)>1&&
            spare*(r.required_amount?.[i]??1)>(sold.get(ingredient)||0)+1e-10))return false;
        const [ability,minimum]=r.aniimo,trait=facilities.get(r.facility)?.personality;
        const speeds=new Set();
        members.forEach((m,i)=>{
            const busy=plan.roster_workload?.[i]??0;
            if(busy<=(posts[i]||0)+1e-7||(m.abilities[ability]||0)<minimum)return;
            speeds.add(m.abilities[ability]+'|'+Boolean(trait&&m.personalities?.includes(trait)));
        });
        return speeds.size>1;
    }).map(r=>r.name);
}

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
export function keepsProduction(before,after){
    if(!before?.success||!after?.success||!Number.isFinite(before.rate_per_second)||!Number.isFinite(after.rate_per_second)
        ||after.rate_per_second<before.rate_per_second-1e-9)return false;
    for(const key of ['level_up','level_up_preview']){
        if(Number.isFinite(before[key]?.seconds)&&(!Number.isFinite(after[key]?.seconds)||after[key].seconds>before[key].seconds+1e-5))
            return false;
    }
    const achieved=new Map((after.priorities??[]).map(p=>[p.target,p.per_second]));
    return (before.priorities??[]).every(p=>achieved.get(p.target)>=p.per_second-1e-9);
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
    const manualWork=jobs.reduce((n,j)=>n+j.busy,0);
    const work=manualWork+generators;
    if(input.aniimo?.startsWith('best')){
        return {people:recommendBestTeam(jobs,plan.hauling_busy||0).shifts.length+generators,manualWork,work};
    }
    return {people:minimumWorkers(jobs)+generators+Math.max(0,Math.ceil((plan.hauling_busy||0)-1e-6)),manualWork,work};
}

// Hold every recipe's combined output and every sale exactly at their
// incumbent values. Whole sites, electric tiers, generators and their staff
// remain in the native model, including competition for scarce ingredients.
export async function refineElectricStaffing(problem,incumbent,solve,{pkg,input,report,fixedRecipes}={}){
    const options=problem.recipe_options??[], keys=problem.variable_keys;
    if(!keys || incumbent?.values?.length!==keys.length || !options.length || input?.fixed_homeland
        || (input?.recipe_switching_relaxation && !fixedRecipes?.size))return incumbent;
    const original=incumbent.values, groups=new Map(), pools=problem.staffing_pools??[];
    // The income solve already chose staffed and powered recipes. For a map
    // draft, optimize secondary power assignments once pickup shares exist.
    const provisional=input?.roster && !Object.keys(input.roster.dispatch??{}).length;
    if(provisional && input.map_dispatch_pending && input.always_running && !switchingWorkshops(input).length)return incumbent;
    for(const option of options){
        const list=groups.get(option[1])??[];
        list.push(option);groups.set(option[1],list);
    }
    const switches=new Set([...groups]
        .filter(([name,g])=>!fixedRecipes?.has(name)&&g.some(o=>o[4])&&g.some(o=>!o[4])&&g.some(o=>original[o[0]]>1e-10))
        .map(([name])=>name));
    if(!switches.size && !(pools.length && input && !provisional))return incumbent;
    if(!pools.length && (!pkg?.get_all_items || !report))return incumbent;
    const rows=[],warm=[...original],added=[],working=[],counts=[],integer=[],reserveCounts=[];
    const row=(terms,op,value)=>rows.push(' power_shift_'+rows.length+': '+expression(terms)+' '+op+' '+value);
    const fix=(v)=>row([[v,1]],'=',Math.abs(original[v])<1e-12?0:original[v]);
    // Free equivalent worker variants even for residents and other buildings
    // that cannot use E-mode. Keep their recipe, physical tier and output.
    const transferable=new Set();
    const held=new Set((problem.recipe_variables??[])
        .filter(([,name])=>!switches.has(name)&&!fixedRecipes?.has(name)).map(([v])=>v));
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
    const isGeneratorVar=v=>keys[v]?.startsWith('staff:Crackle Generator:')||keys[v]==='generators#0';
    if(pools.length){
        const reserveWork=[];
        for(const [member,p] of pools.entries()){
            if(!p.work.length&&!p.anchors.length)continue;
            const deployed=scorePool(p,original);
            const count=countFor(p.work,deployed,p.anchors,p.active);
            if(p.reserve){reserveCounts.push([count,1]);reserveWork.push(...p.work.filter(([v])=>!isGeneratorVar(v)));}
            const helpers=input?.crop_peak_helpers?.[member]??0;
            if(helpers>0 || p.crop.some(v=>original[v]>1e-9)){
                const spare=(input?.roster?.members?.[member]?.count??0)-deployed-helpers;
                // A resident's unit occupies a permanent post, just like a
                // generator or climate assignment. Keep one copy harvesting
                // while an idle copy of the same family takes that post.
                const anchors=new Set(p.anchors);
                const permanent=v=>keys[v].startsWith('staff:') || (anchors.has(v) && keys[v].startsWith('units:'));
                const posts=p.work.filter(([v])=>permanent(v));
                if(!provisional && !p.reserve && spare>0 && posts.length){
                    const mobile=p.work.filter(([v])=>!permanent(v));
                    row(mobile,'<=',sum(mobile,original)+1e-9);
                    row(posts,'<=',sum(posts,original)+spare);
                }else row(p.work,'<=',sum(p.work,original)+1e-9);
            }
        }
        if(reserveCounts.length){
            row(reserveCounts,'<=',pools.filter(p=>p.reserve).reduce((n,p)=>n+scorePool(p,original),0));
            if(reserveWork.length)row(reserveWork,'<=',sum(reserveWork,original)+1e-9);
        }
        const manualWorking=working.filter(([v])=>!isGeneratorVar(v));
        score=values=>({people:pools.reduce((n,p)=>n+scorePool(p,values),0),manualWork:sum(manualWorking,values),work:sum(working,values),
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
            return keepsProduction(before,plan)?generatedScore(plan,input,definitions):null;
        };
    }
    if(!counts.length)return incumbent;
    // Prefer switching manual work to E-mode whenever total occupied Aniimo
    // (and reserves) do not increase. A tiny generator tie-break avoids turning
    // on an idle generator that does not reduce manual work.
    const genPenalty=1e-5;
    const weight=2+Math.ceil(Math.max(sum(working,original),baseline.work,baseline.people));
    const costs=new Map();
    for(const [v,c] of working)costs.set(v,(costs.get(v)||0)-c*(isGeneratorVar(v)?genPenalty:1));
    const draftProof=provisional && input.map_dispatch_pending && input.always_running && pools.length;
    const workload=draftProof?[...costs].map(([v,c])=>[v,-c]):null;
    const headWeight=weight*(1+(provisional?0:baseline.reserves||0));
    for(const [v] of counts)costs.set(v,(costs.get(v)||0)-headWeight);
    if(!provisional)for(const [v] of reserveCounts)costs.set(v,(costs.get(v)||0)-weight);
    const exposed=[];
    let reference;
    if(input?.always_running&&!provisional&&input.roster&&switches.size&&report&&pkg?.get_all_items){
        reference=report(original);
        if(reference?.success){
            if(!catalogs.has(pkg))catalogs.set(pkg,new Map(JSON.parse(pkg.get_all_items()).map(r=>[r.name,r])));
            for(const name of contestedShifts(reference,catalogs.get(pkg),input.roster)){
                if(!switches.has(name))continue;
                const group=groups.get(name),manual=group.filter(o=>!o[4]).map(o=>[o[0],1]);
                const flag=warm.length, flow=sum(group.map(o=>[o[0],1]),original);
                warm.push(Number(sum(manual,original)>1e-10));
                added.push(' 0 <= x'+flag+' <= 1');integer.push(' x'+flag);
                row([...manual,[flag,-flow]],'<=',0);
                // Removing one exposed recipe takes precedence over lower staffing
                // costs, within the current headcount and exact production totals.
                costs.set(flag,-(1+headWeight*baseline.people+weight*baseline.reserves+baseline.work));
                exposed.push(manual);
            }
            if(exposed.length)row(counts,'<=',baseline.people);
        }
    }
    const objective=[...costs];
    const lp=problem.lp.replace(/^Maximize\n[^\n]+/,'Maximize\n obj: '+expression(objective))
        .replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n'+(added.length?added.join('\n')+'\n':''))
        .replace('\nGeneral\n','\nGeneral\n'+(integer.length?integer.join('\n')+'\n':''));
    const model={...problem,lp,variables:warm.length,variable_keys:keys.concat(integer.map((_,i)=>'power_team:'+i)),
        tiebreak:[],primary_objective:objective};
    const precision=provisional?{}:{mip_feasibility_tolerance:1e-9,primal_feasibility_tolerance:1e-9};
    const settings={mip_max_nodes:2147483647,mip_rel_gap:0,mip_abs_gap:0,...precision};
    const draft=draftProof && workload.length && workload.every(([,c])=>c>=0)
        ? await solveDraftShift(model,settings,solve,warm,counts,workload,headWeight) : null;
    const result=draft ?? await solve(model,settings,undefined,warm);
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
    if(!after||after.people>baseline.people)return incumbent;
    if(pools.length && !provisional && after.reserves>baseline.reserves)return incumbent;
    const manualRecipes=vals=>exposed.filter(terms=>sum(terms,vals)>1e-10).length;
    const riskChange=manualRecipes(values)-manualRecipes(original);
    const betterLoad=after.manualWork<baseline.manualWork-1e-8
        || (Math.abs(after.manualWork-baseline.manualWork)<=1e-8 && after.work<baseline.work-1e-8);
    const staffingImproved=after.people<baseline.people || (after.people===baseline.people &&
        ((!provisional && after.reserves<baseline.reserves) || ((provisional || after.reserves===baseline.reserves) && betterLoad)));
    if(riskChange>0 || (riskChange===0 && !staffingImproved))return incumbent;
    if(report && pools.length){
        reference??=report(original);
        if(!keepsProduction(reference,report(values)))return incumbent;
    }
    return {...incumbent,values};
}
