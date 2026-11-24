import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { scheduleRosterCopies } from '../web/roster-work.js';
import { splitPhaseTasks } from '../web/phase-work.js';
import { scheduleProfiles } from '../web/recipe-schedule-plan.js';
import { routeDispatchKey } from '../web/reactive-dispatch.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAniimoAssignments, groupRosterAssignments } from '../web/aniimo-assignment-groups.js';
import { recommendBestTeam } from '../web/best-team.js';
import { productionTeamJobs } from '../web/production-team-jobs.js';

test('uses the assigned job and facility instead of the portrait’s available abilities', () => {
    const plan = {
        coin_items: [
            ['Mine', 'clay', 'Earth'],
            ['Well', 'fresh_water', 'Water'],
            ['Nimbus Bed', 'wool', 'Leisure'],
            ['Bouncy Brew Keg', 'wheat_tea', 'Water'],
            ['Claw Game Cooker', 'bread', 'Fire'],
        ].map(([facility, item_name, ability]) => ({
            facility, item_name, status: 'producing', facility_count: 1,
            aniimo_tasks: [{ ability, level: 1, busy: 1 }],
        })),
    };
    const environmentJobs = [
        ['Sunlamp', 'Light'],
        ['Heat Furnace', 'Fire'],
        ['Cooling Unit', 'Ice'],
        ['Crackle Generator', 'Lightning'],
    ].map(([facility, ability]) => ({
        facility, ability, label: facility, fixed: true, level: 1, busy: 1,
    }));

    const { shifts } = recommendBestTeam([...productionTeamJobs(plan, []), ...environmentJobs], 1);
    const groups = groupAniimoAssignments(shifts);
    assert.deepEqual(groups.map(([label, members]) => [
        label, members.flatMap(shift => [...shift.tasks.keys()]).sort(),
    ]), [
        ['Leisure', ['Nimbus Bed|wool|Leisure']],
        ['Mining', ['Mine|clay|Earth']],
        ['Water Extraction', ['Well|fresh_water|Water']],
        ['Lighting & Climate', ['Cooling Unit', 'Crackle Generator', 'Heat Furnace', 'Sunlamp']],
        ['Other Assignments', ['Bouncy Brew Keg|wheat_tea|Water', 'Claw Game Cooker|bread|Fire',
            'Hauling to Storage Units']],
    ]);
});

test('shows each portrait once, using total workload across jobs in each group', () => {
    const miner = { allocations: [
        { facility: 'Mine', busy: .25 },
        { facility: 'Well', busy: .4 },
        { facility: 'Mine', busy: .25 },
    ] };
    const tie = { allocations: [
        { facility: 'Well', busy: .5 },
        { facility: 'Mine', busy: .5 },
    ] };
    const support = { peakSupport: true, allocations: [] };
    assert.deepEqual(groupAniimoAssignments([miner, support, tie]), [
        ['Mining', [miner, tie]],
        ['Other Assignments', [support]],
    ]);
});

test('groups individual roster copies by the facility they actually worked in', async () => {
    const source = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
    const copyShifts = runInNewContext(source.slice(source.indexOf('function rosterCopyShifts('),
        source.indexOf('function renderRosterSummary(')) + '\nrosterCopyShifts', {
        scheduleRosterCopies, splitPhaseTasks, scheduleProfiles, routeDispatchKey, recipeIndex: [],
        RESIDENT_FACILITIES: new Set(['Nimbus Bed']), translate: label => 'tr-' + label, prettyItem: String,
    });
    const plan = {
        coin_items: [{ status: 'producing', facility: 'Nimbus Bed', item_name: 'wool', crew: 0, facility_count: 1 }],
        staffing: [['Crackle Generator', 0, 1]],
        roster_routes: [['Mine','clay'], ['Well','water']].map(([facility,item]) => ({
            facility, item, member: 0, visits: 0, jobs: [['', 1]],
        })),
    };
    for (const recipe_schedule of [undefined, { phases: [{duration: 1, assignments: []}], jobs: [], sites: [] }]) {
        const [shifts] = copyShifts({...plan, recipe_schedule}, [{ count: 4 }], [4], [0]);
        assert.deepEqual(groupAniimoAssignments(shifts).map(([label, members]) => [label, members.length]), [
            ['Leisure', 1], ['Mining', 1], ['Water Extraction', 1], ['Lighting & Climate', 1],
        ]);
    }
});

test('shows a missing copy beside the owned worker and leaves unused reserve capacity off the team', () => {
    const owned = { count: 2 };
    const reserve = { count: 10, assumed: true };
    const miner = { allocations: [{ facility: 'Mine', busy: 1 }] };
    const groups = groupRosterAssignments([owned, reserve], [1, 1], [[miner], [miner]], {
        additions: [{ member: 0, count: 1 }], shortfall: [],
    });
    assert.deepEqual(groups.map(([group, copies]) => [group, copies.map(tile => [tile.member, tile.suggested])]), [
        ['Mining', [[0, false], [1, true]]],
        ['Other Assignments', [[0, true]]],
        ['Unassigned', [[0, false]]],
    ]);
});
