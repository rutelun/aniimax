import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFacilityStock, bufferedBatches, haulingBatchTrips, haulingTravelSeconds,
    haulingWorkload, allocateHauling } from '../web/hauling.js';

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
    assert.equal(work.seconds['Mine|far'], 6.5); // double the loaded leg and weighted next pickup
    assert.equal(work.seconds['Well|near'], 4.5);
    assert.ok(Math.abs(work.busy - 200/3600) < 1e-12);
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
    ], haulingTravelSeconds(40));
    assert.equal(work.busy, 2);
});

test('a large harvest takes multiple trips according to the actual couriers carrying level', () => {
    const work = haulingWorkload({storages:[{x:-1,y:-1,w:2,h:2}],pieces:[{members:[
        {x:7,y:-1,w:2,h:2,weight:180,facility:'Farmland',crop:'large',stockLimit:35},
    ]}]}, [{facility:'Farmland',item_name:'large',status:'producing',facility_count:1,cycle_time:20}], 0,
    [{name:'large',yieldAmount:200}]);
    assert.equal(work.seconds['Farmland|large|1'],32);
    assert.equal(work.seconds['Farmland|large|2'],24);
    assert.equal(work.seconds['Farmland|large|3'],16);
    assert.ok(allocateHauling([{count:1,abilities:{Hauling:1}}], [0], work, 1).unassigned > 0);
    const stronger = allocateHauling([{count:1,abilities:{Hauling:3}}], [0], work, 1);
    assert.deepEqual(stronger.assignments,[[0,.8]]);
    assert.equal(stronger.unassigned,0);
});

test('a building accumulates several batches before sending a delivery, including the route bound', () => {
    const recipes = [{ name: 'wheat', yieldAmount: 5, facility_level: 1 }];
    const facilities = { Farmland: [{ level: 6, count: 1 }] };
    const crop = { x: 7, y: -1, w: 2, h: 2, weight: 60, facility: 'Farmland', crop: 'wheat' };
    assignFacilityStock([crop], facilities, new Map(recipes.map(recipe => [recipe.name, recipe])));
    assert.equal(crop.stockLimit, 30);
    assert.equal(bufferedBatches(recipes[0], crop.stockLimit), 6);
    const steps = [{ facility:'Farmland',item_name:'wheat',status:'producing',facility_count:1,cycle_time:60 }];
    const measured = haulingWorkload({ storages: [{ x:-1,y:-1,w:2,h:2 }], pieces: [{ members: [crop] }] }, steps, 0, recipes);
    const bounded = haulingWorkload({ storages: [], pieces: [] }, steps, haulingTravelSeconds(16), recipes, facilities);
    assert.equal(measured.seconds['Farmland|wheat'], 8 / 6);
    assert.equal(bounded.seconds['Farmland|wheat'], measured.seconds['Farmland|wheat']);
    assert.equal(haulingBatchTrips({ yieldAmount: 4, byproductAmount: 2 }, 3, 18), 2 / 3);
});

test('a powered building keeps the stock limit of its exact tier', () => {
    const standard = { weight: 1, facility: 'Well', crop: 'water' };
    const powered = { ...standard, electric_level: 4 };
    assignFacilityStock([standard, powered], { Well: [{ level: 4, count: 1 }, { level: 1, count: 1 }] }, new Map());
    assert.equal(standard.stockLimit, 300);
    assert.equal(powered.stockLimit, 340);
});
