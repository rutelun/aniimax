import {test} from 'node:test';
import assert from 'node:assert/strict';
import {automaticReplacements} from '../web/two-ability-search.js';

const input={facilities:{Mill:[{count:2,level:2}],Stove:[{count:1,level:2}],Table:[{count:1,level:2}],Bed:[{count:1,level:1}]},
    roster:{members:[{count:1,abilities:{Fire:3}},{count:1,abilities:{Artisanship:3}}],residents:['Bed']}};
const recipes=[{name:'a',facility:'Mill',facility_level:1,aniimo:['Artisanship',1]},
    {name:'b',facility:'Stove',facility_level:1,aniimo:['Fire',1]},
    {name:'c',facility:'Table',facility_level:1,aniimo:['Grass',1]},
    {name:'d',facility:'Bed',facility_level:1,aniimo:['Leisure',1],family:'1017'}];
const plan={coin_items:[{status:'producing',facility:'Mill',crew:0,aniimo:{ability:'Fire',level:3},busy_units:.4},
    {status:'producing',facility:'Table',crew:1,aniimo:{ability:'Artisanship',level:3},busy_units:.4}]};

test('automatic pairs include idle but available abilities and prefer compatible partial shifts',()=>{
    const saved=structuredClone(input),pairs=automaticReplacements(input,plan,recipes);
    assert.equal(pairs.length,3);
    assert.deepEqual(Object.keys(pairs[0].input.roster.members.at(-1).abilities),['Artisanship','Fire']);
    assert.ok(pairs.some(p=>p.input.roster.members.at(-1).abilities.Grass));
    assert.deepEqual(input,saved);
    assert.ok(pairs.every(p=>p.input.roster.members.at(-1).count===1));
});

test('walking and delivery prevent prioritizing an impossible partial-shift merge',()=>{
    const travel={...plan,movement_staffing:[[0,.3,0]]};
    const pairs=automaticReplacements(input,travel,recipes);
    const pair=pairs.find(p=>p.input.roster.members.at(-1).abilities.Fire&&p.input.roster.members.at(-1).abilities.Artisanship);
    assert.ok(pair.score<10,'.4+.3+.4 takes more than a worker day');
});

test('full-day residents and unavailable recipes do not add redundant or impossible pairs',()=>{
    const inaccessible={name:'e',facility:'Missing',aniimo:['Ice',1]};
    const pairs=automaticReplacements(input,plan,[...recipes,inaccessible],a=>a==='Artisanship'?3:4);
    assert.ok(pairs.every(p=>!p.input.roster.members.at(-1).abilities.Leisure&&!p.input.roster.members.at(-1).abilities.Ice));
    assert.ok(pairs.every(p=>(p.input.roster.members.at(-1).abilities.Artisanship||3)===3));
    assert.deepEqual(automaticReplacements({...input,roster:null},plan,recipes),[]);
});
