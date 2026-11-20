import { workerTravelSeconds } from './worker-travel.js?v=logic-audit';

export const TASK_SWITCHING = 'Switching between available jobs';
const pointOf = site => [site.x + site.w / 2, site.y + site.h / 2];
const locationKey = (facility, item) => `${facility}|${item}`;

export function dispatchLocations(layout) {
    const locations = new Map();
    for (const piece of layout.pieces) for (const site of piece.members) {
        const point = pointOf(site);
        const outputs = site.jobs ?? [{ item: site.crop, rate: (site.batchWeight ?? site.weight) / 3600,
            electric_level: site.electric_level }];
        for (const output of outputs) {
            if (!output.item || output.electric_level != null || !(output.rate > 0)) continue;
            const key = locationKey(site.facility, output.item);
            if (!locations.has(key)) locations.set(key, []);
            locations.get(key).push({ point, rate: output.rate, cycle:output.cycle??site.cycle, facility: site.facility, item: output.item });
        }
    }
    return locations;
}

export function buildDispatch(layout, recipes, hauling, residentFacilities) {
    const locations = dispatchLocations(layout);
    const byItem = new Map(recipes.map(recipe => [locationKey(recipe.facility, recipe.name), recipe]));
    const opportunities = [];
    for (const [key, sites] of locations) {
        const recipe = byItem.get(key);
        if (!recipe || residentFacilities.has(recipe.facility)) continue;
        const requirements = recipe.aniimo ? [recipe.aniimo] : (recipe.jobs || []).map(([, ability, level]) => [ability, level]);
        for (const site of sites) for (const [ability, level] of requirements) {
            opportunities.push({ ...site, ability, level, family: ability === 'Leisure' ? recipe.family : null });
        }
    }
    if (hauling?.trips > 0 && layout.storages?.length) {
        const stops = hauling.tripSites?.length ? hauling.tripSites
            : layout.storages.map(storage => ({ point: pointOf(storage), rate: hauling.trips / layout.storages.length }));
        for (const stop of stops) opportunities.push({ ...stop, ability: 'Hauling', level: 1 });
    }
    return { locations, opportunities };
}

function describeHomes(homes) {
    const summary = { rate: 0, sites: new Map() };
    for (const { point, rate } of homes || []) {
        if (!(rate > 0)) continue;
        summary.rate += rate;
        const key = point.join(',');
        const site = summary.sites.get(key) || { point, rate: 0 };
        site.rate += rate;
        summary.sites.set(key, site);
    }
    return summary;
}

// Model each new request as going to any eligible free Aniimo. Time here is
// extra travel to an unplanned destination and back to a planned work area.
export function estimateJobSwitching(opportunities, workers) {
    const homes = workers.map(worker => describeHomes(worker.homes));
    const found = workers.map(() => ({ arrivals: 0, distance: 0 }));
    if (!homes.some(home => home.rate > 0)) return workers.map(() => 0);
    const eligibility = new Map();
    for (const { ability, level, family, point, returnFrom = point, rate } of opportunities || []) {
        const key = `${ability}|${level}|${family || ''}`;
        if (!eligibility.has(key)) {
            const eligible = [];
            let total = 0;
            workers.forEach((worker, i) => {
                const free = worker.free;
                if (!(free > 0) || !(worker.abilities?.[ability] >= level) || (family && worker.family !== family)) return;
                eligible.push([i, free]);
                total += free;
            });
            eligibility.set(key, { eligible, total });
        }
        const { eligible, total } = eligibility.get(key);
        const site = point.join(',');
        for (const [i, free] of eligible) {
            const home = homes[i];
            if (!home.rate || (home.sites.has(site) && point === returnFrom)) continue;
            const arrivals = rate * free / total;
            // At dispatch the worker is still at its previous activity. Average over
            // those actual sites, rather than assuming a worker is waiting at a midpoint.
            let distance = 0;
            for (const previous of home.sites.values()) {
                distance += previous.rate * (
                    Math.hypot(point[0] - previous.point[0], point[1] - previous.point[1])
                    + Math.hypot(returnFrom[0] - previous.point[0], returnFrom[1] - previous.point[1]));
            }
            found[i].arrivals += arrivals;
            found[i].distance += arrivals * distance / home.rate;
        }
    }
    return found.map(({ arrivals, distance }, i) => {
        if (!arrivals) return 0;
        const trips = Math.min(arrivals, homes[i].rate);
        return Math.min(workers[i].spare, trips * workerTravelSeconds(distance / arrivals));
    });
}

export function rosterJobSwitching(dispatch, routes, members, busy, anchored) {
    if (!routes?.length) return [];
    const workers = members.map((member, i) => {
        const active = Math.max(anchored[i] || 0, Math.ceil(busy[i] - 1e-6));
        const count = member.assumed ? active : member.count;
        return { abilities: member.abilities, family: member.family,
            free: Math.max(0, count - busy[i]), spare: Math.max(0, active - busy[i]), homes: [] };
    });
    for (const route of routes) {
        if (!(route.job_rate > 0) || !workers[route.member]?.spare) continue;
        const sites = dispatch.locations.get(locationKey(route.facility, route.item));
        if (!sites) continue;
        const total = sites.reduce((sum, site) => sum + site.rate, 0);
        for (const { point, rate } of sites) workers[route.member].homes.push({ point, rate: route.job_rate * rate / total });
    }
    return estimateJobSwitching(dispatch.opportunities, workers).flatMap((share, member) => share > 1e-9 ? [[member, share]] : []);
}
