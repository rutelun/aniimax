import test from 'node:test';
import assert from 'node:assert/strict';
import {cachedEconomicBound} from '../web/economic-bound-cache.js';
import {solveEconomicBound} from '../web/economic-bound.js';
import highsModule from '../web/vendor/highs/highs.mjs';
import {readFile} from 'node:fs/promises';

test('only a proved identical economic problem can bypass a solve', async () => {
    const highs=await highsModule({wasmBinary:await readFile(new URL('../web/vendor/highs/highs.wasm',import.meta.url)),print(){},printErr(){}});
    const problem={lp:'Maximize\n obj: x0\nSubject To\n cap: x0 <= 1\nBounds\n 0 <= x0 <= 2\nEnd',
        variables:1,variable_keys:['rate:crop#0'],primary_objective:[[0,1]],recipe_options:[[0,'crop','Farm',true,false,1]],production_only:true};
    let calls=0;
    const solve=(p,o)=>{calls++;return solveEconomicBound(highs,p,o);};
    const run=(p=problem,opts={})=>cachedEconomicBound(p,opts,solve);
    assert.equal((await run()).objective,1);
    assert.equal((await run(structuredClone(problem))).upper,1);
    assert.equal(calls,1);
    assert.equal((await run({...problem,lp:problem.lp.replace('cap: x0 <= 1','cap: x0 <= 2')})).objective,2);
    assert.equal((await run(problem,{discovery:true})).proven,false);
    assert.equal((await run(problem,{discovery:true})).upper,null);
    assert.equal(calls,4);
});

test('unproved results are retried and cached values belong to each caller',async()=>{
    const problem={lp:'bounded test',variables:1};
    let calls=0;
    const solve=()=>({proven:++calls>1,upper:1,objective:1,values:[1]});
    const run=()=>cachedEconomicBound(problem,{},solve);
    assert.equal((await run()).proven,false);
    (await run()).values[0]=0;
    assert.deepEqual((await run()).values,[1]);
    assert.equal(calls,2);
});

test('a late cache miss cannot reopen workers after the plan is finished',async t=>{
    const {economicWorkers}=await import('../web/economic-parallel.js');
    t.mock.getter(globalThis,'navigator',()=>({hardwareConcurrency:8}));
    const original=globalThis.Worker;
    let spawned=0;
    globalThis.Worker=class {constructor(){spawned++;} postMessage(){throw Error('unexpected solve');}};
    t.after(()=>{if(original)globalThis.Worker=original;else delete globalThis.Worker;});
    const pool=economicWorkers('');
    const delayed=Promise.resolve().then(()=>pool.callbacks.evaluateBound({},{}));
    pool.close();
    assert.equal(await delayed,null);
    assert.equal(spawned,0);
});

test('recipe proposals leave the bound request pending until its certificate arrives',async t=>{
    const {economicWorkers}=await import('../web/economic-parallel.js');
    t.mock.getter(globalThis,'navigator',()=>({hardwareConcurrency:8}));
    const original=globalThis.Worker;
    let worker, request;
    globalThis.Worker=class {
        constructor(){worker=this;}
        postMessage(message){request=structuredClone(message);}
        terminate(){}
    };
    t.after(()=>{if(original)globalThis.Worker=original;else delete globalThis.Worker;});
    const pool=economicWorkers(''),proposals=[];
    try{
        const bound=pool.callbacks.evaluateBound({},{onRecipes:items=>proposals.push(items)});
        assert.equal(request.reportRecipes,true);
        worker.onmessage({data:{id:request.id,recipes:['ore']}});
        worker.onmessage({data:{id:request.id,result:{upper:12}}});
        assert.deepEqual(await bound,{upper:12});
        assert.deepEqual(proposals,[['ore']]);
    }finally{pool.close();}
});

test('a large measured model can reuse its dual bound at the requested gap', async()=>{
    const keys=Array.from({length:6500},(_,v)=>'continuous_site:Workshop|recipe_'+v);
    const problem={lp:'measured dispatch',variables:keys.length,variable_keys:keys};
    const options={exact:true,relativeGap:.002,incomeTarget:100.2};
    let calls=0;
    const result={proven:false,keys,upper:100.15,objective:100,values:keys.map((_,v)=>v===3?1:0)};
    const solve=()=>{calls++;return result;};
    await cachedEconomicBound(problem,options,solve);
    const hit=await cachedEconomicBound(problem,options,solve);
    assert.equal(calls,1);
    assert.deepEqual(hit,result);
    hit.values[3]=0;
    assert.equal((await cachedEconomicBound(problem,options,solve)).values[3],1);
    await cachedEconomicBound(problem,{...options,relativeGap:.0001,incomeTarget:100.01},solve);
    await cachedEconomicBound(problem,{...options,relativeGap:.0001,incomeTarget:100.01},solve);
    assert.equal(calls,3);
});

test('economicWorkers pools idle workers, forwards wasmModule once, and terminates aborted jobs',async t=>{
    const {economicWorkers}=await import('../web/economic-parallel.js');
    const created=[];
    const fakeWasm={tag:'compiled-wasm'};
    const createWorker=()=>{
        const w={messages:[],terminated:false,onmessage:null,onerror:null,onmessageerror:null,
            postMessage(m){this.messages.push(m);},
            terminate(){this.terminated=true;}};
        created.push(w);
        return w;
    };
    const pool=economicWorkers('',{wasmModule:fakeWasm,createWorker,maxWorkers:2});
    try{
        // First request spawns slot 0 and receives wasmModule once.
        const p1=pool.callbacks.evaluateBound({lp:'a'},{});
        assert.equal(created.length,1);
        assert.equal(created[0].messages[0].wasmModule,fakeWasm);
        created[0].onmessage({data:{id:created[0].messages[0].id,result:{upper:10}}});
        assert.deepEqual(await p1,{upper:10});

        // Next sequential request reuses idle slot 0 without resending wasmModule.
        const p2=pool.callbacks.evaluateSolve({lp:'b'},{polish:true});
        assert.equal(created.length,1);
        assert.equal(created[0].messages[1].kind,'solve');
        assert.equal(created[0].messages[1].wasmModule,undefined);
        created[0].onmessage({data:{id:created[0].messages[1].id,result:{values:[1],objective:1,proven:true,polished:true}}});
        assert.equal((await p2).objective,1);

        // Concurrent request with AbortSignal spawns slot 1 and terminates it immediately on abort.
        const ctrl=new AbortController();
        const p3=pool.callbacks.evaluateBound({lp:'c'},{});
        const p4=pool.callbacks.evaluateBound({lp:'d'},{signal:ctrl.signal});
        assert.equal(created.length,2);
        ctrl.abort();
        assert.equal(await p4,null);
        assert.equal(created[1].terminated,true);
        assert.equal(created[0].terminated,false);
        created[0].onmessage({data:{id:created[0].messages[2].id,result:{upper:9}}});
        assert.deepEqual(await p3,{upper:9});
    }finally{pool.close();}
    assert.equal(created[0].terminated,true);
});
