// An optional physical layout with a Storage Unit and a clear feature in each group.
import { alphabetScore, chainPurposes, compareProductionPlacement, productionDistance, productionGraph,
    productionLinkDistances, refineProductionPlacement } from './production-layout.js?v=income-guard';
import { allocateHauling, haulingWorkload } from './hauling.js?v=hauling-workload';
import { ANIIMO_WALK_SPEED, workerTravelDistances } from './worker-travel.js?v=auto-worker-travel';

const load = new URL(import.meta.url).search;
const placement = import('./layout.js' + load);
const wiring = import('./power-layout.js' + load);
const area = rectangle => rectangle.w * rectangle.h;
const center = rectangle => [rectangle.x + rectangle.w / 2, rectangle.y + rectangle.h / 2];
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const membersOf = piece => piece.cluster ? [...piece.buildings, ...piece.plots] : piece.members;
const pieceArea = piece => membersOf(piece).reduce((sum, rectangle) => sum + area(rectangle), 0);
const rvFacilities = new Set(['Woodworking Bench', 'Chimney Kiln']);
const saleKey = (facility, item) => `${facility}|${item.replace(/^quick_/, '')}`;

function piecePurpose(piece, sales) {
    const members = membersOf(piece);
    if (members.some(member => rvFacilities.has(member.facility))) return 'rv';
    const products = members.flatMap(member => member.weight > 0
        ? (member.jobs?.map(job => job.item) || [member.crop]).filter(Boolean).map(item => saleKey(member.facility, item))
        : []);
    // An environment cluster and a machine with several jobs must each move as one.
    return products.length && products.every(item => sales.has(item)) ? 'sales' : 'support';
}

function assignPurposes(groups, pieces, purposes) {
    const capacity = groups.map(group => group.buildable.reduce((sum, rectangle) => sum + area(rectangle), 0));
    const total = capacity.reduce((sum, value) => sum + value, 0);
    const sold = pieces.reduce((sum, piece, i) => sum + (purposes[i] === 'sales' ? pieceArea(piece) : 0), 0);
    const rv = pieces.reduce((sum, piece, i) => sum + (purposes[i] === 'rv' ? pieceArea(piece) : 0), 0);
    const rest = pieces.reduce((sum, piece, i) => sum + (purposes[i] === 'sales' ? 0 : pieceArea(piece)), 0);
    if (!sold || !rest) return groups.map(() => 'mixed');
    let best = null, bestScore = Infinity;
    // At most eight stores. Try the small set of partitions and balance usable
    // land against both kinds of footprint rather than splitting by building count.
    for (let mask = 1; mask < (1 << groups.length) - 1; mask++) {
        const sales = [], support = [];
        let saleArea = 0;
        for (let i = 0; i < groups.length; i++) {
            if (mask & (1 << i)) { sales.push(i); saleArea += capacity[i]; }
            else support.push(i);
        }
        if (saleArea < sold || total - saleArea < rest) continue;
        const rvGroup = rv ? support.reduce((a, b) => capacity[b] > capacity[a] ? b : a) : -1;
        if (rvGroup !== -1 && capacity[rvGroup] < rv) continue;
        const density = Math.max(sold / saleArea, rest / (total - saleArea));
        const spread = indices => {
            const points = indices.map(i => center(groups[i].bounds));
            return points.reduce((sum, [x, y], i) => sum + points.slice(0, i)
                .reduce((cost, [a, b]) => cost + Math.hypot(x - a, y - b), 0), 0) / Math.max(1, points.length);
        };
        const score = density + (spread(sales) + spread(support)) / 500;
        if (score < bestScore) {
            bestScore = score;
            best = groups.map((_, i) => sales.includes(i) ? 'sales' : i === rvGroup ? 'rv' : 'support');
        }
    }
    return best;
}

// Merge plots only when their union is rectangular. Different aspect preferences
// offer two arrangements while keeping every group inside the open homeland.
function groupLots(cells, count, aspect) {
    const lots = cells.map(({ x, y, w, h }) => ({ x, y, w, h }));
    while (lots.length > count) {
        let best = null;
        for (let i = 0; i < lots.length; i++) for (let j = i + 1; j < lots.length; j++) {
            const a = lots[i], b = lots[j];
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
            const merged = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
            if (area(merged) !== area(a) + area(b)) continue;
            const score = area(merged) * (1 + .2 * Math.abs(Math.log(merged.w / merged.h / aspect)));
            if (!best || score < best.score) best = { i, j, merged, score };
        }
        if (!best) break;
        lots[best.i] = best.merged;
        lots.splice(best.j, 1);
    }
    if (lots.length > count) lots.sort((a, b) => area(b) - area(a));
    return lots.slice(0, count).sort((a, b) => a.y - b.y || a.x - b.x);
}

