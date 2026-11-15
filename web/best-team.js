import catalog from './aniimo-catalog.json' with { type: 'json' };
import { opposedPersonality } from './facility-config.js?v=leisure-families';
import { workerTravelSeconds } from './worker-travel.js?v=travel-allowance';
import { cropStorageDistance, cropSwitchingShare, TASK_SWITCHING } from './task-switching.js?v=opportunistic-jobs';

const EPSILON = 1e-6;
const roleKey = ({ ability, level, family }) => `${ability}|${level}|${family || ''}`;

function indexCatalog(entries) {
    const index = new Map();
    for (const entry of entries) {
        for (const [ability, level] of Object.entries(entry.abilities)) {
            for (let min = 1; min <= level; min++) {
                const families = ability === 'Leisure' && entry.family ? ['', entry.family] : [''];
                for (const family of families) {
                    const key = roleKey({ ability, level: min, family });
                    if (!index.has(key)) index.set(key, new Set());
                    index.get(key).add(entry);
                }
            }
        }
    }
    return index;
}

const catalogIndex = indexCatalog(catalog.entries);
const noMatches = new Set();

export function placeBestJobs(jobs, layout) {
    if (!layout) return jobs;
    const sites = new Map();
    for (const piece of layout.pieces) for (const member of piece.members) {
        const point = [member.x + member.w / 2, member.y + member.h / 2];
        const cropDistance = member.facility === 'Farmland' || member.facility === 'Woodland'
            ? cropStorageDistance(member, layout.storages || []) : 0;
        for (const job of member.jobs ?? [{ item: member.crop, rate: member.batchWeight ?? member.weight, electric_level: member.electric_level }]) {
            if (!job.item || job.electric_level != null || !(job.rate > 0)) continue;
            const key = `${member.facility}|${job.item}`;
            if (!sites.has(key)) sites.set(key, []);
            sites.get(key).push({ point, rate: job.rate, cropDistance });
        }
    }
    return jobs.flatMap(job => {
        const locations = sites.get(job.siteKey);
        if (!locations) return [job];
        const total = locations.reduce((sum, site) => sum + site.rate, 0);
        return locations.map(({ point, rate, cropDistance }) => ({ ...job, point, cropDistance, busy: job.busy * rate / total }));
    });
}

