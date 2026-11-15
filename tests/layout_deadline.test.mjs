import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { layOutHomeland } from '../web/layout.js';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function startLayoutTask('), source.indexOf('// Every plot of the homeland'));

test('a slow optional search returns the latest layout and stops the worker', () => {
    let worker, expire, applied;
    class FakeWorker {
        constructor() { worker = this; }
        postMessage(input) { this.input = input; }
        terminate() { this.terminated = true; }
    }
    const start = new Function('Worker', 'WORKER_URL', 'setTimeout', 'clearTimeout', `${code} return startLayoutTask;`)(
        FakeWorker, 'worker.js', (callback, ms) => { expire = callback; return ms; }, () => {},
    );
    start({}, layout => { applied = layout; }, error => assert.fail(error));
    assert.equal(worker.input.budgetMs, 2300);
    worker.onmessage({ data: { layout: { unplaced: [] }, done: false } });
    assert.equal(applied, undefined);
    expire();
    assert.deepEqual(applied, { unplaced: [], searchLimited: true });
    assert.equal(worker.terminated, true);
});

test('an expired placement reports work still unplaced', () => {
    const pieces = [{ members: [{ x: 0, y: 0, w: 2, h: 2, weight: 1 }] }];
    const layout = layOutHomeland(pieces, [{ x: 0, y: 0, w: 10, h: 10 }], { w: 2, h: 2 }, 1,
        { fast: true, deadline: performance.now() - 1 });
    assert.deepEqual(layout.unplaced, [0]);
    assert.deepEqual(layout.pieces[0].members, []);
});
