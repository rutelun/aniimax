import fs from 'node:fs';
import {initSync,refine_layout} from '../target/fast-wasm/aniimax.js';
import {refineFastLayout} from '../web/fast-layout.js';
import {layoutDeliveryCost,improveFixedStorage,refineDistrictDeliveries,createInsideTest} from '../web/layout.js';
initSync({module:fs.readFileSync('target/fast-wasm/aniimax_bg.wasm')});
const input=JSON.parse(fs.readFileSync(process.argv[2])),initial=JSON.parse(fs.readFileSync(process.argv[3]));
for(const run of (process.argv.includes('--temperatures')?[2,4,8,12,20,30].map(temperature=>({seed:1,temperature})):[1,2,3,4,5,6,7,8].map(seed=>({seed,temperature:1})))){
 const {seed,temperature}=run;
 const t=performance.now();let out=refineFastLayout(initial,input.cells,refine_layout,{iterations:2500000,seed,temperature});
 const before=layoutDeliveryCost(out),inside=createInsideTest(input.cells),x=Math.min(...input.cells.map(c=>c.x)),y=Math.min(...input.cells.map(c=>c.y));
 const bounds={x,y,w:Math.max(...input.cells.map(c=>c.x+c.w))-x,h:Math.max(...input.cells.map(c=>c.y+c.h))-y};
 out=refineDistrictDeliveries(out,[{bounds,reserved:[]}],{passes:1,includeMines:true,costOf:layoutDeliveryCost,canPlace:(_,__,rs)=>rs.every(inside)});
 out=improveFixedStorage(out,input.cells,0);
 console.log(JSON.stringify({seed,temperature,before,cost:layoutDeliveryCost(out),ms:performance.now()-t}));
}
