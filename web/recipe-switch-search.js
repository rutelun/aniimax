import {materialFlowSchedule} from './material-flow-schedule.js';
import {buildRecipeSchedule,readRecipeSchedule} from './recipe-schedule.js';
import {scheduleInputForPlan,attachRecipeSchedule,materialChainSchedule} from './recipe-schedule-plan.js';

export function improvesPlan(candidate,baseline) {
    if(!candidate?.success)return false;
    if(!baseline?.success)return true;
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
        const tolerance=1e-5*Math.max(1,Math.abs(a),Math.abs(b));
        if(a>b+tolerance)return true;
        if(a<b-tolerance)return false;
    }
    return candidate.rate_per_second>baseline.rate_per_second+1e-5*Math.max(1,Math.abs(baseline.rate_per_second));
}

const materialWorkshops = ['Woodworking Bench','Chimney Kiln'];
const materialChoice = input => ({normal:true, facilities:materialWorkshops.filter(f=>input.facilities?.[f]?.some(t=>t.count>0))});
const switchTrial = (input, choice) => ({...input, recipe_switching_relaxation:true,
    recipe_switching_facilities:choice.facilities, recipe_switching_normal_only:!!choice.normal, maximize_material_work:false});

export async function proveFirstSwitch(input, boundsFor, candidate, progress=()=>{}) {
    if (!input.always_running || !input.recipe_switching?.max_buildings || !input.recipe_switching.max_switches
        || input.fixed_homeland || input.level_up || input.level_up_strategy || input.prioritize_byproducts
        || input.priorities?.[0] !== 'level_up' || !input.level_up_preview) return null;
    const choice = materialChoice(input);
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
            const schedule = materialFlowSchedule(data);
            if (schedule) return {winner:attachRecipeSchedule(proposed,data,schedule)};
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
function speculate(trial,createWorker,active) {
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
            worker.postMessage({type:'switch_candidate',id:1,payload:JSON.stringify(trial)});
        }catch{finish(null);}
    });
}

export async function searchRecipeSwitches(input,baseline,{candidate,solve,progress=()=>{},createWorker,parallel=1,firstProposal}) {
    const limits=input.recipe_switching;
    if(!limits?.max_buildings||!limits.max_switches )return baseline;
    if(input.fixed_homeland)return {...baseline,recipe_switching_note:'Recipe switching requires an automatically generated layout.'};
    progress('recipe_switching','start');
    const active=new Set();
    try {
        const groups=new Map();
        for(const row of baseline.coin_items||[])if(row.status==='producing'&&!row.is_grower){
            if(!groups.has(row.facility))groups.set(row.facility,new Set());
            groups.get(row.facility).add(row.item_name);
        }
        const materialFirst=(input.priorities||[]).includes('level_up')||input.level_up;
        const preferred=materialFirst?['Woodworking Bench','Chimney Kiln','Crafting Table','Carousel Mill']:['Crafting Table','Carousel Mill','Woodworking Bench','Chimney Kiln'];
        const eligible=[...new Set([...preferred,...groups.keys()])].filter(f=>baseline.success?groups.get(f)?.size>1:input.facilities?.[f]?.some(t=>t.count>0));
        const facilities=eligible.slice(0,Math.max(1,limits.max_buildings));
        let detail=null;
        const choices=[...(materialFirst?[materialChoice(input)]:[]),{facilities},...facilities.slice(0,2).map(f=>({facilities:[f]}))].filter((v,i,a)=>a.findIndex(x=>JSON.stringify(x)===JSON.stringify(v))===i);
        const trials=choices.map(choice=>switchTrial(input,choice));
        const width=createWorker?Math.min(choices.length,Math.max(1,parallel)):1;
        const pending=new Map();
        for(const [index,chosen] of choices.entries()){
            if(width>1 && index%width===0 && index+1<trials.length){
                // Keep the parent responsive: nested workers need its event
                // loop during startup. Accept replies in the original order.
                for(let j=index;j<Math.min(index+width,trials.length);j++){
                    if(j===0 && firstProposal)continue;
                    pending.set(j,speculate(trials[j],createWorker,active));
                }
            }
            try{
                const proposed=(index===0 ? firstProposal : null) ?? (await pending.get(index)) ?? await candidate(trials[index]);
                if(!improvesPlan(proposed,baseline))continue;
                const scheduleInput=scheduleInputForPlan(input,proposed);
                if(chosen.normal){
                    const flow=materialFlowSchedule(scheduleInput);
                    if(flow){
                        try{return attachRecipeSchedule(proposed,scheduleInput,flow);}
                        catch(error){detail=String(error.message||error);}
                    }
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
        return {...baseline,recipe_switching_note:detail?'No verified switching improvement found; keeping the ordinary plan.':'No improvement found; keeping the ordinary plan.',...(detail?{recipe_switching_detail:detail}:{})};
    } catch(error) {
        return {...baseline,recipe_switching_note:'No verified switching improvement found; keeping the ordinary plan.',recipe_switching_detail:String(error.message||error)};
    } finally {
        for(const worker of active)worker.terminate();
        active.clear();
        progress('recipe_switching','done',false);
    }
}
