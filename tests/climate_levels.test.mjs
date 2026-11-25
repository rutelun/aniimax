import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pkg from '../web/pkg/aniimax.js';
import highsModule from '../web/vendor/highs/highs.mjs';
import {recommendBestTeam} from '../web/best-team.js';
import {refineStaffing} from '../web/staffing-search.js';
import {solveWithIncumbent} from '../web/highs-solve.js';
import {tryPriorityPlan} from '../web/continuous-priority-plan.js';

test('Best uses real level-2 workers for strong climate jobs', () => {
    for (const [ability, label] of [['Ice','Cooling Unit (Freeze)'], ['Fire','Heat Furnace (Scorching)']]) {
        const {shifts} = recommendBestTeam([{ability, level:2, label, busy:1, fixed:true}]);
        assert.equal(shifts.length, 1);
        assert.ok(shifts[0].entry);
        assert.ok(shifts[0].abilities[ability] >= 2);
        assert.ok(!['baleetle-snowfield','emberpup','emberpup-highland','emberpup-timberline'].includes(shifts[0].entry.id));
    }
});

test('roster LP rejects level-1 staffing of strong modes, including overlapping pairs', async () => {
    pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    for (const level of [1,2]) {
        const input = {currency:'coins',aniimo:'roster',facilities:{Farmland:[{count:4,level:5}],Woodland:[{count:4,level:5}], 'Heat Furnace':[{count:1,level:1}],'Cooling Unit':[{count:1,level:1}]},
            roster:{members:[{count:10,abilities:{Grass:3,Dark:3,Earth:3,Water:3,Hauling:3}}, {count:2,abilities:{Fire:level,Ice:level}}],environment:{'Heat Furnace':'Fire','Cooling Unit':'Ice'},residents:[],personalities:{}}};
        const problem = JSON.parse(pkg.exact_problem(JSON.stringify(input), '{}'));
        // Disable automatically suggested reserve workers to isolate owned eligibility.
        const noReserves = problem.variable_keys.flatMap((key, i) => key.startsWith('staff:') && key.includes('reserve:') ? [` no_reserve_${i}: x${i} = 0`] : []).join('\n');
        problem.lp = problem.lp.replace('Subject To', `Subject To\n${noReserves}\n`);
        const find = prefix => problem.variable_keys.findIndex(key => key.startsWith(prefix));
        const keys = ['environment:Heat Furnace:Warm:', 'environment:Heat Furnace:Scorching:', 'environment:Cooling Unit:Cool:', 'environment:Cooling Unit:Freeze:'];
        for (const prefix of keys) {
            const index = find(prefix);
            assert.ok(index >= 0, prefix);
            const result = highs.solve(problem.lp.replace('Subject To', `Subject To\n forced_mode: x${index} = 1\n`));
            const strong = /Scorching|Freeze/.test(prefix);
            assert.equal(result.Status, strong && level === 1 ? 'Infeasible' : 'Optimal', `${prefix} worker level ${level}`);
        }
        const pair = problem.variable_keys.findIndex(key => key.startsWith('pair:') && key.includes('Scorching'));
        assert.ok(pair >= 0);
        const result = highs.solve(problem.lp.replace('Subject To', `Subject To\n forced_pair: x${pair} = 1\n`));
        assert.equal(result.Status, level === 1 ? 'Infeasible' : 'Optimal');
    }
});

test('a single Scorching|Cool pair groups same-footprint Warm buildings together', async () => {
    pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const input = {
        currency:'coins',
        facilities:{
            Farmland:[{count:10,level:7}],
            Woodland:[{count:1,level:6}],
            'Starfall Hammock':[{count:2,level:2}],
            'Tidewhisper Sandcastle':[{count:2,level:3}],
            'Heat Furnace':[{count:1,level:1}],
            'Cooling Unit':[{count:1,level:1}],
        },
        modules:{ecological_module:8,resource_detector:0},
    };
    const problem = JSON.parse(pkg.exact_problem(JSON.stringify(input), '{}'));
    const sol = highs.solve(problem.lp, {mip_rel_gap:0, mip_abs_gap:0});
    assert.equal(sol.Status, 'Optimal');
    const values = Array.from({length:problem.variables}, (_, i) => sol.Columns['x'+i]?.Primal ?? 0);
    const plan = JSON.parse(pkg.exact_plan(JSON.stringify(input), '{}', JSON.stringify({values, proven:true, bound:sol.ObjectiveValue})));
    assert.equal(plan.success, true, plan.error);
    const warmZone = plan.environment_assignments.find(a => a.partner && a.mode === 'Warm');
    assert.ok(warmZone, 'expected a single overlapping pair supplying Warm');
    assert.equal(warmZone.units, 1);
    const covered = Object.fromEntries(warmZone.covered.map(c => [c.facility, c.count]));
    assert.equal(covered['Starfall Hammock'], 2);
    assert.equal(covered['Tidewhisper Sandcastle'], 2);
    assert.equal(warmZone.layouts[0].length, 4);
    assert.equal(warmZone.layouts[0].filter(p => p.facility === 'Starfall Hammock').length, 2);
    assert.equal(warmZone.layouts[0].filter(p => p.facility === 'Tidewhisper Sandcastle').length, 2);
});

