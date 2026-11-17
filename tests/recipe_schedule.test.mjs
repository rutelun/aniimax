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
