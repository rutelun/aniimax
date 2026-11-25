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
