import {haulingLevelFor} from '../web/hauling.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
test('layout postpass retains the phase-certified couriers instead of allocating by daily spare time',()=>{
 const context=vm.createContext({haulingLevelFor,selectedSetupTab:()=> 'custom',haulingRouteBound:()=>100,haulingWorkload:()=>({seconds:{},busyByLevel:{3:.5}}),recipeIndex:[],lastPlanInput:{facilities:{}},bestTeamLayouts:new WeakMap()});
 vm.runInContext(src.slice(src.indexOf('function assignLayoutHauling('),src.indexOf('function refineWorkerMovement(')),context);
 context.plan={recipe_schedule:{phases:[{duration:43200},{duration:43200}]},hauling_staffing:[[0,.5]]};
 vm.runInContext('assignLayoutHauling({},plan)',context);
 assert.deepEqual(JSON.parse(JSON.stringify(context.plan.delivery_assignments)),[[0,.5]]);
});
