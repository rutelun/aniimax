import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {searchRecipeSwitches,improvesPlan} from '../web/recipe-switch-search.js';
const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const input={facilities:{'Woodworking Bench':[{count:1,level:2}]},roster:{members:[{count:1}]}};
const baseline={success:true,rate_per_second:1,priorities:[]};
const candidate={...baseline,rate_per_second:2,recipe_switching_candidate:true,roster_workload:[.4],coin_items:[],
    schedule_sources:['a','b'].map(item=>({id:item,item,facility:'Woodworking Bench',facility_level:1,cycle:10,rate:.02,crew:0,turns:true,inputs:[],outputs:[[item,1]]}))};
const twoWorkshops={...input,facilities:{...input.facilities,'Chimney Kiln':[{count:1,level:2}],
    'Crafting Table':[{count:3,level:1}]}};
test('complete search returns a validated physical schedule and unchanged candidate rates',async()=>{
    const result=await searchRecipeSwitches(input,baseline,{candidate:async()=>candidate,solve:async m=>highs.solve(m.lp)});
    assert.ok(result.recipe_schedule,result.recipe_switching_detail);
    assert.equal(result.rate_per_second,2);
    assert.equal(result.recipe_schedule.switchedBuildings.length,1);
    assert.equal(result.recipe_switching_candidate,undefined);
});
test('other workshops skip the extra solve and failed material candidates keep the baseline',async()=>{
    let calls=0;const deps={candidate:async()=>{calls++;throw Error('timeout');},solve:async()=>null};
    assert.equal(await searchRecipeSwitches({...input,facilities:{'Crafting Table':[{count:5}]}},baseline,deps),baseline);
    assert.equal(await searchRecipeSwitches({...input,facilities:{'Chimney Kiln':[{count:2,level:1}]}},baseline,deps),baseline);
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
    const found=searchRecipeSwitches(twoWorkshops,baseline,{
        createWorker,parallel:3,candidate:()=>assert.fail('unexpected inline retry'),solve:async m=>highs.solve(m.lp),
    });
    assert.deepEqual(pending.map(p=>p.facilities),[['Woodworking Bench','Chimney Kiln'],['Woodworking Bench'],['Chimney Kiln']]);
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
    const retried=await searchRecipeSwitches(twoWorkshops,baseline,deps);
    assert.equal(retried.rate_per_second,2);
    assert.equal(starts,2);
    assert.equal(retries,2);
});

test('a free switch worker starts the next choice while the first choice is still running', async()=>{
    const started=[];
    const result=searchRecipeSwitches(twoWorkshops,baseline,{
        parallel:2,createWorker:()=>({
            postMessage({payload}){started.push([JSON.parse(payload).recipe_switching_facilities,this]);},
            terminate(){},
        }),
        candidate:()=>assert.fail('unexpected inline solve'),solve:async model=>highs.solve(model.lp),
    });
    assert.deepEqual(started.map(([facilities])=>facilities),[['Woodworking Bench','Chimney Kiln'],['Woodworking Bench']]);
    started[1][1].onmessage({data:{ok:true,result:JSON.stringify(baseline)}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(started.map(([facilities])=>facilities),[['Woodworking Bench','Chimney Kiln'],['Woodworking Bench'],['Chimney Kiln']]);
    started[2][1].onmessage({data:{ok:true,result:JSON.stringify({...candidate,rate_per_second:4})}});
    started[0][1].onmessage({data:{ok:true,result:JSON.stringify(candidate)}});
    assert.equal((await result).rate_per_second,2);
});

test('parallel workers check their own workshop and an inline retry checks it again',async()=>{
    const starts=[],checks=[];
    const workshopBaseline={success:true,priorities:[],level_up_preview:{}};
    const result=searchRecipeSwitches(twoWorkshops,baseline,{
        parallel:3,workshopBaseline,createWorker:()=>({
            postMessage(message){assert.deepEqual(message.workshopBaseline,workshopBaseline);starts.push(this);},
            terminate(){},
        }),
        canFillWorkshop(trial){checks.push(trial.recipe_switching_facilities);return false;},
        candidate:()=>assert.fail('an infeasible workshop should skip the income search'),
        solve:async model=>highs.solve(model.lp),
    });
    assert.equal(starts.length,3);
    assert.deepEqual(checks,[]);
    starts[0].onmessage({data:{ok:true,result:JSON.stringify({success:false})}});
    starts[1].onerror();
    const kilnPlan={...candidate,schedule_sources:candidate.schedule_sources.map(s=>({...s,facility:'Chimney Kiln'}))};
    starts[2].onmessage({data:{ok:true,result:JSON.stringify(kilnPlan)}});
    assert.equal((await result).rate_per_second,2);
    assert.deepEqual(checks,[['Woodworking Bench']]);
});

test('an upgrade material gain breaks a tie after the selected priorities and income',()=>{
    const ordinary={...baseline,comparison_scores:{material_pace:3}};
    const switched={...ordinary,comparison_scores:{material_pace:4}};
    assert.equal(improvesPlan(switched,ordinary),true);
    assert.equal(improvesPlan({...switched,rate_per_second:.5},ordinary),false);
    const crops = (plan,count) => ({...plan,comparison_scores:{...plan.comparison_scores,crop_variety:count}});
    assert.equal(improvesPlan(crops(switched,2),crops(ordinary,3)),false);
    assert.equal(improvesPlan({...ordinary,comparison_scores:{material_pace:3,material_work:4}},
        {...ordinary,comparison_scores:{material_pace:3,material_work:2}}),true);
});

test('workshop selection protects player priorities and compares the actual upgrade horizon on tied income',async()=>{
    const {prefersWorkshopPlan}=await import('../web/recipe-switch-search.js');
    const coins={...baseline,priorities:[{target:'coins',per_second:1}],level_up_preview:{seconds:100}};
    const faster={...coins,level_up_preview:{seconds:90},recipe_schedule:{switches:[1]}};
    assert.ok(prefersWorkshopPlan(faster,coins));
    const lowerIncome={...faster,rate_per_second:.9,priorities:[{target:'coins',per_second:.9}]};
    assert.equal(prefersWorkshopPlan(lowerIncome,coins),false);
    const levelUp={...coins,priorities:[{target:'level_up',per_second:0},...coins.priorities]};
    assert.ok(prefersWorkshopPlan({...lowerIncome,priorities:[levelUp.priorities[0],...lowerIncome.priorities]},levelUp));
    assert.equal(prefersWorkshopPlan({...coins,recipe_schedule:{switches:[1]}},coins),false);
    assert.ok(prefersWorkshopPlan(coins,{...coins,recipe_schedule:{switches:[1]}}));
    const crew=n=>({...coins,roster_workload:[.2],recipe_schedule:{switches:[1],workerProfiles:{0:[n,.2]}}});
    assert.ok(prefersWorkshopPlan(crew(1),crew(2)));
    assert.equal(prefersWorkshopPlan(crew(2),crew(1)),false);
});
test('workshop capacity trials pass the common physical schedule check',async()=>{
    const {validateWorkshopCapacity}=await import('../web/recipe-switch-search.js');
    const found=await validateWorkshopCapacity(input,candidate,baseline,m=>highs.solve(m.lp));
    assert.equal(found.recipe_schedule.switchedBuildings.length,1);
    assert.equal(found.recipe_switching_candidate,undefined);
    const impossible={...candidate,schedule_sources:candidate.schedule_sources.map(s=>({...s,rate:1}))};
    assert.equal(await validateWorkshopCapacity(input,impossible,baseline,m=>highs.solve(m.lp)),null);
});
