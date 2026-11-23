import {dispatchLocations} from './task-switching.js';
import {FACILITIES} from './facility-config.js';
import {distractionCount} from './best-team.js';
import catalog from './aniimo-catalog.json' with { type: 'json' };
import { plannedCropPeakTeam, criticalCropJob } from './crop-peaks.js?v=team-support';

const residents = new Set(FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name));

// Compare distinct crop ability profiles, not hundreds of near-identical forms.
// Production remains unchanged: these are additional crop-support candidates.
export function withCropSupport({pools,layout,recipes,limit,recommend=true,haulingBusy=pools.some(p=>p.allocations?.some(a=>a.ability==='Hauling' && a.busy>0))}) {
    const sites=dispatchLocations(layout);
    const active=recipes.filter(r=>sites.has(`${r.facility}|${r.name}`));
    const skills=[...new Set(active.flatMap(r=>(r.jobs||[]).filter(([name])=>criticalCropJob(name)).map(([,ability])=>ability)))].sort();
    const outside=active.filter(r=>r.aniimo && !residents.has(r.facility)).map(r=>({
        ability:r.aniimo[0],level:r.aniimo[1],family:r.family,siteCount:sites.get(`${r.facility}|${r.name}`).filter(s=>!s.occupied).length,
    }));
    if (haulingBusy>1e-6) outside.push({ability:'Hauling',level:1});
    const profiles=new Map();
    for(const entry of catalog.entries){
        const levels=skills.map(skill=>entry.abilities[skill]||0);
        if(!levels.some(Boolean))continue;
        const distractions=distractionCount(entry,outside);
        const key=levels.join('/'),previous=profiles.get(key);
        if(!previous||distractions<previous.distractions)profiles.set(key,{entry,levels,distractions});
    }
    const choices=[...profiles.values()].filter(c=>![...profiles.values()].some(other=>other!==c&&other.distractions<=c.distractions&&other.levels.every((n,i)=>n>=c.levels[i])&&other.levels.some((n,i)=>n>c.levels[i])));
    const candidates=choices.map(({entry,distractions})=>({entry,distractions,abilities:entry.abilities,family:entry.family,count:0,busy:0,allocations:[],tasks:new Map(),personalities:new Set(),peakSupport:true}));
    const all=[...pools.map(p=>({...p,helperDistractions:distractionCount(p.entry ?? p,outside)})),...candidates];
    const peak=plannedCropPeakTeam({layout,recipes,pools:all,limit,recommend});
    return {peak,pools:all};
}
