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
    const pack = (jobs, pool, preferOrder=false) => {
        const total = jobs.reduce((sum, [, duration]) => sum + duration, 0);
        if (total <= EPSILON) return;
        const fit = !preferOrder && pool.find(shift => free(shift) >= total - EPSILON);
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
        // A measured route can exceed the model estimate. Preserve that demand
        // on an existing worker instead of silently truncating it at one shift.
        if (remaining > EPSILON && pool.length) {
            const leastBusy = pool.reduce((a, b) => a.busy <= b.busy ? a : b);
            add(leastBusy, jobs, remaining / total);
        }
    };

    let next = 0;
    for (const [label, units] of fixed) {
        for (let i = 0; i < units; i++) add(shifts[next++], [[label, 1]], 1);
    }
    const mobile = shifts.slice(next);
    const byStation = new Map();
    for (const [station, units] of posts) {
        byStation.set(station, shifts.slice(next, next + units));
        next += units;
    }
    const plotPosts = new Set();
    for (const { station, jobs, localPlots, crop } of routes) {
        if (!station) continue;
        const crew = byStation.get(station);
        if(crop)for(const shift of crew)plotPosts.add(shift);
        const plots = Math.min(crew.length, Math.ceil(localPlots - EPSILON));
        if (plots > 0) {
            for (let i = 0; i < plots; i++) {
                add(crew[i], jobs, Math.min(1, localPlots - i) / localPlots);
            }
        } else {
            pack(jobs, crew);
        }
    }
    const order=r=>r.spread?4:r.delivery?3:r.crop?(r.copyShares?2:1):Number(!!r.copyShares);
    const workshopCrew=plotPosts.size?[...mobile].sort((a,b)=>Number(plotPosts.has(a))-Number(plotPosts.has(b))):mobile;
    let growers;
    for (const { station, jobs, spread, copyShares, crop } of [...routes].sort((a,b)=>order(a)-order(b))) {
        if (station) continue;
        if(crop)growers??=[...mobile].sort((a,b)=>a.busy-b.busy);
        const crew=crop && growers.length?growers:workshopCrew.length?workshopCrew:shifts;
        if(copyShares?.length){
            const total=jobs.reduce((sum,[,duration])=>sum+duration,0);
            if(total<=EPSILON)continue;
            let placed=0;
            for(const [copy,fraction] of copyShares){
                const shift=shifts[copy];if(!shift||!mobile.includes(shift))continue;
                const share=Math.min(Math.max(0,fraction),free(shift)/total,1-placed);
                add(shift,jobs,share);placed+=share;
            }
            if(placed<1-EPSILON)pack(jobs.map(([label,n])=>[label,n*(1-placed)]),crew,crop);
        } else if (spread) {
            // Reactive diversions are estimates across active copies, proportional to
            // their opportunity to pick up work. Do not wake an otherwise idle copy.
            const active = mobile.filter(shift => shift.busy > EPSILON);
            const spare = active.reduce((sum, shift) => sum + free(shift), 0);
            const weights = active.map(shift => spare > 0 ? free(shift) / spare : 1 / active.length);
            active.forEach((shift, i) => add(shift, jobs, weights[i]));
        } else pack(jobs, crew, crop || plotPosts.size>0);
    }
    return shifts;
}
