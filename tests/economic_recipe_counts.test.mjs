import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {economicRecipeCounts,economicCountNeighborhood,priceIdleWorkshop} from '../web/economic-recipe-counts.js';

const highs=await highsModule({
    wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}
});

function sample() {
    const keys=['rate:fruit__byowned:0#0','units:fruit__byowned:0#0',
        'rate:fruit__byowned:1#0','units:fruit__byowned:1#0','sold:fruit#0'];
    return {
        lp:['Maximize',' obj: 5 x4 - 3 x0','Subject To',' a: 2 x0 - x1 <= 0',' b: x2 - x3 <= 0',
            ' trees: x1 + x3 <= 3',' fruits: x0 + x2 - x4 >= 0','Bounds',
            ...keys.map((_,i)=>' x'+i+' >= 0'),'General',' x1',' x3','End'].join('\n'),
        variables:5,variable_keys:keys,production_only:true,primary_objective:[[4,5],[0,-3]],
        recipe_options:[[0,'fruit','Orchard',true,false,2],[2,'fruit','Orchard',true,false,1]],
        recipe_variables:[[0,'fruit'],[1,'fruit'],[2,'fruit'],[3,'fruit']],
        integer_groups:[['fruit',[[1,1],[3,1]],3]]
    };
}

test('whole-site projection bounds the parent when a costly and a free variant are merged',()=>{
    const p=sample();
    const counts=economicRecipeCounts(highs,p);
    assert.equal(counts.get('fruit'),3);
    assert.ok(counts.upper>=highs.solve(p.lp).ObjectiveValue);
    assert.ok(counts.upper<15.00001);
    const local=economicCountNeighborhood(highs,p,counts,14.9);
    assert.equal(highs.solve(local.lp).ObjectiveValue,15);
    assert.equal(local.continuousRestricted,true);
});

test('an advertised worker capacity cannot cut stronger output allowed by the unrestricted model',()=>{
    const p=sample();
    // The worker list suggests a pool of one, while this synthetic full model
    // lets the faster worker staff all three trees. Its native LP bound wins.
    const counts=economicRecipeCounts(highs,p,{input:{roster:{members:[{count:1},{count:1}],residents:[]}}});
    assert.ok(counts.upper>=15);
    assert.equal(counts.get('fruit'),3);
});

test('whole recipe totals can price fractional variants while the executable plan requires whole sites',()=>{
    const p=sample();
    p.recipe_options[1][4]=true;
    p.lp=p.lp.replace('5 x4 - 3 x0','5 x4').replace('Bounds',
        ' normal: x1 <= 1.5\n powered: x3 <= 1.5\nBounds');
    p.primary_objective=[[4,5]];
    const counts=economicRecipeCounts(highs,p);
    assert.equal(counts.get('fruit'),3);
    assert.ok(Math.abs(counts.upper-11.25)<1e-5);
    assert.equal(highs.solve(p.lp).ObjectiveValue,7.5);
    assert.equal(economicCountNeighborhood(highs,p,counts,11.26),null);
});

test('unsupported time-sharing and mismatched native cycle metadata decline the projection',()=>{
    const p=sample();
    assert.equal(economicRecipeCounts(highs,{...p,lp:p.lp.replace(' x1\n x3\nEnd',' x3\nEnd')}),null);
    p.recipe_options[0][5]=4;
    assert.equal(economicRecipeCounts(highs,p),null);
    assert.equal(economicCountNeighborhood(highs,p,new Map([['missing',1]]),1),null);
});

test('a building pattern can earn less than a global ceiling and still supply a feasible plan',()=>{
    const p=sample(), counts=new Map([['fruit',1]]);
    assert.equal(economicCountNeighborhood(highs,p,counts,15),null);
    const local=economicCountNeighborhood(highs,p,counts);
    const result=highs.solve(local.lp);
    assert.equal(result.Status,'Optimal');
    assert.equal(result.ObjectiveValue,5);
    assert.equal(local.localIncomeUpper,5);
    assert.equal(highs.solve(p.lp).ObjectiveValue,15);
    assert.equal(local.continuousRestricted,true);
});

test('dispatch shares reserve a single physical site and retain their weighted cycle time',()=>{
    const p=sample();
    p.variables=6;
    p.variable_keys.push('continuous_site:Orchard|fruit#0');
    p.recipe_variables.push([5,'fruit']);
    p.integer_groups=[];
    p.primary_objective=[[4,1]];
    p.lp=p.lp.replace('5 x4 - 3 x0','x4').replace('x1 + x3 <= 3',
        'x1 + x3 - x5 <= 0\n policy: 0.75 x0 - 0.25 x2 = 0')
        .replace('General\n x1\n x3',' 0 <= x5 <= 1\nGeneral\n x5');
    const counts=economicRecipeCounts(highs,p);
    assert.equal(counts.get('fruit'),1);
    assert.ok(Math.abs(counts.upper-0.8)<1e-5);
    assert.equal(highs.solve(p.lp).ObjectiveValue,0.8);
});

test('a positive objective residual on an unmapped route is bounded by the original LP',()=>{
    const p=sample();
    p.variables++;
    p.variable_keys.push('route:fruit:owned:0#0');
    p.lp=p.lp.replace('5 x4 - 3 x0','5 x4 - 3 x0 + 0.4 x5').replace('Bounds',' travel: x5 <= 2\nBounds');
    p.primary_objective.push([5,0.4]);
    const counts=economicRecipeCounts(highs,p);
    assert.ok(counts.upper>=15.8);
    assert.ok(counts.upper<15.80001);
});

test('a provisional fit can drop both jobs in one workshop while retaining the fruit income floor',()=>{
    const p=sample();
    const keys=['rate:syrup#0','units:syrup#0','rate:juice#0','units:juice#0'];
    p.variable_keys.push(...keys);
    p.variables+=keys.length;
    p.lp=p.lp.replace('Bounds',' staffing: x3 + x6 + x8 <= 3\n syrup: x5 - x6 <= 0\n juice: x7 - x8 <= 0\nBounds')
        .replace('General',' x5 >= 0\n x6 >= 0\n x7 >= 0\n x8 >= 0\nGeneral').replace('\nEnd','\n x6\n x8\nEnd');
    for(const [v,recipe] of [[5,'syrup'],[7,'juice']]){
        p.recipe_options.push([v,recipe,'Keg',false,false,1]);
        p.integer_groups.push([recipe,[[v+1,1]],1]);
        p.recipe_variables.push([v,recipe],[v+1,recipe]);
    }
    const counts=new Map([['fruit',3],['syrup',1],['juice',1]]);
    const fit=priceIdleWorkshop(highs,p,counts,4.9);
    assert.equal(fit.estimatedIncome,15);
    const solution=highs.solve(fit.model.lp);
    assert.equal(solution.ObjectiveValue,15);
    assert.deepEqual([solution.Columns.x6.Primal,solution.Columns.x8.Primal],[0,0]);
    assert.equal(counts.get('syrup'),1);
    assert.equal(priceIdleWorkshop(highs,p,new Map([['fruit',3]]),14.9),null);
});
