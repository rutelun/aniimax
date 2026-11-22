// Bound integer assignments against a feasible score for this exact objective.
// The LP may split buildings. Its optimal dual prices bound the loss from
// moving a variable away from a bound, even after other decisions are reoptimized.
import {parseLinearLp} from './highs-reuse.js';
const {requiredSiteRows}=await import('./priority-ceilings.js'+new URL(import.meta.url).search);

export function resourceBounds(highs, problem, witness) {
    const values=witness?.values;
    if(!problem.recipe_options?.length || problem.variable_keys?.length!==problem.variables
        || values?.length!==problem.variables || !values.every(Number.isFinite))return null;
    const parsed=parseLinearLp(problem.lp,problem.variables);
    if(!parsed || !parsed.integers.some(Boolean))return null;
    const score=parsed.costs.reduce((sum,c,v)=>sum+c*values[v],0);
    if(!Number.isFinite(score))return null;
    // Callers supply a feasible result from the same model (or a restriction
    // of it). Reject a misaligned witness before using its score as a floor.
    const eps=1e-7;
    for(let v=0;v<values.length;v++){
        const [lo,hi]=parsed.bounds[v],x=values[v];
        if(x<lo-eps || x>hi+eps || parsed.integers[v] && Math.abs(x-Math.round(x))>eps)return null;
    }
    for(const row of parsed.rows){
        const lhs=row.coefficients.reduce((sum,[v,c])=>sum+c*values[v],0);
        if(lhs<row.lo-eps || lhs>row.hi+eps)return null;
    }
    const rows=requiredSiteRows(problem,parsed);
    const required=rows.length;
    const withRows=lp=>rows.length?lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n'):lp;
    const model=highs.createModel({format:'lp',data:withRows(problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd'))});
    try{
        model.options.set({primal_feasibility_tolerance:1e-9,dual_feasibility_tolerance:1e-9});
        model.run();
        if(model.getModelStatus()!==highs.constants.modelStatus.optimal)return null;
        const upper=model.getObjectiveValue();
        const margin=1e-7*Math.max(1,Math.abs(score),Math.abs(upper));
        if(!Number.isFinite(upper) || upper<score-margin)return null;
        const gap=Math.max(0,upper-score)+margin;
        const solution=model.getSolution();
        for(let i=0;i<solution.colValue.length;i++){
            const v=Number(model.getColName(i).slice(1));
            if(!parsed.integers[v])continue;
            const [lo,hi]=parsed.bounds[v],x=solution.colValue[i],price=solution.colDual[i];
            if(lo===hi || !Number.isFinite(price))continue;
            if(price < -eps && Math.abs(x-lo)<eps){
                const cap=Math.floor(lo+gap/-price+eps);
                if(cap<hi && values[v]<=cap+eps)rows.push(' priced_upper_'+v+': x'+v+' <= '+cap);
            }else if(price > eps && Math.abs(x-hi)<eps){
                const minimum=Math.ceil(hi-gap/price-eps);
                if(minimum>lo && values[v]>=minimum-eps)rows.push(' priced_lower_'+v+': x'+v+' >= '+minimum);
            }
        }
        return {upper,score,pricedColumns:rows.length-required,problem:rows.length?{...problem,lp:withRows(problem.lp)}:problem};
    }finally{model.dispose();}
}
