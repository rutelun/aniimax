// Game item artwork from https://aniimo.gamevault.in/en/items/ in 64px atlas cells.
import sprites from './product-icons.json' with { type: 'json' };
import { abilityGlyph } from './ability-icons.js';
import { powerJobDetails } from './power-islands.js';
import { elapsed, recipeTransitions } from './recipe-schedule-view.js';

// Rates use the same steady-state batches and item sales as the displayed production plan.
export function productionFlow(plan, recipeTerms) {
    const nodes = new Map();
    function node(item) {
        if (!nodes.has(item)) nodes.set(item, { item, made: 0, sold: 0, grossSales: 0, inputs: new Map(), consumers: new Set(), depth: 0 });
        return nodes.get(item);
    }
    function addProduction(batches, outputs, inputs) {
        if (!(batches > 0)) return;
        for (const [id, yieldAmount] of outputs) node(id).made += batches * yieldAmount;
        const product = node(outputs[0][0]);
        for (const [ingredient, quantity] of inputs) {
            product.inputs.set(ingredient, (product.inputs.get(ingredient) || 0) + batches * quantity);
            node(ingredient).consumers.add(product.item);
        }
    }
    if (plan.schedule_sources?.length) {
        for (const source of plan.schedule_sources) addProduction(source.rate, source.outputs, source.inputs);
    } else {
        for (const row of plan.coin_items || []) {
            if (row.status !== 'producing' || !(row.cycle_time > 0) || !row.item_name) continue;
            const terms = recipeTerms(row.item_name);
            const outputs = [[terms.makes, terms.yield]];
            if (terms.byproduct) outputs.push(terms.byproduct);
            addProduction((row.busy_units ?? row.facility_count) / row.cycle_time, outputs, terms.takes);
        }
    }
    for (const stream of plan.income_streams || []) {
        if (!(stream.units_per_second > 0)) continue;
        const product = node(stream.item_name.replace(/^quick_/, ''));
        product.sold += stream.units_per_second;
        product.grossSales += stream.units_per_second * stream.sell_value;
    }

    // Each ingredient precedes all its consumers, even if a product has several inputs.
    const remaining = new Map([...nodes].map(([item, n]) => [item, n.inputs.size]));
    const queue = [...nodes.values()].filter(n => !n.inputs.size);
    for (const source of queue) {
        for (const item of source.consumers) {
            const consumer = node(item);
            consumer.depth = Math.max(consumer.depth, source.depth + 1);
            remaining.set(item, remaining.get(item) - 1);
            if (!remaining.get(item)) queue.push(consumer);
        }
    }
    const grossSales = [...nodes.values()].reduce((sum, product) => sum + product.grossSales, 0);
    return { nodes, grossSales };
}

export function allOutputSold(product, requirement) {
    const reserved = requirement && requirement.need > requirement.have && requirement.per_second > 0;
    // Production and sales may be summed from different floating-point rates.
    return !reserved && !product.consumers.size && product.made > 0 && product.sold >= product.made * (1 - 1e-8);
}

