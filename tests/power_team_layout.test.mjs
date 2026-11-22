import test from 'node:test';
import assert from 'node:assert/strict';
import {reusePowerTeamLayout} from '../web/power-team-layout.js';

const cells=[{x:0,y:0,w:36,h:16}];
const piece=m=>({members:[m]});
const mine=(x,crop,extra={})=>({x,y:3,w:2,h:2,facility:'Mine',crop,weight:1,...extra});
const gen=(x=0)=>({x,y:0,w:2,h:2,facility:'Crackle Generator',generator:true,generatedWatts:600});
const storage={x:6,y:0,w:2,h:2};
const layout=members=>({pieces:members.map(piece),unplaced:[],storages:[storage],storage,storageAt:{x:7,y:1},power:{poles:[]}});

test('keeps crop coordinates and storage while replacing old schedule and power metadata',()=>{
    const original=layout([mine(0,'ore',{electric_level:2,scheduleId:'before',schedulePeak:.2}),mine(26,'sand'),gen()]);
    const pieces=[piece(mine(0,'sand',{electric_level:3,schedulePeak:.8,scheduleId:'after',jobs:[{item:'sand',rate:.08,cycle:10}]})),
        piece(mine(0,'ore')),piece(gen()),piece(gen())];
    const out=reusePowerTeamLayout(original,pieces,cells,1);
    assert.ok(out);
    assert.equal(out.power.disconnected,0);
    assert.deepEqual(out.storages,original.storages);
    const [sand,ore]=out.pieces.map(p=>p.members[0]);
    assert.equal(sand.x,26);
    assert.equal(sand.scheduleId,'after');
    assert.equal(sand.jobs[0].rate,.08);
    assert.equal(ore.schedulePeak,undefined);
    assert.equal(ore.electric_level,undefined);
    assert.equal(original.pieces[0].members[0].scheduleId,'before');
    assert.equal(pieces[0].members[0].x,0);
});

test('rejects a changed inventory or incomplete source layout',()=>{
    const original=layout([mine(0,'ore')]);
    assert.equal(reusePowerTeamLayout(original,[],cells,0),null);
    assert.equal(reusePowerTeamLayout({...original,unplaced:[1]},[piece(mine(0,'ore'))],cells,0),null);
});

test('preserves rotated climate plots, group geometry and revised piece indices',()=>{
    const climate={x:0,y:0,w:1,h:1,facility:'Heat Furnace',mode:'Warm',building:true};
    const plot={w:3,h:2,facility:'Farmland',crop:'berry',zone:0,weight:1};
    const cluster={cluster:true,buildings:[climate],plots:[plot],planned:[{x:2,y:0}]};
    const original=layout([]);
    original.groupStyle='groups';
    original.groups=[{bounds:{x:10,y:3,w:8,h:6},indices:[0],storageIndices:[],reserved:[],purpose:'support',themes:['fields']}];
    original.pieces=[{...cluster,members:[{...climate,x:10,y:4,productionGroup:0},
        {...plot,x:12,y:4,w:2,h:3,productionGroup:0}]},piece(mine(0,'ore'))];
    const pieces=[piece(mine(0,'ore')),{...cluster,plots:[{...plot,weight:3}]}];
    const out=reusePowerTeamLayout(original,pieces,cells,0);
    assert.ok(out);
    assert.deepEqual(out.groups[0].indices,[1]);
    assert.deepEqual(out.groups[0].themes,['fields']);
    const updated=out.pieces[1].members[1];
    assert.deepEqual([updated.x,updated.y,updated.w,updated.h,updated.weight,updated.sourcePiece,updated.sourceMember],[12,4,2,3,3,1,1]);
    assert.equal(reusePowerTeamLayout(original,[pieces[0],{...cluster,plots:[{...plot,crop:'melon'}]}],cells,0),null);
});

test('powers a mill outside pole reach by exchanging positions with a manual workshop',()=>{
    const mill={...mine(28,'powder'),facility:'Carousel Mill'};
    const keg={...mine(0,'drink'),facility:'Bouncy Brew Keg'};
    const original=layout([mill,keg,gen()]);
    const out=reusePowerTeamLayout(original,[piece({...mill,electric_level:1}),piece(keg),piece(gen())],cells,0);
    assert.ok(out);
    assert.equal(out.power.disconnected,0);
    assert.equal(out.pieces[0].members[0].x,keg.x);
    assert.equal(original.pieces[0].members[0].x,28);
});

test('moves a single differently sized mill onto clear powered land while keeping storage and fields in place',()=>{
    const mill={...mine(28,'powder'),w:5.5,h:5.5,facility:'Carousel Mill'};
    const field={...mine(0,'agave'),facility:'Farmland',sensitive:true};
    const original=layout([mill,field,gen()]);
    const powered={...mill,electric_level:7};
    const out=reusePowerTeamLayout(original,[piece(powered),piece(field),piece(gen())],cells,0);
    assert.ok(out);
    const placed=out.pieces[0].members[0];
    assert.equal(placed.power_connected,true);
    assert.equal(out.power.poles.length,0);
    assert.equal(out.pieces[1].members[0].x,field.x);
    for (const other of [field,storage,gen()]) assert.ok(placed.x+placed.w<=other.x ||
        placed.y+placed.h<=other.y || placed.x>=other.x+other.w || placed.y>=other.y+other.h);
    assert.equal(original.pieces[0].members[0].x,28);
});
