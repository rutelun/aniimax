import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';
import { powerLinked } from './power-layout.js';

const area = r => r.w * r.h;
const members = p => p.members ?? [...p.buildings, ...p.plots];
const letter = label => label.charAt(0).toUpperCase();
const english = new Intl.Collator('en');
const snap = x => Math.round(x * 4) / 4;
const distance = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const overlaps = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const clearOf = (cell, obstacle) => {
    if (!obstacle) return [cell];
    const left = Math.max(cell.x, obstacle.x), top = Math.max(cell.y, obstacle.y);
    const right = Math.min(cell.x + cell.w, obstacle.x + obstacle.w), bottom = Math.min(cell.y + cell.h, obstacle.y + obstacle.h);
    if (right <= left || bottom <= top) return [cell];
    return [
        { x: cell.x, y: cell.y, w: cell.w, h: top - cell.y },
        { x: cell.x, y: bottom, w: cell.w, h: cell.y + cell.h - bottom },
        { x: cell.x, y: top, w: left - cell.x, h: bottom - top },
        { x: right, y: top, w: cell.x + cell.w - right, h: bottom - top },
    ].filter(r => r.w > 0 && r.h > 0);
};

// Split English initials into disjoint, contiguous ranges before placing anything.
// Trying a whole range at once avoids the local optimum where individual swaps
// cannot move enough buildings to remove a range overlap.
export function productionZones(pieces, groups, graph, purposes, limit = 8) {
    const letters = [...new Set(graph.nodes.filter(n => n.label).map(n => letter(n.label)))].sort();
    if (!groups.length) return [];
    if (!letters.length) return [{ score: 0, owners: pieces.map(() => -1), ranges: groups.map(() => null) }];
    const byPiece = pieces.map(() => []);
    for (const node of graph.nodes) if (node.label) byPiece[node.index].push(letters.indexOf(letter(node.label)));
    const locked = new Set();
    const buckets = letters.map(() => []);
    for (let i = 0; i < pieces.length; i++) if (byPiece[i].length) {
        const start = Math.min(...byPiece[i]), end = Math.max(...byPiece[i]);
        for (let cut = start + 1; cut <= end; cut++) locked.add(cut);
        buckets[start].push(i);
    }
    const footprint = pieces.map(piece => members(piece).reduce((sum, r) => sum + area(r), 0));
    const capacity = groups.map(group => group.buildable.reduce((sum, r) => sum + area(r), 0));
    const links = graph.links.filter(({ from, to }) => from.index !== to.index);
    const weight = links.reduce((sum, link) => sum + link.weight, 0) || 1;
    const edges = buckets.map(() => new Map());
    for (const { from, to, weight: rate } of links) {
        const a = Math.min(...byPiece[from.index]), b = Math.min(...byPiece[to.index]);
        if (a === b || !Number.isFinite(a + b)) continue;
        const later = edges[Math.max(a, b)], earlier = Math.min(a, b);
        later.set(earlier, (later.get(earlier) || 0) + rate / weight);
    }
    const distances = groups.map(a => groups.map(b => distance(a.storage, b.storage)));
    const fits = groups.map(group => pieces.map(piece => members(piece).every(r =>
        (r.w <= group.bounds.w && r.h <= group.bounds.h) || (r.h <= group.bounds.w && r.w <= group.bounds.h))));
    const processorCount = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
    const targetCount = Math.min(groups.length, letters.length, Math.ceil(processorCount / 6));
    const frontier = letters.map(() => []);
    frontier.push([]);
    frontier[0].push({ used: 0, owners: [], spans: [], score: 0, rv: -1 });
    for (let start = 0; start < letters.length; start++) {
        if (locked.has(start)) continue;
        const states = frontier[start].sort((a, b) => a.score - b.score).slice(0, 96);
        const segment = [];
        let size = 0, saleArea = 0, otherArea = 0, rvArea = 0;
        for (let end = start + 1; end <= letters.length; end++) {
            for (const i of buckets[end - 1]) {
                segment.push(i);
                size += footprint[i];
                if (purposes?.[i] === 'sales') saleArea += footprint[i];
                else otherArea += footprint[i];
                if (purposes?.[i] === 'rv') rvArea += footprint[i];
            }
            if (locked.has(end) || !segment.length) continue;
            for (let zone = 0; zone < groups.length; zone++) {
                if (size > capacity[zone] || !segment.every(i => fits[zone][i])) continue;
                const fill = size / capacity[zone];
                const mixed = purposes ? Math.min(saleArea, otherArea) / Math.max(1, size) : 0;
                const local = fill ** 2 * 15 + mixed * 7;
                for (const state of states) {
                    if (state.used & (1 << zone)) continue;
                    let score = state.score + local;
                    if (rvArea && state.rv >= 0) score += 4 + distances[zone][state.rv] * .12;
                    for (let j = start; j < end; j++) for (const [i, rate] of edges[j]) {
                        if (i < start) score += rate * (8 + distances[zone][state.owners[i]]);
                    }
                    const spans = [...state.spans, [start, end, zone]];
                    if (end === letters.length) score += 3 * Math.abs(targetCount - spans.length);
                    frontier[end].push({ used: state.used | (1 << zone), owners: [...state.owners, ...Array(end - start).fill(zone)],
                        spans, score, rv: state.rv >= 0 ? state.rv : rvArea ? zone : -1 });
                }
            }
        }
    }
    const best = frontier[letters.length].sort((a, b) => a.score - b.score);
    // Keep alternative cuts as well as alternative positions for the best cut.
    const chosen = [], skipped = [], byCut = new Map();
    for (const state of best) {
        const cut = state.spans.map(([, end]) => end).join(',');
        const tried = byCut.get(cut) || 0;
        if (tried < 2) {
            chosen.push(state);
            byCut.set(cut, tried + 1);
            if (chosen.length === limit) break;
        } else if (skipped.length < limit) skipped.push(state);
    }
    return [...chosen, ...skipped].slice(0, limit).map(state => ({
        score: state.score,
        owners: byPiece.map(indices => indices.length ? state.owners[indices[0]] : -1),
        ranges: groups.map((_, i) => {
            const span = state.spans.find(([, , zone]) => zone === i);
            return span ? [letters[span[0]], letters[span[1] - 1]] : null;
        }),
    }));
}

