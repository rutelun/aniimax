import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import highsModule from '../web/vendor/highs/highs.mjs';
import {priorityCeiling} from '../web/priority-ceilings.js';
import {canFillSwitchingWorkshop} from '../web/recipe-switch-bound.js';

const highs = await highsModule({
    wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}
});

test('switch search requires a full site-day of work in the selected workshops',()=>{
    const trial={always_running:true,recipe_switching_facilities:['Kiln']};
    function model(maxRate) {
        return {exact_priority_problem:()=>JSON.stringify({
            recipe_options:[[0,'ore','Kiln',false,false,2],[1,'wood','Bench',false,false,1]],
            lp:['Maximize',' obj: x1','Subject To',' ore: x0 <= '+maxRate,
                ' wood: x1 <= 20','Bounds',' x0 >= 0',' x1 >= 0','End'].join('\n')
        })};
    }
    assert.equal(canFillSwitchingWorkshop(model(.25),highs,trial),false);
    assert.equal(canFillSwitchingWorkshop(model(.5),highs,trial),true);
    assert.equal(canFillSwitchingWorkshop(model(.49),highs,{...trial,recipe_switching_facilities:['Bench','Kiln']}),true);
    assert.equal(canFillSwitchingWorkshop(model(.25),highs,{...trial,level_up_preview:{stock:[['ore',1]]}}),true);
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

test('wildcard switching needs whole active sites in each fixed power mode at the competing upgrade pace',()=>{
    const trial={always_running:true,recipe_switching_facilities:[],e_mode_rv:12,priorities:['level_up','coins'],
        level_up_preview:{cost:[['ore',1]],stock:[]},facilities:{Kiln:[{count:2,level:2}]}};
    const base={success:true,priorities:[{target:'level_up'}],level_up_preview:{seconds:86400}};
    function model(maxRate, switched=true) {
        return {exact_priority_problem:(_payload,stage)=>{
            const minimum=JSON.parse(stage).pace??0;
            return JSON.stringify({variables:2,variable_keys:['rate:ore#0','rate:ore__electric2#0'],
                recipe_options:[[0,'ore','Kiln',false,false,1],[1,'ore','Kiln',false,true,1]],
                switching_rates:switched?[[0,null],[1,2]]:[],
                lp:['Maximize',' obj: x0','Subject To',' retained: x0 + x1 >= '+minimum,
                    'Bounds',' 0 <= x0 <= '+maxRate,' 0 <= x1 <= 0.7','End'].join('\n')});
        }};
    }
    assert.equal(canFillSwitchingWorkshop(model(.7),highs,trial,base),false);
    assert.equal(canFillSwitchingWorkshop(model(1),highs,trial,base),true);
    assert.equal(canFillSwitchingWorkshop(model(1,false),highs,trial,base),false);
});

test('unstocked material flow can wait for ingredients at downstream sites',()=>{
    const facility='Woodworking Bench';
    const trial={always_running:true,recipe_switching_normal_only:true,recipe_switching_facilities:[facility],
        facilities:{[facility]:[{count:4,level:1}]},e_mode_rv:12};
    const model={exact_priority_problem:()=>JSON.stringify({variables:1,variable_keys:['rate:rough_lumber#0'],
        recipe_options:[[0,'rough_lumber',facility,false,false,1]],switching_rates:[[0,null]],
        lp:'Maximize\n obj: x0\nSubject To\n raw: x0 = 1.5\nBounds\n x0 >= 0\nEnd'})};
    assert.equal(canFillSwitchingWorkshop(model,highs,trial),true);
});

test('feasibility keeps discrete worker posts and a slower upgrade within comparison tolerance',()=>{
    const trial={always_running:true,recipe_switching_facilities:['Kiln'],priorities:['level_up','coins'],
        level_up_preview:{cost:[['ore',1]],stock:[]}};
    const base={success:true,priorities:[{target:'level_up'}],level_up_preview:{seconds:86400}};
    const model=discretePost=>({exact_priority_problem:(_payload,stage)=>{
        const {pace}=JSON.parse(stage);
        assert.ok(pace<1 && pace>0.99);
        return JSON.stringify({variables:3,variable_keys:['rate:ore__byowned:0#0','post:ore__byowned:0:owned:0#0','pace#0'],
            recipe_options:[[0,'ore','Kiln',false,false,1]],switching_rates:[[0,null]],
            lp:['Maximize',' obj: x0','Subject To',' post: x0 - 2 x1 <= 0','Bounds',
                ' 0 <= x0 <= 1',' 0 <= x1 <= 0.6',' '+pace+' <= x2 <= 0.999995',
                ...(discretePost?['General',' x1']:[]),'End'].join('\n')});
    }});
    assert.equal(canFillSwitchingWorkshop(model(false),highs,trial,base),true);
    assert.equal(canFillSwitchingWorkshop(model(true),highs,trial,base),false);
});
