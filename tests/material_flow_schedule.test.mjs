import test from 'node:test';
import assert from 'node:assert/strict';
import {materialFlowSchedule} from '../web/material-flow-schedule.js';
import {validateRecipeSchedule} from '../web/recipe-schedule.js';

const recipes=['rough_lumber','standard_planks','laminated_beams','densified_timber_component'];
function setup() {
    const jobs=recipes.map((recipe,i)=>({id:recipe,recipe,facility:'Woodworking Bench',seconds:1,
        batches:120/2**i,inputs:{[i?recipes[i-1]:'wood_block']:2},outputs:{[recipe]:1},workers:{crew:1}}));
    return {alwaysRunning:true,approximate:true,daySeconds:100,maxBuildings:1,maxSwitches:1,jobs,
        buildings:recipes.map((_,i)=>({id:String(i),facility:'Woodworking Bench',recipes})),
        workerCapacity:{crew:4},backgroundOutputs:{wood_block:2.5}};
}
test('a renewable chain runs whenever supplied and switches one bench after twenty seconds',()=>{
    const input=setup(), schedule=materialFlowSchedule(input);
    assert.ok(schedule);
    const result=validateRecipeSchedule(input,schedule);
    assert.deepEqual(result.errors,[]);
    assert.equal(result.switchedBuildings.length,1);
    assert.equal(result.switches.length,1);
    assert.ok(Math.abs(result.switches[0]-20)<1e-7);
    assert.ok(schedule.initialStock.wood_block>0);
    // Adding an available buffer takes away the explanation for a slow consumer.
    const changed=structuredClone(schedule);
    changed.initialStock.rough_lumber=(changed.initialStock.rough_lumber||0)+10;
    assert.ok(!validateRecipeSchedule(input,changed).valid);
    assert.ok(!validateRecipeSchedule({...input,workerCapacity:{crew:1}},schedule).valid);
    assert.ok(!validateRecipeSchedule({...input,maxSwitches:0},schedule).valid);
    assert.ok(!validateRecipeSchedule({...input,approximate:false},schedule).valid);
});
test('a competing consumer, an unsupported chain or insufficient daily supply keeps the generic search',()=>{
    const input=setup();
    assert.equal(materialFlowSchedule({...input,backgroundInputs:{rough_lumber:.1}}),null);
    assert.equal(materialFlowSchedule({...input,backgroundOutputs:{wood_block:2}}),null);
    assert.equal(materialFlowSchedule({...input,jobs:input.jobs.slice(1)}),null);
    assert.equal(materialFlowSchedule({...input,maxBuildings:0}),null);
});
test('two chains with different raw workloads use two common switch times',()=>{
    const input=setup(),kiln='Chimney Kiln';
    const ores=['coarse_sifted_ore','sintered_ore_brick','refined_ore','microcrystalline_ore_plate'];
    const oreJobs=input.jobs.map((j,i)=>({...j,facility:kiln,id:ores[i],recipe:ores[i],batches:140/2**i,
        inputs:{[i?ores[i-1]:'mineral_sand']:2},outputs:{[ores[i]]:1},workers:{fire:1}}));
    const both={...input,maxBuildings:2,maxSwitches:2,jobs:[...input.jobs,...oreJobs],
        buildings:[...input.buildings,...input.buildings.map(b=>({...b,facility:kiln,id:'ore'+b.id,recipes:ores}))],
        workerCapacity:{crew:4,fire:4},backgroundOutputs:{...input.backgroundOutputs,mineral_sand:3}};
    const schedule=materialFlowSchedule(both);
    const check=validateRecipeSchedule(both,schedule);
    assert.deepEqual(check.errors,[]);
    assert.deepEqual(check.switches,[20,40]);
    assert.equal(check.switchedBuildings.length,2);
    assert.equal(materialFlowSchedule({...both,maxSwitches:1}),null);
    const wrongBatches={...both,jobs:both.jobs.map(j=>j.id===ores[3]?{...j,batches:j.batches+1}:j)};
    assert.ok(validateRecipeSchedule(wrongBatches,schedule).errors.some(e=>e.includes('Wrong daily batches')));
});
test('material search accepts the first independently verified roster schedule',async()=>{
    const {searchRecipeSwitches}=await import('../web/recipe-switch-search.js');
    const sample=setup(),facility='Woodworking Bench',day=86400;
    const sources=sample.jobs.map(j=>({id:j.id,item:j.recipe,facility,facility_level:1,crew:0,cycle:j.seconds,
        rate:j.batches/sample.daySeconds,turns:true,inputs:Object.entries(j.inputs),outputs:Object.entries(j.outputs)}));
    const sourcesAndWood=[...sources,{id:'tree',item:'tree',facility:'Woodland',cycle:1,rate:1,turns:false,
        inputs:[],outputs:[['wood_block',2.5]]}];
    const input={priorities:['level_up'],always_running:true,facilities:{[facility]:[{count:4,level:1}]},
        roster:{members:[{count:4}]},recipe_switching:{max_buildings:1,max_switches:1}};
    const baseline={success:true,priorities:[{target:'level_up',per_second:0}],level_up_preview:{seconds:3*day},
        coin_items:[],rate_per_second:10};
    const proposed={...baseline,rate_per_second:9,level_up_preview:{seconds:2*day},schedule_sources:sourcesAndWood,
        coin_items:[{facility:'Woodland',status:'producing',item_name:'tree',facility_count:1}],
        roster_workload:[sources.reduce((sum,s)=>sum+s.rate*s.cycle,0)]};
    let proposals=0,solves=0;
    const result=await searchRecipeSwitches(input,baseline,{candidate:async()=>{proposals++;return proposed;},
        solve:async()=>{solves++;return null;}});
    assert.ok(result.recipe_schedule?.materialFlow);
    assert.equal(proposals,1);
    assert.equal(solves,0);
    assert.equal(result.recipe_schedule.workerProfiles[0].length,result.recipe_schedule.phases.length);
});
