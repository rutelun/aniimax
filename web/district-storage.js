const EPS = 1e-6;
const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
const overlaps = (a, b) => a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS
    && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
const distance = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const districtOf = (r, groups) => groups.findIndex(group => contains(group.bounds, r));

export function districtStorageIndices(stores, groups) {
    const indices = groups.map(() => []);
    stores.forEach((store, i) => indices[districtOf(store, groups)]?.push(i));
    return indices;
}

export function canMoveDistrictStorage(layout, index, trial, groups) {
    const origin = districtOf(layout.storages[index], groups), target = districtOf(trial, groups);
    return target >= 0 && (!groups[target].workshop || !overlaps(trial, groups[target].workshop))
        && (target === origin || !groups[origin]?.range
        || layout.storages.some((store, i) => i !== index && districtOf(store, groups) === origin));
}

// Move only storage. The workshops, climate geometry, poles and decorative
// gaps have already been placed. Every delivery still uses its nearest store.
export function improveDistrictStorage(layout, groups, keepsIncome = () => true) {
    const storages = layout.storages.slice();
    const buildings = layout.pieces.flatMap(piece => piece.members);
    const sources = buildings.filter(member => member.weight > 0);
    if (!storages.length || !sources.length) return layout;
    const obstacles = [...buildings, ...(layout.power?.poles ?? [])];
    const trials = [];
    groups.forEach(({ bounds, workshop }, zone) => {
        for (let y = Math.ceil(bounds.y * 2) / 2; y + 2 <= bounds.y + bounds.h + EPS; y += .5) {
            for (let x = Math.ceil(bounds.x * 2) / 2; x + 2 <= bounds.x + bounds.w + EPS; x += .5) {
                const r = { x, y, w: 2, h: 2, zone };
                if ((!workshop || !overlaps(r, workshop)) && !obstacles.some(other => overlaps(r, other))) trials.push(r);
            }
        }
    });
    if (!trials.length) return layout;
    const zones = sources.map(member => districtOf(member, groups));
    const stride = sources.length, distances = new Float32Array(trials.length * stride);
    trials.forEach((trial, i) => sources.forEach((source, j) => { distances[i * stride + j] = distance(source, trial); }));
    const move = (i, trial) => {
        const { zone, ...position } = trial;
        storages[i] = position;
    };
    const fit = candidate => keepsIncome({ ...layout, storages: candidate });
    const protectIncome = fit(storages);
    // First make each store useful to the area it was built for. Then let
    // underused stores compete for the spot where they save the most trips.
    for (const local of [true, false, false]) {
        let changed = false;
        for (let i = 0; i < storages.length; i++) {
            const current = storages[i], zone = districtOf(current, groups);
            const hasAnother = storages.some((other, j) => j !== i && districtOf(other, groups) === zone);
            const stays = local || (groups[zone]?.range && !hasAnother);
            if (local && !zones.includes(zone)) continue;
            const others = storages.filter((_, j) => j !== i);
            const without = sources.map(source => others.reduce((best, store) => Math.min(best, distance(source, store)), Infinity));
            let oldGlobal = 0, oldLocal = 0;
            for (let j = 0; j < stride; j++) {
                const d = distance(sources[j], current), weight = sources[j].weight;
                oldGlobal += weight * Math.min(without[j], d);
                if (zones[j] === zone) oldLocal += weight * d;
            }
            const shortlist = [];
            for (let t = 0; t < trials.length; t++) {
                const trial = trials[t];
                if (stays && trial.zone !== zone) continue;
                if (others.some(other => overlaps(trial, other))) continue;
                let global = 0, within = 0;
                for (let j = 0; j < stride; j++) {
                    const d = distances[t * stride + j], weight = sources[j].weight;
                    global += weight * Math.min(without[j], d);
                    if (local && zones[j] === zone) within += weight * d;
                }
                if (global > oldGlobal - .01 || (local && within > oldLocal + .01)) continue;
                const score = local ? within + .25 * global : global;
                if (shortlist.length >= 6 && score >= shortlist.at(-1).score) continue;
                shortlist.push({ trial, score });
                shortlist.sort((a, b) => a.score - b.score);
                if (shortlist.length > 6) shortlist.pop();
            }
            for (const { trial } of shortlist) {
                move(i, trial);
                if (!protectIncome || fit(storages)) { changed = true; break; }
                storages[i] = current;
            }
        }
        if (!local && !changed) break;
    }
    const first = storages[0];
    return { ...layout, storages, storage: first, storageAt: { x: first.x + first.w / 2, y: first.y + first.h / 2 } };
}
