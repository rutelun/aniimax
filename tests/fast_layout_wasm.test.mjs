import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {HOMELAND_PLOTS,storageUnitLimit} from '../web/facility-config.js';
import {createInsideTest,layoutDeliveryCost} from '../web/layout.js';
import {encodeRefinement,refineFastLayout,polishFastLayout} from '../web/fast-layout.js';
import {updatePowerConnections} from '../web/power-layout.js';
const wasmRoot=process.env.LAYOUT_WASM_ROOT || '../web/pkg/';
const wasmPath=new URL(`${wasmRoot}aniimax_bg.wasm`,import.meta.url);
const available=fs.existsSync(wasmPath);
const {initSync,refine_layout}=available?await import(new URL(`${wasmRoot}aniimax.js`,import.meta.url)):{};
if(available)initSync({module:fs.readFileSync(wasmPath)});
const wasmTest=(name,fn)=>test(name,{skip:available?false:'Build target/fast-wasm with scripts/build-fast-wasm.ps1 first'},fn);
const refine=input=>JSON.parse(refine_layout(JSON.stringify(input)));
const overlap=(a,b)=>a[0]<b[0]+b[2]&&b[0]<a[0]+a[2]&&a[1]<b[1]+b[3]&&b[1]<a[1]+a[3];

wasmTest('fast search scores cross-storage approach legs and exact acceptance preserves route quality',()=>{
 const layout={pieces:[{members:[{x:2,y:0,w:2,h:2,weight:1}]},{members:[{x:32,y:0,w:2,h:2,weight:1}]}],
   storages:[{x:0,y:0,w:2,h:2},{x:30,y:0,w:2,h:2}],power:{poles:[],disconnected:0},unplaced:[]};
 const cells=[{x:0,y:0,w:40,h:10}];
 const input=encodeRefinement(layout,cells,{iterations:10000,polish_passes:0});
 assert.deepEqual(input.rectangles[0].arrival_weights,[.5,.5]);
 const out=refine(input);assert.equal(out.initial_cost,18);
 const accepted=refineFastLayout(layout,cells,refine_layout,{iterations:10000,polish_passes:0});
 assert.ok(layoutDeliveryCost(accepted)<layoutDeliveryCost(layout));
});

test('search temperature ignores heavy production already at its geometric distance floor',()=>{
 const layout={pieces:[{members:[{x:2,y:0,w:2,h:2,weight:30},{x:8,y:0,w:2,h:2,weight:2}]}],storages:[{x:0,y:0,w:2,h:2}],power:{poles:[]}};
 assert.equal(encodeRefinement(layout,[{x:0,y:0,w:12,h:4}]).temperature,1);
 layout.pieces[0].members[0].x=8;layout.pieces[0].members[1].x=2;
 assert.equal(encodeRefinement(layout,[{x:0,y:0,w:12,h:4}]).temperature,10);
});

wasmTest('deterministic polishing reaches the narrow-bay optimum without random steps',()=>{
 const out=refine({rectangles:[{x:6,y:0,w:2,h:2,weight:1,movable:true},{x:0,y:0,w:2,h:2}],producer_count:1,store_count:1,cells:[{x:0,y:0,w:8,h:2}],iterations:0,polish_passes:2});
 assert.equal(out.cost,2);assert.ok(!overlap(...out.poses));
});

wasmTest('joint exchange moves both blockers to free the nearest production bay',()=>{
 const out=refine({rectangles:[
  {x:6,y:0,w:4,h:4,weight:10,movable:true},
  {x:2,y:0,w:2,h:2,weight:.01,movable:true},
  {x:2,y:2,w:2,h:2,weight:.01,movable:true},
  {x:0,y:0,w:2,h:2}],producer_count:3,store_count:1,cells:[{x:0,y:0,w:12,h:4}],iterations:0,exchange_trials:12});
 assert.equal(out.poses[0][0],2);
 out.poses.forEach((r,i)=>assert.ok(out.poses.slice(i+1).every(q=>!overlap(r,q))));
});

wasmTest('WASM reaches the proven narrow-bay optimum',()=>{
 const out=refine({rectangles:[{x:6,y:0,w:2,h:2,weight:1,movable:true},{x:0,y:0,w:2,h:2}],producer_count:1,store_count:1,cells:[{x:0,y:0,w:8,h:2}],iterations:50000,temperature:.5});
 assert.equal(out.cost,2);assert.ok(!overlap(...out.poses));
});
wasmTest('WASM rejects invalid geometry and preserves a layout without storage',()=>{
 const input={rectangles:[{x:0,y:0,w:2,h:2,weight:1}],producer_count:1,store_count:0,cells:[{x:0,y:0,w:8,h:8}]};
 assert.deepEqual(refine(input).poses,[[0,0,2,2]]);
 input.rectangles[0].w=-2;assert.throws(()=>refine(input));
});




