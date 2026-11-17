import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import * as pkg from '../web/pkg/aniimax.js';
pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
function solve(hauling,minorCrop=false,grassTravel=1){
 const input={currency:'coins',aniimo:'roster',level_up:{cost:[['potato',100]],stock:[]},
 fixed_homeland:{groups:[{facility:'Farmland',count:3,level:3,lit:false,powered:false}],climate:{},generators:0},
 roster:{members:[{count:1,abilities:{Earth:3,Hauling:3}},{count:3,abilities:{Earth:3,Grass:2,Hauling:hauling}},{count:1,abilities:{Water:3,Dark:3,...(!minorCrop?{Earth:3,Grass:2}:{})}}],movement_seconds:0,
 dispatch:{'Farmland|potato|Earth':[{member:minorCrop?0:2,share:1,travel_seconds:1}],
 'Farmland|potato|Grass':[{member:minorCrop?1:2,share:1,travel_seconds:grassTravel}],
 'Farmland|potato|Hauling':[{member:0,share:.75,travel_seconds:100},{member:1,share:.25,travel_seconds:100}]}}};
 const payload=JSON.stringify(input),p=JSON.parse(pkg.exact_level_up_problem(payload)),s=highs.solve(p.lp);
 assert.equal(s.Status,'Optimal');const values=Array.from({length:p.variables},(_,i)=>s.Columns[`x${i}`]?.Primal??0);
 const r=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:s.ObjectiveValue}),JSON.stringify({values,proven:true,bound:s.ObjectiveValue})));
 assert.equal(r.success,true,r.error);return {r,p,s,values};
}
test('a partly used versatile pool accepts courier work without disturbing focused growers',()=>{
 const {r,p,values}=solve(3);
 const source=values.reduce((sum,v,i)=>sum+(p.variable_keys[i].startsWith('haul:')&&p.variable_keys[i].includes(':owned:0#')?v:0),0);
 const recipient=values.reduce((sum,v,i)=>sum+(p.variable_keys[i].startsWith('haul:')&&p.variable_keys[i].includes(':owned:1#')?v:0),0);
 assert.ok(source>0&&recipient>0,'both pools start occupied');
 assert.equal(r.roster_workload[0],0);
 assert.ok(!r.hauling_staffing.some(([m,h])=>m===0&&h>0));
 for(const ability of ['Hauling']){
  const es=r.roster_dispatch['Farmland|potato|'+ability];
  assert.equal(es.length,1);assert.equal(es[0].member,1);assert.equal(es[0].share,1);
 }
 assert.ok(r.roster_routes.some(x=>x.member===2&&x.jobs.some(([n])=>n==='Sowing')));
 assert.ok(r.roster_routes.some(x=>x.member===2&&x.jobs.some(([n])=>n==='Reclaiming')));
 assert.ok(r.roster_workload.every((v,i)=>v<=[1,3,1][i]+1e-6));
});
test('extra skills do not compensate for a lower hauling level',()=>{
 const {r}=solve(2);assert.ok(r.hauling_staffing.some(([m,h])=>m===0&&h>0));
});



test('minor crop work cannot be merged when it makes sowing or reclaiming wait more',()=>{
 const {r}=solve(3,true);assert.ok(r.hauling_staffing.some(([m,h])=>m===0&&h>0));
 assert.ok(r.roster_routes.some(x=>x.member===0&&x.jobs.some(([n])=>n==='Reclaiming')));
});
