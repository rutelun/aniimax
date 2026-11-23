// The first material-switch trial has the same workshops regardless of the
// ordinary plan's layout. Bound that plan before paying for its lower priorities.
import {priorityCeiling,requiredSiteRows} from './priority-ceilings.js';
import {materialChains} from './material-flow-schedule.js';
import {productionObjective} from './priority-search.js';
import {reservedSeasonScore} from './season-planning.js';

// The direct schedule runs two raw processors at dawn, then one. Use the
// already-solved relaxation to decide whether trying this schedule first is
// worthwhile. The ordinary ordered search still considers every proposal.
export function suggestsMaterialFlow(problem, values, input) {
    const chains=new Map(), switchable=new Set();
    const columns=new Map(problem.variable_keys.map((key,v)=>[key,v]));
    for(const [v,name,facility,,electric,cycle] of problem.recipe_options){
        const tier=materialChains[facility]?.indexOf(name)??-1,rate=values[v];
        if(tier<0 || !(rate>1e-9))continue;
        if(!chains.has(facility))chains.set(facility,Array(4).fill(0));
        const chain=chains.get(facility);
        if(electric || chain[tier]>0)return false;
        chain[tier]=rate*cycle;
        if(tier && canRunAtCapacity(problem,columns,input,v,cycle))switchable.add(facility);
        if(tier===0 && input.roster){
            const crew=/__by(?:owned:)?(\d+)#/.exec(problem.variable_keys[v]);
            if(crew && input.roster.members?.[Number(crew[1])]?.count<2)return false;
        }
    }
    return switchable.size===chains.size && chains.size>0 && [...chains.values()].every(chain=>chain.every(load=>load>0)
        && chain[0]>1+1e-8 && chain[0]<2-1e-8);
}

export function upgradeSwitchBounds(pkg, highs, input, trial) {
    const payload = settings => JSON.stringify({...settings, always_running_recipes:[], restrict_to_checked_recipes:false});
    let plausible=false;
    const pace = (data,checkFlow=false) => {
        const problem = JSON.parse(pkg.exact_priority_problem(data, '{"floors":[]}', 'level_up'));
        return priorityCeiling(highs, productionObjective(problem), 'level_up', checkFlow ? model=>{
            const source=model.getSolution().colValue,values=new Float64Array(problem.variables);
            for(let i=0;i<source.length;i++)values[Number(model.getColName(i).slice(1))]=source[i];
            plausible=suggestsMaterialFlow(problem,values,input);
        } : undefined);
    };
    const switched = pace(payload(trial),true);
    if (!plausible || !(switched > 0) || !Number.isFinite(switched)) return null;
    const ordinary = payload(input), fixed = pace(ordinary);
    if (!(fixed > 0) || !Number.isFinite(fixed)) return null;
    // A relaxation already too slow to beat the fixed-plan bound cannot
    // furnish this proof. Leave the ordinary comparison to rank those plans.
    if (!(switched > fixed * (1 + 2e-5))) return null;
    const crop = input.crop_variety || input.season
        ? reservedSeasonScore(pkg,input) ?? priorityCeiling(highs, JSON.parse(pkg.exact_crop_variety_problem(ordinary)), 'crop_variety') : null;
    if ((input.crop_variety || input.season) && !Number.isFinite(crop)) return null;
    return {seconds:86400 / fixed, crop};
}

