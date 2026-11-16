import test from 'node:test';
import assert from 'node:assert/strict';
import {rectangleUnion} from '../web/group-outline.js';
test('concave group outlines preserve notches and omit shared internal edges',()=>{
    const shape=rectangleUnion([{x:0,y:0,w:4,h:2},{x:0,y:2,w:2,h:2}]);
    assert.ok(shape.edge.includes('M2,2V4'));
    assert.ok(!shape.edge.includes('M0,2H2'));
    assert.ok(shape.edge.includes('M2,2H4'));
    assert.deepEqual(rectangleUnion([]),{fill:'',edge:''});
});
