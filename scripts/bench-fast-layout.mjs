import fs from 'node:fs';
import {initSync,refine_layout} from '../target/fast-wasm/aniimax.js';
import {layOutHomeland,layoutDeliveryCost,refineDistrictDeliveries,createInsideTest,improveFixedStorage} from '../web/layout.js';
import {connectPower} from '../web/power-layout.js';
import {refineFastLayout} from '../web/fast-layout.js';
initSync({module:fs.readFileSync('target/fast-wasm/aniimax_bg.wasm')});
for(const path of process.argv.slice(2)) {
 const d=JSON.parse(fs.readFileSync(path)),inside=createInsideTest(d.cells),start=performance.now();
 let layout=connectPower(layOutHomeland(d.pieces,d.cells,{w:2,h:2},d.storageCount,{fast:true,accountForWorkers:false}),d.cells,d.poleLimit);
 const x=Math.min(...d.cells.map(c=>c.x)),y=Math.min(...d.cells.map(c=>c.y));
 const bounds={x,y,w:Math.max(...d.cells.map(c=>c.x+c.w))-x,h:Math.max(...d.cells.map(c=>c.y+c.h))-y};
 layout=refineDistrictDeliveries(layout,[{bounds,reserved:[]}],{passes:1,includeMines:true,costOf:layoutDeliveryCost,canPlace:(_,__,rs)=>rs.every(inside)});
 layout=improveFixedStorage(layout,d.cells,0);
 const seeded=performance.now(),seedCost=layoutDeliveryCost(layout);
 const out=refineFastLayout(layout,d.cells,refine_layout),end=performance.now();
 console.log(JSON.stringify({path,seedMs:seeded-start,searchMs:end-seeded,totalMs:end-start,seedCost,cost:layoutDeliveryCost(out),unplaced:out.unplaced.length,disconnected:out.power.disconnected}));
 fs.writeFileSync(path.replace(/\.json$/,'.fast-layout.json'),JSON.stringify(out));
}
