import { FACILITIES, FACILITY_FOOTPRINTS, HOMELAND_PLOTS, HOMELAND_PLOT_SIZE,
    generatorLimit, powerPoleLimit, storageUnitLimit } from './facility-config.js?v=leisure-families';
import { createInsideTest, nearestStorage } from './layout.js?v=storage-power';
import { powerLinked, updatePowerConnections } from './power-layout.js?v=fixed-homeland';
import { facilityStockLimit, haulingBatchTrips, haulingTravelSeconds, pickupStockLimit } from './hauling.js?v=facility-stock';
import { ANIIMO_WALK_SPEED } from './worker-travel.js?v=auto-worker-travel';

const STORAGE = 'Storage Unit';
const GENERATOR = 'Crackle Generator';
const POLE = 'Crackle Power Pole';
const INFRASTRUCTURE = [STORAGE, GENERATOR, POLE];
const CLIMATE = {
    'Heat Furnace': ['Warm', 'Scorching'],
    'Cooling Unit': ['Cool', 'Freeze'],
    Sunlamp: ['Adequate'],
};
const TEMPERATURE = ['Freeze', 'Cool', null, 'Warm', 'Scorching'];
const CLIMATE_SITES = new Set(['Farmland', 'Woodland', 'Starfall Hammock', 'Tidewhisper Sandcastle', 'Floral Windmill', 'Dewy House']);
const EPS = 1e-6;
const MAX_SITES = 240;
const validType = facility => Object.hasOwn(FACILITY_FOOTPRINTS, facility);
const snap = n => Math.round(n * 4) / 4;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + EPS
    && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + EPS;
const distance = (a, b) => Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2);
const initials = name => name.split(/[ -]/).map(word => word[0]).join('');

export function existingPlots(rv) {
    const { w, h } = HOMELAND_PLOT_SIZE;
    return HOMELAND_PLOTS.flatMap((row, y) => row.map((number, x) =>
        ({ number, x: x * w, y: y * h, w, h, open: number <= rv })));
}

export function normalizeExistingSites(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_SITES).flatMap(site => {
        if (!site || !validType(site.facility) || !Number.isFinite(site.x) || !Number.isFinite(site.y)) return [];
        const { facility } = site;
        const max = facility === GENERATOR ? 5 : Math.max(1, ...Object.keys(
            FACILITIES.find(f => f.name === facility)?.unlocks || {}).map(Number));
        return [{ facility, x: snap(site.x), y: snap(site.y),
            level: Math.max(1, Math.min(max, Math.round(Number(site.level) || 1))),
            rotated: site.rotated === true,
            mode: CLIMATE[facility]?.includes(site.mode) ? site.mode : null }];
    });
}

function footprint(site, index) {
    const [w, h] = FACILITY_FOOTPRINTS[site.facility];
    return { ...site, index, w: site.rotated ? h : w, h: site.rotated ? w : h,
        generator: site.facility === GENERATOR, pole: site.facility === POLE };
}

function firstPowerGrid(sites) {
    const generators = sites.filter(site => site.facility === GENERATOR);
    const relays = [...generators, ...sites.filter(site => site.facility === POLE)];
    const connected = new Set(generators.slice(0, 1));
    for (const parent of connected) {
        for (const next of relays) if (!connected.has(next) && powerLinked(parent, next)) connected.add(next);
    }
    return { connected, generators: generators.filter(site => connected.has(site)) };
}

