import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ids = ['recipe-switching-buildings', 'recipe-switching-switches'];
function harness(values = {}) {
    const elements = Object.fromEntries(ids.map(id => [id, {
        value: values[id] ?? html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))?.[1],
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
        ['function recipeSwitchingInput()', '// parseInt/parseFloat'],
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

test('legacy and default setups omit switching; enabled setup preserves zero switches', () => {
    const p = harness();
    assert.equal(p.run('getPlanInputValues()').recipe_switching, undefined);
    p.run('(loadInputsFromStorage({}), getPlanInputValues())');
    assert.equal(p.elements[ids[0]].value, '0');
    p.elements[ids[0]].value = '3';
    assert.deepEqual(p.run('getPlanInputValues()').recipe_switching, {max_buildings: 3, max_switches: 2});
    p.elements[ids[1]].value = '0';
    assert.deepEqual(p.run('getPlanInputValues()').recipe_switching, {max_buildings: 3, max_switches: 0});
});

test('switching settings round trip through saved and shared configuration and auto-save', () => {
    const p = harness({[ids[0]]: '4', [ids[1]]: '3'});
    const saved = p.run('currentConfig()');
    const restored = harness();
    restored.run(`(loadInputsFromStorage(${JSON.stringify(saved)}), true)`);
    assert.deepEqual(restored.run('getPlanInputValues()').recipe_switching, {max_buildings: 4, max_switches: 3});
    restored.run('(attachAutoSave(), true)');
    for (const id of ids) assert.equal(typeof restored.elements[id].input, 'function');
});

test('switching limits reject invalid counts and normalize fractional input', () => {
    for (const value of ['-1', 'Infinity', 'bad', '']) {
        assert.equal(harness({[ids[0]]: value}).run('getPlanInputValues()').recipe_switching, undefined);
    }
    assert.deepEqual(harness({[ids[0]]: '2.9', [ids[1]]: '-1'}).run('getPlanInputValues()').recipe_switching,
        {max_buildings: 2, max_switches: 0});
});