function around(outer, hole) {
    return [
        { x: outer.x, y: outer.y, w: outer.w, h: hole.y - outer.y },
        { x: outer.x, y: hole.y + hole.h, w: outer.w, h: outer.y + outer.h - hole.y - hole.h },
        { x: outer.x, y: hole.y, w: hole.x - outer.x, h: hole.h },
        { x: hole.x + hole.w, y: hole.y, w: outer.x + outer.w - hole.x - hole.w, h: hole.h },
    ].filter(rectangle => rectangle.w > 0 && rectangle.h > 0);
}

function makeGroup(lot, style, gap) {
    const edge = gap / 2;
    const bounds = { x: lot.x + edge, y: lot.y + edge, w: lot.w - gap, h: lot.h - gap };
    const [x, y] = center(bounds);
    const [w, h] = style === 'courtyards' ? [6, 6] : bounds.w >= bounds.h ? [bounds.w, 4] : [4, bounds.h];
    const feature = { x: x - w / 2, y: y - h / 2, w, h };
    const storage = { x: x - 1, y: y - 1, w: 2, h: 2 };
    if (!contains(bounds, feature) || !contains(feature, storage)) return null;
    return { bounds, storage, feature, buildable: around(bounds, feature), reserved: [...around(lot, bounds), feature] };
}

// Moving buildings preserves income when the existing production plan can still run.
// Use the same workload and route checks as the app so a move cannot trigger a lower-output solve.
function incomeWalking(layout, staffing, recipes) {
    if (!staffing) return [];
    const { movement, limit, minimumWorkers, members, busy, steps, haulingBound, haulingLevel } = staffing;
    const walking = [], occupied = busy?.slice();
    if (movement) {
        const distances = workerTravelDistances(layout.pieces.flatMap(piece => piece.members));
        for (const [member, distance] of distances) {
            const extra = distance - (movement.byMember[member] ?? movement.defaultDistance);
            if (extra <= 1e-6) continue;
            const visits = movement.visits[member];
            if (!(visits > 0) || !members?.[member]) return null;
            const workload = extra * visits / (ANIIMO_WALK_SPEED * 3600);
            occupied[member] += workload;
            if (occupied[member] > members[member].count + 1e-6) return null;
            walking.push([member, workload]);
        }
    }
    if (!Number.isFinite(limit)) return walking;
    const cargo = recipes.map(recipe => ({ name: recipe.item, yieldAmount: recipe.yield, byproductAmount: recipe.byproduct?.[1] }));
    const work = haulingWorkload(layout, steps, haulingBound, cargo);
    if (!members) return minimumWorkers + Math.ceil(work.busyByLevel[haulingLevel] - 1e-6) <= limit ? walking : null;
    if (occupied.reduce((sum, load) => sum + Math.max(0, Math.ceil(load - 1e-6)), 0) > limit) return null;
    return allocateHauling(members, occupied, work, limit).unassigned <= 1e-6 ? walking : null;
}

export const layoutKeepsIncome = (layout, staffing, recipes) => incomeWalking(layout, staffing, recipes) !== null;

