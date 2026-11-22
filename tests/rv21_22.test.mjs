import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {facilityStockLimit} from '../web/hauling.js';
import {FACILITIES,simpleSetup,MAX_HOME_LEVEL,ANIIMO_MAX,LEVEL_UP_COSTS,LEISURE_FAMILIES,storageUnitLimit,generatorLimit,SPECIAL_RECIPES} from '../web/facility-config.js';
const csv=name=>{const [header,...rows]=fs.readFileSync(new URL(`../data/${name}.csv`,import.meta.url),'utf8').trim().split(/\r?\n/);const keys=header.split(',').map(x=>x.trim());return rows.map(row=>Object.fromEntries(row.split(',').map((v,i)=>[keys[i],v.trim()])));};
test('RV 21 and 22 unlock exact tiers and retain infrastructure limits',()=>{
 assert.equal(MAX_HOME_LEVEL,22);assert.deepEqual(ANIIMO_MAX.slice(-2),[46,47]);
 const a=simpleSetup(21),b=simpleSetup(22);
 for(const [name,level,count] of [['Farmland',8,40],['Woodland',6,20],['Mine',7,10],['Well',6,4],['Starfall Hammock',2,2],['Carousel Mill',7,2],['Jukebox Dryer',8,2],['Joy Wheel Loom',5,2],['Simmering Pot',7,2],['Pickling Jar',6,2]]) assert.deepEqual(a.facilities[name],[{level,count}],name);
 assert.equal(a.facilities['Phonolfactory Table'][0].level,6);
 for(const [name,level] of [['Phonolfactory Table',7],['Crafting Table',9],['Tidewhisper Sandcastle',5],['Bouncy Brew Keg',6],['Blazing Stove',6]]) assert.equal(b.facilities[name][0].level,level,name);
 assert.equal(b.facilities.Farmland[0].count,42);assert.equal(b.facilities.Woodland[0].count,21);
 assert.equal(a.modules.ecological_module,9);assert.equal(b.modules.crafting_module,8);assert.equal(b.modules.resource_detector,10);
 assert.equal(facilityStockLimit('Farmland',8),40);
 for(const rv of [21,22]){assert.equal(storageUnitLimit(rv),8);assert.equal(generatorLimit(rv),3);}
 assert.deepEqual(LEVEL_UP_COSTS[21],{coins:34300000,items:[['densified_timber_component',830],['microcrystalline_ore_plate',460]]});
 assert.deepEqual(LEVEL_UP_COSTS[22],{coins:52600000,items:[['densified_timber_component',1190],['microcrystalline_ore_plate',1320]]});
});
test('compiled recipes respect RV/module gates and include complete ingredient and worker data',
 {skip:!fs.existsSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))},async()=>{
 const pkg=await import('../web/pkg/aniimax.js');pkg.initSync({module:fs.readFileSync(new URL('../web/pkg/aniimax_bg.wasm',import.meta.url))});
 const available=rv=>new Set(JSON.parse(pkg.exact_problem(JSON.stringify(simpleSetup(rv)),'{}')).variable_keys
     .filter(k=>k.startsWith('rate:')).map(k=>k.slice(5).split('#')[0]));
 const a=available(20),b=available(21),c=available(22);
 for(const name of ['sorghum','premium_potato','quick_agave','silver_ore','snowmelt_cold_spring','gold_speck_cap','sorghum_flour','sisal_plush_mat','sorghum_fermented_mash']){assert.ok(!a.has(name),`${name} too early`);assert.ok(b.has(name),`${name} missing at 21`);}
 for(const name of ['sweet_cone','quick_snowmelt_cold_spring','premium_quicksilver_springstone','coconut_milk_lotion','cocoa_sweet_cone','shredded_coconut_cake']){assert.ok(!b.has(name),`${name} too early`);assert.ok(c.has(name),`${name} missing at 22`);}
 assert.ok(a.has('quick_pearl'));
 const all=JSON.parse(pkg.get_all_items()),names=new Set([...all.map(r=>r.name),'wood_block','mineral_sand']);
 for(const recipe of all)for(const ingredient of recipe.raw_materials||[])assert.ok(names.has(ingredient),`${recipe.name}: missing ${ingredient}`);
 assert.equal(all.find(r=>r.name==='sorghum').production_time,1800,'watering adjustment applied exactly once');
 assert.ok(all.find(r=>r.name==='sorghum').jobs.some(j=>j[0]==='Watering'));
 assert.equal(all.find(r=>r.name==='gold_speck_cap').family,'1063');
 assert.equal(all.find(r=>r.name==='sweet_cone').family,'1059');
});
test('new crops, variants and family-restricted gathering retain their real constraints',()=>{
 const crops=csv('farmland');
 for(const name of ['sorghum','premium_potato','quick_agave']) assert.equal(crops.find(r=>r.name===name)?.production_time,'2400');
 assert.equal(crops.find(r=>r.name==='sorghum').environment,'Adequate');
 assert.equal(crops.find(r=>r.name==='sorghum').cost,'165');
 assert.equal(crops.find(r=>r.name==='quick_agave').module_requirement,'ecological_module:9');
 assert.equal(csv('well').find(r=>r.name==='quick_snowmelt_cold_spring').module_requirement,'resource_detector:10');
 assert.equal(csv('tidewhisper_sandcastle').find(r=>r.name==='sweet_cone').environment,'Freeze');
 assert.equal(csv('starfall_hammock').find(r=>r.name==='gold_speck_cap').environment,'Warm');
 const req=csv('aniimo_requirements');
 assert.equal(req.find(r=>r.name==='gold_speck_cap').family,'1063');assert.equal(req.find(r=>r.name==='sweet_cone').family,'1059');
 const catalog=JSON.parse(fs.readFileSync(new URL('../web/aniimo-catalog.json',import.meta.url)));
 const entries=catalog.entries;
 for(const family of ['1063','1059']){assert.ok(LEISURE_FAMILIES.some(f=>f.id===family));assert.ok(entries.some(a=>a.family===family&&a.abilities.Leisure===4));}
 assert.ok(SPECIAL_RECIPES.some(r=>r.name==='orange_flower_rice_drink'));
});

test('custom counts from mixed-tier saves use the selected RV cap for every owned facility',()=>{
 const owned=Object.fromEntries(FACILITIES.map(f=>[f.name,[{count:2,level:1},{count:1,level:2}]]));
 owned.Well=[{count:0,level:1}];
 for (const rv of [1,12,21,22]) {
  const caps=simpleSetup(rv).facilities, effective=simpleSetup(rv,owned).facilities;
  for(const f of FACILITIES) assert.deepEqual(effective[f.name],[{level:caps[f.name][0].level,
   count:caps[f.name][0].count && f.name!=='Well'?3:0}],f.name);
 }
 assert.deepEqual(owned.Mine,[{count:2,level:1},{count:1,level:2}]);
});
