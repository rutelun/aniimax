import { nearestStorage } from './layout.js?v=logic-audit';
import { ANIIMO_WALK_SPEED, workerTravelSeconds } from './worker-travel.js?v=logic-audit';
import facilityStock from './facility-stock.json' with { type: 'json' };
import { deliveryRouting } from './delivery-routing.js';

// Hauling capacity from Skippy, Fenrier, Glacy and Prismana Glacy's Homeland profiles.
export const HAULING_CAPACITY = Object.freeze({1:60, 2:80, 3:100, 4:120});
export const haulingLevelFor = setup => setup?.startsWith('best') ? 4 : setup === 'minimum' ? 1 : 3;
export const HAULING_PICKUP_FILL = .4;
const levels = [1, 2, 3, 4];
const headcount = n => Math.max(0, Math.ceil(n - 1e-6));
export const haulingTravelSeconds = (distance, accountForTravel = false) =>
    accountForTravel ? workerTravelSeconds(distance) : distance / ANIIMO_WALK_SPEED;
export const haulingWorkSeconds = (distance, accountForTravel = false) =>
    haulingTravelSeconds(distance, accountForTravel);
const batchOutput = recipe => Math.max(1, recipe?.yieldAmount || 1) + Math.max(0, recipe?.byproductAmount || 0);
export const facilityStockLimit = (facility, level = 1) =>
    facilityStock[facility]?.[Math.max(1, level) - 1] ?? facilityStock[facility]?.at(-1) ?? 0;

