import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const start=source.indexOf('async function initWasm()');
const end=source.indexOf('\n}',start)+2;
assert.ok(start>=0 && end>start);

test('the first solve waits for restored seasonal fields even when the worker is already ready',async()=>{
    let release;
    const waiting=new Promise(resolve=>{release=resolve;});
    let loaded;
    const started=new Promise(resolve=>{loaded=resolve;});
    const label={},button={disabled:true,querySelector:()=>label};
    const context={wasmReady:false,wasmLoadFailed:false,
        document:{getElementById:id=>id==='optimize-btn'?button:{},querySelector:()=>label},
        callWorker:async()=>'test',loadRecipeIndex:async()=>{loaded();await waiting;},
        resetPlanButton:()=>{button.disabled=!context.wasmReady;},console:{log(){}}};
    const init=runInNewContext(source.slice(start,end)+'\ninitWasm()',context);
    await started;
    assert.equal(button.disabled,true);
    assert.equal(context.wasmReady,false);
    release();
    await init;
    assert.equal(button.disabled,false);
    assert.equal(context.wasmReady,true);
});
