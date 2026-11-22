import test from 'node:test';
import assert from 'node:assert/strict';
import {powerTeamCandidates,singleWorkshopUpgrades} from '../web/power-team-candidates.js';
import {physicalPlanPower} from '../web/physical-power.js';
import {validateRecipeSchedule} from '../web/recipe-schedule.js';
import {materialChains, materialFlowSchedule} from '../web/material-flow-schedule.js';
import {scheduleInputForPlan, attachRecipeSchedule} from '../web/recipe-schedule-plan.js';

test('electrified workshop switches preserve every material rate, physical tier and daily stock cycle', () => {
    const facility = 'Woodworking Bench', items = materialChains[facility], ability = 'Artisanship';
    const input = {always_running:true, e_mode_rv:16, aniimo:'best', aniimo_levels:{Lightning:3,[ability]:3},
        facilities:{[facility]:[{level:1,count:1},{level:4,count:3}],Woodland:[{level:1,count:1}]},
        recipe_switching:{max_buildings:1,max_switches:1}};
    const recipes = items.map((name,i) => ({name,facility_level:i+1,aniimo:[ability,1]}));
    const native = {recipe_options:[],variable_keys:[]};
    for (const [i,item] of items.entries()) {
        for (const mode of [null,...(i===0?[1,4]:[4])]) {
            native.recipe_options.push([native.variable_keys.length,item,facility,false,!!mode,mode?1.5:1]);
            native.variable_keys.push('rate:'+item+(mode?'__electric'+mode:'')+'#0');
        }
    }
    const sources = items.map((item,i) => ({item,id:item,facility,cycle:1,facility_level:i+1,turns:true,rate:1.2/2**i,
        electric_level:null,inputs:[[items[i-1]??'wood_block',2]],outputs:[[item,1]],crew:null,hauling_seconds:[]}));
    sources.push({id:'tree',item:'tree',facility:'Woodland',cycle:1,facility_level:1,rate:1,turns:false,
        electric_level:null,inputs:[],outputs:[['wood_block',2.5]]});
    const role = {ability,level:3,personality_bonus:true};
    const base = {rate_per_second:10,schedule_sources:sources,generator_tiers_by_lightning:[0,0,3,3],generator_watts_by_lightning:[0,0,1000,1000],
        coin_items:sources.map(s => ({status:'producing',facility:s.facility,item_name:s.item,busy_units:s.rate,
            facility_count:Math.ceil(s.rate),cycle_time:1,electric_level:null,aniimo:role,aniimo_tasks:[{...role,busy:s.rate,jobs:[]}]}))};
    const scheduleInput = scheduleInputForPlan(input,base);
    const plan = attachRecipeSchedule(base,scheduleInput,materialFlowSchedule(scheduleInput));
    const snapshot = structuredClone(plan);
    const candidates = [...powerTeamCandidates(plan,input,native,recipes)];
    const mixed = candidates.find(p => p.recipe_schedule.sites.some(site => site.electric_level===4 && site.jobs.length===2));
    assert.ok(mixed);
    assert.deepEqual(plan,snapshot);
    for (const p of candidates) {
        assert.equal(p.rate_per_second,plan.rate_per_second);
        assert.deepEqual(validateRecipeSchedule({...scheduleInputForPlan(input,p),buildings:p.recipe_schedule.buildings},p.recipe_schedule).errors,[]);
        assert.equal(p.power_used??0,physicalPlanPower(p));
        assert.ok(p.power_used<=p.power_generated);
        assert.ok(p.power_generators<=2);
        for (const s of sources) {
            const sum = p.schedule_sources.filter(t => t.item===s.item).reduce((n,t) => n+t.rate,0);
            assert.ok(Math.abs(sum-s.rate)<1e-8);
        }
        for (const site of p.recipe_schedule.sites) for (const job of site.jobs) {
            assert.equal(job.electric_level,site.electric_level);
            assert.ok(site.level>=recipes.find(r=>r.name===job.item).facility_level);
        }
    }
});

test('ordinary E-mode changes use native cycle and owned tier, and preserve native surplus occupied sites', () => {
    const facility='Crafting Table', item='widget';
    const source={facility,id:item,item,rate:.25,cycle:1,facility_level:1,turns:false,inputs:[],outputs:[[item,1]]};
    const row={facility,item_name:item,status:'producing',facility_count:1,aniimo:{ability:'Artisanship',level:3},busy_units:.25};
    const plan={schedule_sources:[source], coin_items:[row], generator_tiers_by_lightning:[1,1,1,1],generator_watts_by_lightning:[600,600,600,600]};
    const input={facilities:{[facility]:[{level:2,count:1}]},e_mode_rv:12,aniimo_levels:{Lightning:2}};
    const problem={recipe_options:[[0,item,facility,false,false,1],[1,item,facility,false,true,2]],
        variable_keys:['rate:widget#0','rate:widget__electric2#0']};
    const candidates=(p) => [...powerTeamCandidates(p,input,problem,[{name:item,facility_level:1,aniimo:['Artisanship',1]}])];
    const powered=candidates(plan).find(p=>p.power_used>0);
    assert.ok(powered);
    assert.equal(powered.power_used,36);
    assert.equal(powered.schedule_sources[0].cycle,2);
    assert.deepEqual(powered.power_generator_levels,[[1,1]]);
    assert.equal(powered.coin_items[0].busy_units,.5);
    const held={...plan,coin_items:[{...row,facility_count:2}]};
    assert.ok(candidates(held).every(p=>p.power_used===0));
});

