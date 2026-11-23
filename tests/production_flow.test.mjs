import assert from 'node:assert/strict';
import test from 'node:test';
import { allOutputSold, productionFlow, upgradeHorizon, flowSections, flowBuildings, routeFlowEdges } from '../web/production-flow.js';

test('combines quick and normal output, retains real sales and routes byproducts to their consumers', () => {
    const row = (item_name, busy_units) => ({ item_name, busy_units, facility_count: 2, cycle_time: 10, status: 'producing' });
    const plan = {
        coin_items: [row('quick_bamboo', .5), row('bamboo', null), row('rough_lumber', 1), row('rough_lumber', 0),
            { ...row('rough_lumber', 1), status: 'idle' }],
        income_streams: [{ item_name: 'bamboo', units_per_second: .75, sell_value: 13 }],
    };
    const terms = {
        quick_bamboo: { makes: 'bamboo', yield: 20, byproduct: ['wood_block', 8], takes: [] },
        bamboo: { makes: 'bamboo', yield: 10, byproduct: ['wood_block', 7], takes: [] },
        rough_lumber: { makes: 'rough_lumber', yield: 1, takes: [['wood_block', 8]] },
    };
    const { nodes, grossSales } = productionFlow(plan, name => terms[name]);
    assert.equal(nodes.get('bamboo').made, 3);
    assert.equal(nodes.get('bamboo').sold, .75);
    assert.equal(grossSales, 9.75);
    assert.ok(Math.abs(nodes.get('wood_block').made - 1.8) < 1e-8);
    assert.deepEqual([...nodes.get('rough_lumber').inputs], [['wood_block', .8]]);
    assert.equal(nodes.get('rough_lumber').depth, 1);
});

test('only marks products whose entire output goes to sales', () => {
    const product = { made: .1 + .2, sold: .3, consumers: new Set() };
    assert.ok(allOutputSold(product));
    assert.ok(allOutputSold(product, { need: 1, have: 1, per_second: 1 }));
    assert.equal(allOutputSold(product, { need: 1, have: 0, per_second: 1 }), false);
    assert.equal(allOutputSold({ ...product, sold: .29 }), false);
    assert.equal(allOutputSold({ ...product, consumers: new Set(['lotion']) }), false);
    assert.equal(allOutputSold({ ...product, made: 0 }), false);
});

test('RV horizon follows the displayed plan, including ready and unreachable upgrades', () => {
    assert.equal(upgradeHorizon({ level_up_preview: { seconds: 9421 } }, {}), 9421);
    assert.equal(upgradeHorizon({}, { ready: true }), 0);
    assert.equal(upgradeHorizon({level_up_preview:{seconds:null}}, {}), null);
    assert.equal(upgradeHorizon({level_up_preview:{seconds:50}}, {unavailable:true}), null);
});

test('uses the solver’s effective recipe rates when a scheduled plan supplies them', () => {
    const { nodes } = productionFlow({
        schedule_sources: [{ rate: .25, outputs: [['bamboo', 4], ['wood_block', 2]], inputs: [] },
            { rate: .05, outputs: [['rough_lumber', 1]], inputs: [['wood_block', 8]] }],
    });
    assert.equal(nodes.get('wood_block').made, .5);
    assert.equal(nodes.get('rough_lumber').inputs.get('wood_block'), .4);
});

test('gross sales use each stream’s own price and only units actually sold', () => {
    const plan = { income_streams: [
        { item_name: 'orange_blossom', units_per_second: 2, sell_value: 5 },
        { item_name: 'quick_orange_blossom', units_per_second: 1, sell_value: 6 },
        { item_name: 'syrup', units_per_second: .5, sell_value: 20 },
    ] };
    const { nodes, grossSales } = productionFlow(plan);
    assert.equal(nodes.get('orange_blossom').sold, 3);
    assert.equal(nodes.get('orange_blossom').grossSales, 16);
    assert.equal(nodes.get('syrup').grossSales, 10);
    assert.equal(grossSales, 26);
});

test('upgrade chains and stand-alone upgrade items precede sales at every period', () => {
    const {nodes} = productionFlow({ schedule_sources: [
        {rate:1, outputs:[['berry',2]], inputs:[]},
        {rate:1, outputs:[['juice',1]], inputs:[['berry',2]]},
        {rate:1, outputs:[['sand',8]], inputs:[]},
        {rate:1, outputs:[['brick',1]], inputs:[['sand',8]]},
        {rate:1, outputs:[['wood',3]], inputs:[]},
    ]});
    const sections = flowSections(nodes, [
        {name:'brick', need:10, have:0, per_second:1},
        {name:'wood', need:3, have:0, per_second:3},
        {name:'juice', need:2, have:2, per_second:1},
    ]);
    assert.deepEqual(sections.map(s => [s.upgrade, s.nodes.map(n => n.item)]),
        [[true,['sand','brick']], [true,['wood']], [false,['berry','juice']]]);
});

test('building load is busy time per assigned building, including shared sites and byproducts', () => {
    const mk = (item_name, facility, busy_units, facility_count) =>
        ({item_name,facility,busy_units,facility_count,status:'producing',cycle_time:10});
    const plan={coin_items:[mk('tree','Woodland',1,4),mk('planks','Bench',.5,1),mk('timber','Bench',.25,1)],
        recipe_schedule:{sites:[{id:'bench1',facility:'Bench',jobs:[
            {item:'planks',rate:.05,cycle:10},{item:'timber',rate:.025,cycle:10}]}]}};
    const buildings=flowBuildings(plan, name=>({makes:name,byproduct:name==='tree'?['wood',1]:null}),
        step=>[{name:step.item_name+' worker', form:'test-form', ability:'Woodwork'}]);
    const get=id=>[...buildings.get(id).values()][0];
    for (const [id,load,count] of [['tree',.25,4],['wood',.25,4],['planks',.5,1],['timber',.25,1]]) {
        assert.equal(get(id).busy/get(id).count,load);
        assert.equal(get(id).count,count);
    }
    assert.equal(get('planks').buildingBusy, .75);
    assert.equal(get('timber').buildingBusy, .75);
    assert.deepEqual([...get('wood').workers.values()], [{name:'tree worker', form:'test-form', ability:'Woodwork'}]);
});

test('keeps a custom name with its portrait and deduplicates repeated assignments of the same form', () => {
    const job={status:'producing', item_name:'bread', facility:'Kiln', busy_units:.5, facility_count:1};
    const buildings=flowBuildings({coin_items:[job,job]}, () => ({makes:'bread'}),
        () => [{name:'My baker',form:'blazen',ability:'Fire'}]);
    assert.deepEqual([...buildings.get('bread').values()][0].workers.size, 1);
});

test('a long edge passes below the skipped card when the nearer upper gap would cross its connections', () => {
    const tracks = [
        {left: 0, right: 90, occupied: []},
        {left: 110, right: 200, occupied: [{top: 50, bottom: 100}]},
        {left: 220, right: 310, occupied: []},
    ];
    const bypass = {start: 0, end: 2, y: 120, ty: 15};
    const enter = {start: 0, end: 1, y: 95, ty: 75};
    const leave = {start: 1, end: 2, y: 75, ty: 9};
    const routes = routeFlowEdges([bypass, enter, leave], tracks, 160);
    assert.ok(routes.get(bypass)[1] > 100);
    assert.deepEqual(routes.get(enter), [95, 75]);
});
