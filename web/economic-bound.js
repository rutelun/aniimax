import {planSearchOptions,runPlanModel,searchStopped} from './highs-solve.js';

// An unrestricted recipe-scope model retains every recipe, dispatch policy,
// physical building and balance. Omitting a recipe's work-conservation rules
// enlarges its feasible set, so its MIP dual bound also bounds the full model.
// A primal from this relaxation still needs the caller's full production audit.
export function solveEconomicBound(highs, problem, {seed, scope = [], timeLimit = 2, discovery = false, exact = false, relativeGap = 0, exactGap = false, deferExactGap = false, incomeTarget, onRecipes, floorCertify = false, maxNodes} = {}) {
    const keys = problem.variable_keys;
    if (!problem.production_only || problem.continuousRestricted || !problem.primary_objective?.length
        || keys?.length !== problem.variables || !problem.recipe_options || !(timeLimit > 0)) return null;
    const certifyIncome = !discovery && relativeGap > 0 && Number.isFinite(incomeTarget) && incomeTarget > 0;
    const useFloor = Boolean(floorCertify && exact && certifyIncome && problem.lp?.includes('\nBounds\n'));
    const lpData = useFloor
        ? problem.lp.replace('\nBounds\n',
            `\n certify_floor: ${problem.primary_objective.map(([v, c]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} x${v}`).join(' ')} >= ${incomeTarget - 1e-7}\nBounds\n`)
        : problem.lp;
    const model = highs.createModel({format:'lp', data:lpData});
    try {
        const {numCols} = model.getDimensions();
        const indices = Array.from({length:numCols}, (_, i) => Number(model.getColName(i).slice(1)));
        if (indices.some(v => !Number.isInteger(v) || v < 0 || v >= keys.length)) return null;
        const precision = {mip_abs_gap:0, mip_rel_gap:exactGap || (certifyIncome && !exact) ? 0 : relativeGap,
            primal_feasibility_tolerance:useFloor||discovery?1e-7:1e-9, mip_feasibility_tolerance:useFloor?1e-7:discovery?1e-8:1e-9,
            ...(useFloor ? {presolve:'off'} : {})};
        const {incumbentIterations,...nativeOptions} = exact ? precision : planSearchOptions({time_limit:timeLimit,...precision});
        if (discovery) nativeOptions.mip_max_nodes = Math.ceil(128*timeLimit);
        else if (maxNodes != null) nativeOptions.mip_max_nodes = maxNodes;
        model.options.set(nativeOptions);
        // A partial integer start can make HiGHS 1.15.1 report its repaired
        // incumbent as Optimal. Use it only for discovery, which supplies no bound.
        if (discovery && seed?.keys?.length === seed?.values?.length && seed?.keys) {
            const previous = new Map(seed.keys.map((key, v) => [key, seed.values[v]]));
            // Let HiGHS refit rates and complete the scope-local availability
            // binaries. Assigning zero to missing binaries can invalidate a
            // feasible physical plan before the search even starts.
            const section = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
            const integers = new Set(Array.from((section?.[1] ?? '').matchAll(/\bx(\d+)\b/g), m => Number(m[1])));
            const warm = {indices:[], values:[]};
            indices.forEach((v, i) => {
                const value = previous.get(keys[v]);
                if (integers.has(v) && !keys[v].startsWith('extra#') && Number.isFinite(value)
                    && Math.abs(value - Math.round(value)) < 1e-6) {
                    warm.indices.push(i);
                    warm.values.push(Math.round(value));
                }
            });
            if (warm.indices.length) model.setSolution(warm);
        }
        const run = () => {
            const maxIter = !exact && (seed || discovery) ? Math.ceil(timeLimit * 4000) : undefined;
            if (!certifyIncome) return runPlanModel(model,highs,maxIter,undefined,incumbentIterations);
            // A relaxed shift may earn more than the already verified physical
            // shift. Its relative gap alone cannot certify that physical income.
            const callbacks={};
            if(onRecipes){
                const nativeIndex=new Map(indices.map((v,i)=>[v,i]));
                const rates=problem.recipe_options.map(([v,name])=>[nativeIndex.get(v),name]);
                callbacks[highs.constants.callbackType.mipImprovingSolution]=({data})=>{
                    if(data.mip_primal_bound<incomeTarget)return;
                    const used=new Set();
                    const values=data.mip_solution;
                    for(const [i,name] of rates)if(values[i]>1e-10)used.add(name);
                    onRecipes([...used]);
                };
            }
            return model.run({...callbacks,[highs.constants.callbackType.mipInterrupt]:event=>{
                const {mip_primal_bound:lower,mip_dual_bound:upper,mip_total_lp_iterations:iters} = event.data;
                if ((maxIter && iters >= maxIter)
                    || (incumbentIterations && iters >= incumbentIterations && Number.isFinite(lower))) {
                    event.interrupt();
                    return;
                }
                if (!Number.isFinite(upper)) return;
                if (Number.isFinite(lower) && lower > upper) return;
                if (upper <= incomeTarget || (Number.isFinite(lower) && lower >= incomeTarget && upper-lower <= relativeGap*Math.abs(lower))) {
                    event.interrupt();
                }
            }});
        };
        run();
        const statuses = highs.constants.modelStatus;
        if (useFloor && model.getModelStatus() === statuses.infeasible) {
            return {upper:incomeTarget, proven:true, scope:[...scope]};
        }
        // Tight priority floors and measured worker shares can make presolve
        // declare a feasible model infeasible at 1e-9. First retry at 1e-7
        // (still a valid upper-bound relaxation) with presolve enabled before
        // falling back to presolve:'off'.
        if(!useFloor && model.getModelStatus()===statuses.infeasible){
            if(!discovery){
                model.clearSolver();
                model.options.set({primal_feasibility_tolerance:1e-7, mip_feasibility_tolerance:1e-7});
                run();
            }
            if(model.getModelStatus()===statuses.infeasible){
                model.clearSolver();
                model.options.set({presolve:'off'});
                run();
            }
        }
        // A native gap stop can leave the physical target between the
        // incumbent and its upper bound. When the relaxed incumbent already
        // beats the prior verified income (incomeTarget / (1 + relativeGap)),
        // let the caller try restoring it first before paying for a full restart.
        let needsExactGap = false;
        const prevEarned = incomeTarget / (1 + relativeGap);
        if (certifyIncome && model.getModelStatus() === statuses.optimal && model.info.get('mip_gap') > 0
            && model.getObjectiveValue() < incomeTarget && model.info.get('mip_dual_bound') > incomeTarget) {
            if (deferExactGap && model.getObjectiveValue() > prevEarned + 1e-7) {
                needsExactGap = true;
            } else {
                model.options.set({mip_rel_gap:0});
                run();
            }
        }
        const status = model.getModelStatus();
        if (status !== statuses.optimal && !searchStopped(status,statuses)) return null;
        const optimal = status === statuses.optimal;
        const upper = optimal && !relativeGap ? model.getObjectiveValue() : model.info.get('mip_dual_bound');
        // HiGHS also reports Optimal when it reaches a requested MIP gap.
        // The dual bound, rather than that status, distinguishes exact income.
        const exactObjective = optimal && (!relativeGap || model.info.get('mip_gap') === 0);
        const result = {upper:!discovery && Number.isFinite(upper) ? upper : null,
            proven:exactObjective && !discovery, needsExactGap, scope:[...scope]};
        if (model.info.get('primal_solution_status') !== highs.constants.solutionStatus.feasible) return result;
        const values = Array(keys.length).fill(0), native = model.getSolution().colValue;
        indices.forEach((v, i) => { values[v] = native[i]; });
        const objective = problem.primary_objective.reduce((sum, [v,c]) => sum + c * values[v], 0);
        return {...result, keys, values, objective, ...economicRecipeUse(problem, values)};
    } finally {
        model.dispose();
    }
}

// Exact LP-based OBBT on recipe site totals for a given proof scope at a
// verified income floor. Every integer shift earning >= floor must satisfy
// these upper bounds, so passing them as recipe_site_limits tightens
// always_running binary expansions and big-M envelopes without pruning any
// optimal shift.
const obbtLpCache = new WeakMap();

export function obbtSiteLimits(highs, rawProblem, recipes, floor, baseLimits = {}) {
    if (!(floor > 0) || !Number.isFinite(floor) || !highs?.createModel
        || !rawProblem?.primary_objective?.length || !rawProblem?.lp) return null;
    const targets = new Set(recipes);
    if (!targets.size) return null;
    const groups = new Map();
    for (const [name, terms, cap] of rawProblem.integer_groups ?? []) {
        if (!targets.has(name)) continue;
        const entry = groups.get(name) ?? {cols:new Set(), cap};
        for (const [v] of terms) entry.cols.add(v);
        entry.cap = Math.max(entry.cap, cap);
        groups.set(name, entry);
    }
    for (const [v, name] of rawProblem.recipe_variables ?? []) {
        if (!targets.has(name)) continue;
        const key = rawProblem.variable_keys[v];
        if (!key.startsWith('continuous_site:')) continue;
        const entry = groups.get(name) ?? {cols:new Set(), cap:Infinity};
        entry.cols.add(v);
        groups.set(name, entry);
    }
    const candidates = [...groups.entries()].filter(([name, g]) => {
        const current = baseLimits[name] ?? g.cap;
        return g.cols.size > 0 && current >= 1;
    });
    if (!candidates.length) return null;
    let cached = obbtLpCache.get(rawProblem);
    if (cached && cached.lp !== rawProblem.lp) cached = null;
    const model = cached
        ? highs.createModel(cached.lpData)
        : highs.createModel({format:'lp', data:rawProblem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/, '\nEnd')});
    const statuses = highs.constants.modelStatus;
    try {
        let nativeIndex, numCols;
        if (cached) {
            nativeIndex = cached.nativeIndex;
            numCols = cached.lpData.numCols;
        } else {
            const lpData = model.getLp();
            lpData.integrality.fill(0);
            numCols = lpData.numCols;
            nativeIndex = new Map(Array.from({length:numCols}, (_, i) => [Number(model.getColName(i).slice(1)), i]));
            obbtLpCache.set(rawProblem, {lp:rawProblem.lp, lpData, nativeIndex});
        }
        const floorPairs = rawProblem.primary_objective
            .map(([v, c]) => [nativeIndex.get(v), c])
            .filter(([i]) => i != null)
            .sort((a, b) => a[0] - b[0]);
        model.addRow(floor - 1e-7 * Math.max(1, Math.abs(floor)), Infinity, {
            indices: floorPairs.map(([i]) => i),
            values: floorPairs.map(([, c]) => c),
        });
        model.options.set({primal_feasibility_tolerance:1e-9, dual_feasibility_tolerance:1e-9});
        model.changeColsCost({kind:'range', from:0, to:numCols - 1}, Array(numCols).fill(0));
        model.run();
        if (model.getModelStatus() === statuses.infeasible) return {infeasible:true};
        if (model.getModelStatus() !== statuses.optimal) return null;
        const limits = {...baseLimits};
        const colLists = candidates.map(([, g]) => {
            const cols = [...g.cols].map(v => nativeIndex.get(v)).filter(i => i != null).sort((a, b) => a - b);
            return cols.length && cols.length === g.cols.size ? cols : null;
        });
        const seenMax = new Float64Array(candidates.length).fill(-Infinity);
        const observe = start => {
            const sol = model.getSolution()?.colValue;
            if (!sol) return;
            for (let j = start; j < candidates.length; j++) {
                const cols = colLists[j];
                if (!cols) continue;
                let total = 0;
                for (let t = 0; t < cols.length; t++) total += sol[cols[t]];
                if (total > seenMax[j]) seenMax[j] = total;
            }
        };
        observe(0);
        let prev = [], tightened = 0;
        for (let k = 0; k < candidates.length; k++) {
            const [name, g] = candidates[k];
            const cols = colLists[k];
            if (!cols) continue;
            const current = limits[name] ?? g.cap;
            if (seenMax[k] >= current - 1e-5) continue;
            if (prev.length) model.changeColsCost({kind:'set', indices:prev}, prev.map(() => 0));
            prev = cols;
            model.changeColsCost({kind:'set', indices:cols}, cols.map(() => 1));
            model.run();
            const st = model.getModelStatus();
            if (st === statuses.infeasible) return {infeasible:true};
            if (st !== statuses.optimal) continue;
            const ub = Math.max(0, Math.floor(model.getObjectiveValue() + 1e-5));
            if (ub < current) {
                limits[name] = ub;
                tightened++;
                model.addRow(-Infinity, ub, {indices:cols, values:cols.map(() => 1)});
                for (let j = k + 1; j < candidates.length; j++) seenMax[j] = -Infinity;
            } else {
                observe(k + 1);
            }
        }
        return tightened ? {infeasible:false, limits} : null;
    } finally {
        model.dispose();
    }
}

// Group manual dispatch variants at their shared whole site. Electric
// variants retain separate reservations. These diagnostics select candidate
// constraints for later solves. They do not restrict recipes or certify rates.
export function economicRecipeUse(problem, values) {
    const active = new Set(), occupied = new Set(), throttled = new Set();
    const {loads} = recipeLoads(problem, values);
    for (const {name,work,sites} of loads.values()) {
        occupied.add(name);
        if (work < sites - 1e-7) throttled.add(name);
    }
    for (const [rate,name] of problem.recipe_options) {
        if (values[rate] > 1e-10) active.add(name);
    }
    return {activeRecipes:[...active], occupiedRecipes:[...occupied], throttledRecipes:[...throttled]};
}

function recipeLoads(problem, values) {
    const keys = problem.variable_keys, byKey = new Map(keys.map((key, v) => [key, v]));
    const loads = new Map(), rateLoads = new Map();
    for (const [rate, name, facility, staffedSource, electric, seconds] of problem.recipe_options) {
        const key = keys[rate];
        const shared = electric ? undefined : byKey.get(`continuous_site:${facility}|${name}#0`);
        const site = shared ?? byKey.get(key.replace(/^rate:/, 'units:'));
        if (site === undefined || values[site] <= 1e-8) continue;
        const crop = facility==='Farmland'||facility==='Woodland';
        const load = loads.get(site) ?? {name, facility, crop, source:staffedSource||crop, sites:values[site], work:0};
        load.work += seconds * values[rate];
        loads.set(site, load);
        rateLoads.set(rate, load);
    }
    return {loads,rateLoads};
}