export function bufferedBatches(recipe, limit = 0, facility) {
    // Model pickup readiness at 40% of the supplied output-buffer limit, rounded up
    // to a completed batch. This is a modelling assumption, not an input-buffer rule.
    const threshold = limit * HAULING_PICKUP_FILL;
    return Math.max(1, Math.ceil(threshold / batchOutput(recipe)));
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
// comes the next pickup, weighted by its delivery frequency across all storage groups.
// Pickup thresholds are estimates. Each leg uses base speed; fallback seconds cover the full route.
export function haulingWorkload(layout, steps, fallbackSeconds = 0, recipes = [], facilities = null, accountForTravel = false, courierLevel = 3) {
    const recipeOf = new Map(recipes.map(recipe => [recipe.name, recipe]));
    const seconds = {}, tripsPerBatch = {}, jobs = new Map(), tripSites = [];
    for (const level of levels) {
        const routes = new Map(), pickups = [];
        for (const member of layout.pieces.flatMap(piece => piece.members)) {
            if (!(member.weight > 0)) continue;
            const storage = nearestStorage(member, layout.storages);
            if (!storage) continue;
            const distance = Math.hypot(member.x + member.w / 2 - storage.x - storage.w / 2,
                member.y + member.h / 2 - storage.y - storage.h / 2);
            const loaded = haulingWorkSeconds(distance, accountForTravel);
            const cargo = member.jobs?.map(job => [job.item, job.rate * 3600]) || [[member.crop, member.batchWeight ?? member.weight]];
            for (const [item, batches] of cargo) {
                const trips = batches * haulingBatchTrips(recipeOf.get(item), level, pickupStockLimit(member), member.facility);
                pickups.push({key:`${member.facility}|${item}`, member, storage, loaded, trips, batches});
                if (level === courierLevel) tripSites.push({
                    point: [member.x + member.w / 2, member.y + member.h / 2],
                    returnFrom: [storage.x + storage.w / 2, storage.y + storage.h / 2],
                    rate: trips / 3600,
                });
            }
        }
        const flow=deliveryRouting({storages:layout.storages,pieces:[{members:pickups.map(p=>({
            x:p.member.x,y:p.member.y,w:p.member.w,h:p.member.h,weight:p.trips}))}]});
        for (const [index,pickup] of pickups.entries()) {
            const route = routes.get(pickup.key) || { batches: 0, seconds: 0, trips: 0 };
            route.batches += pickup.batches;
            route.trips += pickup.trips;
            route.seconds += pickup.trips * (pickup.loaded + haulingWorkSeconds(flow.arrivals[index].approach,accountForTravel));
            routes.set(pickup.key, route);
        }
        for (const [key, route] of routes) {
            seconds[`${key}|${level}`] = route.seconds / route.batches;
            if (level === courierLevel) tripsPerBatch[key] = route.trips / route.batches;
        }
    }
    for (const step of steps) {
        if (step.status !== 'producing' || !(step.cycle_time > 0)) continue;
        const key = `${step.facility}|${step.item_name}`;
        const costs = Object.fromEntries(levels.map(level => [level,
            seconds[`${key}|${level}`] ?? fallbackSeconds * fallbackTrips(step, recipeOf.get(step.item_name), level, facilities)]));
        for (const level of levels) seconds[`${key}|${level}`] = costs[level];
        seconds[key] = costs[courierLevel];
        const trips = tripsPerBatch[key] ?? fallbackTrips(step, recipeOf.get(step.item_name), courierLevel, facilities);
        const job = jobs.get(key) || { key, rate: 0, seconds: costs, trips };
        job.rate += (step.busy_units ?? step.facility_count) / step.cycle_time;
        jobs.set(key, job);
    }
    const busyByLevel = Object.fromEntries(levels.map(level => [level,
        [...jobs.values()].reduce((sum, job) => sum + job.rate * job.seconds[level], 0)]));
    const trips = [...jobs.values()].reduce((sum, job) => sum + job.rate * job.trips, 0);
    return { seconds, courierLevel, busy: busyByLevel[courierLevel], busyByLevel, trips, tripSites, jobs: [...jobs.values()] };
}

// Use couriers' spare hours, then idle copies and neutral Lv.3 reserves. A headcount shortage
// goes to the optimizer, which can redistribute both production and delivery by recipe.
export function allocateHauling(members, busy, required, limit = Infinity, anchored = [], switching = [], growers = new Set()) {
    const active = busy.map((load, member) => Math.max(anchored[member] ?? 0, headcount(load)));
    let slots = Math.max(0, limit - active.reduce((sum, n) => sum + n, 0));
    const jobs = typeof required === 'number' ? [{rate:required, seconds:{1:1,2:1,3:1,4:1}}] : required.jobs;
    const couriers = members.map((member, index) => ({member,index,level:Math.min(4, member?.abilities.Hauling || 0),
        versatility: Object.values(member?.abilities ?? {}).filter(level => level > 0).length}))
        .filter(courier => courier.level > 0).sort((a,b) => b.level - a.level
            || Number(switching[a.index] > 0) - Number(switching[b.index] > 0) || b.versatility - a.versatility);
    const assigned = new Map();
    const dedicated = new Map();
    const regularCouriers = couriers.filter(({ index }) => !growers.has(index));
    const growerCouriers = couriers.filter(({ index }) => growers.has(index));
    let reserveBusy = 0, unassigned = 0;
    for (const job of [...jobs].sort((a,b) => b.seconds[1] / (b.seconds[3] || 1) - a.seconds[1] / (a.seconds[3] || 1))) {
        let remaining = job.rate;
        const assignCouriers = (eligible, existingOnly, separateCopies = false) => {
            const hoursByMember = separateCopies ? dedicated : assigned;
            for (const {member,index,level} of eligible) {
                if (remaining <= 0) return;
                const used = hoursByMember.get(index) || 0;
                const before = (separateCopies ? active[index] : busy[index]) + used;
                const alreadyWorking = Math.max(active[index], headcount(before));
                const maximum = member.count - (separateCopies ? 0 : headcount(dedicated.get(index) || 0));
                const capacity = Math.min(maximum, existingOnly ? active[index] : alreadyWorking + slots);
                const cost = job.seconds[level];
                if (cost <= 0) { remaining = 0; return; }
                const batches = Math.min(remaining, Math.max(0, capacity - before) / cost);
                const hours = batches * cost;
                if (hours > 1e-12) hoursByMember.set(index, used + hours);
                slots -= Math.max(0, headcount(before + hours) - alreadyWorking);
                remaining -= batches;
            }
        };
        assignCouriers(regularCouriers, true);
        assignCouriers(regularCouriers, false);
        assignCouriers(growerCouriers, false, true);
        const hours = Math.min(remaining * job.seconds[3], Math.max(0, headcount(reserveBusy) + slots - reserveBusy));
        if (hours > 0) {
            slots -= headcount(reserveBusy + hours) - headcount(reserveBusy);
            reserveBusy += hours;
            remaining -= hours / job.seconds[3];
        }
        // A separate courier is worth an extra slot if it keeps a grower near the crops.
        // A tight headcount may still need that grower's help to sustain the same output.
        assignCouriers(growerCouriers, true);
        unassigned += Math.max(0, remaining * job.seconds[3]);
    }
    return { assignments:[...assigned], dedicated:[...dedicated], reserveBusy, reserveCount:headcount(reserveBusy), unassigned };
}
