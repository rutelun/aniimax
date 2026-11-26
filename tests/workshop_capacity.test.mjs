import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLinearLp} from '../web/highs-reuse.js';
import {withWorkshopCapacityCuts} from '../web/bound-tightening.js';

function workshop(capacity) {
    return {variables:7, variable_keys:['units:a','units:b','extra#0','extra#1','extra#2','extra#3','units:c'],
        lp:`Maximize
 obj: x0
Subject To
 sites: x0 + x1 + x6 <= ${capacity}
 a: x2 + 2 x3 - x0 = 0
 b: x4 + 2 x5 - x1 = 0
Bounds
 0 <= x0 <= 3
 0 <= x1 <= 3
 0 <= x2 <= 1
 0 <= x3 <= 1
 0 <= x4 <= 1
 0 <= x5 <= 1
 0 <= x6 <= 3
General
 x0
 x1
 x2
 x3
 x4
 x5
End`};
}

test('capacity cuts exclude fractional double bookings and preserve all whole recipe assignments',()=>{
    for(const capacity of [2,3,4,5]){
        const model=withWorkshopCapacityCuts(workshop(capacity));
        const cuts=parseLinearLp(model.lp,model.variables).rows.filter(row=>row.name.startsWith('machine_'));
        assert.ok(cuts.length);
        const fits=values=>cuts.every(({coefficients,hi})=>
            coefficients.reduce((n,[v,c])=>n+c*values[v],0)<=hi);
        for(let a=0;a<=3;a++)for(let b=0;b<=3;b++)for(const other of [0,.5,1]){
            if(a+b+other<=capacity)assert.ok(fits([a,b,a%2,a>>1,b%2,b>>1,other]));
        }
        // The relaxed counts consume exactly two sites. The second recipe's
        // half-activated pair cannot coexist with a whole single-site recipe.
        if(capacity===2)assert.equal(fits([1,1,1,0,0,.5,0]),false);
    }
});

test('a signed capacity row or a fractional selector cannot prove a workshop cover',()=>{
    const original=workshop(2);
    for(const lp of [original.lp.replace('0 <= x6','-2 <= x6'), original.lp.replace(' x3\n x4',' x4').replace(' x5\nEnd','End')]){
        const problem={...original,lp};
        assert.equal(withWorkshopCapacityCuts(problem),problem);
    }
});

import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {materialChains} from '../web/material-flow-schedule.js';
import {simpleSetup} from '../web/facility-config.js';
import {validateWorkshopCapacity} from '../web/recipe-switch-search.js';
import {searchWorkshopCapacity} from '../web/workshop-capacity.js';

const wasmPath=new URL('../web/pkg/aniimax_bg.wasm',import.meta.url);
async function workshopSolver(){
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    return {pkg,highs,items:JSON.parse(pkg.get_all_items())};
}

function ordinaryShift(pkg,highs,input,reserved){
    const payload=JSON.stringify(input),stage='{"pace":0,"floors":[]}';
    const p=JSON.parse(pkg.exact_problem(payload,stage));
    const site=p.variable_keys.indexOf('units:'+reserved+'#0');
    if(reserved)assert.ok(site>=0);
    const lp=reserved?p.lp.replace('\nBounds\n','\n held_site: x'+site+' = 1\nBounds\n'):p.lp;
    const r=highs.solve(lp),values=p.variable_keys.map((_,v)=>r.Columns['x'+v]?.Primal??0);
    const baseline=JSON.parse(pkg.exact_plan(payload,stage,JSON.stringify({values,proven:false,bound:0,verify_only:true})));
    assert.equal(baseline.success,true,baseline.error);
    return {...baseline,comparison_seed:{keys:p.variable_keys,values},
        active_continuous_recipes:p.recipe_variables.filter(([v])=>values[v]>1e-9).map(([,name])=>name),
        comparison_goals:{floors:[],pace:0,currency:'coins',currency_value:0},continuous_production_checked:true};
}

test('one bench can finish an otherwise unreachable plank upgrade with a verified daily change',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const {pkg,highs,items}=await workshopSolver();
    const input={currency:'coins',aniimo:'best',always_running:true,priorities:['level_up','coins'],
        facilities:{'Woodworking Bench':[{level:2,count:1}],'Chimney Kiln':[{level:1,count:1}]},quest_income_per_day:{wood_block:864000},
        exclude:items.map(item=>item.name).filter(name=>!['rough_lumber','standard_planks','coarse_sifted_ore'].includes(name)),
        level_up_preview:{cost:[['standard_planks',10]],stock:[]}};
    // The ordinary event plan can reserve an ingredient-starved site. Its
    // zero-rate recipe is omitted from the displayed production rows.
    const baseline=ordinaryShift(pkg,highs,input,'coarse_sifted_ore');
    assert.ok(baseline.active_continuous_recipes.includes('coarse_sifted_ore'));
    assert.ok(!baseline.coin_items.some(r=>r.status==='producing'&&r.item_name==='coarse_sifted_ore'));
    assert.equal(baseline.level_up_preview.seconds,null);
    const validate=(t,p,b)=>validateWorkshopCapacity(t,p,b,m=>highs.solve(m.lp));
    const best=await searchWorkshopCapacity(pkg,highs,input,baseline,{validate});
    assert.ok(Math.abs(best.level_up_preview.seconds-637.5)<1e-6);
    assert.equal(best.recipe_schedule.switches.length,1);
    assert.equal(best.continuous_production_checked,true);
    assert.equal(await searchWorkshopCapacity(pkg,highs,input,baseline,{validate:async()=>null}),baseline);
});


