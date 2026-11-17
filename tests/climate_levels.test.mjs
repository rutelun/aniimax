import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as pkg from '../web/pkg/aniimax.js';
import highsModule from '../web/vendor/highs/highs.mjs';
import {recommendBestTeam} from '../web/best-team.js';

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
