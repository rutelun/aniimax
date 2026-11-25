import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {refineStaffing} from '../web/staffing-search.js';

const wasm = new URL('../web/pkg/aniimax_bg.wasm', import.meta.url);
for (const [sand, canSwap] of [[800, true], [800000, false]]) {
test(canSwap ? 'a supply-limited kiln releases a faster producer from a permanent furnace post'
        : 'a continuously running kiln keeps its producer if a swap would change the output',
    {skip:!fs.existsSync(wasm)}, async () => {
    const pkg = await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasm)});
    const highs = await highsModule({
        wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm', import.meta.url)),
        print(){}, printErr(){},
    });
    const input = {currency:'coins', always_running:true, aniimo:'roster',
        quest_income_per_day:{mineral_sand:sand}, level_up:{cost:[['coarse_sifted_ore',100]],stock:[]},
        fixed_homeland:{groups:[{facility:'Chimney Kiln',count:1,level:1,lit:false,powered:false}],
            climate:{'Heat Furnace':2},generators:0},
        roster:{members:[{count:2,abilities:{Fire:3,Artisanship:4}},{count:1,abilities:{Fire:2}}],
            environment:{'Heat Furnace':'Fire'}, residents:[], movement_seconds:5}};
    const payload = JSON.stringify(input), stage = JSON.stringify({pace:1});
    const problem = JSON.parse(pkg.exact_problem(payload, stage));
    const solve = async p => {
        const result = highs.solve(p.lp, {mip_rel_gap:0, mip_abs_gap:0});
        if (result.Status !== 'Optimal') return null;
        return {values:Array.from({length:p.variables}, (_,i)=>result.Columns['x'+i]?.Primal??0),
            objective:result.ObjectiveValue,proven:true};
    };
    const furnace = problem.variable_keys.indexOf('staff:Heat Furnace:owned:0#0');
    assert.ok(furnace >= 0);
    const incumbent = await solve({...problem,lp:problem.lp.replace('Subject To',
        'Subject To\n original_staff: x'+furnace+' = 2')});
    assert.ok(incumbent);
    const report = result => JSON.parse(pkg.exact_plan(payload, stage, JSON.stringify({...result,bound:0})));
    const before = report(incumbent);
    assert.equal(before.success, true, before.error);
    const after = report(await refineStaffing(problem, incumbent, solve));
    assert.equal(after.success, true, after.error);
    assert.equal(after.staffing.some(([building,member,count]) => building==='Heat Furnace' && member===1 && count===1), canSwap);
    const kilnRate = plan => plan.coin_items.filter(row=>row.item_name==='coarse_sifted_ore' && row.status==='producing')
        .reduce((total,row)=>total+row.busy_units/row.cycle_time,0);
    assert.ok(kilnRate(before)>0);
    assert.ok(Math.abs(kilnRate(before)-kilnRate(after))<1e-9);
    const days = plan => plan.roster_workload.reduce((a,b)=>a+b,0);
    if (canSwap) assert.ok(days(after) < days(before) - 1e-4);
    else assert.ok(Math.abs(days(after)-days(before)) < 1e-8);
    assert.equal(after.level_up.seconds,before.level_up.seconds);
});
}

test('a shorter shift cannot spread one active worker across two new workers',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const p={variables:3,lp:'Maximize\n obj: + 1 x0\nSubject To\n jobs: x0 + x1 + x2 = 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 0.5\n 0 <= x2 <= 0.5\nEnd\n',
        staffing_groups:[[0,1,2]],
        staffing_pools:[0.8,0.4,0.4].map((time,i)=>({work:[[i,time]],crop:[],anchors:[],reserve:false,active:null}))};
    const before={values:[1,0,0]},after=await refineStaffing(p,before,async problem=>{
        const result=highs.solve(problem.lp);
        assert.equal(result.Status,'Optimal');
        return {values:[0,1,2].map(i=>result.Columns['x'+i].Primal)};
    });
    assert.deepEqual(after.values,before.values);
});

