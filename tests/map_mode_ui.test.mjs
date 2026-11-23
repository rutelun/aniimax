import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const optionsFunction=source.slice(source.indexOf('function layoutOptionsFor('),source.indexOf('\nfunction rememberLayout('));
test('both visible map modes build a worker request and distinct cache keys without removed controls',()=>{
    const context=vm.createContext({storageUnitLimit:()=>5,powerPoleLimit:()=>12,numberOrDefault:(v,d)=>v===''?d:Number(v),
        document:{getElementById:id=>{assert.equal(id,'layout-storage-count');return {value:''};}},
        selectedSetupTab:()=> 'minimum',layoutStyle:()=>context.style,
        homelandPlots:()=>[{number:1,x:0,y:0,w:20,h:15}],style:'delivery'});
    vm.runInContext(optionsFunction,context);
    const delivery=context.layoutOptionsFor({},15);
    context.style='groups';const grouped=context.layoutOptionsFor({},15);
    assert.equal(delivery.storageCount,5);assert.equal(grouped.storageCount,5);
    assert.equal(delivery.style,'delivery');assert.equal(grouped.style,'groups');
    assert.notEqual(delivery.key,grouped.key);
});


test('the measured map preview uses the roster dispatch that the completed plan will display',async()=>{
    const previewFunction=source.slice(source.indexOf('function prepareOrdinaryRoute('),source.indexOf('async function refineMappedPowerTeam('));
    let request;
    const previous={ore:[{member:1,share:1}]}, measured={ore:[{member:2,share:1}]};
    const context=vm.createContext({AbortController,planRunId:1,selectedAniimoSetup:()=>'roster-key',
        selectedSetupTab:()=>'custom',discardRoutePreview(){},routePreview:null,layoutHomeLevel:()=>21,
        layoutOptionsFor:()=>({key:'groups',staffing:{dispatch:previous}}),homelandPieces:()=>({pieces:[]}),
        lastPlanInput:{},WORKER_URL:'worker.js',runMapWorker:async(url,message)=>{request=message;return {};},
    });
    vm.runInContext(previewFunction,context);
    for(const [policy,expected] of [[measured,measured],[{},previous]]){
        context.prepareOrdinaryRoute(JSON.stringify({roster_dispatch:policy}),'roster-key',1,true);
        await context.routePreview.measured;
        assert.deepEqual(JSON.parse(JSON.stringify(request.staffing.dispatch)),expected);
        assert.equal(previous.ore[0].member,1);
    }
});