// A positive workload below half a site-day must run entirely in the
// shorter phase: even one site in the longer phase would exceed it.
// For N sites and a workload in [lo,hi], that phase lasts at least lo/N
// and at most hi of the day. Intersect intervals only within one workshop.
function fitsShortPhase(highs,problem,trial,options) {
    const recipes=new Map();
    for(const [column] of problem.switching_rates) {
        const [,recipe,facility,,,cycle]=options.get(column);
        const key=JSON.stringify([facility,recipe]);
        if(!recipes.has(key))recipes.set(key,{facility,rates:[]});
        recipes.get(key).rates.push([column,cycle]);
    }
    if(recipes.size<2)return true;
    const cuts=requiredSiteRows(problem);
    const lp=problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd')
        .replace('\nBounds\n','\n'+cuts.join('\n')+'\nBounds\n');
    const model=highs.createModel({format:'lp',data:lp});
    try {
        const count=model.getDimensions().numCols;
        const native=new Map(Array.from({length:count},(_,i)=>[Number(model.getColName(i).slice(1)),i]));
        model.options.set({primal_feasibility_tolerance:1e-9,dual_feasibility_tolerance:1e-9});
        model.changeColsCost({kind:'range',from:0,to:count-1},Array(count).fill(0));
        const intervals=new Map();
        let previous=[];
        for(const {facility,rates} of recipes.values()) {
            const cap=trial.facilities?.[facility]?.reduce((n,t)=>n+t.count,0);
            if(!Number.isSafeInteger(cap) || cap<=0)continue;
            const terms=rates.map(([v,c])=>[native.get(v),c]).sort(([a],[b])=>a-b);
            if(terms.some(([v])=>v==null))continue;
            if(previous.length)model.changeColsCost({kind:'set',indices:previous},previous.map(()=>0));
            const indices=terms.map(([v])=>v),cycles=terms.map(([,c])=>c);
            previous=indices;
            // Match the tolerance for ignored trace rates and physical workloads.
            const slack=1e-5*(1+cap)+cycles.reduce((n,c)=>n+c*1.1e-7,0);
            model.changeColsCost({kind:'set',indices},cycles.map(c=>-c));
            model.run();
            if(model.getModelStatus()!==highs.constants.modelStatus.optimal)continue;
            const lo=-model.getObjectiveValue()-slack;
            if(!(lo>0 && lo<0.5))continue;
            model.changeColsCost({kind:'set',indices},cycles);
            model.run();
            if(model.getModelStatus()!==highs.constants.modelStatus.optimal)continue;
            const hi=model.getObjectiveValue()+slack;
            if(!(hi>=lo && hi<0.5))continue;
            const [min,max]=intervals.get(facility)??[0,0.5];
            const low=Math.max(min,lo/cap),high=Math.min(max,hi);
            if(low>high)return false;
            intervals.set(facility,[low,high]);
        }
        return true;
    } finally {model.dispose();}
}

function mandatoryOwnedRoute(problem,columns,v,cycle){
    const owned=/^rate:(.+__byowned:(\d+))#0$/.exec(problem.variable_keys[v]);
    if(!owned)return null;
    const member=Number(owned[2]), route='route:'+owned[1]+':owned:'+member+':None:';
    const mobile=columns.get(route+'true#0');
    const assigned=mobile!=null && !columns.has(route+'false#0')
        ? problem.staffing_pools?.[member]?.work?.find(([column])=>column===mobile) : null;
    return {member,seconds:Math.max(cycle,assigned?.[1]??cycle)};
}

function canRunAtCapacity(problem,columns,trial,v,cycle){
    const route=mandatoryOwnedRoute(problem,columns,v,cycle);
    const count=trial.roster?.members?.[route?.member]?.count;
    return !route || !Number.isSafeInteger(count) || route.seconds/cycle<=count+1e-5;
}

