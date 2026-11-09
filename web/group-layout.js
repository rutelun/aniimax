// An optional physical layout with a Storage Unit and a clear feature in each group.
import { alphabetScore, chainPurposes, productionDistance, productionGraph,
    productionLinkDistances, refineProductionPlacement } from './production-layout.js?v=zone-ranges';
import { miningRows, productionRows, productionZones, rawTheme, rawZones, rawZoneSpread, zoneLinkDistance } from './production-zones.js?v=workshop-blocks';
import { allocateHauling, haulingWorkload } from './hauling.js?v=facility-stock';
import { ANIIMO_WALK_SPEED, workerTravelDistances } from './worker-travel.js?v=auto-worker-travel';
import { canMoveDistrictStorage, districtStorageIndices, improveDistrictStorage } from './district-storage.js?v=workshop-blocks';

const load = new URL(import.meta.url).search;
const placement = import('./layout.js' + load);
const wiring = import('./power-layout.js' + load);
const area = rectangle => rectangle.w * rectangle.h;
const center = rectangle => [rectangle.x + rectangle.w / 2, rectangle.y + rectangle.h / 2];
const halfTile = value => Math.round(value * 2) / 2;
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const overlaps = (a, b) => a && b && a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const membersOf = piece => piece.cluster ? [...piece.buildings, ...piece.plots] : piece.members;
const pieceArea = piece => membersOf(piece).reduce((sum, rectangle) => sum + area(rectangle), 0);
const miningDistricts = (layout, groups) => new Set(layout.pieces.flatMap(piece => piece.members)
    .filter(member => member.facility === 'Mine').map(member => groups.findIndex(group => contains(group.bounds, member)))).size;
const workshopSeparation = workshops => {
    const waiting = workshops.filter(Boolean);
    if (waiting.length < 2) return 0;
    const connected = [waiting.shift()];
    let total = 0;
    while (waiting.length) {
        let next = -1, shortest = Infinity;
        waiting.forEach((b, i) => connected.forEach(a => {
            const gap = Math.hypot(Math.max(0, a.x - b.x - b.w, b.x - a.x - a.w),
                Math.max(0, a.y - b.y - b.h, b.y - a.y - a.h));
            if (gap < shortest) { shortest = gap; next = i; }
        }));
        total += shortest;
        connected.push(waiting.splice(next, 1)[0]);
    }
    return total;
};
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

function makeGroup(lot, style, gap, offset) {
    const edge = gap / 2;
    const bounds = { x: lot.x + edge, y: lot.y + edge, w: lot.w - gap, h: lot.h - gap };
    // A long, shallow lot needs its entrance on the short side. Otherwise a
    // frontage across its full length can leave room for only one row of mines.
    const [w, h] = style === 'districts' ? (bounds.w >= bounds.h * 1.8 ? [3, bounds.h] : [bounds.w, 3])
        : style === 'courtyards' ? [6, 6] : bounds.w >= bounds.h ? [bounds.w, 4] : [4, bounds.h];
    // Leave one larger continuous building area if a plaza in the middle splits
    // the available space too much for a climate cluster or a large facility.
    const x = halfTile(bounds.x + w / 2 + (bounds.w - w) * offset);
    const y = halfTile(bounds.y + h / 2 + (bounds.h - h) * offset);
    const feature = { x: x - w / 2, y: y - h / 2, w, h };
    const storage = { x: x - 1, y: y - 1, w: 2, h: 2 };
    if (!contains(bounds, feature) || !contains(feature, storage)) return null;
    return { bounds, storage, feature, buildable: around(bounds, feature), reserved: [...around(lot, bounds), feature] };
}

