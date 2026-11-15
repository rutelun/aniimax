import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleRosterCopies } from '../web/roster-work.js';

const loads = shifts => shifts.map(shift => Number(shift.busy.toFixed(6)));

test('identical copies take separate routes and keep each route’s walking time', () => {
    const shifts = scheduleRosterCopies(2, [], [], [
        { jobs: [['Watering · Ginseng', 0.30], ['Walking', 0.30]] },
        { jobs: [['Watering · Quick Rice', 0.25], ['Walking', 0.16]] },
    ]);

    assert.deepEqual(loads(shifts), [0.6, 0.41]);
    assert.deepEqual([...shifts[0].tasks], [['Watering · Ginseng', 0.30], ['Walking', 0.30]]);
    assert.deepEqual([...shifts[1].tasks], [['Watering · Quick Rice', 0.25], ['Walking', 0.16]]);
});

test('full-time posts keep a copy occupied and local work can share its remaining shift', () => {
    const shifts = scheduleRosterCopies(3, [['Sunlamp', 1]], [['kiln', 1]], [
        { station: 'kiln', jobs: [['Refined Ore', 0.55]] },
        { jobs: [['Hauling', 0.70], ['Walking', 0.10]] },
        { jobs: [['Sowing', 0.30]] },
    ]);

    assert.deepEqual(loads(shifts), [1, 0.85, 0.8]);
    assert.deepEqual([...shifts[0].tasks], [['Sunlamp', 1]]);
    assert.equal(shifts[1].tasks.get('Refined Ore'), 0.55);
    assert.equal(shifts[2].tasks.has('Refined Ore'), false);
});

test('splits a route only when its workload cannot fit within a single available shift', () => {
    const shifts = scheduleRosterCopies(2, [], [], [
        { jobs: [['Sowing', 0.60], ['Walking', 0.60]] },
    ]);

    assert.deepEqual(loads(shifts), [1, 0.2]);
    for (const shift of shifts) assert.equal(shift.tasks.get('Sowing'), shift.tasks.get('Walking'));
});
