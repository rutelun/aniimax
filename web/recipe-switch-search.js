import {materialFlowSchedules,switchingWorkshops} from './material-flow-schedule.js';
import {buildRecipeSchedule,readRecipeSchedule} from './recipe-schedule.js';
import {scheduleInputForPlan,attachRecipeSchedule,materialChainSchedule} from './recipe-schedule-plan.js';

function compareScore(after, before) {
    if (after == null || before == null) return 0;
    const difference = after - before;
    return Math.abs(difference) > 1e-5 * Math.max(1,Math.abs(after),Math.abs(before)) ? Math.sign(difference) : 0;
}

export function improvesPlan(candidate,baseline) {
    if(!candidate?.success)return false;
    if(!baseline?.success)return true;
    const baseScores = baseline.comparison_scores, scores = candidate.comparison_scores;
    const crops = compareScore(scores?.crop_variety,baseScores?.crop_variety);
    if (crops) return crops > 0;
    for(const priority of baseline.priorities||[]) {
        if(priority.target==='level_up'&&baseline.level_up_preview){
            const before=baseline.level_up_preview.seconds??Infinity,after=candidate.level_up_preview?.seconds??Infinity;
            if(before!==after){
                if(!Number.isFinite(after))return false;
                if(!Number.isFinite(before))return true;
                if(Math.abs(before-after)>1e-5*Math.max(1,before,after))return after<before;
            }
            continue;
        }
        const a=candidate.priorities?.find(p=>p.target===priority.target)?.per_second??0,b=priority.per_second;
        const priorityGain = compareScore(a,b);
        if (priorityGain) return priorityGain > 0;
    }
    // RV materials break ties after the selected priorities and income, just as in the ordinary plan.
    return (compareScore(candidate.rate_per_second,baseline.rate_per_second)
        || compareScore(scores?.material_pace,baseScores?.material_pace)
        || compareScore(scores?.material_work,baseScores?.material_work)) > 0;
}

const switchTrial = (input, choice) => ({...input, recipe_switching_relaxation:true,
    recipe_switching_facilities:choice.facilities, recipe_switching_normal_only:!!choice.normal});

// Prefer a timetable that the existing shift can cover before adding assumed
// copies for simultaneous work. Worker profiles include background production.
function chooseMaterialSchedule(plan,data,baseline,onError) {
    const previous=new Map();
    for(const [member,ability,level,,family] of baseline?.assumed_aniimo??[]){
        const load=(baseline.roster_workload?.[member]??0)
            +(baseline.hauling_staffing?.find(([id])=>id===member)?.[1]??0);
        const peak=Math.max(load,...(baseline.recipe_schedule?.workerProfiles?.[member]??[]));
        previous.set(JSON.stringify([ability,level,family]),Math.max(Math.ceil(peak-1e-6),
            baseline.crop_peaks?.counts?.[member]??0));
    }
    let best=null,minimum=Infinity;
    for(const flow of materialFlowSchedules(data)){
        let candidate;
        try{candidate=attachRecipeSchedule(plan,data,flow);}
        catch(error){onError?.(error);continue;}
        let additional=0;
        for(const [member,ability,level,,family] of plan.assumed_aniimo??[]){
            const profile=candidate.recipe_schedule.workerProfiles[member]??[];
            const needed=Math.ceil(Math.max(0,...profile)-1e-6);
            additional+=Math.max(0,needed-(previous.get(JSON.stringify([ability,level,family]))??0));
        }
        if(additional===0)return candidate;
        if(additional<minimum){best=candidate;minimum=additional;}
    }
    return best;
}

export function checkMaterialDraft(input,plan,baseline){
    if(!improvesPlan(plan,baseline))return null;
    try{return chooseMaterialSchedule(plan,scheduleInputForPlan(input,plan,{materialSites:true}),baseline);}
    catch{return null;}
}

// In the whole-site schedule an active recipe occupies at least one full
// machine. Its total machine-seconds therefore bound its active seconds,
// even when copies of the machine or several operators share the recipe.
export function canStaffWholeRecipes(input) {
    if(!input.alwaysRunning)return true;
    const recipes=new Map();
    for(const job of input.jobs){
        let group=recipes.get(job.recipe);
        if(!group){group={seconds:0,work:new Map()};recipes.set(job.recipe,group);}
        group.seconds+=job.batches*job.seconds;
        for(const [worker,seconds] of Object.entries(job.workers??{}))
            group.work.set(worker,(group.work.get(worker)??0)+job.batches*seconds);
    }
    for(const {seconds,work} of recipes.values())for(const [worker,needed] of work){
        const free=input.workerCapacity[worker]-(input.backgroundWorkers?.[worker]??0);
        const available=Math.max(0,free)*Math.min(input.daySeconds,seconds);
        if(needed>available+1e-5*Math.max(1,input.daySeconds,needed,available))return false;
    }
    return true;
}

export async function proveFirstSwitch(input, boundsFor, candidate, progress=()=>{}) {
    if (!input.always_running || input.fixed_homeland || input.level_up || input.level_up_strategy || input.prioritize_byproducts
        || input.priorities?.[0] !== 'level_up' || !input.level_up_preview) return null;
    const choice = {normal:true, facilities:switchingWorkshops(input)};
    // The direct material-flow proof assigns a distinct site to each of
    // four tiers in at least one chain. Smaller workshops still use the
    // ordinary schedule search, which also considers other switch patterns.
    if (!choice.facilities.some(facility =>
        input.facilities[facility].reduce((n,tier)=>n+tier.count,0) >= 4)) return null;
    const trial = switchTrial(input,choice);
    let proposed, started = false;
    try {
        const bound = await boundsFor(trial);
        if (!bound || !Number.isFinite(bound.seconds) || bound.seconds <= 0) return null;
        started = true;
        progress('recipe_switching','start');
        proposed = await candidate(trial);
        const seconds = proposed?.level_up_preview?.seconds;
        // Require the same checked first candidate the ordered search would
        // select, strictly beyond its comparison tolerance even at the bound.
        if (proposed?.success && proposed.continuous_production_checked && seconds > 0
            && seconds < bound.seconds - 2e-5 * Math.max(1,bound.seconds)
            && (bound.crop == null || proposed.comparison_scores?.crop_variety === bound.crop)) {
            const data = scheduleInputForPlan(input,proposed);
            const winner=chooseMaterialSchedule(proposed,data,proposed);
            if(winner)return {winner};
        }
    } catch {
        // A missing proof or a rejected schedule still permits the ordinary search.
    } finally {
        if (started) progress('recipe_switching','done',false);
    }
    return proposed?.success ? {proposed} : null;
}

