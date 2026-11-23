import {parseLinearLp} from './highs-reuse.js';

// Optimization-based bound tightening (OBBT). One reusable LP basis bounds whole
// recipe/building counts. Rounded bounds are valid integer cuts, never guesses
// based on what happened to be idle in a previous solution.
export function tightenIntegerBounds(highs,problem,incumbent,{maxProbes=32}={}) {
    if(!problem.integer_groups?.length || !problem.production_only || !problem.primary_objective?.length
        || problem.variable_keys?.length!==problem.variables || !incumbent?.values
        || incumbent.values.length!==problem.variables || !Number.isFinite(incumbent.objective) || !(incumbent.objective>1e-9))return [];
    const expression=terms=>terms.map(([v,c])=>`${c<0?'-':'+'} ${Math.abs(c)} x${v}`).join(' ');
    // Later priorities retain this currency with the native 0.01% floor slack.
    // Probe at that weaker floor so the cuts remain valid for those later models.
    const floor=incumbent.objective*(1-1e-4);
    const lp=problem.lp.replace(/\nGeneral\n[\s\S]*\nEnd/,'\nEnd')
        .replace('\nBounds\n',`\n obbt_floor: ${expression(problem.primary_objective)} >= ${floor}\nBounds\n`);
    const model=highs.createModel({format:'lp',data:lp}),cuts=[];
    let probes=0;
    try {
        const count=model.getDimensions().numCols;
        const nativeIndex=new Map(Array.from({length:count},(_,i)=>[Number(model.getColName(i).slice(1)),i]));
        model.changeColsCost({kind:'range',from:0,to:count-1},Array(count).fill(0));
        let previous=[];
        for(const [,terms,capacity] of problem.integer_groups){
            if(probes>=maxProbes)break;
            const entries=terms.map(([v,c])=>[nativeIndex.get(v),c]).sort((a,b)=>a[0]-b[0]);
            if(!entries.length || entries.some(([i])=>i==null))continue;
            const indices=entries.map(([i])=>i),coefficients=entries.map(([,c])=>c);
            const seed=terms.reduce((s,[v,c])=>s+c*incumbent.values[v],0);
            if(previous.length)model.changeColsCost({kind:'set',indices:previous},previous.map(()=>0));
            previous=indices;
            for(const sign of [1,-1]){
                // A feasible witness already reaches these bounds. Its zero use rules
                // out a positive minimum; use at capacity rules out a tighter maximum.
                if(sign===-1&&seed===0 || sign===1&&seed>=capacity)continue;
                if(probes>=maxProbes)break;
                probes++;
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

// A recipe count is encoded as a sum of binary columns with positive integer
// weights. Several recipes can draw their sites from the same physical pool.
export function withWorkshopCapacityCuts(problem) {
    if (problem.variable_keys?.length !== problem.variables) return problem;
    const model = parseLinearLp(problem.lp, problem.variables);
    if (!model) return problem;
    const keys = problem.variable_keys, bitsByUnit = new Map(), pools = [];
    for (const {lo, hi, coefficients} of model.rows) {
        if (lo === 0 && hi === 0) {
            const unit = coefficients.find(([v,c]) => c === -1 && keys[v].startsWith('units:'));
            if (!unit) continue;
            const bits = coefficients.filter(([v,c]) => Number.isSafeInteger(c) && c > 0 && model.integers[v]
                && model.bounds[v][0] === 0 && model.bounds[v][1] === 1 && keys[v].startsWith('extra#'));
            if (bits.length && bits.length + 1 === coefficients.length) bitsByUnit.set(unit[0], bits);
        } else if (Number.isSafeInteger(hi) && hi > 1 && coefficients.length > 1
            && coefficients.every(([v,c]) => c === 1 && keys[v].startsWith('units:') && model.bounds[v][0] >= 0)) {
            pools.push({capacity:hi, units:new Set(coefficients.map(([v]) => v))});
        }
    }
    const cuts = new Set(), accepted = [];
    pools.sort((a,b) => b.units.size - a.units.size);
    for (const pool of pools) {
        const {capacity, units} = pool;
        if (accepted.some(other => other.capacity <= capacity && [...units].every(v => other.units.has(v)))) continue;
        accepted.push(pool);
        const bits = [...bitsByUnit].filter(([v]) => units.has(v)).flatMap(([,terms]) => terms);
        for (const size of new Set(bits.map(([,weight]) => weight).filter(weight => weight > 1))) {
            // Count whole groups of this size, rounding each contribution down.
            // An active smaller bit that exceeds the leftover sites consumes at
            // least one of those groups too. Include only one such bit per cut.
            const groups = bits.filter(([,w]) => w >= size).map(([v,w]) => Math.floor(w/size)+' x'+v);
            const limit = Math.floor(capacity/size);
            cuts.add(groups.join(' + ')+' <= '+limit);
            for (const [v,weight] of bits) {
                if (weight < size && weight > capacity % size) cuts.add([...groups,'x'+v].join(' + ')+' <= '+limit);
            }
        }
    }
    if (!cuts.size) return problem;
    const rows = [...cuts].map((cut,i) => ' machine_'+i+': '+cut).join('\n');
    return {...problem, lp:problem.lp.replace('\nBounds\n','\n'+rows+'\nBounds\n')};
}
