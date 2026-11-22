import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleInputForPlan, attachRecipeSchedule, scheduleProfiles} from '../web/recipe-schedule-plan.js';
const source=(item,extra={})=>({id:item,item,facility:'Chimney Kiln',facility_level:1,cycle:10,rate:.02,crew:0,electric_level:null,turns:true,inputs:[],outputs:[[item,1]],...extra});
const input={facilities:{'Chimney Kiln':[{count:1,level:1}]},recipe_switching:{max_buildings:1,max_switches:1},roster:{members:[{count:1}]}};
const plan={recipe_switching_candidate:true,schedule_sources:[source('ore'),source('brick')],roster_workload:[.4],coin_items:[]};
test('adapter uses actual physical tiers, worker identity and daily rates',()=>{
    const p=scheduleInputForPlan(input,plan);
    assert.equal(p.buildings.length,1);assert.equal(p.jobs.length,2);
    assert.equal(p.jobs[0].batches,1728);assert.equal(p.jobs[0].workers['0'],10);
    assert.equal(p.workerCapacity['0'],1);assert.equal(p.backgroundWorkers['0'],0);
});
test('electric and normal recipes never share a physical site',()=>{
    const p=scheduleInputForPlan({...input,facilities:{'Chimney Kiln':[{count:2,level:1}]}},
        {...plan,schedule_sources:[source('ore',{electric_level:1,crew:null}),source('brick')]});
    assert.equal(p.buildings.length,2);
    assert.ok(p.buildings.every(b=>b.jobs.length===1));
});
test('background production and sales enter the renewable inventory balance',()=>{
    const p=scheduleInputForPlan(input,{...plan,schedule_sources:[...plan.schedule_sources,
        source('raw',{turns:false,facility:'Mine',outputs:[['sand',4]],inputs:[]})],income_streams:[{item_name:'ore',units_per_second:.01}]});
    assert.equal(p.backgroundOutputs.sand,.08);assert.equal(p.backgroundInputs.ore,.01);
});

