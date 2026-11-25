// Pure renderer: callers provide labels; escape all display values.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[c]);

export function elapsed(seconds) {
    const minutes = Math.max(0, Math.round((Number(seconds) || 0) / 60));
    return `+${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

// Only use the physical view for facility types where a site actually changes
// recipes. Keep adjacent periods together when only another site changes.
export function facilitySchedule(schedule, facility) {
    const sites = schedule?.buildings?.filter(site => site.facility === facility);
    const switched = new Set(schedule?.switchedBuildings);
    if (!sites?.some(site => switched.has(site.id)) || !schedule.phases?.length) return null;
    const jobs = new Map(schedule.jobs.map(job => [job.id, job]));
    return sites.map(site => {
        const periods = [];
        let start = 0;
        for (const phase of schedule.phases) {
            const batches = new Map();
            for (const assignment of phase.assignments) {
                // A material-flow phase can keep a recipe selected at zero output.
                if (assignment.building !== site.id) continue;
                batches.set(assignment.job, (batches.get(assignment.job) || 0) + assignment.batches);
            }
            const previous = periods.at(-1);
            const sameJobs = previous && previous.batches.size === batches.size
                && [...batches.keys()].every(id => previous.batches.has(id));
            if (sameJobs) {
                previous.duration += phase.duration;
                for (const [id, count] of batches) previous.batches.set(id, previous.batches.get(id) + count);
            } else {
                periods.push({start, duration: phase.duration, batches});
            }
            start += phase.duration;
        }
        return {site, periods: periods.map(({start, duration, batches}) => ({
            start, duration, jobs: [...batches].map(([id, count]) => ({job: jobs.get(id), rate: count / duration})),
        }))};
    });
}

// Daily table and flow cards use the same phase boundaries and selected recipes.
function scheduleColumns(schedule, switched) {
    const jobs = new Map((schedule.jobs || []).map(job => [job.id, job.recipe ?? job.id]));
    const columns = [];
    let start = 0;
    for (const phase of schedule.phases) {
        const recipes = new Map(switched.map(id => [id, new Set()]));
        for (const assignment of phase.assignments || []) {
            recipes.get(assignment.building)?.add(jobs.get(assignment.job) ?? assignment.job);
        }
        const selected = new Map([...recipes].map(([id, values]) => [id, [...values].sort()]));
        const previous = columns.at(-1);
        const changed = new Set(switched.filter(id => previous &&
            JSON.stringify(selected.get(id)) !== JSON.stringify(previous.selected.get(id))));
        if (!previous || changed.size) columns.push({start, title: previous ? elapsed(start) : 'Morning', selected, changed});
        start += Number(phase.duration) || 0;
    }
    return columns;
}

export function recipeTransitions(schedule) {
    if (!schedule?.phases?.length || !schedule.switchedBuildings?.length) return [];
    const buildings = new Map((schedule.buildings || []).map(site => [site.id, site]));
    const columns = scheduleColumns(schedule, [...new Set(schedule.switchedBuildings)]);
    const transitions = [];
    for (let i = 1; i < columns.length; i++) {
        const {start, selected, changed} = columns[i];
        for (const id of changed) transitions.push({
            site: buildings.get(id) ?? {id}, start, from: columns[i - 1].selected.get(id), to: selected.get(id),
        });
    }
    return transitions;
}

export function renderRecipeSchedule(schedule, {
    itemName = name => name,
    buildingName = building => `${building.facility || 'Building'} ${building.id}`,
    buildingIcon = () => '',
    tr = value => value,
    formatSummary = (switches, buildingsCount) =>
        `${switches} ${switches === 1 ? 'switch' : 'switches'}/day · ${buildingsCount} ${buildingsCount === 1 ? 'building' : 'buildings'}`,
} = {}) {
    if (!schedule?.phases?.length) return '';
    const buildings = new Map((schedule.buildings || []).map(building => [building.id, building]));
    const switched = [...new Set(schedule.switchedBuildings || [])];
    const events = schedule.switches || [];
    const columns = scheduleColumns(schedule, switched);
    const colTitle = title => title === 'Morning' ? tr('Morning') : title;
    const label = values => values.length ? values.map(r => escape(itemName(r))).join(', ') : escape(tr('Idle'));
    const rows = switched.map(id => {
        const building = buildings.get(id) || {id};
        const icon = buildingIcon(building.facility);
        const cells = columns.map(({selected, title, changed: changes}) => {
            const current = selected.get(id);
            const changed = changes.has(id);
            return `<td data-time="${escape(colTitle(title))}"${changed ? ' class="recipe-schedule-changed"' : ''}>${changed ? '<span class="recipe-schedule-arrow" aria-hidden="true">→</span>' : ''}${label(current)}</td>`;
        }).join('');
        return `<tr><th scope="row"><span class="recipe-schedule-building">${icon ? `<img src="${escape(icon)}" alt="" width="32" height="32">` : ''}<span>${escape(buildingName(building))}</span></span></th>${cells}</tr>`;
    }).join('');
    return `<details class="recipe-schedule" open><summary><strong>${escape(tr('Daily recipe schedule'))}</strong> <span class="recipe-schedule-count">${escape(formatSummary(events.length, switched.length))}</span></summary>
        ${switched.length ? `<div class="recipe-schedule-scroll"><table class="recipe-schedule-table"><thead><tr><th scope="col">${escape(tr('Building'))}</th>${columns.map(c => `<th scope="col">${escape(colTitle(c.title))}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p>${escape(tr('No buildings change recipes.'))}</p>`}
    </details>`;
}
