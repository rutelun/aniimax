// Each child owns its HiGHS runtime. The planner can fit a physical team while
// the child computes an independent income bound for the same input.
const version = new URL(import.meta.url).search;
let runtime;
async function evaluate({id,kind,problem,options,reportRecipes}) {
    runtime ??= Promise.all([
        import(new URL('./vendor/highs/highs.mjs' + version, import.meta.url).href),
        fetch(new URL('./vendor/highs/highs.wasm',import.meta.url)).then(response=>{
            if (!response.ok) throw new Error('Could not load the economic solver');
            return response.arrayBuffer();
        }),
    ]).then(([module,wasmBinary])=>module.default({wasmBinary,print(){},printErr(){}}));
    const highs = await runtime;
    if (kind === 'bound') {
        const {solveEconomicBound} = await import('./economic-bound.js');
        if (reportRecipes) options.onRecipes=recipes=>self.postMessage({id,recipes});
        return solveEconomicBound(highs,problem,options);
    }
    const {economicRecipeCounts} = await import('./economic-recipe-counts.js');
    const counts = economicRecipeCounts(highs,problem,options);
    return counts && {entries:[...counts],upper:counts.upper,infeasible:Boolean(counts.infeasible)};
}
self.onmessage = async ({data}) => {
    try {
        self.postMessage({id:data.id,result:await evaluate(data)});
    } catch (error) {
        self.postMessage({id:data.id,error:String(error.message || error)});
    }
};
