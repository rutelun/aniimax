import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunityEffect,prepareOpportunities,startedProcessing,increasedProcessing} from '../web/opportunity-effects.js';

const recipes=[
    {name:'grain',facility:'Farm',facility_level:1},
    {name:'meal',facility:'Mill',facility_level:1,raw_materials:['grain'],workload:10,aniimo:['Artisanship',1]},
    {name:'flour',facility:'Mill',facility_level:3,raw_materials:['grain'],workload:10,aniimo:['Artisanship',2]},
    {name:'bread',facility:'Oven',facility_level:1,raw_materials:['flour'],workload:10,aniimo:['Fire',1],module_requirement:['kitchen_module',2]},
];
const base={facilities:{Farm:[{count:1,level:1}],Mill:[{count:1,level:1}],Oven:[{count:1,level:1}]},modules:{kitchen_module:1}};

test('an upgrade explains downstream chains, not only the recipe at the upgraded building',()=>{
    const before={...base,modules:{kitchen_module:2}};
    const input={...before,facilities:{...before.facilities,Mill:[{count:1,level:3}]}};
    const effect=opportunityEffect(before,{input},recipes);
    assert.equal(effect.skip,null);
    assert.deepEqual(effect.lines[0],{kind:'unlocks',recipes:['flour','bread']});
});

test('only module levels with an unchanged reachable recipe set are omitted',()=>{
    const input={...base,modules:{kitchen_module:2}};
    assert.equal(opportunityEffect(base,{input},recipes).skip,null,'new structural recipes stay eligible even when an ingredient is blocked');
    assert.equal(opportunityEffect(input,{input:{...input,modules:{kitchen_module:3}}},recipes).skip,'No additional usable recipes at this module level.');
    const ready={...base,facilities:{...base.facilities,Mill:[{count:1,level:3}]}};
    assert.equal(opportunityEffect(ready,{input:{...ready,modules:{kitchen_module:2}}},recipes).skip,null);
    // Do not prune a combined change just because its module alone changes no recipes.
    assert.equal(opportunityEffect(base,{input:{...input,roster:{members:[]}}},recipes).skip,null);
});

test('higher-level capacity is retained even if another unit already unlocked the recipe',()=>{
    const before={...base,facilities:{...base.facilities,Mill:[{count:1,level:1},{count:1,level:3}]}};
    const input={...before,facilities:{...before.facilities,Mill:[{count:2,level:3}]}};
    assert.equal(opportunityEffect(before,{input},recipes).skip,null);
    const unchanged={...base,facilities:{...base.facilities,Mill:[{count:1,level:2}]}};
    assert.equal(opportunityEffect(base,{input:unchanged},recipes).skip,'Usable recipe capacity is unchanged at this level.');
    const powered={...base,electricity:{watts:600,percent:120}};
    assert.equal(opportunityEffect(powered,{input:{...unchanged,electricity:powered.electricity}},recipes).skip,null);
});

test('candidate preparation preserves input and reports exact omission reasons',()=>{
    const before={...base,modules:{kitchen_module:2}};
    const input={...base,modules:{kitchen_module:3}};
    const snapshot=structuredClone(input);
    const result=prepareOpportunities(before,[{label:'Module 3',input}],recipes,{});
    assert.equal(result.candidates.length,0);
    assert.equal(result.omitted.length,1);
    assert.equal(result.omitted[0].effect.skip,'No additional usable recipes at this module level.');
    assert.deepEqual(input,snapshot);
});

test('grower levels remain eligible because planting variety depends on owned levels',()=>{
    const input={...base,crop_variety:true};
    const candidate={input:{...input,facilities:{...input.facilities,Farm:[{count:1,level:2}]}}};
    assert.equal(opportunityEffect(input,candidate,recipes.map(r=>({...r,ingredients:r.raw_materials||[]}))).skip,null);
});

test('comparison explanations report newly started processing, without double-counting workers or idle units',()=>{
    const step=(name,extra={})=>({status:'producing',item_name:name,facility_count:1,busy_units:.1,cycle_time:10,...extra});
    assert.deepEqual(startedProcessing({coin_items:[step('meal')]},{coin_items:[step('meal'),step('bread'),step('bread'),
        step('quick_wheat',{is_grower:true}),step('flour',{busy_units:0})]}),['bread']);
});

test('an exhausted ingredient is explained without excluding the opportunity', () => {
    const input = { ...base, facilities: { ...base.facilities, Mill: [{ count: 2, level: 1 }] } };
    const row = (item_name, facility, busy_units) => ({
        item_name, facility, busy_units, status: 'producing', cycle_time: 10, facility_count: 1,
    });
    const before = { coin_items: [row('grain', 'Farm', .5), row('meal', 'Mill', .5)] };
    const effect = opportunityEffect(base, { input }, recipes, before);
    assert.equal(effect.skip, null);
    assert.deepEqual(effect.lines.at(-1), { kind: 'allocated', facility: 'Mill', ingredients: ['grain'] });
    const after = { coin_items: [row('grain', 'Farm', 1), row('meal', 'Mill', .4), row('meal', 'Mill', .4)] };
    assert.deepEqual(increasedProcessing(before, after, recipes, effect.lines),
        { item: 'meal', facility: 'Mill', before: .05, after: .08 });
    assert.equal(opportunityEffect(base, { input }, recipes, {
        coin_items: [row('grain', 'Farm', .6), row('meal', 'Mill', .5)],
    }).lines.some(line => line.kind === 'allocated'), false);
});
