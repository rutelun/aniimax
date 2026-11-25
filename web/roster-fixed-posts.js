import {splitProductionSites} from './physical-production.js';

const epsilon=1e-6;
export const plot=facility=>facility==='Farmland'||facility==='Woodland';

export function fixedPosts(plan) {
    const locked=new Map(), occupied=new Map();
    for(const step of plan.coin_items) {
        if(step.status!=='producing'||step.electric_level!=null||plot(step.facility)||!(step.cycle_time>0))continue;
        const key=step.facility+'|'+step.item_name+'|Production';
        const add=(member,count,rate)=>{
            if(!locked.has(key))locked.set(key,new Map());
            const group=locked.get(key),held=group.get(member)??{count:0,rate:0};
            held.count+=count;held.rate+=rate;group.set(member,held);
            occupied.set(member,(occupied.get(member)??0)+count);
        };
        const load=(step.busy_units??step.facility_count)/step.facility_count;
        if(step.crew!=null) {
            if(load>=1-epsilon)add(step.crew,step.facility_count,(step.busy_units??step.facility_count)/step.cycle_time);
            continue;
        }
        const sites=splitProductionSites(step,plan.roster_routes);
        if(sites) {
            for(const site of sites)if(site.load>=1-epsilon)add(site.crew,1,site.rate);
        } else if(load>=1-epsilon) {
            // A fully busy shared station can use several alternating workers.
            // Keep the rates of all incumbents even when none occupies a whole copy.
            for(const r of plan.roster_routes) {
                if(r.facility!==step.facility||r.item!==step.item_name||r.job_rate<=0||r.jobs?.some(([name])=>name))continue;
                add(r.member,0,r.job_rate);
            }
        }
    }
    for(const [,member,count] of plan.staffing??[])occupied.set(member,(occupied.get(member)??0)+count);
    const memberKey = member=>{
        const reserve=plan.assumed_aniimo?.find(([id])=>id===member);
        if(!reserve)return 'owned:'+member;
        const [,ability,level,,family]=reserve;
        return 'reserve:{'+JSON.stringify(ability)+': '+level+'}:'+(family==null?'None':'Some('+JSON.stringify(family)+')');
    };
    return {locked,occupied,memberKey,staff:plan.staffing??[]};
}

export function addPostConstraints(model,posts,rows) {
    const slots=new Map(),index=new Map(model.variable_keys.map((name,v)=>[name,v]));
    for(const [v,item,facility,,electric] of model.recipe_options) {
        if(electric)continue;
        const key=facility+'|'+item+'|Production';
        if(!posts.locked.has(key))continue;
        if(!slots.has(key))slots.set(key,[]);
        slots.get(key).push(v);
    }
    for(const [key,group] of posts.locked)for(const [member,held] of group){
        const suffix='__by'+posts.memberKey(member)+'#';
        const columns=(slots.get(key)??[]).filter(v=>model.variable_keys[v].includes(suffix));
        if(!columns.length)return false;
        rows.push(' held_rate_'+rows.length+': '+columns.map(v=>'x'+v).join(' + ')+' >= '+held.rate);
    }
    for(const [building,member,count] of posts.staff){
        if(count<=0)continue;
        const v=index.get('staff:'+building+':'+posts.memberKey(member)+'#0');
        if(v==null)return false;
        rows.push(' held_post_'+v+': x'+v+' >= '+count);
    }
    return true;
}
