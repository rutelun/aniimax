import test from 'node:test';
import assert from 'node:assert/strict';
import { rosterFormName, searchRosterCatalog } from '../web/roster-picker.js';

test('the picker distinguishes the base form and prefills alternate form skills', () => {
    const matches = searchRosterCatalog('stellarys');
    assert.equal(rosterFormName(matches[0]), 'Stellarys');
    const [rainfall, ...rest] = searchRosterCatalog('Stellarys (Rainfall)');
    assert.equal(rest.length, 0);
    assert.equal(rosterFormName(rainfall), 'Stellarys (Rainfall Form)');
    assert.deepEqual(rainfall.abilities, { Water: 2, Dark: 3, Leisure: 3 });
    assert.equal(rainfall.family, '1001');
});
