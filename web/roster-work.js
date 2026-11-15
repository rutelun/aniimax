const EPSILON = 1e-8;

// Expand a pool of interchangeable Aniimo into planned shifts. Local work keeps its
// workplace, and mobile work carries its walking time even when two shifts share it.
export function scheduleRosterCopies(count, fixed, posts, routes) {
    const shifts = Array.from({ length: count }, () => ({ busy: 0, tasks: new Map() }));
    const free = shift => Math.max(0, 1 - shift.busy);
    const add = (shift, jobs, fraction) => {
        for (const [label, duration] of jobs) {
            const share = duration * fraction;
            if (share <= 0) continue;
            shift.busy += share;
            shift.tasks.set(label, (shift.tasks.get(label) || 0) + share);
        }
    };
    const pack = (jobs, pool) => {
        const total = jobs.reduce((sum, [, duration]) => sum + duration, 0);
        if (total <= EPSILON) return;
        const fit = pool.find(shift => free(shift) >= total - EPSILON);
        if (fit) {
            add(fit, jobs, 1);
            return;
        }
        let remaining = total;
        for (const shift of pool) {
            if (remaining <= EPSILON) break;
            const part = Math.min(remaining, free(shift));
            add(shift, jobs, part / total);
            remaining -= part;
        }
    };

    let next = 0;
    for (const [label, units] of fixed) {
        for (let i = 0; i < units; i++) add(shifts[next++], [[label, 1]], 1);
    }
    const byStation = new Map();
    for (const [station, units] of posts) {
        byStation.set(station, shifts.slice(next, next + units));
        next += units;
    }
    for (const { station, jobs, localPlots } of routes) {
        if (!station) continue;
        const crew = byStation.get(station);
        const plots = Math.min(crew.length, Math.ceil(localPlots - EPSILON));
        if (plots > 0) {
            for (let i = 0; i < plots; i++) {
                add(crew[i], jobs, Math.min(1, localPlots - i) / localPlots);
            }
        } else {
            pack(jobs, crew);
        }
    }
    for (const { station, jobs } of routes) {
        if (!station) pack(jobs, shifts);
    }
    return shifts;
}