// In the ordinary always-running schedule an active site is busy for every
// phase. Its facility and power mode never change. Summed over a day, the
// workload for each such group must equal its whole number of active sites.
// Relax all other integer decisions except the selected recipes' worker posts.
function fitsWholeSites(highs, problem, trial) {
    const options = new Map(problem.recipe_options.map(option=>[option[0],option]));
    const groups = new Map(), recipes = new Set(), loads = new Map();
    for (const [column,tier] of problem.switching_rates) {
        const option = options.get(column);
        if (!option || !Number.isFinite(option[5]) || option[5]<=0) return true;
        const [,recipe,facility,,,cycle] = option;
        const key = JSON.stringify([facility,tier]);
        if (!groups.has(key)) groups.set(key,[]);
        groups.get(key).push([column,cycle]);
        recipes.add(recipe);
        const recipeKey = JSON.stringify([facility,tier,recipe]);
        if (!loads.has(recipeKey)) loads.set(recipeKey,{facility,tier,rates:[]});
        loads.get(recipeKey).rates.push([column,cycle]);
    }
    if (!groups.size || !fitsShortPhase(highs,problem,trial,options)) return false;
    const rows = [], sites = [];
    const columns=new Map(problem.variable_keys.map((key,v)=>[key,v]));
    for(const {rates} of loads.values()){
        const routes=rates.map(([v,cycle])=>mandatoryOwnedRoute(problem,columns,v,cycle));
        for(const member of new Set(routes.filter(Boolean).map(route=>route.member))){
            const count=trial.roster?.members?.[member]?.count;
            if(!Number.isSafeInteger(count) || count<0)continue;
            const terms=rates.map(([v,cycle],i)=>[v,(routes[i]?.member===member?routes[i].seconds:0)-count*cycle]);
            if(!terms.some(([,c])=>c>1e-7))continue;
            // A selected recipe keeps at least one site busy. Even with jobs
            // split across operators, its elapsed time cannot exceed the sum
            // of its machine-seconds. Omitted trace rates retain their slack.
            const slack=terms.reduce((n,[,c])=>n+Math.abs(c)*1.1e-7,1e-5*(1+count));
            const work=terms.filter(([,c])=>c!==0).map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');
            rows.push(' recipe_crew_'+rows.length+': '+work+' <= '+slack);
        }
    }
    for (const rates of groups.values()) {
        const site = 'sw'+sites.length;
        const work = rates.map(([v,cycle])=>cycle+' x'+v).join(' + ');
        // scheduleInputForPlan drops individual rates at or below 1e-7.
        // Allow their full combined workload and the schedule's rounding slack.
        const slack = 1e-5 + rates.reduce((n,[,cycle])=>n+cycle*1e-7,0);
        rows.push(' lo_'+site+': '+work+' - 0.99999 '+site+' >= -'+slack,
            ' hi_'+site+': '+work+' - 1.00001 '+site+' <= '+slack);
        sites.push(site);
    }
    rows.push(' active_switch_site: '+sites.join(' + ')+' >= 1');
    const general = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const posts = (general?.[1].match(/\bx\d+\b/g)||[]).filter(column=>{
        const key = problem.variable_keys[Number(column.slice(1))];
        return key?.startsWith('post:') && recipes.has(key.slice(5).split(/__|:/,1)[0]);
    });
    // With one daily change per workshop, each recipe runs on a whole number
    // of sites before and after the same fraction of the day. Pool all
    // worker variants: a site may hand the same recipe to another operator.
    // Encode the signed change in site count as binary digits times that
    // shared fraction. Resource, staffing and tier compatibility remain relaxed.
    if (!scheduleFeasible(highs,problem,rows,[...sites,...posts])) return false;
    const phaseIntegers=[];
    const fractions=new Map();
    for (const {facility,tier,rates} of loads.values()) {
        const stock=trial.facilities?.[facility];
        if (!Array.isArray(stock)) continue;
        const cap=stock.reduce((sum,t)=>sum+(tier==null || t.level===tier ? t.count : 0),0);
        if (!Number.isSafeInteger(cap) || cap<=0) continue;
        if (!fractions.has(facility)) {
            const name='switch_fraction'+fractions.size;
            fractions.set(facility,name);
            rows.push(' duration_'+name+': '+name+' <= 1');
        }
        const fraction=fractions.get(facility);
        const id=phaseIntegers.length, after='after'+id;
        const count=[], products=[];
        for (let weight=1; weight<=2*cap; weight*=2) {
            const bit='bit'+id+'_'+weight, part='part'+id+'_'+weight;
            rows.push(' bin_'+bit+': '+bit+' <= 1',
                ' use_'+bit+': '+part+' - '+bit+' <= 0',
                ' time_'+bit+': '+part+' - '+fraction+' <= 0',
                ' on_'+bit+': '+part+' - '+fraction+' - '+bit+' >= -1');
            phaseIntegers.push(bit);
            count.push(weight+' '+bit);
            products.push(weight+' '+part);
        }
        phaseIntegers.push(after);
        const before=[after,...count].join(' + ');
        rows.push(' last_'+id+': '+after+' <= '+cap,
            ' first_lo_'+id+': '+before+' >= '+cap,
            ' first_hi_'+id+': '+before+' <= '+(2*cap));
        const work=rates.map(([v,c])=>c+' x'+v).join(' + ');
        const residual=work+' - '+after+' + '+cap+' '+fraction+' - '+products.join(' - ');
        const slack=1e-5*(1+cap)+rates.reduce((n,[,c])=>n+c*1.1e-7,0);
        rows.push(' phase_lo_'+id+': '+residual+' >= -'+slack,
            ' phase_hi_'+id+': '+residual+' <= '+slack);
    }
    return !phaseIntegers.length || scheduleFeasible(highs,problem,rows,[...sites,...posts,...phaseIntegers]);
}