test('a quicker workshop worker keeps the slack needed for its existing harvest jobs',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const p={variables:3,lp:'Maximize\n obj: + 1 x0\nSubject To\n harvest: x0 = 1\n workshop: x1 + x2 = 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\n 0 <= x2 <= 1\nEnd\n',
        staffing_groups:[[0],[1,2]],staffing_pools:[
            {work:[[0,0.4],[2,0.2]],crop:[0],anchors:[],reserve:false,active:null},
            {work:[[1,0.8]],crop:[],anchors:[],reserve:false,active:null},
        ]};
    const original={values:[1,1,0]};
    const after=await refineStaffing(p,original,async problem=>{
        const result=highs.solve(problem.lp);
        assert.equal(result.Status,'Optimal');
        return {values:[0,1,2].map(i=>result.Columns['x'+i].Primal)};
    });
    assert.deepEqual(after.values,original.values);
});

import {refineElectricStaffing} from '../web/electric-staffing.js';
test('draft staffing reuses feasible physical shifts below the relaxed target and retries missing results',async()=>{
    const problem={variables:3,variable_keys:['rate:ore','rate:ore:electric','extra#0'],
        recipe_options:[[0,'ore','Chimney Kiln',false,false,1],[1,'ore','Chimney Kiln',false,true,1]],
        lp:'Maximize\n obj: x0\nSubject To\nBounds\n 0 <= x2 <= 1\nGeneral\n x2\nEnd',
        staffing_pools:[{work:[[0,1]],anchors:[],crop:[]}]};
    const input={roster:{members:[]},always_running:true,map_dispatch_pending:true,
        facilities:{'Chimney Kiln':[{count:1,level:2}]}};
    for(const fail of ['none','count','work','replay','below-target']){
        const calls=[];
        const solve=async(model,settings,unused,seed)=>{
            const phase=settings.objective_target!=null?'replay':model.lp.includes('minimum_team:')?'work':
                model.primary_objective.length===1?'count':'original';
            calls.push(phase);
            const integers=model.lp.split('\nGeneral\n')[1].split('\nEnd')[0].trim().split(/\s+/);
            assert.equal(integers.includes('x2'),phase==='replay'||phase==='original');
            assert.ok(integers.includes('x3'));
            if(phase==='replay')assert.deepEqual(seed,[1,0,0,1]);
            if(phase==='replay' && fail==='below-target')return {proven:false,values:[1,0,0,1],objective:-11};
            if(phase===fail)return phase==='replay'?null:{proven:false,values:[1,0,0,1],objective:-1};
            return {proven:true,objective:0,values:[0,1,0,0]};
        };
        const result=await refineElectricStaffing(problem,{values:[1,0,0]},solve,{input});
        assert.deepEqual(result.values,fail==='below-target'?[1,0,0]:[0,1,0]);
        assert.deepEqual(calls,fail==='count'?['count','original']:fail==='work'?['count','work','original']:
            fail==='replay'?['count','work','replay','original']:['count','work','replay']);
    }
});
test('an idle owned copy can take a reserve furnace post while its sibling keeps the harvest shift',async()=>{
    const keys=['rate:crop','staff:Heat Furnace:owned:0#0','staff:Heat Furnace:reserve#0'];
    const p={variables:3,variable_keys:keys,lp:'Maximize\n obj: x0\nSubject To\n furnace: x1 + x2 = 1\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\n 0 <= x2 <= 1\nGeneral\n x1 x2\nEnd',
        recipe_options:[[0,'crop','Farmland',false,false,1]],recipe_variables:[[0,'crop']],
        staffing_pools:[{work:[[0,.25],[1,1]],crop:[0],anchors:[1],reserve:false},
            {work:[[2,1]],crop:[],anchors:[2],reserve:true}]};
    const before={values:[1,0,1]};
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    for(const [count,helpers,canMove] of [[1,0,false],[2,0,true],[2,1,false]]){
        const input={roster:{dispatch:{measured:[]},members:[{count}]},crop_peak_helpers:[helpers]};
        const solve=async model=>{
            const result=highs.solve(model.lp);
            assert.equal(result.Status,'Optimal');
            return {values:model.variable_keys.map((_,v)=>result.Columns['x'+v].Primal)};
        };
        const chosen=await refineElectricStaffing(p,before,solve,{input});
        assert.deepEqual(chosen.values,canMove?[1,1,0]:before.values);
        // A neighborhood solve can return its incumbent. Check the physical
        // post transfer independently and retain only a native-verified swap.
        for(const loss of [0,1]){
            const checked=await refineStaffing(p,before,async()=>null,{
                input,
                report:values=>({success:true,rate_per_second:100-loss*values[1]})
            });
            assert.deepEqual(checked.values,canMove && !loss?[1,1,0]:before.values);
        }
    }
});
test('the final My Aniimo shift keeps income, selected priorities and RV time',async()=>{
    const before={values:[1,0]},values=[0,1];
    const pool=(v,seconds)=>({work:[[v,seconds]],crop:[],anchors:[],reserve:false,active:null});
    const problem={variables:2,lp:'Maximize\n obj: x0\nSubject To\nBounds\nEnd',staffing_groups:[[0,1]],
        staffing_pools:[pool(0,1),pool(1,.5)]};
    const baseline={success:true,rate_per_second:10,level_up_preview:{seconds:100},priorities:[{target:'wood',per_second:5}]};
    for(const change of [{},{rate_per_second:9.99},{level_up_preview:{seconds:101}},{priorities:[{target:'wood',per_second:4}]}]){
        const result=await refineStaffing(problem,before,async()=>({values}),{input:{roster:{dispatch:{measured:[]}}},
            report:shift=>shift===before.values?baseline:{...baseline,...change}});
        assert.deepEqual(result.values,Object.keys(change).length?before.values:values);
    }
});
test('measured staffing uses an owned resident and keeps only the lamps required for coverage',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const original=[0,2,2,2];
    const keys=['rate:pearl:owned','rate:pearl:reserve','environment:Sunlamp:Adequate:light','sold:pearl'];
    for(const required of [1,2]){
        const problem={variables:4,variable_keys:keys,
            lp:'Maximize\n obj: x3\nSubject To\n pearl: x0 + x1 - x3 = 0\n light: x2 >= '+required+
                '\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 2\n 0 <= x2 <= 2\nGeneral\n x0 x1 x2\nEnd',
            recipe_options:[0,1].map(v=>[v,'pearl','Tidewhisper Sandcastle',true,false,1]),
            recipe_variables:[[0,'pearl'],[1,'pearl']],staffing_groups:[[0,1]],
            staffing_pools:[0,1,2].map(v=>({work:[[v,1]],anchors:[],crop:[],reserve:v!==0,active:null})),
            primary_objective:[[3,1]]};
        const solve=async(model,settings)=>{
            const solution=highs.solve(model.lp,settings);
            assert.equal(solution.Status,'Optimal');
            return {values:Array.from({length:model.variables},(_,i)=>solution.Columns['x'+i]?.Primal??0)};
        };
        const result=await refineElectricStaffing(problem,{values:original},solve,{input:{roster:{dispatch:{'Mill|flour|Production':[]}}}});
        assert.deepEqual(result.values,[1,1,required,2]);
    }
});
for(const mode of ['minimum','best']){
    test(mode+' prefers E-mode only when total occupied Aniimo and every priority are preserved',async()=>{
        const keys=['rate:ore#0','rate:ore__electric1#0','sold:ore#0','generators#0'];
        const problem={variable_keys:keys,variables:4,
            lp:'Maximize\n obj: x2\nSubject To\n power: x1 - x3 <= 0\nBounds\nGeneral\n x3\nEnd',
            recipe_options:[[0,'ore','Mine',true,false,1],[1,'ore','Mine',true,true,1]],primary_objective:[[2,1]]};
        const pkg={get_all_items:()=>JSON.stringify([{name:'ore',aniimo:['Earth',1]}])};
        const makeReport=(extra={})=>([manual,,sale,generators])=>({success:true,rate_per_second:sale,power_generators:generators,
            level_up_preview:{seconds:100},priorities:[{target:'aniimo_exp',per_second:5}],...extra,
            coin_items:[...(extra.fixedItems??[]),...(manual?[{status:'producing',facility:'Mine',item_name:'ore',facility_count:1,
                aniimo_tasks:[{ability:'Earth',level:1,busy:manual}]}]:[])]});
        const candidate={values:[0,.4,.4,1]},solve=async()=>candidate;
        const options={pkg,input:{aniimo:mode},report:makeReport()};
        // Switching 0.4 manual (1 Earth Aniimo) to E-mode (1 Lightning generator) keeps people=1 and reduces manual work.
        const staffed={values:[.4,0,.4,0]};
        assert.deepEqual((await refineElectricStaffing(problem,staffed,solve,options)).values,candidate.values);
        // If another manual job keeps the Earth Aniimo occupied, adding a generator raises people 1 -> 2 and is rejected.
        const sharedEarth={...options,report:makeReport({fixedItems:[{status:'producing',facility:'Mine',item_name:'clay',facility_count:1,
            aniimo_tasks:[{ability:'Earth',level:1,busy:.2}]}]})};
        assert.equal(await refineElectricStaffing(problem,staffed,solve,sharedEarth),staffed);
        // Switching to E-mode on an already-running generator reduces both people and manual work.
        const runningGenerator={values:[.4,0,.4,1]};
        assert.deepEqual((await refineElectricStaffing(problem,runningGenerator,solve,options)).values,candidate.values);
        // Any loss in income, upgrade ETA, or another priority rejects the E-mode switch.
        const losingIncome=async()=>({values:[0,.4,.39,1]});
        assert.equal(await refineElectricStaffing(problem,runningGenerator,losingIncome,options),runningGenerator);
        const losingPriority={...options,report:vals=>({...makeReport()(vals),
            priorities:[{target:'aniimo_exp',per_second:vals[1]>0?4.9:5}]})};
        assert.equal(await refineElectricStaffing(problem,runningGenerator,solve,losingPriority),runningGenerator);
        const slowerUpgrade={...options,report:vals=>({...makeReport()(vals),
            level_up_preview:{seconds:vals[1]>0?101:100}})};
        assert.equal(await refineElectricStaffing(problem,runningGenerator,solve,slowerUpgrade),runningGenerator);
    });
}
test('My Aniimo switches fractional manual work to E-mode with a new generator when occupied Aniimo and priorities stay equal',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const keys=['rate:candied_strawberries#0','rate:candied_strawberries__electric4#0','sold:candied_strawberries#0','staff:Crackle Generator:owned:1#0'];
    const problem={variable_keys:keys,variables:4,
        lp:'Maximize\n obj: x2\nSubject To\n out: x0 + x1 - x2 = 0\n pwr: 144 x1 - 1000 x3 <= 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 2\n 0 <= x2 <= 1\n 0 <= x3 <= 1\nGeneral\n x3\nEnd',
        recipe_options:[[0,'candied_strawberries','Pickling Jar',false,false,1],[1,'candied_strawberries','Pickling Jar',false,true,1]],
        primary_objective:[[2,1]],
        staffing_pools:[
            {work:[[0,0.75]],anchors:[],crop:[],reserve:false,active:null},
            {work:[[3,1]],anchors:[3],crop:[],reserve:false,active:null},
        ]};
    const solve=async(model,settings)=>{
        const r=highs.solve(model.lp,settings);
        assert.equal(r.Status,'Optimal');
        return {values:Array.from({length:model.variables},(_,i)=>r.Columns['x'+i]?.Primal??0)};
    };
    const original=[1,0,1,0];
    const baseReport=vals=>({success:true,rate_per_second:vals[2],level_up_preview:{seconds:500},
        priorities:[{target:'aniimo_exp',per_second:10},{target:'coins',per_second:vals[2]}]});
    const input={always_running:true,roster:{members:[{count:1,abilities:{Dark:4}},{count:1,abilities:{Lightning:4}}],dispatch:{'Pickling Jar|candied_strawberries|Production':[]}}};
    // 0.75 manual Dark Aniimo -> 0 manual + 1 Lightning generator: people stays 1, priorities stay identical -> switches to E-mode.
    const switched=await refineElectricStaffing(problem,{values:original},solve,{input,report:baseReport});
    assert.ok(Math.abs(switched.values[1]-1)<1e-9);
    assert.equal(Math.round(switched.values[3]),1);
    // If switching would drop any priority, keep the incumbent.
    const priorityDrop=vals=>({...baseReport(vals),priorities:[{target:'aniimo_exp',per_second:vals[1]>0.1?9.9:10},{target:'coins',per_second:vals[2]}]});
    assert.deepEqual((await refineElectricStaffing(problem,{values:original},solve,{input,report:priorityDrop})).values,original);
    // If switching would add a reserve Aniimo (Lightning is reserve), keep the incumbent.
    const reserveProblem={...problem,staffing_pools:[problem.staffing_pools[0],{...problem.staffing_pools[1],reserve:true}]};
    assert.deepEqual((await refineElectricStaffing(reserveProblem,{values:original},solve,{input,report:baseReport})).values,original);
});
test('My Aniimo spends limited power on a contested ingredient when earnings and team size are equal',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const recipes=[{name:'flour',facility:'Carousel Mill',raw_materials:['wheat'],aniimo:['Wind',3]},
        {name:'sugar',facility:'Simmering Pot',raw_materials:['wheat'],aniimo:['Fire',3]},
        {name:'fabric',facility:'Joy Wheel Loom',raw_materials:['yarn'],aniimo:['Wind',3]}];
    const pkg={get_all_items:()=>JSON.stringify(recipes)}, members=[3,4].map(Wind=>({abilities:{Wind}}));
    const original=[.4,0,0,.4,.4,.4];
    const keys=['rate:flour','rate:flour__electric','rate:fabric','rate:fabric__electric','rate:sugar','sold:total'];
    const problem={variable_keys:keys,variables:6,lp:'Maximize\n obj: x5\nSubject To\n power: x1 + x3 <= 0.4\nBounds\nGeneral\nEnd',
        primary_objective:[[5,1]],recipe_options:[[0,'flour','Carousel Mill',false,false,1],[1,'flour','Carousel Mill',false,true,1],
            [2,'fabric','Joy Wheel Loom',false,false,1],[3,'fabric','Joy Wheel Loom',false,true,1],[4,'sugar','Simmering Pot',false,false,1]],
        staffing_pools:[{work:[[0,.25],[2,1],[4,.5]],anchors:[],crop:[],reserve:false,active:null}]};
    const report=()=>({success:true,rate_per_second:1,roster_workload:[.4,.2],coin_items:recipes.map(r=>({item_name:r.name,status:'producing',busy_units:.4,facility_count:1,cycle_time:1}))});
    // The original dispatch sent every batch to Wind 3. The other active
    // worker can still take a request, so that nominal share cannot hide risk.
    const dispatch={'Carousel Mill|flour|Production':[{member:0,share:1}]};
    const solve=async(model,options)=>{
        const r=highs.solve(model.lp,options);
        assert.equal(r.Status,'Optimal');
        return {values:Array.from({length:model.variables},(_,i)=>r.Columns['x'+i]?.Primal??0)};
    };
    const settings={input:{always_running:true,roster:{members,dispatch}},pkg,report};
    const result=await refineElectricStaffing(problem,{values:original},solve,settings);
    assert.ok(Math.abs(result.values[1]-.4)<1e-9);
    assert.equal(result.values[5],.4);
    const loss=values=>({...report(),rate_per_second:values[1] > .01 ? .999 : 1});
    assert.deepEqual((await refineElectricStaffing(problem,{values:original},solve,{...settings,report:loss})).values,original);
    const idle=()=>({...report(),roster_workload:[.4,0]});
    assert.deepEqual((await refineElectricStaffing(problem,{values:original},solve,{...settings,report:idle})).values,original);
    const surplus=()=>({...report(),income_streams:[{item_name:'wheat',units_per_second:1}]});
    assert.deepEqual((await refineElectricStaffing(problem,{values:original},solve,{...settings,report:surplus})).values,original);
});
test('fixed-output E-mode saves a whole Fire worker before relieving a larger shared Earth shift',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const keys=['rate:a#0','rate:a__electric1#0','rate:b#0','rate:b__electric1#0','rate:c#0','sold:a#0','generators#0'];
    const original=[.84,0,.15,0,.06,.84,1];
    const p={lp:'Maximize\n obj: x5\nSubject To\n power: x1 + 6 x3 <= 1\n sale: x0 + x1 - x5 = 0\nBounds\n'+
        keys.map((k,i)=>' 0 <= x'+i+' <= 1').join('\n')+'\nGeneral\n x6\nEnd',
        variables:keys.length,variable_keys:keys,recipe_options:[[0,'a','Mine',true,false,1],[1,'a','Mine',true,true,1],
            [2,'b','Stove',false,false,1],[3,'b','Stove',false,true,1],[4,'c','Mine',true,false,1]],
        primary_objective:[[5,1]],staffing_pools:[[[0,1],[4,1]],[[2,1]],[[6,1]]].map(work=>({work,crop:[],anchors:[],active:null}))};
    p.lp=p.lp.replace(' power:', ' keep_generator: x6 = 1\n power:');
    const solve=async model=>{
        const r=highs.solve(model.lp,{mip_rel_gap:0});
        assert.equal(r.Status,'Optimal');
        return {values:Array.from({length:model.variables},(_,i)=>r.Columns['x'+i]?.Primal??0)};
    };
    const r=await refineElectricStaffing(p,{values:original},solve);
    assert.ok(Math.abs(r.values[3]-.15)<1e-9);
    assert.equal(r.values[5],original[5]);
    assert.equal(r.values[6],1);
});

