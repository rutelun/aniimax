import {PERSONALITY_PAIRS} from './facility-config.js';
import {buildReactiveDispatch} from './reactive-dispatch.js';
import {fixedPosts} from './roster-fixed-posts.js';
import {fitAssignments} from './roster-swap-model.js';

const productionKey=r=>r.facility+'|'+r.name+'|Production';
const can=(m,ability,level)=>m?.abilities?.[ability]>=level;

export function allowedForm(fromPrismana,toPrismana) {
    return fromPrismana || !toPrismana;
}

function replacements(from,roster,ability,level,prismana) {
    const old=roster[from];
    // Price all allowed profiles, starting with the closest match to the other work.
    const other=Object.entries(old.abilities).filter(([a])=>a!==ability);
    const score=m=>other.reduce((n,[a,l])=>n+Math.min(l,m.abilities[a]??0),0);
    const candidates=roster.map((m,id)=>({m,id,score:score(m)}))
        .filter(({m,id})=>allowedForm(prismana[from],prismana[id]) && !can(m,ability,level)).sort((a,b)=>b.score-a.score||a.id-b.id);
    return candidates.map(c=>c.id);
}

export function swapProposals(rows,input,final,recipes,prismana) {
    const proposals=new Map(),posts=fixedPosts(final),roster=input.roster.members;
    const byKey=new Map(recipes.map(r=>[productionKey(r),r]));
    for(const row of rows){
        if(!Object.values(row.fits).some(f=>f.status==='Optimal'&&Math.round(f.hour-final.rate_per_second*3600)>0))continue;
        const recipe=byKey.get(row.key);
        if(!recipe?.aniimo)continue;
        const [ability,level]=recipe.aniimo;
        roster.forEach((old,from)=>{
            const occupied=posts.occupied.get(from)??0;
            if(from===row.member||!can(old,ability,level)||old.count<=occupied)return;
            // Leaving a slow/interfering worker off the homeland can directly improve dispatch income.
            proposals.set(from+'|null',{from,to:null});
            for(const to of replacements(from,roster,ability,level,prismana))
                proposals.set(from+'|'+to,{from,to});
        });
    }
    return [...proposals.values()];
}

// For an extra copy, keep recorded traits and fill open pairs only when a
// compatible active production job rewards one of the two traits.
export function replacementTraits(input,final,recipes) {
    const byKey=new Map(recipes.map(r=>[productionKey(r),r]));
    return input.roster.members.map(m=>{
        const weights=new Map();
        for(const s of final.coin_items){
            if(s.status!=='producing'||!(s.busy_units>0))continue;
            const r=byKey.get(s.facility+'|'+s.item_name+'|Production'),trait=input.roster.personalities?.[s.facility];
            if(!r?.aniimo||!trait||!can(m,...r.aniimo)||(r.family&&r.family!==m.family))continue;
            weights.set(trait,(weights.get(trait)??0)+s.busy_units);
        }
        const result=[...(m.personalities??[]).filter(Boolean)];
        for(const {names} of PERSONALITY_PAIRS){
            if(names.some(n=>result.includes(n)))continue;
            const best=names.filter(n=>weights.has(n)).sort((a,b)=>weights.get(b)-weights.get(a))[0];
            if(best)result.push(best);
        }
        return result;
    });
}

export function swappedTeam(input,final,changes,traits){
    const members=input.roster.members.map(m=>({...m}));
    for(const {from,to} of changes){
        if(to==null){
            members[from]={...members[from],count:Math.max(0,members[from].count-1)};
        }else if(members[from].count===1){
            members[from]={...input.roster.members[to],count:1,personalities:traits?.[to]??input.roster.members[to].personalities};
        }else{
            members[from]={...members[from],count:Math.max(0,members[from].count-1)};
            members[to]={...members[to],count:members[to].count+1};
        }
    }
    const expanded=[...members];
    for(const [id,ability,level,count,family] of final.assumed_aniimo??[])
        expanded[id]={count,abilities:{[ability]:level},family,assumed:true,personalities:[]};
    return {members,expanded};
}

