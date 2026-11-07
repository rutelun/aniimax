// Shared with delivery animation. Distances and model times are in homeland tiles/seconds.
export const ANIIMO_WALK_SPEED = 4;

export function workerHubs(members) {
    const hubs = new Map();
    for (const m of members) for (const [worker, visits] of m.workers || []) {
        if (!(visits > 0)) continue;
        const hub = hubs.get(worker) || { x: 0, y: 0, visits: 0 };
        hub.x += (m.x + m.w / 2) * visits;
        hub.y += (m.y + m.h / 2) * visits;
        hub.visits += visits;
        hubs.set(worker, hub);
    }
    for (const hub of hubs.values()) { hub.x /= hub.visits; hub.y /= hub.visits; }
    return hubs;
}

export function workerPlacementCost(members, rectangles, hubs) {
    return members.reduce((sum, m, i) => sum + (m.workers || []).reduce((cost, [worker, visits]) => {
        const hub = hubs.get(worker), r = rectangles[i];
        return cost + (hub ? visits * Math.hypot(r.x + r.w / 2 - hub.x, r.y + r.h / 2 - hub.y) : 0);
    }, 0), 0);
}

export const workerLayoutCost = members => workerPlacementCost(members, members, workerHubs(members));

// Visit-frequency-weighted mean distance between distinct workplaces, per roster pool.
// Fixed workers have no visit edges.
export function workerTravelDistances(members) {
    const groups = new Map();
    for (const m of members) for (const [worker, visits] of m.workers || []) {
        if (!groups.has(worker)) groups.set(worker, []);
        if (visits > 0) groups.get(worker).push({ x: m.x + m.w / 2, y: m.y + m.h / 2, visits });
    }
    const distances = new Map();
    for (const [worker, points] of groups) {
        let distance = 0, weight = 0;
        points.forEach((a, i) => points.slice(i + 1).forEach(b => {
            const w = a.visits * b.visits;
            distance += w * Math.hypot(a.x - b.x, a.y - b.y); weight += w;
        }));
        distances.set(worker, weight ? distance / weight : 0);
    }
    return distances;
}

export const workerTravelDistance = members => Math.max(0, ...workerTravelDistances(members).values());
