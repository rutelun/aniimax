import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveWithIncumbent} from '../web/highs-solve.js';
import {tryPriorityPlan} from '../web/continuous-priority-plan.js';
import {searchProductionSites} from '../web/production-site-search.js';

test('measured dispatch proves the attainable whole-post pace before optimizing income',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const keys=['rate:crop#0','units:crop#0','pace#0'];
    let fullCapacity=1;
    const build=(payload,stage,key)=>{
        const full=JSON.parse(payload).always_running_recipes===undefined;
        const goal=key==='level_up'?2:0;
        return JSON.stringify({variables:3,variable_keys:keys,primary_objective:[[goal,1]],tiebreak:[],
            recipe_variables:[[0,'crop'],[1,'crop']],recipe_options:[[0,'crop','Farm',false,false,1]],
            integer_groups:[['crop',[[1,1]],1]],
            lp:['Maximize',' obj: x'+goal,'Subject To',' produce: x0 - x1 <= 0',
                ' upgrade: x2 - 0.5 x1 <= 0',' posts: x1 <= 1.5',' income: x0 <= '+(full?fullCapacity:1),
                ' prior: x2 >= '+(JSON.parse(stage).pace??0),'Bounds',' x0 >= 0',' x1 >= 0',' x2 >= 0',
                'General',' x1','End'].join('\n')});
    };
    const pkg={exact_priority_problem:build,exact_problem:build,exact_plan:(_payload,_stage,report)=>
        JSON.stringify({success:true,rate_per_second:JSON.parse(report).values[0]})};
    const solveModel=(p,o,_,seed)=>{
        const r=solveWithIncumbent(highs,p,o,seed,false);
        return r.Columns?{values:keys.map((_,v)=>r.Columns['x'+v].Primal),objective:r.ObjectiveValue,proven:r.Status==='Optimal'}:null;
    };
    const input={always_running:true,priorities:['level_up','coins'],roster:{dispatch:{crop:[1]}}};
    const initialWitness={recipes:['crop'],seed:{keys,values:[1,1,.75]}};
    const solve=(solver=solveModel)=>tryPriorityPlan(pkg,input,{highs,solveModel:solver,initialWitness});
    const plan=await solve();
    assert.equal(plan.comparison_goals.pace,.5);
    const deferred=await tryPriorityPlan(pkg,input,{highs,solveModel,initialWitness:{...initialWitness,goals:{pace:.75}}});
    assert.equal(deferred.comparison_goals.pace,.5);
    assert.equal(deferred.rate_per_second,plan.rate_per_second);
    assert.equal(plan.rate_per_second,1);
    assert.equal(plan.continuous_production_checked,true);
    const switched=await tryPriorityPlan(pkg,{...input,recipe_switching_relaxation:true},{
        highs,solveModel,initialWitness,
    });
    assert.equal(switched.continuous_production_checked,true);
    assert.deepEqual(switched.comparison_goals,plan.comparison_goals);
    assert.equal(await tryPriorityPlan(pkg,{...input,roster:{dispatch:{}},recipe_switching_relaxation:true},
        {highs,solveModel,initialWitness}),null);
    // A tied relaxed shift may fail the first full-catalogue check. The
    // checked recipes can still supply another shift at the same income.
    let restores=0;
    const alternate=await solve((problem,...args)=>{
        if(problem.lp.includes('actual_shift_') && ++restores===1)return null;
        return solveModel(problem,...args);
    });
    assert.ok(restores>1);
    assert.equal(alternate.rate_per_second,1);
    assert.equal(alternate.continuous_production_checked,true);
    // The fastest shift leaves the site empty. The income shift runs it
    // within the native pace slack and is a valid seed for the wider search.
    const withSlack=(payload,stage,key)=>{
        const model=JSON.parse(build(payload,stage,key));
        model.lp=model.lp.replace('x2 - 0.5 x1 <= 0','x2 + 0.00005 x1 <= 1')
            .replace('prior: x2 >= 1','prior: x2 >= 0.9999');
        return JSON.stringify(model);
    };
    let warm;
    const result=await tryPriorityPlan({...pkg,exact_priority_problem:withSlack,exact_problem:withSlack},input,{
        highs,solveModel,initialWitness:{...initialWitness,goals:{pace:1}},onIncumbent:plan=>{warm=plan;},
    });
    assert.equal(result,null);
    assert.equal(warm?.rate_per_second,1);
    assert.equal(warm?.continuous_production_checked,true);
    fullCapacity=.5;
    assert.equal(await solve(),null);
});

