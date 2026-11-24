// Size the physical workshops for one RV upgrade. All quantities are
// fractional batches, as in the exact production model.
import {materialChains} from './material-flow-schedule.js';
import {productionObjective} from './priority-search.js';
import {questIncome} from './quest-income.js';

const DAY=86400;
const rawResources={wood_block:'Wood Blocks',mineral_sand:'Mineral Sand'};

function amounts(entries){
    const result=new Map();
    for(const [name,n] of entries??[])result.set(name,(result.get(name)??0)+n);
    return result;
}

function workshopInputs(input,catalog){
    const excluded=new Set(input.exclude??[]);
    return Object.entries(materialChains).map(([facility,names])=>{
        const raw=facility==='Woodworking Bench'?'wood_block':'mineral_sand';
        const sites=input.facilities?.[facility]??[];
        const jobs=names.map((recipe,i)=>{
            const item=catalog.get(recipe), feed=i?names[i-1]:raw;
            if(item?.raw_materials?.length!==1 || item.raw_materials[0]!==feed ||
                !(item.required_amount?.[0]>0 && item.yield_amount>0))return null;
            return {recipe,input:feed,quantity:item.required_amount[0],yield:item.yield_amount,
                open:!excluded.has(recipe)&&sites.some(t=>t.count>0 && t.level>=item.facility_level)};
        });
        return {facility,raw,names,jobs};
    });
}

function backgroundRates(input,plan,catalog){
    const rates=new Map(),quest=questIncome(input.quest_income_per_day);
    for(const [raw,resource] of Object.entries(rawResources)){
        const produced=(plan.byproduct_rates??[]).reduce((sum,[name,n])=>sum+(name===resource?n:0),0);
        rates.set(raw,produced+(quest[raw]??0)/DAY);
    }
    for(const row of plan.coin_items??[]){
        if(row.status!=='producing' || materialChains[row.facility]?.includes(row.item_name))continue;
        const item=catalog.get(row.item_name);
        if(!item)return null;
        for(const [i,feed] of (item.raw_materials??[]).entries()){
            if(!(row.cycle_time>0 && row.busy_units>=0))return null;
            rates.set(feed,(rates.get(feed)??0)-item.required_amount[i]*row.busy_units/row.cycle_time);
        }
    }
    return rates;
}

// A downstream shortfall is the maximum of zero and a few affine functions
// of elapsed time. Pass every term upstream so stock at one tier can never
// pay both its direct cost and the same units in the next recipe.
export function workshopDemand(input,plan,catalog,capacity={},minimumSeconds=1){
    const target=input.level_up??input.level_up_preview;
    if(!target?.cost?.length || !plan)return null;
    const stock=amounts(target.stock),cost=amounts(target.cost);
    if([...cost].every(([name,n])=>n<=(stock.get(name)??0)))return null;
    const chains=workshopInputs(input,catalog),rates=backgroundRates(input,plan,catalog);
    if(!rates)return null;
    const report=plan.level_up_preview??plan.level_up;
    const otherRates=new Map((report?.requirements??[]).map(r=>[r.name,r.per_second]));
    const currency=plan.currency??input.currency??'coins';
    if(currency==='coins')otherRates.set('coins',plan.rate_per_second);
    else if(!otherRates.has('coins'))otherRates.set('coins',plan.priorities?.find(p=>p.target==='coins')?.per_second??0);
    const materials=new Set(chains.flatMap(c=>[c.raw,...c.names]));
    let earliest=Math.max(1,minimumSeconds),latest=Infinity;
    // Every constraint has the form amount <= perSecond * horizon.
    const constrain=(amount,perSecond)=>{
        if(perSecond>0)earliest=Math.max(earliest,amount/perSecond);
        else if(perSecond<0)latest=Math.min(latest,amount/perSecond);
        else if(amount>0)earliest=Infinity;
    };
    const deficit=name=>(cost.get(name)??0)-(stock.get(name)??0);
    for(const [name] of cost){
        if(!materials.has(name))constrain(deficit(name),otherRates.get(name)??0);
    }
    for(const chain of chains){
        let downstream=[[0,0]];
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i],name=chain.names[i];
            const net=rates.get(name)??0;
            const work=downstream.map(([n,r])=>[n+deficit(name),r-net]);
            const max=job?.open?(capacity[name]??Infinity):0;
            if(Number.isFinite(max)){
                for(const [n,r] of work)constrain(n,max*(job?.yield??1)-r);
            }
            downstream=job?[[0,0],...work.map(([n,r])=>[n*job.quantity/job.yield,r*job.quantity/job.yield])]:[[0,0]];
        }
        chain.supply=rates.get(chain.raw)??0;
        for(const [n,r] of downstream)constrain(n+deficit(chain.raw),chain.supply-r);
    }
    if(!Number.isFinite(earliest)||earliest>latest)return null;
    const seconds=earliest;
    for(const chain of chains){
        let downstream=0;
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i];
            if(!job)continue;
            const items=Math.max(0,downstream+deficit(job.recipe)-(rates.get(job.recipe)??0)*seconds);
            job.batches=items/job.yield;
            job.rate=job.batches/seconds;
            downstream=job.batches*job.quantity;
        }
        chain.jobs=chain.jobs.filter(job=>job?.open);
    }
    return {seconds,chains};
}

