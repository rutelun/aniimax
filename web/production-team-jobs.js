import {FACILITIES} from './facility-config.js';
import {criticalCropJob} from './crop-peaks.js';
import {siteSchedule} from './recipe-timeline.js';
import {scheduleProfiles} from './recipe-schedule-plan.js';

import {fullyStaffed} from './physical-production.js';

const facilities = new Map(FACILITIES.map(f => [f.name,f]));

export function productionTeamJobs(plan, recipes, labelFor = (step,task) => [step.facility,step.item_name,task.ability].join('|')) {
    const definitions = new Map(recipes.map(r => [r.name,r]));
    const profiles = scheduleProfiles(plan,true);
    const sitesByRecipe = new Map();
    for (const site of plan.recipe_schedule?.sites ?? []) {
        const phases = siteSchedule(plan.recipe_schedule,site.id);
        for (const job of site.jobs) {
            if (job.electric_level != null || !(job.rate > 0)) continue;
            const key = site.facility + '|' + job.item;
            if (!sitesByRecipe.has(key)) sitesByRecipe.set(key,[]);
            sitesByRecipe.get(key).push({id:site.id,rate:job.rate,occupied:fullyStaffed(site,job.item,phases),profile:phases.map(p=>(p.rates[job.item] ?? 0)/job.rate)});
        }
    }
    const jobs = [];
    for (const step of plan.coin_items ?? []) {
        if (step.status !== 'producing' || step.electric_level != null) continue;
        const facility = facilities.get(step.facility);
        const resident = facility?.category === 'Aniimo Materials';
        const batches = step.cycle_time > 0 ? (step.busy_units ?? step.facility_count) / step.cycle_time : 0;
        const recipe = definitions.get(step.item_name);
        const key = step.facility + '|' + step.item_name;
        for (const task of step.aniimo_tasks ?? []) {
            const job = {
                item:step.item_name, ability:task.ability, level:task.level, label:labelFor(step,task), facility:step.facility,
                minimumLevel:recipe?.aniimo?.[1] ?? recipe?.jobs?.filter(([,ability]) => ability === task.ability)
                    .reduce((min,[,,level]) => Math.min(min,level),task.level) ?? task.level,
                siteCount:step.facility_count, profile:profiles.get(key), busy:resident ? step.facility_count : task.busy,
                siteKey:resident ? null : key,
                visitsPerShare:!resident && task.busy > 0 ? batches * (task.jobs?.length || 1) / task.busy : 0,
                growing:task.jobs?.length > 0, fixed:resident, workstation:!resident && !task.jobs?.length,
                occupied:!task.jobs?.length && step.facility_count>0 && (step.busy_units ?? task.busy)>=step.facility_count-1e-6,
                critical:(task.jobs || []).some(criticalCropJob),
                duration:batches > 0 ? task.busy / batches / (task.jobs?.length || 1) : 0,
                personality:task.personality_bonus ? facility?.personality : null,
                family:task.ability === 'Leisure' ? recipe?.family : null,
            };
            const sites = job.workstation && sitesByRecipe.get(key);
            if (sites?.length) {
                const total = sites.reduce((sum,s)=>sum+s.rate,0);
                for (const site of sites) jobs.push({...job,scheduleId:site.id,siteCount:1,occupied:site.occupied,
                    busy:job.busy*site.rate/total,profile:site.profile});
            } else jobs.push(job);
        }
    }
    return jobs;
}
