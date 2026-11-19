import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {refineStaffing} from '../web/staffing-search.js';

const wasm = new URL('../web/pkg/aniimax_bg.wasm', import.meta.url);
for (const [sand, canSwap] of [[800, true], [800000, false]]) {
test(canSwap ? 'a supply-limited kiln releases a faster producer from a permanent furnace post'
        : 'a continuously running kiln keeps its producer if a swap would change the output',
    {skip:!fs.existsSync(wasm)}, async () => {
    const pkg = await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasm)});
    const highs = await highsModule({
        wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm', import.meta.url)),
        print(){}, printErr(){},
    });
    const input = {currency:'coins', always_running:true, aniimo:'roster',
        quest_income_per_day:{mineral_sand:sand}, level_up:{cost:[['coarse_sifted_ore',100]],stock:[]},
        fixed_homeland:{groups:[{facility:'Chimney Kiln',count:1,level:1,lit:false,powered:false}],
            climate:{'Heat Furnace':2},generators:0},
        roster:{members:[{count:2,abilities:{Fire:3,Artisanship:4}},{count:1,abilities:{Fire:2}}],
            environment:{'Heat Furnace':'Fire'}, residents:[], movement_seconds:5}};
    const payload = JSON.stringify(input), stage = JSON.stringify({pace:1});
    const problem = JSON.parse(pkg.exact_problem(payload, stage));
    const solve = async p => {
        const result = highs.solve(p.lp, {mip_rel_gap:0, mip_abs_gap:0});
        if (result.Status !== 'Optimal') return null;
        return {values:Array.from({length:p.variables}, (_,i)=>result.Columns['x'+i]?.Primal??0),
            objective:result.ObjectiveValue,proven:true};
    };
    const furnace = problem.variable_keys.indexOf('staff:Heat Furnace:owned:0#0');
    assert.ok(furnace >= 0);
    const incumbent = await solve({...problem,lp:problem.lp.replace('Subject To',
        'Subject To\n original_staff: x'+furnace+' = 2')});
    assert.ok(incumbent);
    const report = result => JSON.parse(pkg.exact_plan(payload, stage, JSON.stringify({...result,bound:0})));
    const before = report(incumbent);
    assert.equal(before.success, true, before.error);
    const after = report(await refineStaffing(problem, incumbent, solve));
    assert.equal(after.success, true, after.error);
    assert.equal(after.staffing.some(([building,member,count]) => building==='Heat Furnace' && member===1 && count===1), canSwap);
    const kilnRate = plan => plan.coin_items.filter(row=>row.item_name==='coarse_sifted_ore' && row.status==='producing')
        .reduce((total,row)=>total+row.busy_units/row.cycle_time,0);
    assert.ok(kilnRate(before)>0);
    assert.ok(Math.abs(kilnRate(before)-kilnRate(after))<1e-9);
    const days = plan => plan.roster_workload.reduce((a,b)=>a+b,0);
    if (canSwap) assert.ok(days(after) < days(before) - 1e-4);
    else assert.ok(Math.abs(days(after)-days(before)) < 1e-8);
    assert.equal(after.level_up.seconds,before.level_up.seconds);
});
}

test('a shorter shift cannot spread one active worker across two new workers',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const p={variables:3,lp:'Maximize\n obj: + 1 x0\nSubject To\n jobs: x0 + x1 + x2 = 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 0.5\n 0 <= x2 <= 0.5\nEnd\n',
        staffing_groups:[[0,1,2]],
        staffing_pools:[0.8,0.4,0.4].map((time,i)=>({work:[[i,time]],crop:[],anchors:[],reserve:false,active:null}))};
    const before={values:[1,0,0]},after=await refineStaffing(p,before,async problem=>{
        const result=highs.solve(problem.lp);
        assert.equal(result.Status,'Optimal');
        return {values:[0,1,2].map(i=>result.Columns['x'+i].Primal)};
    });
    assert.deepEqual(after.values,before.values);
});

test('a quicker workshop worker keeps the slack needed for its existing harvest jobs',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const p={variables:3,lp:'Maximize\n obj: + 1 x0\nSubject To\n harvest: x0 = 1\n workshop: x1 + x2 = 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\n 0 <= x2 <= 1\nEnd\n',
        staffing_groups:[[0],[1,2]],staffing_pools:[
            {work:[[0,0.4],[2,0.2]],crop:[0],anchors:[],reserve:false,active:null},
            {work:[[1,0.8]],crop:[],anchors:[],reserve:false,active:null},
        ]};
    const original={values:[1,1,0]};
    const after=await refineStaffing(p,original,async problem=>{
        const result=highs.solve(problem.lp);
        assert.equal(result.Status,'Optimal');
        return {values:[0,1,2].map(i=>result.Columns['x'+i].Primal)};
    });
    assert.deepEqual(after.values,original.values);
});
