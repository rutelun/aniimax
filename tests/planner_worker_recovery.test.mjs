import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const rpc = source.slice(source.indexOf('function initWorker()'), source.indexOf('// Converts the solver'));

function harness() {
    const workers = [], timers = [];
    class Worker {
        constructor() { workers.push(this); }
        postMessage(message) { this.last = message; }
        terminate() { this.stopped = true; }
        respond(result) { this.onmessage({data:{id:this.last.id,ok:true,result}}); }
    }
    const call = vm.runInNewContext(`let worker, nextRequestId=0;
        const WORKER_URL='worker.js', pendingWorkerRequests=new Map();
        ${rpc}
        callWorker`, {Worker,console:{error() {}},setTimeout:fn=>timers.push(fn),clearTimeout() {}});
    return {call,workers,timers};
}

test('a crashed planner can run again and late errors cannot cancel its replacement', async () => {
    const {call,workers} = harness();
    const first = call('find_plan');
    workers[0].onmessageerror();
    await assert.rejects(first,/unreadable response/);
    const second = call('find_plan');
    assert.equal(workers[0].stopped,true);
    workers[0].onerror({message:'late error'});
    workers[1].respond('plan');
    assert.equal(await second,'plan');
});

test('a timed-out secondary request leaves an active production search running', async () => {
    const {call,workers,timers} = harness();
    const plan = call('find_plan');
    const id = workers[0].last.id;
    const items = call('get_all_items');
    timers[0]();
    await assert.rejects(items,/too long/);
    assert.equal(workers.length,1);
    workers[0].onmessage({data:{id,ok:true,result:'plan'}});
    assert.equal(await plan,'plan');
});

test('an asynchronous layout failure sends a final response to the caller', async () => {
    const replies = [];
    globalThis.self = {postMessage:message=>replies.push(message)};
    try {
        await import('../web/layout-worker.js');
        await self.onmessage({data:null});
        assert.equal(replies.length,1);
        assert.ok(replies[0].error);
    } finally {
        delete globalThis.self;
    }
});
