import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import { FACILITIES } from '../web/facility-config.js';
const root = process.env.DISPATCH_WASM_ROOT || '../web/pkg/';
const pkg = await import(new URL(`${root}aniimax.js`, import.meta.url));
pkg.initSync({module:fs.readFileSync(new URL(`${root}aniimax_bg.wasm`,import.meta.url))});
const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
const input = () => ({currency:'coins',aniimo:'roster',quest_income_per_day:{wood_block:864000},
    level_up:{cost:[['rough_lumber',100]],stock:[]},
    fixed_homeland:{groups:[{facility:'Woodworking Bench',count:2,level:1,lit:false,powered:false}],climate:{},generators:0},
    roster:{members:[{count:1,abilities:{Artisanship:4,Hauling:3}}, {count:1,abilities:{Artisanship:2,Hauling:1}}],
        movement_seconds:0,dispatch:{}}});
function solve(data) {
    const payload=JSON.stringify(data), problem=JSON.parse(pkg.exact_level_up_problem(payload));
    const result=highs.solve(problem.lp);
    assert.equal(result.Status,'Optimal');
    const values=Array.from({length:problem.variables},(_,i)=>result.Columns[`x${i}`]?.Primal??0);
    const report=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:result.ObjectiveValue}),
        JSON.stringify({values,proven:true,bound:result.ObjectiveValue})));
    assert.equal(report.success,true,report.error);
    return {report,result,problem,values,payload};
}
const entries=(travel=0)=>[{member:0,share:1,travel_seconds:travel},{member:1,share:3,travel_seconds:travel}];
test('two dispatched artisans share one physical bench without duplicating it',()=>{
    const data=input();data.fixed_homeland.groups[0].count=1;
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=entries();
    const {report}=solve(data);
    assert.ok(report.level_up.seconds>0 && Number.isFinite(report.level_up.seconds));
    const rows=report.coin_items.filter(r=>r.status==='producing');
    assert.equal(rows.length,1);
    assert.equal(rows[0].facility_count,1);
    assert.equal(rows[0].crew,null);
    const routes=report.roster_routes.filter(r=>r.item==='rough_lumber');
    assert.equal(new Set(routes.map(r=>r.member)).size,2);
    const batches=routes.reduce((sum,r)=>sum+r.job_rate,0);
    assert.ok(Math.abs(rows[0].busy_units/rows[0].cycle_time-batches)<1e-8);
    assert.ok(Math.abs(rows[0].cycle_time-27.625)<1e-8);
    assert.ok(report.fixed_site_jobs.every(job=>job.turns));
});
test('dispatch shares one bench in an unfixed plan but never shares different recipes',()=>{
    const data=input();delete data.fixed_homeland;
    data.facilities=Object.fromEntries(FACILITIES.map(f=>[f.name,[{count:0,level:1}]]));
    data.facilities['Woodworking Bench']=[{count:1,level:2}];
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=entries();
    let solved=solve(data);
    assert.ok(solved.result.ObjectiveValue>0);
    assert.equal(solved.report.coin_items.filter(r=>r.status==='producing').reduce((n,r)=>n+r.facility_count,0),1);
    data.level_up.cost=[['standard_planks',100]];
    data.roster.dispatch['Woodworking Bench|standard_planks|Production']=entries();
    solved=solve(data);
    assert.ok(solved.result.ObjectiveValue<1e-9,'rough lumber and standard planks each need their own physical bench');
});
test('production dispatch conserves batch requests and forces slower cross-task capture',()=>{
    const data=input();data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=entries();
    const {report}=solve(data);
    const routes=(report.roster_routes??[]).filter(r=>r.item==='rough_lumber');
    const rates=[0,1].map(m=>routes.filter(r=>r.member===m).reduce((s,r)=>s+r.job_rate,0));
    assert.ok(rates[0]>0 && rates[1]>0);
    assert.ok(Math.abs(rates[1]/rates[0]-3)<1e-6);
    const batches=report.coin_items.filter(r=>r.status==='producing').reduce((s,r)=>s+r.busy_units/r.cycle_time,0);
    assert.ok(Math.abs(rates[0]+rates[1]-batches)<1e-8);
    for(const route of routes) assert.ok(Math.abs(route.jobs[0][1]/route.job_rate-(route.member===0?8.5:34))<1e-6);
    assert.ok(routes.every(r=>r.station===null));
    assert.ok(report.roster_workload.every(x=>x<=1+1e-6));
});
test('invalid recipients are ignored and remaining eligible shares are normalized',()=>{
    const data=input();
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=[
        {member:0,share:2,travel_seconds:10},{member:0,share:3,travel_seconds:20},
        {member:1,share:-1,travel_seconds:0},{member:99,share:99,travel_seconds:0},
        {member:1,share:4,travel_seconds:-1},
    ];
    const {report}=solve(data);
    assert.ok(report.roster_routes.length>0);
    assert.ok(report.roster_routes.every(r=>r.member===0));
    for(const route of report.roster_routes) assert.ok(Math.abs(route.walking-route.job_rate*16)<1e-8);
    const baseline=solve(input()).result.ObjectiveValue;
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=[{member:99,share:1,travel_seconds:0}];
    assert.ok(Math.abs(solve(data).result.ObjectiveValue-baseline)<1e-6,'an all-invalid policy falls back without dropping production');
    data.roster.members[1].abilities.Artisanship=1;
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=[{member:1,share:1,travel_seconds:0}];
    assert.ok(solve(data).report.coin_items.filter(r=>r.status==='producing').every(r=>r.crew===0));
});
test('hauling shares conserve batches and full policy cost replaces the fallback route',()=>{
    const data=input();
    data.roster.hauling_default_seconds=999;
    data.roster.dispatch['Woodworking Bench|rough_lumber|Hauling']=[
        {member:0,share:1,travel_seconds:10},{member:1,share:3,travel_seconds:20},
    ];
    const {report,problem,values}=solve(data);
    const haul=[0,0], production=problem.variable_keys.reduce((s,k,i)=>s+(k.startsWith('rate:rough_lumber')?values[i]:0),0);
    problem.variable_keys.forEach((key,i)=>{if(key.startsWith('haul:rough_lumber')){
        const member=Number(key.match(/:owned:(\d+)#/)[1]);haul[member]+=values[i];
    }});
    assert.ok(production>0);
    assert.ok(Math.abs(haul[0]+haul[1]-production)<1e-8);
    assert.ok(Math.abs(haul[1]/haul[0]-3)<1e-6);
    const hours=new Map(report.hauling_staffing);
    assert.ok(Math.abs(hours.get(0)-haul[0]*10)<1e-8);
    assert.ok(Math.abs(hours.get(1)-haul[1]*20)<1e-8);
});
test('crop policies conserve each ability request including two watering visits',()=>{
    const data={currency:'coins',aniimo:'roster',level_up:{cost:[['wheat',100]],stock:[]},
        fixed_homeland:{groups:[{facility:'Farmland',count:3,level:1,lit:false,powered:false}],climate:{},generators:0},
        roster:{members:[{count:1,abilities:{Grass:3,Water:3,Dark:3}},{count:1,abilities:{Grass:2,Water:2,Dark:2}}],movement_seconds:0,
            dispatch:{'Farmland|wheat|Grass':entries(10),'Farmland|wheat|Water':entries(30)}}};
    const {report,problem,values,payload,result}=solve(data);
    assert.ok(report.roster_routes.length>=4);
    const batches=report.coin_items.filter(r=>r.status==='producing').reduce((s,r)=>s+r.busy_units/r.cycle_time,0);
    for(const [job,visits,travel] of [['Watering',2,30],['Sowing',1,10]]){
        const routes=report.roster_routes.filter(r=>r.jobs.some(([name])=>name===job));
        assert.ok(routes.length===2,job);
        assert.ok(Math.abs(routes.reduce((s,r)=>s+r.job_rate,0)-batches*visits)<1e-8);
        const rate=m=>routes.filter(r=>r.member===m).reduce((s,r)=>s+r.job_rate,0);
        assert.ok(Math.abs(rate(1)/rate(0)-3)<1e-6);
        assert.ok(routes.every(r=>r.station===null && Math.abs(r.walking-r.job_rate*travel)<1e-8));
    }
    assert.ok(report.roster_workload.every(x=>x<=1+1e-6));
    const water=[0,1].map(member=>problem.variable_keys.findIndex((key,i)=>key.startsWith('route:wheat:')
        && key.includes(`:owned:${member}:`) && key.includes('Water') && values[i]>0));
    assert.ok(water.every(i=>i>=0));
    values[water[1]]+=values[water[0]];values[water[0]]=0;
    const repaired=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:result.ObjectiveValue}),
        JSON.stringify({values,proven:true,bound:result.ObjectiveValue})));
    assert.equal(repaired.success,true);
    const repairedWater=repaired.roster_routes.filter(r=>r.jobs.some(([job])=>job==='Watering'));
    const repairedRate=m=>repairedWater.filter(r=>r.member===m).reduce((s,r)=>s+r.job_rate,0);
    assert.ok(Math.abs(repairedRate(1)/repairedRate(0)-3)<1e-6,
        'external solution repair restores policy shares before the independent check');
});
test('Rust fallback hauling waits for 40 percent of the processor buffer',()=>{
    const data=input();data.roster.hauling_default_seconds=10;
    delete data.roster.members[1].abilities.Hauling;
    const {report,problem,values}=solve(data);
    const batches=problem.variable_keys.reduce((s,key,i)=>s+(key.startsWith('rate:rough_lumber')?values[i]:0),0);
    const hauled=report.hauling_staffing.reduce((s,[,hours])=>s+hours,0);
    // 20-item buffer, one item per batch: eight batches then one 10-second route.
    assert.ok(Math.abs(hauled/batches-1.25)<1e-8);
});
test('Quick Aromathyst uses the same 40 percent threshold without an earlier cap',()=>{
    const data={currency:'coins',aniimo:'roster',modules:{resource_detector:3},
        level_up:{cost:[['aromathyst',100]],stock:[]},
        fixed_homeland:{groups:[{facility:'Dewy House',count:1,level:2,lit:false,powered:false}],climate:{},generators:0},
        roster:{members:[{count:1,abilities:{Leisure:3,Hauling:3},family:'1035'}],hauling_default_seconds:10}};
    const {report,problem,values}=solve(data);
    const batches=problem.variable_keys.reduce((s,key,i)=>s+(key.startsWith('rate:quick_aromathyst')?values[i]:0),0);
    assert.ok(batches>0);
    const hauled=report.hauling_staffing.reduce((s,[,hours])=>s+hours,0);
    assert.ok(Math.abs(hauled/batches-1.25)<1e-8,'240 items at 40% means eight 12-item batches per pickup');
});
test('dispatch approach consumes real worker capacity and lowers feasible output',()=>{
    const data=input();data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=entries();
    const plain=solve(data);
    data.roster.dispatch['Woodworking Bench|rough_lumber|Production']=entries(120);
    const walking=solve(data);
    assert.ok(walking.result.ObjectiveValue<plain.result.ObjectiveValue*.8);
    for(const route of walking.report.roster_routes) assert.ok(Math.abs(route.walking-route.job_rate*120)<1e-8);
});
