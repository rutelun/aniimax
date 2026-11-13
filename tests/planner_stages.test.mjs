import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {searchMaterials} from '../web/material-search.js';
import {productionObjective,productionCertificate,withProductionBounds} from '../web/priority-search.js';
import {autoMaximizeSeasonPoints,hasSeasonCropMinimums} from '../web/season-planning.js';

const source = await readFile(new URL('../web/worker.js', import.meta.url), 'utf8');
const pipeline = source.slice(source.indexOf('function hasMaterialProcessors'), source.indexOf('// Ranks changes the player could make'));

function planner(materialResult, priorities = ['coins'], extra = {}) {
    const calls = [], checks = [], progress = [];
    const result = (objective = 10) => ({objective,values:[.5,1],proven:true});
    const solveModel = async (problem, options, message, incumbent) => {
        calls.push({problem,options,incumbent});
        if (problem.lp === 'upgrade') return {objective:.3,values:[.5,1,.3],proven:true};
        return problem.lp === 'materials' ? materialResult : result();
    };
    const pkg = {
        exact_byproduct_problems: () => '[]', exact_crop_variety_problem: () => '{}',
        exact_level_up_problem: payload => JSON.parse(payload).level_up ? '{"lp":"level-up","variables":2}' : '{}',
        exact_priority_problem: (_, stage, target) => JSON.stringify({lp:`priority:${target}`,variables:2}),
        exact_problem: (_, stage) => {
            const settings = JSON.parse(stage);
            return JSON.stringify({lp:settings.maximize_upgrade_materials?'upgrade':settings.maximize_material_work?'materials':'final',
                variables:settings.maximize_upgrade_materials||settings.material_pace!=null?3:2,stage:settings});
        },
        exact_plan: (_, stage, solved) => {
            checks.push({stage:JSON.parse(stage),solved:JSON.parse(solved)});
            return JSON.stringify({success:true,rate_per_second:10});
        },
    };
    const run = new Function('solveModel', 'materialSearch','prioritySearch','autoMaximizeSeasonPoints','hasSeasonCropMinimums', `const SOLVE_OPTIONS={time_limit:30}, STRICT_OPTIONS={}, SEASON_POINTS='season_points';
        const newHighs=async()=>({solve:()=>({})}), incumbentSolver=Promise.resolve({polishSolution:(_,__,r)=>r});
        ${pipeline}; return exactPlanJson;`)(solveModel, Promise.resolve({searchMaterials}),Promise.resolve({productionObjective,productionCertificate,withProductionBounds}),autoMaximizeSeasonPoints,hasSeasonCropMinimums);
    return {calls,checks,progress, result, run:()=>run(pkg, JSON.stringify({currency:'coins',priorities,
        facilities:{'Woodworking Bench':[{count:2,level:2}]},...extra}), (...event)=>progress.push(event))};
}

test('reserved event crops do not add a points floor to an RV level-up plan', async () => {
    const base = {
        season:'magical_wonder_night', level_up_strategy:true,
        level_up:{cost:[['coins',100]],stock:[]},
        facilities:{'Woodworking Bench':[],'Chimney Kiln':[]},
    };
    const reserved = planner(null, [], {...base, season_crop_minimums:{magic_pumpkin:4,memory_lanternfruit:4}});
    await reserved.run();
    assert.ok(reserved.calls.some(({problem}) => problem.lp === 'level-up'));
    assert.ok(reserved.checks.every(({stage}) => stage.pace === 10 && !stage.floors.length));
    assert.ok(!reserved.calls.some(({problem}) => problem.lp === 'priority:season_points'));

    const noMinimum = planner(null, [], {...base, season_crop_minimums:{magic_pumpkin:0}});
    await noMinimum.run();
    assert.deepEqual(noMinimum.checks.at(-1).stage.floors,[['season_points',10]]);
});

