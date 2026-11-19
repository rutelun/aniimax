const query = new URL(import.meta.url).search;
const {parseLinearLp} = await import('./highs-reuse.js'+query);
const {requiredRecipeSites} = await import('./priority-ceilings.js'+query);

const expression = terms => [...terms].map(([v,c]) => `${c<0?'-':'+'} ${Math.abs(c)} ${v}`).join(' ');

// The dispatch equations fix each worker's share of a recipe's batches.
// For a row a*r[i] + b*sum(other rates) = 0, the share is -b/(a-b).
// An unrecognized equation leaves its variants free in the relaxation.
function dispatchShares(parsed,recipes,original,mapped) {
    const groups = new Map(recipes.filter(g=>!g.whole).map(g=>[g.rate,g]));
    const shares = new Map();
    for (const {lo,hi,coefficients} of parsed.rows) {
        if (lo!==0 || hi!==0 || !coefficients.length) continue;
        const column = mapped.get(coefficients[0][0]);
        if (!groups.has(column) || !coefficients.every(([v])=>mapped.get(v)===column)) continue;
        const values = new Map(coefficients), variants = original.get(column);
        if (variants.length<2) continue;
        for (const v of variants) {
            const a = values.get(v) || 0, b = values.get(variants[0]===v?variants[1]:variants[0]) || 0;
            if (a===b || !variants.every(u=>u===v || (values.get(u)||0)===b)) continue;
            const share = -b/(a-b);
            if (share>=0 && share<=1) shares.set(v,share);
        }
    }
    return shares;
}

// The best LP value for each proposed worker pool is an upper bound on its
// use even when routes, measured dispatch or crop jobs change. Reuse one
// simplex basis while pricing all pools. A timeout simply drops that row.
function workerPoolBounds(highs, problem, pools) {
    if (!pools.length) return;
    const lp = problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd');
    const model = highs.createModel({format:'lp',data:lp});
    try {
        const count = model.getDimensions().numCols;
        const native = new Map(Array.from({length:count},(_,i)=>[Number(model.getColName(i).slice(1)),i]));
        model.changeColsCost({kind:'range',from:0,to:count-1},Array(count).fill(0));
        let previous = [];
        for (const pool of pools) {
            const terms = pool.terms.map(([v,c])=>[native.get(v),c]).sort(([a],[b])=>a-b);
            if (terms.some(([v])=>v==null)) continue;
            if (previous.length) model.changeColsCost({kind:'set',indices:previous},previous.map(()=>0));
            previous = terms.map(([v])=>v);
            model.changeColsCost({kind:'set',indices:previous},terms.map(([,c])=>c));
            model.zeroAllClocks();
            model.options.set({time_limit:.4});
            model.run();
            if (model.getModelStatus()===highs.constants.modelStatus.optimal) {
                pool.upper = model.getObjectiveValue()+1e-9;
            }
        }
    } finally {
        model.dispose();
    }
}

