// Intermediate lexicographic stages need the largest production value, not a preferred
// staffing/layout among equal producers. Those preferences are optimized by the final model.
// Mixing tiny staffing penalties into every stage makes branch-and-bound prove irrelevant
// distinctions repeatedly, and can even trade a little of an earlier production priority away.
export function productionObjective(problem) {
    if (!problem.primary_objective?.length) return problem;
    const objective = problem.primary_objective.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    return {...problem,production_only:true,tiebreak:[],lp:problem.lp.replace(/Maximize\n[\s\S]*?\nSubject To\n/,
        `Maximize\n obj: ${objective}\nSubject To\n`)};
}

export function productionCertificate(problem,result) {
    if (!problem.production_only || !result?.proven || !Number.isFinite(result.objective)
        || problem.variable_keys?.length !== problem.variables) return null;
    return {upper:result.objective+1e-6+Math.abs(result.objective)*1e-9,
        terms:problem.primary_objective.map(([v,c])=>[problem.variable_keys[v],c])};
}

// A proved integer optimum remains an upper bound when later priorities add constraints.
// Carrying it into their relaxations prevents repeatedly branching to rediscover that bound.
// Certificates belong to this input/run only; they are never carried across upgrades.
export function withProductionBounds(problem,certificates) {
    if (!certificates.length || problem.variable_keys?.length !== problem.variables) return problem;
    const variables=new Map(problem.variable_keys.map((key,i)=>[key,i]));
    const rows=certificates.flatMap((bound,i)=>{
        if (!bound.terms.every(([key])=>variables.has(key))) return [];
        const terms=bound.terms.map(([key,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${variables.get(key)}`).join(' ');
        return [` priority_upper_${i}: ${terms} <= ${bound.upper}`];
    });
    return rows.length ? {...problem,lp:problem.lp.replace('\nBounds\n',`\n${rows.join('\n')}\nBounds\n`)} : problem;
}
