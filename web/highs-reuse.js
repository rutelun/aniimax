// Keep a bounded native model per WASM runtime. Only the planner's small, explicit
// LP dialect is patched; unknown syntax always takes the ordinary native parser.
const runtimes = new WeakMap();
const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const range = new RegExp(`^(${number}) <= x(\\d+) <= (${number})$`);
const lower = new RegExp(`^x(\\d+) >= (${number})$`);
const rowPattern = new RegExp(`^\\s*[^:]+:\\s*(.*?)\\s*(<=|>=|=)\\s*(${number})\\s*$`);

export function parseLinearLp(lp, variables) {
    const match = lp.match(/^Maximize\n\s*obj:\s*([^\n]*)\nSubject To\n([\s\S]*?)\n?Bounds\n([\s\S]*?)(?:\nGeneral\n([\s\S]*?))?\nEnd\s*$/);
    if (!match || !Number.isInteger(variables) || variables < 1) return null;
    const terms = expression => {
        if (!expression.trim() || expression.trim() === '0') return [];
        const result = new Map();
        const pattern = /([+-]?)\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?\s+)?x(\d+)/g;
        let end = 0;
        for (const term of expression.matchAll(pattern)) {
            if (expression.slice(end, term.index).trim()) return null;
            const variable = Number(term[4]), value = (term[1] === '-' ? -1 : 1) * Number((term[2] || '1') + (term[3] || ''));
            if (variable >= variables || !Number.isFinite(value)) return null;
            result.set(variable, (result.get(variable) || 0) + value);
            end = term.index + term[0].length;
        }
        return expression.slice(end).trim() ? null : [...result];
    };
    const objective = terms(match[1]);
    if (!objective) return null;
    const costs = Array(variables).fill(0), bounds = Array.from({length:variables}, () => [0, Infinity]);
    objective.forEach(([i, c]) => costs[i] = c);
    const rows = [];
    for (const line of match[2].split('\n').filter(line => line.trim())) {
        const row = line.match(rowPattern);
        if (!row) return null;
        const coefficients = terms(row[1]), rhs = Number(row[3]);
        if (!coefficients || !Number.isFinite(rhs)) return null;
        rows.push({name:line.slice(0,line.indexOf(':')).trim(),key:row[1].trim().replace(/\s+/g,' '), coefficients,
            lo:row[2] === '<=' ? -Infinity : rhs, hi:row[2] === '>=' ? Infinity : rhs});
    }
    for (const raw of match[3].split('\n').filter(line => line.trim())) {
        const line = raw.trim(), boxed = line.match(range), unbounded = line.match(lower);
        const index = boxed ? Number(boxed[2]) : unbounded ? Number(unbounded[1]) : -1;
        if (index < 0 || index >= variables) return null;
        bounds[index] = boxed ? [Number(boxed[1]),Number(boxed[3])] : [Number(unbounded[2]),Infinity];
    }
    const integers = Array(variables).fill(0);
    for (const raw of (match[4] || '').split('\n').filter(line => line.trim())) {
        const integer = raw.trim().match(/^x(\d+)$/);
        if (!integer || Number(integer[1]) >= variables) return null;
        integers[Number(integer[1])] = 1;
    }
    const order = [...new Set([...lp.matchAll(/\bx(\d+)\b/g)].map(match=>Number(match[1])))];
    return {costs,bounds,integers,rows,order};
}

export function discardReusableModel(highs) {
    const state = runtimes.get(highs);
    if (state?.model) { state.model.dispose(); state.model = null; }
}

export const reuseStatistics = highs => ({...(runtimes.get(highs)?.stats || {})});

