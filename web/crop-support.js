import catalog from './aniimo-catalog.json' with { type: 'json' };
import { plannedCropPeakTeam, criticalCropJob } from './crop-peaks.js?v=team-support';

// Compare distinct crop ability profiles, not hundreds of near-identical forms.
// Production remains unchanged: these are additional crop-support candidates.
export function withCropSupport({pools,layout,recipes,limit}) {
    const activeKeys=new Set(layout.pieces.flatMap(p=>p.members.flatMap(s=>(s.jobs||[{item:s.crop}]).map(j=>`${s.facility}|${j.item}`))));
    const active=recipes.filter(r=>activeKeys.has(`${r.facility}|${r.name}`));
    const skills=[...new Set(active.flatMap(r=>(r.jobs||[]).filter(([name])=>criticalCropJob(name)).map(([,ability])=>ability)))].sort();
    const outside=active.flatMap(r=>r.aniimo?[r.aniimo]:[]);
    const profiles=new Map();
    for(const entry of catalog.entries){
        const levels=skills.map(skill=>entry.abilities[skill]||0);
        if(!levels.some(Boolean))continue;
        const distractions=outside.filter(([skill,level])=>(entry.abilities[skill]||0)>=level).length + Number(!!entry.abilities.Hauling);
        const key=levels.join('/'),previous=profiles.get(key);
        if(!previous||distractions<previous.distractions)profiles.set(key,{entry,levels,distractions});
    }
    const choices=[...profiles.values()].filter(c=>![...profiles.values()].some(other=>other!==c&&other.distractions<=c.distractions&&other.levels.every((n,i)=>n>=c.levels[i])&&other.levels.some((n,i)=>n>c.levels[i])));
    const candidates=choices.map(({entry})=>({entry,abilities:entry.abilities,family:entry.family,count:0,busy:0,allocations:[],tasks:new Map(),personalities:new Set(),peakSupport:true}));
    const all=[...pools,...candidates];
    const peak=plannedCropPeakTeam({layout,recipes,pools:all,limit});
    return {peak,pools:all};
}
