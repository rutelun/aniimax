import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {searchRecipeSwitches,improvesPlan} from '../web/recipe-switch-search.js';
const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const input={recipe_switching:{max_buildings:1,max_switches:1},facilities:{Kiln:[{count:1,level:1}]},roster:{members:[{count:1}]}};
const baseline={success:true,rate_per_second:1,priorities:[]};
const candidate={...baseline,rate_per_second:2,recipe_switching_candidate:true,roster_workload:[.4],coin_items:[],
    schedule_sources:['a','b'].map(item=>({id:item,item,facility:'Kiln',facility_level:1,cycle:10,rate:.02,crew:0,turns:true,inputs:[],outputs:[[item,1]]}))};
test('complete search returns a validated physical schedule and unchanged candidate rates',async()=>{
    const result=await searchRecipeSwitches(input,baseline,{candidate:async()=>candidate,solve:async m=>highs.solve(m.lp)});
    assert.ok(result.recipe_schedule,result.recipe_switching_detail);
    assert.equal(result.rate_per_second,2);
    assert.equal(result.recipe_schedule.switchedBuildings.length,1);
    assert.equal(result.recipe_switching_candidate,undefined);
});
test('disabled mode does not run an extra solve; failure never replaces a valid baseline',async()=>{
    let calls=0;const deps={candidate:async()=>{calls++;throw Error('timeout');},solve:async()=>null};
    assert.equal(await searchRecipeSwitches({...input,recipe_switching:null},baseline,deps),baseline);
    assert.equal(calls,0);
    const result=await searchRecipeSwitches(input,baseline,deps);
    assert.equal(result.rate_per_second,1);assert.ok(result.recipe_switching_note);assert.equal(result.recipe_schedule,undefined);
});
test('original priority order takes precedence over income',()=>{
    const base={...baseline,priorities:[{target:'level_up',per_second:2}]};
    assert.equal(improvesPlan({...base,rate_per_second:100,priorities:[{target:'level_up',per_second:1}]},base),false);
    assert.equal(improvesPlan({...base,rate_per_second:.1,priorities:[{target:'level_up',per_second:3}]},base),true);
});
test('RV priority compares the actual time report even when its rate field is zero',()=>{
 const base={...baseline,rate_per_second:20,priorities:[{target:'level_up',per_second:0}],level_up_preview:{seconds:400000}};
 assert.equal(improvesPlan({...base,rate_per_second:10,level_up_preview:{seconds:300000}},base),true);
 assert.equal(improvesPlan({...base,rate_per_second:100,level_up_preview:{seconds:500000}},base),false);
});
test('switching can make an otherwise infeasible physical-building setup feasible',async()=>{
 const result=await searchRecipeSwitches(input,{success:false,error:'Insufficient distinct sites'}, {candidate:async()=>candidate,solve:async m=>highs.solve(m.lp)});
 assert.equal(result.success,true);assert.ok(result.recipe_schedule);
});

test('parallel switch search starts alternatives together and accepts the first verified choice in order', async()=>{
    const pending=[],terminated=[];
    const createWorker=()=>{
        const worker={
            postMessage({payload}){
                const facilities=JSON.parse(payload).recipe_switching_facilities;
                pending.push({worker,facilities});
            },
            terminate(){terminated.push(worker);}
        };
        return worker;
    };
    const twoSites={...baseline,coin_items:['Kiln','Mill'].flatMap(facility=>['a','b'].map(item_name=>({status:'producing',facility,item_name})))};
    const found=searchRecipeSwitches({...input,recipe_switching:{max_buildings:2,max_switches:1}},twoSites,{
        createWorker,parallel:3,candidate:()=>assert.fail('unexpected inline retry'),solve:async m=>highs.solve(m.lp),
    });
    assert.deepEqual(pending.map(p=>p.facilities),[['Kiln','Mill'],['Kiln'],['Mill']]);
    pending[1].worker.onmessage({data:{ok:true,result:JSON.stringify({...candidate,rate_per_second:3})}});
    pending[0].worker.onmessage({data:{ok:true,result:JSON.stringify(candidate)}});
    assert.equal((await found).rate_per_second,2);
    assert.equal(new Set(terminated).size,3);
});

test('a failed switch worker retries its choice inline; a single choice stays inline',async()=>{
    let starts=0, retries=0;
    const deps={parallel:2,createWorker(){starts++;throw Error('workers unavailable');},
        candidate:async()=>{retries++;return candidate;},solve:async m=>highs.solve(m.lp)};
    const found=await searchRecipeSwitches(input,baseline,deps);
    assert.equal(found.rate_per_second,2);
    assert.equal(starts,0);
    const facilities=['Kiln','Mill'];
    const base={...baseline,coin_items:facilities.flatMap(facility=>['a','b'].map(item_name=>({status:'producing',facility,item_name})))};
    const retried=await searchRecipeSwitches({...input,recipe_switching:{max_buildings:2,max_switches:1}},base,deps);
    assert.equal(retried.rate_per_second,2);
    assert.equal(starts,2);
    assert.equal(retries,2);
});