// Solve the smaller material-balance and physical-capacity problem before
// choosing the individual workers. A pattern is only a proposal for the full
// planner, which still chooses staffing, routes and ingredient availability.
export function economicRecipeCounts(highs, problem, {input,timeLimit=1.5}={}) {
    if (!(timeLimit>0) || !problem.production_only || !problem.recipe_options?.length ||
        !Array.isArray(problem.integer_groups) || problem.variables!==problem.variable_keys?.length) return null;
    const parsed = parseLinearLp(problem.lp,problem.variables);
    if (!parsed || parsed.bounds.some(([lo])=>lo<0)) return null;
    const mapped = new Map(), original = new Map(), bounds = new Map();
    const groups = new Map(), index = new Map(problem.variable_keys.map((key,i)=>[key,i]));
    const capacities = new Map(problem.integer_groups.map(([name,,capacity])=>[name,capacity]));
    const pooledSites = new Map((problem.recipe_variables || []).filter(([v])=>
        parsed.integers[v] && problem.variable_keys[v].startsWith('continuous_site:')));
    for (const [v,name] of pooledSites) {
        if (!capacities.has(name)) capacities.set(name,parsed.bounds[v][1]);
    }
    const pooledRecipes = new Set(pooledSites.values());
    const cycles = new Map();
    for (const {hi,coefficients} of parsed.rows) {
        if (hi>0 || coefficients.length!==2) continue;
        const rate = coefficients.find(([v,c])=>c>0 && problem.variable_keys[v].startsWith('rate:'));
        const site = coefficients.find(([v,c])=>c<0 && problem.variable_keys[v].startsWith('units:'));
        if (rate && site) cycles.set(rate[0],[site[0],rate[1]/-site[1]]);
    }
    const members = input?.roster?.members;
    function assign(v,column,limits) {
        mapped.set(v,column);
        if (!original.has(column)) original.set(column,[]);
        original.get(column).push(v);
        bounds.set(column,limits);
    }
    for (const [rate,name,facility,source,electric,seconds] of problem.recipe_options) {
        const variant = problem.variable_keys[rate].slice(5);
        const site = index.get('units:'+variant);
        const capacity = cycles.get(rate);
        const whole = !!parsed.integers[site];
        if (site==null || (!whole && !pooledRecipes.has(name)) || !capacities.has(name) || !(seconds>0)
            || !capacity || capacity[0]!==site || capacity[1]<seconds) return null;
        // Harvest workers with different speeds must share the available roster.
        // The grouped processor can choose its fastest worker in this search.
        const crew = source && members ? variant.match(/__byowned:(\d+)#/) : null;
        const key = JSON.stringify([name,facility,electric,variant.includes('__uncovered'),source&&members?seconds:0,whole]);
        let group = groups.get(key);
        if (!group) {
            const id = groups.size;
            group = {name,facility,seconds,source,whole,workers:new Set(),limited:true,rate:'r'+id,site:'n'+id};
            groups.set(key,group);
        }
        group.seconds = Math.min(seconds,group.seconds);
        if (crew && members[Number(crew[1])]) group.workers.add(Number(crew[1]));
        else group.limited = false;
        assign(rate,group.rate,[0,Infinity]);
        assign(site,group.site,[0,Infinity]);
    }
    for (const [v,key] of problem.variable_keys.entries()) {
        if (pooledSites.has(v)||/^(sold:|pace#|generators#|crop_variety#)/.test(key)) assign(v,'s'+v,parsed.bounds[v]);
    }
    const rows = new Set(), objective = new Map();
    function addRow(terms,sense,rhs) {
        if (terms.length) rows.add(expression(terms)+' '+sense+' '+rhs);
    }
    // Removing a negative cost on a nonnegative variable only increases an
    // upper bound. Native tie-break cancellation sometimes leaves such dust.
    if (parsed.costs.some((c,v)=>c>0 && !mapped.has(v))) return null;
    for (const [column,variables] of original) {
        const cost = Math.max(...variables.map(v=>parsed.costs[v]));
        if (cost) objective.set(column,cost);
    }
    const siteLimits = new Map([...groups.values()].map(g=>[g.site,
        original.get(g.site).reduce((sum,v)=>sum+parsed.bounds[v][1],0)]));
    // Keep rows that use only mapped variables. The most favorable coefficient
    // accommodates all distributions of the merged rate among its variants.
    for (const {coefficients,lo,hi} of parsed.rows) {
        if (!coefficients.every(([v])=>mapped.has(v))) continue;
        const values = new Map();
        for (const [v,c] of coefficients) {
            const column = mapped.get(v);
            if (!values.has(column)) values.set(column,[]);
            values.get(column).push(c);
        }
        for (const [column,coeffs] of values) if (coeffs.length<original.get(column).length) coeffs.push(0);
        if (Number.isFinite(hi) && coefficients.every(([,c])=>c>=0)) {
            // A nonnegative capacity row bounds each complete group of sites.
            for (const [column,coeffs] of values) {
                const factor = Math.min(...coeffs);
                if (factor>0 && siteLimits.has(column))
                    siteLimits.set(column,Math.min(siteLimits.get(column),hi/factor));
            }
        }
        for (const [sense,rhs] of [['>=',lo],['<=',hi]]) {
            if (!Number.isFinite(rhs)) continue;
            const terms = [];
            for (const [column,coeffs] of values) {
                const c = sense==='>=' ? Math.max(...coeffs) : Math.min(...coeffs);
                if (c) terms.push([column,c]);
            }
            addRow(terms,sense,rhs);
        }
    }
    for (const g of groups.values()) bounds.set(g.site,[0,Math.max(capacities.get(g.name),siteLimits.get(g.site))]);
    for (const sites of requiredRecipeSites(problem,parsed)) {
        if (sites.every(v=>mapped.has(v))) addRow([...new Set(sites.map(v=>mapped.get(v)))].map(id=>[id,1]),'>=',1);
    }
    const recipes = [...groups.values()];
    const shares = dispatchShares(parsed,recipes,original,mapped);
    for (const g of recipes.filter(g=>!g.whole)) {
        const fastest = g.seconds;
        for (const rate of original.get(g.rate)) g.seconds += (shares.get(rate)||0)*(cycles.get(rate)[1]-fastest);
    }
    const pools = [];
    const workerSets = new Set(recipes.filter(g=>g.limited).map(g=>[...g.workers].sort((a,b)=>a-b).join(',')));
    for (const pool of workerSets) {
        const workers = new Set(pool.split(',').map(Number));
        const eligible = recipes.filter(g=>g.limited && [...g.workers].every(id=>workers.has(id)));
        const columns = eligible.map(g=>input.roster.residents?.includes(g.facility) ? [g.site,1] : [g.rate,g.seconds]);
        pools.push({columns,terms:columns.flatMap(([column,c])=>original.get(column).map(v=>[v,c]))});
    }
    for (const g of recipes.filter(g=>g.source && !g.whole)) {
        // A dispatch rule can assign the fast harvest to just one of several
        // otherwise interchangeable workers. Price that recipe's actual
        // worker-days on its own as well as the shared capacity of its pool.
        pools.push({columns:[[g.rate,g.seconds]],terms:original.get(g.rate).map(v=>[v,g.seconds])});
    }
    workerPoolBounds(highs,problem,pools);
    for (const pool of pools) if (Number.isFinite(pool.upper)) addRow(pool.columns,'<=',pool.upper);
    for (const g of recipes) addRow([[g.rate,g.seconds],[g.site,-1]],'<=',0);
    // Dispatched worker shares are fractional. The separate native reservation
    // is integral and counts once across every participating worker.
    const sites = new Map(recipes.filter(g=>g.whole).map(g=>[g.site,g.name]));
    for (const [v,name] of pooledSites) sites.set('s'+v,name);
    const lp = ['Maximize',' obj: '+expression(objective),'Subject To',
        ...[...rows].map((s,i)=>` c${i}: ${s}`),'Bounds',
        ...[...bounds].map(([v,[lo,hi]])=>Number.isFinite(hi) ? ` ${lo} <= ${v} <= ${hi}` : ` ${v} >= ${lo}`),
        'General',...[...sites.keys()].map(v=>' '+v),'End'].join('\n');
    const model = highs.createModel({format:'lp',data:lp});
    try {
        model.options.set({time_limit:timeLimit,mip_rel_gap:.0001});
        model.run();
        if (model.info.get('primal_solution_status')!==highs.constants.solutionStatus.feasible) return null;
        const values = model.getSolution().colValue;
        const selected = new Map();
        for (let i=0;i<values.length;i++) {
            const name = sites.get(model.getColName(i));
            if (!name || values[i]<0.5) continue;
            selected.set(name,(selected.get(name) || 0)+Math.round(values[i]));
        }
        // The integer sums, natural capacity limits and cycle times are the
        // planner's recipe metadata. Merging columns relaxes every retained
        // row and every missing row is dropped. Only the resulting dual bound
        // can certify income. Its primal solution supplies site hints.
        const dual = model.info.get('mip_dual_bound');
        if (Number.isFinite(dual) && dual<1e25) selected.upper = Math.max(dual,model.getObjectiveValue())+1e-7;
        return selected.size ? selected : null;
    } finally {
        model.dispose();
    }
}

// Condition the executable model on the proposed site counts, then select
// worker alternatives using its continuous relaxation. These additional rows
// make a local search. They supply no global income bound.
export function economicCountNeighborhood(highs,problem,counts,minimumIncome) {
    if (!counts?.size || !(minimumIncome>0) || !problem.production_only ||
        !Array.isArray(problem.integer_groups) || !problem.recipe_options?.length) return null;
    const sites = new Map(problem.integer_groups.map(([name,terms])=>[name,terms.map(([v])=>v)]));
    for (const [v,name] of problem.recipe_variables) {
        if (!problem.variable_keys[v].startsWith('continuous_site:')) continue;
        if (!sites.has(name)) sites.set(name,[]);
        sites.get(name).push(v);
    }
    if ([...counts].some(([name,n])=>!sites.has(name)||!Number.isSafeInteger(n)||n<0)) return null;
    const rows = [...sites].map(([name,columns],i)=>
        ` local_sites_${i}: ${columns.map(v=>'x'+v).join(' + ')} = ${counts.get(name) || 0}`);
    const earnings = expression(problem.primary_objective.map(([v,c])=>['x'+v,c]));
    rows.push(` local_income: ${earnings} >= ${minimumIncome}`);
    const restrict = () => problem.lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n');
    const relaxation = highs.solve(restrict().replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd'),{time_limit:.6});
    if (relaxation.Status!=='Optimal' || !relaxation.Columns) return null;
    const index = new Map(problem.variable_keys.map((k,i)=>[k,i]));
    for (const [rate,,,source,electric] of problem.recipe_options) {
        const key = problem.variable_keys[rate];
        if (source || electric || !key.includes('__byowned:') || relaxation.Columns['x'+rate]?.Primal>1e-10) continue;
        const site = index.get('units:'+key.slice(5));
        if (site!=null) rows.push(` local_worker_${site}: x${site} = 0`);
    }
    return {...problem,lp:restrict(),continuousRestricted:true};
}
