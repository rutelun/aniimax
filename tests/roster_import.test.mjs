import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function fillRosterFrom('),source.indexOf('async function sourceTeamLayout('));
test('Best import with ability-level cache key uses the Best team, including support copies',async()=>{
 const key='best:Earth4,Dark4',plan={success:true,coin_items:[]};let imported=false;
 const c=vm.createContext({lastPlanInput:{},rosterFillVersion:0,planRunId:1,plansBySetup:{[key]:plan},document:{getElementById:()=>({})},aniimoInput:()=>({}),
 sourceTeamLayout:async(p,input,mode)=>{assert.equal(mode,'best');return {};},
 haulingWorkload:()=>({busyByLevel:{3:.2}}),haulingRouteBound:()=>0,recipeIndex:[],
 bestPlanTeam:()=>({shifts:[{id:1},{id:2},{id:2}]}),bestRosterMember:s=>({catalogId:s.id,count:1}),
 rosterSlotsFor:r=>r,rosterChanged:()=>{imported=true;},console,Map});
 vm.runInContext(code,c);await c.fillRosterFrom(key);
 assert.equal(imported,true);
 assert.equal(c.roster.reduce((n,m)=>n+m.count,0),3);
 assert.equal(c.roster.find(m=>m.catalogId===2).count,2);
});
