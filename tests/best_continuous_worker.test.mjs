import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';

const wasm = new URL('../web/pkg/aniimax_bg.wasm', import.meta.url);
test('Best retains the audited RV16 shift through the wider priority search',
    {skip:!existsSync(wasm)}, async () => {
    const input = JSON.parse(await readFile(new URL('./fixtures/rv16-best-production.json', import.meta.url)));
    const originalFetch = globalThis.fetch;
    let reply;
    globalThis.self = {performance, postMessage(message) {
        if (message.type !== 'progress') reply = message;
    }};
    globalThis.fetch = async url => new Response(await readFile(url), {
        headers: {'Content-Type': 'application/wasm'},
    });
    try {
        await import('../web/worker.js');
        await self.onmessage({data:{id:1, type:'find_plan', payload:JSON.stringify(input)}});
    } finally {
        globalThis.fetch = originalFetch;
        delete globalThis.self;
    }
    assert.ok(reply.ok, reply.error);
    const plan = JSON.parse(reply.result);
    assert.ok(plan.success, plan.error);
    assert.equal(plan.continuous_production_checked, true);
    assert.deepEqual(plan.comparison_goals.floors.map(([name]) => name), input.priorities.slice(1));
    assert.ok(plan.comparison_goals.pace >= .19221);
    assert.ok(plan.rate_per_second >= 69.97628);
    const floors = Object.fromEntries(plan.comparison_goals.floors);
    assert.ok(floors['Wood Blocks'] >= .70833);
    assert.ok(floors.aniipods >= .0007777);
    assert.ok(floors['Mineral Sand'] >= .57351);
});
