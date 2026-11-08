// Places a whole homeland around its Storage Units, so the Aniimo hauling each finished batch
// walk as little as they can: a piece's cost is its trips (finished batches) per hour times its
// straight-line distance to the nearest Storage Unit, center to center.
//
// Environment buildings keep every plot the plan gives them covered as planned, but not in any set
// arrangement: a plot may go anywhere its footprint overlaps its building's 9x9 coverage square by
// a real area (the rule in coverage.rs), or for two buildings placed to overlap, the zone the plan
// gives it (the first's alone, both, or the second's alone). Temperatures add up where squares
// meet, so no covered plot reaches another building's square, and the squares of different
// buildings don't overlap. Pieces marked `sensitive` (crops that need an environment, grown
// without one) stay out of every square too, so none picks up a temperature it wasn't planned
// for. Anything else, including crops that need no environment, may stand anywhere. Pieces may touch but not overlap, sit on a quarter-tile grid (the smallest step in
// any footprint), and may be turned a quarter at a time.
//
// Busiest pieces for their size go down first, each where it costs least; then each is lifted
// and put back wherever is cheapest with the rest in place, until nothing moves. This is a
// heuristic: it finds a good layout, not a proven best one.

import { workerHubs, workerPlacementCost, workerLayoutCost } from './worker-travel.js?v=auto-worker-travel';

const STEP = 0.25;
const EPSILON = 1e-6;
const CELL = 4;
const RADIUS = 4.5;
// Building positions tried past the first that works, since a building's plots can go anywhere
// in its square and the nearest building isn't always the cheapest; of those, how many also try
// packing the plots afresh, which is slow and seldom beats the plan's own arrangement when a
// building covers many plots.
const CLUSTER_TRIES = 24;
const CLUSTER_PACKS = 2;
const CLUSTER_PACK_MOST = 12;

// Quarter-tile rectangles can query a summed-area table instead of intersecting every
// open plot on every placement. Non-grid or overlapping input retains the area check.
export function createInsideTest(cells) {
    if (!cells) return () => true;
    const fallback = r => cells.reduce((sum,c)=>sum+overlapArea(r,c),0)>=r.w*r.h-EPSILON;
    if (!cells.length || !cells.every(c=>[c.x,c.y,c.w,c.h,c.x+c.w,c.y+c.h].every(v=>Number.isSafeInteger(v/STEP))&&c.w>0&&c.h>0)
        || cells.some((c,i)=>cells.slice(i+1).some(other=>overlapArea(c,other)>0))) return fallback;
    const left=Math.min(...cells.map(c=>c.x))/STEP,top=Math.min(...cells.map(c=>c.y))/STEP;
    const width=Math.max(...cells.map(c=>c.x+c.w))/STEP-left,height=Math.max(...cells.map(c=>c.y+c.h))/STEP-top;
    if (width*height>1_000_000) return fallback;
    const covered=new Uint8Array(width*height),stride=width+1,prefix=new Uint32Array(stride*(height+1));
    for(const cell of cells){
        const x=cell.x/STEP-left,y=cell.y/STEP-top,w=cell.w/STEP,h=cell.h/STEP;
        for(let row=y;row<y+h;row++)covered.fill(1,row*width+x,row*width+x+w);
    }
    for(let y=0;y<height;y++){
        let count=0;
        for(let x=0;x<width;x++){
            count+=covered[y*width+x];
            prefix[(y+1)*stride+x+1]=prefix[y*stride+x+1]+count;
        }
    }
    return r=>{
        if (!Number.isSafeInteger(r.x/STEP)||!Number.isSafeInteger(r.y/STEP)||!Number.isSafeInteger(r.w/STEP)||!Number.isSafeInteger(r.h/STEP)
            || !Number.isSafeInteger((r.x+r.w)/STEP)||!Number.isSafeInteger((r.y+r.h)/STEP)
            || r.w<=0 || r.h<=0) return fallback(r);
        const x=r.x/STEP-left,y=r.y/STEP-top,w=r.w/STEP,h=r.h/STEP;
        if(x<0||y<0||x+w>width||y+h>height)return false;
        const count=prefix[(y+h)*stride+x+w]-prefix[y*stride+x+w]-prefix[(y+h)*stride+x]+prefix[y*stride+x];
        return count===w*h;
    };
}

export function cacheGridDistance(extent, distance) {
    const left=Math.floor(extent.x/STEP),top=Math.floor(extent.y/STEP);
    const width=Math.ceil(extent.x2/STEP)-left+1,height=Math.ceil(extent.y2/STEP)-top+1;
    if(![left,top,Math.ceil(extent.x2/STEP),Math.ceil(extent.y2/STEP)].every(Number.isSafeInteger)
        || !Number.isFinite(width*height)||width*height>1_000_000||width<=0||height<=0)return distance;
    const values=new Float64Array(width*height).fill(-1);
    return (x,y)=>{
        const ix=x/STEP-left,iy=y/STEP-top;
        if(!Number.isInteger(ix)||!Number.isInteger(iy)||ix<0||iy<0||ix>=width||iy>=height)return distance(x,y);
        const index=iy*width+ix;
        if(values[index]<0)values[index]=distance(x,y);
        return values[index];
    };
}

