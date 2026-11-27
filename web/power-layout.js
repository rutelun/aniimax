import {rectangleMask} from './rectangle-mask.js';
// Power coverage is square, centered on the generator/pole. A real 1/4 tile overlap
// connects a building. Only generators and poles relay power; consumers are endpoints. The ranges,
// footprints and conservative overlap follow Aniimo Camp's public Home planner data.
import { createInsideTest } from './layout.js';
import { analyzePowerNetworks } from './power-islands.js';

const EPS = 1e-6;
const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const powerRadius = r => r.generator ? 5.5 : r.pole ? 3.5 : 0;
export function powerCoverage(r) {
    const radius = powerRadius(r);
    if (!radius) return null;
    const c = center(r);
    return { x: c.x - radius, y: c.y - radius, w: 2 * radius, h: 2 * radius };
}
const overlap = (a, b, margin = 0.25) => a && b
    && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= margin - EPS
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= margin - EPS;
function covers(relay, target) {
    const radius = powerRadius(relay);
    if (!radius) return false;
    const x = relay.x + relay.w / 2, y = relay.y + relay.h / 2;
    return Math.min(x + radius, target.x + target.w) - Math.max(x - radius, target.x) >= .25 - EPS
        && Math.min(y + radius, target.y + target.h) - Math.max(y - radius, target.y) >= .25 - EPS;
}
export const powerLinked = (a, b) => covers(a, b) || covers(b, a);
const relaysPower = member => member.generator || member.pole;

function obstacleTest(cells, rectangles) {
    const mask = rectangleMask(cells);
    for (const r of rectangles) mask?.add(r);
    return {
        add(r) { rectangles.push(r); mask?.add(r); },
        blocked(r) { return mask?.overlaps(r) ?? rectangles.some(other => overlap(r, other, EPS * 2)); },
    };
}

function attachTargets(targets, connected, links) {
    const relays = [];
    for (const node of connected) if (relaysPower(node)) relays.push(node);
    let changed;
    do {
        changed = false;
        for (const target of targets) {
            if (connected.has(target)) continue;
            let parent = null;
            for (let i = 0; i < relays.length; i++) {
                if (powerLinked(relays[i], target)) { parent = relays[i]; break; }
            }
            if (!parent) continue;
            links.push({ from: center(parent), to: center(target) });
            connected.add(target);
            if (relaysPower(target)) relays.push(target);
            changed = true;
        }
    } while (changed);
}

// Refresh wiring after consumers move inside existing supply zones. Infrastructure stays put.
export function updatePowerConnections(layout) {
    if(layout.power?.islands)return analyzePowerNetworks(layout);
    const members = layout.pieces.flatMap(p => p.members);
    const generators = members.filter(m => m.generator);
    const consumers = members.filter(m => m.electric_level != null);
    const poles = layout.power?.poles || [];
    const targets = [...generators, ...poles, ...consumers];
    const connected = new Set(generators.slice(0, 1));
    const links = [];
    attachTargets(targets, connected, links);
    for (const m of consumers) m.power_connected = connected.has(m);
    layout.power = { ...layout.power, poles, links, generators: generators.length, consumers: consumers.length,
        disconnected: targets.filter(m => !connected.has(m)).length,
        coverage: [...generators, ...poles].map(m => ({ ...powerCoverage(m), connected: connected.has(m) })),
    };
    return layout;
}

