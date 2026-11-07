import { nearestStorage } from './layout.js?v=optional-worker-travel';
import { ANIIMO_WALK_SPEED } from './worker-travel.js?v=auto-worker-travel';

// Client-derived Wikily profiles: Skippy 60, Fenrier 80, Bouldus/Glacy 100.
// Lv.4's carrying count is unverified; retain the verified Lv.3 capacity conservatively.
export const HAULING_CAPACITY = Object.freeze({1:60, 2:80, 3:100, 4:100});
const levels = [1, 2, 3, 4];
const headcount = n => Math.max(0, Math.ceil(n - 1e-6));
export const haulingBatchTrips = (recipe, level = 3) => Math.ceil((recipe?.yieldAmount || 1) / HAULING_CAPACITY[level])
    + (recipe?.byproductAmount > 0 ? Math.ceil(recipe.byproductAmount / HAULING_CAPACITY[level]) : 0);

// Estimate one completed batch per pickup group, split over carrying capacity. After storage
// comes the next pickup, weighted by its delivery frequency in the same storage pool.
// Buffer accumulation, pickup animations and dispatch priorities are not verified game rules.
export function haulingWorkload(layout, steps, fallbackSeconds = 0, recipes = []) {
    const recipeOf = new Map(recipes.map(recipe => [recipe.name, recipe]));
    const seconds = {}, jobs = new Map();
    for (const level of levels) {
        const routes = new Map(), pickups = [], pools = new Map();
        for (const member of layout.pieces.flatMap(piece => piece.members)) {
            if (!(member.weight > 0)) continue;
            const storage = nearestStorage(member, layout.storages);
            if (!storage) continue;
            const loaded = Math.hypot(member.x + member.w / 2 - storage.x - storage.w / 2,
                member.y + member.h / 2 - storage.y - storage.h / 2) / ANIIMO_WALK_SPEED;
            const cargo = member.jobs?.map(job => [job.item, job.rate * 3600]) || [[member.crop, member.batchWeight ?? member.weight]];
            const pool = pools.get(storage) || { trips: 0, pickupSeconds: 0 };
            for (const [item, batches] of cargo) {
                const trips = batches * haulingBatchTrips(recipeOf.get(item), level);
                pool.trips += trips;
                pool.pickupSeconds += trips * loaded;
                pickups.push({key:`${member.facility}|${item}`, storage, loaded, trips, batches});
            }
            pools.set(storage, pool);
        }
        for (const pickup of pickups) {
            const pool = pools.get(pickup.storage);
            const route = routes.get(pickup.key) || { batches: 0, seconds: 0 };
            route.batches += pickup.batches;
            route.seconds += pickup.trips * (pickup.loaded + pool.pickupSeconds / pool.trips);
            routes.set(pickup.key, route);
        }
        for (const [key, route] of routes) seconds[`${key}|${level}`] = route.seconds / route.batches;
    }
    for (const step of steps) {
        if (step.status !== 'producing' || !(step.cycle_time > 0)) continue;
        const key = `${step.facility}|${step.item_name}`;
        const costs = Object.fromEntries(levels.map(level => [level,
            seconds[`${key}|${level}`] ?? fallbackSeconds * haulingBatchTrips(recipeOf.get(step.item_name), level)]));
        for (const level of levels) seconds[`${key}|${level}`] = costs[level];
        seconds[key] = costs[3];
        const job = jobs.get(key) || { key, rate: 0, seconds: costs };
        job.rate += (step.busy_units ?? step.facility_count) / step.cycle_time;
        jobs.set(key, job);
    }
    const busyByLevel = Object.fromEntries(levels.map(level => [level,
        [...jobs.values()].reduce((sum, job) => sum + job.rate * job.seconds[level], 0)]));
    return { seconds, busy: busyByLevel[3], busyByLevel, jobs: [...jobs.values()] };
}

// Use couriers' spare hours, then idle copies and neutral Lv.3 reserves. A headcount shortage
// goes to the optimizer, which can redistribute both production and delivery by recipe.
export function allocateHauling(members, busy, required, limit = Infinity) {
    const active = busy.map(headcount);
    let slots = Math.max(0, limit - active.reduce((sum, n) => sum + n, 0));
    const jobs = typeof required === 'number' ? [{rate:required, seconds:{1:1,2:1,3:1,4:1}}] : required.jobs;
    const couriers = members.map((member, index) => ({member,index,level:Math.min(4, member?.abilities.Hauling || 0)}))
        .filter(courier => courier.level > 0).sort((a,b) => b.level - a.level);
    const assigned = new Map();
    let reserveBusy = 0, unassigned = 0;
    for (const job of [...jobs].sort((a,b) => b.seconds[1] / (b.seconds[3] || 1) - a.seconds[1] / (a.seconds[3] || 1))) {
        let remaining = job.rate;
        for (const existingOnly of [true, false]) {
            for (const {member,index,level} of couriers) {
                const used = assigned.get(index) || 0;
                const before = busy[index] + used;
                const capacity = existingOnly ? active[index] : Math.min(member.count, headcount(before) + slots);
                const cost = job.seconds[level];
                if (cost <= 0) { remaining = 0; break; }
                const batches = Math.min(remaining, Math.max(0, capacity - before) / cost);
                const hours = batches * cost;
                if (hours > 1e-12) assigned.set(index, used + hours);
                slots -= Math.max(0, headcount(before + hours) - headcount(before));
                remaining -= batches;
            }
        }
        const hours = Math.min(remaining * job.seconds[3], Math.max(0, headcount(reserveBusy) + slots - reserveBusy));
        if (hours > 0) {
            slots -= headcount(reserveBusy + hours) - headcount(reserveBusy);
            reserveBusy += hours;
            remaining -= hours / job.seconds[3];
        }
        unassigned += Math.max(0, remaining * job.seconds[3]);
    }
    return { assignments:[...assigned], reserveBusy, reserveCount:headcount(reserveBusy), unassigned };
}
