import test from 'node:test';
import assert from 'node:assert/strict';
import { fullyStaffed, splitProductionSites } from '../web/physical-production.js';
import { buildReactiveDispatch } from '../web/reactive-dispatch.js';
const step={facility:'Well',item_name:'water',facility_count:3,busy_units:2.9,cycle_time:1000,crew:null,status:'producing'};
const routes=[1,1,.9].map((work,member)=>({member,facility:'Well',item:'water',job_rate:work/1000,jobs:[['',work]],walking:0}));
test('unequal well rates are preserved at their actual physical workplaces',()=>{
 const split=splitProductionSites(step,routes);assert.equal(split.length,3);
 assert.deepEqual(split.map(s=>s.crew),[0,1,2]);
 assert.ok(Math.abs(split.reduce((s,r)=>s+r.rate,0)-.0029)<1e-12);
 const members=split.map(()=>({count:1,abilities:{Water:4}}));
 const layout={storages:[],pieces:split.map((r,i)=>({members:[{...r,x:i*10,y:0,w:2,h:2,facility:'Well',crop:'water',batchWeight:r.rate*3600}]}))};
 const p=buildReactiveDispatch({layout,recipes:[{name:'water',facility:'Well',aniimo:['Water',1]}],members,busy:[1,1,.9],routes});
 assert.ok(p['Well|water|Production'].every(e=>e.travel_seconds===0));
});
test('workers sharing fewer buildings cannot be turned into dedicated workplaces',()=>{
 assert.equal(splitProductionSites({...step,facility_count:2,busy_units:1.8},routes.map(r=>({...r,job_rate:.0006,jobs:[['',.6]]}))),null);
});

test('only spare manual workstation capacity can distract a grower, with delivery still available',async()=>{
 const {buildDispatch}=await import('../web/task-switching.js');
 const {placeBestJobs,recommendBestTeam,distractionCount}=await import('../web/best-team.js');
 const sites=[{crop:'water',load:1},{crop:'water',load:.99},{crop:'drink',jobs:[
     {item:'drink',rate:.02,cycle:25},{item:'juice',rate:.01,cycle:50}]},
     {crop:'drink',schedulePeak:1,jobs:[{item:'drink',rate:.01,cycle:25}]}]
     .map((r,i)=>({...r,facility:i<2?'Well':'Bouncy Brew Keg',x:i*6,y:0,w:2,h:2,batchWeight:1}));
 const recipes=['water','drink','juice'].map(name=>({name,facility:name==='water'?'Well':'Bouncy Brew Keg',aniimo:['Water',1]}));
 const layout={pieces:sites.map(s=>({members:[s]})),storages:[{x:2,y:3,w:2,h:2}]};
 const dispatch=buildDispatch(layout,recipes,{trips:1},new Set());
 assert.deepEqual(dispatch.opportunities.map(s=>[s.ability,s.point[0]]),[['Water',7],['Water',19],['Hauling',3]]);
 const jobs=recipes.map(r=>({facility:r.facility,siteKey:r.facility+'|'+r.name,ability:'Water',level:4,minimumLevel:1,workstation:true,label:r.name,busy:.1}));
 const team=recommendBestTeam(placeBestJobs(jobs,layout,dispatch.locations));
 assert.equal(distractionCount({abilities:{Water:2}},team.manualWorkshops),2);
});

test('an assigned fully occupied well keeps its output when a Water 2 grower is free',()=>{
 const split=splitProductionSites(step,routes);
 const layout={storages:[],pieces:split.map((r,i)=>({members:[{...r,x:i*10,y:0,w:2,h:2,facility:'Well',crop:'water',batchWeight:r.rate*3600}]}))};
 const key='Well|water|Production';
 const p=buildReactiveDispatch({layout,recipes:[{name:'water',facility:'Well',aniimo:['Water',1]}],
     members:[4,4,4,2].map(Water=>({count:1,abilities:{Water}})),busy:[1,1,.9,.6],routes,
     previous:{[key]:[{member:3,share:1}]}});
 const share=i=>p[key].find(e=>e.member===i)?.share||0;
 for (const owner of [0,1]) assert.ok(Math.abs(share(owner)-1/2.9)<1e-8);
 assert.ok(Math.abs(share(3)-.9/2.9)<1e-8);
});

test('a bench stays occupied through a full recipe phase and opens during a partially staffed phase',()=>{
 const site={facility:'Carousel Mill',jobs:[{item:'flour',rate:.025,cycle:20},{item:'powder',rate:.025,cycle:10}],
     schedulePhases:[{duration:10,rates:{flour:.05}},{duration:10,rates:{powder:.05}}]};
 assert.equal(fullyStaffed(site,'flour'),true);
 assert.equal(fullyStaffed(site,'powder'),false);
});
