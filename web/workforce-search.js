// Minimize whole working Aniimo after all production stages. These extra counters are
// derived from the native model's actual workload, not from a guess based on abilities.
import {workerUsage,comparePlans} from './opportunity-comparison.js?v=two-ability';
export {workerUsage};

// Older saved plans did not retain their final stage. Reconstruct its production
// floors, rather than rerunning priorities and obtaining a different, weaker team.
export function referenceStage(plan) {
    if (plan.comparison_stage) return plan.comparison_stage;
    const goals=plan.comparison_goals||{},scores=plan.comparison_scores||{};
    const stage={floors:goals.floors||[],crop_variety:goals.crop_variety,pace:goals.pace,
        material_pace:scores.material_pace};
    if (scores.stock!=null) return {...stage,coins:goals.currency_value,material_work:scores.material_work};
    if (scores.material_work!=null) {
        const currency=goals.currency||'coins';
        stage.floors=[...stage.floors.filter(([name])=>name!==currency),
            [currency,Math.max(goals.currency_value||0,...stage.floors.filter(([name])=>name===currency).map(([,v])=>v))]];
        stage.maximize_material_work=true;
    }
    return stage;
}

export function checkedTeamReference(original,candidate,input) {
    if(candidate?.success && comparePlans(original,candidate,input,{...input,opportunity_goal:'team_size'}).direction>=0)
        return candidate;
    // A timeout, invalid point or worse repeat search cannot become the baseline
    // for later alternatives. Keep the actual current plan and its known seed.
    return {...original,proven_optimal:false,workforce_proven:false};
}
export async function searchWorkforce(problem, incumbent, solve, options) {
    const loads=problem.worker_loads;
    if (!loads?.length || incumbent?.values?.length!==problem.variables) return null;
    const n=problem.variables;
    const heads=loads.map(([,capacity,terms],i)=>({v:n+i,capacity,terms}));
    const expression=terms=>terms.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    const rows=heads.map(({v,terms},i)=>` crew_load_${i}: ${expression(terms)} - x${v} <= 0`);
    if(problem.primary_objective?.length) rows.push(` crew_production: ${expression(problem.primary_objective)} >= ${incumbent.objective-Math.max(1e-9,Math.abs(incumbent.objective)*1e-6)}`);
    let lp=problem.lp.replace(/Maximize\n[\s\S]*?\nSubject To\n/,
        `Maximize\n obj: ${heads.map(({v})=>`- x${v}`).join(' ')}\nSubject To\n`)
        .replace('\nBounds\n',`\n${rows.join('\n')}\nBounds\n${heads.map(({v,capacity})=>` 0 <= x${v} <= ${capacity}`).join('\n')}\n`)
        .replace('\nGeneral\n',`\nGeneral\n${heads.map(({v})=>` x${v}`).join('\n')}\n`);
    const seed=[...incumbent.values,...heads.map(({terms,capacity})=>Math.min(capacity,Math.max(0,Math.ceil(terms.reduce((s,[v,c])=>s+c*(incumbent.values[v]||0),0)-1e-7))))];
    const model={...problem,lp,variables:n+heads.length,tiebreak:[],
        primary_objective:heads.map(({v})=>[v,-1]),
        variable_keys:[...(problem.variable_keys||[]),...loads.map(([member])=>`crew-count:${member}`)]};
    const answer=await solve(model,options,undefined,seed);
    if(!answer?.values || answer.values.length!==model.variables) return null;
    // Independently check every new counter. The original production/flow/workplace
    // constraints are still checked by the native plan checker after truncating counters.
    let total=0;
    for(const {v,capacity,terms} of heads){
        const count=answer.values[v],busy=terms.reduce((s,[j,c])=>s+c*answer.values[j],0);
        if(!Number.isFinite(count)||!Number.isFinite(busy)||count<0||count>capacity+1e-7
            ||Math.abs(count-Math.round(count))>1e-7||busy>count+1e-7)return null;
        total+=Math.round(count);
    }
    const values=answer.values.slice(0,n);
    const objective=(problem.primary_objective||[]).reduce((s,[v,c])=>s+c*values[v],0);
    if(objective<incumbent.objective-Math.max(1e-8,Math.abs(incumbent.objective)*1.1e-6))return null;
    return {values,objective,proven:incumbent.proven&&answer.proven,workers:total,workers_proven:answer.proven};
}
