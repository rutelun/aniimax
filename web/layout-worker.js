// Runs the homeland layout (see layout.js) off the page's own thread, since a large homeland
// takes a few seconds: posts back what `layOutHomeland` returns for the pieces and open cells
// it's sent. Loaded with the page's own load tag (see `WORKER_URL` in app.js), passed on to
// layout.js so a cached older copy is never used with newer page code.
import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';

const ready = import('./layout.js' + new URL(import.meta.url).search);
const powerReady = import('./power-layout.js' + new URL(import.meta.url).search);

self.onmessage = async (event) => {
    const { createInsideTest, improveFixedStorage, layOutHomeland, layoutDeliveryCost, layoutTravelCost, refineDistrictDeliveries, seededStorageLayouts } = await ready;
    const { connectPower, repackPower, updatePowerConnections } = await powerReady;
    const { pieces, cells } = event.data;
    const storageCount = event.data.storageCount ?? 1;
    const poleLimit = event.data.poleLimit ?? 0;
    const { style, groupGap, saleProducts, recipes, staffing } = event.data;
    const grouped = ['courtyards', 'avenues', 'districts'].includes(style);
    if (grouped && storageCount > 0) {
        const { groupHomelandLayout } = await import('./group-layout.js' + new URL(import.meta.url).search);
        const arranged = await groupHomelandLayout(pieces, cells, { style, gap: groupGap, storageCount, poleLimit, saleProducts, recipes, staffing, fast: true });
        if (arranged) {
            self.postMessage(arranged);
            return;
        }
    }
    const storage = { w: 2, h: 2 };
    const accountForWorkers = style !== 'delivery';
    const cost = accountForWorkers ? layoutTravelCost : layoutDeliveryCost;
    const options = { fast: true, accountForWorkers };
    const layout = layOutHomeland(pieces, cells, storage, storageCount, options);
    let best = connectPower(layout, cells, poleLimit);
    const complete = current => !current.unplaced.length && !current.power.disconnected;
    if (!complete(best)) {
        for (const trial of seededStorageLayouts(best, pieces, cells, storage, storageCount, options)) {
            const supplied = connectPower(trial, cells, poleLimit);
            if (complete(supplied)) {
                best = supplied;
                break;
            }
            if (supplied.unplaced.length < best.unplaced.length
                || (supplied.unplaced.length === best.unplaced.length && supplied.power.disconnected < best.power.disconnected)) {
                best = supplied;
            }
        }
    }
    if (!accountForWorkers && complete(best) && storageCount > 1) {
        // A complete first placement can still be far from useful storage locations
        // after the power routing moves consumers. Try one cheaper storage seed.
        const currentCost = cost(best);
        for (const trial of seededStorageLayouts(best, pieces, cells, storage, storageCount, options)) {
            if (cost(trial) >= currentCost * .97) continue;
            const supplied = connectPower(trial, cells, poleLimit);
            if (complete(supplied) && cost(supplied) < currentCost - 1e-9) best = supplied;
            break;
        }
    }
    if (complete(best)) {
        best = improveFixedStorage(best, cells);
        const poles = best.power.poles.length;
        if (poles >= 5) {
            const maximumCost = cost(best) * (accountForWorkers ? 1.02 : 1);
            best = repackPower(best, cells, poleLimit, { attempts: 2, accept: candidate => {
                if (poles - candidate.power.poles.length < 3) return false;
                const relocated = improveFixedStorage(candidate, cells);
                if (cost(relocated) > maximumCost) return false;
                Object.assign(candidate, relocated);
                return true;
            },
            });
        }
        if (cells.length && best.storages.length) {
            const x = Math.min(...cells.map(c => c.x)), y = Math.min(...cells.map(c => c.y));
            const w = Math.max(...cells.map(c => c.x + c.w)) - x, h = Math.max(...cells.map(c => c.y + c.h)) - y;
            const inside = createInsideTest(cells);
            const optimized = updatePowerConnections(refineDistrictDeliveries(best, [{ bounds: { x, y, w, h }, reserved: [] }], {
                swapsOnly: accountForWorkers, passes: 1, costOf: cost, includeMines: !accountForWorkers, targetLimit: 24,
                canPlace: (_, __, rectangles) => rectangles.every(inside),
            }));
            if (complete(optimized) && cost(optimized) < cost(best) - 1e-9) best = improveFixedStorage(optimized, cells);
        }
    }
    const needsRanges = recipes?.some(recipe => recipe.takes.length) || (recipes?.length > 0 && pieces.some(piece =>
        piece.members?.some(member => FACILITY_CATEGORY_BY_NAME.get(member.facility) === 'Materials Processing')));
    const fallback = storageCount === 0 ? 'storage' : needsRanges ? 'ranges' : 'space';
    self.postMessage(grouped ? { ...best, groupFallback: fallback } : best);
};