export async function groupHomelandLayout(pieces, cells, { style, gap = 2, storageCount, poleLimit, saleProducts = null,
    recipes = [], staffing = null }) {
    if (storageCount < 1 || !cells.length) return null;
    const [{ layOut, layoutTravelCost }, { connectPower, updatePowerConnections }] = await Promise.all([placement, wiring]);
    const requiredArea = pieces.reduce((sum, piece) => sum + pieceArea(piece), 0);
    const sales = saleProducts && new Set(saleProducts.map(([facility, item]) => saleKey(facility, item)));
    const purposes = sales ? pieces.map(piece => piecePurpose(piece, sales)) : null;
    const splitRequested = purposes?.includes('sales') && purposes.some(purpose => purpose !== 'sales');
    const linked = splitRequested && recipes.length ? chainPurposes(purposes, productionGraph(pieces, recipes)) : null;
    const assignments = linked?.some((purpose, i) => purpose !== purposes[i]) ? [purposes, linked] : [purposes];
    const seen = new Set();
    const candidates = [];
    for (const aspect of style === 'courtyards' ? [1, 1.65] : [2, .65]) {
        const lots = groupLots(cells, storageCount, aspect);
        const key = JSON.stringify(lots);
        if (seen.has(key)) continue;
        seen.add(key);
        const groups = lots.map(lot => makeGroup(lot, style, gap)).filter(Boolean);
        const buildable = groups.flatMap(group => group.buildable);
        if (!buildable.length || buildable.reduce((sum, rectangle) => sum + area(rectangle), 0) < requiredArea) continue;
        for (const assignment of assignments) {
            const labels = splitRequested ? assignPurposes(groups, pieces, assignment) : groups.map(() => 'mixed');
            if (!labels) continue;
            const storages = groups.map(group => group.storage);
            const accepts = (label, purpose) => label === 'mixed' || (purpose === 'rv' ? label === 'rv'
                : purpose === 'sales' ? label === 'sales' : label !== 'sales');
            const sameGroup = (purpose, rectangles) => groups.some((group, i) =>
                accepts(labels[i], purpose) && rectangles.every(rectangle => contains(group.bounds, rectangle)));
            const layout = layOut(pieces, { cells: buildable, storages, passes: 2,
                clusterFits: (i, rectangles) => sameGroup(assignment?.[i], rectangles),
                canPlace: (i, _, rectangles) => (!splitRequested && rectangles.length === 1) || sameGroup(assignment?.[i], rectangles) });
            if (layout.unplaced.length) continue;
            // Generators and poles also leave the reserved paths and plazas clear.
            if (splitRequested) layout.pieces.forEach((piece, i) => {
                piece.members.forEach(member => { member.layoutPurpose = assignment[i]; });
            });
            const canRelocate = splitRequested ? (member, rectangle) => member.generator
                || sameGroup(member.layoutPurpose, [rectangle]) : null;
            const powered = connectPower(layout, buildable, poleLimit, true, canRelocate);
            if (powered.power.disconnected) continue;
            const arranged = { ...powered, storageAt: { x: storages[0].x + 1, y: storages[0].y + 1 },
                groups: groups.map(({ bounds, feature, reserved }, i) => ({ bounds, feature, reserved, purpose: labels[i] })), groupGap: gap };
            candidates.push({ arranged, groups, assignment, route: layoutTravelCost(arranged),
                canPlace: (i, rectangle) => sameGroup(assignment?.[i], [rectangle]) });
        }
    }
    if (!candidates.length && splitRequested) {
        const mixed = await groupHomelandLayout(pieces, cells, { style, gap, storageCount, poleLimit, recipes, staffing });
        return mixed && { ...mixed, groupPurposeFallback: true };
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.route - b.route);
    const baseline = candidates.find(candidate => candidate.assignment === purposes) ?? candidates[0];
    if (!recipes.length) return baseline.arranged;
    const keepsIncome = layout => layoutKeepsIncome(layout, staffing, recipes);
    const baselineGraph = productionGraph(baseline.arranged.pieces, recipes);
    const maxChain = productionDistance(baselineGraph);
    // Protect individual links too, so a large gain on one chain cannot scatter another.
    const maxLinks = productionLinkDistances(baselineGraph).map(length => length + Math.max(2, length * .1));
    const baselineOrder = alphabetScore(baseline.groups, baselineGraph);
    let best = baseline.arranged;
    let bestScore = keepsIncome(best) ? { chain: maxChain, order: baselineOrder, route: baseline.route, excess: 0 } : null;
    for (const candidate of candidates) {
        const graph = productionGraph(candidate.arranged.pieces, recipes);
        const result = refineProductionPlacement(candidate.arranged, candidate.groups, graph, layoutTravelCost,
            { maxChain, maxLinks, canPlace: candidate.canPlace, keepsIncome });
        if (result.excess > 1e-6 || result.order.count > baselineOrder.count || !keepsIncome(candidate.arranged)) continue;
        if (!bestScore || compareProductionPlacement(result, bestScore) < 0) {
            best = candidate.arranged;
            bestScore = result;
        }
    }
    if (bestScore && staffing?.movement) best.incomeWalking = incomeWalking(best, staffing, recipes);
    return updatePowerConnections(best);
}