import {compactMeasuredTeam} from '../web/measured-team.js';

test('a measured kiln shift releases either Fire worker only when the deployed team can finish every batch',
    {skip:!fs.existsSync(wasm)}, async()=>{
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasm)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const ore='coarse_sifted_ore',facility='Chimney Kiln',key=facility+'|'+ore+'|Production';
    const members=[{count:1,abilities:{Fire:4}},{count:1,abilities:{Fire:3}},{count:1,abilities:{Earth:1}}];
    const dispatch={[key]:[0,1].map(member=>({member,share:.5,travel_seconds:0}))};
    for(const [sand,expected] of [[8000,[0,1,1]],[80000,[1,0,1]],[120000,null]]){
        const input={currency:'coins',always_running:true,always_running_recipes:[ore],aniimo:'roster',priorities:['coins'],
            quest_income_per_day:{mineral_sand:sand},roster:{members,environment:{},residents:[],dispatch,movement_seconds:0},
            fixed_homeland:{groups:[{facility,count:2,level:1,lit:false,powered:false},
                {facility:'Mine',count:1,level:1,lit:false,powered:false}],climate:{},generators:0}};
        const payload=JSON.stringify(input),stage=JSON.stringify({maximize_material_work:true});
        const model=JSON.parse(pkg.exact_problem(payload,stage)),solution=highs.solve(model.lp);
        assert.equal(solution.Status,'Optimal');
        const values=model.variable_keys.map((_,v)=>solution.Columns['x'+v]?.Primal??0);
        const plan=JSON.parse(pkg.exact_plan(payload,stage,JSON.stringify({values,proven:false,bound:0,verify_only:true})));
        assert.equal(plan.success,true,plan.error);
        Object.assign(plan,{continuous_production_checked:true,continuous_checked_recipes:[ore],
            comparison_seed:{keys:model.variable_keys,values},comparison_goals:{floors:[],currency:'coins'},
            comparison_scores:{material_work:model.primary_objective.reduce((n,[v,c])=>n+values[v]*c,0)},
            continuous_upper_bounds:[[JSON.stringify(['coins',{floors:[]}]),plan.rate_per_second]],
            crop_peaks:{counts:[1,1,1],completion:0,targetSeconds:21},reactive_dispatch:dispatch,delivery_assignments:[]});
        const rate=p=>p.roster_routes.filter(r=>r.item===ore).reduce((sum,r)=>sum+r.job_rate,0);
        const context={members,busy:plan.roster_workload,permanent:[0,0,0],routes:plan.roster_routes,
            recipes:[{name:ore,facility,ingredients:['mineral_sand'],workload:34,aniimo:['Fire',2]}],
            layout:{storages:[],pieces:[{members:[{facility,crop:ore,x:0,y:0,w:4,h:4,batchWeight:rate(plan)*3600}]}]}};
        const result=compactMeasuredTeam(pkg,highs,{input,plan,context,limit:3});
        if(expected){
            assert.deepEqual(result.crop_peaks.counts,expected);
            assert.ok(Math.abs(rate(result)-rate(plan))<1e-9);
            assert.ok(Math.abs(result.rate_per_second-plan.rate_per_second)<1e-9);
            assert.equal(result.roster_dispatch[key].length,1);
            assert.equal(result.roster_dispatch[key][0].share,1);
        }else assert.equal(result,null);
    }
});

