import { nearestStorage } from './layout.js?v=optional-worker-travel';
import { ANIIMO_WALK_SPEED, workerTravelSeconds } from './worker-travel.js?v=travel-allowance';
import facilityStock from './facility-stock.json' with { type: 'json' };

// Hauling capacity from Skippy, Fenrier, Glacy and Prismana Glacy's Homeland profiles.
export const HAULING_CAPACITY = Object.freeze({1:60, 2:80, 3:100, 4:120});
const levels = [1, 2, 3, 4];
const headcount = n => Math.max(0, Math.ceil(n - 1e-6));
export const haulingTravelSeconds = (distance, accountForTravel = false) =>
    2 * (accountForTravel ? workerTravelSeconds(distance) : distance / ANIIMO_WALK_SPEED);
export const haulingWorkSeconds = (distance, accountForTravel = false) =>
    2 * haulingTravelSeconds(distance, accountForTravel);
const batchOutput = recipe => Math.max(1, recipe?.yieldAmount || 1) + Math.max(0, recipe?.byproductAmount || 0);
export const facilityStockLimit = (facility, level = 1) =>
    facilityStock[facility]?.[Math.max(1, level) - 1] ?? facilityStock[facility]?.at(-1) ?? 0;

export function bufferedBatches(recipe, limit = 0, facility) {
    // A crop can finish a harvest while below its item limit. Quick Aromathyst has been
    // observed to leave Dewy House after three batches, before local storage fills.
    if (recipe?.name === 'quick_aromathyst') limit = Math.min(limit, 36);
    const batches = limit / batchOutput(recipe);
    return Math.max(1, facility === 'Farmland' || facility === 'Woodland' ? Math.ceil(batches) : Math.floor(batches));
}

export function haulingBatchTrips(recipe, level = 3, limit = 0, facility) {
    const batches = bufferedBatches(recipe, limit, facility);
    return Math.ceil(batchOutput(recipe) * batches / HAULING_CAPACITY[level]) / batches;
}

export function assignFacilityStock(members, facilities, recipeOf) {
    const byFacility = new Map();
    for (const member of members) {
        if (!(member.weight > 0) || !facilityStock[member.facility]) continue;
        const recipes = member.jobs?.map(job => job.item) ?? [member.crop];
        const required = Math.max(1, ...recipes.map(item => recipeOf.get(item)?.facility_level ?? 1));
        if (!byFacility.has(member.facility)) byFacility.set(member.facility, []);
        byFacility.get(member.facility).push({ member, required });
    }
    for (const [facility, placements] of byFacility) {
        const tiers = (facilities?.[facility] ?? []).map(tier => ({ ...tier })).sort((a, b) => a.level - b.level);
        placements.sort((a, b) => Number(b.member.electric_level != null) - Number(a.member.electric_level != null)
            || b.required - a.required);
        for (const { member, required } of placements) {
            const powered = member.electric_level;
            const tier = tiers.find(t => t.count > 0 && (powered != null ? t.level === powered : t.level >= required));
            if (tier) tier.count--;
            member.stockLimit = facilityStockLimit(facility, powered ?? tier?.level ?? required);
        }
    }
}

// A machine switching recipes does not fill a separate full buffer for each.
export const pickupStockLimit = member => member.jobs?.length > 1 ? 0 : member.stockLimit ?? 0;

function fallbackTrips(step, recipe, level, facilities) {
    const tiers = (facilities?.[step.facility] ?? []).filter(tier => tier.count > 0 && (step.electric_level != null
        ? tier.level === step.electric_level : tier.level >= (recipe?.facility_level ?? 1)));
    return tiers.length ? Math.max(...tiers.map(tier =>
        haulingBatchTrips(recipe, level, facilityStockLimit(step.facility, tier.level), step.facility))) : haulingBatchTrips(recipe, level);
}