const materialThemes = new Map([['Farmland', 'fields'], ['Woodland', 'woodland'], ['Mine', 'mining'], ['Well', 'water']]);
export const rawTheme = member => materialThemes.get(member.facility)
    ?? (FACILITY_CATEGORY_BY_NAME.get(member.facility) === 'Aniimo Materials' ? 'aniimo' : null);

// Keep each resource family together. The recipes only break ties between
// suitable districts; the identity of a consumer never splits a raw family.
export function rawZones(pieces, groups, owners, workshops, graph) {
    const themes = new Map(), capacity = groups.map(group => group.buildable.reduce((sum, r) => sum + area(r), 0));
    const workshopsIn = groups.map((_, i) => owners.includes(i));
    const names = pieces.map((piece, i) => {
        const footprint = members(piece).reduce((sum, r) => sum + area(r), 0);
        if (owners[i] >= 0) {
            if (!workshops[owners[i]]) capacity[owners[i]] -= footprint;
            return null;
        }
        const counts = new Map();
        for (const r of members(piece)) {
            const name = rawTheme(r);
            if (name) counts.set(name, (counts.get(name) || 0) + area(r));
        }
        const theme = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (theme) themes.set(theme, (themes.get(theme) || 0) + footprint);
        return theme;
    });
    for (let i = 0; i < groups.length; i++) if (workshops[i]) capacity[i] -= area(workshops[i]);
    const mines = pieces.flatMap((piece, i) => names[i] === 'mining' && members(piece).length === 1 ? [members(piece)[0]] : []);
    const mineCapacity = groups.map((group, i) => mines.length ? group.buildable.flatMap(cell => clearOf(cell, workshops[i]))
        .reduce((sum, cell) => sum + Math.floor(cell.w / mines[0].w) * Math.floor(cell.h / mines[0].h), 0) : 0);
    const demand = new Map();
    for (const { from, to, weight } of graph.supplyLinks) {
        const name = names[from.index], target = owners[to.index];
        if (!name || target < 0) continue;
        if (!demand.has(name)) demand.set(name, new Map());
        const shares = demand.get(name);
        shares.set(target, (shares.get(target) || 0) + weight);
    }
    let states = [{ score: 0, used: groups.map(() => 0), homes: [] }];
    const families = [...themes].sort((a, b) => b[1] - a[1]);
    for (const [name, footprint] of families) {
        const to = [...(demand.get(name) || [])], total = to.reduce((sum, [, weight]) => sum + weight, 0) || 1;
        const next = [];
        for (const state of states) for (let zone = 0; zone < groups.length; zone++) {
            const fill = (state.used[zone] + footprint) / Math.max(1, capacity[zone]);
            const proximity = to.reduce((sum, [i, weight]) => sum + distance(groups[zone].storage, groups[i].storage) * weight / total, 0);
            const cost = (workshopsIn[zone] ? 8 : 0) + (state.used[zone] > 0 ? 5 : 0) + 5 * fill ** 2
                + (name === 'mining' ? 30 * Math.max(0, mines.length - mineCapacity[zone]) : 0)
                + 80 * Math.max(0, fill - 1) + proximity * .045;
            const used = state.used.slice();
            used[zone] += footprint;
            next.push({ score: state.score + cost, used, homes: [...state.homes, zone] });
        }
        states = next.sort((a, b) => a.score - b.score).slice(0, 36);
    }
    const best = states[0], homes = new Map(families.map(([name], i) => [name, best.homes[i]]));
    const fits = best.used.every((used, i) => used <= Math.max(0, capacity[i]));
    const anchors = new Map();
    for (let zone = 0; zone < groups.length; zone++) {
        const local = families.filter(([name]) => homes.get(name) === zone);
        const { bounds, storage } = groups[zone];
        const horizontal = bounds.w >= bounds.h;
        local.forEach(([name], index) => {
            const fraction = (index + .5) / local.length;
            const x = local.length === 1 || !horizontal ? storage.x + 1 : bounds.x + fraction * bounds.w;
            const y = local.length === 1 || horizontal ? storage.y + 1 : bounds.y + fraction * bounds.h;
            anchors.set(name, { x, y });
        });
    }
    return { names, homes: names.map(name => homes.get(name) ?? -1), targets: names.map(name => anchors.get(name) ?? null),
        fits, miningFits: mines.length > 1 && mineCapacity[homes.get('mining')] >= mines.length };
}

