import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {searchWorkforce,referenceStage,checkedTeamReference} from '../web/workforce-search.js';
import {solveWithIncumbent} from '../web/highs-solve.js';

const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const solve=async(p,options,_,seed)=>{
    const r=solveWithIncumbent(highs,p,options,seed);
    return r.Columns?{values:Array.from({length:p.variables},(_,i)=>r.Columns['x'+i]?.Primal||0),objective:r.ObjectiveValue,proven:r.Status==='Optimal'}:null;
};
const problem=(seconds=1)=>({variables:4,variable_keys:['a-old','b-old','a-new','b-new'],tiebreak:[],primary_objective:[[0,1],[1,1],[2,1],[3,1]],
    worker_loads:[[0,1,[[0,seconds]]],[1,1,[[1,seconds]]],[2,1,[[2,seconds],[3,seconds]]]],
    lp:'Maximize\n obj: x0 + x1 + x2 + x3\nSubject To\n a: x0 + x2 = 0.5\n b: x1 + x3 = 0.5\nBounds\n 0 <= x0 <= 0.5\n 0 <= x1 <= 0.5\n 0 <= x2 <= 0.5\n 0 <= x3 <= 0.5\nGeneral\nEnd'});

test('one dual-ability worker replaces two partial single-ability shifts without losing production',async()=>{
    const answer=await searchWorkforce(problem(),{values:[.5,.5,0,0],objective:1,proven:true},solve,{time_limit:1});
    assert.equal(answer.workers,1);
    assert.equal(answer.workers_proven,true);
    assert.ok(answer.values[2]+answer.values[3]>.99999);
    assert.ok(answer.objective>.99999);
});

test('delivery/walking loads and full-time workplaces prevent an impossible one-worker replacement',async()=>{
    for(const seconds of [1.2,2]){
        const answer=await searchWorkforce(problem(seconds),{values:[.5,.5,0,0],objective:1,proven:true},solve,{time_limit:1});
        assert.equal(answer.workers,2);
    }
});

test('a fractional or underloaded headcount cannot be reported as a checked reduction',async()=>{
    for(const counters of [[.5,0,0],[0,0,0]]){
        const answer=await searchWorkforce(problem(),{values:[.5,.5,0,0],objective:1,proven:true},
            async()=>({values:[.5,.5,0,0,...counters],proven:true}),{time_limit:1});
        assert.equal(answer,null);
    }
});

test('a weaker repeat search never becomes the reference for a replacement',()=>{
    const input={priorities:['coins'],roster:{members:[]}};
    const original={success:true,currency:'coins',rate_per_second:10,proven_optimal:true,comparison_seed:{keys:['a'],values:[1]}};
    for(const candidate of [null,{success:false},{...original,rate_per_second:9}]){
        const reference=checkedTeamReference(original,candidate,input);
        assert.equal(reference.rate_per_second,10);
        assert.equal(reference.comparison_seed,original.comparison_seed);
        assert.equal(reference.workforce_proven,false);
    }
    const better={...original,rate_per_second:11};
    assert.equal(checkedTeamReference(original,better,input),better);
});

test('reference stage preserves the actual final production goals and supports older plans',()=>{
    const comparison_stage={floors:[['coins',12]],maximize_material_work:true};
    assert.equal(referenceStage({comparison_stage}),comparison_stage);
    const plan={comparison_goals:{floors:[['Wood Blocks',3],['coins',10]],currency:'coins',currency_value:12,crop_variety:8},
        comparison_scores:{material_pace:2,material_work:5}};
    const stage=referenceStage(plan);
    assert.deepEqual(stage.floors,[['Wood Blocks',3],['coins',12]]);
    assert.equal(stage.maximize_material_work,true);
    assert.equal(stage.material_pace,2);
    const stock=referenceStage({...plan,comparison_scores:{material_work:5,stock:9}});
    assert.equal(stock.coins,12);
    assert.equal(stock.material_work,5);
    assert.equal(stock.maximize_material_work,undefined);
});
