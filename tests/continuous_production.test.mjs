import test from 'node:test';
import assert from 'node:assert/strict';
import {continuousProduction} from '../web/continuous-production.js';
const plan = names => ({success:true,coin_items:names.map(item_name=>({item_name,status:'producing'}))});
test('newly selected recipes are constrained before accepting a plan',async()=>{
    const seen=[];
    const result=await continuousProduction({always_running:true},async input=>{
        seen.push(input.always_running_recipes);
        return plan(seen.length===1?['porcelain','water']:['jello','water']);
    });
    assert.deepEqual(seen,[[],['porcelain','water'],['porcelain','water','jello']]);
    assert.equal(result.continuous_production_checked,true);
});
test('unstable selection falls back to all constraints, never a partial plan',async()=>{
    let calls=0,last;
    const result=await continuousProduction({always_running:true},async input=>{last=input;return plan([`recipe${calls++}`]);});
    assert.equal(calls,9);assert.equal(last.always_running_recipes,undefined);
    assert.equal(result.continuous_production_checked,true);
});

test('a failed constrained solve cannot fall back to the optimistic previous result',async()=>{
    let calls=0;
    const result=await continuousProduction({always_running:true},async()=>++calls===1?plan(['water']):{success:false,error:'infeasible'});
    assert.equal(result.success,false);
    assert.equal(result.continuous_production_checked,undefined);
});

test('a summary without active recipes cannot certify a constrained plan',async()=>{
    await assert.rejects(continuousProduction({always_running:true},async()=>({success:true})),/Missing active recipes/);
});
