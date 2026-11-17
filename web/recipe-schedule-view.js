// Pure renderer: callers provide display labels, and every label is escaped here.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

function elapsed(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (!total) return 'Morning';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60).toString().padStart(2, '0');
    const remainder = total % 60;
    return `+${hours}:${minutes}${remainder ? `:${remainder.toString().padStart(2, '0')}` : ''}`;
}

export function renderRecipeSchedule(schedule, {
    itemName = name => name,
    buildingName = building => `${building.facility || 'Building'} ${building.id}${building.level != null ? ` (level ${building.level})` : ''}`,
    formatNumber = value => String(value),
} = {}) {
    if (!schedule?.phases?.length) return '';
    const clock=seconds=>elapsed(schedule.approximate?Math.round(seconds/60)*60:seconds);
    const phases = schedule.phases;
    const jobs = new Map((schedule.jobs || []).map(job => [job.id, job]));
    const buildings = new Map((schedule.buildings || []).map(building => [building.id, building]));
    const switched = [...new Set(schedule.switchedBuildings || [])];
    const events = Array.isArray(schedule.switches) ? schedule.switches : [];
    let end = 0;
    const intervals = phases.map(phase => {
        const start = end;
        end += Math.max(0, Number(phase.duration) || 0);
        return `${elapsed(start)} – ${elapsed(end)}`;
    });
    const rows = switched.map(id => {
        const building = buildings.get(id) || {id};
        const cells = phases.map(phase => {
            const assignments = (phase.assignments || []).filter(assignment => assignment.building === id);
            const recipes = [...new Set(assignments.map(assignment => jobs.get(assignment.job)?.recipe ?? assignment.job))];
            return `<td>${recipes.length ? recipes.map(recipe => escape(itemName(recipe))).join('<br>') : 'Idle'}</td>`;
        });
        return `<tr><th scope="row">${escape(buildingName(building))}</th>${cells.join('')}</tr>`;
    });
    const stock = Object.entries(schedule.initialStock || {}).filter(([, amount]) => Number(amount) > 0);
    return `<section class="card recipe-schedule">
        <h3>Daily recipe schedule</h3>
        <p>${events.length} ${events.length === 1 ? 'switch' : 'switches'}; ${switched.length} ${switched.length === 1 ? 'building changes' : 'buildings change'} recipes.</p>
        <p class="hint small">Times are elapsed from morning. The morning reset does not count as a switch. ${schedule.approximate ? 'Times are estimates: finish the current batch before switching.' : ''}</p>
        ${events.length ? `<p>Common switch times: ${events.map(time => escape(clock(time))).join(', ')}.</p>` : ''}
        ${rows.length ? `<div class="table-wrapper"><table>
            <thead><tr><th scope="col">Building</th>${intervals.map(interval => `<th scope="col">${escape(interval)}</th>`).join('')}</tr></thead>
            <tbody>${rows.join('')}</tbody>
        </table></div>` : '<p>No buildings change recipes.</p>'}
        ${stock.length ? `<p>Conservative starting stock buffer (replenished daily):</p><ul>${stock.map(([item, amount]) => `<li>${escape(formatNumber(Math.ceil(amount)))} ${escape(itemName(item))}</li>`).join('')}</ul>` : ''}
    </section>`;
}
