import test from 'node:test';
import assert from 'node:assert/strict';
import { parkIdleBuildings, isIdlePiece } from '../web/idle-layout.js';
import { layoutDeliveryCost, createInsideTest } from '../web/layout.js';
test('idle classification excludes active infrastructure and zero-haul working buildings',()=>{
    const piece=extra=>({members:[{facility:'Chimney Kiln',w:2,h:2,weight:0,crop:null,load:0,...extra}]});
    assert.ok(isIdlePiece(piece({})));
    for(const extra of [{generator:true},{load:.1},{crop:'ore'},{electric_level:2},{crew:{}},{workers:[1]}])assert.equal(isIdlePiece(piece(extra)),false);
    assert.equal(isIdlePiece({cluster:true,...piece({})}),false);
});
test('idle buildings form a corner block without moving production or changing income distance',()=>{
    const layout={pieces:[{members:[{x:12,y:12,w:2,h:2,weight:4,facility:'Mine',crop:'ore'}]},
        ...[5,15,22].map(x=>({members:[{x,y:5,w:2,h:2,weight:0,crop:null,load:0,facility:'Crafting Table'}]}))],
        storages:[{x:10,y:12,w:2,h:2}],unplaced:[],power:{poles:[],disconnected:0}};
    const out=parkIdleBuildings(layout,[{x:0,y:0,w:30,h:30}]);
    assert.equal(layoutDeliveryCost(out),layoutDeliveryCost(layout));
    assert.deepEqual(out.pieces[0],layout.pieces[0]);
    assert.equal(out.idleArea.indices.length,3);
    assert.ok(createInsideTest([{x:0,y:0,w:30,h:30}])(out.idleArea.bounds));
    assert.ok(out.idleArea.bounds.x===0||out.idleArea.bounds.y===0||out.idleArea.bounds.x+out.idleArea.bounds.w===30||out.idleArea.bounds.y+out.idleArea.bounds.h===30);
});
