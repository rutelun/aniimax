// Power coverage is square, centered on the generator/pole. A real 1/4 tile overlap
// connects a building. Only generators and poles relay power; consumers are endpoints. The ranges,
// footprints and conservative overlap follow Aniimo Camp's public Home planner data.
const EPS = 1e-6;
const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export function powerCoverage(r) {
    const side = r.generator ? 11 : r.pole ? 7 : 0;
    if (!side) return null;
    const c = center(r);
    return { x: c.x - side / 2, y: c.y - side / 2, w: side, h: side };
}
const overlap = (a, b, margin = 0.25) => a && b
    && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= margin - EPS
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= margin - EPS;
export const powerLinked = (a, b) => !!(overlap(a, powerCoverage(b)) || overlap(b, powerCoverage(a)));
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
    const members = layout.pieces.flatMap(p => p.members);
    const generators = members.filter(m => m.generator);
    const consumers = members.filter(m => m.electric_level != null);
    // Generators do not haul anything. Relocate them into free space near their consumers
    // before routing, rather than leaving them at the edge chosen by the hauling layout.
    for (const generator of generators) {
        const destinations = [...consumers, ...generators.filter(g => g !== generator)];
        const obstacles = [...members.filter(m => m !== generator), ...layout.storages];
        let best = null;
        for (const cell of destinations.length ? cells : []) {
            for (let y = cell.y; y < cell.y + cell.h; y += 0.5) for (let x = cell.x; x < cell.x + cell.w; x += 0.5) {
                const r = { x, y, w: generator.w, h: generator.h };
                if (canRelocate && !canRelocate(generator, r)) continue;
                const area = cells.reduce((sum, c) => sum + Math.max(0, Math.min(x + r.w, c.x + c.w) - Math.max(x, c.x))
                    * Math.max(0, Math.min(y + r.h, c.y + c.h) - Math.max(y, c.y)), 0);
                if (area < r.w * r.h - EPS || obstacles.some(o => overlap(r, o, EPS * 2))) continue;
                const c = center(r);
                const cost = destinations.reduce((sum, d) => { const p = center(d); return sum + (c.x - p.x) ** 2 + (c.y - p.y) ** 2; }, 0);
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
        const area = cells.reduce((sum, cell) => sum + Math.max(0, Math.min(x + r.w, cell.x + cell.w) - Math.max(x, cell.x))
            * Math.max(0, Math.min(y + r.h, cell.y + cell.h) - Math.max(y, cell.y)), 0);
        if (area < r.w * r.h - EPS || blocked.some(b => overlap(r, b, EPS * 2))) continue;
        candidates.push(r);
    }
    // BFS finds a route with the fewest extra poles to one of the remaining targets.
    // A spatial index bounds each expansion to nearby candidates rather than all land.
    const bucket = r => { const c = center(r); return [Math.floor(c.x / 4), Math.floor(c.y / 4)]; };
    while (connected.size && targets.some(t => !connected.has(t)) && poles.length < maximum) {
        const available = candidates.filter(r => !poles.some(p => overlap(r, p, EPS * 2)));
        const buckets = new Map();
        for (const r of available) { const key = bucket(r).join(','); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(r); }
        const parents = new Map();
        const depth = new Map();
        const queue = [];
        for (const r of available) if ([...connected].some(n => relaysPower(n) && powerLinked(n, r))) {
            parents.set(r, null); depth.set(r, 1); queue.push(r);
        }
        let end = null;
        const remaining = targets.filter(t => !connected.has(t));
        for (let head = 0; head < queue.length; head++) {
            const r = queue[head];
            if (remaining.some(t => powerLinked(r, t))) { end = r; break; }
            if (depth.get(r) >= maximum - poles.length) continue;
            const [bx, by] = bucket(r);
            for (let y = by - 2; y <= by + 2; y++) for (let x = bx - 2; x <= bx + 2; x++) {
                for (const next of buckets.get(`${x},${y}`) || []) {
                    if (parents.has(next) || !powerLinked(r, next) || overlap(r, next, EPS * 2)) continue;
                    let blockedByRoute = false;
                    for (let previous = parents.get(r); previous; previous = parents.get(previous)) {
                        if (overlap(previous, next, EPS * 2)) { blockedByRoute = true; break; }
                    }
                    if (blockedByRoute) continue;
                    parents.set(next, r); depth.set(next, depth.get(r) + 1); queue.push(next);
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
    // Hauling alone can scatter electric facilities farther apart than the pole cap allows.
    // Try gathering only those facilities in free land. Climate clusters and other facilities
    // stay fixed. Connectivity takes precedence over the hauling-distance preference here.
    if (repack && layout.power.disconnected && generators.length && consumers.length) {
        const electricMembers = [...consumers, ...generators];
        const mx = electricMembers.reduce((sum, m) => sum + center(m).x, 0) / electricMembers.length;
        const my = electricMembers.reduce((sum, m) => sum + center(m).y, 0) / electricMembers.length;
        const anchors = cells.map(c => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 }))
            .sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my)).slice(0, 8);
        let best = layout;
        for (const anchor of anchors) {
            const trial = structuredClone(layout);
            const all = trial.pieces.flatMap(p => p.members);
            const movable = all.filter(m => m.generator || m.electric_level != null)
                .sort((a, b) => Number(!!b.generator) - Number(!!a.generator) || b.w * b.h - a.w * a.h);
            const occupied = [...trial.storages, ...all.filter(m => !movable.includes(m))];
            let fits = true;
            for (const m of movable) {
                let spot = null;
                for (const cell of cells) for (let y = cell.y; y < cell.y + cell.h; y += 0.5) for (let x = cell.x; x < cell.x + cell.w; x += 0.5) {
                    const r = { x, y, w: m.w, h: m.h };
                    if (canRelocate && !canRelocate(m, r)) continue;
                    const c = center(r);
                    const cost = (c.x - anchor.x) ** 2 + (c.y - anchor.y) ** 2;
                    if (spot && cost >= spot.cost) continue;
                    const area = cells.reduce((sum, cell) => sum + Math.max(0, Math.min(x + r.w, cell.x + cell.w) - Math.max(x, cell.x))
                        * Math.max(0, Math.min(y + r.h, cell.y + cell.h) - Math.max(y, cell.y)), 0);
                    if (area < r.w * r.h - EPS || occupied.some(o => overlap(r, o, EPS * 2))) continue;
                    spot = { x, y, cost };
                }
                if (!spot) { fits = false; break; }
                m.x = spot.x; m.y = spot.y; occupied.push(m);
            }
            if (!fits) continue;
            connectPower(trial, cells, maximum, false, canRelocate, canPlacePole);
            if (trial.power.disconnected < best.power.disconnected || (trial.power.disconnected === best.power.disconnected
                && trial.power.poles.length < best.power.poles.length)) best = trial;
            if (!best.power.disconnected) break;
        }
        return best;
    }
    return layout;
}
