import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveWithIncumbent} from '../web/highs-solve.js';
import {parseLinearLp,reuseStatistics,discardReusableModel,acquireModel} from '../web/highs-reuse.js';

const runtime=async()=>highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const problem=(objective,rows,bounds=' 0 <= x0 <= 10\n 0 <= x1 <= 10',integer=false)=>({variables:2,
    variable_keys:['first','second'],lp:`Maximize\n obj: ${objective}\nSubject To\n${rows}\nBounds\n${bounds}${integer?'\nGeneral\n x0\n x1':''}\nEnd`});

test('persistent rows, objectives, bounds, coefficients and integrality match independent cold solves',async()=>{
    const hot=await runtime(),cold=await runtime();
    const models=[
        problem('2 x1 + x0',' cap: x0 + x1 <= 5'),
        problem('x0 + x1',' floor: x1 >= 2\n renamed: x0 + x1 <= 4'),
        problem('2 x1 + x0',' renamed: x0 + x1 <= 7',' 0 <= x0 <= 2\n 0 <= x1 <= 3'),
        problem('2 x1 + x0',' cap: x0 + 2 x1 <= 7\n duplicate: x0 + 2 x1 >= 2'),
        problem('2 x1 + x0',' cap: x0 + 2 x1 <= 6.5',undefined,true),
        problem('2 x1 + x0',' cap: x0 + 2 x1 <= 6.5'),
        problem('x0 + 2 x1',' cap: x0 + x1 <= -1'),
        problem('x0 + 2 x1',' cap: x0 + x1 <= 5'),
    ];
    for(const model of models){
        const a=solveWithIncumbent(hot,model,{time_limit:1});
        const b=solveWithIncumbent(cold,model,{time_limit:1},undefined,false);
        assert.equal(a.Status,b.Status);
        if(a.Status==='Optimal')assert.ok(Math.abs(a.ObjectiveValue-b.ObjectiveValue)<1e-9);
    }
    const stats=reuseStatistics(hot);
    assert.ok(stats.reused>=4);
    assert.ok(stats.addedRows>0&&stats.removedRows>0);
    discardReusableModel(hot); discardReusableModel(cold);
});

test('unsupported LP syntax uses the native reader and changed semantic keys rebuild safely',async()=>{
    const highs=await runtime();
    const first=problem('x0 + x1',' cap: x0 + x1 <= 2');
    solveWithIncumbent(highs,first,{time_limit:1});
    const changed={...first,variable_keys:['new worker','second']};
    solveWithIncumbent(highs,changed,{time_limit:1});
    assert.equal(reuseStatistics(highs).created,2);
    const offset={...first,lp:first.lp.replace('obj: x0 + x1','obj: x0 + x1 + 5')};
    assert.equal(parseLinearLp(offset.lp,2),null);
    assert.equal(solveWithIncumbent(highs,offset,{time_limit:1}).ObjectiveValue,7);
    assert.equal(solveWithIncumbent(highs,first,{time_limit:1}).ObjectiveValue,2);
    discardReusableModel(highs);
});

test('LP parsing keeps scientific coefficients, duplicate terms and native column order',()=>{
    const parsed=parseLinearLp(problem('+ 1e-3 x1 - 2 x0 + 3 x0',' cap: + 1 x0 + 2 x1 <= 4').lp,2);
    assert.deepEqual(parsed.costs,[1,.001]);
    assert.deepEqual(parsed.order,[1,0]);
    assert.equal(parsed.rows[0].hi,4);
});

test('per-solve options and clocks reset without changing protected runtime settings',async()=>{
    const highs=await runtime(),create=highs.createModel.bind(highs);
    let resets=0,clocks=0;
    highs.createModel=source=>{const model=create(source),reset=model.options.reset.bind(model.options),zero=model.zeroAllClocks.bind(model);
        model.options.reset=()=>{resets++;return reset();}; model.zeroAllClocks=()=>{clocks++;return zero();};return model;};
    const model=problem('x0 + x1',' cap: x0 + x1 <= 5');
    solveWithIncumbent(highs,model,{time_limit:1,presolve:'off'});
    assert.equal(acquireModel(highs,model).model.options.get('presolve'),'off');
    solveWithIncumbent(highs,model,{time_limit:1});
    assert.equal(acquireModel(highs,model).model.options.get('presolve'),'choose');
    assert.equal(clocks,2);
    assert.equal(resets,0);
    discardReusableModel(highs);
});
