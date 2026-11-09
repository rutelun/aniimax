// Runs the homeland layout (see layout.js) off the page's own thread, since a large homeland
// takes a few seconds: posts back what `layOutHomeland` returns for the pieces and open cells
// it's sent. Loaded with the page's own load tag (see `WORKER_URL` in app.js), passed on to
// layout.js so a cached older copy is never used with newer page code.
const ready = import('./layout.js' + new URL(import.meta.url).search);
const powerReady = import('./power-layout.js' + new URL(import.meta.url).search);

self.onmessage = async (event) => {
    const { layOutHomeland, refineSuppliedLayout, seededStorageLayouts, layoutTravelCost } = await ready;
    const { connectPower, updatePowerConnections } = await powerReady;
    const { pieces, cells } = event.data;
    const storageCount = event.data.storageCount ?? 1;
    const poleLimit = event.data.poleLimit ?? 0;
    const storage = { w: 2, h: 2 };
    const layout = layOutHomeland(pieces, cells, storage, storageCount);
    const powered = connectPower(layout, cells, poleLimit);
    // Routing can relocate electric facilities and vacate useful positions. Fill those holes
    // after routing too, without moving infrastructure or disconnecting any electric consumer.
    let best = updatePowerConnections(refineSuppliedLayout(powered, pieces, cells));
    let cost = layoutTravelCost(best);
    for (const trial of seededStorageLayouts(best, pieces, cells, storage, storageCount)) {
        const supplied = connectPower(trial, cells, poleLimit);
        if (supplied.power.disconnected) continue;
        const refined = updatePowerConnections(refineSuppliedLayout(supplied, pieces, cells, { storageTrials: 0 }));
        const score = layoutTravelCost(refined);
        if (!refined.power.disconnected && (best.unplaced.length || best.power.disconnected || score < cost - 1e-6)) {
            best = refined;
            cost = score;
        }
    }
    self.postMessage(best);
};
