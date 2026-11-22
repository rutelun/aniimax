import assert from 'node:assert/strict';
import test from 'node:test';
import { groupAniimoAssignments } from '../web/aniimo-assignment-groups.js';
import { recommendBestTeam } from '../web/best-team.js';

test('uses the assigned job and facility instead of the portrait’s available abilities', () => {
    const productionJobs = [
        ['Mine', 'clay', 'Earth'],
        ['Well', 'fresh_water', 'Water'],
        ['Nimbus Bed', 'wool', 'Leisure'],
        ['Bouncy Brew Keg', 'wheat_tea', 'Water'],
        ['Claw Game Cooker', 'bread', 'Fire'],
    ].map(([facility, item, ability]) => ({
        facility, ability, label: [facility, item, ability].join('|'),
        fixed: ability === 'Leisure', level: 1, busy: 1,
    }));
    const environmentJobs = [
        ['Sunlamp', 'Light'],
        ['Heat Furnace', 'Fire'],
        ['Cooling Unit', 'Ice'],
        ['Crackle Generator', 'Lightning'],
    ].map(([facility, ability]) => ({
        facility, ability, label: facility, fixed: true, level: 1, busy: 1,
    }));

    const { shifts } = recommendBestTeam([...productionJobs, ...environmentJobs], 1);
    const groups = groupAniimoAssignments(shifts);
    assert.deepEqual(groups.map(([label, members]) => [
        label, members.flatMap(shift => [...shift.tasks.keys()]).sort(),
    ]), [
        ['Leisure', ['Nimbus Bed|wool|Leisure']],
        ['Mining', ['Mine|clay|Earth']],
        ['Water Extraction', ['Well|fresh_water|Water']],
        ['Lighting & Climate', ['Cooling Unit', 'Heat Furnace', 'Sunlamp']],
        ['Other Assignments', ['Bouncy Brew Keg|wheat_tea|Water', 'Claw Game Cooker|bread|Fire',
            'Crackle Generator', 'Hauling to Storage Units']],
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
