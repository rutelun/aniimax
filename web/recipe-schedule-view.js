// Pure renderer: callers provide labels; escape all display values.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

function elapsed(seconds) {
    const minutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
    return `+${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

export function renderRecipeSchedule(schedule, {
    itemName = name => name,
    buildingName = building => `${building.facility || 'Building'} ${building.id}`,
    buildingIcon = () => '',
} = {}) {
    if (!schedule?.phases?.length) return '';
    const jobs = new Map((schedule.jobs || []).map(job => [job.id, job]));
    const buildings = new Map((schedule.buildings || []).map(building => [building.id, building]));
    const switched = [...new Set(schedule.switchedBuildings || [])];
    const events = schedule.switches || [];
    const recipes = (phase, id) => [...new Set((phase.assignments || [])
        .filter(a => a.building === id).map(a => jobs.get(a.job)?.recipe ?? a.job))].sort();
    const label = values => values.length ? values.map(r => escape(itemName(r))).join(', ') : 'Idle';
    let time = 0;
    const columns = [{phase: schedule.phases[0], title: 'Morning'}];
    schedule.phases.slice(1).forEach((phase, index) => {
        time += Number(schedule.phases[index].duration) || 0;
        if (switched.some(id => JSON.stringify(recipes(schedule.phases[index], id)) !== JSON.stringify(recipes(phase, id)))) {
            columns.push({phase, title: elapsed(time)});
        }
    });
    const rows = switched.map(id => {
        const building = buildings.get(id) || {id};
        const icon = buildingIcon(building.facility);
        const cells = columns.map(({phase, title}, index) => {
            const current = recipes(phase, id);
            const changed = index > 0 && JSON.stringify(current) !== JSON.stringify(recipes(columns[index - 1].phase, id));
            return `<td data-time="${escape(title)}"${changed ? ' class="recipe-schedule-changed"' : ''}>${changed ? '<span class="recipe-schedule-arrow" aria-hidden="true">→</span>' : ''}${label(current)}</td>`;
        }).join('');
        return `<tr><th scope="row"><span class="recipe-schedule-building">${icon ? `<img src="${escape(icon)}" alt="" width="32" height="32">` : ''}<span>${escape(buildingName(building))}</span></span></th>${cells}</tr>`;
    }).join('');
    return `<details class="recipe-schedule" open><summary><strong>Daily recipe schedule</strong> <span class="recipe-schedule-count">${events.length} ${events.length === 1 ? 'switch' : 'switches'}/day · ${switched.length} ${switched.length === 1 ? 'building' : 'buildings'}</span></summary>
        ${switched.length ? `<div class="recipe-schedule-scroll"><table class="recipe-schedule-table"><thead><tr><th scope="col">Building</th>${columns.map(c => `<th scope="col">${escape(c.title)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : '<p>No buildings change recipes.</p>'}
    </details>`;
}
