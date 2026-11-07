import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haulingWorkload, allocateHauling } from '../web/hauling.js';

test('delivery goes through storage to the next frequency-weighted pickup', () => {
    const layout = { storages: [{x:-1,y:-1,w:2,h:2}], pieces: [{members:[
        {x:7,y:-1,w:2,h:2,weight:10,facility:'Mine',crop:'far'},
        {x:3,y:-1,w:2,h:2,weight:30,facility:'Well',crop:'near'},
    ]}] };
    const steps = [
        {facility:'Mine',item_name:'far',status:'producing',facility_count:1,cycle_time:360},
        {facility:'Well',item_name:'near',status:'producing',facility_count:1,cycle_time:120},
    ];
    const work = haulingWorkload(layout, steps);
    assert.equal(work.seconds['Mine|far'], 3.25); // 8/4 loaded + mean next pickup 5/4
    assert.equal(work.seconds['Well|near'], 2.25); // 4/4 loaded + mean next pickup 5/4
    assert.ok(Math.abs(work.busy - 100/3600) < 1e-12);
});

test('couriers share existing work hours without assigning delivery to another ability', () => {
    const members = [{count:1,abilities:{Hauling:3,Fire:3}}, {count:3,abilities:{Water:3}}];
    const result = allocateHauling(members, [.8,0], .4, 1);
    assert.deepEqual(result.assignments, [[0, .19999999999999996]]);
    assert.ok(Math.abs(result.unassigned - .2) < 1e-12);
    assert.equal(result.reserveCount, 0);
    const unlimited = allocateHauling(members, [.8,0], .4);
    assert.equal(unlimited.reserveCount, 1);
    assert.ok(Math.abs(unlimited.reserveBusy - .2) < 1e-12);
    assert.equal(unlimited.unassigned, 0);
});

test('delivery uses spare hours of active copies before increasing headcount', () => {
    const result = allocateHauling([{count:5,abilities:{Hauling:1}}], [1.2], .7, 2);
    assert.deepEqual(result.assignments, [[0,.7]]);
    assert.equal(result.reserveCount, 0);
    assert.equal(result.unassigned, 0);
});

test('a full resident cannot also deliver; missing layouts do not make hauling free', () => {
    const allocation = allocateHauling([{count:1,abilities:{Hauling:3,Leisure:3}}], [1], .1, 1);
    assert.ok(allocation.unassigned > .09);
    const work = haulingWorkload({pieces:[],storages:[]}, [
        {facility:'Well',item_name:'water',status:'producing',facility_count:1,cycle_time:10},
    ], 20);
    assert.equal(work.busy, 2);
});

test('a large harvest takes multiple trips according to the actual couriers carrying level', () => {
    const work = haulingWorkload({storages:[{x:-1,y:-1,w:2,h:2}],pieces:[{members:[
        {x:7,y:-1,w:2,h:2,weight:360,facility:'Farmland',crop:'large'},
    ]}]}, [{facility:'Farmland',item_name:'large',status:'producing',facility_count:1,cycle_time:10}], 0,
    [{name:'large',yieldAmount:200}]);
    assert.equal(work.seconds['Farmland|large|1'],16);
    assert.equal(work.seconds['Farmland|large|2'],12);
    assert.equal(work.seconds['Farmland|large|3'],8);
    assert.ok(allocateHauling([{count:1,abilities:{Hauling:1}}], [0], work, 1).unassigned > 0);
    const stronger = allocateHauling([{count:1,abilities:{Hauling:3}}], [0], work, 1);
    assert.deepEqual(stronger.assignments,[[0,.8]]);
    assert.equal(stronger.unassigned,0);
});
