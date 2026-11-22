import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {economicRecipeUse, solveEconomicBound, suggestEconomicScope} from '../web/economic-bound.js';

const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm', import.meta.url)),
    print(){}, printErr(){}});

test('unrestricted relaxation returns its bound and a keyed primal for auditing', () => {
    const problem = {
        lp:'Maximize\n obj: x0\nSubject To\n site: 2 x0 - x1 <= 0\n demand: x0 <= 0.25\nBounds\n 0 <= x0 <= 1\n 1 <= x1 <= 1\nGeneral\n x1\nEnd',
        variables:2, production_only:true, primary_objective:[[0,1]], variable_keys:['rate:a#0','units:a#0'],
        recipe_options:[[0,'a','Workshop',false,false,2]],
    };
    const result = solveEconomicBound(highs, problem, {scope:[], timeLimit:1});
    assert.equal(result.upper,.25);
    const exact = solveEconomicBound(highs, problem, {exact:true});
    assert.equal(exact.proven,true);
    assert.equal(exact.upper,result.upper);
    assert.equal(result.objective,.25);
    assert.deepEqual(result.keys,problem.variable_keys);
    assert.deepEqual(result.values,[.25,1]);
    assert.deepEqual(result.throttledRecipes,['a']);
    const discovery = solveEconomicBound(highs,problem,{discovery:true,timeLimit:1});
    assert.equal(discovery.objective,.25);
    assert.equal(discovery.upper,null);
    assert.equal(discovery.proven,false);
    assert.equal(solveEconomicBound(highs,{...problem,continuousRestricted:true}),null);
});

test('dispatch combines workers at one reservation and keeps electric sites separate', () => {
    const problem = {variable_keys:['rate:a__by1#0','rate:a__by2#0','continuous_site:Workshop|a#0',
        'rate:a__electric1#0','units:a__electric1#0','rate:b#0','units:b#0'],
    recipe_options:[[0,'a','Workshop',false,false,2],[1,'a','Workshop',false,false,4],
        [3,'a','Workshop',false,true,3],[5,'b','Oven',false,false,1]]};
    const result = economicRecipeUse(problem,[.25,.125,1,1/3,1,0,1]);
    assert.deepEqual(result.activeRecipes,['a']);
    assert.deepEqual(result.occupiedRecipes,['a','b']);
    assert.deepEqual(result.throttledRecipes,['b']);
});

test('unequal consumer loads identify the competing recipes and their source', () => {
    const problem = {variables:6, variable_keys:['rate:crop#0','units:crop#0','rate:a#0','units:a#0','rate:b#0','units:b#0'],
        recipe_options:[[0,'crop','Garden',false,false,1],[2,'a','Oven',false,false,1],[4,'b','Mill',false,false,1]],
        lp:'Maximize\n obj: x2\nSubject To\n balance: + 1 x0 - 1 x2 - 1 x4 >= 0\nBounds\nEnd'};
    assert.deepEqual(new Set(suggestEconomicScope(problem,[1,1,.25,1,.75,1],['mandatory'])),
        new Set(['mandatory','crop','a','b']));
    assert.deepEqual(suggestEconomicScope(problem,[1,1,.5,1,.5,1]),[]);
    const sellAll={...problem,variables:7,variable_keys:[...problem.variable_keys,'sold:crop#0'],
        lp:problem.lp.replace('x4 >= 0','x4 - 1 x6 = 0')};
    assert.deepEqual(new Set(suggestEconomicScope(sellAll,[1,1,.25,1,.75,1,0])),new Set(['crop','a','b']));
});

test('a search stopping within the relative gap keeps its certified upper bound', () => {
    const problem={production_only:true,variables:1,variable_keys:['rate:crop#0'],
        primary_objective:[[0,1]],lp:'Maximize\n obj: x0\nEnd',
        recipe_options:[[0,'crop','Farmland',true,false,1]]};
    const native={getDimensions:()=>({numCols:1}),getColName:()=>'x0',options:{set(){}},run(){},
        getModelStatus:()=>7,getObjectiveValue:()=>10,getSolution:()=>({colValue:[10]}),dispose(){},
        info:{get:name=>({mip_dual_bound:10.01,primal_solution_status:2,mip_gap:.001})[name]}};
    const runtime={constants:{modelStatus:{optimal:7},solutionStatus:{feasible:2}},createModel:()=>native};
    const result=solveEconomicBound(runtime,problem,{exact:true,relativeGap:.002});
    assert.equal(result.objective,10);
    assert.equal(result.upper,10.01);
    assert.equal(result.proven,false);
});
