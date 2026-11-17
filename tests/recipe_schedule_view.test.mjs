import test from 'node:test';
import assert from 'node:assert/strict';
import {renderRecipeSchedule} from '../web/recipe-schedule-view.js';

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

test('schedule uses common elapsed boundaries and lists switching buildings once', () => {
    const html = renderRecipeSchedule(schedule);
    assert.match(html, /Daily recipe schedule/);
    assert.match(html, /Morning/);
    assert.match(html, /\+6:00/);
    assert.match(html, /\+14:00/);
    assert.match(html, /\+24:00/);
    assert.match(html, /2 switches/);
    assert.equal((html.match(/<th scope="row">/g) || []).length, 1);
    assert.doesNotMatch(html, /Unchanged facility/);
    assert.match(html, /Bread/);
    assert.match(html, /Jam/);
    assert.match(html, /Idle/);
    assert.match(html, /25 wheat/);
    assert.match(html, /replenished daily/);
    assert.match(html, /morning reset does not count/i);
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
    assert.match(html, /&lt;b&gt;25/);
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
    assert.match(html, /1 switch;/);
    assert.doesNotMatch(html, /2 switches/);
});
