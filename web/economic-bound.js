import {planSearchOptions,runPlanModel,searchStopped} from './highs-solve.js';

// An unrestricted recipe-scope model retains every recipe, dispatch policy,
// physical building and balance. Omitting a recipe's work-conservation rules
// enlarges its feasible set, so its MIP dual bound also bounds the full model.
// A primal from this relaxation still needs the caller's full production audit.
export function solveEconomicBound(highs, problem, {seed, scope = [], timeLimit = 2, discovery = false, exact = false} = {}) {
    const keys = problem.variable_keys;
    if (!problem.production_only || problem.continuousRestricted || !problem.primary_objective?.length
        || keys?.length !== problem.variables || !problem.recipe_options || !(timeLimit > 0)) return null;
    const model = highs.createModel({format:'lp', data:problem.lp});
    try {
        const {numCols} = model.getDimensions();
        const indices = Array.from({length:numCols}, (_, i) => Number(model.getColName(i).slice(1)));
        if (indices.some(v => !Number.isInteger(v) || v < 0 || v >= keys.length)) return null;
        const precision = {mip_abs_gap:0, mip_rel_gap:0,
            primal_feasibility_tolerance:discovery?1e-7:1e-9, mip_feasibility_tolerance:discovery?1e-8:1e-9};
        const nativeOptions = exact ? precision : planSearchOptions({time_limit:timeLimit,...precision});
        if (discovery) nativeOptions.mip_max_nodes = Math.ceil(128*timeLimit);
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
        runPlanModel(model,highs,!exact && (seed || discovery) ? Math.ceil(timeLimit * 4000) : undefined);
        const statuses = highs.constants.modelStatus;
        // Tight priority floors and measured worker shares can make presolve
        // declare a feasible model infeasible. Verify on its original rows.
        if(exact && model.getModelStatus()===statuses.infeasible){
            model.clearSolver();
            model.options.set({presolve:'off'});
            runPlanModel(model,highs);
        }
        const status = model.getModelStatus();
        if (status !== statuses.optimal && !searchStopped(status,statuses)) return null;
        const optimal = status === statuses.optimal;
        const upper = optimal ? model.getObjectiveValue() : model.info.get('mip_dual_bound');
        const result = {upper:!discovery && Number.isFinite(upper) ? upper : null, proven:optimal && !discovery, scope:[...scope]};
        if (model.info.get('primal_solution_status') !== highs.constants.solutionStatus.feasible) return result;
        const values = Array(keys.length).fill(0), native = model.getSolution().colValue;
        indices.forEach((v, i) => { values[v] = native[i]; });
        const objective = problem.primary_objective.reduce((sum, [v,c]) => sum + c * values[v], 0);
        return {...result, keys, values, objective, ...economicRecipeUse(problem, values)};
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