// `pieces`: each either
// - `{ members: [{ x, y, w, h, weight, sensitive }] }`, one rigid piece (a facility unit), whose
//   members are relative to its own frame; `sensitive` members stay out of every coverage square;
// - `{ cluster: true, buildings: [{ x, y, w, h }], plots: [{ w, h, weight, zone }], planned:
//   [{ x, y }] }`, environment buildings (one, or two placed to overlap) with the plots they
//   cover: `zone` is 0 for a lone building's plots, else 0, 1 or 2 for the first's zone, the
//   shared one and the second's; `planned` is each plot's place in the plan's own arrangement,
//   in the buildings' frame, used when the plots can't be packed any other way.
// Everything is in tiles, with the Storage Unit's center at the origin. `options.cells`, if
// given, are the open parts of the homeland (disjoint rectangles, in the same frame): every piece
// has to lie within them, though one may span two that meet.
// Returns `{ storage, storages, pieces, unplaced, tried }`: each piece with its members (a cluster's
// buildings then plots) at their final places and its cost, the indices of any piece there was
// no room for, and how many spots were tried.
export function layOut(pieces, options = {}) {
    const { storage = { w: 2, h: 2 }, passes = 6, cells = null } = options;
    const storageRect = { x: -storage.w / 2, y: -storage.h / 2, w: storage.w, h: storage.h };
    const storages = options.storages ?? [storageRect];
    const storageCenters = storages.map(s => [s.x + s.w / 2, s.y + s.h / 2]);
    const rawDistanceToStorage = (x, y) => {
        if (!storageCenters.length) return Math.hypot(x, y);
        let nearest = Infinity;
        for (const center of storageCenters) {
            const dx = x - center[0], dy = y - center[1];
            const squared = dx * dx + dy * dy;
            if (squared < nearest) nearest = squared;
        }
        return Math.sqrt(nearest);
    };
    let tried = 0;
    // Within the open cells: the parts of it inside each cell add up to all of it.
    const inside = createInsideTest(cells);
    const shapes = pieces.map(piece => (piece.cluster ? clusterOrientations(piece) : orientations(piece.members)));
    const membersOf = piece => (piece.cluster ? [...piece.buildings.map(b => ({ ...b, weight: 0 })), ...piece.plots] : piece.members);
    const weightOf = piece => membersOf(piece).reduce((sum, m) => sum + m.weight, 0);
    const areaOf = piece => membersOf(piece).reduce((sum, m) => sum + m.w * m.h, 0);
    const order = pieces
        .map((piece, i) => ({ i, density: weightOf(piece) / Math.max(areaOf(piece), EPSILON) }))
        .sort((a, b) => b.density - a.density || areaOf(pieces[b.i]) - areaOf(pieces[a.i]))
        .map(p => p.i);

    // Spots to try: the open cells' extent, or with none given, well past what everything needs.
    const totalArea = pieces.reduce((sum, p) => sum + areaOf(p), 0) + storages.reduce((sum, s) => sum + s.w * s.h, 0);
    const reach = Math.ceil(Math.sqrt(totalArea) * 1.6 + 16);
    const extent = cells
        ? {
            x: Math.min(...cells.map(c => c.x)), y: Math.min(...cells.map(c => c.y)),
            x2: Math.max(...cells.map(c => c.x + c.w)), y2: Math.max(...cells.map(c => c.y + c.h)),
        }
        : { x: -reach, y: -reach, x2: reach, y2: reach };
    const distanceToStorage = cacheGridDistance(extent,rawDistanceToStorage);
    const offsets = latticeByDistance(extent, STEP, distanceToStorage);
    // Environment buildings stand on whole tiles, which is plenty for them and far fewer to try.
    const clusterOffsets = latticeByDistance(extent, 1, distanceToStorage);

    // What's down: rectangles by piece, found through a coarse grid; coverage squares by cluster;
    // and the rectangles that must stay out of every square.
    const grid = new Map();
    const minCellX=Math.floor(extent.x/CELL)-2,minCellY=Math.floor(extent.y/CELL)-2;
    const cellWidth=Math.ceil(extent.x2/CELL)-minCellX+3,cellHeight=Math.ceil(extent.y2/CELL)-minCellY+3;
    // Numeric keys avoid allocating strings in the inner collision loop. Coordinates
    // outside this layout's finite grid retain distinct string keys.
    const cellKey=(x,y)=>x>=minCellX&&y>=minCellY&&x<minCellX+cellWidth&&y<minCellY+cellHeight
        ? (x-minCellX)*cellHeight+y-minCellY : `${x},${y}`;
    const spatialCells=r=>cellsOf(r,cellKey);
    const placedRects = new Map();
    const collisionSeen=new Uint32Array(pieces.length+2);
    let collisionStamp=0;
    let activeWorkerHubs = new Map();
    const hasWorkerRoutes = pieces.some(p => membersOf(p).some(m => m.workers?.length));
    const squares = new Map();
    const sensitive = new Map();
    const occupy = (key, spot) => {
        placedRects.set(key, spot.rects);
        spot.rects.forEach(r => spatialCells(r).forEach(c => {
            if (!grid.has(c)) grid.set(c, new Set());
            grid.get(c).add(key);
        }));
        if (spot.squares) squares.set(key, spot.squares);
        if (spot.sensitive?.length) sensitive.set(key, spot.sensitive);
    };
    const vacate = key => {
        (placedRects.get(key) || []).forEach(r => spatialCells(r).forEach(c => grid.get(c)?.delete(key)));
        placedRects.delete(key);
        squares.delete(key);
        sensitive.delete(key);
    };
    const free = (r, ignore) => {
        if (!inside(r)) return false;
        collisionStamp=(collisionStamp+1)>>>0;
        if(!collisionStamp){collisionSeen.fill(0);collisionStamp=1;}
        const right=Math.floor((r.x+r.w-EPSILON)/CELL),bottom=Math.floor((r.y+r.h-EPSILON)/CELL);
        for(let cx=Math.floor(r.x/CELL);cx<=right;cx++)for(let cy=Math.floor(r.y/CELL);cy<=bottom;cy++){
            const occupants=grid.get(cellKey(cx,cy));
            if(!occupants)continue;
            for (const other of occupants) {
                if (other === ignore) continue;
                const index=typeof other==='number'?other:pieces.length+(other==='storage'?0:1);
                if(collisionSeen[index]===collisionStamp)continue;
                collisionSeen[index]=collisionStamp;
                for(const o of placedRects.get(other))if(overlaps(r,o))return false;
            }
        }
        return true;
    };
    const inOtherSquare = (r, ignore) => {
        for (const [key, list] of squares) {
            if (key !== ignore && list.some(s => overlaps(r, s))) return true;
        }
        return false;
    };
    occupy('storage', { rects: storages });
    if (options.obstacles?.length) occupy('obstacles', { rects: options.obstacles });

    const placeRigid = i => {
        let best = null;
        for (const shape of shapes[i]) {
            const travelRadius = hasWorkerRoutes && shape.members.some(m => m.workers?.length) ? 6 : 0;
            let firstFit = null;
            // Almost every rigid piece is one physical building. Reuse its probe rectangle
            // and only copy a winning position instead of allocating arrays per grid point.
            if(shape.members.length===1&&options.singleBuildingFastPath!==false){
                const member=shape.members[0],rectangle={x:0,y:0,w:member.w,h:member.h},rectangles=[rectangle];
                for(const [ox,oy,distance] of offsets){
                    if(firstFit!==null&&distance>firstFit+shape.spread+STEP+travelRadius)break;
                    const x=snap(ox-shape.cx),y=snap(oy-shape.cy);
                    rectangle.x=member.x+x;rectangle.y=member.y+y;tried++;
                    if(!free(rectangle,i)||member.sensitive&&inOtherSquare(rectangle,i))continue;
                    if(options.canPlace&&!options.canPlace(i,shape.members,rectangles))continue;
                    if(firstFit===null)firstFit=distance;
                    const centerX=rectangle.x+rectangle.w/2,centerY=rectangle.y+rectangle.h/2;
                    const away=distanceToStorage(centerX,centerY);
                    let walking=0;
                    if(hasWorkerRoutes)for(const [worker,visits] of member.workers || []){
                        const hub=activeWorkerHubs.get(worker);
                        if(hub)walking+=visits*Math.hypot(centerX-hub.x,centerY-hub.y);
                    }
                    const cost=member.weight*away+walking+EPSILON*away;
                    if(!best||cost<best.cost-EPSILON){
                        const placed={...rectangle};
                        best={cost,x,y,shape,rects:[placed],sensitive:member.sensitive?[placed]:[]};
                    }
                }
                continue;
            }
            for (const [ox, oy, distance] of offsets) {
                if (firstFit !== null && distance > firstFit + shape.spread + STEP
                    + travelRadius) break;
                const x = snap(ox - shape.cx);
                const y = snap(oy - shape.cy);
                tried++;
                const rects = shape.members.map(m => ({ x: m.x + x, y: m.y + y, w: m.w, h: m.h }));
                if (!rects.every(r => free(r, i))) continue;
                const touchy = rects.filter((r, j) => shape.members[j].sensitive);
                if (touchy.some(r => inOtherSquare(r, i))) continue;
                if (options.canPlace && !options.canPlace(i, shape.members, rects)) continue;
                if (firstFit === null) firstFit = distance;
                const cost = shape.members.reduce((sum, m) => sum + m.weight * distanceToStorage(m.x + x + m.w / 2, m.y + y + m.h / 2), 0)
                    + (hasWorkerRoutes ? workerPlacementCost(shape.members, rects, activeWorkerHubs) : 0)
                    // Pieces nobody visits still go as close as they can, to keep the homeland tight.
                    + EPSILON * distanceToStorage(shape.cx + x, shape.cy + y);
                if (!best || cost < best.cost - EPSILON) best = { cost, x, y, shape, rects, sensitive: touchy };
            }
        }
        return best;
    };

    // A cluster's buildings at `(x, y)` in orientation `shape`, with its plots in the plan's own
    // arrangement (turned with it), the busiest crops on the plots nearest the Storage Unit; with
    // `pack`, also packed afresh nearest the Storage Unit within their zones, if that's cheaper.
    const tryCluster = (i, shape, x, y, pack, clear) => {
        tried++;
        const buildings = shape.buildings.map(b => ({ x: b.x + x, y: b.y + y, w: b.w, h: b.h }));
        const own = buildings.map(b => ({ x: b.x + b.w / 2 - RADIUS, y: b.y + b.h / 2 - RADIUS, w: 2 * RADIUS, h: 2 * RADIUS }));
        if (!clear(buildings, own)) return null;
        const allowed = (r, zone) => {
            if(shape.pair){
                if(!overlaps(r,own[zone===2?1:0]) || zone===1&&!overlaps(r,own[1])
                    || zone!==1&&overlaps(r,own[zone===0?1:0]))return false;
            }else if(!overlaps(r,own[0]))return false;
            return !inOtherSquare(r,i);
        };
        const costOf = rects => shape.plots.reduce((sum, p, j) => sum + p.weight * distanceToStorage(rects[j].x + p.w / 2, rects[j].y + p.h / 2), 0)
            + (hasWorkerRoutes ? workerPlacementCost(shape.plots, rects, activeWorkerHubs) : 0);
        let plots = null;
        const slots = [];
        for(let j=0;j<shape.plots.length;j++){
            const p=shape.plots[j],r={x:shape.planned[j].x+x,y:shape.planned[j].y+y,w:p.w,h:p.h};
            if(!free(r,i)||buildings.some(b=>overlaps(r,b)))break;
            slots.push(r);
        }
        if (slots.length===shape.plots.length) {
            plots = assignSlots(shape.plots, slots, distanceToStorage);
            if (!plots.every((r, j) => allowed(r, shape.plots[j].zone))) plots = null;
        }
        // Packing afresh is only tried where the plan's arrangement fits: in crowded ground it
        // mostly fails, and failing is the slow part.
        if (pack && plots) {
            const packed = packPlots(shape.plots, own, allowed, r => free(r, i), buildings, distanceToStorage);
            if (packed && costOf(packed) < costOf(plots) - EPSILON) plots = packed;
        }
        if (!plots) return null;
        return { cost: costOf(plots), x, y, shape, rects: [...buildings, ...plots], squares: own, sensitive: plots };
    };

    const placeCluster = i => {
        let best = null;
        // Whether buildings standing here are clear, with their squares clear of every other
        // building's square and every crop that must stay uncovered. A lone building stands in
        // the same place in every orientation, so each place is worked out once.
        const known = new Map();
        const clear = (buildings, own) => {
            const key = buildings.map(b => `${b.x},${b.y},${b.w}`).join('|');
            if (!known.has(key)) {
                known.set(key, buildings.every(r => free(r, i))
                    && ![...squares].some(([k, list]) => k !== i && list.some(s => own.some(o => overlaps(o, s))))
                    && ![...sensitive].some(([k, list]) => k !== i && list.some(r => own.some(o => overlaps(o, r)))));
            }
            return known.get(key);
        };
        for (const shape of shapes[i]) {
            let fits = 0;
            for (const [ox, oy] of clusterOffsets) {
                if (fits >= CLUSTER_TRIES) break;
                const pack = fits < CLUSTER_PACKS && shape.plots.length <= CLUSTER_PACK_MOST;
                const spot = tryCluster(i, shape, Math.round(ox - shape.cx), Math.round(oy - shape.cy), pack, clear);
                if (!spot) continue;
                fits++;
                if (!best || spot.cost < best.cost - EPSILON) best = spot;
            }
        }
        return best;
    };

    const refreshWorkerHubs = i => {
        if (hasWorkerRoutes) {
            const others = [...placedRects].filter(([key]) => typeof key === 'number' && key !== i)
                .flatMap(([key, rects]) => rects.map((r, j) => ({ ...membersOf(pieces[key])[j], ...r })));
            activeWorkerHubs = workerHubs(others);
        }
    };
    const place = i => {
        refreshWorkerHubs(i);
        return pieces[i].cluster ? placeCluster(i) : placeRigid(i);
    };
    const positionCost = spot => {
        const metadata = spot.shape.members || [...spot.shape.buildings, ...spot.shape.plots];
        return metadata.reduce((sum, m, j) => sum + (m.weight || 0)
            * distanceToStorage(spot.rects[j].x + spot.rects[j].w / 2, spot.rects[j].y + spot.rects[j].h / 2), 0)
            + (hasWorkerRoutes ? workerPlacementCost(metadata, spot.rects, activeWorkerHubs) : 0)
            + (spot.shape.members ? EPSILON * distanceToStorage(spot.shape.cx + spot.x, spot.shape.cy + spot.y) : 0);
    };
    const placed = new Map();
    const unplaced = [];
    // Continue improving an existing valid layout after storage moves. Starting over can lose
    // useful holes and leave busy buildings stranded behind the first greedy placements.
    if (options.initialLayout) pieces.forEach((piece, i) => {
        const rects = options.initialLayout.pieces[i]?.members;
        if (!rects?.length) return;
        for (const shape of shapes[i]) {
            const source = shape.members || [...shape.buildings, ...shape.plots];
            if (source.length !== rects.length) continue;
            const x = rects[0].x - source[0].x, y = rects[0].y - source[0].y;
            // Cluster plots may have been reassigned or packed; only their buildings are rigid.
            const rigid = piece.cluster ? shape.buildings : source;
            if (!rigid.every((m, j) => Math.abs(m.x + x - rects[j].x) < EPSILON
                && Math.abs(m.y + y - rects[j].y) < EPSILON
                && m.w === rects[j].w && m.h === rects[j].h)) continue;
            const spot = { x, y, shape, rects, sensitive: piece.cluster
                ? rects.slice(shape.buildings.length) : rects.filter((r, j) => source[j].sensitive) };
            if (piece.cluster) spot.squares = shape.buildings.map(b => ({
                x: b.x + x + b.w / 2 - RADIUS, y: b.y + y + b.h / 2 - RADIUS, w: 2 * RADIUS, h: 2 * RADIUS,
            }));
            spot.cost = positionCost(spot);
            placed.set(i, spot);
            occupy(i, spot);
            break;
        }
    });
    // Nothing moves out while pieces are first put down, so once a piece of some shape finds no
    // room, no later one of that shape will: they're skipped rather than searched for again.
    const noRoom = new Set();
    const shapeOf = i => (pieces[i].cluster ? null : JSON.stringify(pieces[i].members.map(m => [m.x, m.y, m.w, m.h, !!m.sensitive, m.electric_level != null])));
    for (const i of order) {
        if (placed.has(i)) continue;
        const shape = shapeOf(i);
        const spot = shape !== null && noRoom.has(shape) ? null : place(i);
        if (!spot) {
            if (shape !== null) noRoom.add(shape);
            unplaced.push(i);
            continue;
        }
        placed.set(i, spot);
        occupy(i, spot);
    }
    // Lift each piece and put it back where it's cheapest now, until a pass moves nothing.
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (const i of order) {
            if (!placed.has(i)) continue;
            if (options.fixedPieces?.has(i)) continue;
            vacate(i);
            const previous = placed.get(i);
            const spot = place(i);
            // Use precisely the candidate's objective, including compactness for idle units.
            // Also refresh worker hubs: neighboring workplaces may have moved since scoring.
            const oldCost = positionCost(previous);
            if (spot && spot.cost < oldCost - 1e-9) {
                placed.set(i, spot);
                moved = true;
            }
            occupy(i, placed.get(i));
        }
        if (!moved) break;
    }

    // A busy large building cannot enter a better position occupied by several small ones,
    // even when those smaller units would fit where it stood. Try bounded joint moves after
    // the ordinary single-piece search. Every transaction is scored against the complete
    // hauling + worker objective, and rolled back unless all displaced units fit and it wins.
    const completeCost = () => {
        const members = [...placed].flatMap(([i, spot]) => spot.rects.map((r, j) => ({ ...membersOf(pieces[i])[j], ...r })));
        return members.reduce((sum, m) => sum + ((m.weight || 0) + EPSILON)
            * distanceToStorage(m.x + m.w / 2, m.y + m.h / 2), 0) + workerLayoutCost(members);
    };
    let exchangeBudget = options.exchangeBudget ?? 0;
    if (exchangeBudget > 0) {
        let currentCost = completeCost();
        const movable = i => placed.has(i) && !pieces[i].cluster && placed.get(i).rects.length === 1
            && !options.fixedPieces?.has(i);
        const blockersAt = (rectangle, i) => {
            const blockers = new Set();
            for (const cell of spatialCells(rectangle)) for (const other of grid.get(cell) || []) {
                if (other === i || blockers.has(other)) continue;
                if (!placedRects.get(other).some(r => overlaps(r, rectangle))) continue;
                if (!movable(other)) return null;
                blockers.add(other);
                if (blockers.size > 4) return null;
            }
            return [...blockers];
        };
        const candidates = order.filter(i => movable(i) && weightOf(pieces[i]) > 0)
            .sort((a, b) => {
                const priority = i => { const r = placed.get(i).rects[0];
                    return weightOf(pieces[i]) * distanceToStorage(r.x + r.w / 2, r.y + r.h / 2); };
                return priority(b) - priority(a);
            });
        for (const i of candidates) {
            if (exchangeBudget <= 0) break;
            const previous = placed.get(i), r = previous.rects[0];
            const distance = distanceToStorage(r.x + r.w / 2, r.y + r.h / 2);
            const proposals = [], seenGroups = new Map();
            for (const shape of shapes[i]) {
                for (const [ox, oy, away] of offsets) {
                    if (away >= distance - STEP) break;
                    const x = snap(ox - shape.cx), y = snap(oy - shape.cy);
                    const m = shape.members[0], rectangle = { x: m.x + x, y: m.y + y, w: m.w, h: m.h };
                    if (!inside(rectangle) || (m.sensitive && inOtherSquare(rectangle, i))) continue;
                    if (options.canPlace && !options.canPlace(i, shape.members, [rectangle])) continue;
                    const blockers = blockersAt(rectangle, i);
                    if (!blockers?.length) continue;
                    const group = blockers.sort((a, b) => a - b).join(',');
                    // A couple of positions per displaced group avoids spending the budget
                    // on quarter-tile variants of exactly the same exchange.
                    if ((seenGroups.get(group) || 0) >= 2) continue;
                    seenGroups.set(group, (seenGroups.get(group) || 0) + 1);
                    proposals.push({ blockers, spot: { x, y, shape, rects: [rectangle],
                        sensitive: m.sensitive ? [rectangle] : [], cost: 0 }, away });
                }
            }
            proposals.sort((a, b) => a.away - b.away || a.blockers.length - b.blockers.length);
            for (const { spot } of proposals.slice(0, 6)) {
                if (exchangeBudget-- <= 0) break;
                // Previous accepted exchanges can change occupancy while candidate lists
                // are being traversed; derive this transaction from the current grid.
                const currentBlockers = blockersAt(spot.rects[0], i);
                if (!currentBlockers?.length) continue;
                const saved = new Map([i, ...currentBlockers].map(j => [j, placed.get(j)]));
                for (const j of saved.keys()) vacate(j);
                placed.set(i, spot); occupy(i, spot);
                let fits = true;
                for (const j of currentBlockers.sort((a, b) => weightOf(pieces[b]) - weightOf(pieces[a]))) {
                    const replacement = place(j);
                    if (!replacement) { fits = false; break; }
                    placed.set(j, replacement); occupy(j, replacement);
                }
                const cost = fits ? completeCost() : Infinity;
                if (cost < currentCost - EPSILON) {
                    currentCost = cost;
                    for (const j of saved.keys()) {
                        refreshWorkerHubs(j);
                        placed.get(j).cost = positionCost(placed.get(j));
                    }
                    break;
                }
                for (const j of saved.keys()) vacate(j);
                for (const [j, old] of saved) { placed.set(j, old); occupy(j, old); }
            }
        }
    }

    return {
        storage: storages[0] ?? null,
        storages,
        unplaced,
        tried,
        pieces: pieces.map((piece, i) => {
            const spot = placed.get(i);
            if (!spot) return { ...piece, members: [], cost: 0 };
            const source = piece.cluster ? [...piece.buildings, ...piece.plots] : piece.members;
            return {
                ...piece,
                members: spot.rects.map((r, j) => ({ ...source[j], x: r.x, y: r.y, w: r.w, h: r.h })),
                cost: spot.cost,
            };
        }),
    };
}

