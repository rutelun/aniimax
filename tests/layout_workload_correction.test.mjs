import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {workerTravelDistances} from '../web/worker-travel.js';

const source = await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const movementCode = source.slice(source.indexOf('function refineWorkerMovement('),source.indexOf('let rosterFillVersion'));
const haulingCode = source.slice(source.indexOf('function haulingRouteBound('),source.indexOf('function refineWorkerMovement('));
const site = (x, worker) => ({x,y:0,w:2,h:2,workers:[[worker,10]]});
const layout = (distance, worker = 0) => ({pieces:[{members:[site(0,worker),site(distance,worker)]}]});

function page() {
    let updates = 0;
    const context = {workerTravelDistances,workerTravelEnabled:()=>true,selectedSetupTab:()=> 'custom',
        homelandPlots:()=>[{number:1,x:0,y:0,w:100,h:60}],layoutHomeLevel:()=>1,ANIIMO_WALK_SPEED:4,
        stopRanking(){},switchAniimoSetup:()=>updates++,showError:message=>assert.fail(message),
        recipeIndex:[],rosterWorkload:()=>({members:[],busy:[]}),
        haulingWorkload:()=>({seconds:{'Mine|rock':1},busyByLevel:{3:1}}),
        allocateHauling:()=>({unassigned:1}),
    };
    const run = code => runInNewContext(code,context);
    run(`let movementDistances={},movementDefaultDistance=20,travelRefinements=0;
        let haulingDefaultSeconds=0,haulingRefinements=0,haulingSeconds={};
        const haulingBaseByPlan=new WeakMap(); const lastPlanInput={electricity:{max_aniimo:1}};
        ${movementCode} ${haulingCode}`);
    return {context,run,updates:()=>updates};
}

test('a shorter route does not restart the completed optimization', () => {
    const p = page();
    p.context.layout=layout(10);
    assert.equal(p.run('refineWorkerMovement(layout,{mobile_work:[1]})'),false);
    assert.equal(p.updates(),0);
});

test('one correction covers later placements and newly used reserve workers', () => {
    const p = page();
    p.context.layout=layout(50);
    assert.equal(p.run('refineWorkerMovement(layout,{mobile_work:[1]})'),true);
    assert.ok(p.run('movementDefaultDistance')>=Math.hypot(100,60));
    p.context.layout=layout(98,12);
    assert.equal(p.run('refineWorkerMovement(layout,{mobile_work:[1]})'),false);
    assert.equal(p.updates(),1);
});

test('a delivery shortage uses one full-map correction and accepts the checked courier allocation', () => {
    const p = page();
    p.context.plan={assumed_aniimo:[],coin_items:[]};
    assert.equal(p.run('assignLayoutHauling({},plan)'),true);
    assert.equal(p.run('Object.keys(haulingSeconds).length'),0);
    assert.ok(p.run('haulingDefaultSeconds')>=2*Math.hypot(100,60)/4);
    p.context.plan={assumed_aniimo:[],coin_items:[],hauling_staffing:[[0,1]]};
    assert.equal(p.run('assignLayoutHauling({},plan)'),false);
    assert.deepEqual(p.context.plan.delivery_assignments,[[0,1]]);
    assert.equal(p.updates(),1);
});