test('refineStaffing replaces a redundant Scorching|Cool pair with standalone Warm when a furnace is free', async () => {
    pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const input = {
        currency:'coins',
        exclude:['quick_strawberry','strawberry','rose','ginseng','cranberry','star','apple','maple_syrup','quick_maple_syrup','sorghum','premium_potato','premium_wheat','quick_rice','quick_potato','cotton','soybean','rice','potato','wheat','quick_wheat'],
        facilities:{
            Farmland:[{count:10,level:8}],
            Woodland:[{count:0,level:1}],
            'Floral Windmill':[{count:0,level:1}],
            'Starfall Hammock':[{count:2,level:2}],
            'Tidewhisper Sandcastle':[{count:2,level:3}],
            'Heat Furnace':[{count:2,level:1}],
            'Cooling Unit':[{count:1,level:1}],
            Sunlamp:[{count:0,level:1}],
        },
        modules:{ecological_module:9,resource_detector:0},
    };
    const payload = JSON.stringify(input);
    const problem = JSON.parse(pkg.exact_problem(payload, '{}'));
    // Force an incumbent that uses a Scorching|Cool pair even though 2 standalone Heat Furnaces suffice.
    const pairIdx = problem.variable_keys.findIndex(k => k.startsWith('pair:') && k.includes('Scorching') && k.includes('Cool'));
    assert.ok(pairIdx >= 0);
    const forced = highs.solve(problem.lp.replace('Subject To', `Subject To\n force_pair: x${pairIdx} = 1\n`), {mip_rel_gap:0, mip_abs_gap:0});
    assert.equal(forced.Status, 'Optimal');
    const incumbent = {values: Array.from({length:problem.variables}, (_, i) => forced.Columns['x'+i]?.Primal ?? 0)};
    const solve = async model => {
        const res = highs.solve(model.lp, {mip_rel_gap:0, mip_abs_gap:0});
        if (res.Status !== 'Optimal') return null;
        return {values: Array.from({length:model.variables}, (_, i) => res.Columns['x'+i]?.Primal ?? 0)};
    };
    const refined = await refineStaffing(problem, incumbent, solve, {input});
    const plan = JSON.parse(pkg.exact_plan(payload, '{}', JSON.stringify({values:refined.values, proven:true, bound:forced.ObjectiveValue})));
    assert.equal(plan.success, true, plan.error);
    assert.ok(plan.environment_assignments.every(a => !a.partner), 'should drop the redundant overlapping pair');
    assert.ok(plan.environment_assignments.every(a => a.building === 'Heat Furnace'), 'should need zero Cooling Units');
    assert.deepEqual(plan.environment_assignments.map(a => a.mode).sort(), ['Scorching', 'Warm']);
});