export function upgradeHorizon(plan, context) {
    if (!context || context.unavailable) return null;
    if (context.ready) return 0;
    const seconds = (plan.level_up_preview ?? plan.level_up)?.seconds;
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

// Give skipped columns a temporary waypoint so even distant customers influence
// the resource order. Compare sweeps by crossings, then by vertical travel.
function orderChain(group, upgradeItems) {
    const layers = [], vertices = new Map(), segments = [];
    function add(depth, node, priority) {
        const layer = layers[depth] ??= [];
        const v = {node, priority, row: layer.length, before: [], after: []};
        layer.push(v);
        return v;
    }
    for (const n of group) vertices.set(n.item, add(n.depth, n, upgradeItems.has(n.item)));
    for (const n of group) {
        for (const id of n.inputs.keys()) {
            let prev = vertices.get(id);
            for (let d = prev.node.depth + 1; d <= n.depth; d++) {
                const next = d === n.depth ? vertices.get(n.item) : add(d, null, upgradeItems.has(n.item));
                prev.after.push(next);
                next.before.push(prev);
                (segments[d] ??= []).push([prev, next]);
                prev = next;
            }
        }
    }
    let best, minCross = Infinity, minTravel = Infinity;
    function score() {
        let cross = 0, travel = 0;
        segments.forEach((gap, d) => gap.forEach(([a,b], i) => {
            travel += Math.abs((a.row + .5) / layers[d-1].length - (b.row + .5) / layers[d].length);
            for (let j = 0; j < i; j++) {
                const [c,e] = gap[j];
                if ((a.row - c.row) * (b.row - e.row) < 0) cross++;
            }
        }));
        if (cross < minCross || (cross === minCross && travel < minTravel)) {
            minCross = cross;
            minTravel = travel;
            best = layers.flat().filter(v => v.node).map(v => v.node);
        }
    }
    if (!group.some(n => upgradeItems.has(n.item))) score();
    for (let pass = 0; pass < 6; pass++) {
        const upward = pass % 2 === 0;
        for (const layer of upward ? [...layers].reverse() : layers) {
            const neighborRank = v => {
                const peers = upward ? v.after : v.before;
                return peers.length ? peers.reduce((sum, p) => sum + p.row, 0) / peers.length : v.row;
            };
            layer.sort((a,b) => Number(b.priority) - Number(a.priority) || neighborRank(a) - neighborRank(b));
            layer.forEach((v,i) => { v.row = i; });
        }
        score();
    }
    return best;
}

// Keep independent chains together so connectors do not cross unrelated products.
export function flowSections(nodes, requirements) {
    const upgradeItems = new Set(requirements.filter(r => r.name !== 'coins' && r.need > r.have && r.per_second > 0).map(r => r.name));
    // Put the branch leading to each required material first inside a mixed chain too.
    const upstream = [...upgradeItems];
    for (const item of upstream) {
        for (const id of nodes.get(item)?.inputs.keys() || []) {
            if (!upgradeItems.has(id)) { upgradeItems.add(id); upstream.push(id); }
        }
    }
    const sections = [], singles = new Map(), seen = new Set();
    for (const n of nodes.values()) {
        if (seen.has(n.item)) continue;
        const group = [n];
        seen.add(n.item);
        for (const member of group) {
            for (const id of [...member.inputs.keys(), ...member.consumers]) {
                if (seen.has(id)) continue;
                seen.add(id);
                group.push(nodes.get(id));
            }
        }
        const upgrade = group.some(n => upgradeItems.has(n.item));
        if (group.length === 1) {
            if (!singles.has(upgrade)) singles.set(upgrade, []);
            singles.get(upgrade).push(n);
        } else {
            sections.push({upgrade, nodes:orderChain(group, upgradeItems)});
        }
    }
    for (const [upgrade, items] of singles) sections.push({upgrade, nodes:items, singletons:true});
    return sections.sort((a,b) => Number(b.upgrade) - Number(a.upgrade));
}

// Busy time includes waiting for crops to grow. Manual and powered buildings have distinct crews.
export function flowBuildings(plan, termsFor, workersFor, layout) {
    const result = new Map(), mappedRecipes = new Set();
    const members = layout?.pieces.flatMap(piece => piece.members) || [];
    const machines = new Map(members.filter(m => m.scheduleId).map(m => [m.scheduleId, m]));
    const recipeKey = row => JSON.stringify([row.facility, row.item_name, row.electric_level ?? null]);
    function record(step, busy, count, site, buildingBusy = busy) {
        if (!(busy > 0 && count > 0)) return;
        const terms = termsFor(step.item_name);
        const powered = step.electric_level != null;
        const workers = powered ? [] : workersFor(step);
        for (const item of [terms.makes, terms.byproduct?.[0]].filter(Boolean)) {
            if (!result.has(item)) result.set(item, new Map());
            const groups = result.get(item), key = step.facility + '|' + powered;
            if (!groups.has(key)) groups.set(key, {facility:step.facility, powered, busy:0, buildingBusy:0, count:0, sites:new Set(), workers:new Map()});
            const group = groups.get(key);
            group.busy += busy;
            if (!site || !group.sites.has(site)) {
                group.count += count;
                group.buildingBusy += buildingBusy;
            }
            if (site) group.sites.add(site);
            for (const worker of workers) group.workers.set(JSON.stringify([worker.name, worker.form]), worker);
        }
    }
    const scheduled = plan.recipe_schedule?.sites || [];
    const scheduledIds = new Set(scheduled.map(site => site.id));
    const otherSites = members.filter(site => site.jobs?.length && !scheduledIds.has(site.scheduleId));
    for (const site of [...scheduled, ...otherSites]) {
        const power = site.power_percent ?? machines.get(site.id)?.power_percent;
        const loads = site.jobs.map(job => {
            const powered = (job.electric_level ?? site.electric_level) != null;
            return job.rate * job.cycle * (powered && power > 0 ? 120 / power : 1);
        });
        const total = loads.reduce((sum, load) => sum + load, 0);
        site.jobs.forEach((job, i) => {
            const step = {facility:site.facility, item_name:job.item, crew:job.crew, electric_level:job.electric_level ?? site.electric_level};
            record(step, loads[i], 1, site, total);
            mappedRecipes.add(recipeKey(step));
        });
    }
    for (const step of plan.coin_items || []) {
        if (step.status !== 'producing' || !step.item_name || mappedRecipes.has(recipeKey(step))) continue;
        const jobs = powerJobDetails(layout, step);
        if (jobs.length) record(step, jobs.reduce((sum, job) => sum + job.load, 0), jobs.length);
        else record(step, step.busy_units ?? step.facility_count, step.facility_count);
    }
    return result;
}

function icon(item, name) {
    const element = document.createElement('span');
    element.className = 'product-flow-icon';
    if (name) {
        element.setAttribute('role', 'img');
        element.setAttribute('aria-label', name);
        element.dataset.tip = name;
        element.tabIndex = 0;
    } else {
        element.setAttribute('aria-hidden', 'true');
    }
    const index = sprites.indexOf(item);
    if (index >= 0) element.style.backgroundPosition = `${-(index % 16) * 32}px ${-Math.floor(index / 16) * 32}px`;
    else element.style.backgroundImage = 'none';
    return element;
}

// The same inset protects the horizontal run and the bends beside a skipped card.
const cardClearance = 14;
const laneSpacing = 8;

// Open intervals for the center of a line through this column.
function openPassages(column, height) {
    const passages = [];
    let top = cardClearance;
    function add(bottom, below) {
        if (bottom >= top) passages.push({top, bottom, below});
    }
    for (const obstacle of column.occupied) {
        const clearance = obstacle.lane ? laneSpacing : cardClearance;
        add(obstacle.top - clearance, obstacle);
        top = Math.max(top, obstacle.bottom + clearance);
    }
    add(height - cardClearance);
    return passages;
}

function nearestLane({top, bottom}, preferred) {
    const steps = Math.floor((bottom - top) / laneSpacing);
    const first = (top + bottom - steps * laneSpacing) / 2;
    return first + laneSpacing * Math.max(0, Math.min(steps, Math.round((preferred - first) / laneSpacing)));
}

function preferredHeight(edge, tracks, i) {
    const x = (tracks[i].left + tracks[i].right) / 2;
    const fraction = (x - tracks[edge.start].right) / (tracks[edge.end].left - tracks[edge.start].right);
    return edge.y + (edge.ty - edge.y) * fraction;
}

// Count nearby bypasses before reserving their lanes. Otherwise the first
// arrow can consume the only slot in a gap and force the rest around the board.
export function crowdedPassages(edges, tracks, height) {
    const required = new Map();
    for (let i = 1; i < tracks.length - 1; i++) {
        const passages = openPassages(tracks[i], height);
        const demand = new Map();
        for (const edge of edges) {
            if (edge.start >= i || edge.end <= i) continue;
            const y = preferredHeight(edge, tracks, i);
            let best, distance = Infinity;
            for (const p of passages) {
                const d = Math.abs(nearestLane(p, y) - y);
                if (d < distance) { best = p; distance = d; }
            }
            if (best) demand.set(best, (demand.get(best) || 0) + 1);
        }
        for (const [p, count] of demand) {
            const span = (count - 1) * laneSpacing;
            if (p.below && p.bottom - p.top < span) required.set(p.below, 2 * cardClearance + span);
        }
    }
    return required;
}

// Reserve direct connections first, then balance the extra vertical travel of
// each orthogonal path against the crossings in the gutters it passes through.
export function routeFlowEdges(edges, tracks, height) {
    const gaps = tracks.map(() => []);
    const routes = new Map();
    const span = edge => edge.end - edge.start;
    for (const edge of [...edges].sort((a, b) => span(a) - span(b))) {
        const {start, end, y, ty} = edge;
        let states = [{y, cost: 0, previous: null}];
        for (let i = start + 1; i <= end; i++) {
            const track = tracks[i];
            const lanes = i === end ? [ty] : openPassages(track, height)
                .map(p => nearestLane(p, preferredHeight(edge, tracks, i)));
            states = lanes.map(lane => {
                let previous, cost = Infinity;
                for (const state of states) {
                    const crossings = gaps[i].filter(other =>
                        (state.y - other.from) * (lane - other.to) < 0).length;
                    // Allow a small detour to eliminate a crossing without sending the edge
                    // around an entire unrelated chain to save one intersection.
                    const total = state.cost + Math.abs(lane - state.y) + crossings * (4 * laneSpacing);
                    if (total < cost) { cost = total; previous = state; }
                }
                return {y: lane, cost, previous};
            });
        }
        const lanes = [];
        for (let state = states[0]; state; state = state.previous) lanes.push(state.y);
        lanes.reverse();
        for (let i = start + 1; i <= end; i++) {
            const lane = lanes[i - start];
            gaps[i].push({from: lanes[i - start - 1], to: lane});
            if (i < end) {
                tracks[i].occupied.push({top: lane, bottom: lane, lane: true});
                tracks[i].occupied.sort((a, b) => a.top - b.top);
            }
        }
        routes.set(edge, lanes);
    }
    return routes;
}

// A vertical run gets its own x coordinate wherever its y interval overlaps
// another run. Non-overlapping runs can reuse a lane in the same gutter.
export function gutterLanes(edges, routes, count) {
    const gutters = Array.from({length:count}, () => []);
    const neighbors = new Map(edges.map(edge => [edge, new Set()]));
    for (const edge of edges) {
        const route = routes.get(edge);
        for (let i = edge.start; i < edge.end; i++) {
            const from = route[i - edge.start], to = route[i - edge.start + 1];
            gutters[i].push({edge, from, to, low:Math.min(from,to), high:Math.max(from,to)});
        }
    }
    const slots = new Map(edges.map(edge => [edge, []]));
    const widths = gutters.map(runs => {
        // Descending runs bend from bottom to top, ascending ones from top to
        // bottom. This preserves the ordering of parallel paths at their turns.
        runs.sort((a,b) => (a.to >= a.from) - (b.to >= b.from)
            || (a.to >= a.from ? b.from - a.from : a.from - b.from));
        const placed = [];
        for (const run of runs) {
            let slot = 0;
            for (const other of placed) {
                if (run.low > other.high + laneSpacing || other.low > run.high + laneSpacing) continue;
                neighbors.get(run.edge).add(other.edge);
                neighbors.get(other.edge).add(run.edge);
                slot = Math.max(slot, other.slot + 1);
            }
            slots.get(run.edge).push(slot);
            placed.push({...run, slot});
        }
        return Math.max(1, ...placed.map(run => run.slot + 1));
    });
    // Sharing either endpoint also makes lines easy to confuse, even if their
    // ports are far enough apart to use the same lane.
    for (const edge of edges) for (const other of edges) {
        if (edge !== other && (edge.source === other.source || edge.target === other.target)) neighbors.get(edge).add(other);
    }
    const tones = new Map();
    const usage = Array(8).fill(0);
    for (const edge of [...edges].sort((a,b) => neighbors.get(b).size - neighbors.get(a).size)) {
        const scores = [...usage];
        for (const other of neighbors.get(edge)) {
            if (tones.has(other)) scores[tones.get(other)] += edges.length + 1;
        }
        const tone = scores.indexOf(Math.min(...scores));
        tones.set(edge, tone);
        usage[tone]++;
    }
    return {slots, widths, tones};
}

const svgNS = 'http://www.w3.org/2000/svg';
// Compact the headings on narrow screens without changing any recipe's column.
function fitBoard(board) {
    board.classList.remove('flow-tight');
    board.classList.toggle('flow-tight', board.offsetWidth > board.parentElement.clientWidth);
}

// Combine chains of the same depth so their sources share the left edge of the map.
function mapBands(sections) {
    const bands = [];
    for (const upgrade of [true, false]) {
        const byDepth = new Map(), standalone = [];
        for (const section of sections.filter(section => section.upgrade === upgrade)) {
            if (section.singletons) {
                standalone.push(...section.nodes);
                continue;
            }
            const depth = Math.max(...section.nodes.map(node => node.depth));
            if (!byDepth.has(depth)) byDepth.set(depth, []);
            byDepth.get(depth).push(section.nodes);
        }
        const depths = [...byDepth.keys()].sort((a, b) => b - a);
        if (depths.length && standalone.length) byDepth.get(depths.at(-1)).push(standalone);
        else if (standalone.length) {
            depths.push(0);
            byDepth.set(0, [standalone]);
        }
        for (const depth of depths) bands.push({upgrade, depth, chains: byDepth.get(depth)});
    }
    return bands;
}

// Place a recipe at the mean height of its inputs. Only move it away from that
// position to keep cards in the same chain inside their row and clear of each other.
function alignRecipes(board) {
    const centers = new Map();
    for (const stage of board.querySelectorAll('.product-flow-column')) {
        for (const stack of stage.querySelectorAll('.flow-chain-stack')) {
            const bounds = stack.getBoundingClientRect();
            const cards = [...stack.children].map(el => {
                const inputs = [...el.querySelectorAll('[data-input]')].map(port => centers.get(port.dataset.input));
                const rect = el.getBoundingClientRect();
                const desired = inputs.length && inputs.every(Number.isFinite)
                    ? inputs.reduce((sum, y) => sum + y, 0) / inputs.length
                    : bounds.top + el.offsetTop + rect.height / 2;
                return {el, height: rect.height, desired, margin: parseFloat(el.style.marginTop) || 0};
            });
            const gap = parseFloat(getComputedStyle(stack).rowGap);
            let floor = bounds.top;
            for (const card of cards) {
                card.top = Math.max(floor + card.margin, card.desired - card.height / 2);
                floor = card.top + card.height + gap;
            }
            let ceiling = bounds.bottom;
            for (const card of cards.reverse()) {
                card.top = Math.min(card.top, ceiling - card.height);
                const shift = card.top - bounds.top - card.el.offsetTop;
                card.el.style.transform = `translateY(${shift}px)`;
                centers.set(card.el.dataset.output, card.top + card.height / 2);
                ceiling = card.top - gap - card.margin;
            }
        }
    }
}

function drawLinks(board) {
    const svg = board.querySelector('svg');
    const origin = board.getBoundingClientRect();
    if (!origin.width) return;
    alignRecipes(board);
    const cards = new Map(), columns = new Map();
    for (const stage of board.querySelectorAll('.product-flow-column')) {
        const heading = stage.querySelector('h3').getBoundingClientRect();
        for (const card of stage.querySelectorAll('[data-output]')) {
            const rect = card.getBoundingClientRect(), left = rect.left - origin.left;
            cards.set(card.dataset.output, rect);
            if (!columns.has(left)) {
                columns.set(left, {left, right: rect.right - origin.left, occupied: [
                    {top: heading.top - origin.top, bottom: heading.bottom - origin.top}
                ]});
            }
            const column = columns.get(left);
            column.right = Math.max(column.right, rect.right - origin.left);
            column.occupied.push({top: rect.top - origin.top, bottom: rect.bottom - origin.top, element: card});
        }
    }
    const tracks = [...columns.values()].sort((a, b) => a.left - b.left);
    for (const column of tracks) column.occupied.sort((a, b) => a.top - b.top);
    const edges = [...board.querySelectorAll('[data-input]')].map(input => ({
        source: cards.get(input.dataset.input), target: cards.get(input.closest('[data-output]').dataset.output)
    }));
    const trackIndex = new Map(tracks.map((track, i) => [track.left, i]));
    for (const edge of edges) {
        edge.start = trackIndex.get(edge.source.left - origin.left);
        edge.end = trackIndex.get(edge.target.left - origin.left);
    }
    // Order the attachment points by the opposite end of each edge to avoid twists near a card.
    const center = rect => rect.top + rect.height / 2;
    for (const rect of cards.values()) {
        for (const [end, peer, key] of [['source','target','y'], ['target','source','ty']]) {
            const incident = edges.filter(edge => edge[end] === rect)
                .sort((a,b) => center(a[peer]) - center(b[peer]) || a[peer].left - b[peer].left);
            const spacing = Math.min(11, rect.height / (incident.length + 1));
            incident.forEach((edge, i) => {
                edge[key] = center(rect) - origin.top + (i - (incident.length - 1) / 2) * spacing;
            });
        }
    }
    // Leave enough routing space even when many long edges skip a full column of products.
    const skipped = column => edges.filter(({source, target}) =>
        source.right - origin.left < column.left && column.right < target.left - origin.left).length;
    board.style.setProperty('--flow-route-space', (2 * cardClearance + laneSpacing * Math.max(0, ...tracks.map(skipped))) + 'px');
    const height = board.getBoundingClientRect().height;
    let expanded = false;
    for (const [obstacle, required] of crowdedPassages(edges, tracks, height)) {
        const card = obstacle.element;
        if (!card?.previousElementSibling) continue;
        const base = parseFloat(getComputedStyle(card.parentElement).rowGap);
        // Allow one pixel for subpixel placement of the two cards.
        const extra = Math.ceil(required + 1 - base);
        if (extra > (parseFloat(card.style.marginTop) || 0)) {
            card.style.marginTop = extra + 'px';
            expanded = true;
        }
    }
    if (expanded) return drawLinks(board);
    const lines = document.createDocumentFragment();
    const routes = routeFlowEdges(edges, tracks, height);
    const {slots, widths, tones} = gutterLanes(edges, routes, tracks.length - 1);
    // Only widen a board when simultaneous vertical runs need another lane.
    // A wider board retains this space across resize-observer callbacks.
    const requiredGap = 2 * cardClearance + (Math.max(1, ...widths) - 1) * laneSpacing;
    if (requiredGap > parseFloat(getComputedStyle(board).columnGap)) {
        board.style.columnGap = requiredGap + 'px';
        return drawLinks(board);
    }
    for (const edge of edges) {
        const {source, target, y, ty, start, end} = edge;
        const x = source.right - origin.left, tx = target.left - origin.left;
        const path = document.createElementNS(svgNS, 'path');
        const levels = routes.get(edge);
        let d = `M ${x} ${y}`;
        for (let i = start; i < end; i++) {
            const gap = tracks[i+1].left - tracks[i].right;
            const step = Math.min(laneSpacing, (gap - 2 * cardClearance) / Math.max(1,widths[i]-1));
            const turn = tracks[i].right + gap/2 + (slots.get(edge)[i-start] - (widths[i]-1)/2) * step;
            const from = levels[i-start], to = levels[i-start+1];
            const r = Math.min(5, Math.abs(to - from)/2);
            const dy = Math.sign(to - from) * r;
            d += ` H ${turn-r} Q ${turn} ${from} ${turn} ${from+dy} V ${to-dy} Q ${turn} ${to} ${turn+r} ${to}`;
        }
        d += ` H ${tx}`;
        path.setAttribute('d', d);
        const tip = document.createElementNS(svgNS, 'path');
        tip.setAttribute('d', `M ${tx - 5} ${ty - 3} l 5 3 -5 3`);
        const gap = path.cloneNode();
        gap.setAttribute('class', 'flow-line-gap');
        path.dataset.tone = tip.dataset.tone = tones.get(edge);
        lines.append(gap, path, tip);
    }
    svg.replaceChildren(lines);
}

export function attachProductionFlow(card, { itemName, formatAmount, formatRevenue, formatDuration, formatPercent, translate, aniimoPortrait }) {
    const content = card.querySelector('.product-flow-content');
    const buttons = [...card.querySelectorAll('[data-flow-period]')];
    const toggle = card.querySelector('.collapse-toggle');
    const periods = card.querySelector('.product-flow-periods');
    const body = card.querySelector('#product-flow-body');
    toggle.addEventListener('click', () => {
        const expanded = body.hidden;
        toggle.setAttribute('aria-expanded', String(expanded));
        body.hidden = periods.hidden = !expanded;
    });
    const note = card.querySelector('.product-flow-note');
    const observer = new ResizeObserver(entries => entries.forEach(({target}) => {
        if (target.isConnected) drawLinks(target);
    }));
    let availableWidth = 0;
    const widthObserver = new ResizeObserver(() => {
        if (availableWidth === content.clientWidth) return;
        availableWidth = content.clientWidth;
        for (const board of content.querySelectorAll('.product-flow-board')) {
            fitBoard(board);
            drawLinks(board);
        }
    });
    widthObserver.observe(content);
    let period = 'hour', horizon = null, flow = null, requirements = [];
    let rewards = {}, stock = new Map(), getBuildings, buildings;
    let switchesByItem = new Map();
    function text(tag, value, className) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        element.textContent = value;
        return element;
    }
    function render() {
        observer.disconnect();
        content.replaceChildren();
        for (const button of buttons) {
            button.disabled = button.dataset.flowPeriod === 'rv' && horizon === null;
            button.setAttribute('aria-pressed', String(button.dataset.flowPeriod === period));
        }
        note.textContent = !flow ? 'Recipe data unavailable.' : !flow.nodes.size ? 'No production in this plan.'
            : horizon === null ? 'Average plan rates. No reachable RV upgrade in this plan.'
            : 'Average plan rates.';
        if (!flow?.nodes.size) return;
        if (period === 'rv') note.append(' ', text('span', formatDuration(horizon)));
        const seconds = {hour:3600, day:86400, rv:horizon}[period];
        const amount = rate => formatAmount(rate * seconds);
        function field(label, value, css) {
            const line = text('div', '', css);
            line.append(text('span', label), text('strong', value));
            return line;
        }
        function workerPortrait(worker) {
            const badge = text('span', '', 'production-portrait');
            badge.classList.toggle('prismana', !!worker.form?.includes('prismana'));
            const art = text('span', '', 'production-portrait-art');
            const fallback = text('span', translate(worker.name).slice(0, 2));
            const glyph = abilityGlyph(worker.ability);
            if (glyph) fallback.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${glyph}</svg>`;
            art.append(fallback);
            const src = aniimoPortrait(worker.form);
            if (src) {
                const img = new Image();
                img.alt = '';
                img.classList.toggle('game-head', src.includes('/UI_PetHead_'));
                img.referrerPolicy = 'no-referrer';
                img.addEventListener('load', () => img.classList.add('loaded'), {once:true});
                img.src = src;
                art.append(img);
            }
            badge.append(art);
            return badge;
        }
        function facilityBadge(group, baseResource) {
            const badge = text('span', '', 'flow-badge');
            const load = formatPercent(group.buildingBusy / group.count);
            const count = `×${group.count}`;
            const building = translate(group.facility) + (baseResource || group.count > 1 ? ' ' + count : '');
            const workers = [...group.workers.values()];
            const crew = group.powered ? translate('E-mode')
                : workers.map(w => translate(w.name)).join(', ') || translate('Assignment unavailable');
            const assignment = baseResource ? crew : translate('Building load') + ' ' + load + ' · ' + crew;
            const recipeLoad = !baseResource && group.buildingBusy - group.busy > 1e-6
                ? translate('On this recipe') + ' ' + formatPercent(group.busy / group.count) : '';
            badge.setAttribute('role', 'img');
            badge.tabIndex = 0;
            badge.dataset.tip = building;
            badge.dataset.tipDetail = [assignment, recipeLoad].filter(Boolean).join(' · ');
            badge.setAttribute('aria-label', building + ' · ' + badge.dataset.tipDetail);
            badge.append(text('span', baseResource ? count : load));
            if (group.powered) {
                const electric = text('span', '', 'flow-electric-hex');
                electric.innerHTML = `<svg viewBox="0 0 .866 1" aria-hidden="true">
                    <use href="#roster-hex-shape" transform="scale(.866 1)" class="layout-emode-frame"/>
                    <svg x=".063" y=".13" width=".74" height=".74" viewBox="0 0 24 24" class="layout-emode-bolt">${abilityGlyph('Lightning')}</svg>
                </svg>`;
                badge.append(electric);
            } else for (const worker of workers.slice(0, 3)) {
                badge.append(workerPortrait(worker));
            }
            if (workers.length > 3) badge.append(text('small', '+' + (workers.length - 3)));
            return badge;
        }
        function switchRow({site, start, from, to}) {
            const row = text('div', '', 'flow-switch');
            const name = site.facility ? translate(site.facility) + ' #' + site.id.split(':').at(-1) : site.id;
            row.tabIndex = 0;
            row.dataset.tip = name;
            const recipes = text('span', '', 'flow-switch-recipes');
            function appendRecipes(items) {
                if (!items.length) recipes.append(text('span', translate('Idle')));
                for (const id of items) recipes.append(icon(id.replace(/^quick_/, ''), itemName(id)));
            }
            appendRecipes(from);
            recipes.append(text('span', '→'));
            appendRecipes(to);
            row.append(recipes, text('strong', elapsed(start), 'flow-switch-time'));
            return row;
        }
        const saleLabels = new Map([['flow-sale-only', 'All output sold'], ['flow-sale-partial', 'Part of output sold']]);
        function product(n) {
            const el = text('article', '', 'product-flow-node');
            const req = requirements.find(r => r.name === n.item);
            el.dataset.output = n.item;
            el.dataset.depth = n.depth;
            const head = text('div', '', 'flow-node-head');
            const baseResource = !n.inputs.size;
            const crew = text('div', '', 'flow-facilities');
            const heading = text('h4', '');
            const produced = text('strong', amount(n.made), 'flow-produced');
            produced.setAttribute('aria-label', translate('Produced') + ' ' + produced.textContent);
            heading.append(icon(n.item, itemName(n.item)), produced);
            head.append(heading);
            for (const group of buildings?.get(n.item)?.values() || []) crew.append(facilityBadge(group, baseResource));
            if (crew.childElementCount) head.append(crew);
            el.append(head);
            if (n.sold > 0) {
                const sale = text('span', '', 'flow-sale');
                sale.tabIndex = 0;
                sale.setAttribute('role', 'img');
                let label = 'For sale';
                if (n.made > 0) {
                    const saleClass = allOutputSold(n, req) ? 'flow-sale-only' : 'flow-sale-partial';
                    el.classList.add(saleClass);
                    label = saleLabels.get(saleClass);
                }
                sale.dataset.tip = translate(label) + ' · ' + amount(n.sold);
                sale.dataset.tipDetail = translate('Sales revenue (coins)') + ' · ' + amount(n.grossSales);
                sale.setAttribute('aria-label', sale.dataset.tip + '. ' + sale.dataset.tipDetail);
                const coin = text('img', '', 'flow-coin');
                coin.src = './home-coin.webp';
                coin.alt = '';
                sale.append(text('span', amount(n.sold)), text('span', '→'), coin,
                    text('strong', formatRevenue(n.grossSales * seconds), 'flow-revenue'));
                el.append(sale);
            }
            for (const change of switchesByItem.get(n.item) || []) el.append(switchRow(change));
            const rewardRate = (rewards[n.item] || 0) / 86400;
            if (rewardRate) el.append(field('Quest rewards', amount(rewardRate), 'flow-amount'));
            if (stock.has(n.item)) {
                const consumed = [...n.consumers].reduce((sum, id) => sum + flow.nodes.get(id).inputs.get(n.item), n.sold);
                const draw = consumed - n.made - rewardRate;
                if (draw > 1e-8) el.append(field('From stock', formatAmount(Math.min(stock.get(n.item), draw * seconds)), 'flow-amount'));
            }
            const reserved = req && Math.min(Math.max(0, req.need-req.have), seconds * Math.max(0, req.per_second));
            if (reserved > 0) el.append(field('For RV upgrade', formatAmount(reserved), 'flow-reserve'));
            if (n.inputs.size) {
                const ribbon = text('div', '', 'flow-ingredients');
                for (const [id, rate] of n.inputs) {
                    const port = text('span', '', 'flow-input');
                    port.dataset.input = id;
                    port.append(icon(id, itemName(id)), text('span', amount(rate)));
                    ribbon.append(port);
                }
                el.append(ribbon);
            }
            return el;
        }
        const bands = mapBands(flowSections(flow.nodes, requirements));
        let lastCategory;
        for (const {upgrade, depth: lastDepth, chains} of bands) {
            if (lastCategory !== upgrade && bands[0].upgrade) {
                content.append(text('h3', upgrade ? 'For RV upgrade' : 'Other production', 'flow-category'));
            }
            lastCategory = upgrade;
            const scroll = text('div', '', 'product-flow-scroll');
            scroll.tabIndex = 0;
            scroll.setAttribute('role', 'region');
            scroll.setAttribute('aria-label', 'Production chain');
            const board = text('div', '', 'product-flow-board');
            const svg = document.createElementNS(svgNS, 'svg');
            svg.setAttribute('aria-hidden', 'true');
            board.append(svg);
            board.style.gridTemplateRows = `auto repeat(${chains.length}, auto)`;
            for (let depth = 0; depth <= lastDepth; depth++) {
                const col = text('div', '', 'product-flow-column');
                const label = !depth ? 'Resources' : depth === lastDepth ? 'Finished products' : 'Processing';
                col.append(text('h3', label));
                // A chain keeps its row across all stages, even when it has fewer outputs than inputs.
                chains.forEach((chain, index) => {
                    const members = chain.filter(node => node.depth === depth);
                    if (!members.length) return;
                    const stack = text('div', '', 'flow-chain-stack');
                    stack.style.gridRow = index + 2;
                    stack.append(...members.map(product));
                    col.append(stack);
                });
                board.append(col);
            }
            scroll.append(board);
            content.append(scroll);
            fitBoard(board);
            observer.observe(board);
        }
        for (const [saleClass, label] of saleLabels) {
            if (content.querySelector('.' + saleClass)) note.append(' ', text('span', translate(label), 'flow-sale-key ' + saleClass));
        }
        content.append(field('Gross sales (Home Coins)', amount(flow.grossSales), 'product-flow-total'));
    }
    document.addEventListener('aniimax-language-change', () => {
        if (flow) {
            buildings = getBuildings?.();
            render();
        }
    });
    card.addEventListener('click', e => {
        const button = e.target.closest('[data-flow-period]');
        if (button && !button.disabled) {
            period = button.dataset.flowPeriod;
            render();
        }
    });
    return (plan, context, terms, input, buildingDetails) => {
        getBuildings = buildingDetails;
        buildings = getBuildings?.();
        rewards = input?.quest_income_per_day || {};
        stock = new Map((input?.level_up ?? input?.level_up_preview)?.stock || []);
        horizon = upgradeHorizon(plan, context);
        if (period === 'rv' && horizon === null) period = 'hour';
        requirements = (plan.level_up_preview ?? plan.level_up)?.requirements || [];
        switchesByItem = new Map();
        for (const change of recipeTransitions(plan.recipe_schedule)) {
            const changed = [...change.from.filter(id => !change.to.includes(id)), ...change.to.filter(id => !change.from.includes(id))];
            for (const item of new Set(changed.map(id => id.replace(/^quick_/, '')))) {
                if (!switchesByItem.has(item)) switchesByItem.set(item, []);
                switchesByItem.get(item).push(change);
            }
        }
        flow = terms || plan.schedule_sources?.length ? productionFlow(plan, terms) : null;
        render();
    };
}
