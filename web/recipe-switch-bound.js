// The first material-switch trial has the same workshops regardless of the
// ordinary plan's layout. Bound that plan before paying for its lower priorities.
const {priorityCeiling}=await import('./priority-ceilings.js'+new URL(import.meta.url).search);
import {materialChains} from './material-flow-schedule.js';
import {productionObjective} from './priority-search.js';

// The direct schedule runs two raw processors at dawn, then one. Use the
// already-solved relaxation to decide whether trying this schedule first is
// worthwhile. The ordinary ordered search still considers every proposal.
export function suggestsMaterialFlow(problem, values, input) {
    const chains=new Map();
    for(const [v,name,facility,,electric,cycle] of problem.recipe_options){
        const tier=materialChains[facility]?.indexOf(name)??-1,rate=values[v];
        if(tier<0 || !(rate>1e-9))continue;
        if(!chains.has(facility))chains.set(facility,Array(4).fill(0));
        const chain=chains.get(facility);
        if(electric || chain[tier]>0)return false;
        chain[tier]=rate*cycle;
        if(tier===0 && input.roster){
            const crew=/__by(\d+)/.exec(problem.variable_keys[v]);
            if(crew && input.roster.members?.[Number(crew[1])]?.count<2)return false;
        }
    }
    return chains.size>0 && [...chains.values()].every(chain=>chain.every(load=>load>0)
        && chain[0]>1+1e-8 && chain[0]<2-1e-8);
}

export function upgradeSwitchBounds(pkg, highs, input, trial) {
    const payload = settings => JSON.stringify({...settings, always_running_recipes:[], restrict_to_checked_recipes:false});
    let plausible=false;
    const pace = (data,checkFlow=false) => {
        const problem = JSON.parse(pkg.exact_priority_problem(data, '{"floors":[]}', 'level_up'));
        return priorityCeiling(highs, productionObjective(problem), 'level_up', checkFlow ? model=>{
            const source=model.getSolution().colValue,values=new Float64Array(problem.variables);
            for(let i=0;i<source.length;i++)values[Number(model.getColName(i).slice(1))]=source[i];
            plausible=suggestsMaterialFlow(problem,values,input);
        } : undefined);
    };
    const ordinary = payload(input), fixed = pace(ordinary);
    if (!(fixed > 0) || !Number.isFinite(fixed)) return null;
    const switched = pace(payload(trial),true);
    // A relaxation already too slow to beat the fixed-plan bound cannot
    // furnish this proof. Leave the ordinary comparison to rank those plans.
    if (!plausible || !(switched > fixed * (1 + 2e-5))) return null;
    const crop = input.crop_variety || input.season
        ? priorityCeiling(highs, JSON.parse(pkg.exact_crop_variety_problem(ordinary)), 'crop_variety') : null;
    if ((input.crop_variety || input.season) && !Number.isFinite(crop)) return null;
    return {seconds:86400 / fixed, crop};
}

// In the ordinary always-running schedule an active site is busy for every
// phase. Its facility and power mode never change. Summed over a day, the
// workload for each such group must equal its whole number of active sites.
// Relax all other integer decisions except the selected recipes' worker posts.
function fitsWholeSites(highs, problem) {
    const options = new Map(problem.recipe_options.map(option=>[option[0],option]));
    const groups = new Map(), recipes = new Set();
    for (const [column,tier] of problem.switching_rates) {
        const option = options.get(column);
        if (!option || !Number.isFinite(option[5]) || option[5]<=0) return true;
        const [,recipe,facility,,,cycle] = option;
        const key = JSON.stringify([facility,tier]);
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push([column,cycle]);
        recipes.add(recipe);
    }
    if (!groups.size) return false;
    const rows = [], sites = [];
    for (const rates of groups.values()) {
        const site = 'sw'+sites.length;
        const work = rates.map(([v,cycle])=>cycle+' x'+v).join(' + ');
        // scheduleInputForPlan drops individual rates at or below 1e-7.
        // Allow their full combined workload and the schedule's rounding slack.
        const slack = 1e-5 + rates.reduce((n,[,cycle])=>n+cycle*1e-7,0);
        rows.push(' lo_'+site+': '+work+' - 0.99999 '+site+' >= -'+slack,
            ' hi_'+site+': '+work+' - 1.00001 '+site+' <= '+slack);
        sites.push(site);
    }
    rows.push(' active_switch_site: '+sites.join(' + ')+' >= 1');
    const general = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const posts = (general?.[1].match(/\bx\d+\b/g)||[]).filter(column=>{
        const key = problem.variable_keys[Number(column.slice(1))];
        return key?.startsWith('post:') && recipes.has(key.slice(5).split(/__|:/,1)[0]);
    });
    const relaxed = problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd');
    const lp = relaxed.replace(/Maximize\n[\s\S]*?\nSubject To\n/,'Maximize\n obj: 0 x0\nSubject To\n')
        .replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n')
        .replace('\nEnd','\nGeneral\n '+[...sites,...posts].join('\n ')+'\nEnd');
    const model = highs.createModel({format:'lp',data:lp});
    try {
        model.run();
        if (model.getModelStatus()===highs.constants.modelStatus.infeasible) {
            // As in the ordinary planner, confirm an infeasibility report
            // without presolve before discarding a candidate.
            model.options.set({presolve:'off'});
            model.clearSolver();
            model.run();
        }
        return model.getModelStatus()!==highs.constants.modelStatus.infeasible;
    } finally {
        model.dispose();
    }
}

export function canFillSwitchingWorkshop(pkg, highs, trial, baseline) {
    if (!trial.always_running || trial.level_up_strategy || trial.level_up
        || trial.level_up_preview?.stock?.some(([,n])=>n>0)) return true;
    const facilities = trial.recipe_switching_facilities||[];
    const powered = trial.electricity || trial.e_mode_rv>=12;
    // The direct four-tier schedule permits ingredient-starved downstream
    // sites. Its raw processor still has to supply over a full site-day.
    const flow = trial.recipe_switching_normal_only && Object.keys(materialChains).some(facility=>
        (!facilities.length || facilities.includes(facility))
        && (trial.facilities?.[facility]||[]).reduce((n,t)=>n+t.count,0)>=4);
    if (flow && powered) return true;
    const seconds = baseline?.level_up_preview?.seconds;
    const stage = {floors:[]};
    if (baseline?.success && baseline.priorities?.[0]?.target==='level_up'
        && trial.priorities?.[0]==='level_up' && trial.level_up_preview && seconds>0 && Number.isFinite(seconds)) {
        // A slower upgrade can tie within improvesPlan's relative tolerance.
        stage.pace = 86400 / (seconds + 2e-5*Math.max(1,seconds));
    }
    const payload=JSON.stringify({...trial,always_running_recipes:[],restrict_to_checked_recipes:false});
    const problem=JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),trial.currency||'coins'));
    const options=problem.recipe_options;
    if(!options?.length || !problem.lp.startsWith('Maximize\n'))return true;
    if (!flow && Array.isArray(problem.switching_rates) && problem.variable_keys?.length===problem.variables) {
        return fitsWholeSites(highs,problem);
    }
    if (powered || !facilities.length) return true;
    const sites=new Set(facilities);
    const work=options.filter(([, ,facility])=>sites.has(facility)).map(([v,,,,,cycle])=>[v,cycle]);
    if(!work.length || work.some(([,cycle])=>!Number.isFinite(cycle)||cycle<=0))return true;
    const upper=priorityCeiling(highs,productionObjective({...problem,primary_objective:work}),'work');
    return !Number.isFinite(upper)||upper>=1-1e-5;
}
