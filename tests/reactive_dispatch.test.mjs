import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReactiveDispatch,permanentWorkers,measuredDispatchWork} from '../web/reactive-dispatch.js';

const layout={pieces:[{members:[{facility:'Chimney Kiln',crop:'ore',x:0,y:0,w:2,h:2,weight:1},
    {facility:'Farmland',crop:'crop',x:20,y:0,w:2,h:2,weight:1,stockLimit:40}]}],storages:[{x:24,y:0,w:2,h:2}]};
const recipes=[{name:'ore',facility:'Chimney Kiln',aniimo:['Fire',2]},
    {name:'crop',facility:'Farmland',jobs:[['Reaping','Dark',1]],yieldAmount:10}];
const members=[{count:2,abilities:{Fire:3,Dark:4,Hauling:3}},{count:1,abilities:{Dark:3}}];
const routes=[{member:0,facility:'Chimney Kiln',item:'ore',job_rate:.1},
    {member:1,facility:'Farmland',item:'crop',job_rate:.1}];

test('unexpected crop pickup conserves requests and starts at previous production site',()=>{
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[1.8,.5],permanent:[1,0]});
    const crop=p['Farmland|crop|Dark'];
    assert.ok(crop.find(e=>e.member===0).share>0);
    assert.ok(Math.abs(crop.reduce((s,e)=>s+e.share,0)-1)<1e-12);
    assert.equal(crop.find(e=>e.member===0).travel_seconds,5);
    assert.equal(crop.find(e=>e.member===1).travel_seconds,0);
});
test('only permanent shifts exclude copies; no imaginary workplace reservation',()=>{
    const fixed=permanentWorkers({staffing:[['Heat Furnace',0,1]],workplace_anchors:[[0,1]]},members,new Set());
    assert.deepEqual(fixed,[1,0]);
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[2,1],permanent:fixed});
    assert.ok(p['Farmland|crop|Dark'].length===2,'busy workers queue jobs instead of deleting all demand');
    const allFixed=buildReactiveDispatch({layout,recipes,members,routes,busy:[2,0],permanent:[2,0]});
    assert.deepEqual(allFixed['Farmland|crop|Dark'].map(e=>e.member),[1]);
});
test('hauling replaces depot approximation with prior task to pickup to storage and40% cargo',()=>{
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[1.8,.5],permanent:[1,0]});
    // Two ten-item harvests reach40% of40. One trip per two batches.
    assert.equal(p['Farmland|crop|Hauling'][0].travel_seconds,(5+1)/2);
});
test('measured dispatch preserves overload and subtracts old travel rather than repeating execution',()=>{
    const p={'Farmland|crop|Dark':[{member:0,share:1,travel_seconds:10}],
        'Farmland|crop|Hauling':[{member:0,share:1,travel_seconds:2}]};
    const plan={roster_routes:[{facility:'Farmland',item:'crop',member:0,jobs:[['Reaping',.2]],visits:.2,walking:.1}],
        coin_items:[{status:'producing',facility:'Farmland',item_name:'crop',cycle_time:10,facility_count:1,busy_units:1}]};
    const result=measuredDispatchWork(plan,p,recipes);
    assert.deepEqual(result.walking,[[0,1.9]]);
    assert.deepEqual(result.delivery,[[0,.2]]);
});

test('a changed ability cannot retain a stale dispatch share or lose remaining demand',()=>{
    const previous={'Farmland|crop|Dark':[{member:0,share:.25},{member:1,share:.75}]};
    const changed=[{count:2,abilities:{Fire:3}},members[1]];
    const p=buildReactiveDispatch({layout,recipes,members:changed,previous,routes});
    assert.deepEqual(p['Farmland|crop|Dark'].map(e=>[e.member,e.share]),[[1,1]]);
});
