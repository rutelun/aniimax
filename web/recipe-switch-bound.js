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
