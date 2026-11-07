import test from 'node:test';
import assert from 'node:assert/strict';
import { ANIIMO_WALK_SPEED, workerTravelDistance, workerLayoutCost } from '../web/worker-travel.js';
import { layOutHomeland } from '../web/layout.js';

const site = (x, worker = 0, visits = 10) => ({ x, y: 0, w: 2, h: 2, weight: 1, workers: [[worker, visits]] });
test('travel uses delivery speed and measures only a shared worker’s own workplaces', () => {
    assert.equal(ANIIMO_WALK_SPEED, 4);
    assert.equal(workerTravelDistance([site(0), site(12)]), 12);
    assert.equal(workerTravelDistance([site(0), site(12, 1)]), 0);
    assert.equal(workerTravelDistance([site(0), { ...site(100), workers: [] }]), 0);
    assert.ok(workerLayoutCost([site(0), site(30)]) > workerLayoutCost([site(0), site(3)]));
});
test('automatic distance weights frequently visited work sites', () => {
    const regular = workerTravelDistance([site(0), site(4), site(40)]);
    const nearbyWork = workerTravelDistance([site(0, 0, 100), site(4, 0, 100), site(40, 0, 1)]);
    assert.ok(nearbyWork < regular);
});
test('worker-aware placement keeps physical constraints and travel metadata', () => {
    const pieces = Array.from({ length: 8 }, (_, i) => ({ members: [{ ...site(0, i % 2, 20), facility: 'Crafting Table' }] }));
    const layout = layOutHomeland(pieces, [{ x: 0, y: 0, w: 20, h: 15 }], { w: 2, h: 2 }, 2);
    assert.equal(layout.unplaced.length, 0);
    const rectangles = [...layout.storages, ...layout.pieces.flatMap(p => p.members)];
    rectangles.forEach((a, i) => {
        assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= 20 && a.y + a.h <= 15);
        assert.ok(rectangles.slice(i + 1).every(b => a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y));
    });
    assert.ok(layout.pieces.flatMap(p => p.members).every(m => m.workers.length === 1));
    assert.ok(workerTravelDistance(layout.pieces.flatMap(p => p.members)) > 0);
});
