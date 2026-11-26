import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {productionTeamJobs} from '../web/production-team-jobs.js';
import {recommendBestTeam} from '../web/best-team.js';
import {mappedTeamScore} from '../web/mapped-power-team.js';
import {preparePowerTeamValidator,selectPowerTeam,shortlistPowerTeams} from '../web/power-team-search.js';

const plan = {id:'incumbent'};
test('measured whole-team headcount wins, then working generators break ties',async()=>{
    const candidates=[{id:'larger'},{id:'smaller'},{id:'split'},{id:'tie'}];
    const scores=new Map([['incumbent',[40,1]],['larger',[41,3]],['smaller',[38,1]],['split',[38,2]],['tie',[38,2]]]);
    const best=await selectPowerTeam(plan,candidates,p=>{
        const [people,generators]=scores.get(p.id);
        return {people,generators};
    });
    assert.equal(best,candidates[2]);
});
test('discard stale measurements and skip failed layouts',async()=>{
    let current=true;
    const candidates=[{id:'bad'},{id:'better'},{id:'stale'}];
    const measure=p=>{
        if(p.id==='bad')throw new Error('invalid map');
        if(p.id==='stale')current=false;
        return p===plan?{people:40,generators:1}:{people:38,generators:2};
    };
    assert.equal(await selectPowerTeam(plan,candidates.slice(0,2),measure),candidates[1]);
    assert.equal(await selectPowerTeam(plan,candidates,measure,()=>current),plan);
    assert.equal(await selectPowerTeam(plan,candidates,()=>null),plan);
});
test('unsupported generated-power setups return an empty shortlist',async()=>{
    assert.deepEqual(await shortlistPowerTeams({},null,{},{}),[]);
});

test('a feasible team replaces an incumbent with an invalid map',async()=>{
    const candidate={};
    assert.equal(await selectPowerTeam(plan,[candidate],p=>p===plan?null:{people:45,generators:2}),candidate);
});

test('shortlist measures ordinary powered modes and keeps only native-checked generator counts',async()=>{
    const facility='Chimney Kiln',item='brick';
    const input={e_mode_rv:16,facilities:{[facility]:[{level:1,count:1}]}};
    const role={ability:'Fire',level:1,busy:1};
    const source={facility,item,id:item,facility_level:1,rate:1,cycle:1,turns:false,inputs:[],outputs:[[item,1]],electric_level:null};
    const row={facility,item_name:item,facility_count:1,status:'producing',busy_units:1,cycle_time:1,aniimo:role,aniimo_tasks:[role]};
    const incumbent={schedule_sources:[source],coin_items:[row],comparison_seed:{keys:[],values:[]},
        comparison_goals:{floors:[]},rate_per_second:1,generator_tiers_by_lightning:[1],generator_watts_by_lightning:[600]};
    const problem={variable_keys:['rate:brick#0','rate:brick__electric1#0','generators#0'],
        recipe_options:[[0,item,facility,false,false,1],[1,item,facility,false,true,1]],lp:'\nBounds\n'};
    const pkg={exact_problem:()=>JSON.stringify(problem),get_all_items:()=>JSON.stringify([{name:item,facility_level:1,aniimo:['Fire',1]}]),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1,priorities:[]})};
    const highs={solve:lp=>lp.includes('hold_2: x2 = 2')?{Status:'Infeasible'}:{Status:'Optimal',Columns:{}}};
    const shortlist=await shortlistPowerTeams(pkg,highs,incumbent,input);
    assert.deepEqual(shortlist.map(({plan:p})=>[p.power_generators,p.power_used]).sort(),[[0,0],[1,18]]);
});
test('separate working grids break a tie after workers and active generators',async()=>{
    const split={id:'split'},combined={id:'combined'};
    const winner=await selectPowerTeam(plan,[combined,split],p=>({people:9,generators:2,networks:p===split?2:1}));
    assert.equal(winner,split);
});

