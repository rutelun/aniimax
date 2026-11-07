import assert from 'node:assert/strict';
import test from 'node:test';
import { layOutHomeland, nearestStorage } from '../web/layout.js';
import { storageUnitLimit } from '../web/facility-config.js';

const cells = [{ x: 0, y: 0, w: 20, h: 15 }, { x: 20, y: 0, w: 20, h: 15 }];
const pieces = Array.from({ length: 24 }, (_, index) => ({
    members: [{ x: 0, y: 0, w: 2, h: 2, weight: 5 + index, facility: 'Farmland' }],
}));
const overlap = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const cost = layout => layout.pieces.flatMap(p => p.members).reduce((sum, member) => {
    const storage = nearestStorage(member, layout.storages);
    return sum + member.weight * Math.hypot(member.x + member.w / 2 - storage.x - storage.w / 2,
        member.y + member.h / 2 - storage.y - storage.h / 2);
}, 0);

test('storage placement follows the RV rank table', () => {
    assert.deepEqual(Array.from({ length: 20 }, (_, index) => storageUnitLimit(index + 1)),
        [0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 8]);
});

test('multiple storage units shorten hauling and keep every placed facility clear', () => {
    const single = layOutHomeland(pieces, cells);
    const multiple = layOutHomeland(pieces, cells, { w: 2, h: 2 }, 3);
    assert.equal(multiple.unplaced.length, 0);
    assert.ok(multiple.storages.length > 1 && multiple.storages.length <= 3);
    assert.ok(cost(multiple) < cost(single));
    const rectangles = [...multiple.storages, ...multiple.pieces.flatMap(p => p.members)];
    rectangles.forEach((rectangle, index) => {
        assert.ok(rectangle.x >= 0 && rectangle.y >= 0
            && rectangle.x + rectangle.w <= 40 && rectangle.y + rectangle.h <= 15);
        assert.ok(rectangles.slice(index + 1).every(other => !overlap(rectangle, other)));
    });
});

test('storage additions keep environment plots in their planned coverage', () => {
    const cluster = {
        cluster: true,
        buildings: [{ x: 0, y: 0, w: 2, h: 2, facility: 'Sunlamp', building: true }],
        plots: Array.from({ length: 4 }, () => ({ w: 2, h: 2, weight: 15, zone: 0, facility: 'Farmland' })),
        planned: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }],
    };
    const layout = layOutHomeland([cluster, ...pieces.slice(0, 8)], cells, { w: 2, h: 2 }, 3);
    assert.equal(layout.unplaced.length, 0);
    const [building, ...plots] = layout.pieces[0].members;
    const coverage = { x: building.x + building.w / 2 - 4.5, y: building.y + building.h / 2 - 4.5, w: 9, h: 9 };
    assert.ok(plots.every(plot => overlap(plot, coverage)));
    assert.ok(layout.storages.every(storage => layout.pieces.flatMap(p => p.members).every(member => !overlap(storage, member))));
});

test('RV without storage keeps the layout available without delivery targets', () => {
    const layout = layOutHomeland(pieces.slice(0, 3), cells, { w: 2, h: 2 }, 0);
    assert.deepEqual(layout.storages, []);
    assert.equal(layout.storage, null);
    assert.equal(layout.unplaced.length, 0);
    assert.equal(nearestStorage(layout.pieces[0].members[0], layout.storages), null);
});
