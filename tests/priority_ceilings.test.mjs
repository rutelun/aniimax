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

test('a measured material trial survives if either scheduling method can run it',()=>{
    const facility='Woodworking Bench';
    const trial={always_running:true,recipe_switching_normal_only:true,recipe_switching_facilities:[facility],
        facilities:{[facility]:[{count:4,level:1}]},e_mode_rv:12,
        roster:{dispatch:{'Woodworking Bench|rough_lumber|Production':[{member:0,share:1,travel_seconds:0}]}}};
    function model(a,b){
        return {exact_priority_problem:()=>JSON.stringify({variables:2,
            variable_keys:['rate:rough_lumber__byowned:0#0','rate:rough_lumber__byowned:1#0'],
            recipe_options:[[0,'rough_lumber',facility,false,false,1],[1,'rough_lumber',facility,false,false,1]],
            switching_rates:[[0,null],[1,null]],
            lp:['Maximize',' obj: x0','Subject To',' work_a: x0 = '+a,' work_b: x1 = '+b,
                'Bounds',' x0 >= 0',' x1 >= 0','End'].join('\n')})};
    }
    assert.equal(canFillSwitchingWorkshop(model(.75,.75),highs,trial),false);
    const splitCrew={...trial,roster:{...trial.roster,members:[{count:1},{count:1}]}};
    assert.equal(canFillSwitchingWorkshop(model(1,.5),highs,splitCrew),true,
        'one operator runs the steady raw site while another operates the temporary one');
    assert.equal(canFillSwitchingWorkshop(model(1.5,0),highs,splitCrew),false,
        'one operator cannot run both simultaneous sites');
    assert.equal(canFillSwitchingWorkshop(model(.75,.25),highs,trial),true,'whole-site phases can share a recipe');
    assert.equal(canFillSwitchingWorkshop(model(1.5,0),highs,trial),true,'direct material flow may use a partial site-day');
    assert.equal(canFillSwitchingWorkshop(model(1.5,8e-8),highs,trial),true,'unreported trace rates do not require a second job');
});

test('whole-site bounds permit different change times for bench and kiln',()=>{
    const facilities=['Woodworking Bench','Chimney Kiln'];
    const trial={always_running:true,recipe_switching_facilities:facilities,
        facilities:Object.fromEntries(facilities.map(f=>[f,[{count:1,level:3}]]))};
    function model(second){
        const loads=[.2,.8,second,1-second];
        return {exact_priority_problem:()=>JSON.stringify({variables:4,
            variable_keys:loads.map((_,v)=>'rate:recipe'+v+'#0'),
            switching_rates:loads.map((_,v)=>[v,null]),
            recipe_options:loads.map((_,v)=>[v,'recipe'+v,facilities[Math.floor(v/2)],false,false,1]),
            lp:['Maximize',' obj: x0','Subject To',...loads.map((x,v)=>' work'+v+': x'+v+' = '+x),
                'Bounds',...loads.map((_,v)=>' x'+v+' >= 0'),'End'].join('\n')})};
    }
    assert.equal(canFillSwitchingWorkshop(model(.4),highs,trial),true);
    facilities[1]=facilities[0];
    assert.equal(canFillSwitchingWorkshop(model(.4),highs,trial),false);
    assert.equal(canFillSwitchingWorkshop(model(.8),highs,trial),true);
});

test('income-first switching retains schedules within the first priority tolerance',()=>{
    const trial={always_running:true,priorities:['coins'],recipe_switching_facilities:['Kiln']};
    const baseline={success:true,priorities:[{target:'coins',per_second:10}]};
    const pkg={exact_priority_problem:(_input,stage)=>{
        const [[currency,floor]]=JSON.parse(stage).floors;
        assert.equal(currency,'coins');
        assert.ok(floor<9.9999 && floor>9.999);
        return JSON.stringify({lp:''});
    }};
    assert.equal(canFillSwitchingWorkshop(pkg,highs,trial,baseline),true);
});

