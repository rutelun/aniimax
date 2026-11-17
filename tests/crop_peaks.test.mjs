import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCropPeakTeam, cropPeakInput } from '../web/crop-peaks.js';
import { scheduleRosterCopies } from '../web/roster-work.js';

const jobs = Array.from({length:8}, (_,i)=>({key:'Farmland|rice|Dark',ability:'Dark',level:1,
    seconds:[10,10],point:[i*2,0],release:0}));
const workers = [{count:1,abilities:{Dark:3,Fire:3}},{count:2,abilities:{Dark:3}}];
const input = {members:workers,counts:[1,1],permanent:[0,0],jobs,
    targetSeconds:30,outside:[{busy:.8,seconds:120,point:[80,0]},{busy:0,seconds:0,point:[0,0]}],limit:3};

test('an idle crop copy reduces a simultaneous harvest queue while a multi-role worker is busy',()=>{
    const result=selectCropPeakTeam(input);
    assert.deepEqual(result.counts,[1,2]);
    assert.ok(result.wait < result.beforeWait);
    assert.ok(result.shares['Farmland|rice|Dark'].find(e=>e.member===1).share>.5);
});
test('watering alone never requests peak workers',()=>{
    const result=selectCropPeakTeam({...input,jobs:jobs.map(j=>({...j,ability:'Water',name:'Watering'}))});
    assert.deepEqual(result.counts,[1,1]);assert.equal(result.wait,0);
});
test('the RV limit and permanent posts are respected',()=>{
    assert.deepEqual(selectCropPeakTeam({...input,limit:2}).counts,[1,1]);
    const result=selectCropPeakTeam({...input,permanent:[0,2]});
    assert.ok(!result.shares['Farmland|rice|Dark'].some(e=>e.member===1));
});
test('approach starts after release and results are deterministic',()=>{
    const simple={members:[{count:1,abilities:{Dark:1}}],counts:[1],jobs:[{...jobs[0],seconds:[10],point:[40,0]}],
        outside:[{busy:0,seconds:0,point:[0,0]}],limit:1};
    assert.equal(selectCropPeakTeam(simple).wait,10);
    assert.deepEqual(selectCropPeakTeam(input),selectCropPeakTeam(input));
});
test('critical request shares are conserved without creating workload or clipping overload',()=>{
    const result=selectCropPeakTeam(input);
    assert.ok(Math.abs(result.shares['Farmland|rice|Dark'].reduce((n,e)=>n+e.share,0)-1)<1e-10);
    assert.equal(input.outside[0].busy,.8);
    assert.ok(!('busy' in result));
});

test('peak copies respect actual noncrop packing without losing workload',()=>{
    const shifts=scheduleRosterCopies(2,[],[],[{jobs:[['Production',.9]]},
        {jobs:[['Reaping',.8]],copyShares:[[0,.5],[1,.5]]}]);
    assert.ok(shifts.every(s=>s.busy<=1+1e-10));
    assert.ok(Math.abs(shifts.reduce((n,s)=>n+s.busy,0)-1.7)<1e-10);
    const overload=scheduleRosterCopies(1,[],[],[{jobs:[['Production',.9]]},
        {jobs:[['Reaping',.8]],copyShares:[[1,1]]}]);
    assert.ok(Math.abs(overload[0].busy-1.7)<1e-10);
});
test('hauling supplies residual job time and storage origins, not just average load',()=>{
    const args={members:[{count:1,abilities:{Dark:3,Hauling:3}}],busy:[.1],delivery:[[0,.9]],
        layout:{pieces:[{members:[{facility:'Farmland',crop:'rice',x:40,y:0,w:2,h:2,weight:2}]}],storages:[{x:0,y:0,w:2,h:2}]},
        recipes:[{name:'rice',facility:'Farmland',jobs:[['Reaping','Dark',1]]}],
        routes:[{member:0,facility:'Farmland',item:'rice',job_rate:.01,visits:.01,jobs:[['Reaping',.1]],walking:0}]};
    const input=cropPeakInput(args);
    assert.ok(input.outside[0].seconds>0);
    assert.ok(input.outside[0].origins.some(o=>o.point[0]===1));
    assert.ok(selectCropPeakTeam(input).wait>0);
});
test('peak evaluation leaves the checked mean production and route workloads intact',()=>{
    const before=structuredClone(input);selectCropPeakTeam(input);assert.deepEqual(input,before);
});
test('peak tasks execute after their predecessor; watering is not a prerequisite',()=>{
    const result=selectCropPeakTeam({members:[{count:1,abilities:{Dark:1,Grass:1}}],counts:[1],limit:1,
        jobs:[{...jobs[0],id:'harvest',seconds:[10],point:[0,0]},
            {...jobs[0],id:'sow',previous:'harvest',ability:'Grass',seconds:[20],point:[0,0]}]});
    assert.equal(result.wait,0,'sowing starts after harvesting, with no invented queue delay');
});
test('a spare copy cannot claim benefits from another pool’s checked routes',()=>{
    const result=selectCropPeakTeam({...input,members:[{count:3,abilities:{Dark:3}},{count:1,abilities:{Dark:3}}],
        jobs:jobs.map(j=>({...j,eligibleMembers:[1]})),limit:4});
    assert.deepEqual(result.counts,[1,1]);
    assert.deepEqual(result.shares['Farmland|rice|Dark'],[{member:1,share:1}]);
});
