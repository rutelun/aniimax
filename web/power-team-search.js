import {recommendBestTeam, protectedShift, generatorDistractions, cropWorkshopDistractions} from './best-team.js';
import {productionTeamJobs} from './production-team-jobs.js';
import {powerTeamCandidates,singleWorkshopUpgrades} from './power-team-candidates.js';
import {createPowerTeamValidator} from './power-team-validation.js';

const byEstimate = (a,b) => a.cropWorkshopDistractions-b.cropWorkshopDistractions || a.people-b.people || a.distractions-b.distractions || a.work-b.work ||
    b.plan.power_generated-a.plan.power_generated || a.plan.power_used-b.plan.power_used;
const ordinaryModes = p => p.schedule_sources.filter(s=>!s.turns && s.electric_level!=null).map(s=>s.id).sort().join('|');

function estimate(plan,recipes) {
    const jobs=productionTeamJobs(plan,recipes);
    const team=recommendBestTeam(jobs,plan.hauling_busy??0,[],{
        phaseDurations:plan.recipe_schedule?.phases.map(p=>p.duration),
    });
    const {shifts}=team;
    const open=jobs.filter(j=>!j.fixed && !j.occupied && j.busy>1e-6);
    if (plan.hauling_busy>1e-6) open.push({ability:'Hauling',level:1});
    const riskByLevel=new Map();
    const powerRisk=level=>{
        if (!riskByLevel.has(level)) riskByLevel.set(level,generatorDistractions(level,open));
        return riskByLevel.get(level);
    };
    const cropRisk=shifts.filter(protectedShift).reduce((sum,s)=>sum+s.distractions,0);
    return {powerRisk,cropRisk,cropWorkshopDistractions:cropWorkshopDistractions(team),people:shifts.length,work:shifts.reduce((v,s)=>v+s.busy,0)};
}

// Keep backups for native verification while streaming the candidates. Identical
// schedules and modes can be served by several generator tiers at the same count.
function retain(pool,entry) {
    const prior=pool.findIndex(x=>x.key===entry.key);
    if(prior>=0) {
        if(byEstimate(entry,pool[prior])>=0)return;
        pool.splice(prior,1);
    }
    pool.push(entry);
    pool.sort(byEstimate);
    if(pool.length>8) {
        // Protect the best candidate for each changeover pattern so a run
        // of near-identical schedules does not crowd out every alternative.
        const patterns=new Set();
        let redundant=-1;
        for(let i=0;i<pool.length;i++) {
            if(patterns.has(pool[i].shared))redundant=i;
            patterns.add(pool[i].shared);
        }
        pool.splice(redundant<0?pool.length-1:redundant,1);
    }
}

export async function shortlistPowerTeams(pkg,highs,plan,input) {
    if(!input?.e_mode_rv||input.roster||input.fixed_homeland||!plan?.schedule_sources?.length)return [];
    const validator=createPowerTeamValidator(pkg,highs,plan,input);
    if(!validator)return [];
    const recipes=JSON.parse(pkg.get_all_items()), incumbentModes=ordinaryModes(plan);
    const groups=new Map(), estimates=new WeakMap();
    for(const candidate of powerTeamCandidates(plan,input,validator.problem,recipes)) {
        const count=candidate.power_generators;
        if(!groups.has(count))groups.set(count,{unchanged:[],changed:[]});
        let score=estimates.get(candidate.coin_items);
        if(!score) {
            const sites=candidate.recipe_schedule?.sites??[];
            const shared=sites.filter(s=>s.jobs.length>1).map(s=>s.jobs.map(j=>j.item).sort().join('+')).sort().join('|');
            const modes=ordinaryModes(candidate);
            const key=JSON.stringify([modes,sites.map(s=>[s.id,s.electric_level,...s.jobs.map(j=>j.item)])]);
            score={...estimate(candidate,recipes),shared,key,unchanged:modes===incumbentModes};
            estimates.set(candidate.coin_items,score);
        }
        const group=groups.get(count);
        retain(score.unchanged?group.unchanged:group.changed,{
            ...score,plan:candidate,
            distractions:candidate.power_generator_levels.reduce((n,[,level])=>n+score.powerRisk(level),score.cropRisk),
            people:score.people+count,work:score.work+count,
        });
    }
    const verified=[];
    for(const {unchanged,changed} of groups.values()) {
        const pending=[...unchanged,...changed].sort(byEstimate), chosen=[];
        while(pending.length && chosen.length<3) {
            // Keep an incumbent ordinary-mode alternative and a different
            // daily changeover where both survive native verification.
            let index=-1;
            if(chosen.length===1)index=pending.findIndex(x=>x.unchanged!==chosen[0].unchanged);
            if(chosen.length && index<0)index=pending.findIndex(x=>!chosen.some(c=>c.shared===x.shared));
            const [entry]=pending.splice(Math.max(0,index),1);
            try {
                const plan=await validator.validate(entry.plan);
                if(plan)chosen.push({...entry,plan});
            } catch {
                // A failed candidate leaves other certified schedules eligible.
            }
        }
        verified.push(...chosen);
    }
    return verified.sort(byEstimate).map(({plan})=>{
        const upgrades=[];
        for (const candidate of singleWorkshopUpgrades(plan,input,validator.problem,recipes)) {
            try {
                const upgraded=validator.validate(candidate);
                if (upgraded) upgrades.push(upgraded);
            } catch {
                // Keep the certified base schedule when an upgrade fails verification.
            }
        }
        return {plan,upgrades};
    });
}

const validScore = score => Number.isSafeInteger(score?.people) && score.people>=0 &&
    Number.isSafeInteger(score.generators) && score.generators>=0;

export function improvesMeasuredTeam(candidate, incumbent) {
    if (!incumbent) return true;
    const cropDifference=(candidate.cropWorkshopDistractions ?? 0)-(incumbent.cropWorkshopDistractions ?? 0);
    if (cropDifference) return cropDifference<0;
    if (Math.abs(candidate.income-incumbent.income)>1e-7) return candidate.income>incumbent.income;
    if (candidate.people !== incumbent.people) return candidate.people < incumbent.people;
    if (candidate.generators !== incumbent.generators) return candidate.generators > incumbent.generators;
    if ((candidate.networks ?? 0) !== (incumbent.networks ?? 0)) return (candidate.networks ?? 0) > (incumbent.networks ?? 0);
    return (candidate.distractions ?? 0) < (incumbent.distractions ?? 0);
}

export async function selectPowerTeam(plan,candidates,measure,isCurrent=()=>true) {
    if(!candidates?.length || !isCurrent())return plan;
    let winner=plan,best;
    try { best=await measure(plan); } catch { return plan; }
    if(best!=null && !validScore(best))return plan;
    for(const candidate of candidates) {
        if(!isCurrent())return plan;
        let score;
        try { score=await measure(candidate); } catch { continue; }
        if(!validScore(score))continue;
        if (improvesMeasuredTeam(score, best)) {
            best=score;
            winner=candidate;
        }
    }
    return isCurrent()?winner:plan;
}
