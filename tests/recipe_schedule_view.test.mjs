import test from 'node:test';
import assert from 'node:assert/strict';
import {facilitySchedule, recipeTransitions, renderRecipeSchedule} from '../web/recipe-schedule-view.js';

const schedule = {
    phases: [
        {duration: 6 * 3600, assignments: [{building: 'a', job: 'bread', batches: 2}, {building: 'b', job: 'bread', batches: 2}]},
        {duration: 8 * 3600, assignments: [{building: 'a', job: 'jam', batches: 3}, {building: 'b', job: 'bread', batches: 2}]},
        {duration: 10 * 3600, assignments: [{building: 'b', job: 'bread', batches: 2}]},
    ],
    initialStock: {wheat: 25}, switchedBuildings: ['a', 'a'], switches: [21600, 50400],
    jobs: [{id: 'bread', recipe: 'Bread', facility: 'Kitchen'}, {id: 'jam', recipe: 'Jam', facility: 'Kitchen'}],
    buildings: [{id: 'a', facility: 'Kitchen', level: 2}, {id: 'b', facility: 'Unchanged facility', level: 1}],
};

test('building cards keep physical units, zero-output selections and weighted loads across unrelated switches', () => {
    const buildings = ['a', 'b', 'c'].map(id => ({id, facility: 'Kitchen'}));
    const jobs = schedule.jobs;
    const phases = [
        {duration: 10, assignments: [{building: 'a', job: 'bread', batches: 0}, {building: 'b', job: 'bread', batches: 1}]},
        {duration: 20, assignments: [{building: 'a', job: 'jam', batches: 4}, {building: 'b', job: 'bread', batches: 1}]},
        {duration: 30, assignments: [{building: 'a', job: 'jam', batches: 1}, {building: 'b', job: 'bread', batches: 4}]},
    ];
    const plan = {buildings, jobs, phases, switchedBuildings: ['a']};
    const [a, b, c] = facilitySchedule(plan, 'Kitchen');
    assert.deepEqual(a.periods.map(p => [p.start, p.duration, p.jobs[0].job.id, p.jobs[0].rate]),
        [[0, 10, 'bread', 0], [10, 50, 'jam', 0.1]]);
    assert.deepEqual(b.periods, [{start: 0, duration: 60, jobs: [{job: jobs[0], rate: 0.1}]}]);
    assert.deepEqual(c.periods, [{start: 0, duration: 60, jobs: []}]);
    assert.equal(facilitySchedule(plan, 'Mill'), null);
    assert.equal(facilitySchedule(null, 'Kitchen'), null);
});

test('schedule opens above production with morning setup and changed recipes only', () => {
    const html = renderRecipeSchedule(schedule);
    assert.match(html, /Daily recipe schedule/);
    assert.match(html, /Morning/);
    assert.match(html, /\+6:00/);
    assert.match(html, /\+14:00/);
    assert.doesNotMatch(html, /\+24:00/);
    assert.match(html, /2 switches/);
    assert.equal((html.match(/scope="row"/g) || []).length, 1);
    assert.match(html, /<details class="recipe-schedule" open>/);
    assert.doesNotMatch(html, /Unchanged facility/);
    assert.match(html, /Bread/);
    assert.match(html, /Jam/);
    assert.match(html, /Idle/);
    assert.doesNotMatch(html, /wheat|buffer|replenished|checkbox|morning reset/i);
});

test('all custom labels and formatted amounts are escaped', () => {
    const html = renderRecipeSchedule(schedule, {
        itemName: name => `<img src=x onerror="bad()">${name}`,
        buildingName: () => '<script>bad()</script>',
        formatNumber: () => '<b>25</b>',
    });
    assert.doesNotMatch(html, /<script>|<img|<b>25/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /25/);
});

test('empty schedule is omitted and a no-switch day remains explicit', () => {
    assert.equal(renderRecipeSchedule(null), '');
    assert.equal(renderRecipeSchedule({phases: []}), '');
    const html = renderRecipeSchedule({...schedule, phases: [schedule.phases[0]], switchedBuildings: [], switches: [], initialStock: {}});
    assert.match(html, /0 switches/);
    assert.match(html, /No buildings change recipes/);
    assert.doesNotMatch(html, /<table/);
});

test('event total comes from actual switches even when a phase boundary changes no recipe', () => {
    const html = renderRecipeSchedule({...schedule, switches: [21600]});
    assert.match(html, /1 switch\/day/);
    assert.doesNotMatch(html, /2 switches/);
});

test('flow cards get only the transitions of the building that changed, including a switch to idle', () => {
    const plan = {...schedule, switchedBuildings: ['a', 'a', 'b']};
    assert.deepEqual(recipeTransitions(plan), [
        {site: schedule.buildings[0], start: 21600, from: ['Bread'], to: ['Jam']},
        {site: schedule.buildings[0], start: 50400, from: ['Jam'], to: []},
    ]);
    assert.deepEqual(recipeTransitions(null), []);
});
