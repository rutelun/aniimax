import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('building worker details select actual working copies, including crop jobs, from the current team', () => {
    const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
    const tile = (member, jobs) => ({dataset: {workMember: String(member), rosterTasks: JSON.stringify(jobs.map(job => [job, '10%']))}});
    const mill = tile(2, ['Carousel Mill (Ginseng Powder)', 'Hauling to Storage Units']);
    const otherCopy = tile(2, ['Woodworking Bench (Rough Lumber)']);
    const idleCopy = tile(2, []);
    const otherMember = tile(3, ['Carousel Mill (Ginseng Powder)']);
    const cropCopy = tile(2, ['Watering · Ginseng', 'Walking between jobs']);
    let tiles = [mill, otherCopy, idleCopy, otherMember, cropCopy];
    const context = vm.createContext({document: {querySelectorAll: () => tiles}});
    vm.runInContext(source.slice(source.indexOf('function productionWorkerTiles('), source.indexOf('\nfunction showTip(')), context);
    const worker = {dataset: {productionWorker: '2', workerJob: 'Carousel Mill (Ginseng Powder)', workerItem: 'Ginseng Powder'}};
    assert.deepEqual(Array.from(context.productionWorkerTiles(worker)), [mill]);
    worker.dataset.workerJob = 'Farmland (Ginseng)';
    worker.dataset.workerItem = 'Ginseng';
    assert.deepEqual(Array.from(context.productionWorkerTiles(worker)), [cropCopy]);
    tiles = [];
    assert.equal(context.productionWorkerTiles(worker).length, 0);
});
