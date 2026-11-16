import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {questIncome} from '../web/quest-income.js';

test('daily income accepts only the two quest resources and finite positive amounts',()=>{
    assert.deepEqual(questIncome({wood_block:'512',mineral_sand:1024,wool:500,coins:200}),{wood_block:512,mineral_sand:1024});
    assert.deepEqual(questIncome({wood_block:Infinity,mineral_sand:-10}),{});
    assert.deepEqual(questIncome({wood_block:1e20}),{wood_block:1e9});
});
test('old one-off stock never becomes recurring income or an invisible upgrade discount',()=>{
    assert.deepEqual(questIncome(undefined),{});
    const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
    const context=vm.createContext({levelUpStock:{wood_block:512,laminated_beams:10},
        levelUpUnavailable:()=>null,levelUpCost:()=>({coins:100,items:[['laminated_beams',20]]})});
    vm.runInContext(source.slice(source.indexOf('function levelUpInput('),source.indexOf('\n// A per-second rate',source.indexOf('function levelUpInput('))),context);
    assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(levelUpInput())',context)),{
        cost:[['coins',100],['laminated_beams',20]],stock:[]});
});