test('equal mapped teams electrify the workshop that can divert the generator operator',async()=>{
    const recipes=[{name:'brick',facility:'Chimney Kiln',aniimo:['Fire',1]},
        {name:'parts',facility:'Crafting Table',aniimo:['Artisanship',1]}];
    const makePlan=electricItem=>({coin_items:recipes.map(r=>({
        facility:r.facility,item_name:r.name,status:'producing',facility_count:1,
        electric_level:r.name===electricItem?1:null,aniimo_tasks:[{ability:r.aniimo[0],level:4,busy:.5}],
    }))});
    const kiln=makePlan('brick'),bench=makePlan('parts');
    const measure=p=>{
        const jobs=productionTeamJobs(p,recipes);
        jobs.push({ability:'Lightning',level:4,busy:1,label:'Generator',facility:'Crackle Generator',fixed:true});
        return mappedTeamScore(recommendBestTeam(jobs),{networks:[{consumers:1,generated:18,generators:1}]},2);
    };
    assert.deepEqual(measure(kiln),{people:2,generators:1,networks:1,cropWorkshopDistractions:0,distractions:1,manualWork:0.5});
    assert.deepEqual(measure(bench),{people:2,generators:1,networks:1,cropWorkshopDistractions:0,distractions:0,manualWork:0.5});
    assert.equal(await selectPowerTeam(kiln,[bench],measure),bench);
});

test('equal measured teams prefer less manual work (more E-mode) when headcount, generators and distractions tie',async()=>{
    const manual={id:'manual'},powered={id:'powered'};
    const winner=await selectPowerTeam(manual,[powered],p=>({
        people:10,generators:2,networks:2,cropWorkshopDistractions:0,distractions:0,income:100,
        manualWork:p===powered?3.2:4.0,
    }));
    assert.equal(winner,powered);
});

test('protects crop workers and harvest helpers from eligible manual workshops before comparing generator layouts',async()=>{
    const mine=level=>({facility:'Mine',ability:'Earth',level:4,minimumLevel:level,busy:.2,
        workstation:true,label:'Ore',siteCount:2});
    const farmer={entry:{abilities:{Grass:3,Earth:2}},busy:.5,allocations:[{growing:true}]};
    const helper={entry:{abilities:{Earth:4}},busy:0,allocations:[],peakSupport:true};
    const measure=(jobs,generators)=>mappedTeamScore({...recommendBestTeam(jobs),shifts:[farmer,helper]},
        {networks:[{consumers:1,generated:600,generators}]},4);
    assert.equal(measure([mine(3)],2).cropWorkshopDistractions,2);
    assert.equal(measure([mine(2)],2).cropWorkshopDistractions,4);
    const safe={},risky={};
    assert.equal(await selectPowerTeam(risky,[safe],p=>p===safe?measure([],1):measure([mine(3)],2)),safe);
});

test('crop protection accepts at most half a percent of original income and preserves upgrade time',async()=>{
    const {cropProtectionPlans}=await import('../web/power-team-validation.js');
    const keys=['rate:drink#0','units:drink#0','rate:drink__electric5#0','units:drink__electric5#0','generators#0'];
    const model={variable_keys:keys,lp:'Maximize\n obj: x0\nBounds\n',
        recipe_options:[[0,'drink','Bouncy Brew Keg',false,false,67.5],[2,'drink','Bouncy Brew Keg',false,true,135]]};
    const manual={facility:'Bouncy Brew Keg',item_name:'drink',status:'producing',facility_count:2};
    const base={currency:'coins',rate_per_second:99.7,power_generators:1,power_generated:1500,schedule_sources:[{item:'drink',id:'drink',rate:.002}],
        coin_items:[manual],comparison_seed:{keys,values:[.002,2,0,0,1]},level_up_preview:{seconds:100},
        comparison_goals:{floors:[['coins',99.7],['wood',1]]},priorities:[{target:'wood',per_second:1}]};
    const earned={success:true,rate_per_second:99.5,level_up_preview:{seconds:100},priorities:[{target:'wood',per_second:1}],
        schedule_sources:[{id:'drink__electric5',item:'drink',electric_level:5}],coin_items:[{...manual,electric_level:5}]};
    const pkg={exact_problem:(_input,stage)=>{
        assert.deepEqual(JSON.parse(stage).floors,[['wood',1],['coins',99.5]]);
        return JSON.stringify(model);
    },exact_plan:()=>JSON.stringify(earned)};
    const highs={solve:lp=>lp.includes('x1 <= 0')?{Status:'Optimal',Columns:{}}:{Status:'Infeasible'}};
    const solve=()=>cropProtectionPlans(pkg,highs,{plan:base,input:{e_mode_rv:21},targets:['drink'],referenceIncome:100});
    const [protectedPlan]=solve();
    assert.equal(protectedPlan.rate_per_second,99.5);
    assert.equal(protectedPlan.power_used,180);
    assert.equal(protectedPlan.crop_protection_reference_income,100);
    earned.rate_per_second=99.499;
    assert.deepEqual(solve(),[]);
    earned.rate_per_second=99.6;
    earned.level_up_preview.seconds=101;
    assert.deepEqual(solve(),[]);
    earned.level_up_preview.seconds=100;
    earned.priorities=[];
    assert.deepEqual(solve(),[]);
});

