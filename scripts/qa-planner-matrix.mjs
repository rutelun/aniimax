// Run against a served web/ directory and a Chromium browser with local CDP enabled.
// E.g. node scripts/qa-planner-matrix.mjs --rv=3,12 --profile=best,my-small --plan-only
// For a batch, use --rv=all --season=both --reference-origin=<published build>
// --origin=<candidate> and optionally --variant=label=<another build>.
// --switch-upgrade compares level-up then coins with five switching buildings.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {SEASONS,simpleSetup} from '../web/facility-config.js';

const {values:args} = parseArgs({options:{
    origin:{type:'string',default:'http://127.0.0.1:8082/'}, cdp:{type:'string',default:'http://127.0.0.1:9231'},
    rv:{type:'string',default:'3,12,16,20,21,22'}, profile:{type:'string',default:'best,minimum,my-small,my-mixed'},
    timeout:{type:'string',default:'600'}, out:{type:'string',default:'target/qa-planner-matrix'},
    season:{type:'string',default:'off'}, 'reference-origin':{type:'string'}, repeats:{type:'string',default:'1'},
    variant:{type:'string',multiple:true,default:[]},
    'switch-upgrade':{type:'boolean',default:false}, 'plan-only':{type:'boolean',default:false}, 'save-inputs':{type:'boolean',default:false},
}});
const catalog = JSON.parse(await readFile(new URL('../web/aniimo-catalog.json',import.meta.url))).entries;
const rosters = {
    'my-small':['sparki-forest','ignitis-prismana','bailite','shrubclaw','whirlbite-prismana'],
    'my-mixed':['ignitis-prismana','ignitis-prismana','prawnch','gachapus-prismana','fenmane-prismana',
        'shrubclaw','glynsera-prismana','sparki-forest','blazen','whirlbite-prismana'],
};
const levels=args.rv==='all'?Array.from({length:22},(_,i)=>i+1):args.rv.split(',').map(Number);
const profiles=args.profile.split(','), repeats=Number(args.repeats);
const event=SEASONS.find(s=>s.id==='magical_wonder_night');
const seasons=args.season==='both'?['off',event.id]:args.season.split(',');
const builds=new Map([['candidate',args.origin]]);
if(args['reference-origin'])builds.set('reference',args['reference-origin']);
for(const option of args.variant){
    const match=/^([a-z][a-z0-9-]*)=(https?:\/\/.+)$/.exec(option);
    assert.ok(match&&!builds.has(match[1]),'Expected a unique --variant=label=http(s)://... entry');
    builds.set(match[1],new URL(match[2]).href);
}
assert.ok(seasons.every(season=>season==='off'||season===event.id));
assert.ok(Number.isSafeInteger(repeats)&&repeats>=1);
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
function configuration(profile,rv,season) {
    const ids=rosters[profile] || [], unique=[...new Set(ids)];
    const roster=unique.map(id=>{
        const member=catalog.find(m=>m.id===id);
        assert.ok(member,id);
        return {...member,catalogId:id,count:ids.filter(x=>x===id).length,personalities:[]};
    });
    return {'home-level':String(rv), customBuildings:false, facilityTiers:simpleSetup(rv).facilities,
        roster,rosterSlots:ids.map(id=>unique.indexOf(id)), 'aniimo-best':profile==='best',
        'aniimo-minimum':profile==='minimum','aniimo-custom':ids.length>0, 'season-on':season!=='off',
        ...(season==='off'?{}:{'season-event':season,seasonBudgets:{[season]:2000},
            seasonCropMinimums:{magic_pumpkin:2,memory_lanternfruit:2}}),
        'electricity-on':rv>=12,'layout-sim-on':false,
        ...(args['switch-upgrade']?{'recipe-switching-buildings':'5','recipe-switching-switches':'2'}:{}),
        priorities:[
            ...(args['switch-upgrade']?[{target:'level_up',on:true}]:[]),
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
                    upper:p.upper_bound,goals:p.comparison_goals,scores:p.comparison_scores,eta:p.level_up_preview?.seconds,
                    checked:p.continuous_production_checked,priorities:p.priorities,scheduled:!!p.recipe_schedule,
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
                    season:p.season,seasonMinimums:p.season_crop_minimums,switching:p.recipe_switching,
                    members:p.roster?.members?.length,continuous:p.always_running,
                    dispatch:Object.keys(p.roster?.dispatch||{}).length,priorities:p.priorities});
                this.requests.set(msg.id,true);
            }
            super.postMessage(msg,...rest);
        }
    };
};

