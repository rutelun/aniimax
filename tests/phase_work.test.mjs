import test from 'node:test';
import assert from 'node:assert/strict';
import {splitPhaseTasks} from '../web/phase-work.js';
test('phase workload is allocated per copy rather than divided by headcount',()=>{
    const shifts=splitPhaseTasks([{label:'a',busy:.4,profile:[2,0]},{label:'b',busy:.4,profile:[2,0]}],[12,12]);
    assert.equal(shifts.length,2);assert.ok(Math.abs(shifts[0].busy-.5)<1e-9);assert.ok(Math.abs(shifts[1].busy-.3)<1e-9);
    assert.equal(shifts[1].tasks.has('a'),false);
});
test('background posts retain the same copy during every phase',()=>{
    const shifts=splitPhaseTasks([{label:'post',busy:1,fixed:true},{label:'a',busy:.3,profile:[2,0]}],[12,12]);
    assert.deepEqual(shifts[0].phaseBusy,[1,1]);assert.equal(shifts[0].tasks.size,1);
});