test('at equal measured crop protection Best keeps the higher income before saving a worker',async()=>{
    const options=[{risk:1,coins:100,crew:4},{risk:0,coins:99.55,crew:4},{risk:0,coins:99.8,crew:5}];
    const best=await selectPowerTeam(options[0],options.slice(1),p=>({people:p.crew,generators:2,
        cropWorkshopDistractions:p.risk,income:p.coins}));
    assert.equal(best,options[2]);
});

test('prepared reusable native validator matches direct shortlistPowerTeams',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const facility='Chimney Kiln',item='brick';
    const input={e_mode_rv:16,facilities:{[facility]:[{level:1,count:1}]}};
    const role={ability:'Fire',level:1,busy:1};
    const source={facility,item,id:item,facility_level:1,rate:1,cycle:1,turns:false,inputs:[],outputs:[[item,1]],electric_level:null};
    const row={facility,item_name:item,facility_count:1,status:'producing',busy_units:1,cycle_time:1,aniimo:role,aniimo_tasks:[role]};
    const incumbent={schedule_sources:[source],coin_items:[row],comparison_seed:{keys:['rate:brick#0','rate:brick__electric1#0','generators#0'],values:[1,0,0]},
        comparison_goals:{floors:[]},rate_per_second:1,generator_tiers_by_lightning:[1],generator_watts_by_lightning:[600]};
    const lp=[
        'Maximize',' obj: x0 + x1',
        'Subject To',' cap: x0 + x1 <= 1',' pwr: 18 x1 - 600 x2 <= 0',
        'Bounds',' 0 <= x0 <= 1',' 0 <= x1 <= 1',' 0 <= x2 <= 1',
        'General',' x2','End',
    ].join('\n');
    const problem={variables:3,variable_keys:['rate:brick#0','rate:brick__electric1#0','generators#0'],
        recipe_options:[[0,item,facility,false,false,1],[1,item,facility,false,true,1]],lp};
    const pkg={exact_problem:()=>JSON.stringify(problem),get_all_items:()=>JSON.stringify([{name:item,facility_level:1,aniimo:['Fire',1]}]),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1,priorities:[]})};
    const direct=await shortlistPowerTeams(pkg,highs,incumbent,input);
    const prepared=preparePowerTeamValidator(pkg,highs,incumbent,input);
    try {
        const reused=await shortlistPowerTeams(pkg,highs,{...incumbent,hauling_busy:0.5},input,prepared);
        assert.deepEqual(reused.map(f=>[f.plan.power_generators,f.plan.power_used]),
            direct.map(f=>[f.plan.power_generators,f.plan.power_used]));
    } finally {
        prepared?.validator?.dispose?.();
    }
});