test('an explicit points priority still runs with reserved event crops', async () => {
    const p = planner(null, ['season_points','coins'], {
        season:'magical_wonder_night',season_crop_minimums:{magic_pumpkin:4,memory_lanternfruit:4},
        facilities:{'Woodworking Bench':[],'Chimney Kiln':[]},
    });
    await p.run();
    assert.deepEqual(p.calls.map(({problem}) => problem.lp),['priority:season_points','priority:coins']);
    assert.deepEqual(p.checks.at(-1).stage.floors,[['season_points',10],['coins',10]]);
});

test('reuses the last coin priority, seeds material search and deduplicates its coin floor', async () => {
    const p = planner({objective:2,values:[.5,1],proven:true});
    const result = JSON.parse(await p.run());
    assert.ok(result.success);
    assert.deepEqual(p.calls.map(call=>call.problem.lp),['priority:coins','materials']);
    assert.deepEqual(p.calls[1].incumbent,[.5,1]);
    assert.equal(p.calls[1].options.time_limit,30);
    assert.equal(p.checks.at(-1).stage.floors.filter(([name])=>name==='coins').length,1);
    assert.ok(p.progress.some(([step,state])=>step==='final'&&state==='skip'));
});

test('a spare workload timeout preserves the checked plan with RV materials', async () => {
    const p = planner(null, ['coins'], {
        level_up_preview:{cost:[['coins',100],['standard_planks',10]],stock:[]},
    });
    const plan = JSON.parse(await p.run());
    assert.ok(plan.success);
    assert.equal(plan.material_work_note, 'unproven');
    assert.equal(plan.comparison_scores.material_pace, .3);
    assert.equal(p.checks.at(-1).stage.maximize_upgrade_materials, true);
    assert.deepEqual(p.checks.at(-1).solved.values, [.5,1,.3]);
    assert.ok(p.progress.some(([step,state])=>step==='materials'&&state==='fail'));
});

test('a material timeout without an RV material plan does not claim to satisfy the option', async () => {
    const p = planner(null);
    await assert.rejects(p.run(), /Woodworking Bench and Chimney Kiln workload/);
    assert.equal(p.checks.length, 0);
});

test('a feasible time-limited material solution is shown without claiming a proven maximum', async () => {
    const p = planner({objective:1,values:[.5,1],proven:false});
    const plan = JSON.parse(await p.run());
    assert.equal(plan.material_work_note,'unproven');
    assert.equal(p.checks.at(-1).solved.proven,false);
});

test('coins are solved again when a later priority changed the feasible region', async () => {
    const p = planner({objective:2,values:[.5,1],proven:true}, ['coins','Wood Blocks']);
    await p.run();
    assert.deepEqual(p.calls.map(call=>call.problem.lp),['priority:coins','priority:Wood Blocks','final','materials']);
});

test('reserves finished RV materials before maximizing intermediate processor workload', async () => {
    const p = planner({objective:2,values:[.5,1,.3],proven:true},['coins'],{
        level_up_preview:{cost:[['coins',100],['standard_planks',10],['sintered_ore_brick',10]],stock:[]},
    });
    await p.run();
    assert.deepEqual(p.calls.map(c=>c.problem.lp),['priority:coins','upgrade','materials']);
    assert.deepEqual(p.calls[1].incumbent,[.5,1,0]);
    assert.equal(p.calls[2].problem.stage.material_pace,.3);
    assert.deepEqual(p.calls[2].problem.stage.floors,[['coins',10]]);
    assert.equal(p.checks.at(-1).stage.material_pace,.3);
});

test('materials already in stock do not trigger an unnecessary RV production search', async () => {
    const p = planner({objective:2,values:[.5,1],proven:true},['coins'],{
        level_up_preview:{cost:[['coins',100],['standard_planks',10]],stock:[['standard_planks',10]]},
    });
    await p.run();
    assert.deepEqual(p.calls.map(c=>c.problem.lp),['priority:coins','materials']);
});

