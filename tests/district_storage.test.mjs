import assert from 'node:assert/strict';
import test from 'node:test';
import { districtStorageIndices, improveDistrictStorage } from '../web/district-storage.js';
import { layoutTravelCost } from '../web/layout.js';

const at = (x, y, weight) => ({ x, y, w: 2, h: 2, weight });
const layout = {
    storages: [at(8, 0), at(25, 0)],
    pieces: [at(2, 8, 40), at(15, 8, 25)].map(member => ({ members: [member] })),
    power: { poles: [at(4, 8)] },
};
const bounds = [{ x: 0, y: 0, w: 20, h: 14 }, { x: 23, y: 0, w: 8, h: 14 }];
const groups = [{ bounds: bounds[0], range: ['A', 'C'] }, { bounds: bounds[1] }];

test('a spare store moves into the busy zone and each cluster gets a short route', () => {
    const result = improveDistrictStorage(layout, groups);
    assert.deepEqual(districtStorageIndices(result.storages, groups), [[0, 1], []]);
    assert.ok(layoutTravelCost(result) < layoutTravelCost(layout) * .3);
    assert.ok(result.storages.every(store => !(store.x === 4 && store.y === 8)));
    assert.deepEqual(layout.storages, [at(8, 0), at(25, 0)]);
});

test('storage relocation respects both the income check and the last workshop store', () => {
    const guarded = improveDistrictStorage(layout, groups, candidate =>
        candidate.storages.every((store, i) => store.x === layout.storages[i].x && store.y === layout.storages[i].y));
    assert.deepEqual(guarded.storages, layout.storages);
    const protectedGroups = [groups[0], { bounds: bounds[1], range: ['D', 'F'] }];
    const result = improveDistrictStorage(layout, protectedGroups);
    assert.deepEqual(districtStorageIndices(result.storages, protectedGroups), [[0], [1]]);
    assert.ok(layoutTravelCost(result) < layoutTravelCost(layout));
});
