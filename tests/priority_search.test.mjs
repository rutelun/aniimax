import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {productionObjective,productionCertificate,withProductionBounds} from '../web/priority-search.js';

test('intermediate priorities maximize production; final optimization retains staffing preferences',async()=>{
    const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    // The unmodified secondary penalty favors a tiny reduction in the earlier priority.
    const original={variables:2,tiebreak:[[1,.01]],primary_objective:[[0,1],[1,1.001]],
        lp:'Maximize\n obj: x0 + 0.991 x1\nSubject To\n capacity: x0 + x1 <= 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x0\n x1\nEnd'};
    const next=productionObjective(original);
    assert.equal(highs.solve(original.lp).Columns.x0.Primal,1);
    assert.equal(highs.solve(next.lp).Columns.x1.Primal,1);
    assert.deepEqual(next.tiebreak,[]);
    assert.deepEqual(original.tiebreak,[[1,.01]]);
    assert.equal(next.lp.slice(next.lp.indexOf('Subject To')),original.lp.slice(original.lp.indexOf('Subject To')));
    const final={...original,lp:original.lp.replace('\nBounds\n','\n earlier: x0 + 1.001 x1 >= 1.001\nBounds\n')};
    assert.equal(highs.solve(final.lp).Columns.x1.Primal,1);
});

test('only a proved production maximum supplies a bound, with semantic columns across stages',()=>{
    const earlier=productionObjective({variables:2,variable_keys:['rate','sold:coins'],primary_objective:[[1,3]],
        tiebreak:[[0,.1]],lp:'Maximize\n obj: 3 x1 - .1 x0\nSubject To\nBounds\nEnd'});
    assert.equal(productionCertificate(earlier,{objective:6,proven:false}),null);
    assert.equal(productionCertificate({...earlier,production_only:false},{objective:6,proven:true}),null);
    const certificate=productionCertificate(earlier,{objective:6,proven:true});
    const next={variables:3,variable_keys:['sold:wood','rate','sold:coins'],lp:'Maximize\n obj: x0\nSubject To\nBounds\nEnd'};
    const guarded=withProductionBounds(next,[certificate]);
    assert.match(guarded.lp,/priority_upper_0: \+ 3 x2 <= 6\.000001/);
    assert.equal(withProductionBounds({...next,variable_keys:['other','rate','unknown']},[certificate]).lp,next.lp);
    assert.equal(next.lp.includes('priority_upper'),false);
});

test('a timed-out primary search can transfer its dual bound, never its unproved incumbent value',()=>{
    const p={production_only:true,variables:1,variable_keys:['rate'],primary_objective:[[0,2]]};
    assert.equal(productionCertificate(p,{objective:6,proven:false}),null);
    assert.equal(productionCertificate(p,{objective:6,upper:5,proven:false}),null);
    const result=productionCertificate(p,{objective:6,upper:8,proven:false});
    assert.ok(result.upper>8 && result.upper<8.00001);
    assert.deepEqual(result.terms,[['rate',2]]);
});

test('dominated staffing is pruned only when explicitly enabled for an initial production stage',()=>{
    const p={variables:2,production_zero:[1],primary_objective:[[0,1]],
        lp:'Maximize\n obj: x0\nSubject To\nBounds\n x0 >= 0\n 0 <= x1 <= 2\nGeneral\n x1\nEnd'};
    assert.ok(!productionObjective(p).lp.includes('0 <= x1 <= 0'));
    assert.ok(productionObjective(p,{prune:true}).lp.includes('0 <= x1 <= 0'));
    assert.ok(!p.lp.includes('0 <= x1 <= 0'));
});

