import test from 'node:test';
import assert from 'node:assert/strict';
import { aniimoPortrait, rosterCatalogId, rosterFormName, searchRosterCatalog } from '../web/roster-picker.js';

test('the picker distinguishes the base form and prefills alternate form skills', () => {
    const matches = searchRosterCatalog('stellarys');
    assert.equal(rosterFormName(matches[0]), 'Stellarys');
    const [rainfall, ...rest] = searchRosterCatalog('Stellarys (Rainfall)');
    assert.equal(rest.length, 0);
    assert.equal(rosterFormName(rainfall), 'Stellarys (Rainfall Form)');
    assert.deepEqual(rainfall.abilities, { Water: 2, Dark: 3, Leisure: 3 });
    assert.equal(rainfall.family, '1001');
});

test('saved names acquire the right portrait and nicknames keep their selected form', () => {
    const base = rosterCatalogId(undefined, 'Whirlbite');
    const form = rosterCatalogId(undefined, 'Whirlbite (Prismana Form)');
    assert.ok(aniimoPortrait(base));
    assert.ok(aniimoPortrait(form));
    assert.notEqual(aniimoPortrait(base), aniimoPortrait(form));
    assert.equal(rosterCatalogId(form, 'My nickname'), form);
    assert.equal(rosterCatalogId('invalid', 'Whirlbite'), base);
    assert.equal(aniimoPortrait(undefined), '');
});
