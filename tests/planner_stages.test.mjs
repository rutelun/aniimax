import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('../web/worker.js', import.meta.url), 'utf8');
const pipeline = source.slice(source.indexOf('function hasSeasonCropMinimums'), source.indexOf('// Ranks changes the player could make'));

function planner(materialResult, priorities = ['coins']) {
    const calls = [], checks = [], progress = [];
    const result = (objective = 10) => ({objective,values:[.5,1],proven:true});
    const solveModel = async (problem, options, message, incumbent) => {
        calls.push({problem,options,incumbent});
        return problem.lp === 'materials' ? materialResult : result();
    };
    const pkg = {
        exact_byproduct_problems: () => '[]', exact_level_up_problem: () => '{}',
        exact_priority_problem: (_, stage, target) => JSON.stringify({lp:`priority:${target}`,variables:2}),
        exact_problem: (_, stage) => JSON.stringify({lp:JSON.parse(stage).maximize_material_work?'materials':'final',variables:2}),
        exact_plan: (_, stage, solved) => {
            checks.push({stage:JSON.parse(stage),solved:JSON.parse(solved)});
            return JSON.stringify({success:true,rate_per_second:10});
        },
    };
    const run = new Function('solveModel', `const SOLVE_OPTIONS={time_limit:30}, STRICT_OPTIONS={}, SEASON_POINTS='season_points';
        ${pipeline}; return exactPlanJson;`)(solveModel);
    return {calls,checks,progress, result, run:()=>run(pkg, JSON.stringify({currency:'coins',priorities,
        facilities:{'Woodworking Bench':[{count:2,level:2}]}}), (...event)=>progress.push(event))};
}

test('reuses the last coin priority, seeds material search and deduplicates its coin floor', async () => {
    const p = planner({objective:2,values:[.5,1],proven:true});
    const result = JSON.parse(await p.run());
    assert.ok(result.success);
    assert.deepEqual(p.calls.map(call=>call.problem.lp),['priority:coins','materials']);
    assert.deepEqual(p.calls[1].incumbent,[.5,1]);
    assert.equal(p.calls[1].options.time_limit,5);
    assert.equal(p.checks.at(-1).stage.floors.filter(([name])=>name==='coins').length,1);
    assert.ok(p.progress.some(([step,state])=>step==='final'&&state==='skip'));
});

test('a secondary material timeout keeps the valid priority plan with an explicit note', async () => {
    const p = planner(null);
    const plan = JSON.parse(await p.run());
    assert.ok(plan.success);
    assert.equal(plan.material_work_note,'kept');
    assert.equal(p.checks.at(-1).stage.maximize_material_work,undefined);
    assert.ok(p.progress.some(([step,state])=>step==='materials'&&state==='fail'));
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
