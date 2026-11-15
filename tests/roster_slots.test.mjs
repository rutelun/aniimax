import test from 'node:test';
import assert from 'node:assert/strict';
import { placeRosterCopy, rosterSlotsFor, swapRosterSlots } from '../web/roster-slots.js';

test('old rosters get five-slot rows with one position per Aniimo', () => {
    assert.deepEqual(rosterSlotsFor([{ count: 2 }, { count: 4 }]),
        [0, 0, 1, 1, 1, 1, null, null, null, null]);
    assert.deepEqual(rosterSlotsFor([]), Array(5).fill(null));
});

test('saved slots preserve interior gaps and trailing empty rows when restored', () => {
    const slots = [null, 0, null, null, null, 1, null, null, null, null, ...Array(5).fill(null)];
    assert.deepEqual(rosterSlotsFor([{ count: 1 }, { count: 1 }], slots), slots);
});

test('moving across rows swaps occupants without changing roster group indexes', () => {
    const slots = rosterSlotsFor([{ count: 2 }, { count: 1 }]);
    slots.push(...Array(5).fill(null));
    assert.equal(swapRosterSlots(slots, 0, 9), true);
    assert.equal(swapRosterSlots(slots, 2, 9), true);
    assert.deepEqual(slots, [null, 0, 0, null, null, null, null, null, null, 1]);
    assert.equal(swapRosterSlots(slots, 0, 8), false);
    assert.equal(swapRosterSlots(slots, 1, 2), false);
});

test('adding uses the requested slot and opens a row when all positions are full', () => {
    const slots = rosterSlotsFor([{ count: 4 }]);
    assert.equal(placeRosterCopy(slots, 1, 4), 4);
    assert.equal(placeRosterCopy(slots, 2), 5);
    assert.deepEqual(slots, [0, 0, 0, 0, 1, 2, null, null, null, null]);
});