test('powerTeamCandidates consolidates split manual+electric recipes and multi-site fractional workshops',async()=>{
    const {powerTeamCandidates,singleWorkshopUpgrades}=await import('../web/power-team-candidates.js');
    const recipes=[
        {name:'malt_sugar',facility:'Simmering Pot',facility_level:1,aniimo:['Fire',1]},
        {name:'candied_strawberries',facility:'Pickling Jar',facility_level:4,aniimo:['Dark',3]},
    ];
    const input={e_mode_rv:17,facilities:{'Simmering Pot':[{level:5,count:2}],'Pickling Jar':[{level:4,count:2}]}};
    const problem={
        variable_keys:['rate:malt_sugar#0','rate:malt_sugar__electric5#0','rate:candied_strawberries#0','rate:candied_strawberries__electric4#0','generators#0'],
        recipe_options:[
            [0,'malt_sugar','Simmering Pot',false,false,100],[1,'malt_sugar','Simmering Pot',false,true,200],
            [2,'candied_strawberries','Pickling Jar',false,false,45],[3,'candied_strawberries','Pickling Jar',false,true,90],
        ],
    };
    const plan={
        power_generators:1,power_used:90,power_generated:1000,power_generator_levels:[[3,3]],
        generator_tiers_by_lightning:[0,0,3,3],generator_watts_by_lightning:[0,0,1000,1000],
        schedule_sources:[
            {facility:'Simmering Pot',item:'malt_sugar',id:'malt_sugar',facility_level:1,rate:0.002,cycle:100,turns:false,inputs:[],outputs:[['malt_sugar',1]],electric_level:null},
            {facility:'Simmering Pot',item:'malt_sugar',id:'malt_sugar__electric5',facility_level:5,rate:0.001,cycle:200,turns:false,inputs:[],outputs:[['malt_sugar',1]],electric_level:5},
            {facility:'Pickling Jar',item:'candied_strawberries',id:'candied_strawberries',facility_level:4,rate:0.015,cycle:45,turns:false,inputs:[],outputs:[['candied_strawberries',1]],electric_level:null},
        ],
        coin_items:[
            {facility:'Simmering Pot',item_name:'malt_sugar',facility_count:1,status:'producing',busy_units:0.2,cycle_time:100,electric_level:null,aniimo:{ability:'Fire',level:4},aniimo_tasks:[{ability:'Fire',level:4,busy:0.2}]},
            {facility:'Simmering Pot',item_name:'malt_sugar',facility_count:1,status:'producing',busy_units:0.2,cycle_time:200,electric_level:5,aniimo:null,aniimo_tasks:[]},
            {facility:'Pickling Jar',item_name:'candied_strawberries',facility_count:2,status:'producing',busy_units:0.675,cycle_time:45,electric_level:null,aniimo:{ability:'Dark',level:4},aniimo_tasks:[{ability:'Dark',level:4,busy:0.675}]},
        ],
    };
    const candidates=[...powerTeamCandidates(plan,input,problem,recipes)];
    const consolidated=candidates.find(c=>c.schedule_sources.filter(s=>s.item==='malt_sugar').length===1
        && c.schedule_sources.find(s=>s.item==='malt_sugar').electric_level===5
        && Math.abs(c.schedule_sources.find(s=>s.item==='malt_sugar').rate-0.003)<1e-9);
    assert.ok(consolidated);
    assert.equal(consolidated.coin_items.filter(r=>r.item_name==='malt_sugar'&&r.status==='producing').length,1);
    assert.ok(candidates.some(c=>c.schedule_sources.find(s=>s.item==='candied_strawberries')?.electric_level===4
        && c.coin_items.find(r=>r.item_name==='candied_strawberries')?.facility_count===2));
    // Every singleWorkshopUpgrade must be an electric upgrade (never an all-manual downgrade),
    // and 0-watt split consolidations must still be considered at full grid draw.
    const upgrades=[...singleWorkshopUpgrades(plan,input,problem,recipes)];
    assert.ok(upgrades.length>=2);
    assert.ok(upgrades.every(u=>u.power_used>=plan.power_used));
    assert.ok(upgrades.some(u=>u.schedule_sources.filter(s=>s.item==='malt_sugar').every(s=>s.electric_level===5)));
    assert.ok(upgrades.some(u=>u.schedule_sources.find(s=>s.item==='candied_strawberries')?.electric_level===4));
    const fullGridUpgrades=[...singleWorkshopUpgrades({...plan,power_generated:plan.power_used},input,problem,recipes)];
    assert.ok(fullGridUpgrades.some(u=>u.schedule_sources.filter(s=>s.item==='malt_sugar').every(s=>s.electric_level===5)));
    // Electric-before-manual source ordering must preserve the manual row's Aniimo level.
    const reversedPlan={...plan,schedule_sources:[plan.schedule_sources[1],plan.schedule_sources[0],plan.schedule_sources[2]]};
    const revManual=[...powerTeamCandidates(reversedPlan,input,problem,recipes)]
        .find(c=>c.schedule_sources.filter(s=>s.item==='malt_sugar').every(s=>s.electric_level==null));
    assert.equal(revManual?.coin_items.find(r=>r.item_name==='malt_sugar')?.aniimo?.level,4);
});

