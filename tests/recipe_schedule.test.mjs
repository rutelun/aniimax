import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {buildRecipeSchedule, readRecipeSchedule, validateRecipeSchedule} from '../web/recipe-schedule.js';

const highs = await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const problem = (extra={}) => ({daySeconds:100,maxBuildings:1,maxSwitches:1,
    buildings:[{id:'kiln',recipes:['ore','brick']}],
    jobs:[{id:'ore',recipe:'ore',batches:4,seconds:10,outputs:{ore:1}},
        {id:'brick',recipe:'brick',batches:4,seconds:15,inputs:{ore:1},outputs:{brick:1}}],...extra});
function solve(input) {
    const model=buildRecipeSchedule(input);
    const result=highs.solve(model.lp,{time_limit:2,mip_rel_gap:0});
    return result.Status==='Optimal' ? readRecipeSchedule(model,result) : null;
}

test('free morning setup gives two phases for one charged change',()=>{
    const input=problem(), schedule=solve(input);
    assert.ok(schedule);
    assert.equal(schedule.switches.length,1);
    assert.equal(schedule.switchedBuildings.length,1);
    assert.ok(validateRecipeSchedule(input,schedule).valid);
    const durations=schedule.phases.map(p=>p.duration).sort((a,b)=>a-b);
    assert.ok(Math.abs(durations[0]-40)<1e-6);
    assert.ok(Math.abs(durations[1]-60)<1e-6);
});

test('zero switches cannot share a physical kiln between two recipes',()=>{
    assert.equal(solve(problem({maxSwitches:0})),null);
    assert.equal(solve(problem({maxBuildings:0})),null);
});

test('global budget counts distinct buildings, not one new building at each event',()=>{
    const input=problem({maxSwitches:2,buildings:[{id:'a',recipes:['ore','brick']},{id:'b',recipes:['water','ice']}],
        jobs:[...problem().jobs,{id:'water',recipe:'water',batches:4,seconds:10,outputs:{water:1}},
            {id:'ice',recipe:'ice',batches:4,seconds:15,inputs:{water:1},outputs:{ice:1}}]});
    assert.equal(solve(input),null);
    assert.ok(solve({...input,maxBuildings:2}));
});

test('repeating inventory cannot hide a daily material deficit',()=>{
    const jobs=[...problem().jobs]; jobs[1]={...jobs[1],inputs:{ore:2}};
    assert.equal(solve(problem({jobs})),null);
});

test('phase workers cannot borrow idle capacity from a different phase',()=>{
    const input=problem({workerCapacity:{fire:1},jobs:problem().jobs.map(j=>({...j,workers:{fire:j.seconds*2}}))});
    assert.equal(solve(input),null);
});

test('certificate checker rejects overload, short cycles and disappearing buffers',()=>{
    const input=problem(), original=solve(input);
    let broken=structuredClone(original); broken.phases[0].duration=1;
    assert.equal(validateRecipeSchedule(input,broken).valid,false);
    broken=structuredClone(original); broken.initialStock={};
    // Deliberately put the consuming phase before its supplier.
    broken.phases.sort((a,b)=>Number(b.assignments.some(x=>x.job==='brick'))-Number(a.assignments.some(x=>x.job==='brick')));
    assert.equal(validateRecipeSchedule(input,broken).valid,false);
});

test('average worker seconds cannot fit three indivisible batches onto two workers',()=>{
    const input={daySeconds:10,maxBuildings:0,maxSwitches:0,workerCapacity:{fire:2},
        buildings:['a','b','c'].map(id=>({id,recipes:[id]})),
        jobs:['a','b','c'].map(id=>({id,recipe:id,batches:1,seconds:6,workers:{fire:6}}))};
    const candidate={initialStock:{},phases:[{duration:10,assignments:input.jobs.map(j=>({building:j.id,job:j.id,batches:1}))}]};
    assert.equal(validateRecipeSchedule(input,candidate).valid,false);
});

