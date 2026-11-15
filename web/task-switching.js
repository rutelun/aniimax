import { nearestStorage } from './layout.js?v=storage-power';
import { workerTravelSeconds } from './worker-travel.js?v=travel-allowance';

export const TASK_SWITCHING = 'Switching between crop work and deliveries';

export function cropStorageDistance(site, storages) {
    const storage = nearestStorage(site, storages);
    return storage ? Math.hypot(site.x + site.w / 2 - storage.x - storage.w / 2,
        site.y + site.h / 2 - storage.y - storage.h / 2) : 0;
}

// Any free courier can take a pickup. Spread those opportunities over available
// couriers and budget one extra leg for a possible handoff at a growing site.
export function cropSwitchingShare(visits, weightedDistance, haulTrips, eligibleCouriers, spare) {
    if (!(visits > 0 && haulTrips > 0 && eligibleCouriers > 0 && spare > 0)) return 0;
    const interruptions = Math.min(visits, haulTrips / eligibleCouriers);
    return Math.min(spare, interruptions * Math.min(spare, 1) * workerTravelSeconds(weightedDistance / visits));
}

export function rosterCropSwitching(layout, routes, members, busy, anchored, haulTrips) {
    if (!(haulTrips > 0) || !routes?.length || !layout.storages?.length) return [];
    const available = members.map((member, i) => {
        if (!member?.abilities.Hauling || !(busy[i] > 0)) return 0;
        const active = Math.max(anchored[i] || 0, Math.ceil(busy[i] - 1e-6));
        return Math.max(0, active - busy[i]);
    });
    const eligible = available.reduce((count, spare) => count + Number(spare > 1e-6), 0);
    if (!eligible) return [];

    const locations = new Map();
    for (const piece of layout.pieces) for (const site of piece.members) {
        if ((site.facility !== 'Farmland' && site.facility !== 'Woodland') || !site.crop) continue;
        const key = `${site.facility}|${site.crop}`;
        const data = locations.get(key) || { distance: 0, sites: 0 };
        data.distance += cropStorageDistance(site, layout.storages);
        data.sites++;
        locations.set(key, data);
    }
    const profiles = members.map(() => ({ visits: 0, distance: 0 }));
    for (const route of routes) {
        if (!(route.crop_visits > 0 && available[route.member] > 1e-6)) continue;
        const site = locations.get(`${route.facility}|${route.item}`);
        if (!site) continue;
        profiles[route.member].visits += route.crop_visits;
        profiles[route.member].distance += route.crop_visits * site.distance / site.sites;
    }
    return profiles.flatMap(({ visits, distance }, member) => {
        const share = cropSwitchingShare(visits, distance, haulTrips, eligible, available[member]);
        return share > 1e-9 ? [[member, share]] : [];
    });
}
