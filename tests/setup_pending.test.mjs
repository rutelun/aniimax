import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const setupCode = source.slice(source.indexOf('function selectedAniimoSetup()'), source.indexOf('// The most recently computed goal result'));
const payloadCode = source.slice(source.indexOf('function rosterPayload()'), source.indexOf('const escapeText'));

function page() {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, { style: {}, checked: false, classList: { toggle() {} } });
        return elements.get(id);
    };
    const workers = [], timers = new Map(), shown = [], steps = [];
    const state = { tab: 'custom' };
    const context = {
        document: { getElementById: element, querySelectorAll: () => [] },
        selectedSetupTab: () => state.tab, levelledAbilities: () => [],
        maxWorkingAniimo: () => null,
        Worker: class {
            constructor() { workers.push(this); }
            postMessage(message) { this.request = message; }
            terminate() { this.stopped = true; }
        },
        setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        displayPlan: plan => shown.push(plan), runTimeToGoal() {}, updatePlannerNavigation() {},
        startProgress() {}, finishSolveSteps() {}, renderProgress() {}, setStep: (...args) => steps.push(args), translate: s => s,
        stopRanking() {}, stopLayout() {}, renderImprovements() {}, restartWorker() {},
        ENVIRONMENT_BUILDING_ABILITY: {}, RESIDENT_FACILITIES: [], FACILITIES: [], ANIIMO_WALK_SPEED: 4,
    };
    const run = code => runInNewContext(code, context);
    run(`let roster = [{count:1, abilities:{Water:3}, personalities:[], family:null}];
        let haulingSeconds = {}, haulingDefaultSeconds = 0; let movementDistances = {0:40}, movementDefaultDistance = 20, lastPlan = null, plansBySetup = {}, planRunId = 1, ranking, progress=null;
        const WORKER_URL = 'worker.js';` + setupCode + payloadCode + `
        function aniimoInput(setup) { return {aniimo:'roster', roster:rosterPayload()}; }
        lastPlanInput = {facilities:{Well:[{count:2,level:1}]}};`);
    return { run, element, workers, timers, shown, state, steps };
}

test('a missing selected plan starts exactly one solve and clears pending on completion', () => {
    const p = page();
    p.run('showSelectedPlan(); showSelectedPlan();');
    assert.equal(p.workers.length, 1);
    assert.equal(p.element('aniimo-pending').style.display, 'block');
    p.workers[0].onmessage({ data: { ok: true, result: '{"success":true}' } });
    assert.equal(p.element('aniimo-pending').style.display, 'none');
    assert.equal(p.shown.length, 1);
    assert.equal(p.timers.size, 0);
});

test('showing an in-flight primary setup does not duplicate its solve', () => {
    const p = page();
    p.run('mainSolve = {setup:selectedAniimoSetup(), runId:planRunId}; showSelectedPlan();');
    assert.equal(p.workers.length, 0);
});

test('a correction reports real solver progress instead of silently waiting behind the old results', () => {
    const p = page();
    p.run('showSelectedPlan();');
    p.workers[0].onmessage({data:{type:'progress',count:{step:'priority:coins',state:'start'}}});
    assert.deepEqual(p.steps[0],['priority:coins','start',undefined,undefined]);
    assert.equal(p.element('aniimo-pending').textContent,'Updating Aniimo setup...');
    assert.equal(p.timers.size,1);
    p.workers[0].onmessage({data:{ok:true,result:'{"success":true}'}});
    assert.equal(p.element('aniimo-pending').style.display,'none');
});

test('an invalid or timed-out response settles as an error instead of waiting forever', () => {
    for (const failure of ['invalid', 'timeout', 'messageerror']) {
        const p = page();
        p.run('showSelectedPlan();');
        if (failure === 'invalid') p.workers[0].onmessage({ data: { ok: true, result: 'broken JSON' } });
        else if (failure === 'timeout') [...p.timers.values()][0]();
        else p.workers[0].onmessageerror();
        assert.equal(p.element('aniimo-pending').style.display, 'none', failure);
        assert.equal(p.shown[0].success, false, failure);
        assert.ok(p.shown[0].error, failure);
        assert.ok(p.workers[0].stopped, failure);
        assert.equal(p.timers.size, 0, failure);
    }
});

test('turning travel off cancels the costly solve and ignores previous distances', () => {
    const p = page();
    p.element('worker-travel-on').checked = true;
    p.run('showSelectedPlan();');
    assert.equal(JSON.parse(p.workers[0].request.payload).roster.movement_seconds, 5);
    p.element('worker-travel-on').checked = false;
    p.run('switchAniimoSetup();');
    assert.ok(p.workers[0].stopped);
    assert.equal(p.timers.size, 1);
    const payload = JSON.parse(p.workers[1].request.payload);
    assert.equal(payload.roster.movement_seconds, 0);
    assert.deepEqual(payload.roster.movement_by_member, {});
    const key = p.run('selectedAniimoSetup()');
    p.run('movementDistances = {0:100};');
    assert.equal(p.run('selectedAniimoSetup()'), key);
    p.workers[1].onmessage({ data: { ok: true, result: '{"success":true}' } });
    assert.equal(p.element('aniimo-pending').style.display, 'none');
});

test('a completed older setup starts the newly selected plan rather than leaving it pending', () => {
    const p = page();
    p.run(`const original = selectedAniimoSetup(); mainSolve = {setup:original, runId:1};
        roster[0].count = 2; plansBySetup[original] = {success:true}; mainSolve = null;
        showSelectedPlan();`);
    assert.equal(p.workers.length, 1);
    assert.equal(JSON.parse(p.workers[0].request.payload).roster.members[0].count, 2);
});

test('returning to a cached setup cancels the old worker and removes its unfinished progress', () => {
    const p = page();
    p.run(`const original = selectedAniimoSetup(); plansBySetup[original] = {success:true};
        roster[0].count = 2; showSelectedPlan(); progress = {steps:[{state:'running'}]};
        roster[0].count = 1; switchAniimoSetup();`);
    assert.ok(p.workers[0].stopped);
    assert.equal(p.run('progress'),null);
    assert.equal(p.element('aniimo-pending').style.display,'none');
    assert.equal(p.timers.size,0);
});
