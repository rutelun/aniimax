import catalog from './aniimo-catalog.json' with { type: 'json' };
import { opposedPersonality } from './facility-config.js?v=leisure-families';
import { workerTravelSeconds } from './worker-travel.js?v=logic-audit';
import { dispatchLocations, estimateJobSwitching, TASK_SWITCHING } from './task-switching.js?v=base-travel';
import {splitPhaseTasks} from './phase-work.js';

const EPSILON = 1e-6;
const roleKey = ({ ability, level, family }) => `${ability}|${level}|${family || ''}`;

function indexCatalog(entries) {
    const index = new Map();
    for (const entry of entries) {
        for (const [ability, level] of Object.entries(entry.abilities)) {
            // A faster perfumer changes the recipe's share of the available flowers.
            for (let min = ability === 'Perfumery' ? level : 1; min <= level; min++) {
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

export function placeBestJobs(jobs, layout, sites) {
    if (!layout) return jobs;
    sites ??= dispatchLocations(layout);
    return jobs.flatMap(job => {
        const locations = sites.get(job.siteKey);
        if (!locations) return [job];
        const total = locations.reduce((sum, site) => sum + site.rate, 0);
        return locations.map(({ point, rate }) => ({ ...job, point, busy: job.busy * rate / total }));
    });
}

export function recommendBestTeam(jobs, haulingBusy = 0, dispatch = [], options = {}) {
    jobs = jobs.map(job => job.ability === 'Perfumery' && !job.personality
        ? {...job, personality: opposedPersonality('Instinctive')} : job);
    const phases=Math.max(options.haulingProfile?.length||0,...jobs.map(j=>j.profile?.length||0));
    const profile=job=>job.profile||Array(phases).fill(1);
    const spareFor=(shift,job)=>Math.max(0,Math.min(1-shift.busy,...profile(job).map((factor,i)=>factor>0?(1-(shift.phaseBusy?.[i]||0))/factor:Infinity)));
    const shifts = [];
    const available = [];
    const haul = { ability: 'Hauling', level: options.haulingLevel||3, label: 'Hauling to Storage Units', profile:options.haulingProfile };
    const matches = job => catalogIndex.get(roleKey(job)) ?? noMatches;
    const outsideCrops = new Map();
    for (const job of jobs.filter(job => !job.growing && !job.fixed && job.busy > EPSILON)) {
        outsideCrops.set(job.ability, Math.min(job.level, outsideCrops.get(job.ability) ?? Infinity));
    }
    if (haulingBusy > EPSILON) outsideCrops.set('Hauling', 1);
    const candidateFor = shift => {
        let best;
        let lowest = Infinity;
        for (const entry of shift.candidates) {
            const skills = Object.keys(entry.abilities);
            let excess = 0;
            for (const role of shift.roles.values()) excess += entry.abilities[role.ability] - role.level;
            const distractions = shift.growing ? skills.filter(skill => entry.abilities[skill] >= outsideCrops.get(skill)).length : 0;
            const value = distractions * 1000 + (shift.growing ? -excess : excess) * 100 - skills.length;
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
    const walkingFor = (shift, job, share) => {
        if (!job.point || !job.visitsPerShare || !share) return 0;
        let rate=0,travel=0;
        for(const home of shift.homes){
            rate+=home.rate;
            travel+=home.rate*workerTravelSeconds(Math.hypot(home.point[0]-job.point[0],home.point[1]-job.point[1]));
        }
        if(!rate)return 0;
        const added=share*job.visitsPerShare;
        // Ordered origin/destination pairs, weighted by request frequency.
        // No compulsory return to the first workplace after every job.
        return Math.max(0,added*(2*travel-(shift.walking||0))/(rate+added));
    };
    const add = (shift, job, share, walking = 0) => {
        shift.point ||= job.point;
        shift.busy += share + walking;
        if(phases){shift.phaseBusy ||= Array(phases).fill(0);profile(job).forEach((factor,i)=>shift.phaseBusy[i]+=(share+walking)*factor);}
        shift.walking = (shift.walking || 0) + walking;
        shift.allocations.push({ ...job, busy: share + walking });
        if (job.personality) shift.personalities.add(job.personality);
        const key = roleKey(job);
        if (!shift.roles.has(key)) shift.roles.set(key, job);
        shift.tasks.set(job.label, (shift.tasks.get(job.label) || 0) + share);
        const rate = share * (job.visitsPerShare || 0);
        if (job.point && rate > 0) shift.homes.push({ point: job.point, rate });
        if (walking > 0) {
            const label = 'Walking between jobs';
            shift.tasks.set(label, (shift.tasks.get(label) || 0) + walking);
        }
    };
    const place = (job, busy, reuse = true) => {
        const candidates = matches(job);
        while (busy > EPSILON) {
            let share = Math.min(1, busy,1/Math.max(1,...profile(job)));
            let best;
            let narrowed;
            let bestWalking = 0;
            let partial;
            let partialCandidates;
            let partialCapacity = 0;
            let partialWalking = 0;
            for (const shift of reuse && !job.fixed ? available : []) {
                if (1 - shift.busy <= EPSILON) continue;
                if (shift.growing !== Boolean(job.growing)) continue;
                const common = compatible(shift, job, candidates);
                if (common == null || (common.size === 0 && !shift.roles.has(roleKey(job)))) continue;
                const spare = spareFor(shift,job);
                let capacity = Math.min(share,spare);
                if(capacity+walkingFor(shift,job,capacity)>spare){
                    let low=0,high=capacity;
                    for(let i=0;i<24;i++){
                        const mid=(low+high)/2;
                        if(mid+walkingFor(shift,job,mid)<=spare)low=mid;else high=mid;
                    }
                    capacity=low;
                }
                const walking=capacity>0?walkingFor(shift,job,capacity)/capacity:0;
                if (capacity < share - EPSILON) {
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
                    growing: Boolean(job.growing), homes: [], allocations: [] };
                shifts.push(best);
                if (share < 1 - EPSILON || phases) available.push(best);
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
        .filter(({ shift, eligible }) => !shift.growing && eligible?.size && shift.busy < 1 - EPSILON);
    if (dispatch.length) {
        let remaining = haulingBusy;
        for (const { shift, eligible } of couriers) {
            if (remaining <= EPSILON) break;
            shift.candidates = eligible;
            remaining -= spareFor(shift,haul);
        }
        const additionalCouriers = Math.max(0, Math.ceil(remaining - EPSILON));
        const workers = available.map(shift => {
            const entry = candidateFor(shift);
            const abilities = entry?.abilities ?? Object.fromEntries([...shift.roles.values()].map(role => [role.ability, role.level]));
            const spare = spareFor(shift,haul);
            const family = entry?.family ?? [...shift.roles.values()].find(role => role.family)?.family;
            return { abilities, family, free: spare, spare, homes: shift.homes };
        });
        if (additionalCouriers) workers.push({ abilities: { Hauling: haul.level }, free: additionalCouriers - remaining, spare: 0 });
        estimateJobSwitching(dispatch, workers).slice(0, available.length).forEach((extra, i) => {
            if (extra <= EPSILON) return;
            available[i].busy += extra;
            if(phases){available[i].phaseBusy ||= Array(phases).fill(0);available[i].phaseBusy=available[i].phaseBusy.map(v=>v+extra);}
            available[i].tasks.set(TASK_SWITCHING, extra);
        });
    }
    for (const { shift, eligible } of couriers) {
        if (dispatch.length && (candidateFor(shift)?.abilities.Hauling ?? 0) < haul.level) continue;
        const spare = spareFor(shift,haul);
        haulingSpare += spare;
        const load = Math.min(spare, haulingBusy);
        if (load <= EPSILON) continue;
        shift.candidates = eligible;
        add(shift, haul, load);
        haulingBusy -= load;
    }
    place(haul, haulingBusy, false);

    return {
        haulingSpare,
        shifts: shifts.flatMap(pool => {
            const { candidates, roles, growing, homes, ...shift } = pool;
            const requirements = [...roles.values()];
            const entry = candidateFor(pool);
            const abilities = entry?.abilities ?? Object.fromEntries(requirements.map(role => [role.ability, role.level]));
            const result={ ...shift, entry, abilities, family: entry?.family ?? requirements.find(role => role.family)?.family ?? null };
            if(!phases||Math.max(...(shift.phaseBusy||[]))<=1+EPSILON)return [result];
            const durations=options.phaseDurations||Array(phases).fill(1);
            const profiles=new Map(shift.allocations.map(a=>[a.label,a.profile]));
            const split=splitPhaseTasks([...shift.tasks].map(([label,busy])=>({label,busy,profile:profiles.get(label)})),durations);
            return split.map(copy=>({...result,...copy,allocations:shift.allocations.filter(a=>copy.tasks.has(a.label)).map(a=>({...a,
                busy:a.busy*copy.tasks.get(a.label)/(shift.tasks.get(a.label)||1),profile:copy.profiles.get(a.label)}))}));
        }),
    };
}
