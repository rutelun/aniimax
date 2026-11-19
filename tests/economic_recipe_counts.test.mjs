import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {economicRecipeCounts,economicCountNeighborhood} from '../web/economic-recipe-counts.js';

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

test('unsupported time-sharing and mismatched native cycle metadata decline the projection',()=>{
    const p=sample();
    assert.equal(economicRecipeCounts(highs,{...p,lp:p.lp.replace(' x1\n x3\nEnd',' x3\nEnd')}),null);
    p.recipe_options[0][5]=4;
    assert.equal(economicRecipeCounts(highs,p),null);
    assert.equal(economicCountNeighborhood(highs,p,new Map([['missing',1]]),1),null);
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