test('E-mode covers a temporary second raw lane at the same pace as an extra manual shift',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const {pkg,highs,items}=await workshopSolver(),bench='Woodworking Bench';
    const recipes=materialChains[bench],generator='Crackle Generator';
    for(const grid of ['manual','one site','full']){
        const powered=grid!=='manual';
        const input={currency:'coins',aniimo:'best',always_running:true,priorities:['level_up','coins'],
            e_mode_rv:grid==='full'?19:0,electricity:grid==='one site'?{watts:72,percent:120}:null,facilities:{[bench]:[{level:4,count:4}],[generator]:simpleSetup(19).facilities[generator]},
            quest_income_per_day:{wood_block:116640},exclude:items.filter(i=>!recipes.includes(i.name)).map(i=>i.name),
            level_up_preview:{cost:[[recipes[3],10]],stock:[]}};
        const base=ordinaryShift(pkg,highs,input);
        const schedules=[];
        const selected=await searchWorkshopCapacity(pkg,highs,input,base,{validate:async(t,p,b)=>{
            const checked=await validateWorkshopCapacity(t,p,b,m=>highs.solve(m.lp));
            if(checked?.recipe_schedule)schedules.push(checked.recipe_schedule);
            return checked;
        }});
        // 10 components require 20,480 blocks, at 1.35 blocks per second.
        assert.ok(Math.abs(selected.level_up_preview.seconds-20480/1.35)<1e-6);
        assert.equal(selected.recipe_schedule.switches.length,1);
        const raw=selected.recipe_schedule.jobs.filter(job=>job.recipe===recipes[0]);
        if(grid==='one site'){
            assert.ok(schedules.some(s=>s.jobs.filter(j=>j.electric_level===4).length===2 &&
                s.jobs.some(j=>j.electric_level===4&&j.recipe===recipes[0])),
                'one powered site can change from raw to a downstream recipe');
            continue;
        }
        assert.equal(raw.some(job=>job.electric_level===4),powered);
        const peak=Math.max(...Object.values(selected.recipe_schedule.workerProfiles).flat());
        assert.equal(Math.ceil(peak-1e-8),powered?1:3);
    }
});

test('workshop capacity E-mode refinement upgrades automatic generators when physical schedule power crosses a generator boundary',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const {pkg,highs,items}=await workshopSolver();
    const rv=21, setup=simpleSetup(rv);
    const keep=new Set([
        ...materialChains['Woodworking Bench'],
        ...materialChains['Chimney Kiln'],
        'silver_ore','gem','shell','fresh_water','quick_fresh_water','natural_mineral_spring_water','quick_natural_mineral_spring_water',
        'agave','quick_agave','orange_flower','coconut','quick_coconut','magic_pumpkin','memory_lanternfruit','rose',
        'aromathyst','quick_aromathyst','wool','quick_wool','gold_speck_cap','pearl','quick_pearl','scales','quick_scales',
        'aniipod_mega','growth_fruit','agave_drink','coconut_oil','pearl_powder','agave_fiber',
        'sisal_plush_mat','woolen_yarn','magic_pumpkin_lantern','advanced_gemstone_dust','pearl_face_cream',
        'lotion','orange_flower_incense','agave_syrup','orange_flower_syrup',
    ]);
    const input={
        currency:'coins', aniimo:'best', always_running:true, e_mode_rv:rv,
        priorities:['aniipods','aniimo_exp','level_up','coins'],
        season:'magical_wonder_night', season_crop_minimums:{magic_pumpkin:6,memory_lanternfruit:6},
        facilities:setup.facilities, modules:setup.modules,
        aniimo_levels:{Earth:4,Water:4,Leisure:4,Wind:4,Artisanship:4,Fire:4,Dark:4,Perfumery:3,Lightning:4},
        exclude:items.map(i=>i.name).filter(n=>!keep.has(n)),
        level_up_preview:{cost:[['coins',52600000],['densified_timber_component',1190],['microcrystalline_ore_plate',1320]],stock:[]},
    };
    // Solve ordinary baseline directly on the compact recipe set.
    const {tryPriorityPlan}=await import('../web/continuous-priority-plan.js');
    const solveModel=async(model,opts={})=>{
        const {mipIterations,...hiOpts}=opts;
        const res=highs.solve(model.lp,{mip_rel_gap:0,mip_abs_gap:0,...hiOpts});
        if(res.Status!=='Optimal'||!res.Columns)return null;
        return {objective:res.ObjectiveValue,values:Array.from({length:model.variables},(_,i)=>res.Columns['x'+i]?.Primal??0),proven:true};
    };
    const baseline=await tryPriorityPlan(pkg,input,{highs,solveModel});
    assert.ok(baseline?.success);
    const validate=(t,p,b)=>validateWorkshopCapacity(t,p,b,m=>highs.solve(m.lp,{mip_rel_gap:0}));
    const selected=await searchWorkshopCapacity(pkg,highs,input,baseline,{validate});
    assert.ok(selected.recipe_schedule, 'should select a verified switching schedule');
    assert.equal(selected.power_generators, 2, 'should upgrade to 2 automatic generators so physical schedule + light workshops fit on E-mode');
    assert.ok(selected.power_used > 1500 && selected.power_used <= selected.power_generated + 1e-6);
    for (const item of ['coconut_oil','pearl_powder','agave_fiber','sisal_plush_mat','magic_pumpkin_lantern']) {
        const rows=selected.coin_items.filter(r=>r.status==='producing'&&r.item_name===item);
        assert.ok(rows.length && rows.every(r=>r.electric_level!=null), `${item} should stay electrified instead of falling back to manual`);
    }
    const {shortlistPowerTeams}=await import('../web/power-team-search.js');
    const families=await shortlistPowerTeams(pkg,highs,selected,input);
    assert.ok(families.length>0, 'shortlistPowerTeams must validate candidates on switched level_up plans with slowed perfumers');
});