test('shortlist retains split manual+electric incumbent when consolidated all-electric fails validation',async()=>{
    const recipes=[{name:'malt_sugar',facility:'Simmering Pot',facility_level:1,aniimo:['Fire',1]}];
    const input={e_mode_rv:17,facilities:{'Simmering Pot':[{level:5,count:2}]}};
    const problem={
        variable_keys:['rate:malt_sugar#0','rate:malt_sugar__electric5#0','units:malt_sugar#0','units:malt_sugar__electric5#0','generators#0'],
        recipe_options:[[0,'malt_sugar','Simmering Pot',false,false,100],[1,'malt_sugar','Simmering Pot',false,true,200]],
        lp:'\nBounds\n',
    };
    const incumbent={
        power_generators:1,power_used:90,power_generated:1000,power_generator_levels:[[3,3]],
        generator_tiers_by_lightning:[0,0,3,3],generator_watts_by_lightning:[0,0,1000,1000],
        rate_per_second:1,comparison_seed:{keys:problem.variable_keys,values:[0.002,0.001,1,1,1]},
        comparison_goals:{floors:[]},
        schedule_sources:[
            {facility:'Simmering Pot',item:'malt_sugar',id:'malt_sugar',facility_level:1,rate:0.002,cycle:100,turns:false,inputs:[],outputs:[['malt_sugar',1]],electric_level:null},
            {facility:'Simmering Pot',item:'malt_sugar',id:'malt_sugar__electric5',facility_level:5,rate:0.001,cycle:200,turns:false,inputs:[],outputs:[['malt_sugar',1]],electric_level:5},
        ],
        coin_items:[
            {facility:'Simmering Pot',item_name:'malt_sugar',facility_count:1,status:'producing',busy_units:0.2,cycle_time:100,electric_level:null,aniimo:{ability:'Fire',level:4},aniimo_tasks:[{ability:'Fire',level:4,busy:0.2}]},
            {facility:'Simmering Pot',item_name:'malt_sugar',facility_count:1,status:'producing',busy_units:0.2,cycle_time:200,electric_level:5,aniimo:null,aniimo_tasks:[]},
        ],
    };
    const pkg={
        exact_problem:()=>JSON.stringify(problem),
        get_all_items:()=>JSON.stringify(recipes),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1,priorities:[],coin_items:incumbent.coin_items}),
    };
    // Reject pure electric consolidation (rate:malt_sugar#0 = 0), allow the split incumbent.
    const highs={solve:lp=>/hold_0: x0 = 0(?:\r?\n|$)/.test(lp)?{Status:'Infeasible'}:{Status:'Optimal',Columns:{}}};
    const shortlist=await shortlistPowerTeams(pkg,highs,incumbent,input);
    assert.ok(shortlist.some(({plan:p})=>p.power_generators===1 && p.schedule_sources.length===2));
});

test('power team validator rejects candidates whose native solve requires more physical sites than budgeted',async()=>{
    const {createPowerTeamValidator}=await import('../web/power-team-validation.js');
    const recipes=[{name:'candied_strawberries',facility:'Pickling Jar',facility_level:4,aniimo:['Dark',3]}];
    const input={e_mode_rv:17,facilities:{'Pickling Jar':[{level:4,count:4}]}};
    const problem={
        variable_keys:['rate:candied_strawberries#0','rate:candied_strawberries__electric4#0','units:candied_strawberries#0','units:candied_strawberries__electric4#0','generators#0'],
        recipe_options:[[0,'candied_strawberries','Pickling Jar',false,false,45],[1,'candied_strawberries','Pickling Jar',false,true,90]],
        lp:'\nBounds\n',
    };
    const base={
        power_generators:1,power_used:144,power_generated:1000,rate_per_second:1,
        comparison_seed:{keys:problem.variable_keys,values:[0,0.015,0,2,1]},comparison_goals:{floors:[]},
        schedule_sources:[{facility:'Pickling Jar',item:'candied_strawberries',id:'candied_strawberries__electric4',facility_level:4,rate:0.015,cycle:90,turns:false,inputs:[],outputs:[['candied_strawberries',1]],electric_level:4}],
        coin_items:[{facility:'Pickling Jar',item_name:'candied_strawberries',facility_count:2,status:'producing',busy_units:1.35,cycle_time:90,electric_level:4}],
    };
    // Mock native plan that silently needs 4 sites (288W) while candidate budgeted 2 sites (144W).
    const pkg={
        exact_problem:()=>JSON.stringify(problem),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1,priorities:[],
            coin_items:[{facility:'Pickling Jar',item_name:'candied_strawberries',facility_count:4,status:'producing',busy_units:1.35,cycle_time:90,electric_level:4}]}),
    };
    const highs={solve:lp=>{
        // Verify validator caps units:candied_strawberries__electric4#0 <= 2 in the LP too.
        assert.ok(lp.includes('cap_3: x3 <= 2'));
        return {Status:'Optimal',Columns:{}};
    }};
    const validator=createPowerTeamValidator(pkg,highs,base,input);
    assert.equal(validator.validate(base),null);
});