// Moving buildings preserves income when the existing production plan can still run.
// Use the same workload and route checks as the app so a move cannot trigger a lower-output solve.
function incomeWalking(layout, staffing, recipes) {
    if (!staffing) return [];
    const { movement, limit, minimumWorkers, members, busy, steps, haulingBound, haulingLevel, facilities } = staffing;
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
    const cargo = recipes.map(recipe => ({ name: recipe.item, facility_level: recipe.facility_level,
        yieldAmount: recipe.yield, byproductAmount: recipe.byproduct?.[1] }));
    const work = haulingWorkload(layout, steps, haulingBound, cargo, facilities);
    if (!members) return minimumWorkers + Math.ceil(work.busyByLevel[haulingLevel] - 1e-6) <= limit ? walking : null;
    if (occupied.reduce((sum, load) => sum + Math.max(0, Math.ceil(load - 1e-6)), 0) > limit) return null;
    return allocateHauling(members, occupied, work, limit).unassigned <= 1e-6 ? walking : null;
}

export const layoutKeepsIncome = (layout, staffing, recipes) => incomeWalking(layout, staffing, recipes) !== null;

function* groupShapes(cells, storageCount, style, gap) {
    const partitions = [], seen = new Set();
    for (const aspect of style === 'avenues' ? [2, .65] : [1, 1.65]) {
        const lots = groupLots(cells, storageCount, aspect);
        const key = JSON.stringify(lots);
        if (seen.has(key)) continue;
        seen.add(key);
        partitions.push(lots);
    }
    const offsets = style === 'districts' ? [0, 1] : style === 'avenues' ? [.5, .125, .875, 0, 1] : [.5, .125, .875];
    for (const offset of offsets) {
        yield partitions.map(lots => lots.map(lot => makeGroup(lot, style, gap, offset)).filter(Boolean));
    }
}

export async function groupHomelandLayout(pieces, cells, { style, gap = 2, storageCount, poleLimit, saleProducts = null,
    recipes = [], staffing = null }) {
    const graph = productionGraph(pieces, recipes, { includeIdle: recipes.length > 0 });
    const useRanges = graph.nodes.some(node => node.label);
    if (storageCount > 0 && cells.length > 0 && (useRanges || graph.nodes.some(node => rawTheme(node.rect)))) {
        for (let actualGap = gap; actualGap >= 1; actualGap--) {
            const arranged = await tryRangeLayout(pieces, cells, { style, gap: actualGap, storageCount, poleLimit,
                saleProducts, recipes, staffing, graph });
            if (arranged) return { ...arranged, groupStyle: style, requestedGroupGap: gap };
        }
        if (useRanges) return null;
    }
    for (let actualGap = gap; actualGap >= 1; actualGap--) {
        const arranged = await tryGroupedLayout(pieces, cells, {
            style, gap: actualGap, storageCount, poleLimit, saleProducts, recipes, staffing,
        });
        if (arranged) return { ...arranged, groupStyle: style, requestedGroupGap: gap };
    }
    return null;
}