// A downstream recipe occupies one site. At the raw tier a steady site runs
// all day and a temporary site may use a different worker until its switch.
// Electric jobs keep their original relaxation in this feasibility check.
function fitsMaterialFlow(pkg, highs, problem, trial) {
    const switching = new Set(problem.switching_rates.map(([column])=>column));
    const groups = new Map();
    for (const [v,recipe,facility,,electric,cycle] of problem.recipe_options) {
        if (!switching.has(v) || electric || !materialChains[facility]?.includes(recipe)) continue;
        if (!(cycle>0) || !Number.isFinite(cycle)) return true;
        if (!groups.has(recipe)) groups.set(recipe,[]);
        groups.get(recipe).push([v,cycle]);
    }
    const rows=[], selectors=[], rawLoads=[], rawRecipes=new Set();
    const dawnCrew=new Map(), activeChains=new Map(), switchable=new Map();
    const columns=new Map(problem.variable_keys.map((key,v)=>[key,v]));
    for (const [recipe,variants] of groups) {
        if (!Object.values(materialChains).some(chain=>chain[0]===recipe)) continue;
        rawRecipes.add(recipe);
        const active='chain'+rawLoads.length,work=variants.map(([v,c])=>c+' x'+v).join(' + ');
        const slack=1e-5+variants.reduce((n,[,c])=>n+c*1.1e-7,0);
        // The raw processor has two sites before the change and one
        // afterwards. An unselected chain need only allow omitted trace rates.
        rows.push(' chain_bit_'+active+': '+active+' <= 1',
            ' chain_on_'+active+': '+work+' - 2 '+active+' <= '+slack,
            ' chain_lo_'+active+': '+work+' - '+active+' >= -'+slack);
        // Select one variant per raw site. Both sites may use the same
        // variant when that worker pool can cover their simultaneous load.
        const steady=[],temporary=[];
        for (const [v,cycle] of variants) {
            const full=variants.length===1?active:'steady'+v;
            const extra=variants.length===1?active:'temporary'+v;
            if(variants.length>1){
                steady.push(full);
                temporary.push(extra);
                rows.push(' steady_site_'+v+': '+cycle+' x'+v+' - '+full+' >= -'+slack,
                    ' raw_sites_'+v+': '+cycle+' x'+v+' - '+full+' - '+extra+' <= '+slack);
            }
            const route=mandatoryOwnedRoute(problem,columns,v,cycle);
            if (!route) continue;
            const {member,seconds}=route, count=trial.roster?.members?.[member]?.count;
            if(!Number.isSafeInteger(count))continue;
            const load=Math.max(1,seconds/cycle);
            if(!dawnCrew.has(member))dawnCrew.set(member,new Map());
            const sites=dawnCrew.get(member);
            for(const site of [full,extra])sites.set(site,(sites.get(site)??0)+load);
        }
        if(steady.length){
            rows.push(' steady_raw_'+active+': '+steady.join(' + ')+' - '+active+' = 0',
                ' temporary_raw_'+active+': '+temporary.join(' + ')+' - '+active+' = 0');
            selectors.push(...steady,...temporary);
        }
        rawLoads.push(active);
        activeChains.set(recipe,active);
    }
    // Both chains start their extra raw site at dawn, even when the two
    // facilities switch at different times. Count the owned crew jointly.
    for(const [member,sites] of dawnCrew){
        const terms=[...sites].map(([site,workers])=>workers+' '+site);
        const capacity=trial.roster.members[member].count;
        rows.push(' dawn_crew_'+member+': '+terms.join(' + ')+' <= '+(capacity+1e-7));
    }
    if (rawLoads.length) {
        rows.push(' flow_active: '+rawLoads.join(' + ')+' >= 1');
        selectors.push(...rawLoads);
    }
    // Each downstream processor drains all arrivals over the repeating day.
    // Compare only switching columns: fixed electric jobs keep their own rates.
    if (pkg.get_all_items) {
        const items=new Map(JSON.parse(pkg.get_all_items()).map(item=>[item.name,item]));
        for(const chain of Object.values(materialChains))for(let i=1;i<chain.length;i++){
            const before=groups.get(chain[i-1]), after=groups.get(chain[i]);
            if(!before || !after)continue;
            const next=items.get(chain[i]),prev=items.get(chain[i-1]);
            if(prev?.yield_amount!==1 || next?.raw_materials?.length!==1 || next.raw_materials[0]!==prev.name)continue;
            const quantity=next.required_amount?.[0];
            if(!(quantity>0))continue;
            const net=before.map(([v])=>'x'+v).join(' + ')+' - '+after.map(([v])=>quantity+' x'+v).join(' - ');
            // The daily validator accepts a relative error of 1e-6 for each
            // job. Bound it by the largest rate allowed on two processor sites.
            const slack=variants=>variants.reduce((sum,[,cycle])=>sum+1.1e-7+1.1e-6*(2/cycle+1/86400),0);
            const tolerance=slack(before)+quantity*slack(after);
            rows.push(' feed_lo_'+after[0][0]+': '+net+' >= -'+tolerance,
                ' feed_hi_'+after[0][0]+': '+net+' <= '+tolerance);
        }
    }
    for (const [recipe,variants] of groups) {
        if(rawRecipes.has(recipe))continue;
        const eligible=[];
        switchable.set(recipe,eligible);
        if(variants.length===1){
            const [[v,cycle]]=variants;
            if(canRunAtCapacity(problem,columns,trial,v,cycle))switchable.delete(recipe);
            rows.push(' downstream_site_'+v+': '+cycle+' x'+v+' <= '+(1.00001+cycle*1.1e-7));
            continue;
        }
        const group=[];
        for (const [v,cycle] of variants) {
            const selected='flow'+v;
            group.push(selected);
            if(canRunAtCapacity(problem,columns,trial,v,cycle))eligible.push(selected);
            // Allow rates omitted by scheduleInputForPlan and the daily audit slack.
            rows.push(' flow_load_'+v+': '+cycle+' x'+v+' - 1.00001 '+selected+' <= '+(1e-5+cycle*1.1e-7));
        }
        rows.push(' flow_recipe_'+group[0]+': '+group.join(' + ')+' <= 1');
        selectors.push(...group);
    }
    // Before the switch every upstream tier produces into the waiting
    // recipe's buffer. At the change that site must run at its full rate
    // until it exhausts the buffer. At least one downstream operator must
    // therefore cover a whole site, walking included.
    for(const chain of Object.values(materialChains)){
        const active=activeChains.get(chain[0]), choices=chain.slice(1).map(recipe=>switchable.get(recipe));
        if(!active || choices.some(group=>!group))continue;
        const operators=choices.flat();
        rows.push(' switch_crew_'+chain[0]+': '+active+operators.map(v=>' - '+v).join('')+' <= 0');
    }
    return !selectors.length || scheduleFeasible(highs,problem,rows,selectors);
}

