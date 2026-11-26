// One worker per independent computation. Independent runtimes are costly on
// small devices, where the planner already supports the same computations inline.
export function economicWorkers(load) {
    const workers = new Map(), pending = new Map();
    let nextId = 0, closed = false;
    function invoke(kind,problem,options) {
        if (closed) return null;
        let worker = workers.get(kind);
        if (!worker) {
            try { worker = new Worker(new URL('economic-worker.js'+load,import.meta.url),{type:'module'}); }
            catch { return null; }
            workers.set(kind,worker);
            worker.onmessage = ({data:{id,result,error,recipes}}) => {
                const request = pending.get(id);
                if (!request) return;
                if (recipes) {
                    request.onRecipes?.(recipes);
                    return;
                }
                pending.delete(id);
                if (kind === 'counts' && result) result = Object.assign(new Map(result.entries),{upper:result.upper,infeasible:Boolean(result.infeasible)});
                request.resolve(error ? null : result);
            };
            worker.onerror = worker.onmessageerror = () => {
                for (const [id,request] of pending) if (request.kind === kind) {
                    pending.delete(id);
                    request.resolve(null);
                }
                workers.delete(kind);
                worker.terminate();
            };
        }
        const id = nextId++;
        return new Promise(resolve=>{
            const {onRecipes,...settings}=options ?? {};
            pending.set(id,{kind,resolve,onRecipes});
            try { worker.postMessage({id,kind,problem,options:settings,reportRecipes:!!onRecipes}); }
            catch { pending.delete(id); resolve(null); }
        });
    }
    const parallel = typeof Worker === 'function' && (globalThis.navigator?.hardwareConcurrency ?? 1) >= 4;
    return {
        callbacks:parallel ? {
            evaluateBound:(p,opts)=>invoke('bound',p,opts),
            evaluateCounts:(p,opts)=>invoke('counts',p,opts),
        } : {},
        close() {
            closed = true;
            for (const worker of workers.values()) worker.terminate();
            for (const request of pending.values()) request.resolve(null);
            workers.clear();
            pending.clear();
        },
    };
}