test('a harvest worker can lend an idle copy to a resident post while preserving every recipe rate',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const keys=['rate:crop','rate:pearl:owned','rate:pearl:reserve','units:pearl:owned','units:pearl:reserve'];
    const problem={variables:5,variable_keys:keys,
        lp:['Maximize',' obj: x0','Subject To',' owned: x1 - x3 = 0',' reserve: x2 - x4 = 0',
            ' residence: x3 + x4 = 1','Bounds',...keys.map((_,i)=>' 0 <= x'+i+' <= 1'),'General',' x3',' x4','End'].join('\n'),
        recipe_options:[[0,'crop','Farmland',true,false,1],[1,'pearl','Sandcastle',true,false,1],[2,'pearl','Sandcastle',true,false,1]],
        recipe_variables:[[0,'crop'],[1,'pearl'],[2,'pearl'],[3,'pearl'],[4,'pearl']],
        staffing_groups:[[0],[1,2],[3,4]],
        staffing_pools:[{work:[[0,.25],[3,1]],crop:[0],anchors:[3],reserve:false},
            {work:[[4,1]],crop:[],anchors:[4],reserve:true}]};
    const solve=async model=>{
        const solution=highs.solve(model.lp);assert.equal(solution.Status,'Optimal');
        return {values:model.variable_keys.map((_,v)=>solution.Columns['x'+v].Primal)};
    };
    for(const helpers of [0,1]){
        const before={values:[1,0,1,0,1]},input={roster:{dispatch:{measured:[]},members:[{count:2}]},crop_peak_helpers:[helpers]};
        const after=await refineElectricStaffing(problem,before,solve,{input});
        assert.deepEqual(after.values,helpers?before.values:[1,1,0,1,0]);
    }
});

