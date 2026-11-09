const canonical = item => item.replace(/^quick_/, '');
const center = r => [r.x + r.w / 2, r.y + r.h / 2];
const distance = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const overlaps = (a, b, margin = 1e-6) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= margin
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= margin;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const english = new Intl.Collator('en');

export function productionGraph(pieces, recipes) {
    const byItem = new Map(recipes.map(recipe => [recipe.item, recipe]));
    const nodes = pieces.flatMap((piece, index) => {
        const members = piece.members ?? [...piece.buildings, ...piece.plots];
        return members.flatMap(rect => {
            if (!(rect.weight > 0)) return [];
            const jobs = (rect.jobs?.map(job => [job.item, job.rate * 3600])
                ?? [[rect.crop, rect.batchWeight ?? rect.weight]])
                .flatMap(([item, batches]) => byItem.has(item) && batches > 0 ? [{ ...byItem.get(item), batches }] : []);
            const processing = jobs.filter(job => job.takes.length);
            return jobs.length ? [{ index, rect, jobs, processing,
                movable: !piece.cluster && members.length === 1 && !rect.sensitive && !rect.building && !rect.generator,
                label: processing.length ? rect.facility : '' }] : [];
        });
    });
    const supplies = new Map();
    const addSupply = (item, node, rate) => {
        const key = canonical(item);
        if (!supplies.has(key)) supplies.set(key, new Map());
        const sources = supplies.get(key);
        sources.set(node, (sources.get(node) || 0) + rate);
    };
    for (const node of nodes) for (const job of node.jobs) {
        addSupply(job.makes, node, job.batches * job.yield);
        if (job.byproduct?.[1] > 0) addSupply(job.byproduct[0], node, job.batches * job.byproduct[1]);
    }
    const links = [];
    for (const to of nodes) for (const job of to.processing) for (const [item] of job.takes) {
        const sources = [...(supplies.get(canonical(item)) ?? [])].filter(([from]) => from !== to);
        const total = sources.reduce((sum, [, output]) => sum + output, 0);
        for (const [from, output] of sources) if (from.processing.length) {
            links.push({ from, to, weight: job.batches * output / total / job.takes.length });
        }
    }
    return { nodes, links };
}

export function chainPurposes(purposes, { links }) {
    const next = [...purposes], consumers = new Map();
    for (const { from, to } of links) {
        if (from.index === to.index) continue;
        if (!consumers.has(from.index)) consumers.set(from.index, new Set());
        consumers.get(from.index).add(to.index);
    }
    // Move an intermediate only when every known consumer belongs to the same purpose.
    for (let changed = true; changed;) {
        changed = false;
        for (const [source, targets] of consumers) {
            if (next[source] !== 'support') continue;
            const destinations = new Set([...targets].map(i => next[i]));
            if (destinations.size !== 1 || destinations.has('support')) continue;
            next[source] = destinations.values().next().value;
            changed = true;
        }
    }
    return next;
}

export const productionDistance = ({ links }) => links.reduce((sum, { from, to, weight }) =>
    sum + weight * distance(from.rect, to.rect), 0);

// Let the eye scan each district in tile rows, then from left to right.
export function alphabetInversions(groups, { nodes }) {
    return groups.reduce((total, { bounds }) => {
        const ordered = nodes.filter(node => node.label && contains(bounds, node.rect)).sort((a, b) =>
            Math.floor(center(a.rect)[1] / 4) - Math.floor(center(b.rect)[1] / 4)
            || center(a.rect)[0] - center(b.rect)[0]);
        for (let i = 0; i < ordered.length; i++) for (let j = 0; j < i; j++) {
            if (english.compare(ordered[j].label, ordered[i].label) > 0) total++;
        }
        return total;
    }, 0);
}

// Keep a hard route budget. Geometry and the pole positions stay fixed except for
// ordinary processors moving into free space or exchanging equal-sized sites.
export function refineProductionPlacement(layout, groups, graph, travelCost, { limit, maxChain, maxOrder, canPlace }) {
    const movable = graph.nodes.filter(node => node.label && node.movable);
    const occupied = [...layout.pieces.flatMap(piece => piece.members), ...layout.storages, ...layout.power.poles];
    const zones = layout.power.coverage.filter(zone => zone.connected);
    const valid = (node, r) => groups.some(group => contains(group.bounds, r)
        && group.reserved.every(space => !overlaps(space, r)))
        && canPlace(node.index, r)
        && (node.rect.electric_level == null || zones.some(zone => overlaps(zone, r, .25 - 1e-6)));
    const position = (r, x, y) => { r.x = x; r.y = y; };
    let chain = productionDistance(graph), order = alphabetInversions(groups, graph), route = travelCost(layout);
    const epsilon = 1e-6;
    const tryMove = (a, x, y, b, sorting) => {
        const r = a.rect, oldX = r.x, oldY = r.y;
        const s = b?.rect, sx = s?.x, sy = s?.y;
        if (oldX === x && oldY === y) return;
        const target = { ...r, x, y };
        const back = s && { ...s, x: Math.round((oldX + (r.w - s.w) / 2) * 4) / 4,
            y: Math.round((oldY + (r.h - s.h) / 2) * 4) / 4 };
        if (!valid(a, target) || (b && (!valid(b, back) || overlaps(target, back)))) return;
        if (occupied.some(other => other !== r && other !== s && (overlaps(other, target) || (back && overlaps(other, back))))) return;
        position(r, x, y);
        if (s) position(s, back.x, back.y);
        const nextChain = productionDistance(graph);
        const nextOrder = alphabetInversions(groups, graph);
        if (sorting ? nextOrder < order && nextChain <= Math.max(chain, maxChain) + epsilon
            : nextChain < chain - epsilon && nextOrder <= Math.max(order, maxOrder)) {
            const nextRoute = travelCost(layout);
            if (nextRoute <= limit + epsilon) {
                chain = nextChain;
                order = nextOrder;
                route = nextRoute;
                return;
            }
        }
        position(r, oldX, oldY);
        if (s) position(s, sx, sy);
    };
    const near = (node, other, sorting) => {
        const r = node.rect, s = other.rect;
        const [x, y] = center(s);
        const cx = Math.round((x - r.w / 2) * 4) / 4, cy = Math.round((y - r.h / 2) * 4) / 4;
        for (const margin of sorting ? [0] : [0, 1, 2]) {
            tryMove(node, s.x - r.w - margin, cy, null, sorting);
            tryMove(node, s.x + s.w + margin, cy, null, sorting);
            tryMove(node, cx, s.y - r.h - margin, null, sorting);
            tryMove(node, cx, s.y + s.h + margin, null, sorting);
        }
    };
    for (const { from, to } of [...graph.links].sort((a, b) => b.weight - a.weight)) {
        for (const [node, other] of [[from, to], [to, from]]) {
            if (!node.movable) continue;
            near(node, other, false);
        }
    }
    // Reorder within a group, leaving most of any chain improvement intact.
    maxChain = Math.min(maxChain, chain * 1.12);
    for (const group of groups) {
        const local = movable.filter(node => contains(group.bounds, node.rect));
        for (let i = 0; i < local.length; i++) for (let j = 0; j < i; j++) {
            const a = local[i], b = local[j];
            if (a.label === b.label || !contains(group.bounds, a.rect) || !contains(group.bounds, b.rect)) continue;
            const [x, y] = center(b.rect);
            tryMove(a, Math.round((x - a.rect.w / 2) * 4) / 4, Math.round((y - a.rect.h / 2) * 4) / 4, b, true);
            near(a, b, true);
            near(b, a, true);
        }
    }
    return { chain, order, route };
}
