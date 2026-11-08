import assert from 'node:assert/strict';
import test from 'node:test';
import { layOut, layOutHomeland, nearestStorage, layoutCost } from '../web/layout.js';
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

test('refinement fills nearby holes with idle facilities even when worker routes are enabled', () => {
    const pieces = [
        { members: [{ x: 0, y: 0, w: 2, h: 2, weight: 5, workers: [[0, 2]] }] },
        { members: [{ x: 0, y: 0, w: 2, h: 2, weight: 0, facility: 'Idle table' }] },
    ];
    const initialLayout = { pieces: [
        { members: [{ ...pieces[0].members[0], x: 1, y: -1 }] },
        { members: [{ ...pieces[1].members[0], x: 9, y: -1 }] },
    ] };
    const layout = layOut(pieces, { cells: [{ x: -12, y: -8, w: 24, h: 16 }], initialLayout });
    assert.equal(layout.unplaced.length, 0);
    const idle = layout.pieces[1].members[0];
    assert.ok(Math.hypot(idle.x + 1, idle.y + 1) <= 2.01, 'idle building must use a free nearby position');
    assert.ok(!overlap(idle, layout.pieces[0].members[0]));
});

test('continuing a rotated environment layout preserves coverage and all physical units', () => {
    const pieces = [{ cluster: true,
        buildings: [{ x: 0, y: 0, w: 2, h: 2, weight: 0 }],
        plots: Array.from({ length: 4 }, () => ({ w: 2, h: 2, weight: 3, zone: 0, sensitive: true })),
        planned: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }],
    }, ...Array.from({ length: 5 }, () => ({ members: [{ x: 0, y: 0, w: 2, h: 3, weight: 1 }] }))];
    const initialLayout = layOut(pieces);
    const layout = layOut(pieces, { initialLayout });
    assert.equal(layout.unplaced.length, 0);
    assert.equal(layout.pieces.flatMap(p => p.members).length, 10);
    const [building, ...plots] = layout.pieces[0].members;
    const coverage = { x: building.x - 3.5, y: building.y - 3.5, w: 9, h: 9 };
    assert.ok(plots.every(plot => overlap(plot, coverage)));
    const rectangles = [...layout.storages, ...layout.pieces.flatMap(p => p.members)];
    assert.ok(rectangles.every((r, i) => rectangles.slice(i + 1).every(other => !overlap(r, other))));
    assert.ok(cost(layout) <= cost(initialLayout) + 1e-5);
});

test('a frequent large producer can replace four small units in a fully occupied nearer bay', () => {
    const members = [
        { x: 10, y: 0, w: 4, h: 4, weight: 100, facility: 'Frequent producer' },
        ...[2, 4].flatMap(x => [0, 2].map(y => ({ x, y, w: 2, h: 2, weight: 0.1, facility: 'Infrequent producer' }))),
        { x: 6, y: 0, w: 4, h: 4, weight: 0, facility: 'Fixed building' },
    ];
    const pieces = members.map(m => ({ members: [{ ...m, x: 0, y: 0 }] }));
    const initialLayout = { pieces: members.map(m => ({ members: [m] })) };
    const options = { cells: [{ x: 0, y: 0, w: 14, h: 4 }],
        storages: [{ x: 0, y: 0, w: 2, h: 2 }], initialLayout, fixedPieces: new Set([5]) };
    const singleMoves = layOut(pieces, options);
    assert.equal(singleMoves.pieces[0].members[0].x, 10, 'single-building moves cannot escape this packing');
    const exchanged = layOut(pieces, { ...options, exchangeBudget: 24 });
    assert.equal(exchanged.pieces[0].members[0].x, 2);
    assert.equal(exchanged.unplaced.length, 0);
    assert.equal(exchanged.pieces.flatMap(p => p.members).length, members.length);
    assert.ok(layoutCost(exchanged) < layoutCost(singleMoves) / 2);
    assert.deepEqual(exchanged.pieces[5].members[0], members[5]);
    const rectangles = [...exchanged.storages, ...exchanged.pieces.flatMap(p => p.members)];
    assert.ok(rectangles.every((r, i) => rectangles.slice(i + 1).every(other => !overlap(r, other))));
});

test('a shorter delivery route is rejected when the joint move increases shared worker travel more', () => {
    const members = [
        { x: 10, y: 0, w: 4, h: 4, weight: 100, workers: [[0, 10000]] },
        ...[2, 4].flatMap(x => [0, 2].map(y => ({ x, y, w: 2, h: 2, weight: 0.1 }))),
        { x: 6, y: 0, w: 4, h: 4, weight: 0 },
        { x: 14, y: 0, w: 2, h: 4, weight: 0, workers: [[0, 10000]] },
    ];
    const pieces = members.map(m => ({ members: [{ ...m, x: 0, y: 0 }] }));
    const options = { cells: [{ x: 0, y: 0, w: 16, h: 4 }], storages: [{ x: 0, y: 0, w: 2, h: 2 }],
        initialLayout: { pieces: members.map(m => ({ members: [m] })) }, fixedPieces: new Set([5, 6]) };
    const initial = layOut(pieces, options);
    const exchanged = layOut(pieces, { ...options, exchangeBudget: 24 });
    assert.equal(exchanged.pieces[0].members[0].x, 10);
    assert.equal(exchanged.unplaced.length, 0);
    assert.ok(layoutCost(exchanged) <= layoutCost(initial) + 1e-6);
});
