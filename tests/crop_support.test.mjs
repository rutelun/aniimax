import test from 'node:test';
import assert from 'node:assert/strict';
import { withCropSupport } from '../web/crop-support.js';
const recipes=[{name:'rice',facility:'Farmland',jobs:[['Reaping','Dark',1],['Reclaiming','Earth',1],['Sowing','Grass',1]],job_workloads:[['Reaping',3],['Reclaiming',5],['Sowing',3]]}];
const layout={pieces:[{members:Array.from({length:24},(_,i)=>({facility:'Farmland',crop:'rice',x:i%6*2,y:Math.floor(i/6)*2,w:2,h:2,weight:1}))}],storages:[]};
test('generated support considers real multi-role forms outside the base team',()=>{
 const pools=['Dark','Earth','Grass'].map(ability=>({count:1,abilities:{[ability]:1},allocations:[{siteKey:'Farmland|rice',ability,critical:true,busy:.1}],busy:.1}));
 const result=withCropSupport({pools,layout,recipes,limit:10});
 assert.ok(result.peak.recommendedTargetMet);
 assert.ok(result.peak.additions.some(a=>a.member>=pools.length));
 assert.ok(result.peak.additions.every(a=>a.member<pools.length||result.pools[a.member].entry));
 assert.deepEqual(pools.map(p=>p.count),[1,1,1]);
});
