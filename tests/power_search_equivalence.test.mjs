import test from 'node:test';
import assert from 'node:assert/strict';
import {connectPower} from '../web/power-layout.js';
import {createInsideTest} from '../web/layout.js';

test('pruned generator search retains exhaustive best placement for different land sizes and restrictions', () => {
    for(let size=1;size<=20;size++) {
        const cells=Array.from({length:size},(_,i)=>({x:(i%4)*10,y:Math.floor(i/4)*10,w:10,h:10}));
        const generator={x:0,y:0,w:2,h:2,generator:true};
        const consumers=Array.from({length:Math.min(size+1,12)},(_,i)=>({
            x:(i%4)*10+4,y:Math.floor(i/4)*10+4,w:2,h:2,electric_level:3,
        })).filter(createInsideTest(cells));
        const stores=[{x:2,y:2,w:2,h:2}];
        const allow=(_,r)=>r.x>=1&&r.y%1===0;
        const inside=createInsideTest(cells);
        let best=null;
        for(const c of cells)for(let y=c.y;y<c.y+c.h;y+=.5)for(let x=c.x;x<c.x+c.w;x+=.5){
            const r={x,y,w:2,h:2};
            if(!allow(generator,r)||!inside(r)||[...consumers,...stores].some(o=>
                r.x<o.x+o.w&&o.x<r.x+r.w&&r.y<o.y+o.h&&o.y<r.y+r.h))continue;
            const cost=consumers.reduce((s,o)=>s+(x+1-o.x-o.w/2)**2+(y+1-o.y-o.h/2)**2,0);
            if(!best||cost<best.cost)best={x,y,cost};
        }
        const result=connectPower({pieces:[{members:[generator,...consumers]}],storages:stores},cells,0,false,allow);
        assert.deepEqual({x:generator.x,y:generator.y},{x:best.x,y:best.y},`land size ${size}`);
        assert.equal(result.power.poles.length,0);
    }
});