async function run(rv,profile,season,origin,reportName) {
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
            await writeFile(args.out+'/'+reportName+'-inputs.json',JSON.stringify(payloads));
            savedInputs=payloads.length;
        };
        const config=configuration(profile,rv,season);
        await send('Page.enable',{},sessionId);
        await send('Page.addScriptToEvaluateOnNewDocument',{source:'('+observe.toString()+')('+JSON.stringify(config)+')'},sessionId);
        await send('Page.navigate',{url:origin},sessionId);
        await wait("window.plannerQa && (plannerQa.errors.length || document.querySelector('#optimize-btn:enabled'))",30000);
        assert.deepEqual(await evaluate('plannerQa.errors'),[]);
        assert.equal(await evaluate("document.querySelector('#home-level').value"),String(rv));
        // Event crop fields are populated after the recipe index finishes loading.
        if(season!=='off'){
            const expected=JSON.stringify(config.seasonCropMinimums);
            await wait(`Object.entries(${expected}).every(([crop,count]) =>
                Number(document.getElementById('season-minimum-'+crop)?.value)===count)`,30000);
        }
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
            if(args['switch-upgrade']){
                assert.deepEqual(actual.switching,{max_buildings:5,max_switches:2});
                if(rv<22)assert.equal(actual.priorities[0],'level_up');
            }
            assert.equal(actual.season??null,season==='off'?null:season);
            if(season!=='off')assert.deepEqual(actual.seasonMinimums,config.seasonCropMinimums);
            assert.deepEqual(actual.facilities.Farmland,config.facilityTiers.Farmland);
            if(rosters[profile])assert.equal(actual.members,config.roster.length);
        }
        for(const [index,plan] of qa.plans.entries()){
            const phase=qa.inputs[index]?.dispatch ? 'measured delivery routes' : 'initial production';
            assert.ok(plan.success,phase+' — '+(plan.error || 'no plan'));
            assert.equal(plan.checked,true);
            assert.ok(plan.rate>0 && Number.isFinite(plan.rate) && plan.producing>0);
            assert.ok(!plan.fallback,plan.fallback);
        }
        const final=qa.plans.at(-1),first=qa.clicked;
        const displayedCoinsPerDay=args['plan-only']?null:await evaluate(`(() => {
            const unit=document.querySelector('#rate-unit');
            unit.value='day';
            unit.dispatchEvent(new Event('change'));
            const digits=document.querySelector('#plan-rate').textContent.replace(/[^0-9.-]/g,'');
            return digits ? Number(digits) : null;
        })()`);
        if(!args['plan-only'])assert.ok(Number.isFinite(displayedCoinsPerDay));
        const report={rv,profile,season,origin,displayedCoinsPerDay,firstSeconds:(qa.plans[0].at-first)/1000,finalSeconds:(final.at-first)/1000,
            visibleMap:await evaluate("!!document.querySelector('#layout-diagram .layout-svg')"),
            readySeconds:args['plan-only']?null:((qa.ready??readyAt)-first)/1000,
            ...qa};
        await writeFile(args.out+'/'+reportName+'.json',JSON.stringify(report,null,2));
        console.log(reportName,'coins/day',final.rate*86400,'first',report.firstSeconds,'final',report.finalSeconds,
            'button ready',report.readySeconds,'map',report.visibleMap);
        return report;
    } finally {
        await send('Target.disposeBrowserContext',{browserContextId});
    }
}
try {
    let sequence=0;
    for(let repetition=1;repetition<=repeats;repetition++)for(const rv of levels)for(const profile of profiles)for(const season of seasons){
        if(season!=='off'&&rv<event.minHomeLevel)continue;
        const name=profile+'-rv'+rv+(season==='off'?'':'-'+season)+(repeats>1?'-run'+repetition:'');
        const order=[...builds], offset=sequence++%order.length;
        const reports=new Map();
        for(const [label,origin] of [...order.slice(offset),...order.slice(0,offset)]){
            const reportName=builds.size===1 ? name : name+'-'+label;
            try {
                reports.set(label,await run(rv,profile,season,origin,reportName));
            } catch(error) {
                process.exitCode=1;
                const message=String(error?.message??error);
                await writeFile(args.out+'/'+reportName+'-error.json',JSON.stringify({rv,profile,season,origin,message}));
                console.error(reportName,message);
            }
        }
        const metric=args['plan-only']?'firstSeconds':'readySeconds';
        const reference=reports.get('reference');
        if(reference)for(const [label,report] of reports){
            if(label==='reference')continue;
            console.log(name,label,metric,'speedup',reference[metric]/report[metric]);
            if(args['switch-upgrade']){
                const before=reference.plans.at(-1),after=report.plans.at(-1);
                const incomeLost=after.rate < before.rate-1e-8*Math.max(1,Math.abs(before.rate));
                const slowerUpgrade=Number.isFinite(before.eta)
                    && (!Number.isFinite(after.eta) || after.eta > before.eta+1e-8*Math.max(1,before.eta));
                if(incomeLost || slowerUpgrade || report.displayedCoinsPerDay < reference.displayedCoinsPerDay){
                    process.exitCode=1;
                    console.error(name,label,'income',before.rate,after.rate,'upgrade seconds',before.eta,after.eta);
                }
            }
        }
    }
} finally {
    ws.close();
}
