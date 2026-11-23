import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {changeOneMember,personalityInput,reserveLevelFourInputs,workerUsage,comparePlans,keepBetterComparison,
    compareRecommendations,replacementCandidates} from '../web/opportunity-comparison.js';
import {switchingWorkshops} from '../web/material-flow-schedule.js';
import {createComparisonSearch} from '../web/comparison-search.js';
import {comparisonConcurrency,startComparisonQueue} from '../web/comparison-queue.js';

const input = () => ({priorities:['season_points','Wood Blocks','coins'],roster:{members:[
    {count:2,abilities:{Artisanship:3,Water:3},personalities:['Instinctive','Nimble'],family:'1017'},
],residents:['Tidewhisper Sandcastle']}});

test('counterfactual copy replacement preserves the original dispatch demand',()=>{
    const before=input();before.roster.dispatch={job:[{member:0,share:1,travel_seconds:4}]};
    const after=changeOneMember(before,0,{abilities:{Artisanship:4}});
    assert.deepEqual(after.roster.dispatch.job.map(e=>[e.member,e.share]),[[0,.5],[1,.5]]);
    assert.equal(before.roster.dispatch.job[0].share,1);
});

test('comparison reports overload on owned workers instead of inventing copies',()=>{
    const result=workerUsage({roster_workload:[2.6]},input());
    assert.equal(result.assignments.get(0),2);
    assert.equal(result.peak,1.3);
});
const plan = (coins=10,wood=2) => ({success:true,proven_optimal:true,rate_per_second:coins,season_points:1,
    priorities:[{target:'season_points',per_second:1},{target:'Wood Blocks',per_second:wood}],
    comparison_scores:{crop_variety:26,material_pace:.3,material_work:3},
    level_up_preview:{seconds:1_000,requirements:[{name:'standard_planks',per_second:.1}]},coin_items:[]});

test('real replacements match the family and recommend the relevant personality for one copy', () => {
    const original = { roster: { members: [{ count: 2, abilities: { Leisure: 3 }, family: 'required' }],
        personalities: { 'Dewy House': 'Faithful' } } };
    const baseline = { coin_items: [{ facility: 'Dewy House', item_name: 'gem', status: 'producing', crew: 0, facility_count: 1 }] };
    const recipes = [{ facility: 'Dewy House', name: 'gem', aniimo: ['Leisure',3], family: 'required' }];
    const catalog = [{ id: 'wrong', abilities: { Leisure: 4 }, family: 'elsewhere' },
        { id: 'right', abilities: { Leisure: 4 }, family: 'required' },
        { id: 'duplicate', abilities: { Leisure: 4 }, family: 'required' }];
    const [candidate, duplicate] = replacementCandidates(original, baseline, recipes, catalog, [{ names: ['Faithful','Tenacious'] }]);
    assert.equal(duplicate, undefined);
    assert.equal(candidate.entry.id, 'right');
    assert.deepEqual(candidate.traits, ['Faithful']);
    assert.deepEqual(candidate.input.roster.members.map(member => member.count), [1,1]);
    assert.equal(original.roster.members[0].count,2);
});

test('recommendations rank income, workers, then individual load and protect current priorities', () => {
    const base = input();
    const before = { ...plan(), roster_workload: [1.6], comparison_workloads: [[.9,.7]] };
    const income = compareRecommendations(before, { ...before, rate_per_second: 11 }, base, base);
    const fewer = compareRecommendations(before, { ...before, roster_workload: [.8], comparison_workloads: [[.8]] }, base, base);
    const load = compareRecommendations(before, { ...before, roster_workload: [1.5], comparison_workloads: [[.8,.7]] }, base, base);
    assert.deepEqual([income.decisive.id,fewer.decisive.id,load.decisive.id], ['coins','working_aniimo','peak_workload']);
    assert.ok(income.score > fewer.score && fewer.score > load.score && load.score > 0);
    const loss = compareRecommendations(before, { ...plan(11,1), roster_workload: [.8] }, base, base);
    assert.equal(loss.direction,-1);
});

test('climate staffing and equal-watt generator swaps do not reach the solver', () => {
    const original = { roster: { members: [
        { count: 2, abilities: { Fire: 2 } }, { count: 1, abilities: { Lightning: 3 } },
        { count: 1, abilities: { Earth: 3 } },
    ], environment: { 'Heat Furnace': 'Fire' } } };
    const baseline = { staffing: [['Heat Furnace', 0, 1], ['Crackle Generator', 1, 1]],
        coin_items: [{ facility: 'Mine', item_name: 'ore', status: 'producing', crew: 2, busy_units: .5 }],
        generator_watts_by_lightning: [600, 800, 800, 800] };
    const recipes = [{ facility: 'Mine', name: 'ore', aniimo: ['Earth',3] }, { facility: 'Stove', name: 'soup', aniimo: ['Fire',2] }];
    const catalog = [{ id: 'infergon', abilities: { Fire: 4, Earth: 4 } },
        { id: 'fenmane', abilities: { Lightning: 4, Earth: 4 } }];
    const check = plan => new Set(replacementCandidates(original, plan, recipes, catalog, []).map(row => row.index));
    assert.deepEqual(check(baseline), new Set([2]), 'higher skill and extra abilities do not improve a full fixed post');
    assert.deepEqual(check({ ...baseline, generator_watts_by_lightning: [600, 800, 1200, 1500] }), new Set([1,2]),
        'Lightning only matters when it increases actual power');
    assert.deepEqual(check({ ...baseline, coin_items: [...baseline.coin_items,
        { facility: 'Stove', item_name: 'soup', status: 'producing', crew: 0, busy_units: .5 }] }), new Set([0,2]));
});

