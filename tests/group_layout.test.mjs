import assert from 'node:assert/strict';
import test from 'node:test';
import { groupHomelandLayout } from '../web/group-layout.js';
import { createInsideTest } from '../web/layout.js';
import { productionGraph } from '../web/production-layout.js';

const cells = [{ x: 0, y: 0, w: 20, h: 15 }, { x: 20, y: 0, w: 20, h: 15 }];
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const piece = (facility, crop, extra = {}) => ({ members: [{ x: 0, y: 0, w: 2, h: 2, facility, crop, weight: 1, ...extra }] });
const pieces = [
    piece('Mine', 'copper_ore', { electric_level: 1 }),
    piece('Well', 'quick_fresh_water'),
    piece('Generator', null, { generator: true, weight: 0 }),
    piece('Woodworking Bench', 'standard_planks'),
    piece('Chimney Kiln', 'sintered_ore_brick'),
    { cluster: true, buildings: [{ x: 0, y: 0, w: 1, h: 1, facility: 'Sunlamp' }],
        plots: [{ w: 2, h: 2, weight: 4, zone: 0, facility: 'Farmland', crop: 'ginseng' }], planned: [{ x: 1, y: 0 }] },
];
const saleProducts = [['Mine', 'copper_ore'], ['Well', 'fresh_water']];

for (const style of ['courtyards', 'avenues', 'districts']) test(`${style} keep decor clear and group sold output, RV processors and climate plots`, async () => {
    const layout = await groupHomelandLayout(pieces, cells, { style, storageCount: 2, gap: 2, poleLimit: 3, saleProducts });
    assert.ok(layout);
    assert.deepEqual(layout.unplaced, []);
    assert.equal(layout.power.disconnected, 0);
    assert.equal(layout.groups.length, 2);
    const insideOpenLand = createInsideTest(cells);
    const reserved = layout.groups.flatMap(group => group.reserved);
    const members = layout.pieces.flatMap(piece => piece.members);
    const obstacles = [...members, ...layout.power.poles];
    const occupied = [...obstacles, ...layout.storages];
    assert.ok(occupied.every(insideOpenLand));
    assert.ok(occupied.every((r, i) => occupied.slice(i + 1).every(other => !overlaps(r, other))));
    assert.ok(obstacles.every(r => reserved.every(space => !overlaps(r, space))));
    if (style === 'districts') layout.groups.forEach(({ bounds, feature }, i) => {
        assert.equal(feature.w, bounds.w);
        assert.ok(feature.y === bounds.y || feature.y + feature.h === bounds.y + bounds.h);
        assert.ok(createInsideTest([feature])(layout.storages[i]));
    });
    const sales = layout.groups.find(group => group.purpose === 'sales');
    const rv = layout.groups.find(group => group.purpose === 'rv');
    assert.ok(layout.pieces.slice(0, 2).flatMap(piece => piece.members).every(createInsideTest([sales.bounds])));
    assert.ok(layout.pieces.slice(3).flatMap(piece => piece.members).every(createInsideTest([rv.bounds])));
    assert.equal(members.find(member => member.electric_level)?.power_connected, true);
});

test('a single store can keep its courtyard when separate purposes cannot fit', async () => {
    const layout = await groupHomelandLayout(pieces, cells, { style: 'courtyards', storageCount: 1, gap: 2, poleLimit: 3, saleProducts });
    assert.equal(layout.groups.length, 1);
    assert.equal(layout.groupPurposeFallback, true);
    assert.deepEqual(layout.unplaced, []);
    assert.equal(await groupHomelandLayout(pieces, cells, { style: 'courtyards', storageCount: 0, gap: 2, poleLimit: 3 }), null);
});

