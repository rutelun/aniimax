import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryRouting,deliveryRouteCost} from '../web/delivery-routing.js';
const rect=(x,weight=0)=>({x,y:0,w:2,h:2,weight});
const map=gap=>({pieces:[{members:[rect(2,1),rect(gap+2,1)]}],storages:[rect(0),rect(gap)]});
test('equal local delivery distances still penalize travel between distant storage groups',()=>{
    const near=deliveryRouting(map(10)),far=deliveryRouting(map(30));
    assert.equal(near.cost,16);assert.equal(far.cost,36);
});
test('previous assignments do not confine couriers to their own storage groups',()=>{
    const m=map(30);m.pieces[0].members.forEach((s,i)=>s.deliveryWorkers=[[i,1]]);
    assert.equal(deliveryRouting(m).cost,36);
});
test('previous worksite and storage are alternative origins, never two extra return legs',()=>{
    const m={pieces:[{members:[{...rect(4,1),deliveryWorkers:[[0,1]]},{...rect(12),deliveryOrigins:[[0,1]]}]}],storages:[rect(0)]};
    const r=deliveryRouting(m);assert.equal(r.cost,4+(4+8)/2);
    assert.equal(r.arrivals[0].approach,6);
});
test('zero-flow sites and empty storage lists produce finite scores',()=>{
    assert.equal(deliveryRouting({pieces:[{members:[rect(0)]}],storages:[]}).cost,0);
});

test('cached exact scoring follows moving sites, storage assignments and changed workloads',()=>{
 const m=map(30);m.pieces[0].members[0].deliveryWorkers=[[0,1]];
 m.pieces[0].members[1].deliveryWorkers=[[1,1]];
 m.pieces[0].members[1].deliveryOrigins=[[0,3]];
 for(let i=0;i<12;i++){
   m.pieces[0].members[0].x=i*3;m.storages[1].y=i;
   assert.ok(Math.abs(deliveryRouteCost(m)-deliveryRouting(m).cost)<1e-9);
 }
 m.pieces[0].members[0].deliveryWorkers=[[0,8]];
 assert.ok(Math.abs(deliveryRouteCost(m)-deliveryRouting(m).cost)<1e-9);
});