// Only retain existing measured shares for jobs whose eligible workers and speeds
// did not change. Full posts keep their actual operators throughout the refit.
function newPolicy(scenario,changes,recipes,team,posts,plan){
    const {input,map}=scenario,previous={...input.roster.dispatch};
    const touched=new Set();
    for(const {from,to} of changes){
        touched.add(from);
        if(to!=null && input.roster.members[from]?.count>1)touched.add(to);
    }
    for(const r of recipes){
        const jobs=[...(r.aniimo?[['Production',...r.aniimo]]:[]),...(r.jobs??[]).map(([,a,l])=>[a,a,l]),['Hauling','Hauling',1]];
        for(const [role,ability,level] of jobs){
            const key=r.facility+'|'+r.name+'|'+role;
            if([...touched].some(idx=>{
                const a=input.roster.members[idx],b=team.expanded[idx];
                return (can(a,ability,level)||can(b,ability,level)) && (
                    a.count!==b.count||a.abilities[ability]!==b.abilities[ability]||a.family!==b.family||
                    (a.personalities??[]).includes(input.roster.personalities?.[r.facility])!==
                    (b.personalities??[]).includes(input.roster.personalities?.[r.facility]));
            }))delete previous[key];
        }
    }
    const permanent=team.expanded.map((_,i)=>posts.occupied.get(i)??0);
    const policy=buildReactiveDispatch({layout:map,recipes,members:team.expanded,permanent,busy:plan.roster_workload,
        routes:plan.roster_routes,previous});
    for(const [key] of posts.locked)if(input.roster.dispatch[key])policy[key]=input.roster.dispatch[key];
    return policy;
}

export function neededSwapTraits(fullTraits, evaluate, targetHour, tolerance = 0.5) {
    const candidates = [...new Set((fullTraits ?? []).filter(Boolean))];
    if (!candidates.length) return [];
    const bare = evaluate([]);
    if (bare != null && bare >= targetHour - tolerance) return [];
    let kept = candidates;
    for (const trait of candidates) {
        const trial = kept.filter(t => t !== trait);
        const hour = evaluate(trial);
        if (hour != null && hour >= targetHour - tolerance) kept = trial;
    }
    return kept;
}

export function scanSwaps(pkg,highs,scenario,rows,onProgress=()=>{}){
    const {input,final}=scenario,posts=fixedPosts(final);
    const recipes=JSON.parse(pkg.get_all_items()).map(r=>({...r,ingredients:r.raw_materials}));
    const proposals=swapProposals(rows,input,final,recipes,scenario.prismana),results=[];
    const traits=replacementTraits(input,final,recipes);
    if(!proposals.length)return {rows:[],traits,checked:0};
    const counts=final.continuous_site_counts;
    const savedHour=final.rate_per_second*3600;
    function hourlyIncome(changes,overrideTraits=null){
        const activeTraits=overrideTraits?traits.map((list,i)=>changes.some(c=>c.to===i)?overrideTraits:list):traits;
        const team=swappedTeam(input,final,changes,activeTraits);
        let plan=final;
        for(let pass=0;pass<2;pass++){
            const dispatch=newPolicy(scenario,changes,recipes,team,posts,plan);
            const next={...input,roster:{...input.roster,members:team.members,dispatch}};
            const fit=fitAssignments(pkg,highs,next,final,counts,[],{withPlan:true});
            if(!fit.plan)return null;
            plan=fit.plan;
        }
        return plan.rate_per_second*3600;
    }
    // Compare against both the displayed plan and an unchanged roster through the
    // same route refit. A better reprice by itself is not income from a swap.
    const control=hourlyIncome([]);
    if(control==null)throw Error('Could not verify baseline roster income.');
    const baseline=Math.max(savedHour,control);
    for(const change of proposals){
        const hour=hourlyIncome([change]);
        if(hour!=null && Math.round(hour-baseline)>0){
            const needed=change.to!=null && input.roster.members[change.from]?.count===1
                ? neededSwapTraits(traits[change.to],trial=>hourlyIncome([change],trial),hour)
                : [];
            results.push({...change,hour,gain:hour-baseline,traits:needed});
        }
        onProgress();
    }
    results.sort((a,b)=>b.gain-a.gain || a.from-b.from || (a.to??-1)-(b.to??-1));
    return {rows:results,checked:proposals.length,traits,baseline};
}
