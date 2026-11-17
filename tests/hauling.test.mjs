import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFacilityStock, bufferedBatches, haulingBatchTrips, haulingTravelSeconds, haulingWorkSeconds,
    haulingWorkload, allocateHauling } from '../web/hauling.js';
import { buildDispatch, estimateJobSwitching, rosterJobSwitching } from '../web/task-switching.js';

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
    assert.equal(work.seconds['Mine|far'], 3.25);
    assert.equal(work.seconds['Well|near'], 2.25);
    assert.ok(Math.abs(work.busy - 100/3600) < 1e-12);
    assert.ok(Math.abs(work.trips - 40/3600) < 1e-12);
    const withTravel = haulingWorkload(layout, steps, 0, [], null, true);
    assert.equal(withTravel.seconds['Mine|far'], 3.25);
    assert.equal(withTravel.seconds['Well|near'], 2.25);
    assert.ok(Math.abs(withTravel.busy - 100/3600) < 1e-12);
    assert.equal(haulingWorkSeconds(40, true), haulingTravelSeconds(40, true));
});

test('an available delivery can interrupt field work even without a planned delivery assignment', () => {
    const members = [
        { count: 1, abilities: { Grass: 3, Hauling: 3 } },
        { count: 1, abilities: { Grass: 3 } },
        { count: 1, abilities: { Water: 3, Hauling: 3 } },
    ];
    const routes = [0, 1].map(member => ({ member, facility: 'Farmland', item: 'wheat', job_rate: .05 }));
    const layout = { storages: [{ x: 0, y: 0, w: 2, h: 2 }], pieces: [{ members: [
        { facility: 'Farmland', crop: 'wheat', x: 8, y: 0, w: 2, h: 2, batchWeight: 180 },
    ] }] };
    const withoutDelivery = buildDispatch(layout, [], { trips: 0 }, new Set());
    assert.deepEqual(rosterJobSwitching(withoutDelivery, routes, members, [.5, .5, .5], []), []);
    const hauling = { trips: .01, tripSites: [{ point: [13, 1], returnFrom: [1, 1], rate: .01 }] };
    const switching = rosterJobSwitching(buildDispatch(layout, [], hauling, new Set()), routes, members, [.5, .5, .5], []);
    assert.equal(switching.length, 1);
    assert.equal(switching[0][0], 0);
    assert.ok(Math.abs(switching[0][1] - .015) < 1e-9);
    const cargo = allocateHauling(members, [.515, .5, .5], .2, Infinity, [], [.015, 0, 0]);
    assert.deepEqual(cargo.assignments, [[2, .2]]);
});

test('a spare courier protects the grower, with the grower as fallback at the headcount limit', () => {
    const members = [{ count: 1, abilities: { Grass: 3, Hauling: 4 } },
        { count: 1, abilities: { Hauling: 3 } }];
    const growers = new Set([0]);
    assert.deepEqual(allocateHauling(members, [.2, 0], .3, Infinity, [], [], growers).assignments, [[1, .3]]);
    assert.equal(allocateHauling(members.slice(0, 1), [.2], .3, Infinity, [], [], growers).reserveCount, 1);
    assert.deepEqual(allocateHauling(members, [.2, 0], .3, 1, [], [], growers).assignments, [[0, .3]]);
    const copies = allocateHauling([{ ...members[0], count: 2 }], [.2], .3, 2, [], [], growers);
    assert.deepEqual(copies.dedicated, [[0, .3]]);
    assert.deepEqual(copies.assignments, []);
    assert.equal(copies.reserveCount, 0);
});