export function connectPower(layout, cells, maximum, repack = true, canRelocate = null, canPlacePole = null, preferCoverage = false, islands = false, inside = null, retryPreferCoverage = false) {
    inside ??= createInsideTest(cells);
    const members = layout.pieces.flatMap(p => p.members);
    const generators = members.filter(m => m.generator);
    const consumers = members.filter(m => m.electric_level != null);
    // Generators do not haul anything. Relocate them into free space near their consumers
    // before routing, rather than leaving them at the edge chosen by the hauling layout.
    for (const generator of islands ? [] : generators) {
        const destinations = [...consumers, ...generators.filter(g => g !== generator)];
        const sumX = destinations.reduce((sum, m) => sum + m.x + m.w / 2, 0);
        const sumY = destinations.reduce((sum, m) => sum + m.y + m.h / 2, 0);
        const obstacles = obstacleTest(cells,[...members.filter(m => m !== generator), ...layout.storages]);
        let best = null;
        for (const cell of destinations.length ? cells : []) {
            for (let y = cell.y; y < cell.y + cell.h; y += 0.5) for (let x = cell.x; x < cell.x + cell.w; x += 0.5) {
                const cx = x + generator.w / 2, cy = y + generator.h / 2;
                const cost = destinations.length * (cx * cx + cy * cy) - 2 * (cx * sumX + cy * sumY);
                // Once a legal position is known, more expensive checks cannot make
                // a higher-cost position win. Preserve the original tie ordering.
                if (best && cost >= best.cost) continue;
                const r = { x, y, w: generator.w, h: generator.h };
                if (canRelocate && !canRelocate(generator, r)) continue;
                if (!inside(r) || obstacles.blocked(r)) continue;
                if (!best || cost < best.cost) best = { x, y, cost };
            }
        }
        if (best) { generator.x = best.x; generator.y = best.y; }
    }
    const targets = [...generators, ...consumers];
    const baseConnected = new Set();
    const baseLinks = [];
    for (const generator of islands ? generators : generators.slice(0, 1)) baseConnected.add(generator);
    attachTargets(targets, baseConnected, baseLinks);
    // Free half-tile locations for poles, never on facilities, storage or locked land.
    const blocked = obstacleTest(cells, [...members, ...layout.storages]);
    const candidates = [];
    const overlapped = cells.some((cell, i) => cells.some((other, j) => j > i
        && cell.x < other.x + other.w && other.x < cell.x + cell.w
        && cell.y < other.y + other.h && other.y < cell.y + cell.h));
    const seen = overlapped ? new Set() : null;
    const rows = new Map();
    const needsRoute = baseConnected.size && maximum > 0 && targets.some(t => !baseConnected.has(t));
    for (const c of needsRoute ? cells : []) for (let y = c.y; y < c.y + c.h; y += 0.5) for (let x = c.x; x < c.x + c.w; x += 0.5) {
        if (seen) {
            const key = `${x},${y}`;
            if (seen.has(key)) continue;
            seen.add(key);
        }
        const r = { x, y, w: 1.5, h: 1.5, pole: true, facility: 'Crackle Power Pole' };
        if (canPlacePole && !canPlacePole(r)) continue;
        if (!inside(r) || blocked.blocked(r)) continue;
        const id = candidates.length;
        let row = rows.get(y);
        if (!row) { row = []; rows.set(y, row); }
        row.push(id);
        candidates.push(r);
    }
    const candCount = candidates.length;
    const cx = new Float64Array(candCount);
    const cy = new Float64Array(candCount);
    let minBx = Infinity, maxBx = -Infinity, minBy = Infinity, maxBy = -Infinity;
    for (let i = 0; i < candCount; i++) {
        const x = candidates[i].x, y = candidates[i].y;
        cx[i] = x; cy[i] = y;
        const bx = Math.floor((x + 0.75) / 4), by = Math.floor((y + 0.75) / 4);
        if (bx < minBx) minBx = bx;
        if (bx > maxBx) maxBx = bx;
        if (by < minBy) minBy = by;
        if (by > maxBy) maxBy = by;
    }
    const bw = candCount ? maxBx - minBx + 1 : 0;
    const bh = candCount ? maxBy - minBy + 1 : 0;
    const bucketCount = bw * bh;
    const baseBuckets = Array.from({ length: bucketCount }, () => []);
    const candBucket = new Int32Array(candCount);
    for (let i = 0; i < candCount; i++) {
        const b = (Math.floor((cy[i] + 0.75) / 4) - minBy) * bw + (Math.floor((cx[i] + 0.75) / 4) - minBx);
        candBucket[i] = b;
        baseBuckets[b].push(i);
    }
    const baseBucketFree = new Int32Array(bucketCount);
    for (let b = 0; b < bucketCount; b++) baseBucketFree[b] = baseBuckets[b].length;

    // Terrain and consumers stay put while this network grows. Query nearby
    // rows once per endpoint and keep the original site order for routing ties.
    const neighbors = new Map();
    const linkedSiteIds = target => {
        let cached = neighbors.get(target);
        if (cached) return cached;
        cached = [];
        const tx = target.x + target.w / 2, ty = target.y + target.h / 2;
        const rad = powerRadius(target);
        const horizontal = Math.max(3.5 + target.w / 2, rad + .75);
        const vertical = Math.max(3.5 + target.h / 2, rad + .75);
        for (const [y, row] of rows) {
            if (Math.abs(y + .75 - ty) > vertical + EPS) continue;
            for (let j = 0; j < row.length; j++) {
                const id = row[j];
                if (Math.abs(cx[id] + .75 - tx) <= horizontal + EPS && powerLinked(candidates[id], target)) cached.push(id);
            }
        }
        neighbors.set(target, cached);
        return cached;
    };
    const occupied = new Uint8Array(candCount);
    const startMark = new Uint32Array(candCount);
    const goalMark = new Uint32Array(candCount);
    const goalScore = new Int32Array(candCount);
    const visitedMark = new Uint32Array(candCount);
    const parents = new Int32Array(candCount);
    const depth = new Int32Array(candCount);
    const queue = new Int32Array(candCount);
    const bucketRem = new Int32Array(bucketCount);
    const goalBucketMark = new Uint32Array(bucketCount);
    let iterStamp = 0, bfsStamp = 0;

    const routeWith = usePreferCoverage => {
        const poles = [];
        const connected = new Set(baseConnected);
        const links = baseLinks.slice();
        const attach = () => attachTargets([...targets, ...poles], connected, links);
        occupied.fill(0);
        for (let b = 0; b < bucketCount; b++) baseBucketFree[b] = baseBuckets[b].length;
        let indexedPoles = 0;
        // BFS finds a route with the fewest extra poles to one of the remaining targets.
        // A static spatial index bounds each expansion to nearby candidates rather than all land.
        while (connected.size && targets.some(t => !connected.has(t)) && poles.length < maximum) {
            for (; indexedPoles < poles.length; indexedPoles++) {
                const pole = poles[indexedPoles];
                const px = pole.x, py = pole.y;
                if (candCount) {
                    const bx0 = Math.max(0, Math.floor((px + 0.75) / 4) - minBx - 1);
                    const bx1 = Math.min(bw - 1, Math.floor((px + 0.75) / 4) - minBx + 1);
                    const by0 = Math.max(0, Math.floor((py + 0.75) / 4) - minBy - 1);
                    const by1 = Math.min(bh - 1, Math.floor((py + 0.75) / 4) - minBy + 1);
                    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
                        const b = by * bw + bx;
                        if (!baseBucketFree[b]) continue;
                        const bucket = baseBuckets[b];
                        for (let j = 0; j < bucket.length; j++) {
                            const id = bucket[j];
                            if (!occupied[id] && 1.5 - Math.abs(cx[id] - px) >= EPS && 1.5 - Math.abs(cy[id] - py) >= EPS) {
                                occupied[id] = 1;
                                baseBucketFree[b]--;
                            }
                        }
                    }
                }
            }
            iterStamp++;
            const startList = [], goalList = [];
            for (const relay of connected) {
                if (!relaysPower(relay)) continue;
                const ids = linkedSiteIds(relay);
                for (let j = 0; j < ids.length; j++) {
                    const id = ids[j];
                    if (!occupied[id] && startMark[id] !== iterStamp) {
                        startMark[id] = iterStamp;
                        startList.push(id);
                    }
                }
            }
            let direct = -1, directScore = 0;
            for (let t = 0; t < targets.length; t++) {
                const target = targets[t];
                if (connected.has(target)) continue;
                const ids = linkedSiteIds(target);
                for (let j = 0; j < ids.length; j++) {
                    const id = ids[j];
                    if (occupied[id]) continue;
                    let score;
                    if (goalMark[id] !== iterStamp) {
                        goalMark[id] = iterStamp;
                        goalList.push(id);
                        score = 1;
                    } else {
                        score = usePreferCoverage ? goalScore[id] + 1 : 1;
                    }
                    goalScore[id] = score;
                    if (startMark[id] === iterStamp && (score > directScore || (score === directScore && id < direct))) {
                        direct = id;
                        directScore = score;
                    }
                }
            }
            // The old breadth-first order checks every one-pole route before
            // extending a route. Preserve its stable coverage and position ties.
            if (direct >= 0) {
                poles.push(candidates[direct]);
                attach();
                continue;
            }
            if (!goalList.length || !startList.length || maximum - poles.length < 2) break;
            // No one-pole route exists here, so the starts and goals are disjoint.
            // Every longer route must cross the boundary of both sets. A pocket
            // of legal sites with no room for an adjacent pole cannot be wired.
            const useGoals = goalList.length < startList.length;
            const edgeList = useGoals ? goalList : startList;
            const edgeMark = useGoals ? goalMark : startMark;
            let canLeave = false;
            boundary: for (let e = 0; e < edgeList.length; e++) {
                const u = edgeList[e];
                const ux = cx[u], uy = cy[u];
                const bx = Math.floor((ux + 0.75) / 4) - minBx;
                const by = Math.floor((uy + 0.75) / 4) - minBy;
                const bx0 = bx > 0 ? bx - 1 : 0, bx1 = bx + 1 < bw ? bx + 1 : bw - 1;
                const by0 = by > 0 ? by - 1 : 0, by1 = by + 1 < bh ? by + 1 : bh - 1;
                for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
                    const b = y * bw + x;
                    if (!baseBucketFree[b]) continue;
                    const bucket = baseBuckets[b];
                    for (let j = 0; j < bucket.length; j++) {
                        const v = bucket[j];
                        if (occupied[v] || edgeMark[v] === iterStamp) continue;
                        const dx = Math.abs(ux - cx[v]), dy = Math.abs(uy - cy[v]);
                        if (dx <= 4.0 + EPS && dy <= 4.0 + EPS && !(1.5 - dx >= EPS && 1.5 - dy >= EPS)) {
                            canLeave = true;
                            break boundary;
                        }
                    }
                }
            }
            if (!canLeave) break;

            let activeBuckets = baseBuckets;
            if (usePreferCoverage) {
                activeBuckets = baseBuckets.slice();
                for (let g = 0; g < goalList.length; g++) {
                    const b = candBucket[goalList[g]];
                    if (goalBucketMark[b] === iterStamp) continue;
                    goalBucketMark[b] = iterStamp;
                    const copy = baseBuckets[b].slice();
                    copy.sort((a, bId) => ((goalMark[bId] === iterStamp ? goalScore[bId] : 0) - (goalMark[a] === iterStamp ? goalScore[a] : 0)) || (a - bId));
                    activeBuckets[b] = copy;
                }
                startList.sort((a, bId) => ((goalMark[bId] === iterStamp ? goalScore[bId] : 0) - (goalMark[a] === iterStamp ? goalScore[a] : 0)) || (a - bId));
            } else {
                startList.sort((a, bId) => a - bId);
            }

            bfsStamp++;
            bucketRem.set(baseBucketFree);
            let tail = 0;
            for (let s = 0; s < startList.length; s++) {
                const id = startList[s];
                parents[id] = -1;
                depth[id] = 1;
                visitedMark[id] = bfsStamp;
                bucketRem[candBucket[id]]--;
                queue[tail++] = id;
            }
            const maxDepth = maximum - poles.length;
            let end = -1;
            routes: for (let head = 0; head < tail; head++) {
                const u = queue[head];
                const d = depth[u];
                if (d >= maxDepth) continue;
                const ux = cx[u], uy = cy[u];
                const bx = Math.floor((ux + 0.75) / 4) - minBx;
                const by = Math.floor((uy + 0.75) / 4) - minBy;
                const bx0 = bx > 0 ? bx - 1 : 0, bx1 = bx + 1 < bw ? bx + 1 : bw - 1;
                const by0 = by > 0 ? by - 1 : 0, by1 = by + 1 < bh ? by + 1 : bh - 1;
                // Half-tile pole sites link only within four tiles per axis, one bucket away.
                for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
                    const b = y * bw + x;
                    if (bucketRem[b] <= 0) continue;
                    const bucket = activeBuckets[b];
                    for (let j = 0; j < bucket.length; j++) {
                        const v = bucket[j];
                        if (visitedMark[v] === bfsStamp || occupied[v]) continue;
                        const vx = cx[v], vy = cy[v];
                        const dx = Math.abs(ux - vx), dy = Math.abs(uy - vy);
                        if (dx > 4.0 + EPS || dy > 4.0 + EPS) continue;
                        if (1.5 - dx >= EPS && 1.5 - dy >= EPS) continue;
                        let blockedByRoute = false;
                        for (let prev = parents[u]; prev !== -1; prev = parents[prev]) {
                            if (1.5 - Math.abs(cx[prev] - vx) >= EPS && 1.5 - Math.abs(cy[prev] - vy) >= EPS) {
                                blockedByRoute = true;
                                break;
                            }
                        }
                        if (blockedByRoute) continue;
                        parents[v] = u;
                        // The first goal enqueued is also the first dequeued.
                        // All one-pole goals were handled above.
                        if (goalMark[v] === iterStamp) { end = v; break routes; }
                        depth[v] = d + 1;
                        visitedMark[v] = bfsStamp;
                        bucketRem[b]--;
                        queue[tail++] = v;
                    }
                }
            }
            if (end < 0) break;
            const route = [];
            for (let id = end; id !== -1; id = parents[id]) route.push(candidates[id]);
            route.reverse();
            poles.push(...route);
            attach();
        }
        return { poles, links, connected, disconnected: targets.filter(t => !connected.has(t)).length };
    };

    let routed = routeWith(preferCoverage);
    if (!islands && routed.disconnected && !preferCoverage && generators.length && consumers.length) {
        if (retryPreferCoverage) {
            routed = routeWith(true);
        } else if (repack) {
            const covered = routeWith(true);
            if (!covered.disconnected) routed = covered;
        }
    }
    const { poles, links, connected, disconnected } = routed;
    for (const m of consumers) m.power_connected = connected.has(m);
    layout.power = {
        poles, links, maximum,
        generators: generators.length,
        consumers: consumers.length,
        disconnected,
        coverage: [...generators, ...poles].map(r => ({ ...powerCoverage(r), connected: connected.has(r) })),
    };
    if (islands) return analyzePowerNetworks(layout);
    if (repack && layout.power.disconnected && generators.length && consumers.length) {
        return repackPower(layout, cells, maximum, { canRelocate, canPlacePole });
    }
    return layout;
}

