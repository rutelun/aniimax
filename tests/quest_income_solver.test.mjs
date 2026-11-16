import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FACILITIES} from '../web/facility-config.js';
import highsModule from '../web/vendor/highs/highs.mjs';
const wasmPath=new URL('../web/pkg/aniimax_bg.wasm',import.meta.url);
test('daily quest resources support repeat processing, obey time and building limits, and pass independent checking',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const pkg=await import('../web/pkg/aniimax.js');pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const facilities=Object.fromEntries(FACILITIES.map(f=>[f.name,[{count:0,level:1}]]));
    facilities['Woodworking Bench']=[{count:1,level:1}];facilities['Chimney Kiln']=[{count:1,level:1}];
    const solve=(amount,income=8)=>{
        const input={facilities,quest_income_per_day:{wood_block:income,mineral_sand:income},
            level_up:{cost:[['rough_lumber',amount],['coarse_sifted_ore',amount]],stock:[]}};
        const p=JSON.parse(pkg.exact_level_up_problem(JSON.stringify(input))),r=highs.solve(p.lp);
        return {input,p,r,seconds:86400/r.ObjectiveValue};
    };
    const first=solve(1);
    assert.ok(Math.abs(first.seconds-86400)<1e-3,'8 raw items per day yield one processed item per day');
    assert.ok(Math.abs(solve(2).seconds-172800)<1e-3,'twice the target takes two days, not a one-off stock subtraction');
    assert.ok(Math.abs(solve(1,86400).seconds-34)<1e-6,'abundant income still needs processing time');
    const values=Array.from({length:first.p.variables},(_,i)=>first.r.Columns[`x${i}`]?.Primal??0);
    const report=JSON.parse(pkg.exact_plan(JSON.stringify(first.input),JSON.stringify({pace:first.r.ObjectiveValue}),
        JSON.stringify({bound:0,values,proven:true})));
    assert.equal(report.success,true,report.error);
    const rawInput={facilities,quest_income_per_day:{wood_block:8},
        level_up_preview:{cost:[['wood_block',1]],stock:[]}};
    const raw=JSON.parse(pkg.exact_problem(JSON.stringify(rawInput),JSON.stringify({maximize_upgrade_materials:true})));
    assert.ok(Math.abs(highs.solve(raw.lp).ObjectiveValue-8)<1e-6,
        'secondary upgrade-material objective includes recurring raw income');
});
