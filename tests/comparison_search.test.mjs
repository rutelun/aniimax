import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createComparisonSearch} from '../web/comparison-search.js';
import {availableRecipes,usefulUpgrade} from '../web/opportunity-comparison.js';

const model={lp:'Maximize\n obj: + 2 x0 - 0.1 x1\nSubject To\n c0: + 1 x0 <= 5\nBounds\n 0 <= x0 <= 5\nGeneral\n x0\nEnd',
    variables:2,primary_objective:[[0,2]],tiebreak:[[1,.1]]};
const baseline={comparison_goals:{crop_variety:10,floors:[['Wood Blocks',10]],pace:2}};

test('certifies matching earlier goals using a proven continuous bound, without the tie-break',async()=>{
    const calls=[];
    const search=createComparisonSearch(baseline,async(p,o)=>{calls.push({p,o});return{objective:10,proven:true,values:[5,0]};});
    search.begin();
    assert.deepEqual(await search.bound(model,'Wood Blocks'),{objective:10,proven:true});
    assert.ok(!calls[0].p.lp.includes('General'));
    assert.ok(!calls[0].p.lp.includes('0.1 x1'));
    assert.deepEqual(calls[0].p.tiebreak,[]);
    assert.equal(search.stats.bounded,1);
});

test('a loose, worse, unknown or unproven bound never replaces a priority solve',async()=>{
    for(const [objective,proven] of [[11,true],[9,true],[10,false]]){
        const search=createComparisonSearch(baseline,async()=>({objective,proven}));search.begin();
        assert.equal(await search.bound(model,'Wood Blocks'),null);
        assert.equal(await search.bound(model,'unknown'),null);
    }
});

test('integral planting score can use the rounded-down bound',async()=>{
    const search=createComparisonSearch(baseline,async()=>({objective:10.8,proven:true}));search.begin();
    assert.equal((await search.bound(model,'crop_variety')).objective,10);
});

test('only proven identical models are cached; tie-break and strict tolerance stay separate',async()=>{
    let calls=0;
    const search=createComparisonSearch({},async()=>({proven:++calls!==1,objective:10,values:[5,0]}));search.begin();
    await search.solve(model);await search.solve(model);await search.solve(model);
    assert.equal(calls,2);
    await search.solve({...model,tiebreak:[[1,.2]]});assert.equal(calls,3);
    await search.solve(model,{time_limit:1,mip_feasibility_tolerance:1e-9});assert.equal(calls,4);
});

test('quick checks have a per-alternative deadline; detailed search preserves the full budget',async()=>{
    let time=0;const budgets=[];
    const search=createComparisonSearch({},async(_,o)=>{budgets.push(o.time_limit);return null;},{now:()=>time});
    search.begin();time=7_500;await search.solve(model);
    assert.equal(budgets[0],.5);
    time=8_001;await assert.rejects(search.solve(model),/Detailed search/);
    search.begin();await search.solve(model);assert.equal(budgets[1],1);
    const detailed=createComparisonSearch({},async(_,o)=>{budgets.push(o.time_limit);return null;},{detailed:true,now:()=>time});
    detailed.begin();time+=1_000_000;await detailed.solve(model);assert.equal(budgets[2],30);
});

test('quick alternatives preserve the current income floor while earlier goals stay unchanged',()=>{
    const before={...baseline,currency:'coins',rate_per_second:3_506_373/86400,
        comparison_goals:{...baseline.comparison_goals,currency:'coins',currency_value:3_506_373/86400}};
    const search=createComparisonSearch(before,async()=>null);search.begin();
    search.observe('Wood Blocks',{objective:10});
    const guarded=search.protect(model,'coins');
    assert.notEqual(guarded.lp,model.lp);
    assert.ok(guarded.lp.includes(`>= ${before.rate_per_second*(1-1e-4)}`));
    assert.ok(guarded.lp.indexOf('comparison_baseline:')<guarded.lp.indexOf('Bounds'));
    assert.equal(search.protect(model,'crop_variety').lp.includes('>= 10'),true);
    assert.equal(model.lp.includes('comparison_baseline:'),false);
});

test('a real improvement in an earlier goal permits lower later-priority income',()=>{
    const search=createComparisonSearch({...baseline,rate_per_second:10},async()=>null);search.begin();
    search.observe('Wood Blocks',{objective:11});
    assert.equal(search.protect(model,'coins'),model);
    search.begin();
    assert.notEqual(search.protect(model,'coins'),model);
});

test('detailed searches can find genuine trade-offs and do not impose quick baseline guards',()=>{
    const search=createComparisonSearch({...baseline,rate_per_second:10},async()=>null,{detailed:true});search.begin();
    assert.equal(search.protect(model,'coins'),model);
});

test('a weaker time-limited incumbent is rejected, while a higher-priority gain can trade income',()=>{
    const before={currency:'coins',proven_optimal:true,rate_per_second:100,priorities:[{target:'Wood Blocks',per_second:10}]};
    const after={...before,proven_optimal:false,rate_per_second:80};
    const search=createComparisonSearch(before,async()=>null);
    const input={priorities:['Wood Blocks','coins']};
    assert.equal(search.inconclusive(after,input,input),true);
    assert.equal(search.inconclusive({...after,priorities:[{target:'Wood Blocks',per_second:11}]},input,input),false);
});