test('an idle Royalby takes both reserve loom jobs before and after their routes are measured', {skip:!fs.existsSync(wasm)}, async()=>{
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasm)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const recipes=[
        {name:'wool_fabric',facility:'Joy Wheel Loom',ingredients:['woolen_yarn'],aniimo:['Wind',3]},
        {name:'woolen_yarn',facility:'Joy Wheel Loom',ingredients:['wool'],aniimo:['Wind',2]},
    ];
    const members=[{count:1,abilities:{Wind:4,Light:3,Artisanship:4}},{count:1,abilities:{Leisure:4},family:'1026'}];
    const dispatch=Object.fromEntries(recipes.map(r=>[r.facility+'|'+r.name+'|Production',[{member:2,share:1,travel_seconds:0}]]));
    const names=['wool',...recipes.map(r=>r.name)];
    const input={currency:'coins',always_running:true,always_running_recipes:names,restrict_to_checked_recipes:true,
        exclude:JSON.parse(pkg.get_all_items()).map(r=>r.name).filter(n=>!names.includes(n)),
        facilities:{'Joy Wheel Loom':[{count:2,level:3}],'Nimbus Bed':[{count:1,level:1}]},
        aniimo:'roster',priorities:['coins'],
        roster:{members,environment:{},residents:['Nimbus Bed'],dispatch,movement_seconds:0}};
    const draftInput={...input,map_dispatch_pending:true,roster:{...input.roster,dispatch:{},movement_seconds:10}};
    const draftPayload=JSON.stringify(draftInput),draftModel=JSON.parse(pkg.exact_problem(draftPayload,'{}'));
    const solve=model=>{
        const result=highs.solve(model.lp);
        assert.equal(result.Status,'Optimal');
        return {values:model.variable_keys.map((_,v)=>result.Columns['x'+v]?.Primal??0)};
    };
    const holdReserve=draftModel.variable_keys.flatMap((k,v)=>k.startsWith('rate:') &&
        (k.includes('__byowned:0') || k.includes('__byreserve:{"Leisure"')) ? [' draft_'+v+': x'+v+' = 0'] : []);
    const original=solve({...draftModel,lp:draftModel.lp.replace('Subject To','Subject To\n'+holdReserve.join('\n'))});
    const report=values=>JSON.parse(pkg.exact_plan(draftPayload,'{}',JSON.stringify({values,verify_only:true,proven:false,bound:0})));
    assert.deepEqual(report(original.values).roster_routes.map(r=>r.member),[2,2]);
    const draft=report((await refineStaffing(draftModel,original,solve,{input:draftInput,report})).values);
    assert.deepEqual(draft.roster_routes.map(r=>r.member),[0,0]);
    assert.ok(Math.abs(draft.rate_per_second-report(original.values).rate_per_second)<1e-9);

    const payload=JSON.stringify(input),model=JSON.parse(pkg.exact_problem(payload,'{}'));
    const result=highs.solve(model.lp);
    assert.equal(result.Status,'Optimal');
    const values=model.variable_keys.map((_,v)=>result.Columns['x'+v]?.Primal??0);
    const plan=JSON.parse(pkg.exact_plan(payload,'{}',JSON.stringify({values,proven:true,bound:result.ObjectiveValue,verify_only:true})));
    assert.equal(plan.success,true,plan.error);
    assert.equal(plan.assumed_aniimo[0][1],'Wind');
    assert.deepEqual(plan.roster_routes.map(r=>r.member),[2,2]);
    Object.assign(plan,{continuous_production_checked:true,continuous_checked_recipes:names,comparison_seed:{keys:model.variable_keys,values},
        comparison_goals:{floors:[],currency:'coins'},continuous_upper_bounds:[[JSON.stringify(['coins',{floors:[]}]),plan.rate_per_second]],
        crop_peaks:{counts:[0,1,1,0],targetSeconds:21,completion:0},reactive_dispatch:dispatch});
    const sites=plan.roster_routes.map((r,i)=>({facility:r.facility,crop:r.item,x:i*4,y:0,w:2,h:2,batchWeight:r.job_rate*3600}));
    const pools=[...members];
    for(const [id,ability,level,count,family] of plan.assumed_aniimo)pools[id]={count,family,abilities:{[ability]:level},assumed:true};
    const context={members:pools,busy:plan.roster_workload,
        permanent:[0,1,0,0],routes:plan.roster_routes,recipes,layout:{pieces:[{members:sites}],storages:[]}};
    const after=compactMeasuredTeam(pkg,highs,{input,plan,context,limit:2});
    assert.ok(after,'replace the reserve while keeping the same number of workers');
    assert.deepEqual(after.crop_peaks.counts,[1,1,0,0]);
    assert.deepEqual(after.roster_routes.map(r=>[r.item,r.member]),plan.roster_routes.map(r=>[r.item,0]));
    assert.ok(Math.abs(after.rate_per_second-plan.rate_per_second)<1e-9);
});

