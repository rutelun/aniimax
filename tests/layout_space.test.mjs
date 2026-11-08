import test from 'node:test';
import assert from 'node:assert/strict';
import {createInsideTest,cacheGridDistance,layOut} from '../web/layout.js';

const intersection=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))
    *Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
const original=(cells,r)=>cells.reduce((sum,c)=>sum+intersection(r,c),0)>=r.w*r.h-1e-6;

test('summed-area containment matches area intersections across borders, holes and quarter-tile sizes',()=>{
    for(const cells of [
        [{x:-2,y:-1,w:4,h:2},{x:-2,y:1,w:2,h:2}],
        [{x:0,y:0,w:2,h:3},{x:2,y:0,w:2,h:3}],
    ]){
        const inside=createInsideTest(cells);
        for(let x=-2.5;x<=4.5;x+=.25)for(let y=-1.5;y<=3.5;y+=.25)
            for(const w of [.25,1,2,3])for(const h of [.5,1.5,2]){
                const r={x,y,w,h};
                assert.equal(inside(r),original(cells,r),JSON.stringify({cells,r}));
            }
    }
});

test('non-grid and overlapping cells retain the original geometry check',()=>{
    for(const cells of [[],[{x:.1,y:.1,w:2.2,h:3.3}],[{x:0,y:0,w:2,h:2},{x:0,y:0,w:2,h:2}]]){
        const inside=createInsideTest(cells);
        for(const r of [{x:0,y:0,w:4,h:2},{x:.15,y:.25,w:.3,h:.5},{x:1,y:1,w:1,h:1},{x:20,y:20,w:0,h:1}])
            assert.equal(inside(r),original(cells,r));
    }
    assert.equal(createInsideTest(null)({x:-1e6,y:1e6,w:3,h:4}),true);
    const huge=[{x:1e16,y:0,w:20,h:20}],tiny={x:1e16,y:0,w:.25,h:.25};
    assert.equal(createInsideTest(huge)(tiny),original(huge,tiny),'unsafe grid coordinates must retain floating-point area semantics');
});

test('distance caching is exact and caches zero while falling back outside its grid',()=>{
    let calls=0;
    const distance=(x,y)=>{calls++;return Math.hypot(x,y);};
    const cached=cacheGridDistance({x:-4,y:-3,x2:5,y2:6},distance);
    assert.equal(cached(0,0),0); assert.equal(cached(0,0),0); assert.equal(calls,1);
    for(const [x,y] of [[-4,-3],[5,6],[.25,1.5],[.1,.2],[200,-300]]){
        assert.equal(cached(x,y),Math.hypot(x,y));
        assert.equal(cached(x,y),Math.hypot(x,y));
    }
});

test('single-building probes produce exactly the reference arrangement with worker routes and constraints',()=>{
    const pieces=Array.from({length:14},(_,i)=>({members:[{x:0,y:0,w:i%2?2.5:3,h:i%3?2:3.5,weight:i%4?i:0,
        workers:i%2?[[0,1+i/10],[1,2]]:undefined,sensitive:i%3===0}]}));
    pieces.unshift({cluster:true,buildings:[{x:0,y:0,w:1,h:1}],plots:[{w:2,h:2,weight:4,zone:0}],planned:[{x:1,y:0}]});
    const options={cells:[{x:-20,y:-10,w:20,h:20},{x:0,y:-10,w:20,h:20}],
        storages:[{x:-5,y:-1,w:2,h:2},{x:5,y:1,w:2,h:2}],passes:2,
        canPlace:(i,metadata,rectangles)=>i%4!==1||rectangles[0].y>=-5};
    assert.deepEqual(layOut(pieces,options),layOut(pieces,{...options,singleBuildingFastPath:false}));
});
