import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveWithIncumbent} from '../web/highs-solve.js';
import {tryPriorityPlan} from '../web/continuous-priority-plan.js';

test('fast priority plan checks the occupied recipe and returns the actual shift',async()=>{
    const highs=await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),
        print(){},printErr(){}});
    const model={variables:2,variable_keys:['rate:crop#0','units:crop#0'],primary_objective:[[0,1]],tiebreak:[],
        integer_groups:[['crop',[[1,1]],1]],recipe_options:[[0,'crop','Farm',false,false,4]],recipe_variables:[[0,'crop'],[1,'crop']],
        lp:'Maximize\n obj: + 1 x0\nSubject To\n capacity: + 4 x0 - 1 x1 <= 0\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x1\nEnd'};
    const pkg={exact_priority_problem:()=>JSON.stringify(model),exact_problem:()=>JSON.stringify(model),
        exact_plan:(input,_stage,result)=>{
            assert.deepEqual(JSON.parse(input).always_running_recipes,['crop']);
            const report=JSON.parse(result);
            assert.equal(report.verify_only,true);
            assert.deepEqual(report.values,[.25,1]);
            return JSON.stringify({success:true,rate_per_second:report.values[0]});
        }};
    const solveModel=(p,options,_,seed)=>{
        const r=solveWithIncumbent(highs,p,options,seed,false);
        return r.Columns?{values:p.variable_keys.map((_key,i)=>r.Columns['x'+i].Primal),objective:r.ObjectiveValue,
            proven:r.Status==='Optimal',upper:r.UpperBound}:null;
    };
    const input={currency:'coins',priorities:['coins'],always_running:true,roster:{dispatch:{work:[1]}}};
    const plan=await tryPriorityPlan(pkg,input,{highs,solveModel});
    assert.equal(plan.rate_per_second,.25);
    assert.deepEqual(plan.continuous_upper_bounds,[['["coins",{"floors":[]}]',.25]]);
    assert.deepEqual(plan.continuous_site_counts,{crop:1});
});
