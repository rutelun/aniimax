import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {resourceBounds} from '../web/resource-bounds.js';
import {parseLinearLp} from '../web/highs-reuse.js';

const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const problem={variables:3,variable_keys:['units:a','units:b','sold:c'],recipe_options:[[2,'c']],
    lp:'Maximize\n obj: 10 x0 - 5 x1 + x2\nSubject To\n stock: x2 <= 2.5\nBounds\n 0 <= x0 <= 3\n 0 <= x1 <= 4\n 0 <= x2 <= 3\nGeneral\n x0\n x1\nEnd'};

test('both signs of reduced cost retain ties and every integer pattern at least as good as the witness',()=>{
    const {problem:bounded,upper,score}=resourceBounds(highs,problem,{values:[3,1,2.5]});
    assert.equal(score,27.5);
    assert.equal(upper,32.5);
    assert.match(bounded.lp,/priced_lower_0: x0 >= 3/);
    assert.match(bounded.lp,/priced_upper_1: x1 <= 1/);
    const parsed=parseLinearLp(bounded.lp,3);
    for(let a=0;a<=3;a++)for(let b=0;b<=4;b++)for(const c of [0,1,2,2.5]){
        if(10*a-5*b+c<score)continue;
        for(const row of parsed.rows){
            const lhs=row.coefficients.reduce((s,[v,k])=>s+k*[a,b,c][v],0);
            assert.ok(lhs>=row.lo && lhs<=row.hi);
        }
    }
    assert.equal(highs.solve(bounded.lp).ObjectiveValue,highs.solve(problem.lp).ObjectiveValue);
});

test('a fractional, infeasible or incompatible incumbent cannot supply a pruning threshold',()=>{
    for(const values of [[3.1,0,2],[2,0,3],[2,-1,2],[2,0],[2,0,NaN]]){
        assert.equal(resourceBounds(highs,problem,{values}),null);
    }
});
