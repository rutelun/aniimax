// Run the actual worker, not a simplified surrogate. Pass one or more captured
// inputs. Optional --styles checks all layout styles; --output saves JSON.
import fs from 'node:fs';
import {layoutDeliveryCost,layoutTravelCost} from '../web/layout.js';
const originalFetch=globalThis.fetch;
globalThis.fetch=(url,options)=>String(url).startsWith('file:')
    ?Promise.resolve(new Response(fs.readFileSync(new URL(url)),{headers:{'Content-Type':'application/wasm'}}))
    :originalFetch(url,options);
const args=process.argv.slice(2), allStyles=args.includes('--styles');
const oi=args.indexOf('--output'), output=oi>=0?args[oi+1]:null;
const paths=args.filter((a,i)=>a!=='--styles'&&i!==oi&&(oi<0||i!==oi+1));
if(!paths.length)throw new Error('Provide at least one captured layout input JSON');
let result;
globalThis.self={postMessage:value=>{result=value;}};
await import('../web/layout-worker.js');
const rows=[];
for(const path of paths){
    const input=JSON.parse(fs.readFileSync(path,'utf8'));
    for(const style of allStyles?['delivery','groups']:['delivery']){
        result=null;
        const start=performance.now();
        await self.onmessage({data:structuredClone({...input,style})});
        const row={input:path,style,ms:performance.now()-start,deliveryCost:layoutDeliveryCost(result),
            travelCost:layoutTravelCost(result),unplaced:result.unplaced.length,disconnected:result.power?.disconnected??0,
            storages:result.storages.length,poles:result.power?.poles.length??0,fallback:result.groupFallback??null};
        rows.push(row);console.log(JSON.stringify(row));
        if(output)fs.writeFileSync(output,JSON.stringify(rows,null,2));
    }
}
