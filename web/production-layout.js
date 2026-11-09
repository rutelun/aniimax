import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';

const canonical = item => item.replace(/^quick_/, '');
const center = r => [r.x + r.w / 2, r.y + r.h / 2];
const distance = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const overlaps = (a, b, margin = 1e-6) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) >= margin
    && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) >= margin;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const english = new Intl.Collator('en');

export function productionGraph(pieces, recipes, { includeIdle = false } = {}) {
    const byItem = new Map(recipes.map(recipe => [recipe.item, recipe]));
    const nodes = pieces.flatMap((piece, index) => {
        const members = piece.members ?? [...piece.buildings, ...piece.plots];
        return members.flatMap(rect => {
            const workshop = includeIdle && FACILITY_CATEGORY_BY_NAME.get(rect.facility) === 'Materials Processing';
            if (!(rect.weight > 0) && !workshop) return [];
            const jobs = (rect.jobs?.map(job => [job.item, job.rate * 3600])
                ?? [[rect.crop, rect.batchWeight ?? rect.weight]])
                .flatMap(([item, batches]) => byItem.has(item) && batches > 0 ? [{ ...byItem.get(item), batches }] : []);
            const processing = jobs.filter(job => job.takes.length);
            return jobs.length || workshop ? [{ index, rect, jobs, processing,
                movable: !piece.cluster && members.length === 1 && !rect.sensitive && !rect.building && !rect.generator,
                label: processing.length || workshop ? rect.facility : '' }] : [];
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
    const links = [], supplyLinks = [];
    for (const to of nodes) for (const job of to.processing) for (const [item] of job.takes) {
        const sources = [...(supplies.get(canonical(item)) ?? [])].filter(([from]) => from !== to);
        const total = sources.reduce((sum, [, output]) => sum + output, 0);
        for (const [from, output] of sources) {
            const link = { from, to, weight: job.batches * output / total / job.takes.length };
            if (from.processing.length) links.push(link);
            else supplyLinks.push(link);
        }
    }
    return { nodes, links, supplyLinks };
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

export const productionLinkDistances = ({ links }) => links.map(({ from, to }) => distance(from.rect, to.rect));

function linkExcess(graph, limits) {
    if (!limits) return 0;
    if (limits.length !== graph.links.length) return Infinity;
    return productionLinkDistances(graph).reduce((sum, value, i) => sum + Math.max(0, value - limits[i]), 0);
}

// Read each district in tile rows. When reversals remain, prefer ones between
// adjacent entries and then between physically closer buildings.
export function alphabetScore(groups, { nodes }) {
    const score = { spread: 0, interleaving: 0, count: 0, span: 0, distance: 0 };
    const districts = [];
    for (const { bounds } of groups) {
        const ordered = nodes.filter(node => node.label && contains(bounds, node.rect)).sort((a, b) =>
            Math.floor(center(a.rect)[1] / 4) - Math.floor(center(b.rect)[1] / 4)
            || center(a.rect)[0] - center(b.rect)[0]);
        const names = new Map();
        for (const { label } of ordered) names.set(label, (names.get(label) ?? 0) + 1);
        districts.push(names);
        for (let i = 0; i < ordered.length; i++) for (let j = 0; j < i; j++) {
            if (english.compare(ordered[j].label, ordered[i].label) <= 0) continue;
            score.count++;
            score.span += (i - j - 1) ** 2;
            score.distance += distance(ordered[j].rect, ordered[i].rect);
        }
    }
    // Prefer a single storage block for each facility type, and avoid interleaved
    // ranges of names. Either alphabetical direction between two blocks is valid:
    // a block's number has no bearing on the names that belong in it.
    for (let i = 0; i < districts.length; i++) for (let j = 0; j < i; j++) {
        let before = 0, after = 0;
        for (const [a, copiesA] of districts[i]) for (const [b, copiesB] of districts[j]) {
            const order = english.compare(a, b);
            if (order < 0) before++;
            else if (order > 0) after++;
            else score.spread += copiesA * copiesB;
        }
        score.interleaving += Math.min(before, after);
    }
    return score;
}

export const alphabetInversions = (groups, graph) => alphabetScore(groups, graph).count;

const difference = (a, b) => Math.abs(a - b) <= 1e-6 || a === b ? 0 : a - b;
export const compareProductionPlacement = (a, b) => difference(a.excess, b.excess)
    || a.order.spread - b.order.spread || a.order.interleaving - b.order.interleaving
    || a.order.count - b.order.count || a.order.span - b.order.span
    || difference(a.order.distance, b.order.distance) || difference(a.chain, b.chain) || difference(a.route, b.route);

// Search the feasible swaps and moves, keeping the best one on each pass.
export function refineProductionPlacement(layout, groups, graph, travelCost, { maxChain, maxLinks, canPlace, keepsIncome }) {
    const movable = graph.nodes.filter(node => node.label && node.movable);
    const occupied = [...layout.pieces.flatMap(piece => piece.members), ...layout.storages, ...layout.power.poles];
    const zones = layout.power.coverage.filter(zone => zone.connected);
    const valid = (node, r) => groups.some(group => contains(group.bounds, r)
        && group.reserved.every(space => !overlaps(space, r)))
        && canPlace(node.index, r)
        && (node.rect.electric_level == null || zones.some(zone => overlaps(zone, r, .25 - 1e-6)));
    const position = (r, x, y) => { r.x = x; r.y = y; };
    const measure = route => {
        const chain = productionDistance(graph);
        return { chain, order: alphabetScore(groups, graph), route,
            excess: linkExcess(graph, maxLinks) + Math.max(0, chain - maxChain) };
    };
    let current = measure(travelCost(layout)), best;
    const tryMove = (a, x, y, b) => {
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
        const previous = best?.score ?? current;
        const next = measure(previous.route);
        if (compareProductionPlacement(next, previous) <= 0 && keepsIncome(layout)) {
            next.route = travelCost(layout);
            if (compareProductionPlacement(next, previous) < 0) best = { r, x, y, s, back, score: next };
        }
        position(r, oldX, oldY);
        if (s) position(s, sx, sy);
    };
    const near = (node, other, margins) => {
        const r = node.rect, s = other.rect;
        const [x, y] = center(s);
        const cx = Math.round((x - r.w / 2) * 4) / 4, cy = Math.round((y - r.h / 2) * 4) / 4;
        for (const margin of margins) {
            tryMove(node, s.x - r.w - margin, cy);
            tryMove(node, s.x + s.w + margin, cy);
            tryMove(node, cx, s.y - r.h - margin);
            tryMove(node, cx, s.y + s.h + margin);
        }
    };
    const swap = (a, b) => {
        const [x, y] = center(b.rect);
        tryMove(a, Math.round((x - a.rect.w / 2) * 4) / 4, Math.round((y - a.rect.h / 2) * 4) / 4, b);
    };
    for (let pass = 0; pass < 12; pass++) {
        best = null;
        const districts = groups.map(group => movable.filter(node => contains(group.bounds, node.rect)));
        for (const local of districts) {
            for (let i = 0; i < local.length; i++) for (let j = 0; j < i; j++) {
                const a = local[i], b = local[j];
                if (a.label === b.label) continue;
                swap(a, b);
                near(a, b, [0]);
                near(b, a, [0]);
            }
        }
        if (current.order.spread || current.order.interleaving) {
            for (let i = 0; i < districts.length; i++) for (let j = 0; j < i; j++) {
                for (const a of districts[i]) for (const b of districts[j]) {
                    if (a.label !== b.label) swap(a, b);
                    else {
                        near(a, b, [0, 1, 2]);
                        near(b, a, [0, 1, 2]);
                    }
                }
            }
        }
        for (const { from, to } of graph.links) {
            if (from.movable) near(from, to, [0, 1, 2]);
            if (to.movable) near(to, from, [0, 1, 2]);
        }
        if (!best) break;
        position(best.r, best.x, best.y);
        if (best.s) position(best.s, best.back.x, best.back.y);
        current = best.score;
    }
    return current;
}
