import {availableRecipes,twoAbilityInput,workerUsage} from './opportunity-comparison.js?v=two-ability';

// This orders searches; it never rejects a pair because it is idle in the current
// solution. The complete optimizer, not this estimate, decides the actual gain.
export function automaticReplacements(input,plan,recipes,levelFor=()=>4) {
    if(!input.roster)return [];
    const available=availableRecipes(input,recipes),residents=new Set(input.roster.residents||[]);
    const useful=new Set(),families=new Set();
    for(const r of available){
        if(r.aniimo){
            // A full-day resident cannot combine its resident job with a second job.
            // Its level/family upgrades are already ordinary Opportunities.
            if(!residents.has(r.facility))useful.add(r.aniimo[0]);
            if(r.aniimo[0]==='Leisure' && r.family)families.add(r.family);
        }
        for(const [,ability] of r.jobs||[])useful.add(ability);
    }
    for(const [building,ability] of Object.entries(input.roster.environment||{})){
        if(building==='Crackle Generator'?input.electricity?.watts>0
            :(input.facilities?.[building]||[]).some(t=>t.count>0))useful.add(ability);
    }
    if(input.roster.hauling_default_seconds>0 || (plan.delivery_assignments||plan.hauling_staffing||[]).length)useful.add('Hauling');
    const jobs=new Map(),load=new Map(),headroom=new Map();
    const add=(member,ability,days,level=4)=>{
        if(member==null || !ability || !(days>0))return;
        if(!jobs.has(member))jobs.set(member,new Set());
        jobs.get(member).add(ability);
        load.set(ability,(load.get(ability)||0)+days);
        headroom.set(ability,(headroom.get(ability)||0)+days*Math.max(0,levelFor(ability)-level));
    };
    for(const step of plan.coin_items||[])if(step.status==='producing')
        add(step.crew,step.aniimo?.ability,step.busy_units??step.facility_count,step.aniimo?.level);
    for(const [ability,level,member,days] of plan.crop_assignments||[])add(member,ability,days,level);
    for(const [building,member,days] of plan.staffing||[])add(member,input.roster.environment?.[building]||(building==='Crackle Generator'?'Lightning':null),days);
    for(const [member,days] of plan.delivery_assignments||plan.hauling_staffing||[])add(member,'Hauling',days,input.roster.members[member]?.abilities.Hauling||3);
    const usage=workerUsage(plan,input),abilities=[...useful].sort(),candidates=[];
    for(let i=0;i<abilities.length;i++)for(let j=i+1;j<abilities.length;j++){
        const pair=[abilities[i],abilities[j]],set=new Set(pair);
        // Partial workers with compatible roles are tried first. Walking/delivery
        // remain in busy days, so even the ordering doesn't assume free travel.
        const partial=[...(usage?.busy||[])].filter(([member,days])=>days>1e-6&&days<1-1e-6
            && jobs.has(member)&&[...jobs.get(member)].every(a=>set.has(a)));
        let merge=0;
        for(let a=0;a<partial.length;a++)for(let b=a+1;b<partial.length;b++){
            if(partial[a][1]+partial[b][1]<=1+1e-6)merge=Math.max(merge,2-partial[a][1]-partial[b][1]);
        }
        const score=10*merge+pair.reduce((s,a)=>s+(headroom.get(a)||0)+.1*Math.min(1,load.get(a)||0),0);
        for(const family of pair.includes('Leisure')?[...families].sort():[null]){
            const inputWithPair=twoAbilityInput(input,Object.fromEntries(pair.map(a=>[a,levelFor(a)])),family);
            const member=inputWithPair.roster.members.at(-1);
            candidates.push({kind:'Two-ability replacements',
                group:`replacement:${JSON.stringify([Object.entries(member.abilities),member.family])}`,
                label:pair.map(a=>`${a} Lv.${levelFor(a)}`).join(' + '),input:inputWithPair,score,
                description:'One Aniimo with two abilities and no personality.'});
        }
    }
    return candidates.sort((a,b)=>b.score-a.score||a.group.localeCompare(b.group));
}
