// Runs the homeland layout (see layout.js) off the page's own thread, since a large homeland
// takes a few seconds: posts back what `layOutHomeland` returns for the pieces and open cells
// it's sent. Loaded with the page's own load tag (see `WORKER_URL` in app.js), passed on to
// layout.js so a cached older copy is never used with newer page code.
import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';
import { normalizeMapStyle } from './map-style.js';
import { parkIdleBuildings } from './idle-layout.js';
import { optimizePowerNetworks } from './power-islands.js';

const ready = import('./layout.js' + new URL(import.meta.url).search);
const powerReady = import('./power-layout.js' + new URL(import.meta.url).search);
let refinementReady;
function loadRefinement() {
    return refinementReady ??= import('./pkg/aniimax.js' + new URL(import.meta.url).search).then(async pkg => {
        if(typeof pkg.refine_layout !== 'function')return null;
        await pkg.default({module_or_path:fetch(new URL('./pkg/aniimax_bg.wasm',import.meta.url),{cache:'no-cache'})});
        return pkg.refine_layout;
    });
}

self.onmessage = async (event) => {
    const { centralDeliverySeed, createInsideTest, improveFixedStorage, layOutHomeland, layoutDeliveryCost, layoutTravelCost,
        refineDistrictClimate, refineDistrictDeliveries, refineStorageNeighborhood, refineSuppliedLayout, seededStorageLayouts } = await ready;
    const { connectPower, repackPower, updatePowerConnections } = await powerReady;
    const { pieces, cells } = event.data;
    const storageCount = event.data.storageCount ?? 1;
    const poleLimit = event.data.poleLimit ?? 0;
    const { recipes, staffing } = event.data;
    const style = normalizeMapStyle(event.data.style);
    const grouped = style === 'groups';
    const deliver = layout => self.postMessage(optimizePowerNetworks(parkIdleBuildings(layout,cells),cells,poleLimit));
    if (grouped && storageCount > 0) {
        const { productionGroupLayout } = await import('./production-groups.js' + new URL(import.meta.url).search);
        const arranged = await productionGroupLayout(pieces, cells, { storageCount, poleLimit, recipes, staffing });
        if (arranged) {
            self.postMessage(optimizePowerNetworks(arranged,cells,poleLimit));
            return;
        }
    }
    const storage = { w: 2, h: 2 };
    // A failed grouped layout explicitly falls back to Shortest delivery.
    const accountForWorkers = !grouped && style !== 'delivery';
    if(!accountForWorkers&&storageCount>0&&cells.length) {
        try {
            const [refineJSON,{fastLayoutSeed,refineFastLayout,polishFastLayout},{layoutKeepsIncome}]=await Promise.all([
                loadRefinement(),import('./fast-layout.js'+new URL(import.meta.url).search),
                import('./group-layout.js'+new URL(import.meta.url).search),
            ]);
            if(refineJSON) {
                const seed=fastLayoutSeed({pieces,cells,storageCount,poleLimit});
                if(!seed.unplaced.length&&!seed.power.disconnected) {
                    const broad=refineFastLayout(seed,cells,refineJSON);
                    const polished=polishFastLayout(broad,seed,cells,refineJSON);
                    const candidate=layoutKeepsIncome(polished,staffing,recipes||[])?polished:broad;
                    if(layoutKeepsIncome(candidate,staffing,recipes||[])) {
                        const needsRanges=recipes?.some(recipe=>recipe.takes.length)||(recipes?.length>0&&pieces.some(piece=>
                            piece.members?.some(member=>FACILITY_CATEGORY_BY_NAME.get(member.facility)==='Materials Processing')));
                        deliver(grouped?{...candidate,groupFallback:needsRanges?'ranges':'space'}:candidate);
                        return;
                    }
                }
            }
        }catch(error) {
            // Older cached WASM or unsupported inputs retain the previous full
            // search; failed refinement must never leave the map unusable.
            console.warn('Fast layout refinement unavailable; using fallback search.',error);
        }
    }
    const cost = accountForWorkers ? layoutTravelCost : layoutDeliveryCost;
    const options = { fast: true, accountForWorkers };
    const place = () => layOutHomeland(pieces, cells, storage, storageCount, options);
    const centered = accountForWorkers || !pieces.some(piece => piece.members?.some(member => member.electric_level != null))
        ? null : centralDeliverySeed(pieces, cells, storage, storageCount, options);
    const centerCost = centered ? cost(centered) : 0;
    let best = connectPower(centered || place(), cells, poleLimit);
    const complete = current => !current.unplaced.length && !current.power.disconnected;
    const fewerProblems = (candidate, previous) => candidate.unplaced.length < previous.unplaced.length
        || (candidate.unplaced.length === previous.unplaced.length && candidate.power.disconnected < previous.power.disconnected);
    let usedCentered = Boolean(centered);
    if (centered && (!complete(best) || cost(best) > centerCost * 1.3)) {
        // When wiring scatters the central placement, compare it with the regular seed
        // after both have had a chance to move their storage units.
        const regular = connectPower(place(), cells, poleLimit);
        if (fewerProblems(regular, best) || (complete(regular) && (!complete(best)
            || cost(improveFixedStorage(regular, cells, 0)) < cost(improveFixedStorage(best, cells, 0))))) {
            best = regular;
            usedCentered = false;
        }
    }
    if (!complete(best)) {
        for (const trial of seededStorageLayouts(best, pieces, cells, storage, storageCount, options)) {
            const supplied = connectPower(trial, cells, poleLimit);
            if (complete(supplied)) {
                best = supplied;
                break;
            }
            if (fewerProblems(supplied, best)) {
                best = supplied;
            }
        }
    }
    if (!accountForWorkers && !usedCentered && complete(best) && storageCount > 1) {
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
        const moveStorage = layout => improveFixedStorage(layout, cells, accountForWorkers ? .01 : 0);
        if (cells.length && best.storages.length) {
            const x = Math.min(...cells.map(c => c.x)), y = Math.min(...cells.map(c => c.y));
            const w = Math.max(...cells.map(c => c.x + c.w)) - x, h = Math.max(...cells.map(c => c.y + c.h)) - y;
            const inside = createInsideTest(cells);
            const groups = [{ bounds: { x, y, w, h }, reserved: [] }];
            const moveBuildings = layout => refineDistrictDeliveries(layout, groups, {
                swapsOnly: accountForWorkers, passes: accountForWorkers ? 1 : 6, costOf: cost,
                includeMines: !accountForWorkers, targetLimit: accountForWorkers ? 24 : Infinity,
                canPlace: (_, __, rectangles) => rectangles.every(inside),
            });
            for (let round = 0; round < (accountForWorkers ? 1 : 2); round++) {
                let trial = moveStorage(best);
                if (!accountForWorkers) trial = refineDistrictClimate(trial, pieces, cells, { ...options, costOf: cost, clusterTries: 3 });
                trial = moveBuildings(trial);
                if (!accountForWorkers && round === 0) {
                    // Let a storage unit move into occupied space when nearby buildings can move together.
                    trial = refineStorageNeighborhood(trial, pieces, cells, 3, { cost });
                }
                trial = updatePowerConnections(trial);
                if (!complete(trial) || cost(trial) >= cost(best) - 1e-9) break;
                best = trial;
            }
        }
        if (!accountForWorkers && cells.length) {
            const x=Math.min(...cells.map(c=>c.x)),y=Math.min(...cells.map(c=>c.y));
            const w=Math.max(...cells.map(c=>c.x+c.w))-x,h=Math.max(...cells.map(c=>c.y+c.h))-y;
            const inside=createInsideTest(cells);
            let trial=refineSuppliedLayout(best,pieces,cells,{
                costOf:cost,accountForWorkers:false,fast:true,clusterTries:3,exchangeBudget:0,storageTrials:0,
            });
            // Joint local repacks can escape a single-building minimum. Pin everything
            // outside one storage neighborhood; evaluate every store on equal terms.
            for (const store of trial.storages) {
                const fixedPieces=new Set(trial.pieces.flatMap((piece,i)=>
                    piece.members.some(r=>r.generator) || !piece.members.some(r=>
                        Math.hypot(r.x+r.w/2-store.x-store.w/2,r.y+r.h/2-store.y-store.h/2)<11) ? [i] : []));
                trial=refineSuppliedLayout(trial,pieces,cells,{
                    costOf:cost,accountForWorkers:false,fast:true,clusterTries:3,
                    exchangeBudget:16,storageTrials:0,fixedPieces,
                });
            }
            trial=refineStorageNeighborhood(trial,pieces,cells,5,{cost,quarterGrid:true});
            trial=refineDistrictDeliveries(trial,[{bounds:{x,y,w,h},reserved:[]}],{
                costOf:cost,includeMines:true,passes:4,quarterGrid:true,
                canPlace:(_,__,rs)=>rs.every(inside),
            });
            trial=updatePowerConnections(trial);
            if(complete(trial)&&cost(trial)<cost(best)-1e-9)best=trial;
        }
        const poles = best.power.poles.length;
        if (poles >= 5) {
            const maximumCost = cost(best) * (accountForWorkers ? 1.02 : 1);
            best = repackPower(best, cells, poleLimit, { attempts: 2, accept: candidate => {
                if (poles - candidate.power.poles.length < 3) return false;
                const relocated = moveStorage(candidate);
                if (cost(relocated) > maximumCost) return false;
                Object.assign(candidate, relocated);
                return true;
            } });
        }
    }
    const needsRanges = recipes?.some(recipe => recipe.takes.length) || (recipes?.length > 0 && pieces.some(piece =>
        piece.members?.some(member => FACILITY_CATEGORY_BY_NAME.get(member.facility) === 'Materials Processing')));
    const fallback = storageCount === 0 ? 'storage' : needsRanges ? 'ranges' : 'space';
    deliver(grouped ? { ...best, groupFallback: fallback } : best);
};