test('estimated mode preserves fractional daily rates and replenishes background inputs',()=>{
    const input=problem({approximate:true,backgroundOutputs:{sand:.05},
        jobs:[{id:'ore',recipe:'ore',batches:2.5,seconds:10,inputs:{sand:2},outputs:{ore:1}},
            {id:'brick',recipe:'brick',batches:2.5,seconds:15,inputs:{ore:1},outputs:{brick:1}}]});
    const result=solve(input);
    assert.ok(result?.approximate);
    assert.ok(validateRecipeSchedule(input,result).valid);
});

test('background work consumes capacity in every interval',()=>{
    const input=problem({approximate:true,workerCapacity:{fire:1},backgroundWorkers:{fire:.5},
        jobs:problem().jobs.map(j=>({...j,workers:{fire:j.seconds}}))});
    assert.equal(solve(input),null);
});

test('always-running schedules reject unexplained manual throttling',()=>{
    const input=problem({alwaysRunning:true,maxSwitches:0,buildings:[{id:'kiln',recipes:['ore']}],
        jobs:[{id:'ore',recipe:'ore',batches:2,seconds:10,outputs:{ore:1}}]});
    assert.equal(solve(input),null);
    assert.equal(validateRecipeSchedule(input,{initialStock:{},phases:[{duration:100,assignments:[{building:'kiln',job:'ore',batches:2}]}]}).valid,false);
});
test('always-running schedules allow a full-speed switch and unused buildings',()=>{
    const input=problem({alwaysRunning:true,buildings:[{id:'kiln',recipes:['ore','brick']},{id:'spare',recipes:['ore','brick']}]});
    assert.ok(solve(input));
});

// One worker runs the kiln at dawn. The jar stays configured and catches up
// during the second shift, when its daily supply of fruit is available.
test('a fixed jar sharing the kiln worker can finish its daily batches in the later phase',async()=>{
    const {scheduleInputForPlan,attachRecipeSchedule}=await import('../web/recipe-schedule-plan.js');
    const make=(id,facility,crew,rate,cycle,inputs,turns)=>({id,item:id,facility,facility_level:1,electric_level:null,crew,rate,cycle,inputs,outputs:[[id,1]],turns});
    const sources=[make('ore','Chimney Kiln',0,.05,10,[],true),make('brick','Chimney Kiln',1,.05,10,[['ore',1]],true),
        make('fruit','Farmland',null,.1,10,[],false),make('candied','Pickling Jar',0,.1,2,[['fruit',1]],false)];
    const config={always_running:true,roster:{members:[{count:1},{count:1}]},facilities:{'Chimney Kiln':[{count:1,level:1}],'Pickling Jar':[{count:1,level:1}]}};
    const plan={schedule_sources:sources,roster_workload:[.7,.5],coin_items:[{facility:'Pickling Jar',item_name:'candied',status:'producing',facility_count:1},{facility:'Farmland',item_name:'fruit',status:'producing',facility_count:1}]};
    const input=scheduleInputForPlan(config,plan);
    const schedule=solve(input);assert.ok(schedule);
    const result=attachRecipeSchedule(plan,input,schedule);
    assert.equal(result.recipe_schedule.switchedBuildings.length,1);
    const jar=result.recipe_schedule.phases.map(p=>p.fixedRates.candied*p.duration);
    assert.ok(jar.some(n=>n===0));assert.ok(Math.abs(jar.reduce((a,b)=>a+b)-8640)<1e-6);
    assert.ok(result.recipe_schedule.workerProfiles[0].every(n=>n<=1+1e-8));
    const wrongStock=structuredClone(schedule);
    wrongStock.initialStock.fruit+=10;
    assert.equal(validateRecipeSchedule(input,wrongStock).valid,false);
    const busyBothPhases={...input,jobs:input.jobs.map(j=>({...j,workers:{0:j.seconds}}))};
    assert.throws(()=>solve(busyBothPhases),/cannot sustain its daily batches/);
    assert.equal(validateRecipeSchedule(busyBothPhases,schedule).valid,false);
});
