import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionBlocks, productionGroupLayout, normalizeMapStyle, refineProductionGroups, refineGroupedMembers } from '../web/production-groups.js';
import { createInsideTest, layoutDeliveryCost } from '../web/layout.js';

const piece = (facility, weight = 1) => ({members:[{x:0,y:0,w:2,h:2,facility,weight}]});
test('legacy map styles migrate to exactly two modes', () => {
    for(const style of ['courtyards','avenues','districts','groups']) assert.equal(normalizeMapStyle(style),'groups');
    for(const style of ['delivery',null,'unknown']) assert.equal(normalizeMapStyle(style),'delivery');
});
test('compact blocks separate categories and keep alphabetical production rows', () => {
    const input=['Woodworking Bench','Well','Farmland','Chimney Kiln','Mine','Dewy House','Woodland'].map(n=>piece(n));
    const blocks=buildProductionBlocks(input,{width:10});
    assert.deepEqual(new Set(blocks.map(b=>b.theme)),new Set(['fields','woodland','extraction','aniimo','processing']));
    const production=blocks.find(b=>b.theme==='processing');
    assert.deepEqual(production.members.map(m=>m.facility),['Chimney Kiln','Woodworking Bench']);
    assert.ok(blocks.every(b=>b.reserved.length===0));
});
test('splits contain eight or more objects, small categories remain whole', () => {
    const blocks=buildProductionBlocks(Array.from({length:18},()=>piece('Mine')),{width:10,targetSize:8});
    assert.deepEqual(blocks.map(b=>b.members.length),[9,9]);
    assert.equal(buildProductionBlocks(Array.from({length:5},()=>piece('Well')),{targetSize:8}).length,1);
});
test('climate links remain rigid and mixed field/woodland climates share one block', () => {
    const cluster={cluster:true,buildings:[{x:0,y:0,w:1,h:1,facility:'Heat Furnace'}],
        plots:[{w:2,h:2,facility:'Farmland',weight:1,zone:0},{w:2,h:2,facility:'Woodland',weight:1,zone:0}],
        planned:[{x:1,y:0},{x:1,y:2}]};
    const [block]=buildProductionBlocks([cluster]);
    assert.equal(block.theme,'growing');
    assert.equal(block.members[1].x-block.members[0].x,1);
    assert.equal(block.members[2].y-block.members[1].y,2);
});
test('grouped layout preserves buildings and improves delivery without decorative gaps', async () => {
    const pieces=['Mine','Mine','Well','Farmland','Woodland','Dewy House','Woodworking Bench','Chimney Kiln'].map((n,i)=>piece(n,i+1));
    const cells=[{x:0,y:0,w:30,h:30}];
    const layout=await productionGroupLayout(pieces,cells,{storageCount:2,poleLimit:0});
    assert.ok(layout);
    assert.deepEqual(layout.unplaced,[]);
    assert.equal(layout.groupStyle,'groups');
    assert.equal(layout.power.disconnected,0);
    assert.ok(layoutDeliveryCost(layout)<=layout.groupSearch.seedCost+1e-8);
    const rects=[...layout.pieces.flatMap(p=>p.members),...layout.storages,...layout.power.poles];
    assert.equal(layout.pieces.flatMap(p=>p.members).length,pieces.length);
    assert.ok(rects.every(createInsideTest(cells)));
    for(let i=0;i<rects.length;i++)for(let j=0;j<i;j++){
        const a=rects[i],b=rects[j];
        assert.ok(!(a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h));
    }
    assert.ok(layout.groups.every(g=>g.reserved.length===0));
});
test('whole-group refinement reduces real deliveries while preserving category membership', () => {
    const layout={pieces:[{members:[{x:14,y:10,w:2,h:2,weight:4,facility:'Mine',productionGroup:0}]}],
        storages:[{x:2,y:10,w:2,h:2}],unplaced:[],power:{poles:[],disconnected:0},
        groups:[{bounds:{x:14,y:10,w:2,h:2},indices:[0],themes:['extraction'],reserved:[]}]};
    const before=layoutDeliveryCost(layout);
    const out=refineProductionGroups(layout,[{x:0,y:0,w:30,h:30}]);
    assert.ok(layoutDeliveryCost(out)<before);
    assert.equal(out.pieces[0].members[0].x,out.groups[0].bounds.x);
    assert.equal(layoutDeliveryCost(layout),before,'does not mutate the seed');
});
test('group output carries validated walking slack so custom teams do not need a conservative re-solve',async()=>{
    const layout=await productionGroupLayout([piece('Mine')],[{x:0,y:0,w:20,h:20}],{
        storageCount:1,poleLimit:0,staffing:{movement:{defaultDistance:100,byMember:{},visits:{}},members:[],busy:[]},
    });
    assert.ok(layout);
    assert.deepEqual(layout.incomeWalking,[]);
});
test('idle processors stay in the alphabetical production group',async()=>{
    const idle={members:[{x:0,y:0,w:2,h:2,facility:'Chimney Kiln',weight:0,crop:null,load:0}]};
    const out=await productionGroupLayout([piece('Woodworking Bench'),idle,piece('Mine')],[{x:0,y:0,w:30,h:20}],{storageCount:1,poleLimit:0});
    assert.ok(out);
    assert.equal(out.pieces[0].members[0].productionGroup,out.pieces[1].members[0].productionGroup);
    assert.equal(out.idleArea,undefined);
});
test('processing A–Z starts at the bottom left, with bottom-aligned rows of different heights',()=>{
    const input=['Woodworking Bench','Crafting Table','Chimney Kiln','Blazing Stove','Aniipod Maker'].map(n=>piece(n));
    input[4].members[0].h=4;
    const b=buildProductionBlocks(input,{width:4})[0];
    const ordered=[...b.members].sort((a,b)=>(b.y+b.h)-(a.y+a.h)||a.x-b.x);
    assert.deepEqual(ordered.map(r=>r.facility),['Aniipod Maker','Blazing Stove','Chimney Kiln','Crafting Table','Woodworking Bench']);
    assert.equal(ordered[0].y+ordered[0].h,ordered[1].y+ordered[1].h);
});
test('groups can interlock one building deep while their real footprints remain separate',()=>{
    const layout={pieces:[{members:[{x:8,y:8,w:2,h:2,weight:4,facility:'Mine',productionGroup:0}]},
        {members:[{x:4,y:12,w:2,h:2,weight:0,facility:'Well',productionGroup:1}]}],
        storages:[{x:0,y:8,w:2,h:2}],unplaced:[],power:{poles:[],disconnected:0},
        groups:[{bounds:{x:8,y:8,w:4,h:6},indices:[0],themes:['extraction'],reserved:[]},
                {bounds:{x:4,y:8,w:4,h:6},indices:[1],themes:['aniimo'],reserved:[]}]};
    const out=refineProductionGroups(layout,[{x:0,y:0,w:20,h:20}]);
    assert.ok(out.groups[0].bounds.x<8,'envelopes can overlap');
    assert.ok(out.pieces[0].members[0].x>=6,'penetration is at most one 2-tile building');
    assert.ok(layoutDeliveryCost(out)<layoutDeliveryCost(layout));
});
test('a low-throughput well is refined even behind 49 higher-cost producers',()=>{
    const mines=Array.from({length:49},(_,i)=>({members:[{x:15+i%7,y:15+Math.floor(i/7),w:1,h:1,weight:1000,facility:'Mine',productionGroup:0}]}));
    const well={members:[{x:25,y:5,w:1,h:1,weight:1,facility:'Well',productionGroup:0}]};
    const layout={groupStyle:'groups',pieces:[...mines,well],storages:[{x:1,y:1,w:2,h:2}],unplaced:[],power:{poles:[],disconnected:0},
        groups:[{bounds:{x:0,y:0,w:30,h:30},indices:Array.from({length:50},(_,i)=>i),themes:['extraction'],reserved:[]}]};
    const out=refineGroupedMembers(layout,[{x:0,y:0,w:30,h:30}],{accept:c=>mines.every((p,i)=>p.members[0].x===c.pieces[i].members[0].x&&p.members[0].y===c.pieces[i].members[0].y)});
    assert.ok(out.pieces[49].members[0].x<25);
    assert.ok(layoutDeliveryCost(out)<layoutDeliveryCost(layout));
});

test('narrow land retains a compact fallback when wider processing rows do not fit',async()=>{
    const layout=await productionGroupLayout(Array.from({length:8},()=>piece('Crafting Table')),[{x:0,y:0,w:12,h:12}]);
    assert.ok(layout);
    assert.equal(layout.unplaced.length,0);
    assert.equal(layout.pieces.flatMap(p=>p.members).length,8);
});