test('a powered upgrade cannot consume the only site available to a higher-tier manual recipe', () => {
    const facility='Crafting Table', items=['low','high'];
    const plan={schedule_sources:items.map(item=>({item,id:item,facility,cycle:1,rate:.5,inputs:[],outputs:[[item,1]]})),
        coin_items:items.map(item=>({item_name:item,facility,status:'producing',facility_count:1,busy_units:.5,
            aniimo:{ability:'Artisanship',level:3}})),generator_tiers_by_lightning:[1,1,1,1],generator_watts_by_lightning:[600,600,600,600]};
    const problem={recipe_options:[[0,'low',facility,false,false,1],[1,'low',facility,false,true,1],
        [2,'high',facility,false,false,1]],variable_keys:['rate:low#0','rate:low__electric3#0','rate:high#0']};
    const recipes=items.map((name,i)=>({name,facility_level:i?3:1,aniimo:['Artisanship',1]}));
    const candidates=tiers=>[...powerTeamCandidates(plan,{e_mode_rv:12,facilities:{[facility]:tiers}},problem,recipes)];
    const scarce=candidates([{level:1,count:1},{level:3,count:1}]);
    assert.ok(scarce.length);
    assert.ok(scarce.every(p=>p.power_used===0));
    assert.ok(candidates([{level:3,count:2}]).some(p=>p.power_used===54));
});

test('the shortlist can electrify a competing workshop even if the incumbent uses the entire power budget', () => {
    const facility='Crafting Table', items=['safe','competing'], skills=['Fire','Artisanship'];
    const plan={schedule_sources:items.map((item,i)=>({item,id:i?item:item+'__electric1',facility,rate:.5,cycle:1,
        electric_level:i?null:1,inputs:[],outputs:[[item,1]]})),power_generator_levels:[[1,4]],
        generator_tiers_by_lightning:[1,1,1,1],generator_watts_by_lightning:[1,2,3,18],coin_items:items.map((item,i)=>({item_name:item,facility,status:'producing',
        facility_count:1,busy_units:.5,electric_level:i?null:1,aniimo:i?{ability:skills[i],level:1}:null}))};
    const problem={variable_keys:[],recipe_options:[]};
    for(const item of items) for(const electric of [false,true]){
        problem.recipe_options.push([problem.variable_keys.length,item,facility,false,electric,1]);
        problem.variable_keys.push('rate:'+item+(electric?'__electric1':'')+'#0');
    }
    const input={e_mode_rv:12, facilities:{[facility]:[{count:2,level:1}]}};
    const recipes=items.map((name,i)=>({name,facility,facility_level:1,aniimo:[skills[i],1]}));
    const candidates=[...powerTeamCandidates(plan,input,problem,recipes)];
    assert.ok(candidates.some(p=>p.schedule_sources[1].electric_level===1 && p.power_used===18));
});

test('RV21 powers even a small load only with max-tier generators and Lightning 4', () => {
    const facility='Mine', item='ore';
    const source={facility,id:item,item,cycle:1,rate:.5,inputs:[],outputs:[[item,1]]};
    const plan={schedule_sources:[source],generator_tiers_by_lightning:[0,0,0,5],
        generator_watts_by_lightning:[0,0,0,1500],
        coin_items:[{facility,item_name:item,status:'producing',facility_count:1,busy_units:.5,aniimo:{ability:'Earth',level:1}}]};
    const problem={recipe_options:[[0,item,facility,false,false,1],[1,item,facility,false,true,1]],
        variable_keys:['rate:ore#0','rate:ore__electric1#0']};
    const recipes=[{name:item,facility,facility_level:1,aniimo:['Earth',1]}];
    for (const lightning of [3,4]) {
        const candidates=[...powerTeamCandidates(plan,{e_mode_rv:21,aniimo_levels:{Lightning:lightning},
            facilities:{Mine:[{level:1,count:1}]}},problem,recipes)];
        const pairs=candidates.flatMap(c=>c.power_generator_levels);
        if (lightning === 3) assert.equal(pairs.length,0);
        else {
            assert.ok(pairs.length);
            assert.ok(pairs.every(([tier,skill])=>tier===5 && skill===4));
        }
    }
});

test('spare generator capacity can remove an individual specialist without changing the other workshop',()=>{
    const jobs=[['pearl_powder','Carousel Mill','Wind',7],['brick','Chimney Kiln','Fire',5]];
    const input={facilities:{}}, recipes=[], problem={variable_keys:[],recipe_options:[]};
    const plan={power_generated:1500,power_used:0,schedule_sources:[],coin_items:[]};
    for (const [item,facility,ability,level] of jobs) {
        input.facilities[facility]=[{level,count:1}];
        recipes.push({name:item,facility_level:1,aniimo:[ability,3]});
        plan.schedule_sources.push({item,id:item,facility,rate:.08,cycle:1,turns:false,inputs:[],outputs:[[item,1]]});
        plan.coin_items.push({facility,item_name:item,status:'producing',facility_count:1,busy_units:.08,
            aniimo:{ability,level:4},aniimo_tasks:[{ability,level:4,busy:.08}]});
        for (const electric of [false,true]) {
            problem.recipe_options.push([problem.variable_keys.length,item,facility,false,electric,electric?2:1]);
            problem.variable_keys.push('rate:'+item+(electric?'__electric'+level:'')+'#0');
        }
    }
    const upgrades=[...singleWorkshopUpgrades(plan,input,problem,recipes)];
    assert.deepEqual(upgrades.map(p=>p.power_used),[126,90]);
    assert.deepEqual(upgrades.map(p=>p.schedule_sources.filter(s=>s.electric_level!=null).map(s=>s.item)),[['pearl_powder'],['brick']]);
    assert.deepEqual([...singleWorkshopUpgrades({...plan,power_generated:89},input,problem,recipes)],[]);
});