export function miningRows(pieces, groups, raw, workshops) {
    if (!raw.miningFits) return [];
    const indices = raw.names.flatMap((name, i) => name === 'mining' && members(pieces[i]).length === 1 ? [i] : []);
    const zone = raw.homes[indices[0]], group = groups[zone], { storage } = group;
    indices.sort((a, b) => Number(members(pieces[b])[0].electric_level != null) - Number(members(pieces[a])[0].electric_level != null));
    const { w, h } = members(pieces[indices[0]])[0];
    if (indices.some(i => members(pieces[i])[0].w !== w || members(pieces[i])[0].h !== h)) return [];
    const cells = group.buildable.flatMap(cell => clearOf(cell, workshops[zone]));
    const electric = indices.filter(i => members(pieces[i])[0].electric_level != null).length;
    const generatorSpots = [];
    if (electric) for (const cell of cells) {
        for (let y = cell.y; y + 2 <= cell.y + cell.h; y += .5) for (let x = cell.x; x + 2 <= cell.x + cell.w; x += .5) {
            generatorSpots.push({ x, y, w: 2, h: 2, generator: true });
        }
    }
    let best = null;
    for (const [dx, dy] of electric ? [[2, .5], [2, 0], [.5, 2], [0, 2], [.5, .5], [0, 0]] : [[.5, .5], [0, 0]]) {
        const boxes = cells.map(cell => {
            const columns = Math.floor((cell.w + dx) / (w + dx)), rows = Math.floor((cell.h + dy) / (h + dy));
            const cols = Math.min(columns, indices.length), lines = Math.min(rows, Math.ceil(indices.length / Math.max(1, cols)));
            const width = cols * (w + dx) - dx, height = lines * (h + dy) - dy;
            const x = snap(Math.max(cell.x, Math.min(cell.x + cell.w - width, storage.x + 1 - width / 2)));
            const y = snap(Math.max(cell.y, Math.min(cell.y + cell.h - height, storage.y + 1 - height / 2)));
            return Array.from({ length: cols * lines }, (_, i) => ({
                x: x + i % cols * (w + dx), y: y + Math.floor(i / cols) * (h + dy), w, h,
            }));
        });
        const pools = [...boxes, boxes.flat()];
        for (const pool of pools) {
            if (pool.length < indices.length) continue;
            const spots = pool.slice().sort((a, b) => distance(a, storage) - distance(b, storage)).slice(0, indices.length);
            let connected = 0;
            for (const generator of generatorSpots) {
                if (spots.some(spot => overlaps(spot, generator))) continue;
                let count = 0;
                for (let i = 0; i < electric; i++) if (powerLinked(generator, spots[i])) count++;
                connected = Math.max(connected, count);
                if (connected === electric) break;
            }
            const cost = spots.reduce((sum, spot, i) => sum + distance(spot, storage)
                + spots.slice(0, i).reduce((subtotal, previous) => subtotal + distance(previous, spot) / indices.length, 0), 0)
                + (electric - connected) * 8;
            if (!best || cost < best.cost - 1e-6) best = { spots, cost };
        }
    }
    return best ? best.spots.map((spot, i) => [indices[i], spot]) : [];
}

