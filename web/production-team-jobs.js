import {FACILITIES} from './facility-config.js';
import {criticalCropJob} from './crop-peaks.js';
import {scheduleProfiles} from './recipe-schedule-plan.js';

const facilities = new Map(FACILITIES.map(f => [f.name,f]));

export function productionTeamJobs(plan, recipes, labelFor = (step,task) => [step.facility,step.item_name,task.ability].join('|')) {
    const definitions = new Map(recipes.map(r => [r.name,r]));
    const profiles = scheduleProfiles(plan,true);
    const jobs = [];
    for (const step of plan.coin_items ?? []) {
        if (step.status !== 'producing' || step.electric_level != null) continue;
        const facility = facilities.get(step.facility);
        const resident = facility?.category === 'Aniimo Materials';
        const batches = step.cycle_time > 0 ? (step.busy_units ?? step.facility_count) / step.cycle_time : 0;
        const recipe = definitions.get(step.item_name);
        const key = step.facility + '|' + step.item_name;
        for (const task of step.aniimo_tasks ?? []) {
            jobs.push({
                ability:task.ability, level:task.level, label:labelFor(step,task), facility:step.facility,
                minimumLevel:recipe?.aniimo?.[1] ?? recipe?.jobs?.filter(([,ability]) => ability === task.ability)
                    .reduce((min,[,,level]) => Math.min(min,level),task.level) ?? task.level,
                siteCount:step.facility_count, profile:profiles.get(key), busy:resident ? step.facility_count : task.busy,
                siteKey:resident ? null : key,
                visitsPerShare:!resident && task.busy > 0 ? batches * (task.jobs?.length || 1) / task.busy : 0,
                growing:task.jobs?.length > 0, fixed:resident,
                critical:(task.jobs || []).some(criticalCropJob),
                duration:batches > 0 ? task.busy / batches / (task.jobs?.length || 1) : 0,
                personality:task.personality_bonus ? facility?.personality : null,
                family:task.ability === 'Leisure' ? recipe?.family : null,
            });
        }
    }
    return jobs;
}
