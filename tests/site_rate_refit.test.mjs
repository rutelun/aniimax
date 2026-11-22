import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import highsModule from '../web/vendor/highs/highs.mjs';
import {solveEconomicBound} from '../web/economic-bound.js';
import {searchProductionSites} from '../web/production-site-search.js';

test('the full model can earn the priced recipe rates by changing site modes', async () => {
    const highs = await highsModule({wasmBinary:fs.readFileSync(new URL('../web/vendor/highs/highs.wasm', import.meta.url)),
        print(){}, printErr(){}});
    const raw = {variables:4, production_only:true, variable_keys:['rate:bread#0','units:bread#0','rate:bread__electric#0','units:bread__electric#0'],
        primary_objective:[[0,1],[2,1]], recipe_options:[[0,'bread','Oven',false,false,.5],[2,'bread','Oven',false,true,1]],
        recipe_variables:[[0,'bread'],[1,'bread'],[2,'bread'],[3,'bread']],
        lp:'Maximize\n obj: x0 + x2\nSubject To\n fast: 0.5 x0 - x1 <= 0\n slow: x2 - x3 <= 0\n stock: x0 + x2 <= 1\n ovens: x1 + x3 <= 1\nBounds\n x0 >= 0\n 0 <= x1 <= 1\n x2 >= 0\n 0 <= x3 <= 1\nGeneral\n x1\n x3\nEnd'};
    const full = {...raw, lp:raw.lp.replace('x0 - x1 <= 0','x0 - x1 = 0').replace('x2 - x3 <= 0','x2 - x3 = 0')};
    const proposal = {keys:raw.variable_keys, values:[1,1,0,0], objective:1, upper:1, proven:true,
        activeRecipes:['bread'], occupiedRecipes:['bread']};
    const models = [];
    const solve = (model, options) => {
        models.push(model.lp);
        return model === raw ? proposal : solveEconomicBound(highs, model, options);
    };
    const result = await searchProductionSites(highs,raw,full,() => raw,solve);
    assert.equal(models.length,3);
    assert.equal(result.upper,1);
    assert.equal(result.best.objective,1);
    assert.deepEqual(result.best.values,[0,0,1,1]);
});
