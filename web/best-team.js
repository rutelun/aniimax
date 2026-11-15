import catalog from './aniimo-catalog.json' with { type: 'json' };
import { opposedPersonality } from './facility-config.js?v=leisure-families';

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

export function recommendBestTeam(jobs, haulingBusy = 0) {
    const shifts = [];
    const available = [];
    const haul = { ability: 'Hauling', level: 3, label: 'Hauling to Storage Units' };
    const matches = job => catalogIndex.get(roleKey(job)) ?? noMatches;
    const compatible = (shift, job, candidates) => {
        if (job.personality && shift.personalities.has(opposedPersonality(job.personality))) return null;
        if (shift.roles.has(roleKey(job))) return shift.candidates;
        if (!shift.candidates.size || !candidates.size) return null;
        return new Set([...shift.candidates].filter(entry => candidates.has(entry)));
    };
    const add = (shift, job, share) => {
        shift.busy += share;
        if (job.personality) shift.personalities.add(job.personality);
        const key = roleKey(job);
        if (!shift.roles.has(key)) shift.roles.set(key, job);
        shift.tasks.set(job.label, (shift.tasks.get(job.label) || 0) + share);
    };
    const place = (job, busy) => {
        const candidates = matches(job);
        while (busy > EPSILON) {
            let share = Math.min(1, busy);
            let best;
            let narrowed;
            let partial;
            let partialCandidates;
            for (const shift of available) {
                if (share === 1 || 1 - shift.busy <= EPSILON) continue;
                const common = compatible(shift, job, candidates);
                if (common == null || (common.size === 0 && !shift.roles.has(roleKey(job)))) continue;
                if (1 - shift.busy < share - EPSILON) {
                    if (!partial || shift.busy < partial.busy) {
                        partial = shift;
                        partialCandidates = common;
                    }
                    continue;
                }
                if (!best || shift.busy > best.busy + EPSILON
                    || (Math.abs(shift.busy - best.busy) <= EPSILON && common.size > narrowed.size)) {
                    best = shift;
                    narrowed = common;
                }
            }
            if (!best && partial) {
                best = partial;
                narrowed = partialCandidates;
                share = 1 - partial.busy;
            }
            if (!best) {
                best = { busy: 0, candidates, roles: new Map(), tasks: new Map(), personalities: new Set() };
                shifts.push(best);
                if (share < 1 - EPSILON) available.push(best);
            } else {
                best.candidates = narrowed;
            }
            add(best, job, share);
            busy -= share;
        }
    };

    // Every resident or environment post arrives as a whole shift. Flexible work gets
    // the most restrictive jobs first, leaving each shift open to every compatible form.
    const roles = [...jobs].sort((a, b) => matches(a).size - matches(b).size || b.busy - a.busy);
    for (const job of roles) place(job, job.busy);

    let haulingSpare = 0;
    const courierForms = matches(haul);
    for (const shift of available) {
        const eligible = compatible(shift, haul, courierForms);
        if (!eligible?.size) continue;
        const spare = Math.max(0, 1 - shift.busy);
        haulingSpare += spare;
        const load = Math.min(spare, haulingBusy);
        if (load <= EPSILON) continue;
        shift.candidates = eligible;
        add(shift, haul, load);
        haulingBusy -= load;
    }
    place(haul, haulingBusy);

    return {
        haulingSpare,
        shifts: shifts.map(({ candidates, roles, ...shift }) => {
            const requirements = [...roles.values()];
            // A role's planned rate is achievable at or above its requested level.
            // Prefer the closest match, then useful additional abilities.
            const score = entry => requirements.reduce((sum, role) => sum + entry.abilities[role.ability] - role.level, 0)
                * 10 - Object.keys(entry.abilities).length;
            let entry;
            let bestScore = Infinity;
            for (const candidate of candidates) {
                const value = score(candidate);
                if (value >= bestScore) continue;
                bestScore = value;
                entry = candidate;
            }
            const abilities = entry?.abilities ?? Object.fromEntries(requirements.map(role => [role.ability, role.level]));
            return { ...shift, entry, abilities, family: entry?.family ?? requirements.find(role => role.family)?.family ?? null };
        }),
    };
}