test('refineStaffing drops a surplus climate building held by a depleted always_running worker', async () => {
    pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const input = {
        currency:'coins',
        always_running:true,
        aniimo:'roster',
        facilities:{
            Farmland:[{count:4,level:5}],
            'Starfall Hammock':[{count:1,level:2}],
            'Heat Furnace':[{count:2,level:1}],
            'Cooling Unit':[{count:0,level:1}],
            Sunlamp:[{count:0,level:1}],
        },
        roster:{
            members:[
                {count:1,abilities:{Fire:2}},
                {count:1,abilities:{Fire:2}},
                {count:4,abilities:{Grass:3,Dark:3,Earth:3,Water:3,Hauling:3}},
            ],
            environment:{'Heat Furnace':'Fire'},
            residents:[],
            personalities:{},
        },
    };
    const payload = JSON.stringify(input);
    const problem = JSON.parse(pkg.exact_problem(payload, '{}'));
    const warmIdx = problem.variable_keys.findIndex(k => k.startsWith('environment:Heat Furnace:Warm:'));
    const staff0 = problem.variable_keys.indexOf('staff:Heat Furnace:owned:0#0');
    const staff1 = problem.variable_keys.indexOf('staff:Heat Furnace:owned:1#0');
    assert.ok(warmIdx >= 0 && staff0 >= 0 && staff1 >= 0);
    // Find the always_running depletion indicators for both Fire workers: `- x{staff} + x{dep} <= 0`.
    const depFor = staffIdx => {
        const m = problem.lp.match(new RegExp(`-\\s*(?:1\\s+)?x${staffIdx}\\s+\\+\\s*(?:1\\s+)?x(\\d+)\\s*<=\\s*0`));
        assert.ok(m, `expected always_running depletion constraint for x${staffIdx}`);
        const idx = Number(m[1]);
        assert.ok(problem.variable_keys[idx].startsWith('extra#'));
        return idx;
    };
    const dep0 = depFor(staff0), dep1 = depFor(staff1);

    const forced = highs.solve(
        problem.lp.replace('Subject To',
            `Subject To\n force_warm: x${warmIdx} = 2\n force_staff0: x${staff0} = 1\n force_staff1: x${staff1} = 1\n force_dep0: x${dep0} = 1\n force_dep1: x${dep1} = 1\n`),
        {mip_rel_gap:0, mip_abs_gap:0},
    );
    assert.equal(forced.Status, 'Optimal');
    const incumbent = {values: Array.from({length:problem.variables}, (_, i) => forced.Columns['x'+i]?.Primal ?? 0)};
    const report = values => JSON.parse(pkg.exact_plan(payload, '{}', JSON.stringify({values, proven:true, bound:0, verify_only:true})));
    const warmUnits = plan => plan.environment_assignments.filter(a => a.mode === 'Warm').reduce((s, a) => s + a.units, 0);
    const before = report(incumbent.values);
    assert.equal(before.success, true, before.error);
    assert.equal(warmUnits(before), 2);
    assert.ok(incumbent.values[dep0] > 0.5 && incumbent.values[dep1] > 0.5);

    const solve = async model => {
        const res = highs.solve(model.lp, {mip_rel_gap:0, mip_abs_gap:0});
        if (res.Status !== 'Optimal') return null;
        return {values: Array.from({length:model.variables}, (_, i) => res.Columns['x'+i]?.Primal ?? 0)};
    };
    const refined = await refineStaffing(problem, incumbent, solve, {input, report});
    const after = report(refined.values);
    assert.equal(after.success, true, after.error);
    assert.equal(warmUnits(after), 1, 'should drop the empty Heat Furnace');
    assert.ok(refined.values[dep0] + refined.values[dep1] < 1.5, 'should clear freed worker depleted indicator in availability DAG');
    assert.ok(after.environment_assignments.every(a => (a.layouts || []).every(l => l.length > 0)));
    assert.ok(Math.abs(after.rate_per_second - before.rate_per_second) < 1e-6);

    // Also verify map_dispatch_pending drafts still run climate minimization without altering production.
    const draftRefined = await refineStaffing(problem, incumbent, solve, {
        input:{...input, map_dispatch_pending:true},
        report,
    });
    const draftAfter = report(draftRefined.values);
    assert.equal(draftAfter.success, true, draftAfter.error);
    assert.equal(warmUnits(draftAfter), 1, 'draft should also drop the empty Heat Furnace');
    assert.ok(Math.abs(draftAfter.rate_per_second - before.rate_per_second) < 1e-6);
});

test('tryPriorityPlan upgrades relax_pair_coverage plans to an overlapping Scorching|Cool pair when it saves a building', async () => {
    pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const input = {
        currency:'coins',
        always_running:true,
        relax_pair_coverage:true,
        priorities:['coins'],
        facilities:{
            Farmland:[{count:10,level:7}],
            Woodland:[{count:1,level:6}],
            'Starfall Hammock':[{count:2,level:2}],
            'Tidewhisper Sandcastle':[{count:2,level:3}],
            'Heat Furnace':[{count:2,level:1}],
            'Cooling Unit':[{count:1,level:1}],
            Sunlamp:[{count:0,level:1}],
        },
        modules:{ecological_module:8,resource_detector:0},
    };
    const solveModel = (p, options, _stage, seed) => {
        const r = solveWithIncumbent(highs, p, options, seed, false);
        return r.Columns ? {
            values: Array.from({length:p.variables}, (_, i) => r.Columns['x'+i]?.Primal ?? 0),
            objective: r.ObjectiveValue,
            proven: r.Status === 'Optimal',
            upper: r.UpperBound,
        } : null;
    };
    const plan = await tryPriorityPlan(pkg, input, {highs, solveModel});
    assert.ok(plan && plan.success, plan?.error || 'expected a verified plan');
    assert.ok(plan.environment_assignments.every(a => a.partner && a.units === 1), 'should use a single overlapping pair instead of 3 standalone units');
    assert.deepEqual(plan.environment_assignments.map(a => a.mode).sort(), ['Cool', 'Scorching', 'Warm']);
    assert.ok(plan.environment_assignments.every(a => (a.layouts || []).every(l => l.length > 0)));
});
