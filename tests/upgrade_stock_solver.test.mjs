import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {FACILITIES} from '../web/facility-config.js';
import highsModule from '../web/vendor/highs/highs.mjs';

const wasmPath=new URL('../web/pkg/aniimax_bg.wasm',import.meta.url);
test('quest raw stock enables processing but does not instantly satisfy finished upgrade materials',
    {skip:!fs.existsSync(wasmPath)},async()=>{
    const pkg=await import('../web/pkg/aniimax.js');
    pkg.initSync({module:fs.readFileSync(wasmPath)});
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const facilities=Object.fromEntries(FACILITIES.map(f=>[f.name,[{count:0,level:1}]]));
    facilities['Woodworking Bench']=[{count:1,level:1}];
    facilities['Chimney Kiln']=[{count:1,level:1}];
    const solve=stock=>{
        const p=JSON.parse(pkg.exact_level_up_problem(JSON.stringify({facilities,
            level_up:{cost:[['rough_lumber',1],['coarse_sifted_ore',1]],stock}})));
        return {p,r:highs.solve(p.lp)};
    };
    assert.equal(solve([]).r.ObjectiveValue,0,'without stock or gathering no upgrade materials can be made');
    const {p,r}=solve([['wood_block',8],['mineral_sand',8]]);
    assert.equal(r.Status,'Optimal');
    assert.ok(Math.abs(86400/r.ObjectiveValue-34)<1e-6,'both processors must spend 34 seconds working');
    for(const item of ['rough_lumber','coarse_sifted_ore']){
        const index=p.variable_keys.indexOf(`rate:${item}#0`);
        assert.ok(index>=0&&r.Columns[`x${index}`].Primal>0,'the plan includes the processing recipe');
    }
});