// Lays the homeland out within its open `cells` (in homeland tiles), trying the Storage Unit at
// the middle of the open area and at the middles of the open plots nearest it, and keeping
// whichever walks least with everything placed. Returns what `layOut` does, moved into the
// homeland's own frame, plus the first storage center for older callers.
// Additional storage locations are chosen up to `storageCount`.
export function layOutHomeland(pieces, cells, storage = { w: 2, h: 2 }, storageCount = 1) {
    if (!cells.length) {
        return { storage: null, storages: [], storageAt: null, pieces: pieces.map(p => ({ ...p, members: [], cost: 0 })), unplaced: pieces.map((_, i) => i), tried: 0 };
    }
    const area = cells.reduce((sum, c) => sum + c.w * c.h, 0);
    const mid = {
        x: cells.reduce((sum, c) => sum + (c.x + c.w / 2) * c.w * c.h, 0) / area,
        y: cells.reduce((sum, c) => sum + (c.y + c.h / 2) * c.w * c.h, 0) / area,
    };
    const byMid = cells
        .map(c => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 }))
        .sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y));
    const candidates = [mid, ...byMid.slice(0, 4)]
        .map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
        .filter((p, i, all) => all.findIndex(q => q.x === p.x && q.y === p.y) === i);
    let best = null;
    let tried = 0;
    for (const at of candidates) {
        const storageRect = { x: at.x - storage.w / 2, y: at.y - storage.h / 2, w: storage.w, h: storage.h };
        if (cells.reduce((sum, c) => sum + overlapArea(storageRect, c), 0) < storage.w * storage.h - EPSILON) continue;
        const relative = cells.map(c => ({ x: c.x - at.x, y: c.y - at.y, w: c.w, h: c.h }));
        const out = layOut(pieces, { storage, cells: relative, ...(storageCount === 0 ? { storages: [] } : {}) });
        tried += out.tried;
        const cost = layoutCost(out);
        const better = !best || out.unplaced.length < best.out.unplaced.length
            || (out.unplaced.length === best.out.unplaced.length && cost < best.cost - EPSILON);
        if (better) best = { out, cost, at };
    }
    if (!best) {
        return { storage: null, storages: [], storageAt: null, pieces: pieces.map(p => ({ ...p, members: [], cost: 0 })), unplaced: pieces.map((_, i) => i), tried };
    }
    const { out, at } = best;
    const move = r => ({ ...r, x: r.x + at.x, y: r.y + at.y });
    let layout = {
        ...out,
        tried,
        storageAt: out.storage ? at : null,
        storage: out.storage ? move(out.storage) : null,
        storages: out.storages.map(move),
        pieces: out.pieces.map(p => ({ ...p, members: p.members.map(move) })),
    };
    if (storageCount > 1) layout = improveStorageLayout(layout, pieces, cells, storage, storageCount);
    return layout;
}

