// Run against a served web/ directory and a Chromium browser with local CDP enabled.
// E.g. node scripts/qa-planner-matrix.mjs --rv=3,12 --profile=best,my-small --plan-only
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {simpleSetup} from '../web/facility-config.js';

const {values:args} = parseArgs({options:{
    origin:{type:'string',default:'http://127.0.0.1:8082/'}, cdp:{type:'string',default:'http://127.0.0.1:9231'},
    rv:{type:'string',default:'3,12,16,20,21,22'}, profile:{type:'string',default:'best,minimum,my-small,my-mixed'},
    timeout:{type:'string',default:'600'}, out:{type:'string',default:'target/qa-planner-matrix'},
    'plan-only':{type:'boolean',default:false}, 'save-inputs':{type:'boolean',default:false},
}});
const catalog = JSON.parse(await readFile(new URL('../web/aniimo-catalog.json',import.meta.url))).entries;
const rosters = {
    'my-small':['sparki-forest','ignitis-prismana','bailite','shrubclaw','whirlbite-prismana'],
    'my-mixed':['ignitis-prismana','ignitis-prismana','prawnch','gachapus-prismana','fenmane-prismana',
        'shrubclaw','glynsera-prismana','sparki-forest','blazen','whirlbite-prismana'],
};
const levels=args.rv.split(',').map(Number), profiles=args.profile.split(',');
assert.ok(levels.every(rv=>Number.isInteger(rv)&&rv>=1&&rv<=22));
assert.ok(profiles.every(profile=>['best','minimum',...Object.keys(rosters)].includes(profile)));
assert.ok(Number(args.timeout)>0);
await mkdir(args.out,{recursive:true});

const version = await (await fetch(new URL('/json/version',args.cdp))).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
const pending = new Map();
let sequence=0;
ws.onmessage=({data})=>{
    const {id,result,error}=JSON.parse(data), request=pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(new Error(error.message));
    else request.resolve(result);
};
function send(method,params={},sessionId) {
    const id=++sequence;
    return new Promise((resolve,reject)=>{
        pending.set(id,{resolve,reject});
        ws.send(JSON.stringify({id,method,params,sessionId}));
    });
}
function configuration(profile,rv) {
    const ids=rosters[profile] || [], unique=[...new Set(ids)];
    const roster=unique.map(id=>{
        const member=catalog.find(m=>m.id===id);
        assert.ok(member,id);
        return {...member,catalogId:id,count:ids.filter(x=>x===id).length,personalities:[]};
    });
    return {'home-level':String(rv), customBuildings:false, facilityTiers:simpleSetup(rv).facilities,
        roster,rosterSlots:ids.map(id=>unique.indexOf(id)), 'aniimo-best':profile==='best',
        'aniimo-minimum':profile==='minimum','aniimo-custom':ids.length>0, 'season-on':false,
        'electricity-on':rv>=12,'layout-sim-on':false, priorities:[
            {target:'coins',on:true},{target:'Wood Blocks',on:profile==='my-mixed'},
        ]};
}
const observe = config => {
    localStorage.setItem('aniimax-config-v1',JSON.stringify(config));
    const qa = window.plannerQa={inputs:[],plans:[],stages:[],errors:[],version:null};
    window.plannerPayloads=[];
    window.addEventListener('error',e=>qa.errors.push(e.message));
    window.Worker=class extends Worker {
        constructor(...args) {
            super(...args);
            this.requests=new Map();
            this.addEventListener('error',e=>qa.errors.push(e.message||'Worker failed to load '+args[0]));
            this.addEventListener('message',({data})=>{
                if(this.requests.get(data.id)==='get_version'){qa.version=data.result??data.error;return}
                if (!this.requests.has(data.id)) return;
                if (data.type==='progress') {
                    if(data.count?.step) qa.stages.push([data.count.step,data.count.state,Math.round(performance.now())]);
                    return;
                }
                if(!data.ok) {qa.errors.push(String(data.error));return}
                const p=JSON.parse(data.result);
                qa.plans.push({at:performance.now(),success:p.success,error:p.error,rate:p.rate_per_second,
                    checked:p.continuous_production_checked,priorities:p.priorities,
                    climate:p.staffing, unverified:p.unverified,fallback:p.fallback_reason,
                    crops:p.coin_items?.filter(r=>r.is_grower&&r.status==='producing').length,
                    producing:p.coin_items?.filter(r=>r.status==='producing').length});
            });
        }
        postMessage(msg,...rest) {
            if(msg.type==='get_version'){qa.version='requested'; this.requests.set(msg.id,'get_version')}
            if(msg.type==='find_plan'){
                const p=JSON.parse(msg.payload);
                window.plannerPayloads.push({input:p,routeWitness:msg.routeWitness});
                qa.inputs.push({at:performance.now(),setup:p.aniimo.split(':')[0],facilities:p.facilities,
                    members:p.roster?.members?.length,continuous:p.always_running,
                    dispatch:Object.keys(p.roster?.dispatch||{}).length,priorities:p.priorities});
                this.requests.set(msg.id,true);
            }
            super.postMessage(msg,...rest);
        }
    };
};