export function prepareExistingHomeland(inputSites, rv, electricity, recipes) {
    const sites = normalizeExistingSites(inputSites).map(footprint);
    const inside = createInsideTest(existingPlots(rv).filter(plot => plot.open));
    const storages = sites.filter(site => site.facility === STORAGE);
    const climateSites = sites.filter(site => site.mode);
    const production = sites.filter(site => !INFRASTRUCTURE.includes(site.facility) && !Object.hasOwn(CLIMATE, site.facility));
    if (!production.length) throw new Error('Place at least one production building on your map.');
    if (!storages.length) throw new Error('Place a Storage Unit to calculate delivery work.');
    if (storages.length > storageUnitLimit(rv) || sites.filter(s => s.facility === GENERATOR).length > generatorLimit(rv)
        || sites.filter(s => s.facility === POLE).length > powerPoleLimit(rv)) {
        throw new Error('The map exceeds the RV limit for Storage Units, generators, or power poles.');
    }
    if (sites.some((site, i) => !inside(site) || sites.slice(i + 1).some(other => overlap(site, other)))) {
        throw new Error('Move overlapping buildings and buildings outside unlocked plots.');
    }
    const { connected, generators } = firstPowerGrid(electricity ? sites : []);
    const climate = {};
    const facilities = Object.fromEntries(FACILITIES.map(({ name }) => [name, []]));
    for (const site of sites) {
        const tiers = facilities[site.facility];
        const tier = tiers?.find(t => t.level === site.level);
        if (tier) tier.count++;
        else tiers?.push({ level: site.level, count: 1 });
        if (site.mode) climate[site.facility] = (climate[site.facility] || 0) + 1;
    }
    const pools = new Map();
    const groupsByKey = new Map();
    for (const site of production) {
        site.storage = nearestStorage(site, storages);
        site.loadedSeconds = haulingTravelSeconds(distance(site, site.storage));
        pools.set(site.storage, Math.max(pools.get(site.storage) || 0, site.loadedSeconds));
        let temperature = 0, lit = false;
        for (const source of CLIMATE_SITES.has(site.facility) ? climateSites : []) {
            const area = { x: source.x + source.w / 2 - 4.5, y: source.y + source.h / 2 - 4.5, w: 9, h: 9 };
            if (!overlap(site, area)) continue;
            if (source.mode === 'Adequate') lit = true;
            else temperature += TEMPERATURE.indexOf(source.mode) - 2;
        }
        const powered = [...connected].some(source => powerLinked(source, site));
        const properties = { facility: site.facility, level: site.level, lit,
            temperature: TEMPERATURE[Math.min(4, Math.max(0, temperature + 2))], powered };
        const key = JSON.stringify(properties);
        if (!groupsByKey.has(key)) groupsByKey.set(key, { properties, sites: [] });
        groupsByKey.get(key).sites.push(site);
    }
    const groups = [...groupsByKey.values()];
    for (const { sites: candidates } of groups) candidates.sort((a, b) => a.loadedSeconds - b.loadedSeconds);
    const hauling = {};
    for (const recipe of recipes) {
        const eligible = groups.filter(({ properties: group }) => group.facility === recipe.facility
            && group.level >= recipe.facility_level && (recipe.environment === 'Adequate' ? group.lit
                : !recipe.environment || group.temperature === recipe.environment || (!group.temperature && !recipe.workload)));
        if (!eligible.length) continue;
        const key = recipe.facility + '|' + recipe.name;
        for (let level = 1; level <= 4; level++) {
            hauling[key + '|' + level] = Math.max(...eligible.flatMap(({ sites: candidates }) => candidates.map(site => {
                const stock = recipe.turns ? 0 : facilityStockLimit(site.facility, site.level);
                return haulingBatchTrips(recipe, level, stock) * (site.loadedSeconds + pools.get(site.storage));
            })));
        }
        hauling[key] = hauling[key + '|3'];
    }
    let longestWalk = 0;
    for (const [i, site] of production.entries()) {
        for (const other of production.slice(i + 1)) longestWalk = Math.max(longestWalk, distance(site, other));
    }
    return {
        sites, storages, groups, facilities, hauling, movement: longestWalk / ANIIMO_WALK_SPEED,
        generatorSites: generators,
        disconnectedGenerators: electricity ? sites.filter(s => s.facility === GENERATOR).length - generators.length : 0,
        mixedGenerators: new Set(generators.map(site => site.level)).size > 1,
        input: { groups: groups.map(({ properties, sites }) => ({ ...properties, count: sites.length })),
            climate, generators: generators.length,
            generator_level: generators.length ? Math.min(...generators.map(site => site.level)) : null },
    };
}

