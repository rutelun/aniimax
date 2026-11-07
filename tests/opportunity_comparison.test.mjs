import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {changeOneMember,personalityInput,reserveLevelFourInputs,workerUsage,comparePlans} from '../web/opportunity-comparison.js';

const input = () => ({priorities:['season_points','Wood Blocks','coins'],roster:{members:[
    {count:2,abilities:{Artisanship:3,Water:3},personalities:['Instinctive','Nimble'],family:'1017'},
],residents:['Tidewhisper Sandcastle']}});
const plan = (coins=10,wood=2) => ({success:true,proven_optimal:true,rate_per_second:coins,season_points:1,
    priorities:[{target:'season_points',per_second:1},{target:'Wood Blocks',per_second:wood}],
    comparison_scores:{crop_variety:26,material_pace:.3,material_work:3},
    level_up_preview:{seconds:1_000,requirements:[{name:'standard_planks',per_second:.1}]},coin_items:[]});

test('only one copy is trained, preserving its family, other ability and original input', () => {
    const original=input(), saved=structuredClone(original);
    const changed=changeOneMember(original,0,{abilities:{Artisanship:4,Water:3}});
    assert.deepEqual(original,saved);
    assert.equal(changed.roster.members[0].count,1);
    assert.equal(changed.roster.members[0].abilities.Artisanship,3);
    assert.equal(changed.roster.members[1].abilities.Artisanship,4);
    assert.equal(changed.roster.members[1].abilities.Water,3);
    assert.equal(changed.roster.members[1].family,'1017');
});

test('a personality replaces its opposite on one copy while preserving the other traits', () => {
    const original=input();
    const changed=personalityInput(original,0,'Energetic',[
        {names:['Instinctive','Energetic']},{names:['Nimble','Practical']},
    ]);
    assert.deepEqual(changed.roster.members[1].personalities,['Nimble','Energetic']);
    assert.deepEqual(original.roster.members[0].personalities,['Instinctive','Nimble']);
});

test('Lv.4 suggestions replace productive reserves, excluding idle pools and climate-only staffing', () => {
    const p={coin_items:[{status:'producing',crew:2}],assumed_aniimo:[
        [1,'Lightning',3,20,null],[2,'Artisanship',3,20,null],[3,'Perfumery',3,20,null],
    ],staffing:[['Crackle Generator',1,1]]};
    const suggestions=reserveLevelFourInputs(input(),p,a=>a==='Perfumery'?3:4);
    assert.equal(suggestions.length,1);
    assert.equal(suggestions[0].ability,'Artisanship');
    const added=suggestions[0].input.roster.members.at(-1);
    assert.equal(added.count,1); assert.deepEqual(added.abilities,{Artisanship:4});
    assert.deepEqual(added.personalities,[]);
});

test('a useful Leisure upgrade retains its specific family', () => {
    const p={coin_items:[{status:'producing',crew:2}],assumed_aniimo:[[2,'Leisure',3,20,'1017']]};
    assert.equal(reserveLevelFourInputs(input(),p)[0].input.roster.members.at(-1).family,'1017');
});

test('all priorities are compared: more coins cannot conceal fewer Wood Blocks', () => {
    const result=comparePlans(plan(),plan(100,1),input());
    assert.equal(result.direction,-1); assert.equal(result.decisive.id,'Wood Blocks');
    assert.equal(result.score,0);
});

test('a lower-priority coin gain is visible when the first priorities are capped', () => {
    const result=comparePlans(plan(),plan(12),input());
    assert.equal(result.direction,1); assert.equal(result.decisive.id,'coins');
    assert.ok(result.rows.some(r=>r.id==='rv_time'));
    assert.ok(result.rows.some(r=>r.id==='item:standard_planks'));
});

test('planting coverage remains ahead of monetary gains', () => {
    const after=plan(100);after.comparison_scores.crop_variety=25;
    assert.equal(comparePlans(plan(),after,input()).decisive.id,'crop_variety');
    assert.equal(comparePlans(plan(),after,input()).direction,-1);
});

test('level-up strategy compares ETA before coins and handles an unreachable base', () => {
    const base=plan(100),after=plan(50);base.level_up_preview.seconds=null;after.level_up_preview.seconds=100;
    const result=comparePlans(base,after,{...input(),level_up_strategy:true});
    assert.equal(result.direction,1);assert.equal(result.decisive.id,'rv_time');
});

