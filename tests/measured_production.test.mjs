import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {measuredProductionShift} from '../web/measured-production.js';

test('measured dispatch keeps the planting pattern, opens new processors and checks their continuous rates',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    // Measured workers can turn at most half the crop into juice. The tentative
    // model allows one whole batch until that previously unused processor is checked.
    const keys=['rate:fruit#0','units:fruit#0','rate:juice#0','continuous_site:Mill|juice#0','sold:fruit#0'];
    const modelFor=scope=>({variables:5, variable_keys:keys, production_only:true,tiebreak:[],
        primary_objective:[[2,5],[4,1]],integer_groups:[['fruit',[[1,1]],2]],
        recipe_options:[[0,'fruit','Farmland',false,false,1],[2,'juice','Mill',false,false,1]],
        recipe_variables:[[0,'fruit'],[1,'fruit'],[2,'juice'],[3,'juice']],
        lp:'Maximize\n obj: + 5 x2 + 1 x4\nSubject To\n grow: x0 - x1 = 0\n use: x0 - x2 - x4 = 0\n mill: x2 - x3 <= 0\n'
          +(new Set(scope).has('juice')?' measured_mill: x2 - 0.5 x3 <= 0\n':'')
          +'Bounds\n 0 <= x0 <= 2\n 0 <= x1 <= 2\n 0 <= x2 <= 1\n 0 <= x3 <= 1\n 0 <= x4 <= 2\nGeneral\n x1\n x3\nEnd\n'});
    const solveModel=async p=>{
        const result=highs.solve(p.lp);
        return result.Status==='Optimal'?{values:keys.map((_,i)=>result.Columns['x'+i]?.Primal??0),objective:result.ObjectiveValue}:null;
    };
    const found=await measuredProductionShift({modelFor,counts:{fruit:1,juice:0},checked:['fruit'],
        seed:{keys,values:[1,1,0,0,1]},highs,solveModel});
    assert.ok(found);
    assert.equal(found.objective,3);
    assert.equal(found.values[1],1);
    assert.equal(found.values[2],0.5);
    assert.ok(found.checked.includes('juice'));
});