test('a switch may earn less when its crop variety beats the ordinary plan',()=>{
    const trial={always_running:true,season:'test',priorities:['coins'],recipe_switching_facilities:['Kiln']};
    const base={success:true,comparison_scores:{crop_variety:2},priorities:[{target:'coins',per_second:10}]};
    for (const ceiling of [2,3]) {
        const pkg={
            exact_crop_variety_problem:()=>JSON.stringify({lp:'Maximize\n obj: x0\nSubject To\n crop: x0 <= '+ceiling+'\nBounds\n x0 >= 0\nEnd'}),
            exact_priority_problem:(_input,stage)=>{
                const data=JSON.parse(stage);
                assert.equal(data.crop_variety,2);
                assert.equal(data.floors.length,ceiling===2?1:0);
                return JSON.stringify({lp:''});
            }
        };
        assert.ok(canFillSwitchingWorkshop(pkg,highs,trial,base));
    }
});

test('direct raw processors in two chains can use independent change times',()=>{
    const facilities=['Woodworking Bench','Chimney Kiln'];
    const trial={always_running:true,recipe_switching_normal_only:true,e_mode_rv:21,
        recipe_switching_facilities:facilities,facilities:Object.fromEntries(facilities.map(f=>[f,[{count:4,level:4}]]))};
    const model=second=>({exact_priority_problem:()=>JSON.stringify({variables:2,
        variable_keys:['rate:rough_lumber#0','rate:coarse_sifted_ore#0'],
        recipe_options:[[0,'rough_lumber',facilities[0],false,false,1],[1,'coarse_sifted_ore',facilities[1],false,false,1]],
        switching_rates:[[0,null],[1,null]],
        lp:'Maximize\n obj: x0\nSubject To\n bench: x0 = 1.25\n kiln: x1 = '+second+'\nBounds\n x0 >= 0\n x1 >= 0\nEnd'})});
    assert.equal(canFillSwitchingWorkshop(model(1.5),highs,trial),true);
    assert.equal(canFillSwitchingWorkshop(model(2.1),highs,trial),false);
    assert.equal(canFillSwitchingWorkshop(model(1.25),highs,trial),true);
    assert.equal(canFillSwitchingWorkshop(model(0),highs,trial),true);
});

test('raw operators must cover simultaneous starts in both workshops',()=>{
    const facilities=['Woodworking Bench','Chimney Kiln'], names=['rough_lumber','coarse_sifted_ore'];
    const trial={always_running:true,recipe_switching_normal_only:true,recipe_switching_facilities:facilities,
        facilities:Object.fromEntries(facilities.map(f=>[f,[{count:4,level:4}]]))};
    const pkg={exact_priority_problem:()=>JSON.stringify({variables:2,
        variable_keys:names.map(n=>'rate:'+n+'__byowned:0#0'),
        recipe_options:names.map((n,v)=>[v,n,facilities[v],false,false,1]),switching_rates:[[0,null],[1,null]],
        lp:'Maximize\n obj: x0\nSubject To\n bench: x0 = 1.25\n kiln: x1 = 1.5\nBounds\n x0 >= 0\n x1 >= 0\nEnd'})};
    const possible=count=>canFillSwitchingWorkshop(pkg,highs,{...trial,roster:{members:[{count}]}});
    assert.equal(possible(3),false);
    assert.equal(possible(4),true);
});

test('the same raw crew pays both workshops’ measured walking time at dawn',()=>{
    const facilities=['Woodworking Bench','Chimney Kiln'], names=['rough_lumber','coarse_sifted_ore'];
    const trial={always_running:true,recipe_switching_normal_only:true,recipe_switching_facilities:facilities,
        facilities:Object.fromEntries(facilities.map(f=>[f,[{count:4,level:4}]]))};
    const keys=[...names.map(n=>'rate:'+n+'__byowned:0#0'),...names.map(n=>'route:'+n+'__byowned:0:owned:0:None:true#0')];
    const pkg={exact_priority_problem:()=>JSON.stringify({variables:4,variable_keys:keys,
        recipe_options:names.map((n,v)=>[v,n,facilities[v],false,false,1]),switching_rates:[[0,null],[1,null]],
        staffing_pools:[{work:[[2,1.2],[3,1.2]]}],
        lp:'Maximize\n obj: x0\nSubject To\n bench: x0 = 1.25\n kiln: x1 = 1.5\nBounds\n x0 >= 0\n x1 >= 0\n x2 >= 0\n x3 >= 0\nEnd'})};
    const possible=count=>canFillSwitchingWorkshop(pkg,highs,{...trial,roster:{members:[{count}]}});
    assert.equal(possible(4),false);
    assert.equal(possible(5),true);
});

