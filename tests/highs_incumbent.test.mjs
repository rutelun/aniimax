import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveWithIncumbent,polishSolution,attainablePriority,planSearchOptions,runPlanModel,searchStopped} from '../web/highs-solve.js';

test('incumbent values follow variable names despite a different native LP column order', async () => {
    const highs = await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const problem = {variables:2,lp:'Maximize\n obj: 2 x1 + x0\nSubject To\n cap: x0 + x1 <= 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x0\n x1\nEnd'};
    const result = solveWithIncumbent(highs,problem,{time_limit:1},[0,1]);
    assert.equal(result.Status,'Optimal');
    assert.equal(result.ObjectiveValue,2);
    assert.equal(result.UpperBound,2);
    assert.equal(result.Columns.x1.Primal,1);
    assert.equal(result.Columns.x0.Primal,0);
    const impossible = {...problem,lp:problem.lp.replace('<= 1\nBounds','<= -1\nBounds')};
    assert.equal(solveWithIncumbent(highs,impossible,{time_limit:1},[0,1]).Status,'Infeasible');
    // A failed search has released its native model and doesn't contaminate the next one.
    assert.equal(solveWithIncumbent(highs,problem,{time_limit:1},[1,0]).ObjectiveValue,2);
});

test('continuous polishing repairs rates without moving a workplace or inventing a global proof',async()=>{
    const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const problem={variables:2,tiebreak:[],lp:'Maximize\n obj: x0\nSubject To\n capacity: 3 x0 - x1 <= 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x1\nEnd'};
    const seed={values:[1/3+1e-8,1],objective:1/3+1e-8,proven:false};
    const polished=polishSolution(highs,problem,seed);
    assert.equal(polished.values[1],1);
    assert.ok(3*polished.values[0]<=1+1e-10);
    assert.equal(polished.proven,false);
    assert.equal(seed.values[0],1/3+1e-8);
    const impossible={...problem,lp:problem.lp.replace('0 <= x0 <= 1','0.5 <= x0 <= 1')};
    assert.equal(polishSolution(highs,impossible,seed),seed);
});

test('a certified income tolerance retains the dual ceiling and the open proof gap',async()=>{
    const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const items=Array.from({length:24},(_,i)=>i+1);
    const terms=(factor,modulus)=>items.map(i=>(1+i*factor%modulus)+' x'+i).join(' + ');
    const lp=['Maximize',' obj: 1000000 x0 + '+terms(17,31),'Subject To',
        ...[7,13,19].map((a,i)=>' cap'+i+': '+terms(a,23+i*3)+' <= '+(130+i*15)),
        'Bounds',' 1 <= x0 <= 1',...items.map(i=>' 0 <= x'+i+' <= 1'),
        'General',...items.map(i=>' x'+i),'End'].join('\n');
    const p={variables:25,lp};
    const approximate=solveWithIncumbent(highs,p,{mip_rel_gap:.002});
    const exact=solveWithIncumbent(highs,p,{mip_rel_gap:0});
    assert.equal(approximate.Status,'Gap target reached');
    assert.ok(approximate.UpperBound>approximate.ObjectiveValue);
    assert.ok(approximate.UpperBound<=approximate.ObjectiveValue*1.002);
    assert.ok(approximate.ObjectiveValue<=exact.ObjectiveValue && exact.ObjectiveValue<=approximate.UpperBound);
    assert.equal(exact.Status,'Optimal');
});

test('production search uses repeatable work limits and keeps early exits distinct from proofs',()=>{
    const options=planSearchOptions({time_limit:2,mip_rel_gap:0});
    assert.equal(options.time_limit,undefined);
    assert.equal(options.mip_max_nodes,1);
    assert.equal(planSearchOptions({time_limit:30}).mip_max_nodes,2048);
    assert.equal(planSearchOptions({mip_max_nodes:128}).mip_max_nodes,128);
    const statuses={optimal:7,timeLimit:13,iterationLimit:14,solutionLimit:16,interrupted:17};
    let interruptedAt;
    const model={run(callbacks){
        for(const iterations of [1n,999n,1000n]){
            callbacks[6]({data:{mip_total_lp_iterations:iterations},interrupt(){interruptedAt=iterations;}});
            if(interruptedAt!==undefined)break;
        }
    }};
    runPlanModel(model,{constants:{callbackType:{mipInterrupt:6}}},1000);
    assert.equal(interruptedAt,1000n);
    assert.ok(searchStopped(statuses.interrupted,statuses));
    assert.equal(searchStopped(statuses.optimal,statuses),false);
});

test('later priorities inherit a pace attainable within the worker capacity', async () => {
    const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const problem={variables:2,tiebreak:[],lp:'Maximize\n obj: x0\nSubject To\n capacity: x0 - x1 <= 0\nBounds\n 0 <= x0 <= 2\n 0 <= x1 <= 1\nGeneral\n x1\nEnd'};
    const noisy={objective:1.000000809,values:[1.000000809,1],proven:true,searchProven:true,upper:1.000000809};
    const pace=attainablePriority(highs,problem,noisy);
    assert.equal(pace.objective,1);
    assert.deepEqual(pace.values,[1,1]);
    assert.equal(pace.proven,false);
    assert.equal(pace.searchProven,false);
    assert.equal(pace.upper,noisy.upper);
    const exact={...noisy,objective:1,values:[1,1]};
    assert.equal(attainablePriority(highs,problem,exact),exact);
});
