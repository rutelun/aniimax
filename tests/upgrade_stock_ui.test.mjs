import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function setup(cost,stock={}){
    const context=vm.createContext({levelUpStock:stock,levelUpUnavailable:()=>null,levelUpCost:()=>cost});
    vm.runInContext(source.slice(source.indexOf('function stockNames('),source.indexOf('\nfunction populateLevelUpTargets('))+
        source.slice(source.indexOf('function levelUpInput('),source.indexOf('\n// A per-second rate',source.indexOf('function levelUpInput('))),context);
    return context;
}
test('higher RV exposes basic wood and sand alongside its upgrade costs only',()=>{
    const ctx=setup({coins:100,items:[['laminated_beams',10],['refined_ore',20]]});
    assert.deepEqual(Array.from(vm.runInContext('stockNames(levelUpCost())',ctx)),['wood_block','mineral_sand','coins','laminated_beams','refined_ore']);
});
test('early RV does not duplicate raw materials that are also upgrade costs',()=>{
    const ctx=setup({coins:100,items:[['wood_block',10],['mineral_sand',20]]});
    const names=Array.from(vm.runInContext('stockNames(levelUpCost())',ctx));
    assert.equal(names.length,3);assert.equal(new Set(names).size,3);
});
test('raw stock reaches the solver under its original names without becoming finished material',()=>{
    const ctx=setup({coins:100,items:[['laminated_beams',10],['refined_ore',20]]},
        {wood_block:512,mineral_sand:1024,laminated_beams:2,refined_ore:-1,coins:Infinity,wool:100});
    const input=JSON.parse(vm.runInContext('JSON.stringify(levelUpInput())',ctx));
    assert.deepEqual(input.stock,[['wood_block',512],['mineral_sand',1024],['laminated_beams',2]]);
    assert.deepEqual(input.cost,[['coins',100],['laminated_beams',10],['refined_ore',20]]);
});
