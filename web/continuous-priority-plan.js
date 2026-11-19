// Fast path for the explicit priority list. Global ceilings use all unlocked
// recipes. Candidate models check work conservation on every occupied site.
const version = new URL(import.meta.url).search;
const {priorityCeiling} = await import('./priority-ceilings.js'+version);
const {productionObjective} = await import('./priority-search.js'+version);
const {solveEconomicBound,suggestEconomicScope} = await import('./economic-bound.js'+version);
const {polishSolution} = await import('./highs-solve.js'+version);
const {refineStaffing} = await import('./staffing-search.js'+version);
const {continuousNeighborhood} = await import('./continuous-neighborhood.js'+version);
const {economicRecipeCounts,economicCountNeighborhood} = await import('./economic-recipe-counts.js'+version);

const options = seconds => ({time_limit:seconds,mip_rel_gap:0,mip_abs_gap:0,mip_feasibility_tolerance:1e-9});
const close = (a,b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a));
const stageKey = (key,stage) => JSON.stringify([key,stage],(_,v)=>typeof v==='number'?Number(v.toPrecision(12)):v);
const sum = (terms,values) => terms.reduce((total,[v,c])=>total+c*values[v],0);
const expression = terms => terms.map(([v,c])=>(c<0?'- ':'+ ')+Math.abs(c)+' x'+v).join(' ');

function align(problem,seed) {
    if (!seed?.keys || seed.keys.length!==seed.values?.length) return;
    const previous = new Map(seed.keys.map((key,i)=>[key,seed.values[i]]));
    return problem.variable_keys.map(key=>key.startsWith('extra#')?0:previous.get(key)??0);
}

function restrict(problem,names) {
    const off = new Set(problem.recipe_variables.filter(([,name])=>!names.has(name)).map(([v])=>v));
    const lp = problem.lp.replace(/^ (?:0 <= x(\d+) <= [^\n]+|x(\d+) >= 0)$/gm,
        (line,a,b)=>off.has(Number(a??b))?` 0 <= x${a??b} <= 0`:line);
    return {...problem,lp,continuousRestricted:true};
}

function addRows(problem,rows) {
    return rows.length?{...problem,lp:problem.lp.replace('\nBounds\n','\n'+rows.join('\n')+'\nBounds\n')}:problem;
}

function keepRawIncome(problem,income,minimum) {
    if (!(minimum>0)) return problem;
    const index = new Map(problem.variable_keys.map((key,i)=>[key,i]));
    const terms = income.primary_objective.map(([v,c])=>[index.get(income.variable_keys[v]),c]);
    if (terms.some(([v])=>v===undefined)) return null;
    return addRows(problem,[' retain_currency: '+expression(terms)+' >= '+(minimum-1e-8)]);
}

function siteCounts(problem,values) {
    const groups = new Map();
    for (const [name,terms] of problem.integer_groups??[]) {
        groups.set(name,[...(groups.get(name)??[]),...terms]);
    }
    for (const [v,name] of problem.recipe_variables) if (problem.variable_keys[v].startsWith('continuous_site:')) {
        groups.set(name,[...(groups.get(name)??[]),[v,1]]);
    }
    return Object.fromEntries([...groups].map(([name,terms])=>[name,Math.round(sum(terms,values))]));
}

function fixPhysical(problem,warm,recipeSitesOnly=false) {
    if (!warm) return problem;
    const general=problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const rows=[];
    for (const match of (general?.[1]??'').matchAll(/\bx(\d+)\b/g)) {
        const v=Number(match[1]);
        const key=problem.variable_keys[v];
        if (recipeSitesOnly?!/^(?:units|continuous_site):/.test(key):key.startsWith('extra#'))continue;
        rows.push(` site_fix_${v}: x${v} = ${Math.round(warm[v])}`);
    }
    return addRows(problem,rows);
}

