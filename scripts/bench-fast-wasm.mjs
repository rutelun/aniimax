import fs from 'node:fs';
import {initSync,refine_layout} from '../target/fast-wasm/aniimax.js';
import {layoutDeliveryCost} from '../web/layout.js';
import {updatePowerConnections} from '../web/power-layout.js';
initSync({module:fs.readFileSync('target/fast-wasm/aniimax_bg.wasm')});
const input=JSON.parse(fs.readFileSync('target/user-current-layout-input-lv4.json'));
const layout=JSON.parse(fs.readFileSync('target/fast-anneal-seed.json'));
const rectangles=[],climates=[];
for(const piece of layout.pieces){
  const start=rectangles.length, owner=piece.cluster?climates.length:-1;
  if(piece.cluster)climates.push(piece.buildings.map((_,j)=>start+j));
  for(const [j,r] of piece.members.entries())rectangles.push({
    x:r.x,y:r.y,w:r.w,h:r.h,weight:r.weight||0,
    owner:piece.cluster&&j>=piece.buildings.length?owner:-1,zone:r.zone||0,
    sensitive:!!r.sensitive,generator:!!r.generator,electric:r.electric_level!=null,
    movable:piece.cluster?j>=piece.buildings.length:piece.members.length===1&&!r.generator,
  });
}
const producer_count=rectangles.length;
for(const r of layout.storages)rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h});
for(const r of layout.power?.poles||[])rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h,pole:true});
const passes=process.argv.includes('--passes');
const sweep=process.argv.includes('--sweep');
const runs=sweep?[.05,.1,.25,.5,1,2,4].map(temperature=>({iterations:5000000,temperature})):(passes?[4000000,2000000,2000000,2000000]:[100000,4000000,16000000]).map(iterations=>({iterations,temperature:1}));
for(const {iterations,temperature} of runs){
  const t=performance.now();
  const result=JSON.parse(refine_layout(JSON.stringify({rectangles,climates,producer_count,
    store_count:layout.storages.length,cells:input.cells,iterations,seed:1,temperature,penalty:30,mobile_relays:true})));
  const ms=performance.now()-t, out=structuredClone(layout);
  const all=[...out.pieces.flatMap(p=>p.members),...out.storages,...out.power.poles];
  result.poses.forEach(([x,y,w,h],i)=>Object.assign(all[i],{x,y,w,h}));
  updatePowerConnections(out);
  console.log({iterations,temperature,ms,cost:result.cost,jsCost:layoutDeliveryCost(out)});
  fs.writeFileSync(`target/wasm-search-${iterations}${sweep?'-t'+temperature:''}.json`,JSON.stringify(out));
  if(passes)result.poses.forEach(([x,y,w,h],i)=>Object.assign(rectangles[i],{x,y,w,h}));
}