test('an idle Sparki takes an equivalent furnace post from Magmarex even if the staffing solve retains its incumbent', async()=>{
    const problem={variables:2,variable_keys:['staff:Heat Furnace:owned:0#0','staff:Heat Furnace:owned:1#0'],
        climate_skills:[[0,11],[1,2]],staffing_pools:[0,1].map(v=>({anchors:[v],work:[[v,1]],crop:[],reserve:false}))};
    const input={roster:{members:[{count:1,abilities:{Fire:4,Dark:3,Hauling:4}},{count:1,abilities:{Fire:2}}],
        dispatch:{measured:[]}}};
    for(const [helpers,valid,expected] of [[0,true,[0,1]],[1,true,[1,0]],[0,false,[1,0]]]){
        const shift=await refineStaffing(problem,{values:[1,0]},async()=>null,{input:{...input,crop_peak_helpers:[0,helpers]},
            report:values=>({success:valid||values[1]===0,rate_per_second:1})});
        assert.deepEqual(shift.values,expected);
    }
});

test('the native plan verifies Sparki at the furnace with the same mine output', {skip:!fs.existsSync(wasm)}, async()=>{
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasm)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const input={currency:'coins',aniimo:'roster',always_running:true,
        fixed_homeland:{groups:[{facility:'Mine',count:1,level:1,lit:false,powered:false}],climate:{'Heat Furnace':1},generators:0},
        roster:{members:[{count:1,abilities:{Fire:4,Dark:3,Hauling:4}},{count:1,abilities:{Fire:2}},{count:1,abilities:{Earth:3}}],
            environment:{'Heat Furnace':'Fire'},residents:[],movement_seconds:0}};
    const payload=JSON.stringify(input),problem=JSON.parse(pkg.exact_problem(payload,'{}'));
    const furnace=problem.variable_keys.indexOf('staff:Heat Furnace:owned:0#0');
    const solved=highs.solve(problem.lp.replace('Subject To','Subject To\n initial_furnace: x'+furnace+' = 1'));
    assert.equal(solved.Status,'Optimal');
    const original={values:problem.variable_keys.map((_,v)=>solved.Columns['x'+v]?.Primal??0)};
    const report=values=>JSON.parse(pkg.exact_plan(payload,'{}',JSON.stringify({values,proven:false,bound:0,verify_only:true})));
    const before=report(original.values);
    assert.deepEqual(before.staffing,[['Heat Furnace',0,1]]);
    const after=report((await refineStaffing(problem,original,async()=>null,{input,report})).values);
    assert.equal(after.success,true,after.error);
    assert.deepEqual(after.staffing,[['Heat Furnace',1,1]]);
    assert.deepEqual(after.roster_workload,[0,1,before.roster_workload[2]]);
    assert.equal(after.rate_per_second,before.rate_per_second);
});
