import catalog from './aniimo-catalog.json' with { type: 'json' };
import { opposedPersonality } from './facility-config.js?v=leisure-families';
import { workerTravelSeconds } from './worker-travel.js?v=logic-audit';
import { dispatchLocations, estimateJobSwitching, TASK_SWITCHING } from './task-switching.js?v=base-travel';
import {canElectrify} from './physical-power.js';
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

const canTakeJob=(entry,job)=>entry?.abilities[job.ability]>=(job.minimumLevel ?? job.level) &&
    (!job.family || entry.family===job.family);

export function distractionCount(entry, jobs) {
    let count = 0;
    for (const job of jobs) {
        if (canTakeJob(entry,job)) count += job.siteCount ?? 1;
    }
    return count;
}

// A bench rotating through two eligible recipes is still one physical diversion.
function cropWorkers(team) {
    return team.shifts.filter(s=>s.peakSupport || s.allocations.some(a=>a.growing));
}

export function cropWorkshopItems(team) {
    const workers=cropWorkers(team);
    return [...new Set(team.manualWorkshops.filter(j=>j.item && workers.some(s=>canTakeJob(s.entry,j))).map(j=>j.item))];
}

export function cropWorkshopDistractions(team) {
    let count=0;
    for (const shift of cropWorkers(team)) {
        const sites=new Map();
        for (const job of team.manualWorkshops) {
            if (!canTakeJob(shift.entry,job)) continue;
            const site=job.scheduleId ?? job.point?.join(',') ?? job.siteKey ?? job.label;
            const key=JSON.stringify([job.facility,site]);
            sites.set(key,Math.max(sites.get(key) ?? 0,job.siteCount ?? 1));
        }
        for (const n of sites.values()) count+=n;
    }
    return count;
}

export const isPrismanaEntry = entry => Boolean(entry?.id?.includes('prismana') || /prismana/i.test(entry?.form || ''));

export function pickCatalogEntry(entries, ability, level, family = null) {
    let best = null, bestScore = null;
    for (const entry of entries) {
        if (family && entry.family !== family) continue;
        const lv = entry.abilities?.[ability] ?? 0;
        if (lv < level) continue;
        const score = [
            isPrismanaEntry(entry) ? 1 : 0,
            lv - level,
            Object.keys(entry.abilities || {}).length,
        ];
        if (!bestScore || score[0] < bestScore[0]
            || (score[0] === bestScore[0] && (score[1] < bestScore[1]
                || (score[1] === bestScore[1] && score[2] < bestScore[2])))) {
            best = entry;
            bestScore = score;
        }
    }
    return best;
}

function bestForm(candidates, roles, growing, otherJobs, options = {}) {
    let entry, distractions = 0, bestPrimary = Infinity, bestSecondary = Infinity;
    let bestPrismana = Infinity, bestExtraSkills = Infinity;
    for (const candidate of candidates) {
        let excess = 0;
        for (const role of roles) excess += candidate.abilities[role.ability] - role.level;
        const risk = distractionCount(candidate, otherJobs);
        // Match production speed first (and minimize over-leveling in minimum mode).
        // For fields in Best mode, prefer fewer diversions and then stronger coverage
        // of the assigned crop stages. Break ties against rare Prismana forms and
        // unnecessary extra abilities.
        const primary = (growing && !options.preferMinimum) ? risk : excess;
        const secondary = (growing && !options.preferMinimum) ? -excess : risk;
        const prismana = isPrismanaEntry(candidate) ? 1 : 0;
        const extraSkills = Object.keys(candidate.abilities).length - roles.length;
        if (primary < bestPrimary
            || (primary === bestPrimary && (secondary < bestSecondary
                || (secondary === bestSecondary && (prismana < bestPrismana
                    || (prismana === bestPrismana && extraSkills < bestExtraSkills)))))) {
            entry = candidate;
            distractions = risk;
            bestPrimary = primary;
            bestSecondary = secondary;
            bestPrismana = prismana;
            bestExtraSkills = extraSkills;
        }
    }
    return {entry,distractions};
}