test('new jobs in another workshop use the distance from previous sites at dispatch', () => {
    const workers = [
        { abilities: { Artisanship: 3 }, free: .5, spare: .5, homes: [
            { point: [0, 0], rate: .05 }, { point: [8, 0], rate: .05 },
        ] },
        { abilities: { Artisanship: 3 }, free: .5, spare: .5 },
        { abilities: { Artisanship: 1 }, free: 1, spare: 1 },
    ];
    const opportunities = [
        { ability: 'Artisanship', level: 3, point: [4, 0], rate: .02 },
        { ability: 'Artisanship', level: 3, point: [0, 0], rate: .2 },
    ];
    const switching = estimateJobSwitching(opportunities, workers);
    assert.ok(Math.abs(switching[0] - .02) < 1e-9);
    assert.deepEqual(switching.slice(1), [0, 0]);
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

test('a local workplace uses a copy but its idle time fits other deliveries', () => {
    const crew = [{ count: 2, abilities: { Hauling: 3 } }];
    const result = allocateHauling(crew, [.3], .6, 1, [1]);
    assert.deepEqual(result.assignments, [[0,.6]]);
    assert.equal(result.unassigned,0);
    const full = allocateHauling(crew, [.3], 1, 1, [1]);
    assert.ok(full.unassigned > .29);
});

test('a full resident cannot also deliver; missing layouts do not make hauling free', () => {
    const allocation = allocateHauling([{count:1,abilities:{Hauling:3,Leisure:3}}], [1], .1, 1);
    assert.ok(allocation.unassigned > .09);
    const work = haulingWorkload({pieces:[],storages:[]}, [
        {facility:'Well',item_name:'water',status:'producing',facility_count:1,cycle_time:10},
    ], haulingWorkSeconds(40));
    assert.equal(work.busy, 1);
});

test('a large harvest takes multiple trips according to the actual couriers carrying level', () => {
    const work = haulingWorkload({storages:[{x:-1,y:-1,w:2,h:2}],pieces:[{members:[
        {x:7,y:-1,w:2,h:2,weight:180,facility:'Farmland',crop:'large',stockLimit:35},
    ]}]}, [{facility:'Farmland',item_name:'large',status:'producing',facility_count:1,cycle_time:40}], 0,
    [{name:'large',yieldAmount:200}]);
    assert.equal(work.seconds['Farmland|large|1'],16);
    assert.equal(work.seconds['Farmland|large|2'],12);
    assert.equal(work.seconds['Farmland|large|3'],8);
    assert.ok(allocateHauling([{count:1,abilities:{Hauling:1}}], [.7], work, 1).unassigned > 0);
    const stronger = allocateHauling([{count:1,abilities:{Hauling:3}}], [0], work, 1);
    assert.deepEqual(stronger.assignments,[[0,.2]]);
    assert.equal(stronger.unassigned,0);
});

test('a building accumulates several batches before sending a delivery, including the route bound', () => {
    const recipes = [{ name: 'wheat', yieldAmount: 5, facility_level: 1 }];
    const facilities = { Farmland: [{ level: 6, count: 1 }] };
    const crop = { x: 7, y: -1, w: 2, h: 2, weight: 60, facility: 'Farmland', crop: 'wheat' };
    assignFacilityStock([crop], facilities, new Map(recipes.map(recipe => [recipe.name, recipe])));
    assert.equal(crop.stockLimit, 30);
    assert.equal(bufferedBatches(recipes[0], crop.stockLimit), 3);
    const steps = [{ facility:'Farmland',item_name:'wheat',status:'producing',facility_count:1,cycle_time:60 }];
    const measured = haulingWorkload({ storages: [{ x:-1,y:-1,w:2,h:2 }], pieces: [{ members: [crop] }] }, steps, 0, recipes);
    const bounded = haulingWorkload({ storages: [], pieces: [] }, steps, haulingWorkSeconds(16), recipes, facilities);
    assert.equal(measured.seconds['Farmland|wheat'], 4 / 3);
    assert.equal(bounded.seconds['Farmland|wheat'], measured.seconds['Farmland|wheat']);
    assert.equal(haulingBatchTrips({ yieldAmount: 4, byproductAmount: 2 }, 3, 18), 1 / 2);
});

test('a 40% pickup includes the last harvest and Hauling 4 can carry 105 mixed items', () => {
    const maple = { name: 'quick_maple_syrup', yieldAmount: 30, byproductAmount: 75 };
    assert.equal(haulingBatchTrips(maple, 3, 28, 'Woodland'), 2);
    assert.equal(haulingBatchTrips(maple, 4, 28, 'Woodland'), 1);
    assert.equal(bufferedBatches({ yieldAmount: 8 }, 35, 'Farmland'), 2);
    assert.equal(bufferedBatches({ name: 'quick_aromathyst', yieldAmount: 12 }, 240, 'Dewy House'), 8);
});

test('prefer a more versatile courier at the same rate and keep a faster specialist', () => {
    const crew = [{ count: 1, abilities: { Hauling: 4 } }, { count: 1, abilities: { Hauling: 4, Water: 3 } }];
    const work = { jobs: [{ rate: .5, seconds: { 1: 2, 2: 2, 3: 2, 4: 1 } }] };
    assert.deepEqual(allocateHauling(crew, [0, 0], work, 1).assignments, [[1, .5]]);
    crew[1].abilities.Hauling = 3;
    assert.deepEqual(allocateHauling(crew, [0, 0], work, 1).assignments, [[0, .5]]);
});

test('a powered building keeps the stock limit of its exact tier', () => {
    const standard = { weight: 1, facility: 'Well', crop: 'water' };
    const powered = { ...standard, electric_level: 4 };
    assignFacilityStock([standard, powered], { Well: [{ level: 4, count: 1 }, { level: 1, count: 1 }] }, new Map());
    assert.equal(standard.stockLimit, 300);
    assert.equal(powered.stockLimit, 340);
});

test('delivery and walking use base speed without allowances or a duplicated return leg', async () => {
    const { workerTravelSeconds } = await import('../web/worker-travel.js');
    assert.equal(workerTravelSeconds(8), 2);
    assert.equal(haulingTravelSeconds(8, true), 2);
    assert.equal(haulingWorkSeconds(8, true), 2);
    const layout = {storages:[{x:-1,y:-1,w:2,h:2}],pieces:[{members:[
        {x:7,y:-1,w:2,h:2,weight:60,facility:'Well',crop:'water'},
    ]}]};
    const work = haulingWorkload(layout, [
        {facility:'Well',item_name:'water',status:'producing',facility_count:1,cycle_time:60},
    ], 0, [], null, true);
    assert.equal(work.seconds['Well|water'], 4);
    assert.equal(work.busy, 4 / 60);
});