// Each speculative worker owns one solver. A failed start or reply leaves the
// original candidate available to solve inline when its turn comes.
function speculate(trial,createWorker,active,workshopBaseline) {
    return new Promise(resolve=>{
        let worker;
        const finish=plan=>{
            if(active.delete(worker))worker.terminate();
            resolve(plan);
        };
        try{
            worker=createWorker();
            active.add(worker);
            worker.onmessage=({data})=>{
                try{finish(data.ok?JSON.parse(data.result):null);}
                catch{finish(null);}
            };
            worker.onerror=worker.onmessageerror=()=>finish(null);
            worker.postMessage({type:'switch_candidate',id:1,payload:JSON.stringify(trial),workshopBaseline});
        }catch{finish(null);}
    });
}

export async function searchRecipeSwitches(input,baseline,{candidate,solve,progress=()=>{},createWorker,parallel=1,firstProposal,canFillWorkshop,workshopBaseline}) {
    const facilities = switchingWorkshops(input);
    if (!facilities.length) return baseline;
    progress('recipe_switching','start');
    const active=new Set();
    let searching=true;
    try {
        // Try both chains together, then each independently in case their schedules conflict.
        const groups = [facilities];
        if (facilities.length > 1) groups.push(...facilities.map(facility => [facility]));
        const choices = groups.flatMap(facilities => input.e_mode_rv >= 12 || input.electricity
            ? [{facilities,normal:true}, {facilities}] : [{facilities,normal:true}]);
        let detail=null;
        // Each worker can check its own workshop while the earlier choices run.
        // A previously solved proposal and an inline retry still need the same check.
        const workerBound=createWorker && parallel>1 && choices.length>1 ? workshopBaseline : null;
        const fits=async trial=>{
            try { return !canFillWorkshop || await canFillWorkshop(trial); }
            catch { return true; }
        };
        const trials=[];
        for(const [index,choice] of choices.entries()) {
            const trial=switchTrial(input,choice);
            const proposal=index===0?firstProposal:null;
            if(canFillWorkshop && (!workerBound || proposal) && !await fits(trial)) continue;
            trials.push({choice,trial,proposal});
        }
        const width=createWorker?Math.min(trials.length,Math.max(1,parallel)):1;
        const pending=new Map();
        let next=0, current=0;
        const startNext=()=>{
            while(next<trials.length && trials[next].proposal)next++;
            if(!searching || next===trials.length || active.size>=width)return;
            const index=next++;
            const reply=speculate(trials[index].trial,createWorker,active,workerBound);
            pending.set(index,reply);
            // Results are consumed in order below. A later choice that has
            // already finished can release its slot before the earlier one does.
            reply.then(plan=>{if(plan && index>current)startNext();});
        };
        if(width>1)for(let slot=0;slot<width;slot++)startNext();
        for(const [index,{choice:chosen,proposal}] of trials.entries()){
            current=index;
            if(width>1 && index>0)startNext();
            try{
                const trial=trials[index].trial;
                let proposed=proposal ?? await pending.get(index);
                if (!proposed) {
                    if (workerBound && !await fits(trial)) continue;
                    proposed=await candidate(trial);
                }
                if(!improvesPlan(proposed,baseline))continue;
                const scheduleInput=scheduleInputForPlan(input,proposed);
                if(chosen.normal){
                    const candidate=chooseMaterialSchedule(proposed,scheduleInput,baseline,
                        error=>{detail=String(error.message||error);});
                    if(candidate)return candidate;
                }
                if(!canStaffWholeRecipes(scheduleInput)){
                    detail='A workshop recipe needs more crew than is available while it runs.';
                    continue;
                }
                const pattern=chosen.normal?materialChainSchedule(scheduleInput):null;
                for(const attempt of [pattern,scheduleInput].filter(Boolean)){
                    const model=buildRecipeSchedule(attempt),solution=await solve(model);
                    if(!solution?.Columns||!['Optimal','Time limit reached','Iteration limit reached','Solution limit reached'].includes(solution.Status)){detail='No feasible common schedule found.';continue;}
                    try{return attachRecipeSchedule(proposed,attempt,readRecipeSchedule(model,solution));}
                    catch(error){detail=String(error.message||error);}
                }
            }catch(error){detail=String(error.message||error);}
        }
        if(baseline.recipe_schedule)return baseline;
        return {...baseline,recipe_switching_note:detail?'No verified switching improvement found; keeping the ordinary plan.':'No improvement found; keeping the ordinary plan.',...(detail?{recipe_switching_detail:detail}:{})};
    } catch(error) {
        if(baseline.recipe_schedule)return baseline;
        return {...baseline,recipe_switching_note:'No verified switching improvement found; keeping the ordinary plan.',recipe_switching_detail:String(error.message||error)};
    } finally {
        searching=false;
        for(const worker of active)worker.terminate();
        active.clear();
        progress('recipe_switching','done',false);
    }
}
