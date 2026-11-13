import test from 'node:test';
import assert from 'node:assert/strict';
import { jobsOnExistingSites, prepareExistingHomeland } from '../web/fixed-homeland.js';

test('a fixed layout preserves individual climate and power eligibility', () => {
    const map = prepareExistingHomeland([
        { facility: 'Storage Unit', x: 41, y: 48 },
        { facility: 'Woodland', level: 6, x: 44, y: 47 },
        { facility: 'Heat Furnace', mode: 'Warm', x: 48, y: 48 },
        { facility: 'Woodland', level: 6, x: 51, y: 54 },
        { facility: 'Crackle Generator', level: 4, x: 60, y: 47 },
        { facility: 'Crackle Power Pole', x: 65, y: 47 },
        { facility: 'Well', level: 3, x: 68, y: 47 },
        { facility: 'Well', level: 3, x: 75, y: 47 },
    ], 14, true, []);
    assert.equal(map.input.climate['Heat Furnace'], 1);
    assert.equal(map.input.generator_level, 4);
    assert.deepEqual(map.input.groups.filter(g => g.facility === 'Woodland').map(g => g.temperature), ['Warm', null]);
    assert.deepEqual(map.input.groups.filter(g => g.facility === 'Well').map(g => g.powered), [true, false]);
});

test('dedicated recipes stay in different buildings, with rates summing to the plan', () => {
    const sites = [
        { facility: 'Storage Unit', x: 41, y: 48 },
        { facility: 'Woodworking Bench', level: 3, x: 44, y: 48 },
        { facility: 'Woodworking Bench', level: 3, x: 48, y: 48 },
    ];
    const map = prepareExistingHomeland(sites, 14, false, []);
    const rates = [{ item: 'rough_lumber', rate: 0.01 }, { item: 'standard_planks', rate: 0.002 }];
    const rows = jobsOnExistingSites(map, { fixed_site_jobs: rates.map(job => ({ ...job, group: 0, units: 1, cycle: 34 })) });
    assert.deepEqual(rows.slice(1).map(row => row.jobs.map(({ item, rate }) => ({ item, rate }))), rates.map(job => [job]));
    assert.throws(() => prepareExistingHomeland([...sites, sites[1]], 14, false, []), /overlapping/);
});
