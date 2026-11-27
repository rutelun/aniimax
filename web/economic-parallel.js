// Pooled Web Workers for independent HiGHS computations (bounds, counts, and
// local MIP subproblems). Independent runtimes are costly on small devices,
// where the planner already supports the same computations inline.
export function economicWorkers(load, {wasmModule = null, createWorker = null, maxWorkers = null} = {}) {
    const hc = globalThis.navigator?.hardwareConcurrency ?? 1;
    const parallel = (typeof createWorker === 'function') || (typeof Worker === 'function' && hc >= 4);
    const limit = maxWorkers ?? 2;
    // Each slot tracks `{ worker, initialized, busyId }`.
    const slots = new Set();
    const pending = new Map();
    const queue = [];
    let nextId = 0, closed = false;

    const spawnSlot = () => {
        let worker;
        try {
            worker = createWorker
                ? createWorker()
                : new Worker(new URL('economic-worker.js' + load, import.meta.url), {type:'module'});
        } catch {
            return null;
        }
        const slot = {worker, initialized:false, busyId:null};
        slots.add(slot);
        worker.onmessage = ({data:{id, result, error, recipes}}) => {
            const request = pending.get(id);
            if (!request) return;
            if (recipes) {
                request.onRecipes?.(recipes);
                return;
            }
            cleanupRequest(id, request);
            slot.busyId = null;
            if (request.kind === 'counts' && result) {
                result = Object.assign(new Map(result.entries), {upper:result.upper, infeasible:Boolean(result.infeasible)});
            }
            request.resolve(error ? null : result);
            drainQueue();
        };
        worker.onerror = worker.onmessageerror = () => {
            const id = slot.busyId;
            slot.busyId = null;
            slots.delete(slot);
            try { worker.terminate(); } catch {}
            if (id != null) {
                const request = pending.get(id);
                if (request) {
                    cleanupRequest(id, request);
                    request.resolve(null);
                }
            }
            drainQueue();
        };
        return slot;
    };

    const cleanupRequest = (id, request) => {
        pending.delete(id);
        if (request.signal && request.onAbort) {
            request.signal.removeEventListener('abort', request.onAbort);
        }
    };

    const dispatchToSlot = (slot, entry) => {
        const {id, kind, problem, settings, reportRecipes, request} = entry;
        if (closed || request.signal?.aborted) {
            cleanupRequest(id, request);
            request.resolve(null);
            return false;
        }
        slot.busyId = id;
        request.slot = slot;
        const message = {id, kind, problem, options:settings, reportRecipes};
        if (wasmModule && !slot.initialized) {
            message.wasmModule = wasmModule;
            slot.initialized = true;
        }
        try {
            slot.worker.postMessage(message);
            return true;
        } catch {
            slot.busyId = null;
            request.slot = null;
            cleanupRequest(id, request);
            request.resolve(null);
            return false;
        }
    };

    const drainQueue = () => {
        if (closed) return;
        while (queue.length) {
            let idle = null;
            for (const slot of slots) {
                if (slot.busyId == null) { idle = slot; break; }
            }
            if (!idle && slots.size < limit) idle = spawnSlot();
            if (!idle) break;
            const entry = queue.shift();
            if (!pending.has(entry.id)) continue;
            dispatchToSlot(idle, entry);
        }
    };

    function invoke(kind, problem, options) {
        if (closed) return null;
        const {onRecipes, signal, ...settings} = options ?? {};
        if (signal?.aborted) return Promise.resolve(null);
        const id = nextId++;
        return new Promise(resolve => {
            const request = {kind, resolve, onRecipes, signal, slot:null, onAbort:null};
            if (signal) {
                request.onAbort = () => {
                    if (!pending.has(id)) return;
                    const slot = request.slot;
                    cleanupRequest(id, request);
                    if (slot && slot.busyId === id) {
                        slot.busyId = null;
                        slots.delete(slot);
                        try { slot.worker.terminate(); } catch {}
                    }
                    resolve(null);
                    drainQueue();
                };
                signal.addEventListener('abort', request.onAbort, {once:true});
            }
            pending.set(id, request);
            const entry = {id, kind, problem, settings, reportRecipes:!!onRecipes, request};
            let idle = null;
            for (const slot of slots) {
                if (slot.busyId == null) { idle = slot; break; }
            }
            if (!idle && slots.size < limit) idle = spawnSlot();
            if (idle) {
                dispatchToSlot(idle, entry);
            } else if (slots.size > 0) {
                queue.push(entry);
            } else {
                cleanupRequest(id, request);
                resolve(null);
            }
        });
    }

    return {
        callbacks: parallel ? {
            evaluateBound:(p, opts) => invoke('bound', p, opts),
            evaluateCounts:(p, opts) => invoke('counts', p, opts),
            evaluateSolve:(p, opts) => invoke('solve', p, opts),
            parallelWorkers: limit,
        } : {},
        close() {
            closed = true;
            queue.length = 0;
            for (const slot of slots) {
                slot.busyId = null;
                try { slot.worker.terminate(); } catch {}
            }
            slots.clear();
            for (const [id, request] of pending) {
                cleanupRequest(id, request);
                request.resolve(null);
            }
            pending.clear();
        },
    };
}
