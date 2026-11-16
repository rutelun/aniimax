import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductionBlocks, productionGroupLayout, normalizeMapStyle, refineProductionGroups } from '../web/production-groups.js';
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