// The nearest storage rectangle to a facility, with a stable choice when distances tie.
export function nearestStorage(member, storages) {
    const x = member.x + member.w / 2;
    const y = member.y + member.h / 2;
    let nearest = null, distance = Infinity;
    for (const s of storages) {
        const dx = x - s.x - s.w / 2, dy = y - s.y - s.h / 2;
        const squared = dx * dx + dy * dy;
        if (squared < distance) { nearest = s; distance = squared; }
    }
    return nearest;
}

// Score complete alternatives consistently; cached piece costs contain local worker-hub
// estimates from different points in the search and must not be added to global worker cost.
export function layoutCost(layout) {
    const members = layout.pieces.flatMap(p => p.members);
    return members.reduce((sum, m) => {
        const store = nearestStorage(m, layout.storages);
        return sum + (store ? ((m.weight || 0) + EPSILON) * Math.hypot(
            m.x + m.w / 2 - store.x - store.w / 2, m.y + m.h / 2 - store.y - store.h / 2) : 0);
    }, 0) + workerLayoutCost(members);
}

// Power routing may move consumers after the hauling layout, freeing better positions.
// Refine against the final infrastructure: poles and generators stay fixed, and consumers
// may move only within connected supply zones. Climate and collision checks still apply.
function suppliedPlacementOptions(layout) {
    const zones = (layout.power?.coverage || []).filter(zone => zone.connected);
    return {
        obstacles: layout.power?.poles,
        canPlace: (i, metadata, rectangles) => metadata.every((member, j) => member.electric_level == null
            || zones.some(zone => Math.min(rectangles[j].x + rectangles[j].w, zone.x + zone.w) - Math.max(rectangles[j].x, zone.x) >= .25 - EPSILON
                && Math.min(rectangles[j].y + rectangles[j].h, zone.y + zone.h) - Math.max(rectangles[j].y, zone.y) >= .25 - EPSILON)),
    };
}