test('power team validator and crop protection retain solved pace floor against LP slack', async () => {
    const { createPowerTeamValidator, cropProtectionPlans } = await import('../web/power-team-validation.js');
    const input = { e_mode_rv: 21, facilities: { 'Bouncy Brew Keg': [{ level: 5, count: 1 }] } };
    const problem = {
        variable_keys: ['rate:agave_drink#0', 'rate:agave_drink__electric5#0', 'units:agave_drink#0', 'units:agave_drink__electric5#0', 'pace#0', 'generators#0'],
        recipe_options: [[0, 'agave_drink', 'Bouncy Brew Keg', false, false, 67.5], [1, 'agave_drink', 'Bouncy Brew Keg', false, true, 135]],
        lp: '\nBounds\n',
    };
    const pace = 0.04341477272727273;
    const base = {
        currency: 'coins',
        power_generators: 1, power_used: 0, power_generated: 1500, power_generator_levels: [[5, 3]], rate_per_second: 100,
        level_up_preview: { seconds: 86400 / pace },
        priorities: [{ target: 'coins', per_second: 100 }],
        comparison_seed: { keys: problem.variable_keys, values: [0.002, 0, 1, 0, pace, 1] },
        comparison_goals: { currency: 'coins', pace, floors: [['coins', 100]] },
        schedule_sources: [{ facility: 'Bouncy Brew Keg', item: 'agave_drink', id: 'agave_drink', facility_level: 1, rate: 0.002, cycle: 67.5, turns: false, inputs: [], outputs: [['agave_drink', 1]], electric_level: null }],
        coin_items: [{ facility: 'Bouncy Brew Keg', item_name: 'agave_drink', facility_count: 1, status: 'producing', busy_units: 0.135, cycle_time: 67.5, electric_level: null, aniimo: { ability: 'Water', level: 4 }, aniimo_tasks: [{ ability: 'Water', level: 4, busy: 0.135 }] }],
    };
    const pkg = {
        exact_problem: () => JSON.stringify(problem),
        exact_plan: () => JSON.stringify({
            success: true, rate_per_second: 100, priorities: [{ target: 'coins', per_second: 100 }],
            level_up_preview: { seconds: 86400 / pace },
            coin_items: base.coin_items, schedule_sources: base.schedule_sources,
        }),
    };
    let sawValidatorPace = false, sawCropPace = false;
    const highs = {
        solve: lp => {
            if (lp.includes(`hold_4: x4 >= ${pace}`)) sawValidatorPace = true;
            if (lp.includes(`x4 >= ${pace}`)) sawCropPace = true;
            return { Status: 'Optimal', Columns: { x4: { Primal: pace }, x5: { Primal: 1 } } };
        },
    };
    const validator = createPowerTeamValidator(pkg, highs, base, input);
    assert.ok(validator.validate(base), 'validator should accept incumbent with retained pace floor');
    assert.ok(sawValidatorPace, 'validator LP must retain pace#0 >= prior pace');
    cropProtectionPlans(pkg, highs, { plan: base, input, targets: ['agave_drink'], referenceIncome: 100 });
    assert.ok(sawCropPace, 'cropProtectionPlans LP must retain pace#0 >= prior pace');
});
