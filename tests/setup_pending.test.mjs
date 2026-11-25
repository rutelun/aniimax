import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { workerTravelSeconds } from '../web/worker-travel.js';

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
    const state = { tab: 'custom', resets:0, starts:0 };
    const context = {
        document: { getElementById: element, querySelectorAll: () => [] },
        selectedSetupTab: () => state.tab, levelledAbilities: () => [],
        Worker: class {
            constructor() { workers.push(this); }
            postMessage(message) { this.request = message; }
            terminate() { this.stopped = true; }
        },
        setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
        clearTimeout(id) { timers.delete(id); },
        displayPlan: (plan,keepLayout) => {shown.push(plan);state.keepLayout=keepLayout;}, runTimeToGoal() {},
        resetPlanButton() {state.resets++;}, showError(error) {state.error=error;},
        startProgress() {state.starts++;}, finishSolveSteps() {}, renderProgress() {}, setStep: (...args) => steps.push(args), translate: s => s,
        stopRanking() {}, stopLayout() {}, stopRosterSwaps() {}, swapInputs: new WeakMap(), swapPlanData: plan => plan,
        renderImprovements() {}, restartWorker() {}, refreshRosterTileWorkloads() {},
        ENVIRONMENT_BUILDING_ABILITY: {}, RESIDENT_FACILITIES: [], FACILITIES: [], workerTravelSeconds,
    };
    const run = code => runInNewContext(code, context);
    run(`let roster = [{count:1, abilities:{Water:3}, personalities:[], family:null}];
        let reactiveDispatch = {}; let haulingSeconds = {}, haulingDefaultSeconds = 0; let movementDistances = {0:40}, movementDefaultDistance = 20, lastPlan = null, plansBySetup = {}, planRunId = 1, ranking, progress=null;
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
    assert.equal(p.timers.size,0);
    p.workers[0].onmessage({data:{ok:true,result:'{"success":true}'}});
    assert.equal(p.element('aniimo-pending').style.display,'none');
});

test('an invalid or unreadable response settles as an error instead of waiting forever', () => {
    for (const failure of ['invalid', 'messageerror']) {
        const p = page();
        p.run('showSelectedPlan();');
        if (failure === 'invalid') p.workers[0].onmessage({ data: { ok: true, result: 'broken JSON' } });
        else p.workers[0].onmessageerror();
        assert.equal(p.element('aniimo-pending').style.display, 'none', failure);
        assert.equal(p.shown[0].success, false, failure);
        assert.ok(p.shown[0].error, failure);
        assert.ok(p.workers[0].stopped, failure);
        assert.equal(p.timers.size, 0, failure);
        assert.equal(p.state.resets,1,failure);
    }
});

test('automatic refinement keeps completed progress and updates the map in place',()=>{
    const p=page();
    p.element('aniimo-pending').style.display='none';
    p.run("progress={runId:1,steps:[{key:'plan',state:'done'}]};ensurePlanFor(selectedAniimoSetup(),true)");
    assert.equal(p.state.starts,0);
    assert.equal(p.element('aniimo-pending').style.display,'none');
    assert.equal(p.run('progress.steps[0].state'),'done');
    assert.deepEqual(p.steps,[['refine','start']]);
    p.workers[0].onmessage({data:{type:'progress',count:{step:'priority:coins',state:'start'}}});
    assert.equal(p.steps.length,1,'internal solves must not restart completed progress rows');
    p.run('let measuredMapOnly; function prepareOrdinaryRoute(plan,setup,runId,layoutOnly){measuredMapOnly=layoutOnly;}');
    p.workers[0].onmessage({data:{type:'progress',count:{ordinaryForMap:'{}',layoutOnly:true}}});
    assert.equal(p.run('measuredMapOnly'),true);
    p.workers[0].onmessage({data:{ok:true,result:'{"success":true}'}});
    assert.equal(p.state.keepLayout,true);
});

test('failed refinement retains results and releases the calculate button',()=>{
    const p=page();
    p.run("progress={runId:1,steps:[]};ensurePlanFor(selectedAniimoSetup(),true)");
    p.workers[0].onmessage({data:{ok:false,error:'failure'}});
    assert.equal(p.shown.length,0);
    assert.equal(p.state.resets,1);
    assert.match(p.state.error,/failure/);
    assert.deepEqual(p.steps.at(-1),['refine','fail']);
});

function pendingRoute(page) {
    page.run(`let finishPreview, cancelled=false;
        const previous={continuous_production_checked:true, active_continuous_recipes:['rice'],
            comparison_seed:{keys:['rate:rice'],values:[1]}};
        routePreview={runId:planRunId, setup:selectedAniimoSetup(), controller:{abort(){cancelled=true;}},
            request:JSON.stringify(setupPlanRequest(selectedAniimoSetup(),previous)),
            measured:new Promise(resolve=>{finishPreview=resolve;})};`);
}

test('an identical measured request joins the search already running for this map',async()=>{
    const p=page();
    pendingRoute(p);
    p.run('ensurePlanFor(selectedAniimoSetup(),true,previous)');
    assert.equal(p.workers.length,0);
    assert.equal(p.shown.length,0);
    p.run('finishPreview({success:true,rate_per_second:12})');
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(p.shown[0].rate_per_second,12);
    assert.equal(p.state.keepLayout,true);
});

test('a different production seed discards the preview and starts the measured search',()=>{
    const p=page();
    pendingRoute(p);
    p.run('previous.comparison_seed.values=[2];ensurePlanFor(selectedAniimoSetup(),true,previous)');
    assert.equal(p.run('cancelled'),true);
    assert.equal(p.workers.length,1);
    assert.deepEqual([...p.workers[0].request.routeWitness.seed.values],[2]);
});

test('a failed preview retries normally and a cancelled preview cannot update a newer setup',async()=>{
    for (const cancel of [false,true]) {
        const p=page();
        pendingRoute(p);
        p.run('ensurePlanFor(selectedAniimoSetup(),true,previous)');
        if(cancel)p.run('stopSetupSolve()');
        p.run(cancel?'finishPreview({success:true})':'finishPreview(null)');
        await new Promise(resolve=>setImmediate(resolve));
        assert.equal(p.workers.length,cancel?0:1);
        assert.equal(p.run('cancelled'),cancel);
        assert.equal(p.shown.length,0);
    }
});

test('a roster always accounts for walking and a corrected distance restarts its solve', () => {
    const p = page();
    p.run('showSelectedPlan();');
    const withTravel = JSON.parse(p.workers[0].request.payload).roster;
    assert.equal(withTravel.movement_seconds, 5);
    assert.deepEqual(withTravel.movement_by_member, {0:10});
    const key = p.run('selectedAniimoSetup()');
    p.run('movementDistances = {0:100}; switchAniimoSetup();');
    assert.ok(p.workers[0].stopped);
    assert.equal(p.timers.size, 0);
    const payload = JSON.parse(p.workers[1].request.payload);
    assert.equal(payload.roster.movement_seconds, 5);
    assert.deepEqual(payload.roster.movement_by_member, {0:25});
    assert.notEqual(p.run('selectedAniimoSetup()'), key);
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

test('an empty measured dispatch still finishes the pending workshop plan exactly once', () => {
    const p=page();
    p.run(`const provisional={success:true,pending_workshop_routes:true};
        const setup=selectedAniimoSetup();
        plansBySetup[setup]=provisional;
        ensurePlanFor(setup,true,provisional);
        ensurePlanFor(setup,true,provisional);`);
    assert.equal(p.workers.length,1);
    assert.equal(JSON.parse(p.workers[0].request.payload).map_dispatch_pending,false);
    p.workers[0].onmessage({data:{ok:true,result:JSON.stringify({success:true})}});
    p.run('ensurePlanFor(setup,true,provisional)');
    assert.equal(p.workers.length,1);
});