// Give the source model just the net raw cost of the upgrade. It can vary
// all gathering and income together while keeping shared workers, crops,
// seasonal minimums, stations, power and earlier priorities in the same model.
export function optimizeWorkshopSources(pkg,highs,input,base,catalog){
    const target=input.level_up??input.level_up_preview;
    if(!target?.cost?.length || input.fixed_homeland)return null;
    const cost=amounts(target.cost),stock=amounts(target.stock),facilities={...input.facilities};
    let needsGathering=false;
    for(const chain of workshopInputs(input,catalog)){
        let needed=0;
        for(let i=chain.jobs.length-1;i>=0;i--){
            const job=chain.jobs[i],name=chain.names[i];
            needed=Math.max(0,needed+(cost.get(name)??0)-(stock.get(name)??0));
            if(needed && !job?.open)return null;
            needed=needed* (job?job.quantity/job.yield:0);
            cost.delete(name);
            stock.delete(name);
        }
        const rawCost=needed+(cost.get(chain.raw)??0);
        if(rawCost)cost.set(chain.raw,rawCost);
        needsGathering ||= rawCost>(stock.get(chain.raw)??0);
        facilities[chain.facility]=[{count:0,level:1}];
    }
    if(!needsGathering)return null;
    const sourceInput={...input,currency:'coins',facilities,level_up:null,level_up_preview:{cost:[...cost],stock:[...stock]}};
    const priorities=input.priorities??[],rv=priorities.indexOf('level_up');
    const protectedGoals=new Set(rv<0?priorities:priorities.slice(0,rv));
    if(input.prioritize_byproducts)for(const resource of Object.values(rawResources))protectedGoals.add(resource);
    const floors=new Map((base.comparison_goals?.floors??[]).filter(([name])=>protectedGoals.has(name)));
    for(const {target,per_second} of base.priorities??[]){
        if(protectedGoals.has(target))floors.set(target,per_second);
    }
    // Rust allows 1e-4 slack on a currency floor between stages. Undo
    // that allowance here so releasing the workshops cannot spend coin income.
    const currency=base.currency??input.currency??'coins';
    if(protectedGoals.has(currency) || rv<0)floors.set(currency,base.rate_per_second);
    if(floors.has('coins'))floors.set('coins',floors.get('coins')/(1-1e-4));
    const stage={floors:[...floors],crop_variety:base.comparison_scores?.crop_variety??null};
    const payload=JSON.stringify(sourceInput);
    const problem=productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),'level_up')));
    if(!problem.lp)return null;
    const current=workshopDemand(input,base,catalog);
    const lp=problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd');
    const relaxation=highs.solve(lp);
    if(relaxation.Status!=='Optimal' || !(relaxation.ObjectiveValue>0) ||
        current && DAY/relaxation.ObjectiveValue>=current.seconds*(1-1e-8))return null;
    const solution=highs.solve(problem.lp,{mip_rel_gap:0,mip_abs_gap:0});
    if(solution.Status!=='Optimal' || !(solution.ObjectiveValue>0) ||
        current && DAY/solution.ObjectiveValue>=current.seconds*(1-1e-8))return null;
    const values=problem.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0);
    const verified=JSON.parse(pkg.exact_plan(payload,JSON.stringify({...stage,pace:solution.ObjectiveValue}),
        JSON.stringify({values,verify_only:true,proven:false,bound:0})));
    if(!verified.success)return null;
    verified.comparison_seed={keys:problem.variable_keys,values};
    verified.active_continuous_recipes=[...new Set(problem.recipe_options.filter(([v])=>values[v]>1e-9).map(([,name])=>name))];
    return {plan:verified};
}