export async function tryPriorityPlan(pkg,input,{highs,solveModel,step=()=>{},first=()=>{},initialWitness,
    evaluateBound,evaluateCounts} = {}) {
    const currency=input.currency||'coins', priorities=[...(input.priorities??[])];
    if(!priorities.includes(currency))priorities.push(currency);
    const pos=priorities.indexOf(currency);
    if (!input.always_running || input.level_up_strategy || input.prioritize_byproducts
        || input.recipe_switching?.max_buildings || input.level_up || !highs || !solveModel) return null;
    const witnessSeed=initialWitness?.seed??initialWitness?.comparison_seed;
    const oldGoals=initialWitness?.goals??initialWitness?.comparison_goals;
    const oldScores=initialWitness?.scores??initialWitness?.comparison_scores;
    const witnessNames=initialWitness?.recipes??initialWitness?.continuous_checked_recipes??[];
    const payloadFor=(scope,restricted=false)=>JSON.stringify({...input,always_running_recipes:[...scope],
        restrict_to_checked_recipes:restricted});
    const relaxed=payloadFor([]);
    const priority=(payload,stage,key)=>key==='crop_variety'?JSON.parse(pkg.exact_crop_variety_problem(payload))
        :productionObjective(JSON.parse(pkg.exact_priority_problem(payload,JSON.stringify(stage),key)));
    const exact=(payload,stage)=>JSON.parse(pkg.exact_problem(payload,JSON.stringify(stage)));
    const stage={floors:[]}, bounds=[], early=[];
    const prefix=[...(input.crop_variety||input.season?['crop_variety']:[]),...priorities.slice(0,pos)];
    for(const key of prefix){
        const p=priority(relaxed,stage,key);
        if(!p.lp && key==='level_up')continue;
        if(!p.lp)return null;
        let upper=priorityCeiling(highs,p,key);
        if(!Number.isFinite(upper))return null;
        const before=structuredClone(stage);
        early.push({key,before,upper,terms:(key==='crop_variety'?[]:p.primary_objective??[]).map(([v,c])=>[p.variable_keys[v],c])});
        bounds.push([stageKey(key,stage),upper]);
        if(key==='crop_variety')stage.crop_variety=upper;
        else if(key==='level_up'){if(upper>1e-9)stage.pace=upper;}
        else stage.floors.push([key,upper]);
    }
    const currencyStage=structuredClone(stage), raw=priority(relaxed,stage,currency);
    if(!raw.production_only || !raw.recipe_variables?.length)return null;
    const lpCeiling=priorityCeiling(highs,raw,currency);
    let upper=Number.isFinite(lpCeiling)?lpCeiling:Infinity;
    const priorSales=new Set(early.flatMap(({terms})=>terms.filter(([key,c])=>c>0&&key.startsWith('sold:'))
        .map(([key])=>key.slice(5).replace(/#\d+$/,''))));
    let scope=[],best;
    const names=new Set(witnessNames);
    const active=(p,values)=>p.recipe_variables.filter(([v])=>values[v]>1e-9).map(([,name])=>name);
    const addActive=(p,seed)=>{
        if(!seed)return;
        const values=align(p,seed);
        if(values)for(const n of active(p,values))names.add(n);
    };
    addActive(raw,witnessSeed);
    const checkedCandidate=async (seed,fixed=true,sourceModel)=>{
        if(!seed||!names.size)return;
        const payload=payloadFor(names,true), p=restrict(priority(payload,currencyStage,currency),names), warm=align(p,seed);
        let model=fixed?fixPhysical(p,warm):continuousNeighborhood(p,[...names],seed);
        if(sourceModel) {
            // Excluding inactive crops can renumber climate choices. Retain
            // recipe and worker rates, and let the full model assign coverage.
            const from=new Map(seed.keys.map((k,i)=>[k,seed.values[i]]));
            const rows=p.recipe_variables.flatMap(([v])=>{
                const key=p.variable_keys[v],value=from.get(key);
                return Number.isFinite(value)?[` restore_${v}: x${v} = ${value}`]:[];
            });
            model=addRows(p,rows);
        }
        if(!fixed&&best)model=keepRawIncome(model,p,best.objective+2e-7);
        let candidate=await solveModel(model,options(fixed?1:2),undefined,warm);
        if(!candidate?.values&&fixed&&!sourceModel) {
            model=fixPhysical(p,warm,true);
            candidate=await solveModel(model,options(1),undefined,warm);
        }
        if(!candidate?.values)return;
        const polished=polishSolution(highs,model,candidate);
        const objective=sum(p.primary_objective,polished.values);
        if(!Number.isFinite(objective) || objective<=0 || best&&best.objective>=objective-1e-9)return;
        best={keys:p.variable_keys,values:polished.values,objective};
    };
    const oldCurrency=oldGoals?.currency_value;
    const repairModes=async (countsHint)=>{
        if(!best)return;
        const p=restrict(priority(payloadFor(names,true),currencyStage,currency),names);
        const warm=align(p,best),counts=countsHint??siteCounts(p,warm);
        const occupied=new Map(Object.entries(counts).filter(([,n])=>n>0));
        // Keep the whole number of sites per recipe but let electric and
        // worker-operated variants trade places across every facility.
        const local=economicCountNeighborhood(highs,p,occupied,best.objective+1e-7);
        if(!local)return;
        const result=await solveModel(local,options(1.5));
        if(!result?.values)return;
        const polished=polishSolution(highs,local,result);
        const objective=sum(p.primary_objective,polished.values);
        if(objective>best.objective+1e-8)best={keys:p.variable_keys,values:polished.values,objective};
    };
    const dispatched=Object.keys(input.roster?.dispatch??{}).length>0;
    const masterOptions={seed:witnessSeed,scope:[],timeLimit:2};
    let pending=evaluateBound?{model:raw,result:evaluateBound(raw,masterOptions)}:null;
    const countOptions={input,timeLimit:2};
    const countJob=evaluateCounts?evaluateCounts(raw,countOptions):null;
    if(witnessSeed){
        await checkedCandidate(witnessSeed);
        if(!best)await checkedCandidate(witnessSeed,true,raw);
        await repairModes(initialWitness.counts??initialWitness.continuous_site_counts);
    }
    {
        const counts=countJob?await countJob:economicRecipeCounts(highs,raw,countOptions);
        if(counts?.size&&economicCountNeighborhood){
            const allowed=new Set(counts.keys());
            for(const name of allowed)names.add(name);
            const compact=priority(payloadFor(allowed,true),currencyStage,currency);
            const local=economicCountNeighborhood(highs,compact,counts,(counts.upper??0)/1.0025);
            if(local){
                const found=await solveModel(local,{time_limit:2,mip_rel_gap:0});
                if(found?.values){
                    const fit=polishSolution(highs,local,found);
                    await checkedCandidate({keys:compact.variable_keys,values:fit.values},true,compact);
                }
            }
            if(Number.isFinite(counts.upper))upper=Math.min(upper,counts.upper);
        }
    }
    for(let round=0;round<3;round++){
        const model=pending?.model??(round===0?raw:priority(payloadFor(scope),currencyStage,currency));
        const settings={seed:best??witnessSeed,scope:round===0?[]:scope,timeLimit:round===0?2:5};
        const result=pending?await pending.result:evaluateBound?await evaluateBound(model,settings):solveEconomicBound(highs,model,settings);
        pending=null;
        if(Number.isFinite(result?.upper))upper=Math.min(upper,result.upper);
        if(result?.values){
            for(const n of result.activeRecipes)names.add(n);
        }
        const nearFloorOnly=best&&upper-best.objective<=1e-6*Math.max(1,best.objective);
        const required=new Set(scope);
        if(!nearFloorOnly)for(const name of Object.keys(input.season_crop_minimums??{}))required.add(name);
        for(const name of result?.activeRecipes??[])if(priorSales.has(name))required.add(name);
        const next=result?.values?suggestEconomicScope(model,result.values,required,{nearFloorOnly}):scope;
        if(evaluateBound&&dispatched&&round<2&&(!best||!close(upper,best.objective))
            &&next.length>scope.length){
            const narrowed=priority(payloadFor(next),currencyStage,currency);
            pending={model:narrowed,result:evaluateBound(narrowed,{seed:best??witnessSeed,scope:next,timeLimit:5})};
        }
        if(result?.values)await checkedCandidate(result);
        if(!witnessSeed&&!round&&best&&!close(best.objective,upper))await repairModes();
        if((!best || upper-best.objective>(dispatched?1e-7:0.0025*best.objective))&&round===0)await checkedCandidate(best??result??witnessSeed,false);
        if(best&&close(upper,best.objective))break;
        if(nearFloorOnly&&next.length===scope.length)break;
        if(!dispatched&&best&&upper<=best.objective*1.0025)break;
        if(!result?.values)break;
        if(round&&next.length===scope.length)break;
        scope=next;
    }
    if(!best || !Number.isFinite(upper) || best.objective>upper+1e-7)return null;
    // The existing planner continues searching when discovery has neither a
    // comparable checked shift nor its customary 0.25% currency guarantee.
    if(!witnessSeed && upper>best.objective*1.0025)return null;
    const income=best.objective;
    bounds.push([stageKey(currency,currencyStage),upper]);
    stage.floors.push([currency,income]);
    // Each lower material goal may need another level of the upgrade chain,
    // including a formula that did not earn currency in the income plan.
    for(const [,name,facility] of raw.recipe_options){
        if(facility==='Woodworking Bench'||facility==='Chimney Kiln')names.add(name);
    }
    const payload=payloadFor(names,true);
    const localIncome=priority(payload,currencyStage,currency);
    let seed=best,materialPace=null,materialWork=null,last;
    // Each lower priority is optimized with the previous objective floors.
    // Restricted search can provide a feasible value but never a global bound.
    for(const key of priorities.slice(pos+1)){
        const all=priority(relaxed,stage,key);
        if(!all.lp&&key==='level_up')continue;
        if(!all.lp)return null;
        const ceiling=priorityCeiling(highs,all,key);
        const checked=priority(payload,stage,key),local=keepRawIncome(restrict(checked,names),localIncome,income);
        if(!local)return null;
        const warm=align(local,seed);
        let fit=await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
        if(!fit?.values||!close(sum(checked.primary_objective,fit.values),ceiling)){
            const alternative=await solveModel(local,options(2),undefined,fit?.values??warm);
            if(alternative?.values&&(!fit?.values||sum(checked.primary_objective,alternative.values)>sum(checked.primary_objective,fit.values)))fit=alternative;
        }
        if(!fit?.values)return null;
        const objective=sum(checked.primary_objective,fit.values);
        const prior=new Map(oldGoals?.floors??[]).get(key);
        if(Number.isFinite(prior)&&objective+1e-8<prior&&Number.isFinite(oldCurrency)&&income<=oldCurrency+1e-7)return null;
        if(Number.isFinite(ceiling))bounds.push([stageKey(key,stage),ceiling]);
        if(key==='level_up'){if(objective>1e-9)stage.pace=objective;}
        else stage.floors.push([key,objective]);
        seed={keys:checked.variable_keys,values:fit.values};
    }
    const canWork=raw.recipe_options.some(([, ,facility])=>facility==='Woodworking Bench'||facility==='Chimney Kiln');
    const needsStock=canWork&&!stage.pace&&input.level_up_preview?.cost?.some(([key,amount])=>key!==currency&&amount>
        (input.level_up_preview.stock??[]).filter(([name])=>name===key).reduce((total,[,n])=>total+n,0));
    const work=canWork&&(input.maximize_material_work??!input.fixed_homeland);
    const minRate=Math.max(income,Number.isFinite(initialWitness?.rate_per_second)?initialWitness.rate_per_second:0);
    const finalStage=async (request)=>{
        const p=exact(payload,request);
        if(!p.lp)return null;
        let local=keepRawIncome(restrict(p,names),localIncome,minRate);
        if(!local)return null;
        const retained=request.maximize_material_work?oldScores?.material_work:request.maximize_upgrade_materials?oldScores?.material_pace:null;
        if(retained>0&&income<=oldCurrency+1e-7&&local.primary_objective?.length) {
            local=addRows(local,[' retain_material: '+expression(local.primary_objective)+' >= '+(retained-1e-7)]);
        }
        const warm=align(p,seed);
        const commitments=local.material_fixed?.map(v=>` material_commit_${v}: x${v} = ${Math.round(warm[v])}`)??[];
        let r=await solveModel(commitments.length?addRows(local,commitments):fixPhysical(local,warm),
            options(commitments.length?2:1),undefined,warm);
        if(!r?.values)r=await solveModel(fixPhysical(local,warm),options(1),undefined,warm);
        if(!r?.values)r=await solveModel(local,options(2),undefined,warm);
        if(!r?.values)return null;
        r=polishSolution(highs,local,r);
        seed={keys:p.variable_keys,values:r.values};
        last={request,local,p,r};
        return p.primary_objective?.length?sum(p.primary_objective,r.values):r.objective;
    };
    if(needsStock){
        materialPace=await finalStage({...stage,maximize_upgrade_materials:true});
        if(materialPace==null)return null;
        stage.material_pace=materialPace;
    }
    if(work){
        materialWork=await finalStage({...stage,maximize_material_work:true});
        if(materialWork==null)return null;
    }else if(!last&&await finalStage(stage)==null)return null;
    if(oldScores?.material_pace!=null&&materialPace+1e-8<oldScores.material_pace&&income<=oldCurrency+1e-7)return null;
    if(oldScores?.material_work!=null&&materialWork+1e-8<oldScores.material_work&&income<=oldCurrency+1e-7)return null;
    const {p,local,r,request}=last, refined=await refineStaffing(local,r,solveModel);
    const audit=answer=>JSON.parse(pkg.exact_plan(payload,JSON.stringify(request),JSON.stringify({values:answer.values,proven:false,bound:upper,verify_only:true})));
    let final=refined,plan=audit(final);
    if(!plan.success&&refined!==r){final=r;plan=audit(final);}
    if(!plan.success||!Number.isFinite(plan.rate_per_second)||plan.rate_per_second+1e-7<minRate||plan.rate_per_second>upper+1e-7)return null;
    const used=active(p,final.values);
    if(used.some(name=>!names.has(name)))return null;
    const verified=new Map(p.variable_keys.map((key,v)=>[key,final.values[v]]));
    for(const entry of early){
        const {key,terms}=entry;
        let earned=terms.length&&terms.every(([name])=>verified.has(name))
            ?terms.reduce((total,[name,c])=>total+c*verified.get(name),0):null;
        // Later priorities use the native floor slack. Recover the earlier
        // score with the checked sites before claiming it reaches its ceiling.
        if(!close(earned,entry.upper)){
            const checked=restrict(priority(payload,entry.before,key),names);
            const warm=align(checked,{keys:p.variable_keys,values:final.values});
            const audit=await solveModel(fixPhysical(checked,warm),options(.7),undefined,warm);
            if(audit?.values)earned=Math.max(earned??-Infinity,audit.objective);
        }
        entry.earned=earned;
        step(key==='crop_variety'?key:'priority:'+key,'done',close(earned,entry.upper));
    }
    step('priority:'+currency,'done',close(income,upper));
    step('check','done',true);
    const top=early.find(({key})=>key!=='crop_variety');
    if(top&&Number.isFinite(top.earned))first({measure:top.key,objective:top.earned,proven:close(top.earned,top.upper)});
    else if(!top)first({measure:currency,objective:income,proven:close(income,upper)});
    return {...plan,continuous_production_checked:true,continuous_checked_recipes:[...names],
        active_continuous_recipes:[...new Set(used)],continuous_site_counts:siteCounts(p,final.values),
        continuous_upper_bounds:bounds,comparison_seed:{keys:p.variable_keys,values:final.values},
        comparison_goals:{currency,currency_value:income,floors:stage.floors,pace:stage.pace??null,crop_variety:stage.crop_variety??null},
        comparison_scores:{crop_variety:stage.crop_variety??null,material_pace:materialPace,material_work:materialWork,stock:null},
        material_work_note:work?'unproven':null};
}