test('a whole-site recipe can cover its mandatory walk by sharing work with another operator',()=>{
    const facility='Woodworking Bench',name='standard_planks',keys=[
        'rate:'+name+'__byowned:0#0','rate:'+name+'__byowned:1#0','route:'+name+'__byowned:0:owned:0:None:true#0'];
    const trial={always_running:true,recipe_switching_facilities:[facility],facilities:{[facility]:[{count:1,level:2}]},
        roster:{members:[{count:1},{count:1}]}};
    const possible=(a,b)=>canFillSwitchingWorkshop({exact_priority_problem:()=>JSON.stringify({variables:3,
        variable_keys:keys,recipe_options:[0,1].map(v=>[v,name,facility,false,false,1]),switching_rates:[[0,null],[1,null]],
        staffing_pools:[{work:[[2,1.2]]}],lp:'Maximize\n obj: x0\nSubject To\n a: x0 = '+a+'\n b: x1 = '+b+
            '\nBounds\n x0 >= 0\n x1 >= 0\n x2 >= 0\nEnd'})},highs,trial);
    assert.equal(possible(1,0),false);
    assert.equal(possible(.5,.5),true);
});

test('a raw site can switch only to a tier that can work through its accumulated input',()=>{
    const facility='Woodworking Bench', names=['rough_lumber','standard_planks','laminated_beams','densified_timber_component'];
    const trial={always_running:true,recipe_switching_normal_only:true,recipe_switching_facilities:[facility],
        facilities:{[facility]:[{count:4,level:4}]},roster:{members:[{count:2},{count:1}]}};
    const keys=names.map((n,i)=>'rate:'+n+'__byowned:'+(i?1:0)+'#0');
    for(const n of names.slice(1))keys.push('route:'+n+'__byowned:1:owned:1:None:true#0');
    const possible=lastCycle=>canFillSwitchingWorkshop({exact_priority_problem:()=>JSON.stringify({variables:7,
        variable_keys:keys,recipe_options:names.map((n,i)=>[i,n,facility,false,false,1]),switching_rates:names.map((_,i)=>[i,null]),
        staffing_pools:[{}, {work:[[4,1.2],[5,1.2],[6,lastCycle]]}],
        lp:'Maximize\n obj: x0\nSubject To\n'+[1.5,.2,.05,.01].map((v,i)=>' c'+i+': x'+i+' = '+v).join('\n')+
            '\nBounds\n'+keys.map((_,i)=>' x'+i+' >= 0').join('\n')+'\nEnd'})},highs,trial);
    assert.equal(possible(1.2),false);
    assert.equal(possible(1),true);
});

test('disjoint short-phase workloads reject a workshop before integer search',()=>{
    const facility='Chimney Kiln',trial={always_running:true,facilities:{[facility]:[{count:2,level:4}]}};
    const loads=[.19,.01,.8],names=['brick','plate','ore'];
    const problem={variables:3,variable_keys:names.map(n=>'rate:'+n+'#0'),
        recipe_options:names.map((n,v)=>[v,n,facility,false,false,1]),switching_rates:names.map((_,v)=>[v,null]),
        lp:['Maximize',' obj: x0','Subject To',...loads.map((n,v)=>' recipe'+v+': x'+v+' = '+n),
            'Bounds',...loads.map((_,v)=>' x'+v+' >= 0'),'End'].join('\n')};
    const observed={constants:highs.constants,createModel(settings){
        assert.ok(!settings.data.includes('\nGeneral\n'),'unnecessary integer search');
        return highs.createModel(settings);
    }};
    assert.equal(canFillSwitchingWorkshop({exact_priority_problem:()=>JSON.stringify(problem)},observed,trial),false);
});

