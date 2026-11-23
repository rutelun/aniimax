import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const pages = process.env.ANIIMAX_PAGES_DIR;
const workerUrl = pages ? pathToFileURL(join(pages, 'worker.js')) : new URL('../web/worker.js', import.meta.url);
workerUrl.searchParams.set('load', 'worker-test');
const wasm = new URL('pkg/aniimax_bg.wasm', workerUrl);
if (pages) assert.ok(existsSync(wasm), 'Packaged site must include the planner WASM');
const worker = {performance};

async function bestPlan(input) {
    const originalFetch = globalThis.fetch;
    let reply;
    globalThis.self = worker;
    worker.postMessage = message => {
        if (message.type !== 'progress') reply = message;
    };
    globalThis.fetch = async url => new Response(await readFile(url), {
        headers: {'Content-Type': 'application/wasm'},
    });
    try {
        await import(workerUrl.href);
        await self.onmessage({data:{id:1, type:'find_plan', payload:JSON.stringify(input)}});
    } finally {
        globalThis.fetch = originalFetch;
        delete globalThis.self;
    }
    assert.ok(reply.ok, reply.error);
    return JSON.parse(reply.result);
}

test('Best retains the audited seasonal RV16 shift across all priorities',
    {skip:!existsSync(wasm)}, async () => {
    const input = JSON.parse(await readFile(new URL('./fixtures/rv16-best-production.json', import.meta.url)));
    const plan = await bestPlan(input);
    assert.ok(plan.success, plan.error);
    assert.equal(plan.continuous_production_checked, true);
    assert.deepEqual(plan.comparison_goals.floors.map(([name]) => name), input.priorities.slice(1));
    assert.ok(plan.comparison_goals.pace >= .19221);
    // The reserved seasonal crops take 30 minutes per harvest after watering.
    assert.ok(plan.rate_per_second >= 69.28794);
    assert.ok(plan.upper_bound >= plan.rate_per_second - 1e-8);
    assert.ok(plan.upper_bound <= plan.rate_per_second * 1.002 + 1e-8);
    const floors = Object.fromEntries(plan.comparison_goals.floors);
    assert.ok(floors['Wood Blocks'] >= .70833);
    assert.ok(floors.aniipods >= .0007777);
    assert.ok(floors['Mineral Sand'] >= .57351);
});

for (const [rv, maximum] of [[20,497349.93333333335],[21,644470.1777777778]]) {
    test(`RV${rv} coins finds the audited maximum with fixed recipes`, {skip:!existsSync(wasm)}, async () => {
        const {simpleSetup, LEVEL_UP_COSTS} = await import('../web/facility-config.js');
        const levels = {Fire:4,Water:4,Earth:4,Lightning:4,Wind:4,Dark:4,Artisanship:4,Leisure:4,Perfumery:3};
        const next = LEVEL_UP_COSTS[rv+1];
        const plan = await bestPlan({
            ...simpleSetup(rv), e_mode_rv:rv, currency:'coins', always_running:true, priorities:['coins'],
            aniimo:'best:'+Object.entries(levels).map(([name,level])=>name+level).join(','), aniimo_levels:levels,
            exclude:['harvest_platter','umbral_pickle','umbral_hot_pot','umbral_sweet_and_spicy_sauce'],
            level_up_preview:{cost:[['coins',next.coins],...next.items], stock:[]},
        });
        assert.ok(plan.success, plan.error);
        assert.equal(plan.continuous_production_checked, true);
        assert.ok(Math.abs(plan.rate_per_second*3600 - maximum) < .01, String(plan.rate_per_second*3600));
        if (rv === 20) {
            const diamonds = plan.income_streams.find(stream => stream.item_name === 'star_diamond');
            assert.ok(Math.abs(diamonds.units_per_second * 3600 - 6.4) < 1e-6);
        }
        if (rv === 21) {
            const incense = plan.coin_items.find(step => step.item_name === 'orange_flower_incense');
            assert.equal(incense?.aniimo?.level, 1);
            assert.equal(incense.cycle_time, incense.aniimo.personality_bonus ? 270 : 324);
        }
        assert.ok(plan.upper_bound >= plan.rate_per_second - 1e-8);
        assert.ok(plan.upper_bound <= plan.rate_per_second * 1.002 + 1e-8);
    });
}

test('one shared daily recipe change supplies both RV materials from one bench and one kiln',
    {skip:!existsSync(wasm)}, async () => {
        const {simpleSetup} = await import('../web/facility-config.js');
        const {facilities,modules} = simpleSetup(3);
        const workshops = ['Woodworking Bench','Chimney Kiln'];
        for (const facility of workshops) facilities[facility] = [{count:1,level:2}];
        for (const priorities of [['level_up','coins'], ['coins']]) {
            const plan = await bestPlan({facilities, modules, currency:'coins', always_running:true,
                aniimo:'best', aniimo_levels:{Artisanship:4,Fire:4,Water:4,Earth:4,Wind:4,Lightning:4},
                priorities, quest_income_per_day:{wood_block:86400,mineral_sand:86400},
                level_up_preview:{cost:[['standard_planks',10],['sintered_ore_brick',10]],stock:[]}});
            assert.ok(plan.success, plan.error);
            assert.ok(plan.level_up_preview?.seconds > 0);
            assert.deepEqual(plan.recipe_schedule.switchedBuildings.toSorted(),workshops.map(f => f + ':1').toSorted());
            assert.equal(plan.recipe_schedule.switches.length,1);
        }
    });
