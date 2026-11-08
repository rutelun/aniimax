import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {tightenIntegerBounds} from '../web/bound-tightening.js';
import {withProductionBounds} from '../web/priority-search.js';

const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const problem={variables:2,variable_keys:['fast','slow'],production_only:true,primary_objective:[[0,5],[1,4]],
    integer_groups:[['whole buildings',[[0,1],[1,1]],3]],
    lp:'Maximize\n obj: 5 x0 + 4 x1\nSubject To\n space: x0 + x1 <= 2.5\nBounds\n 0 <= x0 <= 2\n 0 <= x1 <= 2\nGeneral\n x0\n x1\nEnd'};

test('LP bounds round integer sums and preserve every feasible plan above the incumbent floor',()=>{
    const cuts=tightenIntegerBounds(highs,problem,{values:[2,0],objective:10});
    assert.ok(cuts.some(c=>c.upper===2));
    assert.ok(cuts.some(c=>c.lower===2));
    for(let a=0;a<=2;a++)for(let b=0;b<=2;b++){
        if(a+b>2.5 || 5*a+4*b<10*(1-1e-4))continue;
        for(const cut of cuts){
            const value=cut.terms.reduce((s,[key,c])=>s+c*(key==='fast'?a:b),0);
            assert.ok(cut.lower==null?value<=cut.upper:value>=cut.lower);
        }
    }
    const guarded=withProductionBounds(problem,cuts);
    const result=highs.solve(guarded.lp);
    assert.equal(result.Status,'Optimal');
    assert.equal(result.ObjectiveValue,10);
});

test('integer cuts transfer with semantic columns and keep the lower-bound direction',()=>{
    const later={...problem,variable_keys:['slow','fast']};
    const lp=withProductionBounds(later,[{terms:[['fast',1]],lower:1},{terms:[['slow',1]],upper:0}]).lp;
    assert.match(lp,/priority_upper_0: \+ 1 x1 >= 1/);
    assert.match(lp,/priority_upper_1: \+ 1 x0 <= 0/);
});

test('a numerical bound just below an integer cannot remove that integer solution',()=>{
    const p={...problem,variables:1,variable_keys:['unit'],primary_objective:[[0,1]],integer_groups:[['unit',[[0,1]],2]],
        lp:'Maximize\n obj: x0\nSubject To\n edge: x0 <= 0.99999999\nBounds\n 0 <= x0 <= 2\nGeneral\n x0\nEnd'};
    const cuts=tightenIntegerBounds(highs,p,{values:[1],objective:.99999999});
    assert.ok(cuts.every(c=>c.upper==null||c.upper>=1));
});

test('no bound is fabricated without a usable incumbent, metadata, or probing budget',()=>{
    assert.deepEqual(tightenIntegerBounds(highs,{...problem,production_only:false},{values:[2,0],objective:10}),[]);
    assert.deepEqual(tightenIntegerBounds(highs,problem,{values:[2],objective:10}),[]);
    assert.deepEqual(tightenIntegerBounds(highs,problem,{values:[2,0],objective:10},{timeLimit:0}),[]);
});
