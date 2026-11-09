import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutTravelCost } from '../web/layout.js';
import { alphabetInversions, chainPurposes, productionDistance, productionGraph, productionLinkDistances,
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

test('a linked mill moves closer and after the stove in English building order within the travel budget', () => {
    const layout = { pieces: [mill(), stove()], storages: [{ x: 15, y: 6, w: 2, h: 2 }],
        power: { poles: [], coverage: [{ x: 13, y: 0, w: 6, h: 4, connected: true }] } };
    const groups = [{ bounds: { x: 0, y: 0, w: 25, h: 15 }, reserved: [{ x: 14, y: 5, w: 4, h: 4 }] }];
    const graph = productionGraph(layout.pieces, recipes);
    const limit = layoutTravelCost(layout) * 1.03, maxChain = productionDistance(graph), maxOrder = alphabetInversions(groups, graph);
    assert.equal(maxOrder, 1, 'Carousel Mill comes after Blazing Stove despite the recipes having different names');
    const result = refineProductionPlacement(layout, groups, graph, layoutTravelCost, { limit, maxChain, maxOrder, canPlace: () => true });
    assert.equal(result.order, 0);
    assert.ok(result.chain < maxChain / 2);
    assert.ok(result.route <= limit);
    const powered = layout.pieces[1].members[0];
    assert.ok(powered.x + powered.w >= 13.25 && powered.x <= 18.75);
});

test('a busier consumer cannot pull a shared intermediate far away from its other customer', () => {
    const layout = { pieces: [mill(), piece('Blazing Stove', 'bread', 17, 1, { weight: 100 }),
        piece('Simmering Pot', 'dough', 4, 1)], storages: [{ x: 12, y: 9, w: 2, h: 2 }],
        power: { poles: [], coverage: [] } };
    const groups = [{ bounds: { x: 0, y: 0, w: 25, h: 15 }, reserved: [] }];
    const graph = productionGraph(layout.pieces, recipes), [far, near] = productionLinkDistances(graph);
    const options = { limit: Infinity, maxChain: productionDistance(graph), maxOrder: Infinity,
        canPlace: index => index === 0 };
    const unbounded = structuredClone(layout);
    const unboundedGraph = productionGraph(unbounded.pieces, recipes);
    refineProductionPlacement(unbounded, groups, unboundedGraph, layoutTravelCost, options);
    assert.ok(productionLinkDistances(unboundedGraph)[1] > near + 2);
    const result = refineProductionPlacement(layout, groups, graph, layoutTravelCost, { ...options, maxLinks: [far + 2, near + 2] });
    assert.ok(result.excess < 1e-6);
    assert.ok(productionLinkDistances(graph)[1] <= near + 2);
});
