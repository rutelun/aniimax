// Distances and model times are in homeland tiles and seconds.
export const ANIIMO_WALK_SPEED = 4;

// Actual routes and reactive dispatch account for detours separately.
export const workerTravelSeconds = distance => distance / ANIIMO_WALK_SPEED;

// Missing map observations are not zero-length routes. Preserve the previous
// allowance (or its default) rather than serializing NaN as an invalid null.
export function measuredMovementEstimates(previous, distances, members) {
    const result = { ...previous };
    for (const member of members) {
        const distance = distances.get(member);
        if (Number.isFinite(distance) && distance >= 0) result[member] = workerTravelSeconds(distance);
    }
    return result;
}

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

// Replace solver allowances only where the final map contains that worker's sites.
// A negative correction releases hours; no layout means no claimed saving.
export function layoutWalkingAdjustments(members, plan) {
    const distances = workerTravelDistances(members);
    const visits = new Map();
    for (const [, , member, rate] of plan.mobile_work || []) {
        visits.set(member, (visits.get(member) || 0) + rate);
    }
    const previous = new Map(plan.movement_staffing || []);
    return [...distances].flatMap(([member, distance]) => {
        if (!visits.has(member)) return [];
        const measured = workerTravelSeconds(distance) * visits.get(member) / 3600;
        return [[member, measured - (previous.get(member) || 0)]];
    });
}

// Reuse coordinates only when the alternative's production fits those physical sites.
// Rates and worker identities belong to the alternative, never to the baseline.
export function projectLayoutWork(layout, plan) {
    const result={...layout,pieces:layout.pieces.map(piece=>({...piece,members:piece.members.map(m=>({
        ...m,workers:[],jobs:m.jobs?.map(job=>({...job,rate:0})),batchWeight:0,weight:0,
    }))}))};
    const members=result.pieces.flatMap(piece=>piece.members);
    const matching=(facility,item)=>members.filter(m=>m.facility===facility &&
        (m.jobs ? m.jobs.some(job=>job.item===item) : m.crop===item));
    for(const step of plan.coin_items || []) {
        if(step.status!=='producing')continue;
        const sites=matching(step.facility,step.item_name);
        if(!sites.length || step.facility_count>sites.length+1e-6 || !(step.cycle_time>0))return null;
        if(sites.some(m=>(m.electric_level??null)!==(step.electric_level??null)))return null;
        const rate=(step.busy_units??step.facility_count)/step.cycle_time/sites.length;
        for(const m of sites) {
            m.batchWeight+=rate*3600;
            m.weight+=rate*3600;
            if(m.jobs) {const job=m.jobs.find(j=>j.item===step.item_name);job.rate+=rate;job.crew=step.crew;}
            else m.crew=step.crew;
        }
    }
    for(const [item,facility,worker,visits] of plan.mobile_work || []) {
        const sites=matching(facility,item);
        if(!sites.length)return null;
        for(const m of sites) {
            const previous=m.workers.find(([member])=>member===worker);
            if(previous)previous[1]+=visits/sites.length;else m.workers.push([worker,visits/sites.length]);
        }
    }
    return result;
}
