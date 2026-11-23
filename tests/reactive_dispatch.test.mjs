import test from 'node:test';
import assert from 'node:assert/strict';
import {measureLayoutDispatch,measureRosterDispatch,buildReactiveDispatch,permanentWorkers,measuredDispatchWork,attachDeliveryFlows} from '../web/reactive-dispatch.js';

const layout={pieces:[{members:[{facility:'Chimney Kiln',crop:'ore',x:0,y:0,w:2,h:2,weight:1},
    {facility:'Farmland',crop:'crop',x:20,y:0,w:2,h:2,weight:1,stockLimit:40}]}],storages:[{x:24,y:0,w:2,h:2}]};
const recipes=[{name:'ore',facility:'Chimney Kiln',aniimo:['Fire',2]},
    {name:'crop',facility:'Farmland',jobs:[['Reaping','Dark',1]],yieldAmount:10}];
const members=[{count:2,abilities:{Fire:3,Dark:4,Hauling:3}},{count:1,abilities:{Dark:3}}];
const routes=[{member:0,facility:'Chimney Kiln',item:'ore',job_rate:.1},
    {member:1,facility:'Farmland',item:'crop',job_rate:.1}];

test('map scoring preserves measured work and delivery with unpriced jobs in the same worker pool',()=>{
    const assignments=[{...routes[0],jobs:[['',1]],visits:.1,walking:.02},
        {...routes[1],jobs:[['Reaping',1]],visits:.25,walking:.05}];
    const plan={roster_routes:assignments,coin_items:[
        {facility:'Farmland',item_name:'crop',status:'producing',cycle_time:10,busy_units:1},
        {facility:'Chimney Kiln',item_name:'ore',status:'idle',cycle_time:20,busy_units:0},
    ]};
    const context={layout,recipes,members,routes:assignments,busy:[1.8,.5]};
    const full=buildReactiveDispatch(context);
    const measured=measureLayoutDispatch(context,plan);
    assert.ok(full['Chimney Kiln|ore|Hauling'][0].travel_seconds>0);
    const expected=measuredDispatchWork(plan,full,recipes);
    assert.equal(expected.walking.length,2);
    assert.ok(expected.delivery.length>0);
    assert.deepEqual(measured,expected);
});

test('previous work origins follow actual production rates, not number of matching buildings',()=>{
 const m={pieces:[{members:[9,1,0].map(rate=>({facility:'Chimney Kiln',jobs:[{item:'ore',rate}]}))}]};
 attachDeliveryFlows(m,{},recipes,members,[{member:0,facility:'Chimney Kiln',item:'ore',job_rate:10}]);
 assert.deepEqual(m.pieces[0].members.map(s=>s.deliveryOrigins),[[[0,32400]],[[0,3600]],[]]);
});

test('a fully occupied specialist retains its own work instead of becoming ineligible',()=>{
    const team=[{count:1,abilities:{Fire:4}},{count:1,abilities:{Fire:2}}];
    const actual=[{member:0,facility:'Chimney Kiln',item:'ore',job_rate:.1,jobs:[['',1]],walking:0}];
    const p=buildReactiveDispatch({layout,recipes,members:team,routes:actual,busy:[1,0]});
    assert.deepEqual(p['Chimney Kiln|ore|Production'].map(e=>[e.member,e.share]),[[0,1]]);
});

test('a processor uses the expected batch time of the workers available when the next batch can start',()=>{
    const recipe={name:'flour',facility:'Carousel Mill',ingredients:['wheat'],aniimo:['Wind',3]};
    const members=[{count:1,abilities:{Wind:3}},{count:3,abilities:{Wind:4}},
        {count:1,abilities:{Wind:4}},{count:1,abilities:{Wind:3}}];
    const routes=[{member:0,facility:recipe.facility,item:recipe.name,job_rate:.006,jobs:[['',.486]]}];
    const context={layout:{pieces:[{members:[{x:0,y:0,w:2,h:2,facility:recipe.facility,crop:recipe.name,weight:1}]}],storages:[]},
        recipes:[recipe],members,routes,busy:[.486,.5,1,0],permanent:[0,0,1,0]};
    const key='Carousel Mill|flour|Production', entries=buildReactiveDispatch(context)[key];
    // One deployed Wind 4 spends half its time elsewhere. Its other copies, a
    // permanent operator, and an undeployed worker cannot claim this wheat.
    assert.deepEqual(entries.map(e=>[e.member,e.share]),[[0,2/3],[1,1/3]]);
    assert.equal(entries.reduce((total,e)=>total+e.share*[81,27][e.member],0),63);
    context.busy[1]=1;
    assert.deepEqual(buildReactiveDispatch(context)[key].map(e=>[e.member,e.share]),[[0,1]]);
});

test('only the fraction blocked by other work can be captured, conserving task demand',()=>{
    const team=[{count:1,abilities:{Fire:4}},{count:1,abilities:{Fire:2}}];
    const actual=[{member:0,facility:'Chimney Kiln',item:'ore',job_rate:.1,jobs:[['',.6]],walking:0}];
    const p=buildReactiveDispatch({layout,recipes,members:team,routes:actual,busy:[1,0]});
    const shares=p['Chimney Kiln|ore|Production'];
    assert.ok(Math.abs(shares.find(e=>e.member===0).share-.6)<1e-9);
    assert.ok(Math.abs(shares.find(e=>e.member===1).share-.4)<1e-9);
});

