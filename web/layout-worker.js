// Runs the homeland layout (see layout.js) off the page's own thread, since a large homeland
// takes a few seconds: posts back what `layOutHomeland` returns for the pieces and open cells
// it's sent. Loaded with the page's own load tag (see `WORKER_URL` in app.js), passed on to
// layout.js so a cached older copy is never used with newer page code.
import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';

const ready = import('./layout.js' + new URL(import.meta.url).search);
const powerReady = import('./power-layout.js' + new URL(import.meta.url).search);

self.onmessage = async (event) => {
    const deadline = performance.now() + (event.data.budgetMs ?? 2500);
    const { layOutHomeland, seededStorageLayouts, layoutTravelCost } = await ready;
    const { connectPower } = await powerReady;
    const { pieces, cells } = event.data;
    const storageCount = event.data.storageCount ?? 1;
    const poleLimit = event.data.poleLimit ?? 0;
    const { style, groupGap, saleProducts, recipes, staffing } = event.data;
    const grouped = ['courtyards', 'avenues', 'districts'].includes(style);
    const needsRanges = recipes?.some(recipe => recipe.takes.length) || (recipes?.length > 0 && pieces.some(piece =>
        piece.members?.some(member => FACILITY_CATEGORY_BY_NAME.get(member.facility) === 'Materials Processing')));
    const fallback = storageCount === 0 ? 'storage' : needsRanges ? 'ranges' : 'space';
    const asFallback = layout => grouped ? { ...layout, groupFallback: fallback } : layout;
    const storage = { w: 2, h: 2 };
    const layout = layOutHomeland(pieces, cells, storage, storageCount, { fast: true, deadline: deadline - 700 });
    let best = connectPower(layout, cells, poleLimit, true, null, null, deadline);
    const complete = current => !current.unplaced.length && !current.power.disconnected;
    const report = (current, done, searchLimited = false) => self.postMessage({
        layout: { ...asFallback(current), searchLimited }, done,
    });
    if ((!grouped && complete(best)) || performance.now() >= deadline) {
        report(best, true, (grouped || !complete(best)) && performance.now() >= deadline);
        return;
    }
    report(best, false);
    if (grouped && storageCount > 0 && performance.now() < deadline) {
        const { groupHomelandLayout } = await import('./group-layout.js' + new URL(import.meta.url).search);
        const arranged = await groupHomelandLayout(pieces, cells, { style, gap: groupGap, storageCount, poleLimit, saleProducts, recipes, staffing, deadline });
        if (arranged) {
            self.postMessage({ layout: arranged, done: true });
            return;
        }
    }
    if (!complete(best) && performance.now() < deadline) {
        for (const trial of seededStorageLayouts(best, pieces, cells, storage, storageCount)) {
            if (performance.now() >= deadline) break;
            const supplied = connectPower(trial, cells, poleLimit, true, null, null, deadline);
            if (complete(supplied)) {
                best = supplied;
                break;
            }
            if (supplied.unplaced.length <= best.unplaced.length && supplied.power.disconnected < best.power.disconnected
                && layoutTravelCost(supplied) <= layoutTravelCost(best)) {
                best = supplied;
                report(best, false);
            }
        }
    }
    report(best, true, (grouped || !complete(best)) && performance.now() >= deadline);
};