export function jobsOnExistingSites(map, plan) {
    const rows = map.sites.map(site => ({ ...site, jobs: [], staff: null }));
    const add = (site, job, units) => {
        rows[site.index].jobs.push({ ...job, units, rate: job.rate * units / job.units });
    };
    for (const [group, { sites }] of map.groups.entries()) {
        const jobs = (plan.fixed_site_jobs || []).filter(job => job.group === group);
        let at = 0;
        const dedicated = jobs.filter(job => !job.turns).sort((a, b) => b.rate / b.units - a.rate / a.units);
        for (const job of dedicated) {
            for (let n = 0; n < Math.round(job.units); n++) add(sites[at++], job, 1);
        }
        for (const electric of [true, false]) {
            let used = 0;
            for (const job of jobs.filter(job => job.turns && (job.electric_level != null) === electric)) {
                let remaining = job.units;
                while (remaining > EPS) {
                    const units = Math.min(remaining, 1 - used);
                    add(sites[at], job, units);
                    used += units;
                    remaining -= units;
                    if (used >= 1 - EPS) { at++; used = 0; }
                }
            }
            if (used > EPS) at++;
        }
    }
    const staffSites = new Map(Object.keys(CLIMATE).map(facility =>
        [facility, rows.filter(site => site.facility === facility && site.mode)]));
    staffSites.set(GENERATOR, map.generatorSites.map(site => rows[site.index]));
    for (const [building, member, count] of plan.staffing || []) {
        const available = staffSites.get(building) || [];
        for (let n = 0; n < Math.round(count); n++) {
            const site = available.shift();
            if (site) site.staff = member;
        }
    }
    return rows;
}

export function existingPlanLayout(map, rows, recipes) {
    const byName = new Map(recipes.map(recipe => [recipe.name, recipe]));
    const pieces = rows.filter(site => site.facility !== STORAGE && site.facility !== POLE).map(site => {
        const jobs = site.jobs;
        const stockLimit = facilityStockLimit(site.facility, site.level);
        const member = { ...site, jobs: jobs.length ? jobs : undefined,
            building: Object.hasOwn(CLIMATE, site.facility), generator: site.facility === GENERATOR,
            crop: jobs[0]?.item, cycle: jobs[0]?.cycle, electric_level: jobs[0]?.electric_level ?? undefined, stockLimit };
        member.weight = jobs.reduce((sum, job) => sum + job.rate * 3600
            * haulingBatchTrips(byName.get(job.item), 3, pickupStockLimit(member)), 0);
        return { members: [member] };
    });
    const layout = { pieces, storages: map.storages, unplaced: [],
        power: { poles: rows.filter(site => site.facility === POLE).map(site => ({ ...site, pole: true })) } };
    return updatePowerConnections(layout);
}

