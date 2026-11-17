import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
const wasmPath=new URL('../web/pkg/aniimax_bg.wasm',import.meta.url);

test('climate posts release faster producers while preserving batches and walking',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const pkg=await import('../web/pkg/aniimax.js');pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    for(const movement of [0,20]){
        const input={currency:'coins',aniimo:'roster',quest_income_per_day:{mineral_sand:800},level_up:{cost:[['coarse_sifted_ore',100]],stock:[]},
            fixed_homeland:{groups:[{facility:'Chimney Kiln',count:1,level:1,lit:false,powered:false}],climate:{'Heat Furnace':1},generators:0},
            roster:{members:[{count:1,abilities:{Fire:4},personalities:[]},{count:1,abilities:{Fire:2},personalities:[]}],
                environment:{'Heat Furnace':'Fire'},residents:[],personalities:{},movement_seconds:movement}};
        const payload=JSON.stringify(input),problem=JSON.parse(pkg.exact_level_up_problem(payload));
        const staff=problem.variable_keys.findIndex(key=>key==='staff:Heat Furnace:owned:0#0');
        assert.ok(staff>=0);
        const mobile=problem.variable_keys.flatMap((key,i)=>key.startsWith('post:')?[` mobile_${i}: x${i} = 0`]:[]).join('\n');
        const forced=problem.lp.replace('Subject To',`Subject To\n force_climate: x${staff} = 1\n${mobile}`);
        const solved=highs.solve(forced);
        assert.equal(solved.Status,'Optimal');
        const values=Array.from({length:problem.variables},(_,i)=>solved.Columns[`x${i}`]?.Primal??0);
        const report=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:solved.ObjectiveValue}),JSON.stringify({values,proven:true,bound:solved.ObjectiveValue})));
        assert.equal(report.success,true,report.error);
        assert.ok(report.staffing.some(([building,id])=>building==='Heat Furnace'&&id===1));
        const production=report.coin_items.filter(row=>row.status==='producing');
        assert.ok(production.length>0);
        assert.ok(production.every(row=>row.crew===0));
        assert.ok(Math.abs(production.reduce((sum,row)=>sum+row.busy_units/row.cycle_time,0)-100/86400)<1e-6);
        assert.ok(report.roster_workload.every(load=>load<=1+1e-6));
        if(movement>0)assert.ok(report.movement_staffing.some(([id,time])=>id===0&&time>0));
    }
});

test('a third artisan can free a cooling worker; unavailable capacity cannot',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const pkg=await import('../web/pkg/aniimax.js');pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    for(const spare of [0,1]){
        const input={currency:'coins',aniimo:'roster',quest_income_per_day:{wood_block:800},level_up:{cost:[['rough_lumber',100]],stock:[]},
            fixed_homeland:{groups:[{facility:'Woodworking Bench',count:1,level:1,lit:false,powered:false}],climate:{'Cooling Unit':2},generators:0},
            roster:{members:[{count:1,abilities:{Ice:4},personalities:[]},{count:2,abilities:{Ice:3,Artisanship:3},personalities:[]},
                {count:spare,abilities:{Artisanship:4},personalities:[]}],environment:{'Cooling Unit':'Ice'},residents:[],personalities:{},movement_seconds:20}};
        const payload=JSON.stringify(input),problem=JSON.parse(pkg.exact_level_up_problem(payload));
        const restrictions=problem.variable_keys.flatMap((key,i)=>{
            if(key.startsWith('post:'))return [` no_post_${i}: x${i} = 0`];
            if(/^staff:Cooling Unit:owned:[01]#0$/.test(key))return [` climate_${i}: x${i} = 1`];
            if(key.startsWith('rate:rough_lumber')&&!key.includes('owned:1#'))return [` producer_${i}: x${i} = 0`];
            return [];
        });
        const solved=highs.solve(problem.lp.replace('Subject To','Subject To\n'+restrictions.join('\n')));
        assert.equal(solved.Status,'Optimal');
        const values=Array.from({length:problem.variables},(_,i)=>solved.Columns[`x${i}`]?.Primal??0);
        const report=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:solved.ObjectiveValue}),JSON.stringify({values,proven:true,bound:solved.ObjectiveValue})));
        assert.equal(report.success,true,report.error);
        const producing=report.coin_items.find(row=>row.status==='producing');
        assert.equal(producing.crew,spare?2:1);
        assert.equal(report.staffing.find(([b,id])=>b==='Cooling Unit'&&id===1)?.[2],spare?2:1);
        assert.ok(Math.abs(producing.busy_units/producing.cycle_time-100/86400)<1e-6);
    }
});




test('measured dispatch follows an accepted climate swap instead of locking the slower producer',
 {skip:!fs.existsSync(wasmPath)},async()=>{
 const pkg=await import('../web/pkg/aniimax.js');pkg.initSync({module:fs.readFileSync(wasmPath)});
 const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
 const key='Chimney Kiln|coarse_sifted_ore|Production';
 const input={currency:'coins',aniimo:'roster',quest_income_per_day:{mineral_sand:800},level_up:{cost:[['coarse_sifted_ore',100]],stock:[]},
 fixed_homeland:{groups:[{facility:'Chimney Kiln',count:1,level:1,lit:false,powered:false}],climate:{'Heat Furnace':1},generators:0},
 roster:{members:[{count:1,abilities:{Fire:4}},{count:1,abilities:{Fire:2}}],environment:{'Heat Furnace':'Fire'},residents:[],movement_seconds:0,
 dispatch:{[key]:[{member:1,share:1,travel_seconds:3}]}}};
 const payload=JSON.stringify(input),p=JSON.parse(pkg.exact_level_up_problem(payload)),s=highs.solve(p.lp);
 assert.equal(s.Status,'Optimal');
 const values=Array.from({length:p.variables},(_,i)=>s.Columns[`x${i}`]?.Primal??0);
 const r=JSON.parse(pkg.exact_plan(payload,JSON.stringify({pace:s.ObjectiveValue}),JSON.stringify({values,proven:true,bound:s.ObjectiveValue})));
 assert.equal(r.success,true,r.error);
 assert.deepEqual(r.staffing,[['Heat Furnace',1,1]]);
 assert.equal(r.roster_routes[0].member,0);
 assert.equal(r.roster_dispatch[key][0].member,0);
 assert.equal(r.roster_dispatch[key][0].share,1);
 assert.ok(r.roster_workload[0]<0.02);
 assert.equal(r.level_up.seconds,86400);
});
