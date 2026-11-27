// Each child owns its HiGHS runtime. The planner can fit a physical team while
// children compute independent income bounds, counts, or local MIP subproblems.
const version = new URL(import.meta.url).search;
let runtime;
let cachedModule = null;

async function getHighs(wasmModule) {
    if (wasmModule) cachedModule = wasmModule;
    runtime ??= (async () => {
        const mod = await import(new URL('./vendor/highs/highs.mjs' + version, import.meta.url).href);
        if (cachedModule) {
            return mod.default({
                instantiateWasm(imports, callback) {
                    WebAssembly.instantiate(cachedModule, imports)
                        .then(instance => callback(instance, cachedModule))
                        .catch(() => {});
                    return {};
                },
                print(){}, printErr(){},
            });
        }
        const wasmBinary = await fetch(new URL('./vendor/highs/highs.wasm', import.meta.url)).then(response => {
            if (!response.ok) throw new Error('Could not load the economic solver');
            return response.arrayBuffer();
        });
        return mod.default({wasmBinary, print(){}, printErr(){}});
    })().catch(error => { runtime = null; throw error; });
    return runtime;
}

async function evaluate({id, kind, problem, options, reportRecipes, wasmModule}) {
    const highs = await getHighs(wasmModule);
    if (kind === 'bound') {
        const {solveEconomicBound} = await import('./economic-bound.js');
        if (reportRecipes) options.onRecipes = recipes => self.postMessage({id, recipes});
        return solveEconomicBound(highs, problem, options);
    }
    if (kind === 'solve') {
        const {planSearchOptions, polishSolution, solveWithIncumbent} = await import('./highs-solve.js');
        const {warm, polish = false, retryPresolveOff = true, rawOptions = false, ...rest} = options ?? {};
        const opts = rawOptions ? rest : planSearchOptions(rest);
        let result = solveWithIncumbent(highs, problem, opts, warm);
        if (retryPresolveOff && result.Status === 'Infeasible') {
            const retryOpts = opts.mip_max_nodes <= 1 && opts.mipIterations == null
                ? {...opts, presolve:'off', mipIterations:opts.incumbentIterations ?? 6000}
                : {...opts, presolve:'off'};
            result = solveWithIncumbent(highs, problem, retryOpts, warm);
        }
        const proven = result.Status === 'Optimal';
        if (!proven && !['Objective target reached', 'Gap target reached', 'Time limit reached', 'Search limit reached'].includes(result.Status)) {
            return null;
        }
        if (!Number.isFinite(result.ObjectiveValue) || !result.Columns) return null;
        const values = Array.from({length: problem.variables}, (_, i) => result.Columns?.['x' + i]?.Primal ?? 0);
        const tiebreak = (problem.tiebreak || []).reduce((sum, [v, weight]) => sum + weight * (values[v] || 0), 0);
        const solved = {values, proven, objective: result.ObjectiveValue + tiebreak, upper: result.UpperBound};
        if (polish) {
            const polished = polishSolution(highs, problem, solved);
            return {...solved, ...polished};
        }
        return solved;
    }
    const {economicRecipeCounts} = await import('./economic-recipe-counts.js');
    const counts = economicRecipeCounts(highs, problem, options);
    return counts && {entries:[...counts], upper:counts.upper, infeasible:Boolean(counts.infeasible)};
}

self.onmessage = async ({data}) => {
    try {
        self.postMessage({id:data.id, result:await evaluate(data)});
    } catch (error) {
        self.postMessage({id:data.id, error:String(error.message || error)});
    }
};
