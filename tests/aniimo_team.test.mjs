import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const teamCode = source.slice(source.indexOf('function aniimoTeam('), source.indexOf('function renderAniimoSummary('));
const pairCode = source.slice(source.indexOf('function environmentPairKey('), source.indexOf('function splitByEnvironmentUnit('));
const aniimoTeam = new Function(`
    const RESIDENT_FACILITIES = new Set(['Tidewhisper Sandcastle']);
    const ENVIRONMENT_BUILDING_ABILITY = { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice', 'Crackle Generator': 'Lightning' };
    const FACILITIES = [], recipeIndex = [{ name: 'salt', family: 'salt-family' }];
    const taskLabel = task => task.ability;
    const leisureFamilyName = family => family;
    const prettyItem = item => item;
    ${pairCode} ${teamCode}
    return aniimoTeam;
`)();

test('Best and Minimum need a resident per unit and count every separate climate pair', () => {
    const climate = [0, 1].flatMap(pair_id => [0, 1, 2].map(zone => ({
        pair_id, zone, building: 'Heat Furnace', partner: ['Cooling Unit', 4, 1],
        pair_modes: ['Scorching', 'Cool'], units: 1,
    })));
    const plan = {
        coin_items: [{ facility: 'Tidewhisper Sandcastle', item_name: 'salt', facility_count: 2,
            aniimo_tasks: [{ ability: 'Leisure', level: 1, busy: .3 }] }],
        environment_assignments: climate,
        power_generator_levels: [[2, 2]],
        hauling_busy: .4,
    };
    const team = aniimoTeam(plan);
    for (const [ability, count] of [['Leisure', 2], ['Fire', 2], ['Ice', 2], ['Lightning', 1]]) {
        assert.equal(team.kept.find(group => group.ability === ability)?.count, count);
    }
    assert.equal(team.total, 8);
    assert.equal(team.kept.find(group => group.ability === 'Lightning').level, 2);
});