// A shared depleted ingredient needs an availability at least as high as
// every consumer's utilization. If that cannot explain a slower consumer,
// check the competing consumers together. Worker shortages can also explain
// the slow rate, so this only selects work-conservation constraints to add.
// The upper bound itself always comes from solving the unrestricted master.
export function suggestEconomicScope(problem, values, required = [], {nearFloorOnly=false} = {}) {
    if (values?.length !== problem.variables || !problem.recipe_options) return [...required];
    const {loads,rateLoads} = recipeLoads(problem, values);
    const scope = new Set(required), inputs = new Map();
    const sharedPlots = new Set([...loads.values()].filter(load=>load.crop&&scope.has(load.name)).map(load=>load.facility));
    const rowSection = problem.lp.split('\nSubject To\n')[1]?.split('\nBounds\n')[0] ?? '';
    for (const line of rowSection.split('\n')) {
        const relation=/ (>=|<=|=) (\S+)\s*$/.exec(line);
        if (!relation) continue;
        const split=relation.index,lower=Number(relation[2]);
        if (!Number.isFinite(lower) || lower > 1e-10) continue;
        const consumers = new Set(), producers = new Set();
        let surplus = -lower, material = true, salable=false;
        const expr = line.slice(line.indexOf(':') + 1, split);
        for (const term of expr.matchAll(/([+-]?)\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s+)?x(\d+)/g)) {
            const v = Number(term[3]), key = problem.variable_keys[v];
            if (key?.startsWith('pace#')) continue;
            if (key?.startsWith('sold:')) {
                // Positive sale terms occur in currency/pace floors. Material
                // balances consume sales and cannot produce them.
                if(term[1]!=='-'){material=false;break;}
                salable=true;
                continue;
            }
            if (!key?.startsWith('rate:')) { material = false; break; }
            const coefficient = (term[1] === '-' ? -1 : 1) * Number(term[2] ?? 1);
            surplus += coefficient * values[v];
            const load = rateLoads.get(v);
            if (load && values[v] > 1e-10) (coefficient < 0 ? consumers : producers).add(load);
        }
        // The native sell-all model uses equality on salable balances, and
        // a second upper row when positive old stock can cover upgrade costs.
        if (!material || !consumers.size || relation[1]!=='>='&&!salable) continue;
        const minimum = Math.max(...Array.from(consumers, load => load.work / load.sites));
        const resource = {consumers, producers, minimum, surplus};
        for (const load of consumers) {
            if (!inputs.has(load)) inputs.set(load, []);
            inputs.get(load).push(resource);
        }
    }
    for (const load of loads.values()) {
        if (!nearFloorOnly && (load.source||!inputs.has(load)) && load.work > 1e-9 && load.work < load.sites - 1e-7) scope.add(load.name);
        // Growing at a reserved seasonal plot and a regular plot shares
        // facility capacity, even when only the former consumes seed tokens.
        if (!nearFloorOnly && load.work>1e-9 && sharedPlots.has(load.facility)) scope.add(load.name);
    }
    for (const [load,resources] of inputs) {
        const usage = load.work / load.sites;
        // The native priority floor has 0.01% slack. Reducing a nearly
        // full prior-priority processor by that amount can create a small
        // ingredient sale even though every input is available to run it.
        if(usage < 1-1e-7 && usage >= 1-2e-4 && resources.every(r=>r.surplus>1e-8)) scope.add(load.name);
        if(nearFloorOnly)continue;
        if (usage >= 1 - 1e-7 || resources.some(r => r.surplus < 1e-8 && r.minimum < usage + 1e-7)) continue;
        const contested = resources.filter(r => r.surplus < 1e-8 && r.consumers.size > 1);
        if (!contested.length) continue;
        for (const resource of contested) for (const other of resource.consumers) scope.add(other.name);
        for (const resource of resources) for (const source of resource.producers) {
            if (source.source||!inputs.has(source)) scope.add(source.name);
        }
    }
    return [...scope];
}
