import test from 'node:test';
import assert from 'node:assert/strict';
import { connectPower, powerLinked } from '../web/power-layout.js';
import { powerPoleLimit, generatorLimit } from '../web/facility-config.js';
import { allocateTurnFacilities } from '../web/turn-jobs.js';

const generator = (x = 1, y = 4) => ({ x, y, w: 2, h: 2, generator: true });
const consumer = (x, y = 4) => ({ x, y, w: 2, h: 2, electric_level: 4 });
const cells = [{ x: 0, y: 0, w: 40, h: 15 }];
const layout = members => ({ storages: [], pieces: [{ members }] });
test('power placement caps follow module and RV unlocks', () => {
    assert.deepEqual([11, 12, 13, 14, 16, 18, 20].map(powerPoleLimit), [0, 6, 6, 12, 18, 24, 30]);
    assert.deepEqual([11, 12, 14, 15, 17, 18, 20].map(generatorLimit), [0, 1, 1, 2, 2, 3, 3]);
});
test('direct generator coverage does not add unnecessary poles', () => {
    const result = connectPower(layout([generator(), consumer(6)]), cells, 6);
    assert.equal(result.power.poles.length, 0);
    assert.equal(result.power.disconnected, 0);
    assert.equal(result.pieces[0].members[1].power_connected, true);
});
test('distant electric buildings get a connected pole route on clear open land', () => {
    const source = generator(); const target = consumer(35); const other = consumer(1);
    const result = connectPower(layout([source, target, other]), cells, 6);
    assert.ok(result.power.poles.length > 0 && result.power.poles.length <= 6);
    assert.equal(result.power.disconnected, 0);
    const rectangles = [source, target, other, ...result.power.poles];
    const overlaps = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) + 1e-6
        && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y) + 1e-6;
    rectangles.forEach((r, i) => {
        assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 40 && r.y + r.h <= 15);
        assert.ok(rectangles.slice(i + 1).every(other => !overlaps(r, other)));
    });
    const reached = new Set([source]);
    for (let i = 0; i < rectangles.length; i++) for (const r of rectangles)
        if ([...reached].some(n => powerLinked(n, r))) reached.add(r);
    assert.ok(reached.has(target));
});
test('pole cap and missing generators leave explicit disconnected consumers', () => {
    const result = connectPower(layout([generator(), consumer(35), consumer(1)]), cells, 0, false);
    assert.equal(result.power.poles.length, 0);
    assert.equal(result.power.disconnected, 2);
    assert.equal(result.pieces[0].members[1].power_connected, false);
    assert.equal(connectPower(layout([consumer(2)]), cells, 6).power.disconnected, 1);
});
test('hauling layout is regrouped when its scattered electric facilities exceed the pole budget', () => {
    const result = connectPower(layout([generator(), consumer(35), consumer(1)]), cells, 0);
    assert.equal(result.power.disconnected, 0);
    assert.equal(result.power.poles.length, 0);
});
test('separate generators join the same grid and storage blocks pole footprints', () => {
    const source = layout([generator(), generator(24)]);
    source.storages = [{ x: 8, y: 2, w: 8, h: 8 }];
    const result = connectPower(source, cells, 6);
    assert.equal(result.power.disconnected, 0);
    assert.ok(result.power.poles.every(r => r.x + r.w <= 8 || r.x >= 16 || r.y + r.h <= 2 || r.y >= 10));
});
test('shared turn facilities retain the electric building level per physical unit', () => {
    const rows = [
        { item_name: 'electric', facility: 'Bench', cycle_time: 20, facility_count: 1, busy_units: 0.4, electric_level: 4 },
        { item_name: 'normal', facility: 'Bench', cycle_time: 10, facility_count: 1, busy_units: 0.5 },
    ];
    const units = allocateTurnFacilities(rows, () => 2, () => true).get('Bench');
    assert.equal(units[0][0].electric_level, 4);
    assert.equal(units[1][0].electric_level, undefined);
});
