// Continuous (fractional batch) schedules for independent workshop chains.
// One site changes from the raw recipe to tier 3. The other three keep
// processing as long as their input is available.
const EPS=1e-8;
export const materialChains={
    'Woodworking Bench':['rough_lumber','standard_planks','laminated_beams','densified_timber_component'],
    'Chimney Kiln':['coarse_sifted_ore','sintered_ore_brick','refined_ore','microcrystalline_ore_plate'],
};
// Each material chain unlocks its second recipe at workshop level two.
export function switchingWorkshops(input) {
    if (input.fixed_homeland) return [];
    return Object.keys(materialChains).filter(facility =>
        input.facilities?.[facility]?.some(tier => tier.count > 0 && tier.level >= 2));
}

export function independentMaterialChains(input, allowMixed = false) {
    if(!input.alwaysRunning||!input.approximate||!input.jobs.length)return null;
    const groups=new Map();
    for(const job of input.jobs) {
        const index=materialChains[job.facility]?.indexOf(job.recipe)??-1;
        if(index<0||(!allowMixed&&job.electric_level!=null))return null;
        if(!groups.has(job.facility))groups.set(job.facility,[]);
        const group=groups.get(job.facility);
        if(group[index]){
            const sameTerms=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.entries(a).every(([k,v])=>b[k]===v);
            if(!allowMixed||!sameTerms(group[index].inputs,job.inputs)||!sameTerms(group[index].outputs,job.outputs))return null;
        }
        group[index]=job;
    }
    for(const [facility,jobs] of groups) {
        let previous=facility==='Woodworking Bench'?'wood_block':'mineral_sand';
        for(let i=0;i<4;i++) {
            const j=jobs[i];
            if(!j||Object.keys(j.inputs).length!==1||!(j.inputs[previous]>0)
                ||Object.keys(j.outputs).length!==1||j.outputs[j.recipe]!==1)return null;
            if(input.backgroundInputs?.[previous]>0||input.backgroundInputs?.[j.recipe]>0||input.backgroundOutputs?.[j.recipe]>0)return null;
            previous=j.recipe;
        }
    }
    return groups;
}

// The input stock at dawn for a periodically fed machine with spare capacity
// is the largest excess of arrivals over capacity in any suffix of yesterday.
export function processStage(supply,capacity,quantity) {
    const intervals=[];
    let stock=0,net=0;
    for(const period of supply) {
        const demand=capacity(period)*quantity;
        const delta=(period.rate-demand)*(period.end-period.start);
        net+=delta;
        stock=Math.max(0,stock+delta);
    }
    if(net>EPS)return null;
    const initial=stock;
    for(const period of supply) {
        const {start,end,rate}=period,maximum=capacity(period);
        const deficit=maximum*quantity-rate;
        const fullUntil=deficit>0?Math.min(end,start+stock/deficit):end;
        if(fullUntil>start)intervals.push({start,end:fullUntil,rate:maximum});
        if(fullUntil<end)intervals.push({start:fullUntil,end,rate:rate/quantity});
        stock=Math.max(0,stock-deficit*(end-start));
    }
    return {initial,intervals};
}

function assignSites(input,facility,jobs,switchTier,extra) {
    const sites=input.buildings.filter(b=>b.facility===facility);
    const accepts=(b,j)=>(b.electric_level??null)===(j.electric_level??null)&&b.recipes.includes(j.recipe)&&(!b.jobs||b.jobs.includes(j.id));
    // Reserve the most restrictive (high-tier) jobs first.
    const assigned=[];
    for(const tier of [3,2,1,0]) {
        const at=sites.findIndex(b=>accepts(b,jobs[tier])&&(tier!==switchTier||accepts(b,extra)));
        if(at<0)return null;
        assigned[tier]=sites.splice(at,1)[0];
    }
    return assigned;
}

// Sites in the other workshop may keep their recipes throughout the day.
// A partially busy fixed site needs an exhausted ingredient in every phase.
function steadyChain(input,facility,jobs) {
    const day=input.daySeconds;
    let supply=input.backgroundOutputs?.[Object.keys(jobs[0].inputs)[0]]??0;
    const profiles=[];
    for(const job of jobs){
        const rate=job.batches/day, load=rate*job.seconds;
        const used=rate*Object.values(job.inputs)[0];
        if(load>1+EPS || used>supply+EPS || (load<1-EPS && Math.abs(used-supply)>EPS))return null;
        profiles.push([{start:0,end:day,rate}]);
        supply=rate;
    }
    const assigned=assignSites(input,facility,jobs);
    return assigned?{assigned,jobs,profiles,initialStock:{}}:null;
}

