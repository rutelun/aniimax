import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {materialChains} from '../web/material-flow-schedule.js';
import {FACILITIES} from '../web/facility-config.js';
import highsModule from '../web/vendor/highs/highs.mjs';
import {workshopDemand,optimizeWorkshopSources} from '../web/workshop-demand.js';

const bench='Woodworking Bench',kiln='Chimney Kiln';
const [wood,ore]=[materialChains[bench],materialChains[kiln]];
const catalog=new Map();
for(const [facility,names] of Object.entries(materialChains)){
    for(const [i,name] of names.entries()){
        const raw=facility===bench?'wood_block':'mineral_sand';
        catalog.set(name,{name,facility,facility_level:i+1,yield_amount:1,
            raw_materials:[i?names[i-1]:raw],required_amount:[i===3?4:8]});
    }
}
function setup(cost,stock=[]){
    return {currency:'coins',priorities:['level_up'],facilities:{[bench]:[{level:4,count:4}],[kiln]:[{level:4,count:4}]},
        level_up_preview:{cost,stock}};
}
const plan={rate_per_second:10,byproduct_rates:[['Wood Blocks',8,0],['Mineral Sand',8,0]],coin_items:[]};

test('the slower raw stream and coin income cap simultaneous processing',()=>{
    const input=setup([['coins',2000],[wood[0],16],[ore[0],100]]);
    const demand=workshopDemand(input,plan,catalog);
    assert.equal(demand.seconds,200);
    assert.deepEqual(demand.chains.map(c=>c.jobs[0].rate),[.08,.5]);
    const constrained=workshopDemand(input,plan,catalog,{[ore[0]]:.25});
    assert.equal(constrained.seconds,400);
    assert.deepEqual(constrained.chains.map(c=>c.jobs[0].rate),[.04,.25]);
});

test('each stock unit pays either its direct upgrade requirement or a downstream input',()=>{
    const input=setup([[wood[3],1],[wood[1],2],['wood_block',8]],
        [[wood[2],2],[wood[1],10],[wood[0],40],['wood_block',10],['wood_block',6]]);
    // Two beams need 16 planks. Two more planks go into the upgrade itself.
    // After the 10 planks and 40 rough in stock, 24 rough must be made.
    const demand=workshopDemand(input,plan,catalog);
    assert.equal(demand.seconds,23);
    assert.deepEqual(demand.chains[0].jobs.map(j=>j.batches),[24,8,2,1]);
});

test('output yield, quest deliveries and competing background consumption enter the same balance',()=>{
    const dual=new Map(catalog);
    dual.set(wood[0],{...dual.get(wood[0]),yield_amount:2});
    dual.set('custom_furniture',{raw_materials:['wood_block',wood[0]],required_amount:[2,1]});
    const input={...setup([[wood[0],20]]),quest_income_per_day:{wood_block:172800}};
    const draft=workshopDemand(input,{...plan,coin_items:[{status:'producing',item_name:'custom_furniture',
        busy_units:1,cycle_time:1}]},dual);
    // Eight net blocks per second make two rough, one of which is reserved.
    assert.equal(draft.seconds,20);
    assert.equal(draft.chains[0].supply,8);
    assert.equal(draft.chains[0].jobs[0].batches,20);
});

test('a closed tier, a missing non-workshop input, and an absent next upgrade keep the baseline',()=>{
    const input=setup([[wood[1],1]]);
    input.facilities[bench]=[{level:1,count:3}];
    assert.equal(workshopDemand(input,plan,catalog),null);
    assert.equal(workshopDemand(setup([[wood[0],1],['custom',2]]),plan,catalog),null);
    assert.equal(workshopDemand({facilities:input.facilities},plan,catalog),null);
    const stocked=setup([[wood[1],1]],[[wood[0],8]]);
    assert.equal(workshopDemand(stocked,{...plan,byproduct_rates:[]},catalog,{[wood[1]]:.5}).seconds,2);
});

test('a slower feasible pace recomputes batch rates while holding finite stock only once',()=>{
    const input=setup([[wood[1],3]],[[wood[0],4]]);
    const demand=workshopDemand(input,plan,catalog,{},80);
    assert.equal(demand.seconds,80);
    assert.equal(demand.chains[0].jobs[0].rate,.25);
    assert.equal(demand.chains[0].jobs[1].rate,3/80);
});

test('coin costs use actual coin earnings when the reported production currency differs',()=>{
    const input=setup([['coins',200],[wood[0],1],['custom',3]]);
    const otherPlan={...plan,currency:'aniimo_exp',rate_per_second:100,
        level_up:{requirements:[{name:'coins',per_second:2},{name:'custom',per_second:1}]}};
    assert.equal(workshopDemand(input,otherPlan,catalog)?.seconds,100);
    assert.equal(workshopDemand(input,{...otherPlan,level_up:{requirements:[{name:'custom',per_second:1}]}},catalog),null);
});

const wasmPath=new URL('../web/pkg/aniimax_bg.wasm',import.meta.url);
test('the source solve activates idle gathering and shares the same worker across both streams',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const recipes=new Map(JSON.parse(pkg.get_all_items()).map(i=>[i.name,i]));
    const facilities=Object.fromEntries(FACILITIES.map(f=>[f.name,[{level:1,count:0}]]));
    for(const facility of ['Woodland','Mine',bench,kiln])facilities[facility]=[{level:1,count:20}];
    const input={...setup([[wood[0],1],[ore[0],1]]),facilities,aniimo:'roster',
        roster:{members:[{count:1,abilities:{Water:4,Grass:4,Earth:4,Dark:4,Hauling:4}}],movement_seconds:0}};
    const idle={rate_per_second:0,coin_items:[],byproduct_rates:[]};
    const solve=i=>optimizeWorkshopSources(pkg,highs,i,idle,recipes);
    const joint=solve(input);
    assert.ok(joint);
    const demand=workshopDemand(input,joint.plan,recipes);
    assert.ok(demand.chains.every(c=>c.supply>0));
    assert.ok(joint.plan.comparison_seed.keys.some((key,i)=>key.startsWith('rate:rock') && joint.plan.comparison_seed.values[i]>0));
    assert.ok(joint.plan.comparison_seed.keys.length===joint.plan.comparison_seed.values.length);
    assert.ok(joint.plan.active_continuous_recipes.includes('rock'));
    const maxima=[0,1].map(index=>solve({...input,level_up_preview:{cost:[input.level_up_preview.cost[index]],stock:[]}}))
        .map((s,i)=>workshopDemand(input,s.plan,recipes)?.chains[i].supply ??
            s.plan.byproduct_rates.filter(([n])=>n===(i?'Mineral Sand':'Wood Blocks')).reduce((n,[,r])=>n+r,0));
    assert.ok(demand.chains.some((c,i)=>c.supply<maxima[i]-1e-6));
});
