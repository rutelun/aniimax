import {fixedPosts,addPostConstraints,plot} from './roster-fixed-posts.js';
import {productionObjective} from './priority-search.js';

// The two plans are the map draft and the final measured plan. Recipes can
// switch to E-mode between them, so discover disputes in their union.
export function sharedJobs(input, plans) {
    const final=plans.at(-1),posts=fixedPosts(final),possible=new Set(),full=new Set();
    for (const plan of plans) {
        for (const step of plan.coin_items) {
            if(step.status!=='producing'||plot(step.facility)||!(step.busy_units>0))continue;
            const key=step.facility+'|'+step.item_name+'|Production';
            if(step.busy_units < step.facility_count-1e-6)possible.add(key);
        }
    }
    // A full manual workplace stays with its final incumbent, even if the
    // draft had spare capacity there. Mixed sites can still have open batches.
    for(const key of posts.locked.keys()){
        const [facility,item]=key.split('|');
        const steps=final.coin_items.filter(s=>s.status==='producing'&&s.facility===facility&&s.item_name===item);
        if(steps.every(s=>s.busy_units>=s.facility_count-1e-6))full.add(key);
    }
    return Object.entries(input.roster.dispatch).flatMap(([key,policy])=>{
        const [facility,recipe,role]=key.split('|');
        if(role!=='Production'||!possible.has(key)||full.has(key))return [];
        const participants=policy.filter(e=>e.share>0);
        const copies=id=>input.roster.members[id]?.count??final.assumed_aniimo?.find(([member])=>member===id)?.[3]??0;
        const workers=participants.filter(e=>copies(e.member)>(posts.occupied.get(e.member)??0));
        if(participants.length<2||!workers.length)return [];
        return [{key,facility,recipe,role,workers}];
    });
}

