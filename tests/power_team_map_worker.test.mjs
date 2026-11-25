import assert from 'node:assert/strict';
import test from 'node:test';

let response;
globalThis.self={postMessage:data=>{response=data;}};
await import('../web/power-team-map-worker.js');

test('a reused map must improve the measured team and power every scheduled consumer',()=>{
    const place=(m,x)=>({members:[{...m,x,y:2}]});
    const generator={facility:'Crackle Generator',generator:true,generatedWatts:600,w:2,h:2};
    const mine={facility:'Mine',crop:'ore',electric_level:2,load:1,w:2,h:2};
    const baseLayout={pieces:[place(generator,1),place(mine,4)],unplaced:[],storages:[],power:{poles:[]}};
    const candidate={index:2,plan:{coin_items:[],power_generators:1},pieces:[generator,mine].map(m=>({members:[m]})),
        jobs:[{ability:'Lightning',level:1,fixed:true,busy:1,label:'Generator'}]};
    const data={baseLayout,candidates:[candidate],cells:[{x:0,y:0,w:12,h:8}],poleLimit:0,recipes:[],
        facilities:{},limit:8,haulingBound:1,baselineScore:{people:1,generators:0,networks:0}};
    self.onmessage({data});
    assert.deepEqual(response.winner?.score,{distractions:0,cropWorkshopDistractions:0,people:1,generators:1,networks:1,manualWork:0});
    assert.equal(response.winner.layout.power.disconnected,0);
    self.onmessage({data:{...data,baselineScore:response.winner.score}});
    assert.equal(response.winner,null);
});
