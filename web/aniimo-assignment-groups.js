import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';

const OTHER = 'Other Assignments';
const GROUPS = ['Leisure', 'Mining', 'Water Extraction', 'Lighting & Climate', OTHER];

function assignmentGroup({ ability, facility }) {
    if (ability === 'Leisure') return 'Leisure';
    if (facility === 'Mine') return 'Mining';
    if (facility === 'Well') return 'Water Extraction';
    if (facility === 'Crackle Generator' || FACILITY_CATEGORY_BY_NAME.get(facility) === 'Environment') {
        return 'Lighting & Climate';
    }
    return OTHER;
}

export function groupAniimoAssignments(shifts) {
    const groups = new Map(GROUPS.map(label => [label, []]));
    for (const shift of shifts) {
        const workload = new Map();
        for (const allocation of shift.allocations ?? []) {
            const group = assignmentGroup(allocation);
            workload.set(group, (workload.get(group) ?? 0) + allocation.busy);
        }
        // Use the displayed order to break ties and keep every Aniimo in a single group.
        let primary = OTHER;
        let busiest = 0;
        for (const group of GROUPS) {
            const load = workload.get(group) ?? 0;
            if (load > busiest) {
                primary = group;
                busiest = load;
            }
        }
        groups.get(primary).push(shift);
    }
    return [...groups].filter(([, members]) => members.length > 0);
}