export function attachExistingEditor(root, { read, write, rv, tr }) {
    const field = id => root.querySelector('#existing-' + id);
    const svg = field('map');
    const type = field('type');
    const level = field('level');
    const mode = field('mode');
    const status = field('status');
    const option = (value, label) => new Option(tr(label), value);
    let selected = -1;
    let moving = false;
    let photoUrl = null;
    const types = [...FACILITIES.map(facility => facility.name), ...INFRASTRUCTURE];
    function localizePalette() {
        for (const item of type.options) item.textContent = tr(item.value);
        for (const item of mode.options) item.textContent = tr(item.value || 'Off');
        render();
    }
    type.replaceChildren(...types.map(facility => option(facility, facility)));
    const updatePalette = () => {
        const facility = type.value;
        const levels = facility === GENERATOR ? [1, 2, 3, 4, 5]
            : Object.keys(FACILITIES.find(f => f.name === facility)?.unlocks || { 1: 1 });
        const previous = level.value;
        level.replaceChildren(...levels.map(value => option(value, 'Lv. ' + value)));
        if (levels.map(String).includes(previous)) level.value = previous;
        mode.replaceChildren(option('', 'Off'), ...(CLIMATE[facility] || []).map(value => option(value, value)));
        field('mode-control').hidden = !Object.hasOwn(CLIMATE, facility);
        field('rotate-control').hidden = FACILITY_FOOTPRINTS[facility][0] === FACILITY_FOOTPRINTS[facility][1];
    };
    const render = () => {
        const sites = read().map(footprint);
        const plots = existingPlots(rv());
        const open = plots.filter(plot => plot.open);
        const inside = createInsideTest(open);
        const x = Math.min(...open.map(plot => plot.x)), y = Math.min(...open.map(plot => plot.y));
        const right = Math.max(...open.map(plot => plot.x + plot.w)), bottom = Math.max(...open.map(plot => plot.y + plot.h));
        svg.setAttribute('viewBox', [x, y, right - x, bottom - y].join(' '));
        const cells = plots.map(p => `<rect class="${p.open ? 'existing-open' : 'existing-locked'}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>`).join('');
        const shapes = sites.map((site, i) => {
            const invalid = !inside(site) || sites.some((other, n) => n !== i && overlap(site, other));
            return `<g data-existing-site="${i}" tabindex="0" role="button" aria-label="${site.facility} #${i + 1}" class="${i === selected ? 'selected' : ''} ${invalid ? 'invalid' : ''}">
                <title>${site.facility} #${i + 1} · Lv.${site.level}</title>
                <rect x="${site.x}" y="${site.y}" width="${site.w}" height="${site.h}"/>
                <text x="${site.x + site.w / 2}" y="${site.y + site.h / 2}">${initials(site.facility)}</text></g>`;
        }).join('');
        const climate = sites.filter(site => site.mode).map(site => `<rect class="existing-climate" x="${site.x + site.w / 2 - 4.5}" y="${site.y + site.h / 2 - 4.5}" width="9" height="9"/>`).join('');
        svg.innerHTML = `<defs><pattern id="existing-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 H 0 V 1"/></pattern></defs>
            ${cells}<rect x="${x}" y="${y}" width="${right - x}" height="${bottom - y}" fill="url(#existing-grid)"/>
            ${plots.map(p => `<text class="existing-plot-label" x="${p.x + 0.5}" y="${p.y + 1.2}">RV ${p.number}</text>`).join('')}
            ${climate}${shapes}`;
        const site = sites[selected];
        field('selection').hidden = !site;
        if (site) {
            field('selected').textContent = `${tr(site.facility)} #${selected + 1}`;
            field('x').value = site.x;
            field('y').value = site.y;
        }
        field('move').setAttribute('aria-pressed', String(moving));
        field('count').textContent = tr('{n} buildings on your map').replace('{n}', sites.length);
    };
    function commit(sites) {
        write(normalizeExistingSites(sites));
        status.textContent = '';
        render();
    }
    function select(index) {
        const site = read()[index];
        if (!site) return;
        selected = index;
        moving = false;
        type.value = site.facility;
        updatePalette();
        level.value = site.level;
        mode.value = site.mode || '';
        field('rotate').checked = site.rotated;
        render();
    }
    const fields = () => ({ facility: type.value, level: Number(level.value), mode: mode.value || null, rotated: field('rotate').checked });
    const setPosition = (x, y, index, options) => {
        const sites = [...read()];
        if (index === sites.length && sites.length >= MAX_SITES) return;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        sites[index] = { ...options, x: snap(x), y: snap(y) };
        selected = index;
        moving = false;
        commit(sites);
    };
    type.addEventListener('change', () => {
        selected = -1; moving = false; updatePalette(); render();
    });
    svg.addEventListener('click', event => {
        const hit = event.target.closest('[data-existing-site]');
        if (hit && !moving) return select(Number(hit.dataset.existingSite));
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
        setPosition(point.x, point.y, moving ? selected : read().length, fields());
    });
    svg.addEventListener('keydown', event => {
        const hit = event.target.closest('[data-existing-site]');
        if (hit && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            select(Number(hit.dataset.existingSite));
        }
    });
    field('move').addEventListener('click', () => { moving = !moving; render(); });
    field('apply').addEventListener('click', () => {
        const x = field('x'), y = field('y');
        if (x.reportValidity() && y.reportValidity()) setPosition(x.valueAsNumber, y.valueAsNumber, selected, fields());
    });
    field('remove').addEventListener('click', () => {
        const index = selected;
        selected = -1; moving = false; commit(read().filter((_, i) => i !== index));
    });
    field('photo').addEventListener('change', () => {
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        const file = field('photo').files[0];
        photoUrl = file && /^image\/(?:png|jpeg|webp)$/.test(file.type) ? URL.createObjectURL(file) : null;
        const preview = field('preview');
        preview.hidden = !photoUrl;
        if (photoUrl) preview.src = photoUrl; else preview.removeAttribute('src');
    });
    field('rv').addEventListener('input', render);
    document.addEventListener('aniimax-language-change', localizePalette);
    updatePalette();
    render();
    return render;
}
