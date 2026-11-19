import test from 'node:test';
import assert from 'node:assert/strict';
import {continuousNeighborhood, incomeRepairNeighborhood, neighborhoodResult, keepProductionWitness} from '../web/continuous-neighborhood.js';

const problem={variable_keys:['rate:a@one','units:a@one','rate:a@two','units:a@two','rate:a@electric','units:a@electric','rate:b@one','units:b@one'],
 recipe_variables:[[0,'a'],[1,'a'],[2,'a'],[3,'a'],[4,'a'],[5,'a'],[6,'b'],[7,'b']],
 recipe_options:[[0,'a','Mill',false,false,5],[2,'a','Mill',false,false,4],[4,'a','Mill',false,true,3],[6,'b','Mill',false,false,4]],
 lp:'Maximize\n x0\nSubject To\n c: x0 <= 1\nBounds\n'+Array.from({length:8},(_,i)=>` 0 <= x${i} <= 1`).join('\n')+'\nEnd'};
const seed={keys:problem.variable_keys,values:[.1,1,0,0,0,0,0,0]};
test('neighborhood keeps selected worker and electric alternatives, constraining other variants',()=>{
 const local=continuousNeighborhood(problem,['a'],seed);
 assert.match(local.lp,/x2 = 0/);assert.match(local.lp,/x3 = 0/);
 assert.match(local.lp,/0 <= x4 <= 1/);assert.match(local.lp,/0 <= x0 <= 1/);
 assert.match(local.lp,/x6 = 0/);assert.equal(local.continuousRestricted,true);
});
test('missing seed or model metadata leaves unrestricted fallback available',()=>{
 assert.equal(continuousNeighborhood(problem,['a'],null),problem);
 assert.equal(continuousNeighborhood({...problem,recipe_options:undefined},['a'],seed).continuousRestricted,undefined);
});
test('neighborhood optimum is never reported as global proof or global bound',()=>{
 const result=neighborhoodResult({values:[1],objective:5,proven:true,upper:5},true);
 assert.equal(result.proven,false);assert.equal(result.searchProven,true);assert.equal(result.upper,undefined);
 assert.equal(neighborhoodResult(null,true),null);
});

test('income repair lets another workshop recipe use the same worker while retaining the source count',()=>{
 const keys=['rate:a__byowned:0#0','units:a__byowned:0#0','rate:b__byowned:0#0','units:b__byowned:0#0',
     'rate:crop#0','units:crop#0','rate:unused#0','units:unused#0'];
 const model={...problem,variable_keys:keys,production_only:true,primary_objective:[[0,8],[2,3]],
     integer_groups:[['crop',[[5,1]],3]],recipe_options:[[0,'a','Mill',false,false],[2,'b','Mill',false,false],[4,'crop','Farmland',false,false],[6,'unused','Mill',false,false]],
     recipe_variables:keys.map((_,i)=>[i,['a','b','crop','unused'][Math.floor(i/2)]])};
 const repair=incomeRepairNeighborhood(model,['a','b','crop'],{keys,values:[1,1,0,0,.1,2,0,0]},9);
 assert.doesNotMatch(repair.lp,/income_off_[23]:/);
 assert.match(repair.lp,/income_sites_5: 1 x5 = 2/);
 assert.match(repair.lp,/income_off_6: x6 = 0/);
 assert.match(repair.lp,/income_target: \+ 8 x0 \+ 3 x2 >= 9/);
 assert.equal(repair.continuousRestricted,true);
});
test('material search may introduce a chain omitted by coin discovery',()=>{
 const material={...problem,continuousMaterialSearch:true,recipe_options:[...problem.recipe_options,[6,'b','Woodworking Bench',false,false,4]]};
 assert.equal(continuousNeighborhood(material,['a'],seed),material);
});

test('a timeout keeps the stronger feasible witness and only the unrestricted upper bound',()=>{
 const witness={values:[1],objective:5,proven:true,upper:5};
 const parent={values:[0],objective:4,proven:false,upper:7};
 const result=keepProductionWitness(parent,witness);
 assert.equal(result.objective,5);assert.equal(result.upper,7);assert.equal(result.proven,false);
 assert.equal(keepProductionWitness(null,witness).upper,undefined);
 assert.equal(keepProductionWitness({...parent,objective:6},witness).objective,6);
});
