import test from 'node:test';
import assert from 'node:assert/strict';
import { splitProductionSites } from '../web/physical-production.js';
import { buildReactiveDispatch } from '../web/reactive-dispatch.js';
const step={facility:'Well',item_name:'water',facility_count:3,busy_units:2.9,cycle_time:1000,crew:null,status:'producing'};
const routes=[1,1,.9].map((work,member)=>({member,facility:'Well',item:'water',job_rate:work/1000,jobs:[['',work]],walking:0}));
test('unequal well rates are preserved at their actual physical workplaces',()=>{
 const split=splitProductionSites(step,routes);assert.equal(split.length,3);
 assert.deepEqual(split.map(s=>s.crew),[0,1,2]);
 assert.ok(Math.abs(split.reduce((s,r)=>s+r.rate,0)-.0029)<1e-12);
 const members=split.map(()=>({count:1,abilities:{Water:4}}));
 const layout={storages:[],pieces:split.map((r,i)=>({members:[{...r,x:i*10,y:0,w:2,h:2,facility:'Well',crop:'water',batchWeight:r.rate*3600}]}))};
 const p=buildReactiveDispatch({layout,recipes:[{name:'water',facility:'Well',aniimo:['Water',1]}],members,busy:[1,1,.9],routes});
 assert.ok(p['Well|water|Production'].every(e=>e.travel_seconds===0));
});
test('workers sharing fewer buildings cannot be turned into dedicated workplaces',()=>{
 assert.equal(splitProductionSites({...step,facility_count:2,busy_units:1.8},routes.map(r=>({...r,job_rate:.0006,jobs:[['',.6]]}))),null);
});
