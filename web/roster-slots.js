export const ROSTER_ROW_SIZE = 5;

// Roster members remain grouped for the solver. Each copy gets a separate cell in the UI.
export function rosterSlotsFor(members, saved = []) {
    const remaining = members.map(member => member.count);
    const slots = Array.from(saved, member => {
        if (!Number.isInteger(member) || !(remaining[member] > 0)) return null;
        remaining[member]--;
        return member;
    });
    let next = 0;
    remaining.forEach((count, member) => {
        for (let i = 0; i < count; i++) {
            while (next < slots.length && slots[next] != null) next++;
            slots[next++] = member;
        }
    });
    const size = Math.max(ROSTER_ROW_SIZE, Math.ceil(slots.length / ROSTER_ROW_SIZE) * ROSTER_ROW_SIZE);
    while (slots.length < size) slots.push(null);
    return slots;
}

export function placeRosterCopy(slots, member, position = slots.indexOf(null)) {
    if (position < 0) {
        position = slots.length;
        slots.push(...Array(ROSTER_ROW_SIZE).fill(null));
    }
    slots[position] = member;
    return position;
}

export function swapRosterSlots(slots, from, to) {
    if (slots[from] == null || to < 0 || to >= slots.length || slots[from] === slots[to]) return false;
    [slots[from], slots[to]] = [slots[to], slots[from]];
    return true;
}
