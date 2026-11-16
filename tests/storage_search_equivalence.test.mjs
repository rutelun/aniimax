import test from 'node:test';
import assert from 'node:assert/strict';
import {improveFixedStorage} from '../web/layout.js';
const hits=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
const cost=(members,stores)=>members.reduce((sum,m)=>sum+(m.weight||0)*Math.min(...stores.map(s=>Math.hypot(m.x+m.w/2-s.x-s.w/2,m.y+m.h/2-s.y-s.h/2))),0);
test('cached storage sites and partial-score pruning preserve exhaustive placement',()=>{
 for(let size=1;size<=12;size++){
  const cells=[{x:0,y:0,w:12+size,h:12}];
  const members=Array.from({length:4},(_,i)=>({x:2+i*3,y:5+i%2*3,w:2,h:2,weight:(i+1)*size/7}));
  const poles=[{x:4,y:1,w:1.5,h:1.5}];
  const stores=[{x:0,y:0,w:2,h:2},{x:10,y:0,w:2,h:2}];
  const expected=structuredClone(stores);
  for(let i=0;i<expected.length;i++){
   const others=expected.filter((_,j)=>i!==j);let best=null;
   for(let x=0;x<=cells[0].w-2;x++)for(let y=0;y<=10;y++){
    const r={x,y,w:2,h:2};if([...members,...poles,...others].some(o=>hits(r,o)))continue;
    const score=cost(members,[...others,r]);
    if(!best||score<best.cost-1e-6)best={r,cost:score};
   }
   if(best&&best.cost<cost(members,expected)-1e-6)expected[i]=best.r;
  }
  const result=improveFixedStorage({pieces:members.map(m=>({members:[m]})),storages:stores,unplaced:[],power:{poles,disconnected:0}},cells,0);
  assert.deepEqual(result.storages,expected,`size ${size}`);
 }
});