test('a full-width gap can be kept by moving the courtyard plaza off center', async () => {
    const lot = [{ x: 0, y: 0, w: 20, h: 15 }];
    const facilities = [piece('Mine', 'copper_ore', { w: 7, h: 7, electric_level: 1 }),
        piece('Generator', null, { generator: true, weight: 0 })];
    const layout = await groupHomelandLayout(facilities, lot, { style: 'courtyards', storageCount: 1, gap: 3, poleLimit: 2 });
    assert.equal(layout.groupGap, 3);
    assert.equal(layout.power.disconnected, 0);
    assert.deepEqual(layout.unplaced, []);
    const group = layout.groups[0];
    assert.notEqual(group.feature.x, 7);
    const obstacles = [...layout.pieces.flatMap(p => p.members), ...layout.power.poles];
    assert.ok(obstacles.every(r => group.reserved.every(space => !overlaps(r, space))));
    assert.ok([...obstacles, ...layout.storages].every(r => Number.isInteger(r.x * 2) && Number.isInteger(r.y * 2)));
});

test('a smaller gap keeps the groups when the requested gap cannot fit', async () => {
    const layout = await groupHomelandLayout([piece('Mine', 'shell', { w: 4, h: 4 })],
        [{ x: 0, y: 0, w: 13, h: 10 }], { style: 'courtyards', storageCount: 1, gap: 3, poleLimit: 0 });
    assert.equal(layout.requestedGroupGap, 3);
    assert.equal(layout.groupGap, 2);
    assert.equal(layout.groups.length, 1);
    assert.deepEqual(layout.unplaced, []);
});

test('workshops use disjoint letter ranges, and mines share a separate resource district', async () => {
    const lots = Array.from({ length: 4 }, (_, i) => ({ x: i % 2 * 20, y: Math.floor(i / 2) * 15, w: 20, h: 15 }));
    const factories = ['Aniipod Maker', 'Blazing Stove', 'Bouncy Brew Keg', 'Carousel Mill',
        'Chimney Kiln', 'Jukebox Dryer', 'Simmering Pot', 'Woodworking Bench'];
    const processors = factories.map((facility, i) => piece(facility, i === 2 ? null : `product_${i}`,
        { w: 4, h: 4, weight: i === 2 ? 0 : 1 }));
    const mines = Array.from({ length: 4 }, (_, i) => piece('Mine', i ? 'copper_ore' : 'shell', { w: 5, h: 5, electric_level: 1 }));
    const inputs = [...processors, ...mines, piece('Generator', null, { generator: true, weight: 0 })];
    const recipes = [
        ...factories.flatMap((_, i) => i === 2 ? [] : [{ item: `product_${i}`, makes: `product_${i}`, yield: 1, takes: [[i % 2 ? 'copper_ore' : 'shell', 1]] }]),
        ...['copper_ore', 'shell'].map(item => ({ item, makes: item, yield: 1, takes: [] })),
    ];
    const layout = await groupHomelandLayout(inputs, lots, { style: 'districts', storageCount: 4, gap: 2, poleLimit: 5, recipes });
    assert.equal(layout.groupGap, 2);
    assert.equal(layout.power.disconnected, 0);
    assert.deepEqual(layout.unplaced, []);
    const ranges = layout.groups.flatMap(group => group.range ? [group.range] : []).sort();
    assert.ok(ranges.length >= 2);
    assert.ok(ranges.every((range, i) => !i || ranges[i - 1][1] < range[0]));
    const district = member => layout.groups.findIndex(group => createInsideTest([group.bounds])(member));
    const nodes = productionGraph(layout.pieces, recipes, { includeIdle: true }).nodes;
    for (const { label, rect } of nodes.filter(node => node.label)) {
        const initial = label[0], [first, last] = layout.groups[district(rect)].range;
        assert.ok(initial >= first && initial <= last);
    }
    const [mineZone, ...others] = layout.pieces.slice(processors.length, processors.length + mines.length).map(p => district(p.members[0]));
    assert.ok(others.every(zone => zone === mineZone));
    assert.equal(layout.groups[mineZone].range, null);
    assert.deepEqual(layout.groups[mineZone].themes, ['mining']);
    const workshopAreas = layout.groups.flatMap(group => group.workshop ? [group.workshop] : []);
    assert.ok(workshopAreas.length >= 2);
    assert.ok(layout.pieces.slice(processors.length).flatMap(p => p.members)
        .every(member => workshopAreas.every(workshop => !overlaps(workshop, member))));
});