async function tryRangeLayout(pieces, cells, { style, gap, storageCount, poleLimit, saleProducts, recipes, staffing, graph }) {
    const [{ layOut, layoutTravelCost, refineStorageNeighborhood, refineDistrictClimate, refineDistrictDeliveries },
        { connectPower, updatePowerConnections }] = await Promise.all([placement, wiring]);
    const requiredArea = pieces.reduce((sum, piece) => sum + pieceArea(piece), 0);
    const sales = saleProducts && new Set(saleProducts.map(([facility, item]) => saleKey(facility, item)));
    const purposes = sales ? chainPurposes(pieces.map(piece => piecePurpose(piece, sales)), graph) : null;
    const candidates = [];
    let variant = 0;
    for (const shapes of groupShapes(cells, storageCount, style, gap)) for (const groups of shapes) {
        const buildable = groups.flatMap(group => group.buildable);
        if (buildable.reduce((sum, r) => sum + area(r), 0) < requiredArea) continue;
        for (const zoning of productionZones(pieces, groups, graph, purposes, 10)) {
            const rows = productionRows(pieces, groups, zoning, graph);
            if (!rows.complete) continue;
            candidates.push({ groups, buildable, zoning, variant, rows,
                rank: zoning.score + .25 * variant });
        }
        variant++;
    }
    candidates.sort((a, b) => a.zoning.workshopCount - b.zoning.workshopCount || a.rank - b.rank);
    // Exhaust the compact options first, but sample several physical shapes.
    const byCount = new Map();
    for (const candidate of candidates) {
        const count = candidate.zoning.workshopCount;
        if (!byCount.has(count)) byCount.set(count, { first: [], more: [], variants: new Set() });
        const { first, more, variants } = byCount.get(count);
        (variants.has(candidate.variant) ? more : first).push(candidate);
        variants.add(candidate.variant);
    }
    const shortlist = [...byCount.values()].flatMap(({ first, more }) =>
        [...first.slice(0, 4), ...more.slice(0, 2), ...first.slice(4)].slice(0, 7)).slice(0, 12);
    const trips = graph.nodes.reduce((sum, node) => sum + (node.rect.weight || 0), 0) || 1;
    const compactness = (layout, placedGraph) => zoneLinkDistance(placedGraph) + layoutTravelCost(layout) / (trips * 2);
    const keepsIncome = layout => layoutKeepsIncome(layout, staffing, recipes);
    let best = null, consolidated = 0;
    for (const { groups, buildable, zoning, rows } of shortlist) {
        if (best?.mineZones <= 1 && zoning.workshopCount > best.zoning.workshopCount) break;
        const storages = groups.map(group => group.storage);
        const belongs = (index, rects) => {
            const owner = zoning.owners[index];
            return owner >= 0 ? rects.every(rect => contains(groups[owner].bounds, rect))
                : rects.length === 1 || groups.some(group => rects.every(rect => contains(group.bounds, rect)));
        };
        const { workshops, ...rowOptions } = rows;
        const raw = rawZones(pieces, groups, zoning.owners, workshops, graph);
        const mining = miningRows(pieces, groups, raw, workshops);
        const modes = [...(raw.fits && raw.homes.some(home => home >= 0) ? ['all'] : []),
            ...(raw.miningFits ? ['mines'] : []), 'flexible'];
        for (const mode of modes) {
            const valid = (i, rects) => {
                if (!belongs(i, rects)) return false;
                const owner = zoning.owners[i];
                if (owner >= 0) return !workshops[owner] || rects.every(rect => contains(workshops[owner], rect));
                const pin = mode === 'all' || mode === 'mines' && raw.names[i] === 'mining';
                return (!pin || raw.homes[i] < 0 || rects.every(rect => contains(groups[raw.homes[i]].bounds, rect)))
                    && rects.every(rect => workshops.every(workshop => !overlaps(workshop, rect)));
            };
            const seed = { initialLayout: { pieces: rowOptions.initialLayout.pieces.slice() },
                fixedPieces: new Set(rowOptions.fixedPieces) };
            if (mode !== 'flexible') for (const [i, spot] of mining) {
                seed.initialLayout.pieces[i] = { members: [spot] };
                seed.fixedPieces.add(i);
            }
            const layout = layOut(pieces, { ...seed, cells: buildable, storages, passes: 1,
                preferredStorages: zoning.owners, preferredTargets: raw.targets,
                placementPriority: pieces.map((piece, i) => piece.cluster ? 3 : zoning.owners[i] >= 0 ? 2 : raw.homes[i] >= 0 ? 1 : 0),
                clusterFits: valid, canPlace: (i, _, rects) => valid(i, rects) });
            if (layout.unplaced.length) continue;
            // The power repacker clones the layout, so the owning piece index
            // must travel with the member to keep its placement restrictions.
            layout.pieces.forEach((piece, i) => piece.members.forEach(member => { member.zonePiece = i; }));
            const wired = connectPower(layout, buildable, poleLimit, true, (member, rectangle) =>
                valid(member.zonePiece, [rectangle]), rectangle => workshops.every(workshop => !overlaps(workshop, rectangle)));
            if (wired.power.disconnected) continue;
            const mineZones = miningDistricts(wired, groups);
            if (best && mineZones > best.mineZones) continue;
            const storageZones = groups.map((group, i) => ({ ...group, range: zoning.ranges[i], workshop: workshops[i] }));
            const powered = improveDistrictStorage(wired, storageZones, keepsIncome);
            if (!keepsIncome(powered)) continue;
            const placedGraph = productionGraph(powered.pieces, recipes, { includeIdle: true });
            const score = compactness(powered, placedGraph) + .15 * zoning.score + .45 * workshopSeparation(workshops)
                + .18 * alphabetScore(groups, placedGraph).count + 1.5 * rawZoneSpread(powered, groups);
            if (!best || mineZones < best.mineZones || zoning.workshopCount < best.zoning.workshopCount
                || (zoning.workshopCount === best.zoning.workshopCount && score < best.score))
                best = { powered, placedGraph, groups, zoning, belongs, score, workshops, mineZones, storageZones };
            if (mineZones <= 1) {
                consolidated++;
                break;
            }
        }
        if (consolidated === 2) break;
    }
    if (!best) return null;
    const { powered, placedGraph, groups, zoning, belongs, workshops, storageZones } = best;
    const maxChain = productionDistance(placedGraph);
    const maxLinks = productionLinkDistances(placedGraph).map(length => length + Math.max(1, length * .07));
    const costBefore = compactness(powered, placedGraph);
    refineProductionPlacement(powered, groups, placedGraph, layoutTravelCost, { maxChain, maxLinks,
        canPlace: (index, rectangle) => belongs(index, [rectangle])
            && (!workshops[zoning.owners[index]] || contains(workshops[zoning.owners[index]], rectangle)),
        keepsIncome: layout => compactness(layout, placedGraph) <= costBefore + .35 && layoutKeepsIncome(layout, staffing, recipes) });
    const placedBeforeStorage = improveDistrictStorage(powered, storageZones, keepsIncome);
    const order = alphabetScore(groups, placedGraph).count;
    const links = productionLinkDistances(placedGraph);
    const chainBeforeStorage = productionDistance(placedGraph);
    const districtForPiece = placedBeforeStorage.pieces.map(piece => groups.findIndex(({ bounds }) =>
        piece.members.every(member => contains(bounds, member))));
    const buildable = groups.flatMap(group => group.buildable);
    const canPlace = (i, _, rects) => {
        const district = districtForPiece[i], owner = zoning.owners[i];
        return district >= 0 && rects.every(rect => contains(groups[district].bounds, rect)
            && (owner >= 0 ? !workshops[owner] || contains(workshops[owner], rect)
                : workshops.every(workshop => !overlaps(workshop, rect))));
    };
    const accept = layout => {
        const graph = productionGraph(layout.pieces, recipes, { includeIdle: true });
        return alphabetScore(groups, graph).count <= order
            && productionDistance(graph) <= chainBeforeStorage + 1e-6
            && productionLinkDistances(graph).every((length, i) => length <= links[i] + Math.max(1, links[i] * .07))
            && keepsIncome(layout);
    };
    const placedStorage = refineStorageNeighborhood(placedBeforeStorage, pieces, buildable, 4, {
        storageCells: groups.map(group => group.bounds),
        canMoveStorage: (layout, index, trial) => canMoveDistrictStorage(layout, index, trial, storageZones),
        canPlace, cost: layoutTravelCost, accept,
    });
    const repackedClimate = refineDistrictClimate(placedStorage, pieces, buildable, { canPlace, accept });
    const finalLayout = refineDistrictDeliveries(repackedClimate, groups, { canPlace, accept });
    const assignedStores = districtStorageIndices(finalLayout.storages, groups);
    const placed = finalLayout.pieces.flatMap(piece => piece.members);
    const labels = groups.map(({ bounds }, group) => {
        const indexes = zoning.owners.flatMap((owner, i) => owner === group ? [i] : []);
        const rv = indexes.some(i => membersOf(pieces[i]).some(member => rvFacilities.has(member.facility)));
        const sold = indexes.some(i => purposes?.[i] === 'sales');
        const mixed = sold && indexes.some(i => purposes[i] !== 'sales');
        const areas = new Map();
        for (const member of placed) {
            const theme = rawTheme(member);
            if (theme && contains(bounds, member)) areas.set(theme, (areas.get(theme) || 0) + area(member));
        }
        const themes = [...areas].sort((a, b) => b[1] - a[1]).map(([theme]) => theme);
        return { purpose: rv ? 'rv' : mixed ? 'mixed' : sold ? 'sales' : indexes.length && !sales ? 'mixed' : 'support', mixed, themes };
    });
    const arranged = { ...finalLayout,
        groupGap: gap, rangeMixedPurposes: labels.some(label => label.mixed),
        groups: groups.map(({ bounds, feature, reserved }, i) => ({
            bounds, feature, reserved, purpose: labels[i].purpose, range: zoning.ranges[i],
            workshop: workshops[i], themes: labels[i].themes, storageIndices: assignedStores[i],
        })) };
    if (staffing?.movement) arranged.incomeWalking = incomeWalking(arranged, staffing, recipes);
    return updatePowerConnections(arranged);
}

