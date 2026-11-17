import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferedBatches, haulingBatchTrips, haulingWorkload, pickupStockLimit } from '../web/hauling.js';

test('crops and processors become ready at the first completed batch reaching 40 percent', () => {
    for (const facility of ['Farmland', 'Woodland', 'Workshop']) {
        assert.equal(bufferedBatches({ yieldAmount: 8 }, 35, facility), 2);
        assert.equal(bufferedBatches({ yieldAmount: 8 }, 40, facility), 2);
        assert.equal(bufferedBatches({ yieldAmount: 8 }, 41, facility), 3);
    }
});

test('small buffers and oversized harvests still need a whole batch and all cargo trips', () => {
    assert.equal(bufferedBatches({ yieldAmount: 8 }, 1, 'Farmland'), 1);
    assert.equal(bufferedBatches({ yieldAmount: 200 }, 35, 'Farmland'), 1);
    assert.equal(haulingBatchTrips({ yieldAmount: 200 }, 1, 35, 'Farmland'), 4);
    assert.equal(haulingBatchTrips({ yieldAmount: 200 }, 3, 35, 'Farmland'), 2);
});

test('mixed output is accumulated once and split over courier capacity', () => {
    // Three completed batches produce 120 items, requiring two Lv.3 trips.
    const recipe = { yieldAmount: 25, byproductAmount: 15 };
    assert.equal(bufferedBatches(recipe, 300, 'Workshop'), 3);
    assert.equal(haulingBatchTrips(recipe, 3, 300, 'Workshop'), 2 / 3);
    assert.equal(haulingBatchTrips(recipe, 4, 300, 'Workshop'), 1 / 3);
});

test('Quick Aromathyst uses the same requested 40 percent threshold', () => {
    const recipe = { name: 'quick_aromathyst', yieldAmount: 12 };
    assert.equal(bufferedBatches(recipe, 240, 'Dewy House'), 8);
    assert.equal(bufferedBatches(recipe, 60, 'Dewy House'), 2);
});

test('switching recipes and unknown buffers use per-batch pickups', () => {
    const member = { stockLimit: 300, jobs: [{ item: 'a' }, { item: 'b' }] };
    assert.equal(pickupStockLimit(member), 0);
    assert.equal(bufferedBatches({ yieldAmount: 5 }, pickupStockLimit(member), 'Workshop'), 1);
    assert.equal(bufferedBatches({ yieldAmount: 5 }), 1);
});

test('pickup threshold changes workload and trip frequency without counting cargo twice', () => {
    const recipe = { name: 'mixed', yieldAmount: 25, byproductAmount: 15 };
    const layout = { storages: [{ x: -1, y: -1, w: 2, h: 2 }], pieces: [{ members: [
        { x: 7, y: -1, w: 2, h: 2, weight: 60, batchWeight: 60,
            facility: 'Workshop', crop: 'mixed', stockLimit: 300 },
    ] }] };
    const work = haulingWorkload(layout, [{ facility: 'Workshop', item_name: 'mixed',
        status: 'producing', facility_count: 1, cycle_time: 60 }], 0, [recipe]);
    assert.equal(work.seconds['Workshop|mixed'], 8 / 3);
    assert.ok(Math.abs(work.trips - 1 / 90) < 1e-12);
    assert.ok(Math.abs(work.busy - 2 / 45) < 1e-12);
    assert.equal(work.tripSites.length, 1);
    assert.equal(work.tripSites[0].rate, 1 / 90);
});