// In a clear part of each block, try a compact row layout before letting the
// general packer fill the remaining area with suppliers and support facilities.
export function productionRows(pieces, groups, { owners }, graph) {
    const names = new Map(graph.nodes.filter(node => node.label).map(node => [node.index, node.label]));
    const layout = { pieces: [] }, fixedPieces = new Set(), workshops = groups.map(() => null);
    const processors = groups.map((_, i) => owners.flatMap((owner, j) => owner === i ? [j] : []));
    for (let i = 0; i < processors.length; i++) {
        const indices = processors[i];
        if (!indices.length) continue;
        if (indices.some(j => pieces[j].cluster || members(pieces[j]).length !== 1 || members(pieces[j])[0].sensitive)) continue;
        indices.sort((a, b) => english.compare(names.get(a), names.get(b)));
        const sum = indices.reduce((total, j) => total + area(members(pieces[j])[0]), 0);
        const group = groups[i], storage = group.storage;
        let best = null;
        for (const cell of group.buildable) {
            const widths = [...new Set([cell.w, Math.min(cell.w, Math.ceil(Math.sqrt(sum) * 1.35)),
                Math.min(cell.w, Math.ceil(Math.sqrt(sum) * 1.8))])];
            for (const width of widths) {
                const rows = [];
                for (const j of indices) {
                    const r = members(pieces[j])[0];
                    if (r.w > width || r.h > cell.h) { rows.length = 0; break; }
                    let row = rows.at(-1);
                    if (!row || row.w + r.w + .5 > width) {
                        row = { w: 0, h: 0, pieces: [] };
                        rows.push(row);
                    }
                    const x = row.w ? row.w + .5 : 0;
                    row.pieces.push({ index: j, x, w: r.w, h: r.h });
                    row.w = x + r.w;
                    row.h = Math.max(row.h, r.h);
                }
                if (!rows.length) continue;
                rows[0].y = 0;
                for (let r = 1; r < rows.length; r++) {
                    const previous = rows[r - 1], row = rows[r];
                    row.y = previous.y + Math.max(previous.h + .5, 4 + (previous.h - row.h) / 2);
                }
                const last = rows.at(-1), height = last.y + last.h;
                if (height > cell.h) continue;
                const usedWidth = Math.max(...rows.map(row => row.w));
                const left = snap(Math.max(cell.x, Math.min(cell.x + cell.w - usedWidth, storage.x + 1 - usedWidth / 2)));
                const top = snap(Math.max(cell.y, Math.min(cell.y + cell.h - height, storage.y + 1 - height / 2)));
                const packed = rows.flatMap(row => row.pieces.map(({ index, x, w, h }) => [index,
                    { x: left + x, y: snap(top + row.y + (row.h - h) / 2), w, h }]));
                const score = packed.reduce((total, [, r]) => total + distance(r, storage), 0) / indices.length
                    + .18 * (usedWidth + height);
                if (!best || score < best.score) best = { packed, score, bounds: { x: left, y: top, w: usedWidth, h: height } };
            }
        }
        if (!best) continue;
        workshops[i] = best.bounds;
        for (const [index, r] of best.packed) {
            layout.pieces[index] = { members: [r] };
            fixedPieces.add(index);
        }
    }
    return { initialLayout: layout, fixedPieces, workshops };
}

export function rawZoneSpread(layout, groups) {
    const themes = new Map();
    for (const piece of layout.pieces) for (const member of piece.members) {
        const name = rawTheme(member);
        if (!name) continue;
        if (!themes.has(name)) themes.set(name, []);
        themes.get(name).push(member);
    }
    let score = 0;
    for (const buildings of themes.values()) {
        if (buildings.length < 2) continue;
        const blocks = new Set(buildings.map(r => groups.findIndex(({ bounds }) =>
            r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h)));
        const point = { x: buildings.reduce((sum, r) => sum + r.x + r.w / 2, 0) / buildings.length,
            y: buildings.reduce((sum, r) => sum + r.y + r.h / 2, 0) / buildings.length, w: 0, h: 0 };
        score += buildings.reduce((sum, r) => sum + distance(r, point), 0) / buildings.length + 2 * (blocks.size - 1);
    }
    return score / Math.max(1, themes.size);
}

export function zoneLinkDistance({ links, supplyLinks }) {
    const mean = edges => {
        const total = edges.reduce((sum, e) => sum + e.weight, 0);
        return total ? edges.reduce((sum, e) => sum + e.weight * distance(e.from.rect, e.to.rect), 0) / total : 0;
    };
    return mean(links) + .45 * mean(supplyLinks);
}