wasmTest('paired climate zones, sensitive crops and a moving power network remain valid',()=>{
 const layout={unplaced:[],pieces:[
   {cluster:true,buildings:[{},{}],members:[
     {x:8,y:8,w:1,h:1},{x:11,y:8,w:1,h:1},
     {x:4,y:8,w:2,h:2,zone:0,weight:2},
     {x:9,y:10,w:2,h:2,zone:1,weight:3},
     {x:14,y:8,w:2,h:2,zone:2,weight:1}]},
   {members:[{x:20,y:20,w:2,h:2,sensitive:true,weight:1}]},
   {members:[{x:20,y:2,w:2,h:2,generator:true}]},
   {members:[{x:22,y:5,w:2,h:2,electric_level:1,weight:2}]},
 ],storages:[{x:19,y:9,w:2,h:2}],power:{poles:[{x:25,y:2,w:1.5,h:1.5,pole:true}]}};
 updatePowerConnections(layout);const before=structuredClone(layout);
 const out=refineFastLayout(layout,[{x:0,y:0,w:30,h:30}],refine_layout,{iterations:400000,polish_passes:2,unequal_swaps:true,exchange_trials:12});
 assert.deepEqual(layout,before,'adapter must not mutate its input');
 assert.equal(out.power.disconnected,0);
 const group=out.pieces[0].members;
 assert.equal(group[1].x-group[0].x,3);assert.equal(group[1].y-group[0].y,0);
 const zones=group.slice(0,2).map(r=>[r.x+r.w/2-4.5,r.y+r.h/2-4.5,9,9]);
 for(const r of group.slice(2)) {
   const hits=zones.map(z=>overlap([r.x,r.y,r.w,r.h],z));
   assert.deepEqual(hits,[[true,false],[true,true],[false,true]][r.zone]);
 }
 const r=out.pieces[1].members[0];assert.ok(zones.every(z=>!overlap([r.x,r.y,r.w,r.h],z)));
 const all=[...out.pieces.flatMap(p=>p.members),...out.storages,...out.power.poles].map(r=>[r.x,r.y,r.w,r.h]);
 all.forEach((r,i)=>assert.ok(all.slice(i+1).every(q=>!overlap(r,q))));
});

// Geometry regression matrix, not a production-quality benchmark: these use
// real RV land unlocks and storage caps with synthetic production workloads.
for(let rv=1;rv<=22;rv++)for(const skew of [false,true])for(const polish of [0,2])wasmTest(`RV ${rv}, ${skew?'concentrated':'mixed'}, polish passes ${polish}: feasible without regression`,()=>{
 const cells=HOMELAND_PLOTS.flatMap((row,y)=>row.flatMap((level,x)=>level<=rv?[{x:x*20,y:y*15,w:20,h:15}]:[]));
 const slots=cells.flatMap(c=>Array.from({length:12},(_,i)=>({x:c.x+1+(i%4)*4,y:c.y+1+Math.floor(i/4)*4,w:2,h:2})));
 const count=Math.min(rv*4,slots.length-storageUnitLimit(rv)),stores=storageUnitLimit(rv);
 const rectangles=slots.slice(0,count).map((r,i)=>({...r,w:r.w+(i%3)*.25,h:r.h+(i%2)*.25,weight:skew?(i%7?1:20):1+i%5,movable:true}));
 rectangles.push(...slots.slice(count,count+stores));
 if(polish)rectangles.slice(0,count).forEach(r=>r.arrival_weights=Array(stores).fill(1/stores));
 const input={rectangles,producer_count:count,store_count:stores,cells,iterations:20000,seed:rv,polish_passes:polish,unequal_swaps:polish>0,exchange_trials:polish?6:0};
 const out=refine(input),inside=createInsideTest(cells);
 assert.ok(out.cost<=out.initial_cost+1e-8);
 out.poses.forEach(([x,y,w,h],i)=>{
   assert.ok(inside({x,y,w,h}));assert.ok(out.poses.slice(i+1).every(b=>!overlap(out.poses[i],b)));
 });
 assert.deepEqual(refine(input),out,'deterministic on repeated inputs');
});

wasmTest('polishing rejects excessive pass counts',()=>{
 const input={rectangles:[{x:0,y:0,w:2,h:2,weight:1}],producer_count:1,store_count:0,cells:[{x:0,y:0,w:8,h:8}],polish_passes:17};
 assert.throws(()=>refine(input));
});

wasmTest('provisional polishFastLayout preserves feasibility and does not regress delivery cost',()=>{
 const layout={pieces:[{members:[{x:2,y:0,w:2,h:2,weight:1}]},{members:[{x:32,y:0,w:2,h:2,weight:4}]}],
   storages:[{x:0,y:0,w:2,h:2},{x:30,y:0,w:2,h:2}],power:{poles:[],disconnected:0},unplaced:[]};
 const cells=[{x:0,y:0,w:40,h:10}];
 const broad=refineFastLayout(layout,cells,refine_layout,{iterations:20000});
 const polished=polishFastLayout(broad,layout,cells,refine_layout,true);
 assert.ok(layoutDeliveryCost(polished)<=layoutDeliveryCost(broad)+1e-8);
 assert.equal(polished.power.disconnected,0);
});