// Solve in the full catalogue so idle recipes still have their material
// balances. Fix the number of physical sites per recipe; the crew can refit.
export function fitAssignments(pkg, highs, input, final, counts, assignments, {withPlan=false}={}) {
    const goals=final.comparison_goals,posts=fixedPosts(final);
    const mixed=new Set();
    const dispatch = {...input.roster.dispatch};
    for (const {key, member} of assignments) {
        const entry = dispatch[key].find(worker => worker.member === member && worker.share > 0);
        if (!entry) throw Error('Unmeasured worker on ' + key);
        const fixed=posts.locked.get(key);
        if(fixed?.size){
            // Positive shares retain the measured travel columns. Below, the
            // incumbent rates replace share equalities for a partially held job.
            mixed.add(key);
            const kept=dispatch[key].filter(e=>fixed.has(e.member)||e.member===member);
            if([...fixed.keys()].some(id=>!kept.some(e=>e.member===id)))return {status:'No worker route'};
            dispatch[key]=kept.map(e=>({...e,share:1/kept.length}));
        }else dispatch[key] = [{...entry, share:1}];
    }
    const active = Object.keys(counts).filter(name => counts[name] > 0);
    const data = {...input, roster:{...input.roster, dispatch}, always_running_recipes:active,
        recipe_site_limits:counts, restrict_to_checked_recipes:false};
    const stage = {floors:goals.floors.filter(([name]) => name !== goals.currency),
        crop_variety:goals.crop_variety, pace:goals.pace};
    const model = productionObjective(JSON.parse(pkg.exact_priority_problem(
        JSON.stringify(data), JSON.stringify(stage), goals.currency)));
    const sites = new Map(model.integer_groups.map(([name,terms]) => [name, terms.map(([v])=>v)]));
    for (const [v,name] of model.recipe_variables) {
        if (model.variable_keys[v].startsWith('continuous_site:')) {
            if (!sites.has(name)) sites.set(name,[]);
            sites.get(name).push(v);
        }
    }
    const rows = [...sites].map(([name,vs],i) =>
        ' fixed_sites_'+i+': '+vs.map(v=>'x'+v).join(' + ')+' = '+(counts[name]??0));
    for (const name of active) if (!sites.get(name)?.length) return {status:'Infeasible'};
    if(!addPostConstraints(model,posts,rows))return {status:"Fixed post unavailable"};
    let originalLp=model.lp;
    const assignedWork = [];
    const personWork = new Map();
    for (const {key,member} of assignments) {
        const [facility,recipe] = key.split('|');
        const options = model.recipe_options.filter(([,name,f])=>name===recipe && f===facility);
        // Switched-off electric batches must not count as personal work.
        for (const [v,,,,electric] of options) if(electric)rows.push(' manual_'+v+': x'+v+' = 0');
        if(mixed.has(key)){
            const eligible=new Set(options.filter(([v,,,,e])=>!e && model.variable_keys[v].includes('__by')).map(([v])=>v));
            const shares=dispatch[key].map(({member,share})=>new Map([...eligible].map(v=>[
                v,(model.variable_keys[v].includes('__by'+posts.memberKey(member)+'#')?1:0)-share
            ]).filter(([,coefficient])=>coefficient!==0)));
            originalLp=originalLp.split('\n').filter(line=>{
                if(!line.endsWith(' = 0'))return true;
                const terms=[...line.matchAll(/ ([+-]) ([0-9.eE+-]+) x(\d+)/g)]
                    .map(([,sign,c,v])=>[Number(v),Number(sign+c)]).filter(([,c])=>c!==0);
                return !terms.length||!shares.some(expected=>terms.length===expected.size &&
                    terms.every(([v,c])=>expected.get(v)===c));
            }).join('\n');
            const fixed=posts.locked.get(key);
            for(const v of eligible){
                const name=model.variable_keys[v];
                if(name.includes('__by'+posts.memberKey(member)+'#'))continue;
                if(![...fixed.keys()].some(id=>name.includes('__by'+posts.memberKey(id)+'#')))
                    rows.push(' other_'+v+': x'+v+' = 0');
            }
            for(const [id,held] of fixed)if(id!==member){
                const cols=[...eligible].filter(v=>model.variable_keys[v].includes('__by'+posts.memberKey(id)+'#'));
                rows.push(' fixed_share_'+rows.length+': '+cols.map(v=>'x'+v).join(' + ')+' = '+held.rate);
            }
        }
        let terms = model.staffing_pools[member]?.work.filter(([v]) => {
            const name=model.variable_keys[v];
            return (name.startsWith('route:'+recipe+':')||name.startsWith('route:'+recipe+'__'))&&!name.includes(':Some((');
        });
        if (!terms?.length && model.dispatched_work?.length) {
            terms = model.dispatched_work.filter(([v, m]) => {
                if (m !== member) return false;
                const name = model.variable_keys[v];
                return name.startsWith('rate:'+recipe+':') || name.startsWith('rate:'+recipe+'__');
            }).map(([v,,c]) => [v, c]);
        }
        if (!terms?.length) return {status:'No worker route'};
        assignedWork.push(terms);
        if (input.roster.members[member]?.count !== 1) {
            if (!personWork.has(member)) personWork.set(member,new Map());
            for (const [v,c] of terms) personWork.get(member).set(v,c);
        }
    }
    for (const [member,terms] of personWork) {
        rows.push(' single_worker_'+member+': '+[...terms].map(([v,c])=>c+' x'+v).join(' + ')+' <= 1');
    }
    const lp = originalLp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n');
    const precision = {mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9,primal_feasibility_tolerance:1e-9};
    let result = highs.solve(lp,precision);
    if (result.Status === 'Infeasible') result = highs.solve(lp,{...precision,presolve:'off'});
    if (result.Status !== 'Optimal') return {status:result.Status};
    const value = v=>result.Columns['x'+v]?.Primal??0;
    if (assignedWork.some(group=>!group.some(([v])=>value(v)>1e-9))) return {status:'Idle'};
    const hour=3600*model.primary_objective.reduce((n,[v,c])=>n+c*value(v),0);
    if(!withPlan)return {status:'Optimal',hour};
    const plan=JSON.parse(pkg.exact_plan(JSON.stringify(data),JSON.stringify(stage),JSON.stringify({
        values:model.variable_keys.map((_,v)=>value(v)),proven:false,bound:hour/3600,verify_only:true
    })));
    return plan.success?{status:'Optimal',hour,plan}:{status:'Unverified'};
}

export function sitePatterns(draft, final) {
    const names = new Set([...Object.keys(draft.continuous_site_counts),...Object.keys(final.continuous_site_counts)]);
    const counts = plan => Object.fromEntries([...names].map(n=>[n,plan.continuous_site_counts[n]??0]));
    const patterns = [{id:'current',counts:counts(final)}];
    const original = counts(draft);
    if (JSON.stringify(patterns[0].counts)!==JSON.stringify(original)) patterns.push({id:'draft',counts:original});
    return patterns;
}

export async function scanAssignments(pkg, highs, input, draft, final, onRow=()=>{}) {
    const jobs=sharedJobs(input,[draft,final]), patterns=sitePatterns(draft,final);
    const results=[];
    for (const job of jobs) {
        for (const {member,share} of job.workers) {
            const assignment={key:job.key,member};
            const fits={};
            for (const {id,counts} of patterns) {
                if (counts[job.recipe]>0) fits[id]=fitAssignments(pkg,highs,input,final,counts,[assignment]);
            }
            const row={...assignment,share,fits};
            results.push(row);
            await onRow(row);
        }
    }
    return results;
}