test('fast priority plan checks the occupied recipe and returns the actual shift',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const model={variables:2,variable_keys:['rate:crop#0','units:crop#0'],primary_objective:[[0,1]],tiebreak:[],
        integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',false,false,4]],recipe_variables:[[0,'crop'],[1,'crop']],
        lp:'Maximize\n obj: + 1 x0\nSubject To\n capacity: + 4 x0 - 1 x1 <= 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x1\nEnd'};
    const pkg={exact_priority_problem:()=>JSON.stringify(model),exact_problem:()=>JSON.stringify(model),
        exact_plan:(input,_stage,result)=>{
            assert.equal(JSON.parse(input).always_running_recipes,undefined);
            assert.equal(JSON.parse(input).restrict_to_checked_recipes,false);
            const report=JSON.parse(result);
            assert.equal(report.verify_only,true);
            assert.deepEqual(report.values,[.25,1]);
            return JSON.stringify({success:true,rate_per_second:report.values[0]});
        }};
    const solveModel=(p,options,_,seed)=>{
        const r=solveWithIncumbent(highs,p,options,seed,false);
        return r.Columns?{values:p.variable_keys.map((_key,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue,
            proven:r.Status==='Optimal',upper:r.UpperBound}:null;
    };
    const input={currency:'coins',priorities:['coins'],always_running:true,roster:{dispatch:{work:[1]}}};
    const plan=await tryPriorityPlan(pkg,input,{highs,solveModel});
    assert.equal(plan.rate_per_second,.25);
    assert.deepEqual(plan.continuous_upper_bounds,[['["coins",{"floors":[]}]',.25]]);
    assert.deepEqual(plan.continuous_site_counts,{crop:1});
    const implicit=await tryPriorityPlan(pkg,{...input,priorities:['tokens']},{highs,solveModel});
    assert.deepEqual(implicit.comparison_goals.floors,[['tokens',.25],['coins',.25]]);
    assert.deepEqual(implicit.continuous_upper_bounds.map(([key])=>JSON.parse(key)[0]),['tokens','coins']);
    const generated=await tryPriorityPlan(pkg,{currency:'coins',priorities:['coins'],always_running:true},{highs,solveModel});
    assert.equal(generated.rate_per_second,.25);
    const switching = {...input, facilities:{'Chimney Kiln':[{count:5,level:2}]}};
    const fixedShift = await tryPriorityPlan(pkg,switching,{highs,solveModel});
    assert.equal(fixedShift?.rate_per_second,plan.rate_per_second);
    assert.equal(await tryPriorityPlan(pkg,{...switching,recipe_switching_relaxation:true},{highs,solveModel}),null);
    assert.deepEqual(generated.continuous_upper_bounds,plan.continuous_upper_bounds);
    const measured=await tryPriorityPlan(pkg,{...input,season_crop_minimums:{crop:1}},{
        highs,solveModel,initialWitness:plan,
        evaluateCounts:()=>assert.fail('alternate buildings cannot improve a checked shift at its ceiling'),
    });
    assert.equal(measured.rate_per_second,.25);
    assert.deepEqual(measured.continuous_upper_bounds,plan.continuous_upper_bounds);
});

test('a site proposal that violates full climate coverage cannot certify its revenue',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const model={variables:3,variable_keys:['rate:crop#0','units:crop#0','environment:heat#0'],
        production_only:true,primary_objective:[[0,1]],recipe_variables:[[0,'crop'],[1,'crop']],
        recipe_options:[[0,'crop','Farmland',false,false,1]],
        lp:'Maximize\n obj: x0\nSubject To\n shift: x0 - x1 = 0\n heat: x1 - x2 <= 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\n 0 <= x2 <= 0\nGeneral\n x1\n x2\nEnd'};
    assert.equal(await searchProductionSites(highs,model,model,()=>model),null);
    const heated={...model,lp:model.lp.replace('0 <= x2 <= 0','0 <= x2 <= 1')};
    const verified=await searchProductionSites(highs,heated,heated,()=>heated);
    assert.equal(verified.best.objective,1);
    assert.equal(verified.upper,1);
});

