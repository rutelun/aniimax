import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ids = ['recipe-switching-buildings', 'recipe-switching-switches'];
function harness() {
    const elements = Object.fromEntries(ids.map(id => [id, {
        value: 'legacy',
        type: 'number', tagName: 'INPUT', addEventListener(event, callback) { this[event] = callback; },
    }]));
    const context = vm.createContext({document: {getElementById: id => elements[id]},
        buildingInventory: () => ({facilities: {}, modules: {}}), activePriorities: () => [],
        levelUpInput: () => null, questIncome: value => value, questIncomePerDay: {},
        wantsCropVariety: () => false, excludedRecipes: () => [], activeSeasonId: () => null,
        seasonCurrencyPerDay: () => 0, activeSeasonCropMinimums: () => ({}), eModeRv: () => null,
        facilityTiers: {}, customBuildings: false, skippedRecipes: [], unlockedSpecial: [],
        priorityOrder: [], aniimoLevels: {}, roster: [], rosterSlots: [], seasonBudgets: {}, seasonCropMinimums: {},
        rosterSlotsFor: () => [], saveInputsToStorage: () => {}, PRIORITY_TARGETS: [],
    });
    for (const [start, end] of [
        ['function getPlanInputValues()', '// parseInt/parseFloat'],
        ['function getPersistedFieldIds()', '// Reads and parses'],
        ['function currentConfig()', 'function clearShareHash()'],
        ['function loadInputsFromStorage(data)', 'function clearSavedInputs()'],
    ]) {
        const at = source.indexOf(start);
        assert.ok(at >= 0, `${start} exists`);
        vm.runInContext(source.slice(at, source.indexOf(end, at)), context);
    }
    return {elements, run: expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context))};
}

test('old switching fields are absent from settings and ignored when loading or sharing a setup', () => {
    const p = harness();
    for (const id of ids) assert.equal(html.includes('id="' + id + '"'), false);
    const saved = p.run('(loadInputsFromStorage({"recipe-switching-buildings":"0","recipe-switching-switches":"0"}), currentConfig())');
    for (const id of ids) {
        assert.equal(p.elements[id].value, 'legacy');
        assert.equal(Object.hasOwn(saved,id), false);
    }
    assert.equal(Object.hasOwn(p.run('getPlanInputValues()'),'recipe_switching'),false);
});
