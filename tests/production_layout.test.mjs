import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutTravelCost } from '../web/layout.js';
import { layoutKeepsIncome } from '../web/group-layout.js';
import { alphabetInversions, alphabetScore, chainPurposes, compareProductionPlacement, productionDistance, productionGraph, productionLinkDistances,
    refineProductionPlacement } from '../web/production-layout.js';

const piece = (facility, crop, x, y, extra = {}) => ({
    members: [{ facility, crop, x, y, w: 2, h: 2, weight: 10, ...extra }],
});
const recipes = [
    { item: 'quick_flour', makes: 'flour', yield: 2, takes: [['wheat', 1]] },
    { item: 'bread', makes: 'bread', yield: 1, takes: [['flour', 1]] },
    { item: 'dough', makes: 'dough', yield: 1, takes: [['flour', 1]] },
];
const mill = () => piece('Carousel Mill', 'quick_flour', 1, 1);
const stove = () => piece('Blazing Stove', 'bread', 15, 1, { electric_level: 1 });

test('an intermediate can join its sales chain, while a shared ingredient stays in support', () => {
    const dedicated = productionGraph([mill(), stove()], recipes);
    assert.deepEqual(chainPurposes(['support', 'sales'], dedicated), ['sales', 'sales']);
    const shared = productionGraph([mill(), stove(), piece('Chimney Kiln', 'dough', 7, 1)], recipes);
    assert.deepEqual(chainPurposes(['support', 'sales', 'rv'], shared), ['support', 'sales', 'rv']);
});

test('a linked mill moves closer and after the stove in English building order while keeping power', () => {
    const layout = { pieces: [mill(), stove()], storages: [{ x: 15, y: 6, w: 2, h: 2 }],
        power: { poles: [], coverage: [{ x: 13, y: 0, w: 6, h: 4, connected: true }] } };
    const groups = [{ bounds: { x: 0, y: 0, w: 25, h: 15 }, reserved: [{ x: 14, y: 5, w: 4, h: 4 }] }];
    const graph = productionGraph(layout.pieces, recipes);
    const maxChain = productionDistance(graph), maxOrder = alphabetInversions(groups, graph);
    assert.equal(maxOrder, 1, 'Carousel Mill comes after Blazing Stove despite the recipes having different names');
    const result = refineProductionPlacement(layout, groups, graph, layoutTravelCost, { maxChain, canPlace: () => true, keepsIncome: () => true });
    assert.equal(result.order.count, 0);
    assert.ok(result.chain < maxChain / 2);
    const powered = layout.pieces[1].members[0];
    assert.ok(powered.x + powered.w >= 13.25 && powered.x <= 18.75);
});

test('a busier consumer cannot pull a shared intermediate far away from its other customer', () => {
    const layout = { pieces: [mill(), piece('Carousel Mill', 'bread', 17, 1, { weight: 100 }),
        piece('Carousel Mill', 'dough', 4, 1)], storages: [{ x: 12, y: 9, w: 2, h: 2 }],
        power: { poles: [], coverage: [] } };
    const groups = [{ bounds: { x: 0, y: 0, w: 25, h: 15 }, reserved: [] }];
    const graph = productionGraph(layout.pieces, recipes), [far, near] = productionLinkDistances(graph);
    const options = { maxChain: productionDistance(graph), canPlace: index => index === 0, keepsIncome: () => true };
    const unbounded = structuredClone(layout);
    const unboundedGraph = productionGraph(unbounded.pieces, recipes);
    refineProductionPlacement(unbounded, groups, unboundedGraph, layoutTravelCost, options);
    assert.ok(productionLinkDistances(unboundedGraph)[1] > near + 2);
    const result = refineProductionPlacement(layout, groups, graph, layoutTravelCost, { ...options, maxLinks: [far + 2, near + 2] });
    assert.ok(result.excess < 1e-6);
    assert.ok(productionLinkDistances(graph)[1] <= near + 2);
});

test('with equally many alphabet reversals the nearer pair wins', () => {
    const groups = [{ bounds: { x: 0, y: 0, w: 25, h: 15 } }];
    const make = x => ({ order: alphabetScore(groups, productionGraph([mill(), piece('Blazing Stove', 'bread', x, 1)], recipes)),
        excess: 0, chain: 0, route: 0 });
    assert.equal(make(5).order.count, make(12).order.count);
    assert.ok(compareProductionPlacement(make(5), make(12)) < 0);
});

test('alphabetical order starts again at the next storage block', () => {
    const groups = [{ bounds: { x: 0, y: 0, w: 10, h: 15 } }, { bounds: { x: 12, y: 0, w: 10, h: 15 } }];
    const graph = productionGraph([piece('Simmering Pot', 'dough', 1, 1), stove()], recipes);
    assert.equal(alphabetScore(groups, graph).count, 0);
});

test('distance can increase when the same production and income still fit the team', () => {
    const stores = [{ x: 0, y: 0, w: 2, h: 2 }];
    const map = x => ({ storages: stores, pieces: [piece('Blazing Stove', 'bread', x, 0, { batchWeight: 3.6 })] });
    const staffing = { limit: 1, members: [{ count: 1, abilities: { Hauling: 1 } }], busy: [.998],
        steps: [{ facility: 'Blazing Stove', item_name: 'bread', status: 'producing', cycle_time: 1000, facility_count: 1 }] };
    assert.ok(layoutTravelCost(map(3)) > layoutTravelCost(map(2)) * 1.01);
    assert.equal(layoutKeepsIncome(map(2), staffing, recipes), true);
    assert.equal(layoutKeepsIncome(map(3), staffing, recipes), true);
    assert.equal(layoutKeepsIncome(map(10), staffing, recipes), false);
});

test('extra walking can use spare working time without lowering production', () => {
    const map = x => ({ storages: [{ x: 10, y: 7, w: 2, h: 2 }],
        pieces: [piece('Carousel Mill', 'quick_flour', 0, 0, { workers: [[0, 36]] }),
            piece('Blazing Stove', 'bread', x, 0, { workers: [[0, 36]] })] });
    const staffing = { limit: 1, members: [{ count: 1, abilities: {} }], busy: [.98], steps: [],
        movement: { defaultDistance: 4, byMember: {}, visits: { 0: 72 } } };
    assert.equal(layoutKeepsIncome(map(6), staffing, recipes), true);
    assert.equal(layoutKeepsIncome(map(20), staffing, recipes), false);
});