test('a shift feasible only with omitted recipes cannot become the published incumbent',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const build=payload=>{
        const input=JSON.parse(payload),maximum=input.always_running_recipes===undefined ? 0.1 : 0.25;
        return JSON.stringify({variables:2,variable_keys:['rate:crop#0','units:crop#0'],primary_objective:[[0,1]],tiebreak:[],
            integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',false,false,4]],recipe_variables:[[0,'crop'],[1,'crop']],
            lp:`Maximize\n obj: + 1 x0\nSubject To\n capacity: + 4 x0 - 1 x1 <= 0\n supply: + 1 x0 <= ${maximum}\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x1\nEnd`});
    };
    const solveModel=(p,o,_,seed)=>{
        const r=solveWithIncumbent(highs,p,o,seed,false);
        return r.Columns?{values:p.variable_keys.map((_k,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue,proven:r.Status==='Optimal'}:null;
    };
    const pkg={exact_priority_problem:build,exact_problem:build,exact_plan:()=>assert.fail('mismatched shift reached publication')};
    const plan=await tryPriorityPlan(pkg,{currency:'coins',always_running:true,roster:{dispatch:{fixed:[1]}}},{highs,solveModel});
    assert.equal(plan,null);
});

test('restoring a shift accounts for unsold output left by an earlier priority floor',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const build=payload=>{
        const sale=JSON.parse(payload).always_running_recipes===undefined ? 1 : 0.9999;
        return JSON.stringify({variables:3,variable_keys:['rate:crop#0','units:crop#0','sold:token#0'],
            primary_objective:[[0,1]],tiebreak:[],integer_groups:[['crop',[[1,1]],1]],
            recipe_options:[[0,'crop','Farm',false,false,1]],recipe_variables:[[0,'crop'],[1,'crop']],
            lp:`Maximize\n obj: + 1 x0\nSubject To\n work: x0 - x1 = 0\n balance: ${sale} x0 - x2 = 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\n 0 <= x2 <= 1\nGeneral\n x1\nEnd`});
    };
    const pkg={exact_priority_problem:build,exact_problem:build,exact_plan:(_input,_stage,report)=>{
        assert.deepEqual(JSON.parse(report).values,[1,1,1]);
        return JSON.stringify({success:true,rate_per_second:1});
    }};
    const solveModel=(p,o,_,seed)=>{
        const r=solveWithIncumbent(highs,p,o,seed,false);
        return r.Columns?{values:p.variable_keys.map((_k,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue}:null;
    };
    const plan=await tryPriorityPlan(pkg,{currency:'coins',always_running:true,roster:{members:[]}},{highs,solveModel});
    assert.equal(plan?.rate_per_second,1);
});

test('a measured shift at the 0.2% income gap is accepted and a 0.22% gap keeps searching',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    let ceiling = .5011;
    const build=payload=>{
        const config=JSON.parse(payload);
        const relaxed=config.always_running_recipes != null && !config.restrict_to_checked_recipes;
        return JSON.stringify({variables:2,variable_keys:['rate:crop#0','units:crop#0'],primary_objective:[[0,1]],tiebreak:[],
            integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',false,false,1]],recipe_variables:[[0,'crop'],[1,'crop']],
            lp:`Maximize\n obj: x0\nSubject To\n shift: x0 - x1 <= 0\nBounds\n 0 <= x0 <= ${relaxed?ceiling:0.5}\n 0 <= x1 <= 1\nGeneral\n x1\nEnd`});
    };
    const pkg={exact_priority_problem:build,exact_problem:build,exact_plan:(payload,_stage,report)=>{
        assert.equal(JSON.parse(payload).always_running_recipes,undefined);
        assert.equal(JSON.parse(report).verify_only,true);
        assert.deepEqual(JSON.parse(report).values,[.5,1]);
        return JSON.stringify({success:true,rate_per_second:.5});
    }};
    const solveModel=(p,o,_,seed)=>{
        const r=solveWithIncumbent(highs,p,o,seed,false);
        return r.Columns?{values:p.variable_keys.map((_k,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue}:null;
    };
    let fallback;
    const input={currency:'coins',always_running:true,roster:{dispatch:{fixed:[1]}}};
    const search=()=>tryPriorityPlan(pkg,input,{highs,solveModel,evaluateCounts:()=>null,onIncumbent:plan=>{fallback=plan;}});
    const fast=await search();
    assert.equal(fast,null);
    assert.equal(fallback?.rate_per_second,.5);
    assert.equal(fallback.continuous_production_checked,true);
    // The old map earned exactly as much, but cannot certify the new map.
    fallback = null;
    const {solveEconomicBound}=await import('../web/economic-bound.js');
    const repairFloors=[];
    const observedHighs=new Proxy(highs,{get(target,key){
        if(key!=='solve')return target[key];
        return (lp,...args)=>{
            const match=lp.match(/ local_income: [^\n]* >= ([^\n]+)/);
            if(match)repairFloors.push(Number(match[1]));
            return target.solve(lp,...args);
        };
    }});
    const carried=await tryPriorityPlan(pkg,input,{highs:observedHighs,solveModel,evaluateCounts:()=>null,
        evaluateBound:(p,o)=>o.exact?null:solveEconomicBound(highs,p,o),
        initialWitness:{seed:{keys:['rate:crop#0','units:crop#0'],values:[.5,1]},goals:{currency_value:.5},recipes:['crop']},
        onIncumbent:plan=>{fallback=plan;}
    });
    assert.equal(carried,null);
    assert.equal(fallback?.rate_per_second,.5);
    assert.ok(repairFloors.some(floor=>floor<=.5 && floor>=.5-1e-7));
    ceiling = .501;
    fallback = null;
    const accepted = await search();
    assert.equal(accepted?.rate_per_second,.5);
    assert.equal(fallback,null);
});

test('a fully audited shift within the measured bound can finish without an exact full-catalogue solve', async () => {
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const keys = ['rate:crop#0','units:crop#0'];
    const build = payload => {
        const config = JSON.parse(payload);
        const complete = config.always_running_recipes == null || config.restrict_to_checked_recipes;
        const cap = complete ? .25 : .2501;
        return JSON.stringify({variables:2,variable_keys:keys,primary_objective:[[0,1]],tiebreak:[],
            integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',true,false,1]],
            recipe_variables:[[0,'crop'],[1,'crop']],
            lp:`Maximize\n obj: x0\nSubject To\n shift: x0 - x1 <= 0\nBounds\n 0 <= x0 <= ${cap}\n 0 <= x1 <= 1\nGeneral\n x1\nEnd`});
    };
    const pkg = {exact_priority_problem:build,exact_problem:build,exact_plan:(_payload,_stage,report)=>{
        const {values} = JSON.parse(report);
        assert.deepEqual(values,[.25,1]);
        return JSON.stringify({success:true,rate_per_second:values[0]});
    }};
    const solveModel = (p,o,_,seed) => {
        const r = solveWithIncumbent(highs,p,o,seed,false);
        return r.Columns && {values:keys.map((_,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue};
    };
    const {solveEconomicBound} = await import('../web/economic-bound.js');
    let fullProofs = 0;
    const evaluateBound = (p,o) => {
        if (o.exact && !o.scope) {
            fullProofs++;
            assert.deepEqual(o.seed.values,[.25,1]);
            assert.doesNotMatch(p.lp,/retain_currency/);
        }
        return solveEconomicBound(highs,p,o);
    };
    const plan = await tryPriorityPlan(pkg,{currency:'coins',always_running:true,roster:{dispatch:{work:[1]}}},{
        highs,solveModel,evaluateBound,initialWitness:{recipes:['crop'],counts:{crop:1},seed:{keys,values:[.2501,1]}},
    });
    assert.equal(fullProofs,0);
    assert.equal(plan?.rate_per_second,.25);
    assert.equal(plan.upper_bound ?? plan.continuous_upper_bounds[0][1],.2501);
    assert.ok(plan.continuous_production_checked);

    // After a physical refit raises the initial zero income, a tighter bound
    // on this same scope suffices without adding another recipe.
    const scoped=[];
    const newModel=payload=>build(payload).replace(' shift:',' scoped_shift:');
    const refined=await tryPriorityPlan({...pkg,exact_priority_problem:newModel},{
        currency:'coins',always_running:true,roster:{dispatch:{work:[1]}},
    },{
        highs,solveModel,initialWitness:{recipes:['crop'],seed:{keys,values:[0,0]}},
        evaluateBound:(model,settings)=>{
            const result=solveEconomicBound(highs,model,settings);
            scoped.push(settings.scope);
            return settings.relativeGap?{...result,proven:false,upper:.26}:result;
        },
    });
    assert.deepEqual(scoped,[[],[]]);
    assert.equal(refined?.rate_per_second,.25);
    assert.equal(refined.continuous_upper_bounds[0][1],.2501);
});

test('measured income certification omits a redundant incumbent floor', async () => {
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const keys=['rate:crop#0','units:crop#0'];
    const problem={variables:2,variable_keys:keys,primary_objective:[[0,1]],tiebreak:[],
        integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',true,false,1]],
        recipe_variables:[[0,'crop'],[1,'crop']],lp:'Maximize\n obj: x0\nSubject To\n capacity: x0 - x1 <= 0\nBounds\n 0 <= x0 <= .5\n 0 <= x1 <= 1\nGeneral\n x1\nEnd'};
    const pkg={exact_priority_problem:()=>JSON.stringify(problem),exact_problem:()=>JSON.stringify(problem),
        exact_plan:(_payload,_stage,report)=>JSON.stringify({success:true,rate_per_second:JSON.parse(report).values[0]})};
    const solveModel=(p,o,_,seed)=>{
        const result=solveWithIncumbent(highs,p,o,seed,false);
        return result.Columns && {values:keys.map((_key,v)=>result.Columns['x'+v].Primal),objective:result.ObjectiveValue};
    };
    const {solveEconomicBound}=await import('../web/economic-bound.js');
    const evaluateBound=(p,o)=>{
        // The real seasonal RV12 dispatch model has a feasible better shift that
        // presolve loses only when the current income is duplicated as a row.
        assert.doesNotMatch(p.lp,/retain_currency/);
        return solveEconomicBound(highs,p,o);
    };
    const plan=await tryPriorityPlan(pkg,{currency:'coins',always_running:true,roster:{dispatch:{measured:[1]}}},{
        highs,solveModel,evaluateBound,initialWitness:{recipes:['crop'],counts:{crop:1},seed:{keys,values:[.4,1]}}
    });
    assert.equal(plan.rate_per_second,.5);
    assert.equal(plan.continuous_upper_bounds[0][1],.5);
});
