import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveWithIncumbent} from '../web/highs-solve.js';
import {searchMaterials} from '../web/material-search.js';

test('material seed keeps production buildings and proves the global workload using a relaxed bound', async () => {
    const highs = await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const problem = {variables:3,tiebreak:[],material_fixed:[0],primary_objective:[[2,1]],lp:
        'Maximize\n obj: x2\nSubject To\n income: x0 >= 1\n work: x2 - x1 <= 0\n supply: x2 <= 1.5\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 2\n x2 >= 0\nGeneral\n x0\n x1\nEnd'};
    const calls = [];
    const solve = async (p, options, _, incumbent) => {
        calls.push(p.lp);
        const r = solveWithIncumbent(highs,p,options,incumbent);
        if (r.Status !== 'Optimal') return null;
        return {objective:r.ObjectiveValue,proven:true,values:Array.from({length:p.variables},(_,i)=>r.Columns[`x${i}`]?.Primal||0)};
    };
    const result = await searchMaterials(problem,[1,0,0],solve,{time_limit:2});
    assert.equal(result.objective,1.5);
    assert.equal(result.values[0],1);
    assert.equal(result.proven,true);
    assert.equal(calls.length,2);
    assert.match(calls[0],/material_fix_0: x0 = 1/);
    assert.doesNotMatch(calls[0],/material_fix_1/);
    assert.doesNotMatch(calls[1],/General/);
});

test('a restricted optimum cannot claim global optimality when the relaxation allows more', async () => {
    const problem = {variables:1,material_fixed:[0],primary_objective:[[0,1]],lp:'Maximize\n obj: x0\nSubject To\nBounds\n 0 <= x0 <= 3\nGeneral\n x0\nEnd'};
    const results = [{objective:1,values:[1],proven:true},{objective:3,values:[3],proven:true},null];
    const calls = [];
    const best = await searchMaterials(problem,[0],async (...args)=>{calls.push(args);return results.shift();},{time_limit:30});
    assert.equal(calls.length,3);
    assert.deepEqual(calls[2][3],[1]);
    assert.equal(best.objective,1);
    assert.equal(best.proven,false);
});

test('a time-limited zero-material incumbent is not returned as a successful workload plan', async () => {
    const result = await searchMaterials({variables:1},[0],async()=>({objective:0,values:[0],proven:false}),{time_limit:30});
    assert.equal(result,null);
});

test('an infeasible restricted layout still searches the full model', async () => {
    let calls = 0;
    const problem = {variables:1,material_fixed:[0],lp:'\nBounds\n'};
    const best = await searchMaterials(problem,[0],async()=>++calls===1?null:{objective:2,values:[2],proven:true},{time_limit:30});
    assert.equal(calls,2);
    assert.equal(best.objective,2);
    assert.equal(best.proven,true);
});
