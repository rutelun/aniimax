import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analyzePowerNetworks, optimizePowerNetworks, powerJobDetails } from '../web/power-islands.js';

const generator=(x,watts=600)=>({x,y:0,w:2,h:2,generator:true,generatedWatts:watts});
const consumer=(x,load=1,level=5)=>({x,y:3,w:2,h:2,facility:'Mine',electric_level:level,load,cycle:100});
const layout=members=>({pieces:members.map(m=>({members:[m]})),storages:[],unplaced:[],power:{poles:[],maximum:10}});

test('separate generators have independent supply and cannot borrow distant surplus',()=>{
    const l=layout([generator(0,100),consumer(0,.5),generator(30,800),consumer(30)]);
    analyzePowerNetworks(l);
    assert.equal(l.power.networks.length,2);
    assert.ok(Math.abs(l.power.networks[0].percent-100/150*100)<1e-8);
    assert.equal(l.power.networks[1].percent,120);
    assert.equal(l.power.disconnected,0);
    l.pieces[1].members[0].load=1;
    analyzePowerNetworks(l);
    assert.equal(l.power.disconnected,1);
});

test('all recipes sharing a building count toward its minimum supply',()=>{
    const c=consumer(0);
    c.jobs=[{rate:.005,cycle:100},{rate:.005,cycle:100}];
    const l=layout([generator(0,150),c]);
    analyzePowerNetworks(l);
    assert.equal(l.power.networks[0].percent,100);
    assert.equal(l.power.disconnected,1);
});

test('a separate network below 120% is accepted only while its scheduled output still fits',()=>{
    const l=layout([generator(0,100),consumer(0,.5),generator(30,800),consumer(30)]);
    const out=optimizePowerNetworks(l,[{x:0,y:0,w:40,h:20}],10);
    assert.equal(out.power.disconnected,0);
    assert.ok(out.power.networks.some(n=>n.percent<120&&n.percent>=n.required));
});

test('a building overlapping two independent networks is budgeted against both',()=>{
    const c={...consumer(4,.5),y:0,w:6};
    const l=analyzePowerNetworks(layout([generator(0,100),generator(12,800),c]));
    assert.equal(l.power.networks.length,2);
    assert.deepEqual(l.power.networks.map(n=>n.rated),[150,150]);
    assert.deepEqual(c.power_networks,[0,1]);
    assert.ok(Math.abs(c.power_percent-100/150*100)<1e-8);
});

test('connected generators combine output while consumers do not relay power',()=>{
    const l=layout([generator(0,150),generator(4,150),consumer(2)]);
    analyzePowerNetworks(l);
    assert.equal(l.power.networks.length,1);
    assert.equal(l.power.networks[0].generated,300);
    assert.equal(l.power.disconnected,0);
});

test('unknown generation leaves the original plan unchanged',()=>{
    const l=layout([{...generator(0),generatedWatts:undefined},consumer(0)]);
    assert.equal(optimizePowerNetworks(l,[{x:0,y:0,w:40,h:20}],10),l);
});

test('recipe details identify the specific generator and slower cycle for each network',()=>{
    const a={...consumer(0,.5),crop:'Quartz Ore'},b={...consumer(30,.5),crop:'Quartz Ore'};
    const l=analyzePowerNetworks(layout([generator(0,150),a,generator(30,600),b]));
    const details=powerJobDetails(l,{facility:'Mine',item_name:'Quartz Ore',electric_level:5});
    assert.deepEqual(details.map(d=>d.networks.flatMap(n=>n.generator_ids)),[[1],[2]]);
    assert.deepEqual(details.map(d=>d.cycle),[120,100]);
    assert.deepEqual(details.map(d=>d.load),[.6,.5]);
});

test('building list shows the concrete generator below 120% and corrected busy time',()=>{
    const plan={},l=analyzePowerNetworks(layout([generator(0,150),{...consumer(0,.5),crop:'Quartz Ore'}]));
    const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
    const context=vm.createContext({plan,lastLayout:{plan,layout:l},powerJobDetails,prettyItem:x=>x,
        recipeIndex:[],ABILITY_BY_NAME:new Map(),productionWorkers:()=>[],unverifiedRowKeys:new Set(),
        abilityGlyph:()=>'',escapeText:String,translate:x=>x,formatNumber:String,cycleDuration:n=>`${n}s`});
    vm.runInContext(source.slice(source.indexOf('function powerNetworkLabel('),source.indexOf('\nfunction layoutWorkerBadges('))+
        source.slice(source.indexOf('function productionCard('),source.indexOf('\nfunction cycleDuration(')),context);
    const html=vm.runInContext("productionCard({status:'producing',facility:'Mine',item_name:'Quartz Ore',electric_level:5,cycle_time:100,facility_count:1,busy_units:.5},plan)",context);
    assert.match(html,/G1 · 100%/);
    assert.match(html,/60%/);
    assert.match(html,/120s per batch/);
});

test('network optimization preserves outputs and does not add generators or mutate input',()=>{
    const l=layout([generator(0),consumer(0,.5),generator(30),consumer(30,.5)]);
    l.power.poles=[{x:6,y:0,w:1.5,h:1.5,pole:true},{x:11,y:0,w:1.5,h:1.5,pole:true},
        {x:16,y:0,w:1.5,h:1.5,pole:true},{x:21,y:0,w:1.5,h:1.5,pole:true},{x:26,y:0,w:1.5,h:1.5,pole:true}];
    const before=structuredClone(l);
    const out=optimizePowerNetworks(l,[{x:0,y:0,w:40,h:20}],10);
    assert.deepEqual(l,before);
    assert.equal(out.power.disconnected,0);
    assert.equal(out.power.networks.length,2);
    assert.equal(out.power.poles.length,0);
    assert.equal(out.pieces.filter(p=>p.members[0].generator).length,2);
    assert.equal(out.pieces[1].members[0].cycle,100);
    assert.equal(out.pieces[1].members[0].load,.5);
});