// Accumulate whole batches in the building's output buffer, then split the
// pickup over carrying capacity. An oversized harvest still needs all its trips. After storage
// comes the next pickup, weighted by its delivery frequency in the same storage pool.
// Pickup thresholds are estimates. Fallback seconds already include the time allowance.
export function haulingWorkload(layout, steps, fallbackSeconds = 0, recipes = [], facilities = null, accountForTravel = false) {
    const recipeOf = new Map(recipes.map(recipe => [recipe.name, recipe]));
    const seconds = {}, tripsPerBatch = {}, jobs = new Map(), tripSites = [];
    for (const level of levels) {
        const routes = new Map(), pickups = [], pools = new Map();
        for (const member of layout.pieces.flatMap(piece => piece.members)) {
            if (!(member.weight > 0)) continue;
            const storage = nearestStorage(member, layout.storages);
            if (!storage) continue;
            const distance = Math.hypot(member.x + member.w / 2 - storage.x - storage.w / 2,
                member.y + member.h / 2 - storage.y - storage.h / 2);
            const loaded = haulingWorkSeconds(distance, accountForTravel);
            const cargo = member.jobs?.map(job => [job.item, job.rate * 3600]) || [[member.crop, member.batchWeight ?? member.weight]];
            const pool = pools.get(storage) || { trips: 0, pickupSeconds: 0 };
            for (const [item, batches] of cargo) {
                const trips = batches * haulingBatchTrips(recipeOf.get(item), level, pickupStockLimit(member), member.facility);
                pool.trips += trips;
                pool.pickupSeconds += trips * loaded;
                pickups.push({key:`${member.facility}|${item}`, storage, loaded, trips, batches});
                if (level === 3) tripSites.push({
                    point: [member.x + member.w / 2, member.y + member.h / 2],
                    returnFrom: [storage.x + storage.w / 2, storage.y + storage.h / 2],
                    rate: trips / 3600,
                });
            }
            pools.set(storage, pool);
        }
        for (const pickup of pickups) {
            const pool = pools.get(pickup.storage);
            const route = routes.get(pickup.key) || { batches: 0, seconds: 0, trips: 0 };
            route.batches += pickup.batches;
            route.trips += pickup.trips;
            route.seconds += pickup.trips * (pickup.loaded + pool.pickupSeconds / pool.trips);
            routes.set(pickup.key, route);
        }
        for (const [key, route] of routes) {
            seconds[`${key}|${level}`] = route.seconds / route.batches;
            if (level === 3) tripsPerBatch[key] = route.trips / route.batches;
        }
    }
    for (const step of steps) {
        if (step.status !== 'producing' || !(step.cycle_time > 0)) continue;
        const key = `${step.facility}|${step.item_name}`;
        const costs = Object.fromEntries(levels.map(level => [level,
            seconds[`${key}|${level}`] ?? fallbackSeconds * fallbackTrips(step, recipeOf.get(step.item_name), level, facilities)]));
        for (const level of levels) seconds[`${key}|${level}`] = costs[level];
        seconds[key] = costs[3];
        const trips = tripsPerBatch[key] ?? fallbackTrips(step, recipeOf.get(step.item_name), 3, facilities);
        const job = jobs.get(key) || { key, rate: 0, seconds: costs, trips };
        job.rate += (step.busy_units ?? step.facility_count) / step.cycle_time;
        jobs.set(key, job);
    }
    const busyByLevel = Object.fromEntries(levels.map(level => [level,
        [...jobs.values()].reduce((sum, job) => sum + job.rate * job.seconds[level], 0)]));
    const trips = [...jobs.values()].reduce((sum, job) => sum + job.rate * job.trips, 0);
    return { seconds, busy: busyByLevel[3], busyByLevel, trips, tripSites, jobs: [...jobs.values()] };
}

// Use couriers' spare hours, then idle copies and neutral Lv.3 reserves. A headcount shortage
// goes to the optimizer, which can redistribute both production and delivery by recipe.
export function allocateHauling(members, busy, required, limit = Infinity, anchored = [], switching = []) {
    const active = busy.map((load, member) => Math.max(anchored[member] ?? 0, headcount(load)));
    let slots = Math.max(0, limit - active.reduce((sum, n) => sum + n, 0));
    const jobs = typeof required === 'number' ? [{rate:required, seconds:{1:1,2:1,3:1,4:1}}] : required.jobs;
    const couriers = members.map((member, index) => ({member,index,level:Math.min(4, member?.abilities.Hauling || 0),
        versatility: Object.values(member?.abilities ?? {}).filter(level => level > 0).length}))
        .filter(courier => courier.level > 0).sort((a,b) => b.level - a.level
            || Number(switching[a.index] > 0) - Number(switching[b.index] > 0) || b.versatility - a.versatility);
    const assigned = new Map();
    let reserveBusy = 0, unassigned = 0;
    for (const job of [...jobs].sort((a,b) => b.seconds[1] / (b.seconds[3] || 1) - a.seconds[1] / (a.seconds[3] || 1))) {
        let remaining = job.rate;
        for (const existingOnly of [true, false]) {
            for (const {member,index,level} of couriers) {
                const used = assigned.get(index) || 0;
                const before = busy[index] + used;
                const alreadyWorking = Math.max(active[index], headcount(before));
                const capacity = existingOnly ? active[index] : Math.min(member.count, alreadyWorking + slots);
                const cost = job.seconds[level];
                if (cost <= 0) { remaining = 0; break; }
                const batches = Math.min(remaining, Math.max(0, capacity - before) / cost);
                const hours = batches * cost;
                if (hours > 1e-12) assigned.set(index, used + hours);
                slots -= Math.max(0, headcount(before + hours) - alreadyWorking);
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
