import test from 'node:test';
import assert from 'node:assert/strict';
import {productionTeamJobs} from '../web/production-team-jobs.js';
import {recommendBestTeam} from '../web/best-team.js';
import {mappedTeamScore} from '../web/mapped-power-team.js';
import {selectPowerTeam,shortlistPowerTeams} from '../web/power-team-search.js';

const plan = {id:'incumbent'};
test('measured whole-team headcount wins, then working generators break ties',async()=>{
    const candidates=[{id:'larger'},{id:'smaller'},{id:'split'},{id:'tie'}];
    const scores=new Map([['incumbent',[40,1]],['larger',[41,3]],['smaller',[38,1]],['split',[38,2]],['tie',[38,2]]]);
    const best=await selectPowerTeam(plan,candidates,p=>{
        const [people,generators]=scores.get(p.id);
        return {people,generators};
    });
    assert.equal(best,candidates[2]);
});
test('discard stale measurements and skip failed layouts',async()=>{
    let current=true;
    const candidates=[{id:'bad'},{id:'better'},{id:'stale'}];
    const measure=p=>{
        if(p.id==='bad')throw new Error('invalid map');
        if(p.id==='stale')current=false;
        return p===plan?{people:40,generators:1}:{people:38,generators:2};
    };
    assert.equal(await selectPowerTeam(plan,candidates.slice(0,2),measure),candidates[1]);
    assert.equal(await selectPowerTeam(plan,candidates,measure,()=>current),plan);
    assert.equal(await selectPowerTeam(plan,candidates,()=>null),plan);
});
test('unsupported generated-power setups return an empty shortlist',async()=>{
    assert.deepEqual(await shortlistPowerTeams({},null,{},{}),[]);
});

test('a feasible team replaces an incumbent with an invalid map',async()=>{
    const candidate={};
    assert.equal(await selectPowerTeam(plan,[candidate],p=>p===plan?null:{people:45,generators:2}),candidate);
});

test('shortlist measures ordinary powered modes and keeps only native-checked generator counts',async()=>{
    const facility='Chimney Kiln',item='brick';
    const input={e_mode_rv:16,facilities:{[facility]:[{level:1,count:1}]}};
    const role={ability:'Fire',level:1,busy:1};
    const source={facility,item,id:item,facility_level:1,rate:1,cycle:1,turns:false,inputs:[],outputs:[[item,1]],electric_level:null};
    const row={facility,item_name:item,facility_count:1,status:'producing',busy_units:1,cycle_time:1,aniimo:role,aniimo_tasks:[role]};
    const incumbent={schedule_sources:[source],coin_items:[row],comparison_seed:{keys:[],values:[]},
        comparison_goals:{floors:[]},rate_per_second:1,generator_watts_by_lightning:[600]};
    const problem={variable_keys:['rate:brick#0','rate:brick__electric1#0','generators#0'],
        recipe_options:[[0,item,facility,false,false,1],[1,item,facility,false,true,1]],lp:'\nBounds\n'};
    const pkg={exact_problem:()=>JSON.stringify(problem),get_all_items:()=>JSON.stringify([{name:item,facility_level:1,aniimo:['Fire',1]}]),
        exact_plan:()=>JSON.stringify({success:true,rate_per_second:1,priorities:[]})};
    const highs={solve:lp=>lp.includes('hold_2: x2 = 2')?{Status:'Infeasible'}:{Status:'Optimal',Columns:{}}};
    const shortlist=await shortlistPowerTeams(pkg,highs,incumbent,input);
    assert.deepEqual(shortlist.map(p=>[p.power_generators,p.power_used]).sort(),[[0,0],[1,18]]);
});
test('separate working grids break a tie after workers and active generators',async()=>{
    const split={id:'split'},combined={id:'combined'};
    const winner=await selectPowerTeam(plan,[combined,split],p=>({people:9,generators:2,networks:p===split?2:1}));
    assert.equal(winner,split);
});

test('equal mapped teams electrify the workshop that can divert the generator operator',async()=>{
    const recipes=[{name:'brick',facility:'Chimney Kiln',aniimo:['Fire',1]},
        {name:'parts',facility:'Crafting Table',aniimo:['Artisanship',1]}];
    const makePlan=electricItem=>({coin_items:recipes.map(r=>({
        facility:r.facility,item_name:r.name,status:'producing',facility_count:1,
        electric_level:r.name===electricItem?1:null,aniimo_tasks:[{ability:r.aniimo[0],level:4,busy:1}],
    }))});
    const kiln=makePlan('brick'),bench=makePlan('parts');
    const measure=p=>{
        const jobs=productionTeamJobs(p,recipes);
        jobs.push({ability:'Lightning',level:4,busy:1,label:'Generator',facility:'Crackle Generator',fixed:true});
        return mappedTeamScore(recommendBestTeam(jobs),{networks:[{consumers:1,generated:18,generators:1}]},2);
    };
    assert.deepEqual(measure(kiln),{people:2,generators:1,networks:1,distractions:1});
    assert.deepEqual(measure(bench),{people:2,generators:1,networks:1,distractions:0});
    assert.equal(await selectPowerTeam(kiln,[bench],measure),bench);
});
