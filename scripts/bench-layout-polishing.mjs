import fs from 'node:fs';
import {initSync,refine_layout} from '../target/fast-wasm/aniimax.js';
import {fastLayoutSeed,refineFastLayout,polishFastLayout} from '../web/fast-layout.js';
import {layoutDeliveryCost} from '../web/layout.js';
initSync({module:fs.readFileSync('target/fast-wasm/aniimax_bg.wasm')});
const rows=[];
for(const path of process.argv.slice(2)){
 const input=JSON.parse(fs.readFileSync(path)),t=performance.now();
 const seed=fastLayoutSeed(input),seedMs=performance.now()-t;
 const broad=refineFastLayout(seed,input.cells,refine_layout),broadMs=performance.now()-t;
 const polished=polishFastLayout(broad,seed,input.cells,refine_layout);
 const row={path,seedMs,broadMs,totalMs:performance.now()-t,before:layoutDeliveryCost(broad),after:layoutDeliveryCost(polished),unplaced:polished.unplaced.length,disconnected:polished.power?.disconnected};
 rows.push(row);console.log(JSON.stringify(row));
 fs.writeFileSync(path+'.polished.json',JSON.stringify(polished));
 fs.writeFileSync('target/polishing-benchmark.json',JSON.stringify(rows,null,2));
}
