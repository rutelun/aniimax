// Independent alternatives have independent feasible regions. Run a small number together,
// reusing each worker's WASM runtime, without changing any search limits or proof criteria.
export function comparisonConcurrency(device, count) {
    const cores = device?.hardwareConcurrency || 2, memory = device?.deviceMemory || 4;
    return Math.min(count, cores >= 12 && memory >= 8 ? 4 : cores >= 4 ? 2 : 1);
}

export function startComparisonQueue({indices, parallel, createWorker, payload, timeout,
    setTimer = setTimeout, clearTimer = clearTimeout, onProgress, onResult, onDone}) {
    const pending = [...indices], slots = [];
    let stopped = false, failed = false, nextId = 0, initializing = true;
    const active = () => slots.filter(s=>s.index != null).map(s=>({index:s.index,step:s.step}));
    const notify = () => onProgress(active());
    const dispose = slot => { clearTimer(slot.timer); slot.worker.terminate(); slot.index = null; slot.dead = true; };
    const finish = () => {
        if (!initializing && !stopped && !slots.some(s=>s.index != null) && (!pending.length || slots.every(s=>s.dead))) {
            stopped = true; slots.forEach(dispose); onDone(failed || pending.length > 0);
        }
    };
    const heartbeat = slot => {
        clearTimer(slot.timer);
        slot.timer = setTimer(()=>crash(slot),timeout);
    };
    const dispatch = slot => {
        slot.index = pending.shift(); slot.step = ''; slot.reported = false;
        if (slot.index == null) { clearTimer(slot.timer); notify(); finish(); return; }
        slot.id = ++nextId; heartbeat(slot); notify();
        slot.worker.postMessage({id:slot.id,type:'rank_improvements',payload:JSON.stringify(payload(slot.index))});
    };
    const crash = slot => {
        if (stopped || slot.dead) return;
        failed = true;
        if (!slot.reported && slot.index != null) onResult(slot.index,{error:'The comparison worker stopped. Try this alternative again.'});
        dispose(slot); notify(); finish();
    };
    // Create all slots before dispatch: synchronous failures/completions cannot finish a
    // partially constructed pool or make an alternative run twice.
    for (let n=0;n<Math.min(parallel,indices.length);n++) {
        const slot = {worker:createWorker(),index:null,dead:false}; slots.push(slot);
        slot.worker.onmessage = ({data}) => {
            if (stopped || slot.dead || data.id !== slot.id || slot.index == null) return;
            heartbeat(slot);
            if (data.type === 'progress') {
                const result = data.count;
                if (result.step) { slot.step=result.step; notify(); }
                else if (result.index === 0) { slot.reported=true; onResult(slot.index,result); }
            } else {
                if (!data.ok) {
                    failed = true;
                    if (!slot.reported) onResult(slot.index,{error:data.error || 'Could not compare'});
                }
                dispatch(slot);
            }
        };
        slot.worker.onerror = slot.worker.onmessageerror = () => crash(slot);
    }
    // A drained slot is idle while other slots finish; it is disposed with the pool.
    slots.forEach(dispatch);
    initializing = false; finish();
    return {stop(){stopped=true;slots.forEach(dispose);},workers:slots.map(s=>s.worker)};
}
