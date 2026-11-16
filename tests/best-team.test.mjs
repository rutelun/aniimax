import assert from 'node:assert/strict';
import test from 'node:test';
import { placeBestJobs, recommendBestTeam } from '../web/best-team.js';
import { TASK_SWITCHING } from '../web/task-switching.js';

test('a catalog match shares a shift across different roles and delivery', () => {
    const { shifts, haulingSpare } = recommendBestTeam([
        { ability: 'Grass', level: 2, label: 'Sowing', busy: .25 },
        { ability: 'Earth', level: 3, label: 'Mine', busy: .4 },
    ], .2);
    assert.equal(shifts.length, 1);
    assert.ok(shifts[0].entry);
    assert.equal(shifts[0].abilities.Earth, 3);
    assert.equal(shifts[0].abilities.Hauling, 3);
    assert.deepEqual(new Set(shifts[0].tasks.keys()), new Set(['Mine', 'Sowing', 'Hauling to Storage Units']));
    assert.equal(haulingSpare, .35);
    assert.ok(Math.abs(shifts[0].busy - .85) < 1e-9);
});

test('a full-time resident keeps its own shift and its Leisure family', () => {
    const { shifts } = recommendBestTeam([
        { ability: 'Leisure', level: 4, family: '1019', label: 'Resident', busy: 2 },
        { ability: 'Water', level: 4, label: 'Well', busy: .5 },
    ]);
    assert.equal(shifts.length, 3);
    const residents = shifts.filter(shift => shift.tasks.has('Resident'));
    assert.equal(residents.length, 2);
    assert.ok(residents.every(shift => shift.entry?.family === '1019' && shift.busy === 1 && shift.tasks.size === 1));
});

test('opposite personalities and unmatched roles stay on separate shifts', () => {
    const { shifts } = recommendBestTeam([
        { ability: 'Water', level: 4, label: 'Well', busy: .4, personality: 'Faithful' },
        { ability: 'Water', level: 4, label: 'Workshop', busy: .4, personality: 'Tenacious' },
        { ability: 'Perfumery', level: 5, label: 'Perfume', busy: .1 },
    ]);
    assert.equal(shifts.length, 3);
    assert.ok(shifts.every(shift => shift.tasks.size === 1));
    assert.equal(shifts.find(shift => shift.tasks.has('Perfume')).entry, undefined);
});

test('walking consumes shift time before delivery and can force an additional worker', () => {
    const jobs = [
        { ability: 'Earth', level: 3, busy: .4, label: 'Mine', siteKey: 'Mine|ore', visitsPerShare: .01 },
        { ability: 'Grass', level: 2, busy: .25, label: 'Sowing', siteKey: 'Farmland|wheat', visitsPerShare: .01 },
    ];
    const layout = distance => ({ pieces: [{ members: [
        { facility: 'Mine', crop: 'ore', x: 0, y: 0, w: 2, h: 2, weight: 1 },
        { facility: 'Farmland', crop: 'wheat', x: distance, y: 0, w: 2, h: 2, weight: 1 },
    ] }] });
    const near = recommendBestTeam(placeBestJobs(jobs, layout(8)), .2);
    const far = recommendBestTeam(placeBestJobs(jobs, layout(80)), .2);
    assert.equal(near.shifts.length, 1);
    assert.ok(near.shifts[0].tasks.get('Walking between jobs') > 0);
    assert.equal(near.shifts[0].tasks.get('Hauling to Storage Units'), .2);
    assert.equal(far.shifts.length, 2);
    assert.ok(far.shifts.every(shift => shift.busy <= 1 + 1e-6));
});

test('Best gives equal farming work to a specialist if another shift can handle deliveries', () => {
    const { shifts } = recommendBestTeam([
        { ability: 'Grass', level: 2, label: 'Sowing', growing: true, visitsPerShare: .01, cropDistance: 8, busy: .3,
            point: [0, 0] },
        { ability: 'Earth', level: 3, label: 'Mine', busy: .6, visitsPerShare: .15, point: [80, 80] },
    ], .2);
    const farmer = shifts.find(shift => shift.tasks.has('Sowing'));
    const courier = shifts.find(shift => shift.tasks.has('Hauling to Storage Units'));
    assert.ok(farmer && courier && farmer !== courier);
    assert.equal(farmer.abilities.Hauling, undefined);
    assert.equal(farmer.busy, .3);
});

test('Best includes diversions to other eligible work without requiring Hauling', () => {
    const { shifts } = recommendBestTeam([
        { ability: 'Fire', level: 3, label: 'Cooking', busy: .25, point: [0, 0], visitsPerShare: .08 },
    ], 0, [{ ability: 'Fire', level: 3, point: [8, 0], rate: .01 }]);
    assert.equal(shifts.length, 1);
    assert.ok(Math.abs(shifts[0].tasks.get(TASK_SWITCHING) - .12) < 1e-9);
    assert.ok(Math.abs(shifts[0].busy - .37) < 1e-9);
});

test('Best keeps frequent crop jobs separate from workshops, even at the same location', () => {
    const point = [0, 0];
    const { shifts } = recommendBestTeam([
        { ability: 'Earth', level: 3, label: 'Mine', busy: .4, point },
        { ability: 'Grass', level: 2, label: 'Sowing', busy: .25, point, growing: true },
    ], .2);
    assert.equal(shifts.length, 2);
    const grower = shifts.find(shift => shift.tasks.has('Sowing'));
    assert.deepEqual([...grower.tasks], [['Sowing', .25]]);
    assert.equal(grower.abilities.Hauling, undefined);
});
