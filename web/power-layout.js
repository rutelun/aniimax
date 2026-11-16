// Power coverage is square, centered on the generator/pole. A real 1/4 tile overlap
// connects a building. Only generators and poles relay power; consumers are endpoints. The ranges,
// footprints and conservative overlap follow Aniimo Camp's public Home planner data.
import { createInsideTest } from './layout.js';

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

function attachTargets(targets, connected, links) {
    let changed;
    do {
        changed = false;
        for (const target of targets) {
            if (connected.has(target)) continue;
            const parent = [...connected].find(node => relaysPower(node) && powerLinked(node, target));
            if (!parent) continue;
            links.push({ from: center(parent), to: center(target) });
            connected.add(target);
            changed = true;
        }
    } while (changed);
}

// Refresh wiring after consumers move inside existing supply zones. Infrastructure stays put.
export function updatePowerConnections(layout) {
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

export function connectPower(layout, cells, maximum, repack = true, canRelocate = null, canPlacePole = null) {
    const inside = createInsideTest(cells);
    const members = layout.pieces.flatMap(p => p.members);
    const generators = members.filter(m => m.generator);
    const consumers = members.filter(m => m.electric_level != null);
    // Generators do not haul anything. Relocate them into free space near their consumers
    // before routing, rather than leaving them at the edge chosen by the hauling layout.
    for (const generator of generators) {
        const destinations = [...consumers, ...generators.filter(g => g !== generator)];
        const sumX = destinations.reduce((sum, m) => sum + m.x + m.w / 2, 0);
        const sumY = destinations.reduce((sum, m) => sum + m.y + m.h / 2, 0);
        const obstacles = [...members.filter(m => m !== generator), ...layout.storages];
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
                if (!inside(r) || obstacles.some(o => overlap(r, o, EPS * 2))) continue;
                if (!best || cost < best.cost) best = { x, y, cost };
            }
        }
        if (best) { generator.x = best.x; generator.y = best.y; }
    }
    const poles = [];
    const targets = [...generators, ...consumers];
    const connected = new Set();
    const links = [];
    if (generators.length) connected.add(generators[0]);
    const attach = () => attachTargets([...targets, ...poles], connected, links);
    attach();
    // Free half-tile locations for poles, never on facilities, storage or locked land.
    const blocked = [...members, ...layout.storages];
    const candidates = [];
    const seen = new Set();
    const needsRoute = connected.size && maximum > 0 && targets.some(t => !connected.has(t));
    for (const c of needsRoute ? cells : []) for (let y = c.y; y < c.y + c.h; y += 0.5) for (let x = c.x; x < c.x + c.w; x += 0.5) {
        const key = `${x},${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const r = { x, y, w: 1.5, h: 1.5, pole: true, facility: 'Crackle Power Pole' };
        if (canPlacePole && !canPlacePole(r)) continue;
        if (!inside(r) || blocked.some(b => overlap(r, b, EPS * 2))) continue;
        candidates.push(r);
    }
    // BFS finds a route with the fewest extra poles to one of the remaining targets.
    // A spatial index bounds each expansion to nearby candidates rather than all land.
    const bucket = r => { const c = center(r); return [Math.floor(c.x / 4), Math.floor(c.y / 4)]; };
    while (connected.size && targets.some(t => !connected.has(t)) && poles.length < maximum) {
        const available = candidates.filter(r => !poles.some(p => overlap(r, p, EPS * 2)));
        const buckets = new Map();
        for (const r of available) { const key = bucket(r).join(','); if (!buckets.has(key)) buckets.set(key, new Set()); buckets.get(key).add(r); }
        const parents = new Map();
        const depth = new Map();
        const queue = [];
        const relays = [...connected].filter(relaysPower);
        for (const r of available) if (relays.some(n => powerLinked(n, r))) {
            parents.set(r, null); depth.set(r, 1); queue.push(r);
            buckets.get(bucket(r).join(',')).delete(r);
        }
        let end = null;
        const remaining = targets.filter(t => !connected.has(t));
        for (let head = 0; head < queue.length; head++) {
            const r = queue[head];
            if (remaining.some(t => powerLinked(r, t))) { end = r; break; }
            if (depth.get(r) >= maximum - poles.length) continue;
            const [bx, by] = bucket(r);
            // Half-tile pole sites link only within four tiles per axis, one bucket away.
            for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) {
                const unvisited = buckets.get(`${x},${y}`);
                if (!unvisited) continue;
                for (const next of unvisited) {
                    if (!powerLinked(r, next) || overlap(r, next, EPS * 2)) continue;
                    let blockedByRoute = false;
                    for (let previous = parents.get(r); previous; previous = parents.get(previous)) {
                        if (overlap(previous, next, EPS * 2)) { blockedByRoute = true; break; }
                    }
                    if (blockedByRoute) continue;
                    parents.set(next, r); depth.set(next, depth.get(r) + 1); queue.push(next);
                    unvisited.delete(next);
                }
            }
        }
        if (!end) break;
        const route = [];
        for (let r = end; r; r = parents.get(r)) route.unshift(r);
        poles.push(...route);
        attach();
    }
    for (const m of consumers) m.power_connected = connected.has(m);
    layout.power = {
        poles, links, maximum,
        generators: generators.length,
        consumers: consumers.length,
        disconnected: targets.filter(t => !connected.has(t)).length,
        coverage: [...generators, ...poles].map(r => ({ ...powerCoverage(r), connected: connected.has(r) })),
    };
    if (repack && layout.power.disconnected && generators.length && consumers.length) {
        return repackPower(layout, cells, maximum, { canRelocate, canPlacePole });
    }
    return layout;
}

// Reuse the same feasible placement search to repair a disconnected grid or to
// compare a compact alternative for an already connected grid.
export function repackPower(layout, cells, maximum, { canRelocate = null, canPlacePole = null, attempts = 8, accept = null } = {}) {
    const inside = createInsideTest(cells);
    const electricMembers = layout.pieces.flatMap(p => p.members).filter(m => m.generator || m.electric_level != null);
    if (!layout.power.generators || !layout.power.consumers) return layout;
    const mx = electricMembers.reduce((sum, m) => sum + center(m).x, 0) / electricMembers.length;
    const my = electricMembers.reduce((sum, m) => sum + center(m).y, 0) / electricMembers.length;
    const anchors = cells.map(c => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 }))
        .sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my)).slice(0, attempts);
    const positions = new Map();
    const sitesFor = ({ w, h }) => {
        const key = `${w}|${h}`;
        if (!positions.has(key)) {
            const sites = [];
            for (const cell of cells) for (let y = cell.y; y < cell.y + cell.h; y += .5) for (let x = cell.x; x < cell.x + cell.w; x += .5) {
                const site = { x, y, w, h };
                if (inside(site)) sites.push(site);
            }
            positions.set(key, sites);
        }
        return positions.get(key);
    };
    let best = layout;
    for (const anchor of anchors) {
        const trial = structuredClone(layout);
        const all = trial.pieces.flatMap(p => p.members);
        const movable = all.filter(m => m.generator || m.electric_level != null)
            .sort((a, b) => Number(!!b.generator) - Number(!!a.generator) || b.w * b.h - a.w * a.h);
        const occupied = [...trial.storages, ...all.filter(m => !movable.includes(m))];
        const byDistance = new Map();
        const near = member => {
            const sites = sitesFor(member);
            if (!byDistance.has(sites)) {
                const cost = r => (r.x + r.w / 2 - anchor.x) ** 2 + (r.y + r.h / 2 - anchor.y) ** 2;
                byDistance.set(sites, sites.map(r => [r, cost(r)]).sort((a, b) => a[1] - b[1]).map(([r]) => r));
            }
            return byDistance.get(sites);
        };
        let fits = true;
        for (const m of movable) {
            const spot = near(m).find(r => (!canRelocate || canRelocate(m, r)) && !occupied.some(o => overlap(r, o, EPS * 2)));
            if (!spot) { fits = false; break; }
            m.x = spot.x; m.y = spot.y; occupied.push(m);
        }
        if (!fits) continue;
        connectPower(trial, cells, maximum, false, canRelocate, canPlacePole);
        if (trial.power.disconnected < best.power.disconnected || (trial.power.disconnected === best.power.disconnected
            && trial.power.poles.length < best.power.poles.length && (!accept || accept(trial)))) best = trial;
        if (!best.power.disconnected && (!accept || best !== layout)) break;
    }
    return best;
}
