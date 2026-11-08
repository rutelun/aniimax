// Optimization-based bound tightening (OBBT). One reusable LP basis bounds whole
// recipe/building counts. Rounded bounds are valid integer cuts, never guesses
// based on what happened to be idle in a previous solution.
export function tightenIntegerBounds(highs,problem,incumbent,{timeLimit=4,now=()=>performance.now()}={}) {
    if(!problem.integer_groups?.length || !problem.production_only || !problem.primary_objective?.length
        || problem.variable_keys?.length!==problem.variables || !incumbent?.values
        || incumbent.values.length!==problem.variables || !Number.isFinite(incumbent.objective) || !(incumbent.objective>1e-9))return [];
    const expression=terms=>terms.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    // Later priorities retain this currency with the native 0.01% floor slack.
    // Probe at that weaker floor so the cuts remain valid for those later models.
    const floor=incumbent.objective*(1-1e-4);
    const lp=problem.lp.replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd')
        .replace('\nBounds\n',`\n obbt_floor: ${expression(problem.primary_objective)} >= ${floor}\nBounds\n`);
    const model=highs.createModel({format:'lp',data:lp}),cuts=[],start=now();
    try {
        const count=model.getDimensions().numCols;
        const nativeIndex=new Map(Array.from({length:count},(_,i)=>[Number(model.getColName(i).slice(1)),i]));
        model.options.set({time_limit:Math.min(1,timeLimit)});
        model.changeColsCost({kind:'range',from:0,to:count-1},Array(count).fill(0));
        let previous=[];
        for(const [,terms,capacity] of problem.integer_groups){
            if((now()-start)/1000>=timeLimit)break;
            const entries=terms.map(([v,c])=>[nativeIndex.get(v),c]).sort((a,b)=>a[0]-b[0]);
            if(!entries.length || entries.some(([i])=>i==null))continue;
            const indices=entries.map(([i])=>i),coefficients=entries.map(([,c])=>c);
            const seed=terms.reduce((s,[v,c])=>s+c*incumbent.values[v],0);
            if(previous.length)model.changeColsCost({kind:'set',indices:previous},previous.map(()=>0));
            previous=indices;
            for(const sign of [1,-1]){
                // A feasible witness already reaches these bounds. Its zero use rules
                // out a positive minimum; use at capacity rules out a tighter maximum.
                // Neither probe can add a cut, so retain its full search time for useful LPs.
                if(sign===-1&&seed===0 || sign===1&&seed>=capacity)continue;
                const remaining=timeLimit-(now()-start)/1000;
                if(remaining<=0)break;
                // HiGHS accumulates run time on a persistent model. Each probe
                // gets a fresh clock while retaining the useful simplex basis.
                model.zeroAllClocks();
                model.options.set({time_limit:Math.min(1,remaining)});
                model.changeColsCost({kind:'set',indices},coefficients.map(c=>sign*c));
                model.run();
                if(model.getModelStatus()!==highs.constants.modelStatus.optimal)continue;
                const value=sign*model.getObjectiveValue(),epsilon=1e-5+Math.abs(value)*1e-7;
                const limit=sign===1?Math.max(0,Math.floor(value+epsilon)):Math.max(0,Math.ceil(value-epsilon));
                // Protect the known incumbent against numerical or interface errors.
                if(sign===1?(limit>=capacity||seed>limit+1e-6):(limit<=0||seed<limit-1e-6))continue;
                const lower=sign===-1;
                model.addRow(lower?limit:-Infinity,lower?Infinity:limit,{indices,values:coefficients});
                cuts.push({terms:terms.map(([v,c])=>[problem.variable_keys[v],c]),...(lower?{lower:limit}:{upper:limit})});
            }
        }
    } finally {model.dispose();}
    return cuts;
}
