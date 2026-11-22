import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCropPeakTeam } from '../web/crop-peaks.js';
const scenario = (count=4) => ({members:[{count,abilities:{Dark:1}}],counts:[1],jobs:Array.from({length:8},(_,i)=>({id:i,key:'crop|Dark',name:'Reaping',ability:'Dark',level:1,seconds:[20],point:[0,0],order:i})),limit:5});
test('100 seconds means last job completion, not average job waiting',()=>{
 const result=selectCropPeakTeam(scenario());
 assert.deepEqual(result.counts,[2]);assert.equal(result.completion,80);assert.equal(result.beforeCompletion,160);assert.equal(result.targetMet,true);
 assert.deepEqual(result.withoutHelper,[160]);
});
test('do not activate spare copies once the mean deadline is met',()=>{
 const result=selectCropPeakTeam({...scenario(),counts:[2]});assert.deepEqual(result.counts,[2]);
 assert.deepEqual(result.withoutHelper,[null]);
});
test('suggest missing copies without pretending they are owned',()=>{
 const result=selectCropPeakTeam(scenario(1));assert.deepEqual(result.counts,[1]);assert.equal(result.targetMet,false);
 assert.deepEqual(result.additions,[{member:0,count:1}]);assert.equal(result.recommendedCompletion,80);
});
test('RV cap never turns an infeasible deadline into a success',()=>{
 const result=selectCropPeakTeam({...scenario(1),limit:1});assert.equal(result.targetMet,false);assert.deepEqual(result.additions,[]);
});
import { plannedCropPeakTeam } from '../web/crop-peaks.js';
const layout={pieces:[{members:Array.from({length:8},()=>({facility:'Farmland',crop:'rice',x:0,y:0,w:2,h:2,weight:1}))}]};
const recipes=[{name:'rice',facility:'Farmland',jobs:[['Reaping','Dark',1],['Sowing','Grass',1]],job_workloads:[['Reaping',8],['Sowing',5]]}];
test('generated teams use canonical work, dependencies and real occupied shifts',()=>{
 const pools=[{count:1,abilities:{Dark:1,Grass:1},allocations:[{siteKey:'Farmland|rice',ability:'Dark',busy:.1,critical:true},{siteKey:'Farmland|rice',ability:'Grass',busy:.1,critical:true},{busy:.7,duration:120}]}];
 const result=plannedCropPeakTeam({layout,recipes,pools,limit:5});
 assert.equal(result.targetMet,false);assert.equal(result.recommendedTargetMet,true);assert.ok(result.additions.length);
 assert.ok(result.completion>=21);assert.ok(result.recommendedCompletion<21);
 assert.equal(pools[0].count,1,'base team is not mutated');
});
test('multiple independent bottlenecks can require more than one added copy',()=>{
 const j=[...scenario().jobs,...scenario().jobs.map(j=>({...j,id:'g'+j.id,ability:'Grass',seconds:[Infinity,20]}))].map(j=>({...j,seconds:j.ability==='Dark'?[20,Infinity]:j.seconds}));
 const result=selectCropPeakTeam({members:[{count:3,abilities:{Dark:1}},{count:3,abilities:{Grass:1}}],counts:[1,1],jobs:j,limit:6});
 assert.deepEqual(result.counts,[2,2]);assert.equal(result.targetMet,true);
 assert.deepEqual(result.withoutHelper,[160,160]);
});
test('generated permanent workers are unavailable for crop bursts',()=>{
 const pools=[{count:1,abilities:{Dark:4,Grass:4},allocations:[{busy:1,fixed:true}]},{count:1,abilities:{Dark:1,Grass:1},allocations:[{siteKey:'Farmland|rice',ability:'Dark',busy:.1,critical:true},{siteKey:'Farmland|rice',ability:'Grass',busy:.1,critical:true}]}];
 const result=plannedCropPeakTeam({layout,recipes,pools,limit:5});
 assert.ok(!result.shares['Farmland|rice|Dark'].some(w=>w.member===0));
 assert.ok(result.additions.every(a=>a.member===1));assert.ok(result.completion>=13);
});
test('full-time generated couriers finish their trip before harvesting',()=>{
 const distant={...layout,storages:[{x:120,y:0,w:2,h:2}],pieces:[{members:layout.pieces[0].members.slice(0,4)}]};
 const harvestOnly=[{...recipes[0],jobs:[['Reaping','Dark',1]]}];
 const result=plannedCropPeakTeam({layout:distant,recipes:harvestOnly,pools:[{count:1,abilities:{Dark:1,Hauling:3},allocations:[{ability:'Hauling',busy:1}]}],limit:1});
 const free=plannedCropPeakTeam({layout:distant,recipes:harvestOnly,pools:[{count:1,abilities:{Dark:1,Hauling:3},allocations:[]}],limit:1});
 assert.ok(result.completion>free.completion);assert.equal(result.targetMet,false);
});
test('deadline is the mean across scenarios, not their worst completion',()=>{
 const result=selectCropPeakTeam({...scenario(2),jobs:scenario().jobs.slice(0,1),outside:[{busy:.5,seconds:200,point:[0,0]}]});
 assert.equal(result.targetMet,true);assert.ok(result.worstCompletion>100);assert.deepEqual(result.counts,[1]);
});
import { cropPeakInput } from '../web/crop-peaks.js';
test('multiple operations on one ability do not divide canonical duration twice',()=>{
 const recipe={name:'rice',facility:'Farmland',jobs:[['Sowing','Grass',1],['Collecting','Grass',1]],job_workloads:[['Sowing',3],['Collecting',3]]};
 const args={layout,recipes:[recipe],members:[{count:1,abilities:{Grass:1}}],busy:[.06],routes:[{member:0,facility:'Farmland',item:'rice',job_rate:.02,jobs:[['Sowing',.03],['Collecting',.03]]}]};
 assert.ok(cropPeakInput(args).jobs.every(j=>j.seconds[0]===3));
 assert.ok(cropPeakInput({...args,recipes:[{...recipe,job_workloads:undefined}]}).jobs.every(j=>j.seconds[0]===3));
});