export function refineSuppliedLayout(layout, pieces, cells, {storageTrials = 4} = {}) {
    if (layout.unplaced.length || layout.power?.disconnected) return layout;
    const refined = layOut(pieces, {
        storages: layout.storages, cells, passes: 2, exchangeBudget: 24, initialLayout: layout,
        ...suppliedPlacementOptions(layout),
        fixedPieces: new Set(layout.pieces.flatMap((p, i) => p.members.some(m => m.generator) ? [i] : [])),
    });
    refined.storageAt = layout.storageAt;
    refined.tried += layout.tried;
    const best = refined.unplaced.length || layoutCost(refined) >= layoutCost(layout) - 1e-9 ? layout : refined;
    best.power = layout.power;
    return refineStorageNeighborhood(best,pieces,cells,storageTrials);
}

// Move a storage together with up to four buildings occupying its proposed position.
// Search only a bounded neighborhood; climate clusters and power infrastructure stay
// fixed, and every accepted candidate retains all units and improves the complete cost.
export function refineStorageNeighborhood(layout, pieces, cells, trials = 4) {
    if (!trials || !layout.storages.length || layout.unplaced.length || layout.power?.disconnected) return layout;
    const fixed = i => pieces[i].cluster || layout.pieces[i].members.length !== 1
        || layout.pieces[i].members.some(m=>m.generator);
    const members = layout.pieces.flatMap((piece,i)=>piece.members.map(member=>({...member,piece:i})));
    const haulingCost = stores => members.reduce((sum,m)=>{
        const s=nearestStorage(m,stores);
        return sum+((m.weight||0)+EPSILON)*Math.hypot(m.x+m.w/2-s.x-s.w/2,m.y+m.h/2-s.y-s.h/2);
    },0);
    const baseline = haulingCost(layout.storages), proposals = [];
    layout.storages.forEach((storage,index)=>{
        const seen = new Set(), choices = [];
        const add = (x,y)=>{
            const key=`${x},${y}`;
            if(seen.has(key))return; seen.add(key);
            const candidate={...storage,x,y};
            if(cells.reduce((sum,c)=>sum+overlapArea(candidate,c),0)<candidate.w*candidate.h-EPSILON)return;
            if(layout.storages.some((s,i)=>i!==index&&overlaps(s,candidate))
                || (layout.power?.poles||[]).some(p=>overlaps(p,candidate)))return;
            const blocking=members.filter(m=>overlaps(m,candidate));
            const blockers=[...new Set(blocking.map(m=>m.piece))];
            if(blockers.length>4||blockers.some(fixed))return;
            const stores=layout.storages.map((s,i)=>i===index?candidate:s);
            let estimate=haulingCost(stores);
            // Rank displaced buildings as if they could occupy the old storage position.
            // This estimate selects trials only; the full physical solve decides acceptance.
            for(const member of blocking){
                const atOld={...member,x:storage.x+storage.w/2-member.w/2,y:storage.y+storage.h/2-member.h/2};
                const a=nearestStorage(atOld,stores),b=nearestStorage(member,stores);
                estimate+=(member.weight||0)*(Math.hypot(atOld.x+atOld.w/2-a.x-a.w/2,atOld.y+atOld.h/2-a.y-a.h/2)
                    -Math.hypot(member.x+member.w/2-b.x-b.w/2,member.y+member.h/2-b.y-b.h/2));
            }
            if(estimate<baseline-EPSILON)choices.push({index,candidate,estimate});
        };
        for(let x=Math.round(storage.x)-6;x<=Math.round(storage.x)+6;x++)
            for(let y=Math.round(storage.y)-6;y<=Math.round(storage.y)+6;y++)add(x,y);
        for(const member of members.filter(m=>m.weight>0))add(Math.round(member.x+(member.w-storage.w)/2),Math.round(member.y+(member.h-storage.h)/2));
        choices.sort((a,b)=>a.estimate-b.estimate);
        // Give separate storage neighborhoods a chance before checking small variants.
        choices.slice(0,2).forEach((proposal,rank)=>proposals.push({...proposal,rank}));
    });
    proposals.sort((a,b)=>a.rank-b.rank||a.estimate-b.estimate);
    let best=layout;
    for(const {index,candidate} of proposals.slice(0,trials)){
        if(best.storages.some((s,i)=>i!==index&&overlaps(s,candidate)))continue;
        const blockers=best.pieces.flatMap((p,i)=>p.members.some(m=>overlaps(m,candidate))?[i]:[]);
        if(blockers.length>4||blockers.some(fixed))continue;
        const neighbors=best.pieces.flatMap((p,i)=>!fixed(i)?[{i,weight:p.members[0].weight||0,
            distance:Math.hypot(p.members[0].x-candidate.x,p.members[0].y-candidate.y)}]:[])
            .filter(p=>p.distance<12).sort((a,b)=>b.weight-a.weight).slice(0,3).map(p=>p.i);
        const movable=new Set([...blockers,...neighbors]);
        const initialLayout={...best,pieces:best.pieces.map((p,i)=>blockers.includes(i)?{...p,members:[]}:p)};
        const stores=best.storages.map((s,i)=>i===index?candidate:s);
        const result=layOut(pieces,{storages:stores,cells,initialLayout,passes:1,exchangeBudget:6,
            ...suppliedPlacementOptions(best),fixedPieces:new Set(pieces.flatMap((_,i)=>movable.has(i)?[]:[i]))});
        result.storageAt={x:stores[0].x+stores[0].w/2,y:stores[0].y+stores[0].h/2};
        result.tried+=best.tried; result.power=best.power;
        if(!result.unplaced.length&&layoutCost(result)<layoutCost(best)-EPSILON)best=result;
    }
    return best;
}

