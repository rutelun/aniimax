import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendBestTeam} from '../web/best-team.js';
const job=(label,profile)=>({ability:'Fire',level:2,label,busy:.5,profile});
test('team counts concurrent scheduled demand rather than its daily average',()=>{
    const team=recommendBestTeam([job('a',[2,0]),job('b',[2,0])]);
    assert.equal(team.shifts.length,2);
    assert.ok(team.shifts.every(s=>Math.max(...s.phaseBusy)<=1+1e-6));
});
test('the same Aniimo can perform complementary scheduled jobs',()=>{
    const team=recommendBestTeam([job('a',[2,0]),job('b',[0,2])]);
    assert.equal(team.shifts.length,1);
    assert.equal(team.shifts[0].busy,1);
});
