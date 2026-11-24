import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyMappedWorkshopCandidate} from '../web/mapped-material-schedule.js';
import {buildReactiveDispatch,measuredDispatchWork} from '../web/reactive-dispatch.js';

function shift(){
    const facility='Chimney Kiln',item='coarse_sifted_ore';
    const layout={pieces:[{members:[{facility,crop:item,x:0,y:0,w:2,h:2,batchWeight:36}]}],
        storages:[{x:4,y:0,w:2,h:2}],unplaced:[],power:{disconnected:0}};
    const members=[{count:1,abilities:{Fire:3,Hauling:3}}];
    const recipes=[{facility,name:item,aniimo:['Fire',2],yieldAmount:1}];
    const routes=[{member:0,facility,item,visits:.01,job_rate:.01,walking:0,jobs:[['',.3]]}];
    const context={layout,recipes,members,routes,busy:[.3],permanent:[0]};
    const plan={coin_items:[{status:'producing',facility,item_name:item,cycle_time:30,busy_units:.3}],
        roster_routes:routes,roster_workload:[.3]};
    const policy=buildReactiveDispatch(context);
    routes[0].walking=policy[facility+'|'+item+'|Production'][0].travel_seconds*.01;
    plan.hauling_staffing=measuredDispatchWork(plan,policy,recipes).delivery;
    plan.roster_dispatch=policy;
    return {plan,context};
}
const baseline={completion:0,targetSeconds:60,counts:[1],growerOutsideLoad:0};
test('a newly optimized permanent shift must reproduce its charged travel and hauling on the selected map',()=>{
    const {plan,context}=shift();
    assert.ok(verifyMappedWorkshopCandidate(plan,context,1,baseline));
    context.layout.storages[0].x=40;
    assert.equal(verifyMappedWorkshopCandidate(plan,context,1,baseline),false);
});
test('the measured roster must cover the schedule peak even when daily charges agree',()=>{
    const {plan,context}=shift();
    plan.recipe_schedule={workerProfiles:{0:[1.5,.1]},haulingProfiles:{0:[1,1]},jobs:[],phases:[
        {duration:43200,assignments:[]},{duration:43200,assignments:[]}]};
    assert.equal(verifyMappedWorkshopCandidate(plan,context,1,baseline),false);
});
test('a fixed background recipe is priced at its actual rate in each workshop phase',()=>{
    const {plan,context}=shift();
    const job={id:'fixed',facility:'Chimney Kiln',item:'coarse_sifted_ore',electric_level:null,crew:0,rate:.01};
    const charged=plan.hauling_staffing[0][1];
    plan.recipe_schedule={workerProfiles:{0:[.45+1.5*charged,.15+.5*charged]},
        haulingProfiles:{0:[1.5,.5]},jobs:[],fixedProduction:[job],phases:[
            {duration:43200,assignments:[],fixedRates:{fixed:.015}},
            {duration:43200,assignments:[],fixedRates:{fixed:.005}}]};
    assert.ok(verifyMappedWorkshopCandidate(plan,context,1,baseline));
    assert.ok(plan.recipe_schedule.haulingProfiles[0][0]>plan.recipe_schedule.haulingProfiles[0][1]);
});
test('a permanent shift overloading an owned copy cannot pass with a rounded-down team',()=>{
    const {plan,context}=shift();
    plan.roster_workload[0]=1.1;
    context.busy=plan.roster_workload;
    assert.equal(verifyMappedWorkshopCandidate(plan,context,1,baseline),false);
});