// Add useful storage locations, then alternate relocating storage and laying facilities out.
// Each accepted step keeps every placed piece and reduces weighted hauling distance.
function improveStorageLayout(layout, pieces, cells, storage, maximum) {
    const candidates = [];
    const seen = new Set();
    for (const cell of cells) {
        for (let x = Math.ceil(cell.x); x <= cell.x + cell.w - storage.w; x++) {
            for (let y = Math.ceil(cell.y); y <= cell.y + cell.h - storage.h; y++) {
                const key = `${x},${y}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    candidates.push({ x, y, w: storage.w, h: storage.h });
                }
            }
        }
    }
    const membersOf = current => current.pieces.flatMap(piece => piece.members);
    const costOf = (members, stores) => members.reduce((sum, member) => {
        const closest = nearestStorage(member, stores);
        return sum + (member.weight || 0) * (closest ? Math.hypot(
            member.x + member.w / 2 - closest.x - closest.w / 2,
            member.y + member.h / 2 - closest.y - closest.h / 2) : 0);
    }, 0);
    const better = (candidate, current) => candidate.unplaced.length < current.unplaced.length
        || (candidate.unplaced.length === current.unplaced.length
            && layoutCost(candidate) < layoutCost(current) - 1e-9);
    const findSpot = (members, others) => {
        const occupied = [...members, ...others];
        let best = null;
        for (const candidate of candidates) {
            if (occupied.some(rect => overlaps(candidate, rect))) continue;
            const cost = costOf(members, [...others, candidate]);
            if (!best || cost < best.cost - EPSILON) best = { storage: candidate, cost };
        }
        return best;
    };
    for (let pass = 0; pass < 2; pass++) {
        const members = membersOf(layout);
        const stores = [...layout.storages];
        let changed = false;
        while (stores.length < maximum) {
            const spot = findSpot(members, stores);
            if (!spot || spot.cost >= costOf(members, stores) - EPSILON) break;
            stores.push(spot.storage);
            changed = true;
        }
        for (let index = 0; index < stores.length; index++) {
            const others = stores.filter((_, i) => i !== index);
            const spot = findSpot(members, others);
            if (spot && spot.cost < costOf(members, stores) - EPSILON) {
                stores[index] = spot.storage;
                changed = true;
            }
        }
        if (!changed) break;
        const updated = { ...layout, storages: stores, storage: stores[0], storageAt: {
            x: stores[0].x + storage.w / 2, y: stores[0].y + storage.h / 2,
        } };
        const repacked = layOut(pieces, { storage, storages: stores, cells, passes: 3, initialLayout: updated });
        repacked.storageAt = updated.storageAt;
        repacked.tried += layout.tried;
        layout = better(repacked, updated) ? repacked : updated;
    }
    return {
        ...layout,
        pieces: layout.pieces.map(piece => ({ ...piece, cost: costOf(piece.members, layout.storages) })),
    };
}

// Puts `plots` on `slots` (the plan's own arrangement, one slot per plot, each slot sized for the
// plot that had it): within each facility and zone, the busiest crop takes the slot nearest the
// Storage Unit.
function assignSlots(plots, slots, distanceToStorage) {
    const result = new Array(plots.length);
    const groups = new Map();
    plots.forEach((p, j) => {
        const key = `${p.facility}|${p.zone}|${p.w}x${p.h}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(j);
    });
    for (const members of groups.values()) {
        const nearest = members.map(j => slots[j]).sort((a, b) => distanceToStorage(a.x + a.w / 2, a.y + a.h / 2) - distanceToStorage(b.x + b.w / 2, b.y + b.h / 2));
        const busiest = [...members].sort((a, b) => plots[b].weight - plots[a].weight);
        busiest.forEach((j, k) => { result[j] = nearest[k]; });
    }
    return result;
}

// Packs `plots` (busiest first) where `allowed(rect, zone)` and `free(rect)`, each at the spot
// nearest the Storage Unit, around the cluster's squares; null if one doesn't fit.
function packPlots(plots, squares, allowed, free, buildings, distanceToStorage) {
    const minX = Math.min(...squares.map(s => s.x));
    const minY = Math.min(...squares.map(s => s.y));
    const maxX = Math.max(...squares.map(s => s.x + s.w));
    const maxY = Math.max(...squares.map(s => s.y + s.h));
    const result = new Array(plots.length);
    const taken = [...buildings];
    const order = plots.map((p, j) => j).sort((a, b) => plots[b].weight - plots[a].weight);
    // Every spot a plot of each size could take, nearest the Storage Unit first.
    const spots = new Map();
    const spotsFor = (w, h) => {
        const key = `${w}x${h}`;
        if (!spots.has(key)) {
            const list = [];
            for (let x = snap(minX - w + STEP); x <= maxX - STEP + EPSILON; x += STEP) {
                for (let y = snap(minY - h + STEP); y <= maxY - STEP + EPSILON; y += STEP) {
                    list.push({ x, y, w, h, distance: distanceToStorage(x + w / 2, y + h / 2) });
                }
            }
            spots.set(key, list.sort((a, b) => a.distance - b.distance));
        }
        return spots.get(key);
    };
    for (const j of order) {
        const p = plots[j];
        const r = spotsFor(p.w, p.h).find(r => allowed(r, p.zone) && !taken.some(t => overlaps(r, t)) && free(r));
        if (!r) return null;
        result[j] = { x: r.x, y: r.y, w: r.w, h: r.h };
        taken.push(result[j]);
    }
    return result;
}

// A rigid piece turned 0 to 3 quarter turns, each with its members' weighted center, used to
// sweep it outward, and how far its members spread from that center.
function orientations(members) {
    const seen = new Set();
    const out = [];
    for (let turns = 0; turns < 4; turns++) {
        const turned = members.map(m => turn(m, turns));
        const minX = Math.min(...turned.map(m => m.x));
        const minY = Math.min(...turned.map(m => m.y));
        const shifted = turned.map(m => ({ ...m, x: snap(m.x - minX), y: snap(m.y - minY) }));
        const key = shifted.map(m => `${m.x},${m.y},${m.w},${m.h}`).sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const weight = shifted.reduce((sum, m) => sum + m.weight, 0);
        const areaWeight = shifted.reduce((sum, m) => sum + m.w * m.h, 0);
        const by = weight > EPSILON ? (m => m.weight / weight) : (m => (m.w * m.h) / areaWeight);
        const cx = shifted.reduce((sum, m) => sum + by(m) * (m.x + m.w / 2), 0);
        const cy = shifted.reduce((sum, m) => sum + by(m) * (m.y + m.h / 2), 0);
        const spread = Math.max(...shifted.map(m => Math.hypot(m.x + m.w / 2 - cx, m.y + m.h / 2 - cy)));
        out.push({ turns, members: shifted, cx, cy, spread });
    }
    return out;
}

// A cluster turned 0 to 3 quarter turns and mirrored or not, which turns its plan's arrangement
// with it; swept outward by its first building's center.
function clusterOrientations(cluster) {
    const pair = cluster.buildings.length > 1;
    const out = [];
    const mirror = r => ({ ...r, x: -(r.x + r.w) });
    for (let variant = 0; variant < 8; variant++) {
        const turns = variant % 4;
        const flip = variant >= 4 ? mirror : (r => r);
        const buildings = cluster.buildings.map(b => turn(flip(b), turns));
        const planned = cluster.plots.map((p, j) => turn(flip({ ...cluster.planned[j], w: p.w, h: p.h }), turns));
        const minX = Math.min(...buildings.map(b => b.x));
        const minY = Math.min(...buildings.map(b => b.y));
        const shift = r => ({ ...r, x: snap(r.x - minX), y: snap(r.y - minY) });
        const shifted = buildings.map(shift);
        out.push({
            turns,
            pair,
            buildings: shifted,
            plots: cluster.plots,
            planned: planned.map(shift),
            cx: shifted[0].x + shifted[0].w / 2,
            cy: shifted[0].y + shifted[0].h / 2,
        });
    }
    return out;
}

// A rectangle turned `turns` quarter turns about its frame's origin.
function turn(m, turns) {
    let { x, y, w, h } = m;
    for (let t = 0; t < turns; t++) {
        [x, y, w, h] = [-(y + h), x, h, w];
    }
    return { ...m, x, y, w, h };
}

// Points `step` tiles apart across `extent` (`{ x, y, x2, y2 }`), nearest the origin first:
// `[x, y, distance]`.
function latticeByDistance(extent, step, distanceToStorage) {
    const points = [];
    for (let i = Math.floor(extent.x / step); i <= Math.ceil(extent.x2 / step); i++) {
        for (let j = Math.floor(extent.y / step); j <= Math.ceil(extent.y2 / step); j++) {
            const x = i * step;
            const y = j * step;
            points.push([x, y, distanceToStorage(x, y)]);
        }
    }
    return points.sort((a, b) => a[2] - b[2]);
}

function overlapArea(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

const snap = v => Math.round(v / STEP) * STEP;

function overlaps(a, b) {
    return a.x < b.x + b.w - EPSILON && b.x < a.x + a.w - EPSILON && a.y < b.y + b.h - EPSILON && b.y < a.y + a.h - EPSILON;
}

function cellsOf(r,keyOf) {
    const cells = [];
    for (let cx = Math.floor(r.x / CELL); cx <= Math.floor((r.x + r.w - EPSILON) / CELL); cx++) {
        for (let cy = Math.floor(r.y / CELL); cy <= Math.floor((r.y + r.h - EPSILON) / CELL); cy++) {
            cells.push(keyOf(cx,cy));
        }
    }
    return cells;
}