// Reuse the same feasible placement search to repair a disconnected grid or to
// compare a compact alternative for an already connected grid.
export function repackPower(layout, cells, maximum, { canRelocate = null, canPlacePole = null, attempts = null, accept = null } = {}) {
    const inside = createInsideTest(cells);
    const electricMembers = layout.pieces.flatMap(p => p.members).filter(m => m.generator || m.electric_level != null);
    if (!layout.power.generators || !layout.power.consumers) return layout;
    const mx = electricMembers.reduce((sum, m) => sum + center(m).x, 0) / electricMembers.length;
    const my = electricMembers.reduce((sum, m) => sum + center(m).y, 0) / electricMembers.length;
    const limit = attempts ?? (accept ? 8 : cells.length);
    const anchors = cells.map(c => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 }))
        .sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my)).slice(0, limit);
    // Every anchor moves the same electric buildings. Exclude immutable
    // obstacles once before ordering sites for any of those trials.
    const stationary = [...layout.storages, ...layout.pieces.flatMap(p => p.members)
        .filter(m => !m.generator && m.electric_level == null)];
    const fixed = obstacleTest(cells, stationary);
    const positions = new Map();
    const rowsFor = ({ w, h }) => {
        const key = `${w}|${h}`;
        if (!positions.has(key)) {
            const rows = [];
            for (const cell of cells) for (let y = cell.y; y < cell.y + cell.h; y += .5) {
                const row = [];
                for (let x = cell.x; x < cell.x + cell.w; x += .5) {
                    const site = { x, y, w, h };
                    if (inside(site) && !fixed.blocked(site)) row.push(site);
                }
                if (row.length) rows.push(row);
            }
            positions.set(key, rows);
        }
        return positions.get(key);
    };
    let best = layout;
    for (const anchor of anchors) {
        const trial = structuredClone(layout);
        const all = trial.pieces.flatMap(p => p.members);
        const movable = all.filter(m => m.generator || m.electric_level != null)
            .sort((a, b) => Number(!!b.generator) - Number(!!a.generator) || b.w * b.h - a.w * a.h);
        const occupied = obstacleTest(cells, []);
        let fits = true;
        for (const m of movable) {
            let bestDistance = Infinity, spot = null;
            // Rows retain the original cell and site order for equal distances.
            for (const row of rowsFor(m)) {
                const dy = row[0].y + m.h / 2 - anchor.y;
                const vertical = dy * dy;
                if (vertical >= bestDistance) continue;
                for (const candidate of row) {
                    const dx = candidate.x + m.w / 2 - anchor.x;
                    const distance = dx * dx + vertical;
                    if (distance >= bestDistance) {
                        // Farther right, the horizontal distance can only grow.
                        if (dx >= 0) break;
                        continue;
                    }
                    if (occupied.blocked(candidate) || (canRelocate && !canRelocate(m, candidate))) continue;
                    spot = candidate;
                    bestDistance = distance;
                }
            }
            if (!spot) { fits = false; break; }
            m.x = spot.x; m.y = spot.y; occupied.add(m);
        }
        if (!fits) continue;
        connectPower(trial, cells, maximum, false, canRelocate, canPlacePole, false, false, inside, true);
        if (trial.power.disconnected < best.power.disconnected || (trial.power.disconnected === best.power.disconnected
            && trial.power.poles.length < best.power.poles.length && (!accept || accept(trial)))) best = trial;
        if (!best.power.disconnected && (!accept || best !== layout)) break;
    }
    return best;
}