test('always-running switching cannot freeze a competing background recipe at its average rate',()=>{
    const wet=source('wet',{inputs:[['water',1]],crew:null,electric_level:1,cycle:1,rate:.5});
    const dry=source('dry',{crew:null,electric_level:1,cycle:1,rate:.5});
    const background=source('consumer',{turns:false,facility:'Other',crew:null,cycle:1,rate:.5,inputs:[['water',1]]});
    const setup={...input,always_running:true};
    const candidate={...plan,schedule_sources:[wet,dry,background],coin_items:[{facility:'Other',item_name:'consumer',status:'producing',facility_count:1}]};
    assert.throws(()=>scheduleInputForPlan(setup,candidate),/phase production is not verified/);
    assert.doesNotThrow(()=>scheduleInputForPlan({...setup,always_running:false},candidate));
});
test('switching Wood Blocks does not change the other output of a fully busy Woodland',()=>{
    const setup={...input,always_running:true,facilities:{'Woodworking Bench':[{count:1,level:1}]}};
    const processor=source('rough_lumber',{facility:'Woodworking Bench',inputs:[['wood_block',8]]});
    const woodland=source('orange_flower',{turns:false,crew:null,facility:'Woodland',cycle:10,rate:.1,
        outputs:[['wood_block',8],['orange_flower',8]]});
    const incense=source('orange_flower_incense',{turns:false,crew:null,facility:'Phonolfactory Table',
        inputs:[['orange_flower',8]]});
    const candidate={...plan,schedule_sources:[processor,woodland,incense],
        coin_items:[woodland,incense].map(({facility,item})=>({facility,item_name:item,status:'producing',facility_count:1}))};
    const adapted=scheduleInputForPlan(setup,candidate);
    assert.equal(adapted.backgroundOutputs.orange_flower,.8);
    assert.equal(adapted.backgroundInputs.orange_flower,.16);
    assert.throws(()=>scheduleInputForPlan(setup,{...candidate,schedule_sources:[processor,{...woodland,crew:0},incense]}),
        /phase production is not verified/);
});
test('validated schedule produces map jobs and time profiles without changing production',()=>{
    const p=scheduleInputForPlan(input,plan);
    const schedule={phases:[{duration:43200,assignments:[{building:p.buildings[0].id,job:'ore',batches:1728}]},
        {duration:43200,assignments:[{building:p.buildings[0].id,job:'brick',batches:1728}]}],initialStock:{},switchedBuildings:[p.buildings[0].id],switches:[43200]};
    const result=attachRecipeSchedule(plan,p,schedule);
    assert.deepEqual(scheduleProfiles(result).get('Chimney Kiln|ore'),[2,0]);
    assert.equal(result.recipe_schedule.sites[0].jobs.length,2);
    assert.equal(result.recipe_switching_candidate,undefined);
    assert.deepEqual(result.coin_items,plan.coin_items);
});
import {materialChainSchedule} from '../web/recipe-schedule-plan.js';
test('material template implements two raw buildings then moves one to tier 3',()=>{
 const p=materialChainSchedule({maxSwitches:2,jobs:['rough_lumber','standard_planks','laminated_beams','densified_timber_component'].map(recipe=>({facility:'Woodworking Bench',recipe})),buildings:Array.from({length:4},(_,i)=>({id:String(i),facility:'Woodworking Bench'}))});
 assert.equal(p.maxSwitches,1);
 assert.deepEqual(p.buildings.map(b=>b.phaseRecipes),[[['rough_lumber'],['rough_lumber']],[['rough_lumber'],['laminated_beams']],[['standard_planks'],['standard_planks']],[['densified_timber_component'],['densified_timber_component']]]);
});
test('unchanged steady production does not reserve a full phase of its inputs',async()=>{
 const module=await import('../web/recipe-schedule.js');
 const p={daySeconds:100,approximate:true,maxBuildings:0,maxSwitches:0,jobs:[],buildings:[],workerCapacity:{},backgroundInputs:{water:2},backgroundOutputs:{water:2}};
 assert.equal(module.validateRecipeSchedule(p,{phases:[{duration:100,assignments:[]}],initialStock:{}}).valid,true);
});

test('attached power includes dedicated background sites and counts a shared upgraded site once',()=>{
    const facility='Chimney Kiln', tier=4;
    const sources=['brick','ore'].map(item=>source(item,{electric_level:tier,crew:null}));
    const rows=sources.map(s=>({facility,item_name:s.item,status:'producing',electric_level:tier,facility_count:1}));
    rows.push({facility:'Mine',item_name:'sand',status:'producing',electric_level:3,facility_count:2});
    const proposed={...plan,schedule_sources:sources,coin_items:rows,power_used:72,power_generated:288};
    const p=scheduleInputForPlan({...input,facilities:{[facility]:[{count:2,level:tier}]}},proposed);
    const site=p.buildings[0].id;
    const schedule={phases:sources.map(j=>({duration:43200,assignments:[{building:site,job:j.id,batches:1728}]})),initialStock:{}};
    assert.equal(attachRecipeSchedule(proposed,p,schedule).power_used,288);
    assert.throws(()=>attachRecipeSchedule({...proposed,power_generated:287},p,schedule),/generation/i);
});

test('a manual raw processor stays fully staffed when its powered neighbour switches recipes',()=>{
    const item={facility:'Woodworking Bench',item:'rough_lumber',batches:86400};
    const jobs=[{...item,id:'manual'}, {...item,id:'powered',electric_level:4,batches:43200}];
    const manual={job:'manual',batches:43200}, powered={job:'powered',batches:43200};
    const phases=[[manual,powered],[manual]].map(assignments=>({duration:43200,assignments}));
    const plan={recipe_schedule:{jobs,phases}};
    assert.deepEqual(scheduleProfiles(plan,true).get('Woodworking Bench|rough_lumber'),[1,1]);
    assert.deepEqual(scheduleProfiles(plan).get('Woodworking Bench|rough_lumber'),[4/3,2/3]);
});