test('a repeating direct ore schedule must process yesterday’s replenished intermediate stock',()=>{
    const facility='Chimney Kiln', names=['coarse_sifted_ore','sintered_ore_brick'];
    const config={always_running:true,recipe_switching_normal_only:true,facilities:{[facility]:[{count:4,level:4}]}};
    const items=[{name:names[0],yield_amount:1},{name:names[1],raw_materials:[names[0]],required_amount:[8]}];
    const model=rate=>({get_all_items:()=>JSON.stringify(items),exact_priority_problem:()=>JSON.stringify({
        variables:2,variable_keys:names.map(n=>'rate:'+n+'#0'),
        recipe_options:names.map((n,v)=>[v,n,facility,false,false,1]),switching_rates:[[0,null],[1,null]],
        lp:'Maximize\n obj: x0\nSubject To\n raw: x0 = 1.5\n brick: x1 = '+rate+'\nBounds\n x0 >= 0\n x1 >= 0\nEnd',
    })});
    assert.equal(canFillSwitchingWorkshop(model(1.5/8),highs,config),true);
    assert.equal(canFillSwitchingWorkshop(model(1.46/8),highs,config),false);
    assert.equal(canFillSwitchingWorkshop(model(.5),highs,config),true,'whole sites can switch even with surplus');
});

test('a locked upgrade pace reserves distinct sites without counting the same material twice',async()=>{
    const {requiredSiteCapacity,applyRequiredSites}=await import('../web/priority-ceilings.js');
    const problem={variables:7,variable_keys:['rate:ore','units:ore','rate:plate','units:plate',
        'rate:spare','units:spare','pace#0'],
        recipe_options:[[0,'ore'],[2,'plate'],[4,'spare']],
        recipe_variables:[[0,'ore'],[1,'ore'],[2,'plate'],[3,'plate'],[4,'spare'],[5,'spare']],
        lp:['Maximize',' obj: x4','Subject To',' raw: x0 - x1 <= 0',' finish: x2 - x3 <= 0',
            ' spare: x4 - x5 <= 0',' ore_balance: x0 - x2 >= 0',' upgrade: x2 - x6 >= 0',
            ' duplicate: x2 - x6 >= 0',' kilns: x1 + x3 + x5 <= 2','Bounds',
            ...[0,2,4].map(v=>' x'+v+' >= 0'),...[1,3,5].map(v=>' 0 <= x'+v+' <= 2'),
            ' 1 <= x6 <= 1','General',' x1',' x3',' x5','End'].join('\n')};
    const capacity=requiredSiteCapacity(problem);
    assert.deepEqual(capacity.limits,{ore:1,plate:1,spare:0});
    assert.equal(highs.solve(applyRequiredSites(problem,capacity).lp).ObjectiveValue,highs.solve(problem.lp).ObjectiveValue);
    assert.equal(requiredSiteCapacity({...problem,lp:problem.lp.replace('1 <= x6','0 <= x6')}),undefined);
});

test('a shared output can be supplied by either workshop and keeps both options when columns move',async()=>{
    const {requiredSiteCapacity,applyRequiredSites}=await import('../web/priority-ceilings.js');
    const keys=['rate:ore#a','units:ore#a','rate:ore#b','units:ore#b','rate:plate','units:plate','pace#0'];
    const p={variables:keys.length,variable_keys:keys,recipe_options:[[0,'ore'],[2,'ore'],[4,'plate']],
        recipe_variables:[[0,'ore'],[1,'ore'],[2,'ore'],[3,'ore'],[4,'plate'],[5,'plate']],
        lp:['Maximize',' obj: x0','Subject To',' a: x0 - x1 <= 0',' b: x2 - x3 <= 0',' c: x4 - x5 <= 0',
            ' balance: x0 + x2 - x4 >= 0',' target: x4 - x6 >= 0',' cap: x1 + x3 + x5 <= 2',
            'Bounds',...[0,2,4].map(v=>' x'+v+' >= 0'),...[1,3,5].map(v=>' 0 <= x'+v+' <= 2'),
            ' 1 <= x6 <= 1','General',' x1',' x3',' x5','End'].join('\n')};
    const capacity=requiredSiteCapacity(p);
    assert.deepEqual(capacity.limits,{ore:1,plate:1});
    const reordered={...p,variable_keys:keys.toReversed()};
    assert.match(applyRequiredSites(reordered,capacity).lp,/reserved_recipe_\d+: x5 \+ x3 = 1/);
    const partial={...p,variable_keys:keys.map(k=>k==='units:ore#b'?'different':k)};
    assert.doesNotMatch(applyRequiredSites(partial,capacity).lp,/reserved_recipe_\d+: x1 = 1/);
});