test('unexpected crop pickup conserves requests and starts at previous production site',()=>{
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[1.8,.5],permanent:[1,0]});
    const crop=p['Farmland|crop|Dark'];
    assert.ok(crop.find(e=>e.member===0).share>0);
    assert.ok(Math.abs(crop.reduce((s,e)=>s+e.share,0)-1)<1e-12);
    assert.equal(crop.find(e=>e.member===0).travel_seconds,(360*5+1.5*1)/361.5);
    assert.equal(crop.find(e=>e.member===1).travel_seconds,0);
});
test('only permanent shifts exclude copies; no imaginary workplace reservation',()=>{
    const fixed=permanentWorkers({staffing:[['Heat Furnace',0,1.0000000000000009]],workplace_anchors:[[0,1]]},members,new Set());
    assert.deepEqual(fixed,[1,0]);
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[2,1],permanent:fixed});
    assert.ok(p['Farmland|crop|Dark'].length===2,'busy workers queue jobs instead of deleting all demand');
    const allFixed=buildReactiveDispatch({layout,recipes,members,routes,busy:[2,0],permanent:[2,0]});
    assert.deepEqual(allFixed['Farmland|crop|Dark'].map(e=>e.member),[1]);
});
test('hauling replaces depot approximation with prior task to pickup to storage and40% cargo',()=>{
    const p=buildReactiveDispatch({layout,recipes,members,routes,busy:[1.8,.5],permanent:[1,0]});
    // Two ten-item harvests reach40% of40. One trip per two batches.
    // 360 previous production completions/hour plus 1.5 completed deliveries.
    // Those deliveries end at storage, so the next approach starts there.
    assert.equal(p['Farmland|crop|Hauling'][0].travel_seconds,((360*5+1.5*1)/361.5+1)/2);
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

test('one well per worker does not invent travel between identical recipes',()=>{
 const recipe={name:'water',facility:'Well',aniimo:['Water',1]};
 const site=(x,crew)=>({x,y:0,w:2,h:2,facility:'Well',crop:'water',crew,batchWeight:60});
 const args={layout:{pieces:[{members:[site(0,0),site(20,1)]}],storages:[]},recipes:[recipe],members:[{count:1,abilities:{Water:4}},{count:1,abilities:{Water:4}}],busy:[1,1],routes:[0,1].map(member=>({member,facility:'Well',item:'water',station:null,job_rate:1/60,jobs:[['',1]],walking:0}))};
 for(const assigned of [true,false]){
   if(!assigned)args.layout.pieces[0].members.forEach(s=>s.crew=null);
   const p=buildReactiveDispatch(args);
   assert.ok(p['Well|water|Production'].every(e=>e.travel_seconds===0));
 }
});

test('unequal shares across identical wells retain real travel between sites',()=>{
 const recipe={name:'water',facility:'Well',aniimo:['Water',1]},key='Well|water|Production';
 const args={layout:{pieces:[{members:[0,20].map(x=>({x,y:0,w:2,h:2,facility:'Well',crop:'water',batchWeight:60}))}],storages:[]},recipes:[recipe],
 members:[{count:1,abilities:{Water:4}},{count:1,abilities:{Water:4}}],busy:[.9,.3],previous:{[key]:[{member:0,share:.75},{member:1,share:.25}]},
 routes:[.75,.25].map((share,member)=>({member,facility:'Well',item:'water',station:null,job_rate:share/30,jobs:[['',share]],walking:0}))};
 assert.ok(buildReactiveDispatch(args)[key].every(e=>e.travel_seconds>0));
});

test('resident Leisure work and inactive recipes cannot invent a second job for a well worker',()=>{
 const recipes=[{name:'water',facility:'Well',aniimo:['Water',1]}, {name:'other_water',facility:'Well',aniimo:['Water',1]},
 {name:'pearl',facility:'Tidewhisper Sandcastle',aniimo:['Leisure',1]}, {name:'rice',facility:'Carousel Mill',aniimo:['Artisanship',1]}];
 const p=buildReactiveDispatch({layout:{pieces:[{members:[{x:0,y:0,w:2,h:2,facility:'Well',crop:'water',batchWeight:60},
 {x:20,y:0,w:2,h:2,facility:'Tidewhisper Sandcastle',crop:'pearl',batchWeight:60},
 {x:10,y:0,w:2,h:2,facility:'Carousel Mill',crop:'rice',batchWeight:60,electric_level:3}]}],storages:[]},recipes,
 members:[{count:1,abilities:{Water:4,Leisure:4,Artisanship:4}}],busy:[1],routes:[{member:0,facility:'Well',item:'water',job_rate:1/60,jobs:[['',1]],walking:0}]});
 assert.equal(p['Tidewhisper Sandcastle|pearl|Production'],undefined);
 assert.equal(p['Well|water|Production'][0].travel_seconds,0);
});


test('a delivery reserve is priced only for real overload within the roster limit',()=>{
    const context={layout,recipes,members:[{count:1,abilities:{Fire:3,Hauling:3}}],
        busy:[1],permanent:[0],routes:[]};
    const plan={coin_items:[{facility:'Chimney Kiln',item_name:'ore',status:'producing',
        busy_units:1,cycle_time:30}]};
    const key='Chimney Kiln|ore|Hauling';
    const proposal=measureRosterDispatch(context,plan,null,2);
    assert.ok(proposal.delivery.some(([id,load])=>id===1 && load>0));
    assert.deepEqual(proposal.context.busy,[1,0]);
    assert.equal(context.members.length,1);
    assert.deepEqual(buildReactiveDispatch({...proposal.context,previous:proposal.policy})[key],proposal.policy[key]);
    for(const limit of [0,1])assert.equal(measureRosterDispatch(context,plan,null,limit).context,context);
    assert.equal(measureRosterDispatch(context,{},null,2).context,context);
    const spare={...context,busy:[0]};
    assert.equal(measureRosterDispatch(spare,plan,null,2).context,spare);
});
