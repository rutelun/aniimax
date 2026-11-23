import {parseLinearLp} from './highs-reuse.js';

// At positive upgrade pace, every unstocked input must be produced. A material
// balance can offer several variants for the same output. If a whole set of
// required variants occurs on its consuming side, at least one rate on the
// producing side must be positive. Each such rate needs a physical building.
export function requiredRecipeSites(problem, model, positiveObjective=false) {
    if (!model || model.bounds.some(([lo])=>lo<0)) return [];
    const required = model.bounds.flatMap(([lo],v)=>lo>0?[[v]]:[]);
    if (positiveObjective) {
        const objective = model.costs.flatMap((c,v)=>c>0?[v]:[]);
        if (objective.length) required.push(objective);
    }
    const rates = new Set(problem.recipe_options.map(([v])=>v));
    const capacity = new Map();
    const balances = [];
    for (const {coefficients,lo,hi} of model.rows) {
        if (hi<=0) {
            const negative = coefficients.filter(([,c])=>c<0);
            if (negative.length===1) {
                const to = negative[0][0];
                const key = problem.variable_keys[to];
                if (key.startsWith('units:') || key.startsWith('continuous_site:')) {
                    for (const [from,c] of coefficients) if (c>0) capacity.set(from,to);
                }
            }
        }
        if (lo<0) continue;
        const producers = coefficients.filter(([,c])=>c>0).map(([v])=>v);
        if (producers.length && producers.every(v=>rates.has(v))) {
            const consumers = new Set(coefficients.filter(([,c])=>c<0).map(([v])=>v));
            balances.push({producers,consumers});
        }
    }
    // Measured dispatch can split one physical station between several
    // fractional worker-time columns. Follow their common integer site.
    const sites = new Map();
    for (const rate of rates) {
        let column = rate;
        const seen = new Set();
        while (capacity.has(column) && !seen.has(column)) {
            seen.add(column);
            column = capacity.get(column);
            if (model.integers[column]) {
                sites.set(rate,column);
                break;
            }
        }
    }
    const groups = [];
    for (const variants of required) {
        for (let i=balances.length-1;i>=0;i--) {
            const {producers,consumers} = balances[i];
            if (!variants.every(v=>consumers.has(v))) continue;
            balances.splice(i,1);
            required.push(producers);
            if (producers.every(v=>sites.has(v))) {
                const group = [...new Set(producers.map(v=>sites.get(v)))];
                groups.push(group);
            }
        }
    }
    return groups;
}

export function requiredSiteRows(problem, parsed, positiveObjective=false) {
    if (!problem.recipe_options?.length || problem.variable_keys?.length!==problem.variables) return [];
    const groups=requiredRecipeSites(problem,parsed ?? parseLinearLp(problem.lp,problem.variables),positiveObjective);
    return groups.map((group,i)=>` required_site_${i}: ${group.map(v=>'x'+v).join(' + ')} >= 1`);
}

// A required chain can leave only one kiln per recipe even when the player
// owns four kilns. Deduce those limits from the model's actual capacity rows.
export function requiredSiteCapacity(problem) {
    if(!problem.recipe_options?.length || !problem.recipe_variables?.length)return;
    const model=parseLinearLp(problem.lp,problem.variables,false);
    if(!model)return;
    const sites=new Map(),owners=new Map();
    for(const [v,name] of problem.recipe_variables){
        if(!model.integers[v] || !/^(units:|continuous_site:)/.test(problem.variable_keys[v]))continue;
        if(!sites.has(name))sites.set(name,[]);
        sites.get(name).push(v);owners.set(v,name);
    }
    const groups=requiredRecipeSites(problem,model);
    const required=groups.filter(group=>{
        const name=owners.get(group[0]);
        return name!=null && group.every(v=>owners.get(v)===name);
    });
    if(!required.length)return;
    const limits={};
    for(const {hi,coefficients} of model.rows){
        if(!Number.isSafeInteger(hi) || hi<1 || coefficients.some(([,c])=>c<0))continue;
        const columns=new Set(coefficients.filter(([v,c])=>c>=1 && owners.has(v)).map(([v])=>v));
        const needed=new Set(required.filter(group=>group.every(v=>columns.has(v))).map(group=>owners.get(group[0])));
        if(!needed.size)continue;
        for(const name of new Set([...columns].map(v=>owners.get(v)))){
            const group=sites.get(name);
            const cap=hi-needed.size+Number(needed.has(name));
            if(cap>=0 && group.every(v=>columns.has(v)) && group.some(v=>model.bounds[v][1]>cap)){
                limits[name]=Math.min(limits[name]??Infinity,cap);
            }
        }
    }
    if(!Object.keys(limits).length)return;
    const requirements=groups.map(group=>{
        const name=owners.get(group[0]);
        const one=limits[name]===1 && group.every(v=>owners.get(v)===name);
        return {keys:group.map(v=>problem.variable_keys[v]),one};
    });
    return {limits,requirements};
}

// A smaller model can renumber columns. Retain all alternative sites from the
// original proof before requiring a whole building for its material output.
export function applyRequiredSites(problem,capacity){
    if(!capacity)return problem;
    const index=new Map(problem.variable_keys.map((key,v)=>[key,v]));
    const rows=new Set();
    for(const {keys,one} of capacity.requirements){
        const sites=keys.map(key=>index.get(key));
        if(sites.every(v=>v!=null))rows.add(sites.map(v=>'x'+v).join(' + ')+(one?' = 1':' >= 1'));
    }
    if(!rows.size)return problem;
    const constraints=[...rows].map((rhs,i)=>' reserved_recipe_'+i+': '+rhs);
    return {...problem,lp:problem.lp.replace('\nBounds\n','\n'+constraints.join('\n')+'\nBounds\n')};
}

// This is an upper bound only. A plan reaching it has to be checked against
// every integer decision and every continuous-production constraint.
export function priorityCeiling(highs, problem, goal, onOptimum) {
    if (!problem?.lp || !(goal==='crop_variety' || problem.production_only)) return null;
    let lp = problem.lp;
    if ((goal==='level_up' || goal==='material_work') && problem.recipe_options?.length && problem.variable_keys?.length===problem.variables) {
        const cuts = requiredSiteRows(problem,null,goal==='level_up');
        if (cuts.length) lp = lp.replace('\nBounds\n','\n'+cuts.join('\n')+'\nBounds\n');
    }
    const model = highs.createModel({format:'lp',data:lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd')});
    try {
        model.options.set({primal_feasibility_tolerance:1e-9,dual_feasibility_tolerance:1e-9});
        model.run();
        const status = model.getModelStatus();
        if (goal==='level_up' && status===highs.constants.modelStatus.infeasible && lp!==problem.lp) return 0;
        if (status!==highs.constants.modelStatus.optimal) return null;
        const upper = model.getObjectiveValue();
        if (!Number.isFinite(upper)) return null;
        onOptimum?.(model);
        // Crop variety awards an integer score for each distinct crop.
        return goal==='crop_variety' ? Math.floor(upper+1e-7) : Math.max(0,upper);
    } finally {
        model.dispose();
    }
}
