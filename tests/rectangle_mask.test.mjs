import assert from 'node:assert/strict';
import test from 'node:test';
import {rectangleMask} from '../web/rectangle-mask.js';

test('quarter-tile occupancy agrees with rectangle intersections across word and row boundaries', () => {
    const mask = rectangleMask([{x:-5,y:-2,w:38,h:9}]);
    const obstacles = [{x:2.75,y:0,w:8.75,h:2}, {x:11.5,y:1,w:10,h:1.75}, {x:30,y:4.25,w:.25,h:.5}];
    for (const r of obstacles) mask.add(r);
    for (const w of [.25, 1, 8, 20]) {
        for (let x=-5;x+w<=33;x+=.25) for (let y=-2;y+1<=7;y+=.5) {
            const r={x,y,w,h:1};
            const expected=obstacles.some(o=>r.x<o.x+o.w && r.x+r.w>o.x && r.y<o.y+o.h && r.y+r.h>o.y);
            assert.equal(mask.overlaps(r),expected);
        }
    }
    assert.equal(mask.overlaps({x:.1,y:0,w:1,h:1}),undefined);
    mask.add({x:.1,y:0,w:1,h:1});
    assert.equal(mask.overlaps({x:0,y:0,w:1,h:1}),undefined);
});