test('warm starts map semantic variable identities rather than reusing old column indices',async()=>{
    const before={comparison_seed:{keys:['rate:owned','rate:reserve','sold'],values:[.5,.1,.6]}};
    let supplied;
    const search=createComparisonSearch(before,async(_,__,___,seed)=>{supplied=seed;return null;},{detailed:true});search.begin();
    await search.solve({...model,variables:4,variable_keys:['sold','new-job','rate:reserve','rate:owned']});
    assert.deepEqual(supplied,[.6,0,.1,.5]);
    assert.equal(search.stats.warm,1);
    await search.solve({...model,variables:4,variable_keys:['sold','new-job','rate:reserve','rate:owned']},undefined,undefined,[1,2,3,4]);
    assert.deepEqual(supplied,[1,2,3,4]);
});

test('refitting a fixed layout supplies only an incumbent and cannot certify the unrestricted optimum',async()=>{
    const before={comparison_seed:{keys:['a','b'],values:[1,.5]}};
    const calls=[];
    const search=createComparisonSearch(before,async(p,options,message,seed)=>{
        calls.push({p,seed});
        return calls.length===1 ? {values:[1,.7],objective:7,proven:true} : {values:[1,.8],objective:8,proven:false};
    },{detailed:true});search.begin();
    const result=await search.solve({...model,variable_keys:['a','b']});
    assert.ok(calls[0].p.lp.includes('warm_fix_0'));
    assert.ok(!calls[0].p.lp.includes('General'));
    assert.equal(calls[1].p.lp,model.lp);
    assert.deepEqual(calls[1].seed,[1,.7]);
    assert.equal(result.proven,false);
    assert.equal(result.objective,8);
});

test('large rosters receive preparation time without increasing the per-solve search limit',async()=>{
    let time=0,limit;
    const keys=Array.from({length:6646},(_,i)=>`job:${i}`);
    const search=createComparisonSearch({comparison_seed:{keys,values:keys.map(()=>0)}},async(_,o)=>{limit=o.time_limit;return null;},{now:()=>time});
    search.begin();time=10_000;
    await search.solve(model);
    assert.equal(limit,1);
    time=22_000;
    await assert.rejects(search.solve(model),/Detailed search/);
});

const input=()=>({facilities:{'Nimbus Bed':[{count:1,level:2}],'Dewy House':[{count:1,level:1}],Mill:[{count:1,level:1}]},
    modules:{kitchen:1},exclude:[],roster:{members:[{count:1,abilities:{Leisure:3},family:'wool'}],
        personalities:{'Nimbus Bed':'Judicious','Dewy House':'Instinctive'}}});
const recipes=[
    {name:'wool',facility:'Nimbus Bed',facility_level:1,workload:10,aniimo:['Leisure',1],family:'wool'},
    {name:'petals',facility:'Nimbus Bed',facility_level:3,workload:10,aniimo:['Leisure',1],family:'petals'},
    {name:'aroma',facility:'Dewy House',facility_level:1,workload:10,aniimo:['Leisure',1],family:'aroma'},
    {name:'fabric',facility:'Mill',facility_level:1,raw_materials:['wool']},
    {name:'other',facility:'Mill',facility_level:1,raw_materials:['fabric'],module_requirement:['kitchen',2]},
    {name:'blocked',facility:'Mill',facility_level:1,raw_materials:['other']},
];

test('excludes unavailable levels/modules/ingredients while retaining craftable chains',()=>{
    assert.deepEqual(availableRecipes(input(),recipes).map(r=>r.name),['wool','aroma','fabric']);
    const changed=input();changed.exclude=['wool'];
    assert.deepEqual(availableRecipes(changed,recipes).map(r=>r.name),['aroma']);
    changed.level_up={stock:[['wool',10]]};
    assert.ok(availableRecipes(changed,recipes).some(r=>r.name==='fabric'));
});

test('wrong-family Leisure traits are removed, including higher-level recipes not yet unlocked',()=>{
    const base=input();
    assert.equal(usefulUpgrade(base,{kind:'personality',member:0,trait:'Instinctive'},recipes),false);
    assert.equal(usefulUpgrade(base,{kind:'personality',member:0,trait:'Judicious'},recipes),true);
    base.roster.members[0].family='petals';
    assert.equal(usefulUpgrade(base,{kind:'personality',member:0,trait:'Judicious'},recipes),false);
});

test('idle compatible facilities are retained and byproduct-only ingredients count as available',()=>{
    const source=[...recipes,{name:'ore',facility:'Mill',facility_level:1,byproduct_item:'sand'},
        {name:'sand_cast',facility:'Mill',facility_level:1,raw_materials:['sand']},
        {name:'quick_rice',facility:'Mill',facility_level:1},
        {name:'rice_drink',facility:'Mill',facility_level:1,raw_materials:['rice']}];
    assert.ok(availableRecipes(input(),source).some(r=>r.name==='sand_cast'));
    assert.ok(availableRecipes(input(),source).some(r=>r.name==='rice_drink'));
    assert.equal(usefulUpgrade(input(),{kind:'ability',member:0,ability:'Leisure'},source),true);
    assert.equal(usefulUpgrade(input(),{kind:'recipe',name:'blocked'},source),false);
});