test('comparison totals use checked shifts and add the actual courier work once', () => {
    const checked = { roster_workload: [1.9, .2], coin_items: [{ status: 'producing', crew: 0, busy_units: .1 }],
        staffing: [['Cooling Unit', 0, 1]], hauling_staffing: [[0, .01]],
        delivery_assignments: [[0, .2]] };
    const usage = workerUsage(checked, input());
    assert.equal(usage.working, 3);
    assert.equal(usage.peak, 1.05);
    assert.equal(usage.additional, 1);
    assert.ok(Math.abs(usage.hours - 55.2) < 1e-9);
});

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

test('workload includes crop jobs, walking and delivery, and counts local workplaces separately', () => {
    const p={coin_items:[{status:'producing',crew:0,facility:'Crafting Table',busy_units:.5}],
        staffing:[['Sunlamp',1,1]],crop_assignments:[['Water',1,0,.1]],movement_staffing:[[0,.1]],
        workplace_anchors:[[0,2]],
        hauling_staffing:[[0,.9]],delivery_assignments:[[0,.05]]};
    const usage=workerUsage(p,input());
    assert.ok(Math.abs(usage.busy.get(0)-.75)<1e-10);
    assert.equal(usage.working,3); assert.equal(usage.additional,1);
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

test('the screenshot case is an inconclusive search, not an upgrade-caused income loss',()=>{
    const before=plan(3_506_373/86400),after=plan(2_851_758/86400);after.proven_optimal=false;
    const comparison=comparePlans(before,after,input());
    assert.equal(comparison.direction,-1);
    assert.equal(comparison.inconclusiveLoss,true);
    after.proven_optimal=true;
    assert.equal(comparePlans(before,after,input()).inconclusiveLoss,false);
});

test('a repeat search or its timeout cannot discard a better checked alternative',()=>{
    const previous={plan:plan(12)},poor={plan:{...plan(8),proven_optimal:false}};
    assert.equal(keepBetterComparison(previous,poor,input()).plan,previous.plan);
    assert.equal(keepBetterComparison(previous,{error:'timeout'},input()).retained,true);
    assert.equal(keepBetterComparison(previous,{plan:plan(14)},input()).plan.rate_per_second,14);
});

test('a failed preliminary search is explained without a misleading before/after loss table',async()=>{
    const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('function comparisonTable('),source.indexOf('function renderImprovements('));
    const render=new Function('translate',`${code};return comparisonTable;`)(s=>s);
    const after={...plan(8),proven_optimal:false};
    const html=render(comparePlans(plan(),after,input()));
    assert.ok(!html.includes('<table'));
    assert.ok(html.includes('does not show that the upgrade reduces production'));
});

test('comparison worker runs the complete planner per change and reports progress and failures independently', async () => {
    const source=await readFile(new URL('../web/worker.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('async function rankImprovements('),source.indexOf('self.onmessage ='));
    const calls=[],reports=[];
    const run=new Function('switchingWorkshops','exactPlanJson','comparisonSearch','solveModel',`${code};return rankImprovements;`)(switchingWorkshops,async(_,payload,step)=>{
        const p=JSON.parse(payload);calls.push(p);
        step('priority:coins','start');
        if(p.fail)throw Error('Cannot check this change');
        return JSON.stringify(plan(p.coins));
    },Promise.resolve({createComparisonSearch}),()=>{});
    await run({},JSON.stringify({base:input(),basePlan:plan(),candidates:[{coins:12},{fail:true},{coins:15}]}),r=>reports.push(r));
    assert.equal(calls.length,3);
    assert.ok(reports.some(r=>r.index===0&&r.step==='priority:coins'));
    assert.ok(reports.some(r=>r.index===1&&r.error));
    assert.equal(reports.find(r=>r.index===2&&r.plan).plan.rate_per_second,15);
});

test('detailed comparison retries without baseline floors when an integer-feasible alternative needs lower goals',async()=>{
    const source=await readFile(new URL('../web/worker.js',import.meta.url),'utf8');
    const code=source.slice(source.indexOf('async function rankImprovements('),source.indexOf('self.onmessage ='));
    const original={...plan(),comparison_goals:{floors:[['Wood Blocks',10]]}};
    let calls=0;const reports=[];
    const run=new Function('switchingWorkshops','exactPlanJson','comparisonSearch','solveModel',`${code};return rankImprovements;`)(switchingWorkshops,
        async(_,payload,step,first,comparison)=>{
            calls++;
            const certified=await comparison.bound({variables:1,tiebreak:[],primary_objective:[[0,1]],
                lp:'Maximize\n obj: + 1 x0\nSubject To\n c0: + 1 x0 <= 10\nBounds\n x0 >= 0\nGeneral\n x0\nEnd'},'Wood Blocks');
            if(certified)throw Error('The baseline floor is integer-infeasible for this trait replacement');
            return JSON.stringify(plan(12));
        },Promise.resolve({createComparisonSearch}),async()=>({objective:10,values:[10],proven:true}));
    await run({},JSON.stringify({base:input(),basePlan:original,candidates:[input()],detailed:true}),r=>reports.push(r));
    assert.equal(calls,2);
    assert.equal(reports.find(r=>r.index===0).plan.rate_per_second,12);
});

test('preparing suggestions does not launch searches, and a check stays in its category', async () => {
    const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
    const stop=source.slice(source.indexOf('function stopRanking()'),source.indexOf('// How many of a facility'));
    const run=source.slice(source.indexOf('function rankImprovementsFor('),source.indexOf('function comparisonPhase('));
    const workers=[],timers=new Set(),baseline=plan(),base=input();
    class FakeWorker {
        constructor(){workers.push(this);}
        terminate(){this.terminated=true;}
        postMessage(message){this.id=message.id;this.message=JSON.parse(message.payload);}
        reply(count){this.onmessage({data:{id:this.id,type:'progress',count}});}
    }
    const api=new Function('Worker','setTimeout','clearTimeout','baseline','base','keepBetterComparison','startComparisonQueue','comparisonConcurrency',`
        let rankRunId=0,rankWorkers=[],rankCleanups=[],ranking=null,rankingsBySetup={};
        const mainSolve=null,setupSolve=null,layoutWorker=null,powerTeamController=null,lastLayout=null,lastPlan=baseline,lastPlanInput=base;
        const plansBySetup={roster:baseline},WORKER_URL='worker',SETUP_TIMEOUT=100;
        const aniimoInput=()=>({}),haulingRouteBound=()=>0,renderImprovements=()=>{};
        const improvementCandidates=()=>({candidates:[0,1,2].map(i=>({kind:i===2?'Recipes':'Aniimo',input:{...base,change:i}}))});
        const opportunityWorkload=plan=>plan,opportunityIndividualLoads=plan=>plan,compareRecommendations=()=>({});
        const comparisonPhase=step=>step;
        const navigator={hardwareConcurrency:4,deviceMemory:4};
        ${stop}\n${run}
        return {run:rankImprovementsFor,stop:stopRanking,state:()=>ranking};
    `)(FakeWorker,fn=>{timers.add(fn);return fn;},id=>timers.delete(id),baseline,base,keepBetterComparison,startComparisonQueue,comparisonConcurrency);
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
    api.run('roster','Aniimo');
    assert.deepEqual(workers.slice(2).flatMap(w=>w.message.candidates.map(c=>c.change)),[0]);
    api.stop();
});

test('opportunity workloads are recalculated once for both rendered and fresh plans', async () => {
    const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('function opportunityWorkload('), source.indexOf('function opportunityIndividualLoads('));
    const { haulingWorkload, allocateHauling } = await import('../web/hauling.js');
    const { layoutWalkingAdjustments, projectLayoutWork } = await import('../web/worker-travel.js');
    const { buildDispatch, rosterJobSwitching } = await import('../web/task-switching.js');
    const project = new Function('workerUsage', 'haulingWorkload', 'allocateHauling', 'buildDispatch',
        'rosterJobSwitching', 'recipeIndex', 'RESIDENT_FACILITIES', 'layoutWalkingAdjustments', 'projectLayoutWork', body + ';return opportunityWorkload;')(
        workerUsage, haulingWorkload, allocateHauling, buildDispatch, rosterJobSwitching, [], new Set(), layoutWalkingAdjustments, projectLayoutWork);
    const input = {roster:{members:[{count:1,abilities:{Hauling:3}}]},facilities:{}};
    const layout = {storages:[{x:-1,y:-1,w:2,h:2}],pieces:[{members:[
        {x:7,y:-1,w:2,h:2,weight:60,facility:'Well',crop:'water'},
    ]}]};
    const raw = {roster_workload:[.95],coin_items:[
        {facility:'Well',item_name:'water',status:'producing',facility_count:1,cycle_time:60},
    ]};
    const once = project(raw, input, layout);
    const twice = project(once, input, layout);
    assert.deepEqual(twice.delivery_assignments, once.delivery_assignments);
    assert.equal(workerUsage(twice,input).working,workerUsage(once,input).working);
    assert.equal(workerUsage(twice,input).hours,workerUsage(once,input).hours);
});

test('worker savings are not claimed when an alternative needs an unverified layout', () => {
    const original={...plan(),roster_workload:[2]};
    const alternative={...plan(),roster_workload:[1],comparison_workload_valid:false};
    const report=compareRecommendations(original,alternative,input(),input());
    assert.equal(report.direction,0);
    assert.ok(!report.rows.some(row=>row.id==='working_aniimo'));
});
