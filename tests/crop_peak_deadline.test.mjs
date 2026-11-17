import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCropPeakTeam } from '../web/crop-peaks.js';
const scenario = (count=4) => ({members:[{count,abilities:{Dark:1}}],counts:[1],jobs:Array.from({length:8},(_,i)=>({id:i,key:'crop|Dark',name:'Reaping',ability:'Dark',level:1,seconds:[20],point:[0,0],order:i})),limit:5});
test('100 seconds means last job completion, not average job waiting',()=>{
 const result=selectCropPeakTeam(scenario());
 assert.deepEqual(result.counts,[2]);assert.equal(result.completion,80);assert.equal(result.beforeCompletion,160);assert.equal(result.targetMet,true);
});
test('do not activate spare copies once the mean deadline is met',()=>{
 const result=selectCropPeakTeam({...scenario(),counts:[2]});assert.deepEqual(result.counts,[2]);
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
const recipes=[{name:'rice',facility:'Farmland',jobs:[['Reaping','Dark',1],['Sowing','Grass',1]],job_workloads:[['Reaping',20],['Sowing',10]]}];
test('generated teams use canonical work, dependencies and real occupied shifts',()=>{
 const pools=[{count:1,abilities:{Dark:1,Grass:1},allocations:[{siteKey:'Farmland|rice',ability:'Dark',busy:.1,critical:true},{siteKey:'Farmland|rice',ability:'Grass',busy:.1,critical:true},{busy:.7,duration:120}]}];
 const result=plannedCropPeakTeam({layout,recipes,pools,limit:5});
 assert.equal(result.targetMet,false);assert.equal(result.recommendedTargetMet,true);assert.ok(result.additions.length);
 assert.ok(result.completion>=240);assert.ok(result.recommendedCompletion<=100);
 assert.equal(pools[0].count,1,'base team is not mutated');
});
test('multiple independent bottlenecks can require more than one added copy',()=>{
 const j=[...scenario().jobs,...scenario().jobs.map(j=>({...j,id:'g'+j.id,ability:'Grass',seconds:[Infinity,20]}))].map(j=>({...j,seconds:j.ability==='Dark'?[20,Infinity]:j.seconds}));
 const result=selectCropPeakTeam({members:[{count:3,abilities:{Dark:1}},{count:3,abilities:{Grass:1}}],counts:[1,1],jobs:j,limit:6});
 assert.deepEqual(result.counts,[2,2]);assert.equal(result.targetMet,true);
});
test('generated permanent workers are unavailable for crop bursts',()=>{
 const pools=[{count:1,abilities:{Dark:4,Grass:4},allocations:[{busy:1,fixed:true}]},{count:1,abilities:{Dark:1,Grass:1},allocations:[{siteKey:'Farmland|rice',ability:'Dark',busy:.1,critical:true},{siteKey:'Farmland|rice',ability:'Grass',busy:.1,critical:true}]}];
 const result=plannedCropPeakTeam({layout,recipes,pools,limit:5});
 assert.ok(result.additions.every(a=>a.member===1));assert.ok(result.completion>=240);
});
test('full-time generated couriers finish their trip before harvesting',()=>{
 const distant={...layout,storages:[{x:120,y:0,w:2,h:2}],pieces:[{members:layout.pieces[0].members.slice(0,4)}]};
 const harvestOnly=[{...recipes[0],jobs:[['Reaping','Dark',1]]}];
 const result=plannedCropPeakTeam({layout:distant,recipes:harvestOnly,pools:[{count:1,abilities:{Dark:1,Hauling:3},allocations:[{ability:'Hauling',busy:1}]}],limit:1});
 assert.ok(result.completion>100);assert.equal(result.targetMet,false);
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