export function acquireModel(highs, problem, reuse = true) {
    let state = runtimes.get(highs);
    if (!state) { state = {stats:{created:0,reused:0,addedRows:0,removedRows:0}}; runtimes.set(highs,state); }
    let parsed;
    if (reuse) {
        parsed = state.lastLp === problem.lp ? state.lastParsed : parseLinearLp(problem.lp,problem.variables);
        state.lastLp = problem.lp; state.lastParsed = parsed;
    }
    const sameKeys = !problem.variable_keys && !state.keys || problem.variable_keys?.length === state.keys?.length
        && problem.variable_keys?.every((key,i) => key === state.keys[i]);
    // MIP branching is sensitive to the native reader's column order. Keep its cold
    // order when a new objective introduces columns in a different sequence.
    const integerOrderChanged = parsed?.integers.some(Boolean) && state.names
        && state.names.some((name,i)=>Number(name.slice(1)) !== parsed.order[i]);
    if (!reuse || !parsed || !state.model || !sameKeys || integerOrderChanged || state.parsed.costs.length !== problem.variables) {
        discardReusableModel(highs);
        const model = highs.createModel({format:'lp',data:problem.lp});
        state.stats.created++;
        const names = Array.from({length:model.getDimensions().numCols},(_,i) => model.getColName(i));
        const index = new Map(names.map((name,i) => [Number(name.slice(1)),i]));
        // Native LP readers may omit unused columns. Rebuild rather than guessing their order.
        let persistent = reuse && parsed && names.length === problem.variables
            && names.every(name => /^x\d+$/.test(name)) && index.size === problem.variables;
        if (persistent) {
            const byName = new Map(parsed.rows.map(row=>[row.name,row]));
            const rows = Array.from({length:model.getDimensions().numRows},(_,i)=>byName.get(model.getRowName(i)));
            persistent = rows.length === parsed.rows.length && byName.size === parsed.rows.length && rows.every(Boolean);
            if (persistent) Object.assign(state,{model,names,index,parsed:{...parsed,rows},keys:problem.variable_keys?.slice()});
        }
        return {model,names,persistent};
    }
    const {model,index} = state, old = state.parsed;
    try {
        const columns = {cost:[],bounds:[],integers:[]};
        for (let i=0;i<problem.variables;i++) {
            if (old.costs[i] !== parsed.costs[i]) columns.cost.push(i);
            if (old.bounds[i][0] !== parsed.bounds[i][0] || old.bounds[i][1] !== parsed.bounds[i][1]) columns.bounds.push(i);
            if (old.integers[i] !== parsed.integers[i]) columns.integers.push(i);
        }
        const update = (indices, method, arrays) => {
            if (!indices.length) return;
            indices.sort((a,b) => index.get(a)-index.get(b));
            model[method]({kind:'set',indices:indices.map(i=>index.get(i))},...arrays.map(values=>indices.map(values)));
        };
        update(columns.cost,'changeColsCost',[i=>parsed.costs[i]]);
        update(columns.bounds,'changeColsBounds',[i=>parsed.bounds[i][0],i=>parsed.bounds[i][1]]);
        update(columns.integers,'changeColsIntegrality',[i=>parsed.integers[i]]);
        // Match rows by their complete left-hand side, not c0/c1 names: adding a floor
        // can renumber every later constraint. Duplicate rows keep independent bounds.
        const groups = new Map();
        old.rows.forEach((row,i) => { if (!groups.has(row.key)) groups.set(row.key,[]); groups.get(row.key).push(i); });
        const matches = parsed.rows.map(row => groups.get(row.key)?.shift() ?? -1);
        const retained = new Set(matches.filter(i=>i>=0)), removed = old.rows.flatMap((_,i)=>retained.has(i)?[]:[i]);
        if (removed.length) model.deleteRows({kind:'set',indices:removed});
        const nativeRows = [], positions = new Map();
        old.rows.forEach((row,i) => { if (retained.has(i)) { positions.set(i,nativeRows.length); nativeRows.push(row); } });
        const changed = [], additions = [];
        parsed.rows.forEach((row,i) => {
            const before = matches[i];
            if (before < 0) { additions.push(row); return; }
            const native = positions.get(before);
            if (old.rows[before].lo !== row.lo || old.rows[before].hi !== row.hi) changed.push([native,row]);
            nativeRows[native] = row;
        });
        changed.sort((a,b)=>a[0]-b[0]);
        if (changed.length) model.changeRowsBounds({kind:'set',indices:changed.map(([i])=>i)},changed.map(([,r])=>r.lo),changed.map(([,r])=>r.hi));
        if (additions.length) {
            const starts = [0], indices = [], values = [];
            for (const row of additions) {
                for (const [variable,value] of row.coefficients) { indices.push(index.get(variable)); values.push(value); }
                starts.push(indices.length);
            }
            model.addRows({lower:additions.map(r=>r.lo),upper:additions.map(r=>r.hi),
                matrix:{format:'csr',numRows:additions.length,numCols:problem.variables,starts,indices,values}});
            nativeRows.push(...additions);
        }
        state.parsed = {...parsed,rows:nativeRows};
        state.stats.reused++; state.stats.addedRows+=additions.length; state.stats.removedRows+=removed.length;
        return {model,names:state.names,persistent:true};
    } catch (error) {
        discardReusableModel(highs);
        throw error;
    }
}
