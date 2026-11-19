import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {priorityCeiling} from '../web/priority-ceilings.js';

const highs = await highsModule({
    wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}
});

// The first recipe takes ten seconds per unit and the finishing step takes
// one. Their two stations can produce at most one finished unit per ten seconds.
function chain({pooled=false, stock=false, alternative=false, available=2}={}) {
    const keys = ['pace#0','rate:raw#0','rate:finished#0','units:raw#0','units:finished#0'];
    const sites = pooled ? [5,6] : [3,4];
    const rows = [
        ' input_capacity: 10 x1 - x3 <= 0',
        ' finish_capacity: x2 - x4 <= 0',
        ' finish: x2 - x0 >= 0',
        ' material: x1 - x2 >= '+(stock ? '-1' : '0')
    ];
    if (pooled) {
        keys.push('continuous_site:mill|raw#0','continuous_site:mill|finished#0');
        rows.push(' raw_pool: x3 - x5 <= 0',' finish_pool: x4 - x6 <= 0');
    }
    rows.push(' shared: x'+sites[0]+' + x'+sites[1]+' <= '+available);
    if (alternative) {
        // A second producer contributes without using a mill. A fractional
        // raw mill must never be rounded up if this route supplies the input.
        rows[3] = ' material: x1 + x'+keys.length+' - x2 >= 0';
        rows.push(' other_supply: x'+keys.length+' <= 2');
        keys.push('rate:import#0');
    }
    return {variables:keys.length,variable_keys:keys,production_only:true,
        recipe_options:keys.flatMap((k,v)=>k.startsWith('rate:')?[[v,k]]:[]),
        lp:['Maximize',' obj: x0','Subject To',...rows,'Bounds',...keys.map((_,v)=>' x'+v+' >= 0'),
            'General',...sites.map(v=>' x'+v),'End'].join('\n')};
}

test('a positive upgrade pace reserves a whole site at every unstocked processing step',()=>{
    for (const pooled of [false,true]) {
        const p = chain({pooled});
        assert.equal(priorityCeiling(highs,p,'level_up'),0.1);
        assert.equal(highs.solve(p.lp).ObjectiveValue,0.1);
    }
});

test('stock and alternative producers do not force the ordinary material recipe',()=>{
    for (const options of [{stock:true},{alternative:true}]) {
        const p = chain(options);
        const upper = priorityCeiling(highs,p,'level_up');
        assert.ok(upper>=highs.solve(p.lp).ObjectiveValue-1e-9);
        assert.ok(upper>=1);
    }
});

test('no positive upgrade pace is possible when the chain exceeds the available sites',()=>{
    const p = chain({available:1});
    assert.equal(highs.solve(p.lp).ObjectiveValue,0);
    assert.equal(priorityCeiling(highs,p,'level_up'),0);
});

test('the variety score is integral when the crop relaxation is fractional',()=>{
    const p={lp:'Maximize\n obj: x0 + x1\nSubject To\n space: 2 x0 + 2 x1 <= 3\nBounds\n 0 <= x0 <= 1\n 0 <= x1 <= 1\nGeneral\n x0\n x1\nEnd'};
    assert.equal(priorityCeiling(highs,p,'crop_variety'),1);
});

test('ordinary priority ceilings relax all integer decisions and keep preceding constraints',()=>{
    const p = chain({available:3});
    p.lp = p.lp.replace(' obj: x0',' obj: x2').replace('Bounds',' prev: x0 >= 0.1\nBounds');
    const upper = priorityCeiling(highs,p,'aniipods');
    assert.ok(Math.abs(upper-3/11)<1e-9);
    assert.equal(priorityCeiling(highs,{...p,production_only:false},'aniipods'),null);
    assert.equal(priorityCeiling(highs,{lp:''},'crop_variety'),null);
});