export function recommendBestTeam(jobs, haulingBusy = 0, haulTrips = 0) {
    const shifts = [];
    const available = [];
    const haul = { ability: 'Hauling', level: 3, label: 'Hauling to Storage Units' };
    const matches = job => catalogIndex.get(roleKey(job)) ?? noMatches;
    const outsideCrops = new Set(jobs.filter(job => !job.growing && !job.fixed).map(job => job.ability));
    if (haulingBusy > EPSILON) outsideCrops.add('Hauling');
    const candidateFor = shift => {
        let best;
        let lowest = Infinity;
        for (const entry of shift.candidates) {
            const skills = Object.keys(entry.abilities);
            let excess = 0;
            for (const role of shift.roles.values()) excess += entry.abilities[role.ability] - role.level;
            const distractions = shift.cropVisits ? skills.filter(skill => outsideCrops.has(skill)).length : 0;
            const value = excess * 100 + distractions * 10 - skills.length;
            if (value < lowest) {
                best = entry;
                lowest = value;
            }
        }
        return best;
    };
    const compatible = (shift, job, candidates) => {
        if (job.personality && shift.personalities.has(opposedPersonality(job.personality))) return null;
        if (shift.roles.has(roleKey(job))) return shift.candidates;
        if (!shift.candidates.size || !candidates.size) return null;
        return new Set([...shift.candidates].filter(entry => candidates.has(entry)));
    };
    const walkingPerShare = (shift, job) => {
        if (!shift.point || !job.point || !job.visitsPerShare) return 0;
        const distance = Math.hypot(shift.point[0] - job.point[0], shift.point[1] - job.point[1]);
        return 2 * workerTravelSeconds(distance) * job.visitsPerShare;
    };
    const add = (shift, job, share, walking = 0) => {
        shift.point ||= job.point;
        shift.busy += share + walking;
        if (job.personality) shift.personalities.add(job.personality);
        const key = roleKey(job);
        if (!shift.roles.has(key)) shift.roles.set(key, job);
        shift.tasks.set(job.label, (shift.tasks.get(job.label) || 0) + share);
        if (job.growing) {
            const visits = share * (job.visitsPerShare || 0);
            shift.cropVisits += visits;
            shift.cropDistance += visits * (job.cropDistance || 0);
        }
        if (walking > 0) {
            const label = 'Walking between jobs';
            shift.tasks.set(label, (shift.tasks.get(label) || 0) + walking);
        }
    };
    const place = (job, busy) => {
        const candidates = matches(job);
        while (busy > EPSILON) {
            let share = Math.min(1, busy);
            let best;
            let narrowed;
            let bestWalking = 0;
            let partial;
            let partialCandidates;
            let partialCapacity = 0;
            let partialWalking = 0;
            for (const shift of available) {
                if (share === 1 || 1 - shift.busy <= EPSILON) continue;
                const common = compatible(shift, job, candidates);
                if (common == null || (common.size === 0 && !shift.roles.has(roleKey(job)))) continue;
                const walking = walkingPerShare(shift, job);
                const capacity = (1 - shift.busy) / (1 + walking);
                if (capacity < share - EPSILON) {
                    if (walking > EPSILON && Boolean(job.growing) !== Boolean(shift.cropVisits)) continue;
                    if (capacity > Math.max(EPSILON, partialCapacity)) {
                        partial = shift;
                        partialCandidates = common;
                        partialCapacity = capacity;
                        partialWalking = walking;
                    }
                    continue;
                }
                if (!best || walking < bestWalking || (walking === bestWalking && shift.busy > best.busy)) {
                    best = shift;
                    narrowed = common;
                    bestWalking = walking;
                }
            }
            if (!best && partial) {
                best = partial;
                narrowed = partialCandidates;
                share = partialCapacity;
                bestWalking = partialWalking;
            }
            if (!best) {
                best = { busy: 0, candidates, roles: new Map(), tasks: new Map(), personalities: new Set(),
                    cropVisits: 0, cropDistance: 0 };
                shifts.push(best);
                if (share < 1 - EPSILON) available.push(best);
            } else {
                best.candidates = narrowed;
            }
            add(best, job, share, share * bestWalking);
            busy -= share;
        }
    };

    // Every resident or environment post arrives as a whole shift. Flexible work gets
    // the most restrictive jobs first, leaving each shift open to every compatible form.
    const roles = [...jobs].sort((a, b) => matches(a).size - matches(b).size || b.busy - a.busy);
    for (const job of roles) place(job, job.busy);

    let haulingSpare = 0;
    const courierForms = matches(haul);
    const couriers = available.map(shift => ({ shift, eligible: compatible(shift, haul, courierForms) }))
        .filter(({ shift, eligible }) => eligible?.size && shift.busy < 1 - EPSILON)
        .sort((a, b) => Number(a.shift.cropVisits > 0) - Number(b.shift.cropVisits > 0));
    const currentCouriers = new Set(haulTrips > 0
        ? available.filter(shift => shift.busy < 1 - EPSILON && candidateFor(shift)?.abilities.Hauling > 0) : []);
    const eligibleCouriers = Math.max(couriers.length, currentCouriers.size);
    const reserveSwitching = shift => {
        const spare = Math.max(0, 1 - shift.busy);
        const share = cropSwitchingShare(shift.cropVisits, shift.cropDistance, haulTrips, eligibleCouriers, spare);
        if (share > EPSILON) {
            shift.busy += share;
            shift.tasks.set(TASK_SWITCHING, share);
            return spare - share;
        }
        return spare;
    };
    currentCouriers.forEach(reserveSwitching);
    for (const { shift, eligible } of couriers) {
        let spare = Math.max(0, 1 - shift.busy);
        haulingSpare += spare;
        if (haulingBusy <= EPSILON || spare <= EPSILON) continue;
        if (!currentCouriers.has(shift)) {
            const original = spare;
            spare = reserveSwitching(shift);
            if (spare <= EPSILON) {
                // The extra workload belongs to an Aniimo able to take that delivery.
                shift.tasks.delete(TASK_SWITCHING);
                shift.busy -= original - spare;
                continue;
            }
        }
        const load = Math.min(spare, haulingBusy);
        if (load <= EPSILON) continue;
        shift.candidates = eligible;
        add(shift, haul, load);
        haulingBusy -= load;
    }
    place(haul, haulingBusy);

    return {
        haulingSpare,
        shifts: shifts.map(pool => {
            const { candidates, roles, cropVisits, cropDistance, ...shift } = pool;
            const requirements = [...roles.values()];
            const entry = candidateFor(pool);
            const abilities = entry?.abilities ?? Object.fromEntries(requirements.map(role => [role.ability, role.level]));
            return { ...shift, entry, abilities, family: entry?.family ?? requirements.find(role => role.family)?.family ?? null };
        }),
    };
}
