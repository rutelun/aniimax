import {recommendBestTeam, placeBestJobs, protectedShift, cropWorkshopDistractions} from './best-team.js';
import {buildDispatch} from './task-switching.js';
import {haulingScheduleProfile} from './recipe-schedule-plan.js';
import {FACILITIES} from './facility-config.js';
import {withCropSupport} from './crop-support.js';

const residents = new Set(FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name));

export function packMappedTeam(plan, jobs, layout, hauling, haulingBusy, recipes, options = {}) {
    const dispatch = layout && buildDispatch(layout, recipes, hauling, residents);
    const level = hauling?.courierLevel ?? (options.preferMinimum ? 1 : 4);
    const sameAtThree = level === 4 && hauling?.jobs?.every(j => Math.abs(j.seconds[3]-j.seconds[4]) < 1e-9);
    return recommendBestTeam(placeBestJobs(jobs, layout, dispatch?.locations), haulingBusy,
        dispatch?.opportunities ?? [], {
            phaseDurations:plan.recipe_schedule?.phases.map(p => p.duration),
            haulingLevel:level, sharedHaulingLevel:sameAtThree ? 3 : level,
            haulingProfile:haulingScheduleProfile(plan, hauling, level),
            preferMinimum: Boolean(options.preferMinimum),
        });
}

export function addHarvestHelpers(team, layout, recipes, limit, recommend=true) {
    const pools = team.shifts.map(shift => ({...shift, busy:Math.max(shift.busy,...(shift.phaseBusy ?? [])), count:1}));
    const {pools:choices, peak} = withCropSupport({layout, recipes, pools, limit, recommend});
    team.cropPeaks = peak;
    for (const {member,count} of peak.additions) for (let i=0; i<count; i++) {
        const helper=choices[member];
        team.shifts.push({...helper, distractions:helper.helperDistractions ?? helper.distractions, busy:0, tasks:new Map(), allocations:[], peakSupport:true});
    }
    return team;
}

// Harvest helpers only add shifts. Before adding them, this same score is an
// optimistic bound for this particular placement, including all generator posts.
export function mappedTeamScore(team, grid, limit, income) {
    if (grid.disconnected || team.shifts.length>limit || team.cropPeaks?.recommendedTargetMet===false ||
        team.shifts.some(s => !s.entry || s.busy>1+1e-6 || s.phaseBusy?.some(n=>n>1+1e-6))) return null;
    const active=grid.networks.filter(n=>n.consumers && n.generated>0);
    const generators=active.reduce((sum,n)=>sum+n.generators,0);
    const manualWork=Math.max(0,team.shifts.reduce((n,s)=>n+(s.busy??0),0)-generators);
    const distractions = team.shifts.filter(protectedShift).reduce((n,s) => n + (s.distractions ?? 0), 0);
    return {...(Number.isFinite(income) ? {income} : {}),distractions,cropWorkshopDistractions:cropWorkshopDistractions(team),people:team.shifts.length,generators,networks:active.length,manualWork};
}