function scheduleFeasible(highs,problem,rows,integers) {
    const relaxed = problem.lp.replace(/\nGeneral\n[\s\S]*?\nEnd/,'\nEnd');
    const lp = relaxed.replace(/Maximize\n[\s\S]*?\nSubject To\n/,'Maximize\n obj: 0 x0\nSubject To\n')
        .replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n')
        .replace('\nEnd','\nGeneral\n '+integers.join('\n ')+'\nEnd');
    const model = highs.createModel({format:'lp',data:lp});
    try {
        model.run();
        if (model.getModelStatus()===highs.constants.modelStatus.infeasible) {
            // As in the ordinary planner, confirm an infeasibility report
            // without presolve before discarding a candidate.
            model.options.set({presolve:'off'});
            model.clearSolver();
            model.run();
        }
        return model.getModelStatus()!==highs.constants.modelStatus.infeasible;
    } finally {
        model.dispose();
    }
}

export function canFillSwitchingWorkshop(pkg, highs, trial, baseline) {
    if (!trial.always_running || trial.level_up_strategy || trial.level_up
        || trial.level_up_preview?.stock?.some(([,n])=>n>0)) return true;
    const facilities = trial.recipe_switching_facilities||[];
    const powered = trial.electricity || trial.e_mode_rv>=12;
    // The direct four-tier schedule permits ingredient-starved downstream
    // sites. Its raw processor still has to supply over a full site-day.
    const flow = trial.recipe_switching_normal_only && Object.keys(materialChains).some(facility=>
        (!facilities.length || facilities.includes(facility))
        && (trial.facilities?.[facility]||[]).reduce((n,t)=>n+t.count,0)>=4);

    const payload=JSON.stringify({...trial,always_running_recipes:[],restrict_to_checked_recipes:false});
    const seconds = baseline?.level_up_preview?.seconds;
    const stage = {floors:[]};
    let cropCanImprove=!!(trial.season || trial.crop_variety);
    const crop=baseline?.comparison_scores?.crop_variety;
    if (cropCanImprove && baseline?.success && Number.isSafeInteger(crop) && crop>=0) {
        stage.crop_variety=crop;
        const upper=reservedSeasonScore(pkg,trial) ??
            priorityCeiling(highs,JSON.parse(pkg.exact_crop_variety_problem(payload)),'crop_variety');
        cropCanImprove=upper==null || upper>crop;
    }
    if (!cropCanImprove && baseline?.success && baseline.priorities?.[0]?.target==='level_up'
        && trial.priorities?.[0]==='level_up' && trial.level_up_preview && seconds>0 && Number.isFinite(seconds)) {
        // A slower upgrade can tie within improvesPlan's relative tolerance.
        stage.pace = 86400 / (seconds + 2e-5*Math.max(1,seconds));
    }
    const first=baseline?.priorities?.[0], currency=trial.currency||'coins';
    if (baseline?.success && !cropCanImprove && first?.target===currency
        && trial.priorities?.[0]===currency && Number.isFinite(first.per_second) && first.per_second>0) {
        // Material work can win an income tie, including one just inside the
        // ranking tolerance. Keep that entire interval in this relaxation.
        stage.floors.push([currency,Math.max(0,first.per_second-2e-5*Math.max(1,first.per_second))]);
    }
    const problem=JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),trial.currency||'coins'));
    const options=problem.recipe_options;
    if(!options?.length || !problem.lp.startsWith('Maximize\n'))return true;
    if (Array.isArray(problem.switching_rates) && problem.variable_keys?.length===problem.variables) {
        if (flow && fitsMaterialFlow(pkg,highs,problem,trial)) return true;
        return fitsWholeSites(highs,problem,trial);
    }
    if (powered || flow || !facilities.length) return true;
    const sites=new Set(facilities);
    const work=options.filter(([, ,facility])=>sites.has(facility)).map(([v,,,,,cycle])=>[v,cycle]);
    if(!work.length || work.some(([,cycle])=>!Number.isFinite(cycle)||cycle<=0))return true;
    const upper=priorityCeiling(highs,productionObjective({...problem,primary_objective:work}),'work');
    return !Number.isFinite(upper)||upper>=1-1e-5;
}
