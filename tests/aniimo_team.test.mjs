import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const teamCode = source.slice(source.indexOf('function aniimoTeam('), source.indexOf('function renderAniimoSummary('));
const environmentCode = source.slice(source.indexOf('function environmentTeamJobs('), source.indexOf('const bestTeamCache'));
const pairCode = source.slice(source.indexOf('function environmentPairKey('), source.indexOf('function splitByEnvironmentUnit('));
const aniimoTeam = new Function(`
    const bestTeamLayouts = new WeakMap(), minimumTeamCache = new WeakMap();
    const criticalCropJob = name => ['Reaping','Logging','Collecting','Reclaiming','Sowing'].includes(name);
    const RESIDENT_FACILITIES = new Set(['Tidewhisper Sandcastle']);
    const ENVIRONMENT_BUILDING_ABILITY = { 'Heat Furnace': 'Fire', 'Cooling Unit': 'Ice', 'Crackle Generator': 'Lightning' };
    const FACILITIES = [], recipeIndex = [{ name: 'salt', family: 'salt-family' }];
    const taskLabel = task => task.ability;
    const leisureFamilyName = family => family;
    const prettyItem = item => item;
    ${pairCode} ${environmentCode} ${teamCode}
    return aniimoTeam;
`)();

test('Minimum needs a resident per unit and counts every separate climate pair', () => {
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
    assert.equal(team.kept.find(group => group.ability === 'Fire').level, 2);
    assert.equal(team.kept.find(group => group.ability === 'Ice').level, 1);
});

test('strong climate jobs reject level-one placeholders while mild modes keep them eligible', () => {
    for (const [building, ability, mild, strong] of [['Heat Furnace','Fire','Warm','Scorching'], ['Cooling Unit','Ice','Cool','Freeze']]) {
        for (const [mode, level] of [[mild,1],[strong,2]]) {
            const team = aniimoTeam({coin_items:[],environment_assignments:[{building,mode,units:1}],power_generator_levels:[],hauling_busy:0});
            const job = team.kept.find(g => g.ability === ability);
            assert.equal(job.level, level, mode);
            assert.equal(job.anyLevel, false, mode);
        }
    }
});

test('Minimum packs lower-level fractional jobs across spare capacity of multiple higher-level hosts', () => {
    const plan = {
        coin_items: [
            { facility: 'Mine', item_name: 'a', facility_count: 1, aniimo_tasks: [{ ability: 'Earth', level: 3, busy: 0.6 }] },
            { facility: 'Mine', item_name: 'b', facility_count: 1, aniimo_tasks: [{ ability: 'Earth', level: 2, busy: 0.6 }] },
            { facility: 'Mine', item_name: 'c', facility_count: 1, aniimo_tasks: [{ ability: 'Earth', level: 1, busy: 0.6 }] },
        ],
        environment_assignments: [],
        power_generator_levels: [],
        hauling_busy: 0,
    };
    const team = aniimoTeam(plan);
    assert.equal(team.total, 2);
    assert.equal(team.kept.reduce((s, g) => s + g.count, 0), 2);
});
