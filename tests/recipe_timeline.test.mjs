import test from 'node:test';
import assert from 'node:assert/strict';
import {siteSchedule,scheduledRate} from '../web/recipe-timeline.js';
test('common periods select only the active recipe and repeat after morning reset',()=>{
 const s={jobs:[{id:'a',item:'ore'},{id:'b',item:'brick'}],phases:[{duration:40,assignments:[{building:'kiln:1',job:'a',batches:4}]},{duration:60,assignments:[{building:'kiln:1',job:'b',batches:3}]}]};
 const phases=siteSchedule(s,'kiln:1');
 assert.equal(scheduledRate(phases,'ore',39),.1);assert.equal(scheduledRate(phases,'ore',40),0);
 assert.equal(scheduledRate(phases,'brick',40),.05);assert.equal(scheduledRate(phases,'ore',100),.1);
});
