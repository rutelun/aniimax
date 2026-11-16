import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {HOMELAND_PLOTS,storageUnitLimit} from '../web/facility-config.js';
import {createInsideTest} from '../web/layout.js';
import {refineFastLayout} from '../web/fast-layout.js';
import {updatePowerConnections} from '../web/power-layout.js';
const wasmPath=new URL('../target/fast-wasm/aniimax_bg.wasm',import.meta.url);
const available=fs.existsSync(wasmPath);
const {initSync,refine_layout}=available?await import('../target/fast-wasm/aniimax.js'):{};
if(available)initSync({module:fs.readFileSync(wasmPath)});
const wasmTest=(name,fn)=>test(name,{skip:available?false:'Build target/fast-wasm with scripts/build-fast-wasm.ps1 first'},fn);
const refine=input=>JSON.parse(refine_layout(JSON.stringify(input)));
const overlap=(a,b)=>a[0]<b[0]+b[2]&&b[0]<a[0]+a[2]&&a[1]<b[1]+b[3]&&b[1]<a[1]+a[3];

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
 const out=refineFastLayout(layout,[{x:0,y:0,w:30,h:30}],refine_layout,{iterations:400000});
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
for(let rv=1;rv<=20;rv++)for(const skew of [false,true])wasmTest(`RV ${rv}, ${skew?'concentrated':'mixed'} workload stays feasible and never regresses`,()=>{
 const cells=HOMELAND_PLOTS.flatMap((row,y)=>row.flatMap((level,x)=>level<=rv?[{x:x*20,y:y*15,w:20,h:15}]:[]));
 const slots=cells.flatMap(c=>Array.from({length:12},(_,i)=>({x:c.x+1+(i%4)*4,y:c.y+1+Math.floor(i/4)*4,w:2,h:2})));
 const count=Math.min(rv*4,slots.length-storageUnitLimit(rv)),stores=storageUnitLimit(rv);
 const rectangles=slots.slice(0,count).map((r,i)=>({...r,weight:skew?(i%7?1:20):1+i%5,movable:true}));
 rectangles.push(...slots.slice(count,count+stores));
 const input={rectangles,producer_count:count,store_count:stores,cells,iterations:20000,seed:rv};
 const out=refine(input),inside=createInsideTest(cells);
 assert.ok(out.cost<=out.initial_cost+1e-8);
 out.poses.forEach(([x,y,w,h],i)=>{
   assert.ok(inside({x,y,w,h}));assert.ok(out.poses.slice(i+1).every(b=>!overlap(out.poses[i],b)));
 });
 assert.deepEqual(refine(input),out,'deterministic on repeated inputs');
});
