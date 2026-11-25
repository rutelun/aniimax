import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pkg from '../web/pkg/aniimax.js';
import highsModule from '../web/vendor/highs/highs.mjs';
import {recommendBestTeam} from '../web/best-team.js';
import {refineStaffing} from '../web/staffing-search.js';

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