test('initial planning remaps the incumbent when a new priority inserts or reorders sale variables',async()=>{
    const calls=[];
    const solveModel=async(problem,options,message,seed)=>{
        calls.push({lp:problem.lp,seed});
        return {objective:1,proven:true,values:problem.lp==='coins'?[.3,.2]:problem.lp==='wood'?[.4,.3,.2]:[.3,.2,.4]};
    };
    const pkg={
        exact_byproduct_problems:()=> '[]',exact_level_up_problem:()=> '{}',
        exact_priority_problem:(_,__,target)=>JSON.stringify(target==='coins'
            ? {lp:'coins',variables:2,variable_keys:['rate','sold:coins']}
            : {lp:'wood',variables:3,variable_keys:['sold:wood','rate','sold:coins']}),
        exact_problem:()=>JSON.stringify({lp:'final',variables:3,variable_keys:['rate','sold:coins','sold:wood']}),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1}),
    };
    const run=new Function('solveModel','prioritySearch','autoMaximizeSeasonPoints','hasSeasonCropMinimums',`const SOLVE_OPTIONS={time_limit:30},STRICT_OPTIONS={},SEASON_POINTS='season_points';
        const newHighs=async()=>({solve:()=>({})}), incumbentSolver=Promise.resolve({polishSolution:(_,__,r)=>r});
        ${pipeline};return exactPlanJson;`)(solveModel,Promise.resolve({productionObjective,productionCertificate,withProductionBounds}),autoMaximizeSeasonPoints,hasSeasonCropMinimums);
    await run(pkg,JSON.stringify({currency:'coins',priorities:['coins','Wood Blocks'],facilities:{'Woodworking Bench':[],'Chimney Kiln':[]}}));
    assert.deepEqual(calls[1].seed,[0,.3,.2]);
    assert.deepEqual(calls[2].seed,[.3,.2,.4]);
});

test('a proved earlier currency maximum passes directly to materials; unproved or no-processor plans still search currency',async()=>{
    for (const [proved,processors,expected,available=true] of [[true,true,false],[false,true,true],[true,false,true],[true,true,true,false]]) {
        const calls=[],keys=['rate','units'];
        const solveModel=async(problem)=>{
            calls.push(problem);
            return {values:[.5,1],objective:problem.label==='coins'?10:problem.label==='wood'?5:2,
                proven:problem.label!=='coins'||proved};
        };
        const model=label=>({label,lp:`model:${label}`,variables:2,variable_keys:keys,primary_objective:[[0,1]],tiebreak:[]});
        const pkg={exact_byproduct_problems:()=> '[]',exact_level_up_problem:()=> '{}',
            exact_priority_problem:(_,__,target)=>JSON.stringify(model(target==='coins'?'coins':'wood')),
            exact_problem:(_,stage)=>JSON.stringify(JSON.parse(stage).maximize_material_work&&!available ? {}
                : {...model(JSON.parse(stage).maximize_material_work?'materials':'final'),stage:JSON.parse(stage)}),
            exact_plan:()=>JSON.stringify({success:true,rate_per_second:10})};
        const run=new Function('solveModel','prioritySearch','materialSearch','autoMaximizeSeasonPoints','hasSeasonCropMinimums',`const SOLVE_OPTIONS={time_limit:30},STRICT_OPTIONS={},SEASON_POINTS='season_points';
            const newHighs=async()=>({solve:()=>({})}),incumbentSolver=Promise.resolve({polishSolution:(_,__,r)=>r});
            ${pipeline};return exactPlanJson;`)(solveModel,Promise.resolve({productionObjective,productionCertificate,withProductionBounds}),Promise.resolve({searchMaterials}),autoMaximizeSeasonPoints,hasSeasonCropMinimums);
        await run(pkg,JSON.stringify({currency:'coins',priorities:['coins','Wood Blocks'],
            facilities:{'Woodworking Bench':[{count:processors?1:0}],'Chimney Kiln':[]}}));
        assert.equal(calls.some(p=>p.label==='final'),expected,`proved=${proved}, processors=${processors}`);
        if(processors&&available)assert.deepEqual(calls.find(p=>p.label==='materials').stage.floors,[['Wood Blocks',5],['coins',10]]);
    }
});
