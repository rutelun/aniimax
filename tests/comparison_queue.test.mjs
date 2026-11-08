import {test} from 'node:test';
import assert from 'node:assert/strict';
import {comparisonConcurrency,startComparisonQueue} from '../web/comparison-queue.js';

function fixture(indices=[0,1,2,3,4],parallel=2) {
    const workers=[],results=[],progress=[],done=[],timers=new Set();
    class Worker {
        constructor(){workers.push(this);this.messages=[];}
        postMessage(message){this.message=message;this.messages.push(message);}
        terminate(){this.terminated=true;}
        reply(data,id=this.message.id){this.onmessage({data:{id,...data}});}
        result(value){this.reply({type:'progress',count:{index:0,plan:value}});}
        finish(){this.reply({ok:true});}
    }
    const queue=startComparisonQueue({indices,parallel,createWorker:()=>new Worker(),payload:i=>({candidate:i}),
        timeout:100,setTimer:fn=>{timers.add(fn);return fn;},clearTimer:id=>timers.delete(id),
        onProgress:value=>progress.push(value),onResult:(...args)=>results.push(args),onDone:value=>done.push(value)});
    return {workers,results,progress,done,timers,queue};
}

test('parallel alternatives retain their indices through out-of-order completion and reuse runtimes',()=>{
    const f=fixture(),[a,b]=f.workers;
    assert.equal(f.workers.length,2);
    b.result('one');b.finish();
    assert.equal(JSON.parse(b.message.payload).candidate,2);
    a.result('zero');a.finish();
    assert.equal(JSON.parse(a.message.payload).candidate,3);
    b.result('two');b.finish();
    b.result('four');b.finish();
    assert.equal(f.done.length,0);
    a.result('three');a.finish();
    assert.deepEqual(f.results,[[1,{index:0,plan:'one'}],[0,{index:0,plan:'zero'}],
        [2,{index:0,plan:'two'}],[4,{index:0,plan:'four'}],[3,{index:0,plan:'three'}]]);
    assert.deepEqual(f.done,[false]);
    assert.equal(f.timers.size,0);
    assert.ok(f.workers.every(w=>w.terminated));
});

test('stale replies, cancellation and timeouts cannot overwrite another candidate',()=>{
    const f=fixture([8,9,10]),[a,b]=f.workers,old=a.message.id;
    a.result('eight');a.finish();
    a.reply({type:'progress',count:{index:0,plan:'stale'}},old);
    assert.equal(f.results.length,1);
    b.onerror();
    assert.equal(f.results[1][0],9);
    assert.ok(f.results[1][1].error);
    f.queue.stop();
    a.result('late');
    assert.equal(f.results.length,2);
    assert.equal(f.timers.size,0);
    assert.equal(f.done.length,0);
    const hung=fixture([1],1);
    [...hung.timers][0]();
    assert.deepEqual(hung.done,[true]);
    assert.ok(hung.workers[0].terminated);
});

test('a failed alternative does not prevent other pending alternatives from being checked',()=>{
    const f=fixture([1,2,3],1),w=f.workers[0];
    w.reply({ok:false,error:'not feasible'});
    assert.equal(JSON.parse(w.message.payload).candidate,2);
    w.result('two');w.finish();w.result('three');w.finish();
    assert.deepEqual(f.results.map(r=>r[0]),[1,2,3]);
    assert.deepEqual(f.done,[true]);
});

test('parallelism leaves capacity for the page and respects small devices',()=>{
    assert.equal(comparisonConcurrency({},50),1);
    assert.equal(comparisonConcurrency({hardwareConcurrency:8,deviceMemory:4},50),2);
    assert.equal(comparisonConcurrency({hardwareConcurrency:24,deviceMemory:8},50),4);
    assert.equal(comparisonConcurrency({hardwareConcurrency:24,deviceMemory:8},1),1);
});
