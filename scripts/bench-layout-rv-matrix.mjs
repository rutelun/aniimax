// Real RV land/inventory limits, synthetic activity patterns. Deliberately
// separate from captured production-plan benchmarks: neither replaces the other.
import fs from 'node:fs';
import {initSync,refine_layout} from '../target/fast-wasm/aniimax.js';
import {simpleSetup,FACILITY_FOOTPRINTS,HOMELAND_PLOTS,storageUnitLimit,powerPoleLimit,generatorLimit} from '../web/facility-config.js';
import {fastLayoutSeed,refineFastLayout} from '../web/fast-layout.js';
import {layoutDeliveryCost} from '../web/layout.js';
initSync({module:fs.readFileSync('target/fast-wasm/aniimax_bg.wasm')});
const results=[];
for(const rv of (process.argv.includes('--polish')?[6,15,20]:[3,6,9,12,15,18,20]))for(const pattern of ['mixed','trees']) {
 const cells=HOMELAND_PLOTS.flatMap((row,y)=>row.flatMap((v,x)=>v<=rv?[{x:x*20,y:y*15,w:20,h:15}]:[]));
 const setup=simpleSetup(rv),pieces=[];
 for(const [facility,tiers] of Object.entries(setup.facilities)) {
   const size=FACILITY_FOOTPRINTS[facility];if(!size)continue;
   for(let i=0;i<tiers.reduce((sum,t)=>sum+t.count,0);i++){
     const environment=['Heat Furnace','Cooling Unit','Sunlamp'].includes(facility);
     pieces.push({members:[{x:0,y:0,w:size[0],h:size[1],facility,weight:environment?0:pattern==='trees'?(facility==='Woodland'?12:.2):1+i%3,
       ...(generatorLimit(rv)&&facility==='Mine'?{electric_level:1}:{})}]});
   }
 }
 for(let i=0;i<generatorLimit(rv);i++)pieces.push({members:[{x:0,y:0,w:2,h:2,facility:'Crackle Generator',weight:0,generator:true}]});
 const input={pieces,cells,storageCount:storageUnitLimit(rv),poleLimit:powerPoleLimit(rv)};
 const start=performance.now(),seed=fastLayoutSeed(input),seedMs=performance.now()-start;
 fs.writeFileSync(`target/rv-${rv}-${pattern}-input.json`,JSON.stringify(input));
 fs.writeFileSync(`target/rv-${rv}-${pattern}-seed.json`,JSON.stringify(seed));
 if(process.argv.includes('--generate'))continue;
 const t=performance.now();let fast=refineFastLayout(seed,cells,refine_layout);
 if(process.argv.includes('--polish'))fast=refineFastLayout(fast,cells,refine_layout,{iterations:1500000,temperature:.3,seed:2});
 const fastMs=performance.now()-t;
 const reference=refineFastLayout(seed,cells,refine_layout,{iterations:16000000});
 const row={rv,pattern,members:pieces.length,seedMs,fastMs,totalMs:seedMs+fastMs,cost:layoutDeliveryCost(fast),reference:layoutDeliveryCost(reference),unplaced:fast.unplaced.length,disconnected:fast.power.disconnected};
 results.push(row);console.log(JSON.stringify(row));
 fs.writeFileSync('target/fast-layout-rv-matrix.json',JSON.stringify(results,null,2));
}
