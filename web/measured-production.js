import {polishSolution} from './highs-solve.js';

// A map changes dispatch eligibility, travel and worker shares. Preserve the number
// of plots per crop rather than worker-specific variants, posts or workshop formulas.
// All processors remain available, including those absent from the unmeasured shift.
export async function measuredProductionShift({modelFor, counts, checked, seed, solveModel, highs}) {
    if (!counts || !checked?.length || seed?.keys?.length !== seed?.values?.length || !seed?.keys?.length) return null;
    const names = new Set(checked);
    let previous = new Map(seed.keys.map((key,i) => [key,seed.values[i]]));
    for (let pass=0; pass<3; pass++) {
        const problem = modelFor([...names]);
        if (!problem.production_only || !problem.primary_objective?.length) return null;
        const crops = new Set(problem.recipe_options.filter(([, , facility]) =>
            facility === 'Farmland' || facility === 'Woodland').map(([, name]) => name));
        const rows = [];
        let planted = 0;
        for (const [name, terms] of problem.integer_groups) {
            if (!crops.has(name)) continue;
            const plots = counts[name] ?? 0;
            if (!Number.isSafeInteger(plots) || plots<0) return null;
            rows.push(` planted_${terms[0][0]}: ${terms.map(([v,c]) => c+' x'+v).join(' + ')} = ${plots}`);
            planted += plots;
        }
        if (!planted) return null;
        const local = {...problem, continuousRestricted:true,
            lp:problem.lp.replace('\nBounds\n', '\n'+rows.join('\n')+'\nBounds\n')};
        const warm = problem.variable_keys.map(key => key.startsWith('extra#') ? 0 : previous.get(key) ?? 0);
        const result = await solveModel(local,{time_limit:2,mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9},
            undefined,warm);
        if (!result?.values) return null;
        const {values} = polishSolution(highs,local,result);
        const active = [...new Set(problem.recipe_variables.filter(([v]) => values[v]>1e-9).map(([,name])=>name))];
        const missing = active.filter(name => !names.has(name));
        if (!missing.length) {
            const objective = problem.primary_objective.reduce((sum,[v,c]) => sum+c*values[v],0);
            return {keys:problem.variable_keys,values,objective,active,checked:[...names]};
        }
        // Rebuild the mixed-integer model with the newly active recipes' work and
        // availability constraints. An unchecked proposal never becomes an incumbent.
        missing.forEach(name => names.add(name));
        previous = new Map(problem.variable_keys.map((key,i) => [key,values[i]]));
    }
    return null;
}