async function run(rv,profile) {
    const {browserContextId}=await send('Target.createBrowserContext',{disposeOnDetach:true});
    try {
        const {targetId}=await send('Target.createTarget',{url:'about:blank',browserContextId});
        const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
        const evaluate=async expression=>{
            const reply=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
            if(reply.exceptionDetails)throw Error(reply.exceptionDetails.exception?.description||reply.exceptionDetails.text);
            return reply.result.value;
        };
        const wait=async(expression,timeout)=>{
            const deadline=Date.now()+timeout;
            while(Date.now()<deadline){
                if(args['save-inputs'])await saveInputs();
                if(await evaluate(expression))return;
                await delay(250);
            }
            await saveInputs();
            throw Error('Timed out waiting for '+expression+'; '+JSON.stringify(await evaluate('window.plannerQa')));
        };
        let savedInputs=0;
        const saveInputs=async()=>{
            if(!args['save-inputs'])return;
            const count=await evaluate('window.plannerPayloads?.length??0');
            if(count<=savedInputs)return;
            const payloads=await evaluate('window.plannerPayloads');
            await writeFile(args.out+'/'+profile+'-rv'+rv+'-inputs.json',JSON.stringify(payloads));
            savedInputs=payloads.length;
        };
        const config=configuration(profile,rv);
        await send('Page.enable',{},sessionId);
        await send('Page.addScriptToEvaluateOnNewDocument',{source:'('+observe.toString()+')('+JSON.stringify(config)+')'},sessionId);
        await send('Page.navigate',{url:args.origin},sessionId);
        await wait("window.plannerQa && (plannerQa.errors.length || document.querySelector('#optimize-btn:enabled'))",30000);
        assert.deepEqual(await evaluate('plannerQa.errors'),[]);
        assert.equal(await evaluate("document.querySelector('#home-level').value"),String(rv));
        await evaluate(`{
            const button=document.querySelector('#optimize-btn');
            new MutationObserver(()=>{if(!button.disabled)plannerQa.ready=performance.now()})
                .observe(button,{attributes:true,attributeFilter:['disabled']});
            plannerQa.clicked=performance.now();
            button.click();
        }`);
        await wait("plannerQa.plans.length || plannerQa.errors.length || document.querySelector('#error-message')?.innerText.trim()",1000*Number(args.timeout));
        if(!args['plan-only']) await wait("!document.querySelector('#optimize-btn').disabled",1000*Number(args.timeout));
        const readyAt=await evaluate('performance.now()');
        const qa=await evaluate('window.plannerQa');
        await saveInputs();
        assert.deepEqual(qa.errors,[]);
        assert.ok(qa.plans.length,await evaluate("document.querySelector('#error-message').innerText"));
        const expected=rosters[profile]?'roster':profile;
        for(const actual of qa.inputs) {
            assert.equal(actual.setup,expected);
            assert.equal(actual.continuous,true);
            assert.deepEqual(actual.facilities.Farmland,config.facilityTiers.Farmland);
            if(rosters[profile])assert.equal(actual.members,config.roster.length);
        }
        for(const plan of qa.plans){
            assert.ok(plan.success,plan.error);
            assert.equal(plan.checked,true);
            assert.ok(plan.rate>0 && Number.isFinite(plan.rate) && plan.producing>0);
            assert.ok(!plan.fallback,plan.fallback);
        }
        const final=qa.plans.at(-1),first=qa.clicked;
        const report={rv,profile,firstSeconds:(qa.plans[0].at-first)/1000,finalSeconds:(final.at-first)/1000,
            visibleMap:await evaluate("!!document.querySelector('#layout-diagram .layout-svg')"),
            readySeconds:args['plan-only']?null:((qa.ready??readyAt)-first)/1000,
            ...qa};
        await writeFile(args.out+'/'+profile+'-rv'+rv+'.json',JSON.stringify(report,null,2));
        console.log(rv,profile,'coins/day',final.rate*86400,'first',report.firstSeconds,'final',report.finalSeconds,
            'button ready',report.readySeconds,'map',report.visibleMap);
    } finally {
        await send('Target.disposeBrowserContext',{browserContextId});
    }
}
try {
    for(const rv of levels)for(const profile of profiles)await run(rv,profile);
} finally {
    ws.close();
}