async function tryGroupedLayout(pieces, cells, { style, gap, storageCount, poleLimit, saleProducts,
    recipes = [], staffing = null }) {
    if (storageCount < 1 || !cells.length) return null;
    const [{ layOut, layoutTravelCost }, { connectPower, updatePowerConnections }] = await Promise.all([placement, wiring]);
    const requiredArea = pieces.reduce((sum, piece) => sum + pieceArea(piece), 0);
    const sales = saleProducts && new Set(saleProducts.map(([facility, item]) => saleKey(facility, item)));
    const purposes = sales ? pieces.map(piece => piecePurpose(piece, sales)) : null;
    const splitRequested = purposes?.includes('sales') && purposes.some(purpose => purpose !== 'sales');
    const candidates = [];
    const tryPartition = groups => {
        const buildable = groups.flatMap(group => group.buildable);
        if (!buildable.length || buildable.reduce((sum, rectangle) => sum + area(rectangle), 0) < requiredArea) return;
        const labels = splitRequested ? assignPurposes(groups, pieces, purposes) : groups.map(() => 'mixed');
        if (!labels) return;
        const storages = groups.map(group => group.storage);
        const accepts = (label, purpose) => label === 'mixed' || (purpose === 'rv' ? label === 'rv'
            : purpose === 'sales' ? label === 'sales' : label !== 'sales');
        const sameGroup = (purpose, rectangles) => groups.some((group, i) =>
            accepts(labels[i], purpose) && rectangles.every(rectangle => contains(group.bounds, rectangle)));
        const layout = layOut(pieces, { cells: buildable, storages, passes: 2,
            clusterFits: (i, rectangles) => sameGroup(purposes?.[i], rectangles),
            canPlace: splitRequested ? (i, _, rectangles) => sameGroup(purposes[i], rectangles) : undefined });
        if (layout.unplaced.length) return;
        if (splitRequested) layout.pieces.forEach((piece, i) => {
            piece.members.forEach(member => { member.layoutPurpose = purposes[i]; });
        });
        const canRelocate = splitRequested ? (member, rectangle) => member.generator
            || sameGroup(member.layoutPurpose, [rectangle]) : null;
        const powered = connectPower(layout, buildable, poleLimit, true, canRelocate);
        if (powered.power.disconnected) return;
        const moved = improveDistrictStorage(powered, groups, layout => layoutKeepsIncome(layout, staffing, recipes));
        const assignedStores = districtStorageIndices(moved.storages, groups);
        const arranged = { ...moved, groups: groups.map(({ bounds, feature, reserved }, i) => ({
            bounds, feature, reserved, purpose: labels[i], storageIndices: assignedStores[i],
        })), groupGap: gap };
        candidates.push({ arranged, route: layoutTravelCost(arranged) });
    };
    for (const shapes of groupShapes(cells, storageCount, style, gap)) {
        for (const groups of shapes) tryPartition(groups);
        if (candidates.length) break;
    }
    if (!candidates.length && splitRequested) {
        const mixed = await tryGroupedLayout(pieces, cells, { style, gap, storageCount, poleLimit, saleProducts: null, recipes, staffing });
        return mixed && { ...mixed, groupPurposeFallback: true };
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.route - b.route);
    for (const { arranged } of candidates) {
        const walking = incomeWalking(arranged, staffing, recipes);
        if (walking === null) continue;
        if (staffing?.movement) arranged.incomeWalking = walking;
        return updatePowerConnections(arranged);
    }
    return updatePowerConnections(candidates[0].arranged);
}