function scheduleChain(input,facility,jobs,switchTier,extraRaw) {
    const initialStock={};
    const day=input.daySeconds,raw=jobs[0];
    const extra=extraRaw??raw;
    if(extraRaw && Math.abs(raw.batches*raw.seconds-day)>EPS*day)return null;
    const change=extraRaw?extra.batches*extra.seconds:raw.batches*raw.seconds-day;
    if(change<=EPS||change>=day-EPS)return null;
    const assigned=assignSites(input,facility,jobs,switchTier,extra);
    if(!assigned)return null;
    const rawInput=Object.keys(raw.inputs)[0],quantity=raw.inputs[rawInput];
    const income=input.backgroundOutputs?.[rawInput]||0;
    const batches=raw.batches+(extraRaw?.batches??0);
    if(income*day+EPS<batches*quantity)return null;
    const peak=1/raw.seconds+1/extra.seconds;
    const reserve=Math.max(0,(peak*quantity-income)*change);
    if(reserve>EPS)initialStock[rawInput]=reserve;
    const profiles=[[{start:0,end:change,rate:peak},{start:change,end:day,rate:1/raw.seconds}]];
    for(let i=1;i<jobs.length;i++) {
        const j=jobs[i],ingredient=jobs[i-1].recipe;
        const next=processStage(profiles[i-1],p=>i===switchTier&&p.start<change?0:1/j.seconds,j.inputs[ingredient]);
        if(!next)return null;
        if(next.initial>EPS)initialStock[ingredient]=next.initial;
        profiles.push(next.intervals);
    }
    return {assigned,jobs,profiles,change,switchTier,initialStock,extra};
}

// Construct the two physical chains independently. Crew and hauling are checked
// against their combined phases, after each workshop has its own timetable.
export function* materialFlowSchedules(input) {
    const groups=independentMaterialChains(input,true);
    if(!groups)return;
    const choices=[];
    for(const [facility,jobs] of groups) {
        const sources=input.jobs.filter(j=>j.facility===facility);
        const raw=sources.filter(j=>j.recipe===jobs[0].recipe);
        if(sources.length!==3+raw.length || raw.length>2)return;
        let extra;
        if(raw.length===2){
            const steady=raw.find(j=>Math.abs(j.seconds*j.batches-input.daySeconds)<=EPS*input.daySeconds);
            if(!steady)return;
            jobs[0]=steady;
            extra=raw.find(j=>j!==steady);
        }
        const steady=!extra && steadyChain(input,facility,jobs);
        const options=steady?[steady]:[2,1,3].map(tier=>scheduleChain(input,facility,jobs,tier,extra)).filter(Boolean);
        if(!options.length)return;
        choices.push(options);
    }
    const combinations=choices.reduce((partial,options)=>partial.flatMap(chains=>
        options.map(option=>[...chains,option])),[[]]);
    for(const chains of combinations){
        const schedule=combineChains(input,chains);
        if(schedule)yield schedule;
    }
}

export function materialFlowSchedule(input) {
    return materialFlowSchedules(input).next().value??null;
}

function combineChains(input,chains) {
    const initialStock=Object.assign({},...chains.map(chain=>chain.initialStock));
    const changes=chains.filter(c=>c.change!=null);
    if(changes.length>input.maxBuildings || new Set(changes.map(c=>c.change)).size>input.maxSwitches)return null;
    const cuts=[...new Set(chains.flatMap(c=>c.profiles.flatMap(profile=>profile.map(p=>p.end))))].sort((a,b)=>a-b);
    const phases=[];
    let start=0;
    for(const end of cuts) {
        const duration=end-start,mid=start+duration/2,assignments=[];
        for(const {jobs,profiles,assigned,change,switchTier,extra} of chains) {
            for(let tier=0;tier<4;tier++) {
                if(tier===switchTier&&mid<change)continue;
                const rate=profiles[tier].find(p=>mid>=p.start&&mid<=p.end)?.rate;
                if(rate==null)return null;
                if(tier===0 && mid<change){
                    assignments.push({building:assigned[0].id,job:jobs[0].id,batches:duration/jobs[0].seconds},
                        {building:assigned[switchTier].id,job:extra.id,batches:duration/extra.seconds});
                }else assignments.push({building:assigned[tier].id,job:jobs[tier].id,batches:rate*duration});
            }
        }
        phases.push({duration,assignments});
        start=end;
    }
    return {approximate:true,materialFlow:true,phases,initialStock};
}