export function generatorDistractions(level, open) {
    const role = {ability:'Lightning',level};
    return bestForm(catalogIndex.get(roleKey(role)) ?? noMatches,[role],false,open).distractions;
}

export const protectedShift = shift => shift.peakSupport ||
    shift.allocations.some(job => job.growing || job.facility === 'Crackle Generator');

export function placeBestJobs(jobs, layout, sites) {
    if (!layout) return jobs;
    sites ??= dispatchLocations(layout);
    return jobs.flatMap(job => {
        const locations = sites.get(job.siteKey);
        if (!locations) return [job];
        if (job.scheduleId) {
            const site = locations.find(s => s.scheduleId === job.scheduleId);
            return [site ? {...job, point:site.point,occupied:site.occupied ?? job.occupied} : job];
        }
        const total = locations.reduce((sum, site) => sum + site.rate, 0);
        return locations.map(({ point, rate, occupied }) => ({ ...job, point, occupied:occupied ?? job.occupied, siteCount: 1, busy: job.busy * rate / total }));
    });
}

export function recommendBestTeam(jobs, haulingBusy = 0, dispatch = [], options = {}) {
    jobs = jobs.map(job => job.ability === 'Perfumery' && !job.personality
        ? {...job, personality: opposedPersonality('Instinctive')} : job);
    const phases=Math.max(options.haulingProfile?.length||0,...jobs.map(j=>j.profile?.length||0));
    const profile=job=>job.profile||Array(phases).fill(1);
    const matches = job => catalogIndex.get(roleKey(job)) ?? noMatches;
    const haul = { ability: 'Hauling', level: options.haulingLevel||4, label: 'Hauling to Storage Units', profile:options.haulingProfile };
    const sharedHaul = {...haul,level:options.sharedHaulingLevel ?? Math.min(3,haul.level)};
    const courierForms = matches(haul), sharedForms = matches(sharedHaul);
    const open = jobs.filter(job => !job.fixed && !job.occupied && job.busy > EPSILON);
    if (haulingBusy > EPSILON) open.push({...haul, minimumLevel:1});

    // Keep compatible recipes on the same physical bench with one operator
    // through recipe changes. Measured idle time can still serve other work.
    const byStation = new Map(), baseRoles = [];
    for (const job of jobs) {
        const station = job.scheduleId ?? job.point?.join(',');
        if (!job.workstation || !station || !(job.busy > EPSILON)) { baseRoles.push(job); continue; }
        const key = JSON.stringify([job.facility,station,roleKey(job),job.personality]);
        if (!byStation.has(key)) byStation.set(key,[]);
        byStation.get(key).push(job);
    }
    for (const parts of byStation.values()) {
        if (parts.length === 1) { baseRoles.push(parts[0]); continue; }
        const busy = parts.reduce((sum,j)=>sum+j.busy,0);
        baseRoles.push({...parts[0],parts,busy,
            profile:Array.from({length:phases},(_,i)=>parts.reduce((sum,j)=>sum+j.busy*profile(j)[i],0)/busy),
            visitsPerShare:parts.reduce((sum,j)=>sum+j.busy*(j.visitsPerShare || 0),0)/busy});
    }

    const runPack = (orderedRoles, { preserveHauling = false, avoidDistractions = false } = {}) => {
        let remainingHauling = haulingBusy;
        const spareFor=(shift,job)=>Math.max(0,Math.min(1-shift.busy,...profile(job).map((factor,i)=>factor>0?(1-(shift.phaseBusy?.[i]||0))/factor:Infinity)));
        const shifts = [];
        const available = [];
        const competing = shift => open.filter(job => !(job.growing && shift.growing) &&
            !shift.allocations.some(own => own.ability === job.ability && own.label === job.label &&
                own.siteKey === job.siteKey && own.point === job.point));
        const candidateFor = shift => bestForm(shift.candidates,[...shift.roles.values()],shift.growing,competing(shift),options);
        const compatible = (shift, job, candidates) => {
            if (job.personality && shift.personalities.has(opposedPersonality(job.personality))) return null;
            if (shift.roles.has(roleKey(job))) return shift.candidates;
            if (!shift.candidates.size || !candidates.size) return null;
            return new Set([...shift.candidates].filter(entry => candidates.has(entry)));
        };
        const hasCourier = set => {
            for (const entry of set) if (courierForms.has(entry) || sharedForms.has(entry)) return true;
            return false;
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
            if (job.parts) {
                for (const part of job.parts) add(shift,part,share*part.busy/job.busy,walking*part.busy/job.busy);
                return;
            }
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
            const wantHauling = preserveHauling && remainingHauling > EPSILON && !job.growing && !job.fixed;
            while (busy > EPSILON) {
                let share = Math.min(1, busy,1/Math.max(1,...profile(job)));
                let best;
                let narrowed;
                let bestWalking = 0;
                let bestScore = null;
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
                    let distDelta = 0;
                    if (avoidDistractions && common.size && shift.candidates.size && !shift.roles.has(roleKey(job))) {
                        const before = candidateFor(shift).distractions;
                        const mergedRoles = [...shift.roles.values(), job];
                        const after = bestForm(common, mergedRoles, shift.growing, competing(shift), options).distractions;
                        distDelta = Math.max(0, after - before);
                    }
                    const lostHaul = wantHauling && hasCourier(shift.candidates) && !hasCourier(common) ? 1 : 0;
                    const score = [walking, distDelta, lostHaul, -shift.busy];
                    const better = !bestScore
                        || score[0] < bestScore[0] - EPSILON
                        || (Math.abs(score[0] - bestScore[0]) <= EPSILON && (
                            score[1] < bestScore[1]
                            || (score[1] === bestScore[1] && (
                                score[2] < bestScore[2]
                                || (score[2] === bestScore[2] && score[3] < bestScore[3])))));
                    if (better) {
                        best = shift;
                        narrowed = common;
                        bestWalking = walking;
                        bestScore = score;
                    }
                }
                if (!best && partial && !job.workstation) {
                    best = partial;
                    narrowed = partialCandidates;
                    share = partialCapacity;
                    bestWalking = partialWalking;
                }
                if (!best) {
                    best = { busy: 0, candidates, roles: new Map(), tasks: new Map(), personalities: new Set(),
                        growing: Boolean(job.growing), fixed: Boolean(job.fixed), homes: [], allocations: [] };
                    shifts.push(best);
                    if (share < 1 - EPSILON || phases) available.push(best);
                } else {
                    best.candidates = narrowed;
                }
                add(best, job, share, share * bestWalking);
                busy -= share;
            }
        };

        for (const job of orderedRoles) place(job, job.busy);

        // Pairwise shift consolidation: merge compatible non-fixed shifts when their
        // combined load + transition walking still fits in one shift.
        const mergeWalkDelta = (a, b) => {
            if (!a.homes.length || !b.homes.length) return 0;
            const rateA = a.homes.reduce((s, h) => s + h.rate, 0);
            const rateB = b.homes.reduce((s, h) => s + h.rate, 0);
            if (!(rateA > 0 && rateB > 0)) return 0;
            let cross = 0;
            for (const ha of a.homes) for (const hb of b.homes) {
                cross += ha.rate * hb.rate * workerTravelSeconds(Math.hypot(ha.point[0] - hb.point[0], ha.point[1] - hb.point[1]));
            }
            const totalRate = rateA + rateB;
            const newWalk = (a.walking * rateA + b.walking * rateB + 2 * cross) / totalRate;
            return Math.max(0, newWalk - a.walking - b.walking);
        };
        for (let merged = true; merged;) {
            merged = false;
            let bestPair = null, bestExtra = Infinity;
            for (let i = 0; i < available.length; i++) {
                const a = available[i];
                if (a.fixed || a.busy >= 1 - EPSILON) continue;
                for (let j = i + 1; j < available.length; j++) {
                    const b = available[j];
                    if (b.fixed || b.growing !== a.growing || b.busy >= 1 - EPSILON) continue;
                    if (a.busy + b.busy > 1 - EPSILON) continue;
                    let opposed = false;
                    for (const trait of b.personalities) {
                        if (a.personalities.has(opposedPersonality(trait))) { opposed = true; break; }
                    }
                    if (opposed) continue;
                    if (!a.candidates.size || !b.candidates.size) continue;
                    const common = new Set([...a.candidates].filter(e => b.candidates.has(e)));
                    if (!common.size) continue;
                    const extraWalk = mergeWalkDelta(a, b);
                    if (a.busy + b.busy + extraWalk > 1 - EPSILON) continue;
                    if (phases) {
                        const phaseOverflow = Array.from({length: phases}, (_, p) =>
                            (a.phaseBusy?.[p] || 0) + (b.phaseBusy?.[p] || 0) + extraWalk).some(v => v > 1 - EPSILON);
                        if (phaseOverflow) continue;
                    }
                    if (extraWalk < bestExtra) {
                        bestExtra = extraWalk;
                        bestPair = [i, j, common, extraWalk];
                    }
                }
            }
            if (bestPair) {
                const [i, j, common, extraWalk] = bestPair;
                const a = available[i], b = available[j];
                a.candidates = common;
                a.busy += b.busy + extraWalk;
                a.walking = (a.walking || 0) + (b.walking || 0) + extraWalk;
                if (phases) {
                    a.phaseBusy ||= Array(phases).fill(0);
                    for (let p = 0; p < phases; p++) a.phaseBusy[p] += (b.phaseBusy?.[p] || 0) + extraWalk;
                }
                a.allocations.push(...b.allocations);
                for (const trait of b.personalities) a.personalities.add(trait);
                for (const [k, r] of b.roles) if (!a.roles.has(k)) a.roles.set(k, r);
                for (const [label, share] of b.tasks) a.tasks.set(label, (a.tasks.get(label) || 0) + share);
                if (extraWalk > EPSILON) {
                    const label = 'Walking between jobs';
                    a.tasks.set(label, (a.tasks.get(label) || 0) + extraWalk);
                }
                a.homes.push(...b.homes);
                available.splice(j, 1);
                const idx = shifts.indexOf(b);
                if (idx >= 0) shifts.splice(idx, 1);
                merged = true;
            }
        }

        let haulingSpare = 0;
        const couriers = available.map(shift => {
            const top = compatible(shift,haul,courierForms);
            return top?.size ? {shift,eligible:top,delivery:haul} :
                {shift,eligible:compatible(shift,sharedHaul,sharedForms),delivery:sharedHaul};
        })
            .filter(({ shift, eligible }) => !shift.growing && eligible?.size && shift.busy < 1 - EPSILON);
        if (dispatch.length) {
            let remaining = remainingHauling;
            for (const { shift, eligible } of couriers) {
                if (remaining <= EPSILON) break;
                shift.candidates = eligible;
                remaining -= spareFor(shift,haul);
            }
            const additionalCouriers = Math.max(0, Math.ceil(remaining - EPSILON));
            const workers = available.map(shift => {
                const {entry} = candidateFor(shift);
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
        for (const { shift, eligible, delivery } of couriers) {
            if (dispatch.length && (candidateFor(shift).entry?.abilities.Hauling ?? 0) < delivery.level) continue;
            const spare = spareFor(shift,haul);
            haulingSpare += spare;
            const load = Math.min(spare, remainingHauling);
            if (load <= EPSILON) continue;
            shift.candidates = eligible;
            add(shift, delivery, load);
            remainingHauling -= load;
        }
        place(haul, remainingHauling, false);

        return {
            haulingSpare,
            manualWorkshops:open.filter(j=>j.workstation && canElectrify(j.facility)),
            shifts: shifts.flatMap(pool => {
                const { candidates, roles, growing, fixed, homes, ...shift } = pool;
                const requirements = [...roles.values()];
                const {entry,distractions} = candidateFor(pool);
                const abilities = entry?.abilities ?? Object.fromEntries(requirements.map(role => [role.ability, role.level]));
                const result={ ...shift, entry, abilities, distractions, family: entry?.family ?? requirements.find(role => role.family)?.family ?? null };
                if(!phases||Math.max(...(shift.phaseBusy||[]))<=1+EPSILON)return [result];
                const durations=options.phaseDurations||Array(phases).fill(1);
                const profiles=new Map(shift.allocations.map(a=>[a.label,a.profile]));
                const split=splitPhaseTasks([...shift.tasks].map(([label,busy])=>({label,busy,profile:profiles.get(label)})),durations);
                return split.map(copy=>({...result,...copy,allocations:shift.allocations.filter(a=>copy.tasks.has(a.label)).map(a=>({...a,
                    busy:a.busy*copy.tasks.get(a.label)/(shift.tasks.get(a.label)||1),profile:copy.profiles.get(a.label)}))}));
            }),
        };
    };

    const byRarest = [...baseRoles].sort((a, b) => matches(a).size - matches(b).size || b.busy - a.busy);
    if (baseRoles.length <= 2) return runPack(byRarest);

    const strategies = [
        [byRarest, { preserveHauling: false, avoidDistractions: false }],
        [byRarest, { preserveHauling: true, avoidDistractions: true }],
        [[...baseRoles].sort((a, b) => b.busy - a.busy || matches(a).size - matches(b).size), { preserveHauling: true, avoidDistractions: true }],
    ];
    if (baseRoles.some(r => r.point)) {
        const byProximity = [...baseRoles].sort((a, b) =>
            Number(Boolean(b.fixed)) - Number(Boolean(a.fixed))
            || Number(Boolean(a.growing)) - Number(Boolean(b.growing))
            || ((a.point?.[0] ?? 0) + (a.point?.[1] ?? 0)) - ((b.point?.[0] ?? 0) + (b.point?.[1] ?? 0))
            || b.busy - a.busy);
        strategies.push([byProximity, { preserveHauling: true, avoidDistractions: true }]);
    }

    const scoreTeam = team => {
        const cropWorkshops = cropWorkshopDistractions(team);
        const protectedDist = team.shifts.filter(protectedShift).reduce((s, sh) => s + (sh.distractions ?? 0), 0);
        const totalDist = team.shifts.reduce((s, sh) => s + (sh.distractions ?? 0), 0);
        const prismana = team.shifts.reduce((s, sh) => s + (isPrismanaEntry(sh.entry) ? 1 : 0), 0);
        const totalBusy = team.shifts.reduce((s, sh) => s + (sh.busy ?? 0), 0);
        return [team.shifts.length, cropWorkshops, protectedDist, totalDist, prismana, totalBusy, -team.haulingSpare];
    };
    const isBetter = (a, b) => {
        for (let i = 0; i < a.length; i++) {
            const tol = i >= 5 ? 1e-7 : 0;
            if (Math.abs(a[i] - b[i]) > tol) return a[i] < b[i];
        }
        return false;
    };

    let bestTeam = null, bestScore = null;
    for (const [order, opts] of strategies) {
        const candidate = runPack(order, opts);
        const score = scoreTeam(candidate);
        if (!bestScore || isBetter(score, bestScore)) {
            bestTeam = candidate;
            bestScore = score;
        }
    }
    return bestTeam;
}
