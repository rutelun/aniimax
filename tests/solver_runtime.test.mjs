import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const workerUrl = new URL('../web/worker.js', import.meta.url);
const source = await readFile(workerUrl, 'utf8');
const runtimeCode = source.slice(source.indexOf('let highsBytes = null;'), source.indexOf('function hasSeasonCropMinimums'))
    .replaceAll('import.meta.url', 'workerUrl')
    .replace("import('./vendor/highs/highs.mjs' + load)", 'import(highsUrl)');

test('reused solver memory keeps consecutive independent models isolated', async t => {
    const localFetch = async url => {
        const bytes = await readFile(url);
        return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
    const create = new Function('workerUrl', 'highsUrl', 'fetch', 'columnValues', 'tiebreakOf',
        `const load = ''; ${runtimeCode}; return {newHighs, solveModel};`);
    const { newHighs, solveModel } = create(workerUrl, new URL('../web/vendor/highs/highs.mjs', import.meta.url).href,
        localFetch, (_, result) => [result.Columns.x0.Primal], () => 0);
    const problem = (objective, bound) => ({ variables: 1, lp:
        `${objective}\n obj: x0\nSubject To\n cap: x0 <= ${bound}\nBounds\n x0 >= 0\nEnd` });
    const runtime = await newHighs();
    const started = performance.now();
    for (let i = 0; i < 12; i++) {
        const result = await solveModel(problem(i % 2 ? 'Minimize' : 'Maximize', i + 1));
        assert.equal(result.objective, i % 2 ? 0 : i + 1);
        assert.equal(await newHighs(), runtime);
    }
    const result = await solveModel(problem('Maximize', -1));
    assert.equal(result, null);
    assert.equal((await solveModel(problem('Maximize', 42))).objective, 42);
    t.diagnostic(`14 isolated LP solves in one WASM runtime: ${(performance.now() - started).toFixed(1)} ms`);
});