test('100-second target accepts the boundary and adds support only above it',()=>{
 for(const seconds of [99,100,101]){
  const result=selectCropPeakTeam({...scenario(),jobs:scenario().jobs.slice(0,2).map(j=>({...j,seconds:[seconds/2]}))});
  assert.equal(result.targetSeconds,100);
  assert.deepEqual(result.counts,[seconds<=100?1:2]);
  assert.equal(result.targetMet,true);
 }
});

test('recurring harvest uses individual sowing times and excludes the synchronized startup',()=>{
 const base=scenario();
 const jobs=base.jobs.map(j=>({...j,cycle:1800,seconds:[15]}));
 const result=selectCropPeakTeam({...base,jobs});
 assert.equal(result.targetSeconds,21);
 assert.equal(result.completion,15);
 assert.equal(result.targetMet,true);
 assert.deepEqual(result.counts,[1]);
 assert.ok(result.observations>8*8);
});

test('recurring crops accept 20 seconds and require strictly less than 21',()=>{
 const base=scenario(1);
 for(const seconds of [20,21]){
  const result=selectCropPeakTeam({...base,limit:1,recommend:false,jobs:[{...base.jobs[0],cycle:1800,seconds:[seconds]}]});
  assert.equal(result.completion,seconds);
  assert.equal(result.targetMet,seconds<21);
 }
});

test('recurring couriers finish trips after warmup and approach from storage',()=>{
 const base=scenario(1),jobs=[{...base.jobs[0],cycle:1817,seconds:[5]}];
 const idle=selectCropPeakTeam({...base,jobs,limit:1,recommend:false});
 const hauling=selectCropPeakTeam({...base,jobs,limit:1,recommend:false,outside:[{
    busy:.6,hauling:.6,otherSeconds:0,tripSeconds:40,storageOrigins:[{point:[40,0],weight:1}]}]});
 assert.equal(idle.completion,5);
 assert.ok(hauling.completion>idle.completion+10);
 assert.deepEqual(hauling.counts,[1]);
});

test('recurring helper selection returns the accepted copy’s full dispatch shares',()=>{
 const input={members:[{abilities:{Dark:1},count:2}],counts:[1],outside:[{busy:1,seconds:100}],limit:2,
    jobs:[{id:'a',ability:'Dark',level:1,key:'crop',name:'Reaping',cycle:1801,order:0,seconds:[5],point:[0,0]}]};
 const result=selectCropPeakTeam(input);
 assert.deepEqual(result.counts,[2]);
 assert.deepEqual(result.withoutHelper,[104]);
 assert.equal(result.observations,368);
 assert.deepEqual(result.shares,{crop:[{member:0,share:1}]});
 assert.deepEqual(result.copyShares,{'crop|0':[[1,1]]});
});