test('workload includes crop jobs, walking, reserved posts and delivery without double counting', () => {
    const p={coin_items:[{status:'producing',crew:0,facility:'Crafting Table',busy_units:.5}],
        staffing:[['Sunlamp',1,.2]],crop_assignments:[['Water',1,0,.1]],movement_staffing:[[0,.1,.2]],
        hauling_staffing:[[0,.9]],delivery_assignments:[[0,.05]]};
    const usage=workerUsage(p,input());
    assert.ok(Math.abs(usage.busy.get(0)-.95)<1e-10);
    assert.equal(usage.working,2); assert.equal(usage.additional,1);
});

test('merely relabeling a reserve as newly owned is not a production gain', () => {
    const before=plan(),after=plan();
    before.coin_items=after.coin_items=[{status:'producing',crew:1,facility:'Mine',busy_units:.5}];
    const a=input(),b=input();b.roster.members.push({count:1,abilities:{Earth:4},personalities:[]});
    const comparison=comparePlans(before,after,a,b);
    assert.equal(comparison.direction,0);
    assert.equal(comparison.rows.find(r=>r.id==='additional_aniimo').before,1);
    assert.equal(comparison.rows.find(r=>r.id==='additional_aniimo').after,0);
});

test('unproven optimization is identified as an estimate', () => {
    const after=plan(20);after.proven_optimal=false;
    assert.equal(comparePlans(plan(),after,input()).approximate,true);
});

test('comparison worker runs the complete planner per change and reports progress and failures independently', async () => {
    const source=await readFile(new URL('../web/worker.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('async function rankImprovements('),source.indexOf('self.onmessage ='));
    const calls=[],reports=[];
    const run=new Function('exactPlanJson',`${code};return rankImprovements;`)(async(_,payload,step)=>{
        const p=JSON.parse(payload);calls.push(p);
        step('priority:coins','start');
        if(p.fail)throw Error('Cannot check this change');
        return JSON.stringify(plan(p.coins));
    });
    await run({},JSON.stringify({base:input(),basePlan:plan(),candidates:[{coins:12},{fail:true},{coins:15}]}),r=>reports.push(r));
    assert.equal(calls.length,3);
    assert.ok(reports.some(r=>r.index===0&&r.step==='priority:coins'));
    assert.ok(reports.some(r=>r.index===1&&r.error));
    assert.equal(reports.find(r=>r.index===2&&r.plan).plan.rate_per_second,15);
});

test('suggestions do not launch searches automatically, and cancelled comparisons ignore late replies', async () => {
    const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
    const stop=source.slice(source.indexOf('function stopRanking()'),source.indexOf('// How many of a facility'));
    const run=source.slice(source.indexOf('function rankImprovementsFor('),source.indexOf('function comparisonPhase('));
    const workers=[],timers=new Set(),baseline=plan(),base=input();
    class FakeWorker {
        constructor(){workers.push(this);}
        terminate(){this.terminated=true;}
        postMessage(message){this.message=JSON.parse(message.payload);}
        reply(count){this.onmessage({data:{type:'progress',count}});}
    }
    const api=new Function('Worker','setTimeout','clearTimeout','baseline','base',`
        let rankRunId=0,rankWorkers=[],rankCleanups=[],ranking=null,rankingsBySetup={};
        const mainSolve=null,setupSolve=null,layoutWorker=null,lastPlan=baseline,lastPlanInput=base;
        const plansBySetup={roster:baseline},WORKER_URL='worker',SETUP_TIMEOUT=100;
        const aniimoInput=()=>({}),haulingRouteBound=()=>0,renderImprovements=()=>{};
        const improvementCandidates=()=>[0,1,2].map(i=>({input:{...base,change:i}}));
        const comparisonPhase=step=>step;
        ${stop}\n${run}
        return {run:rankImprovementsFor,stop:stopRanking,state:()=>ranking};
    `)(FakeWorker,fn=>{timers.add(fn);return fn;},id=>timers.delete(id),baseline,base);
    api.run('roster');
    assert.equal(workers.length,0);
    api.run('roster',[2]);
    assert.equal(workers.length,1);
    assert.equal(workers[0].message.candidates[0].change,2);
    workers[0].reply({index:0,step:'final'});
    assert.equal(api.state().activeIndex,2);
    api.stop();
    assert.ok(workers[0].terminated);
    assert.equal(timers.size,0);
    workers[0].reply({index:0,plan:plan(100)});
    assert.equal(api.state().results[2],undefined);
    api.run('roster',[1]);
    workers[1].reply({index:0,plan:plan(12)});
    assert.equal(api.state().results[1].plan.rate_per_second,12);
    api.stop();
    api.run('roster','all');
    assert.deepEqual(workers[2].message.candidates.map(c=>c.change),[0,2]);
    api.stop();
});
