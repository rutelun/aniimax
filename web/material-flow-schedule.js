// Continuous (fractional batch) schedules for independent workshop chains.
// One site changes from the raw recipe to tier 3. The other three keep
// processing as long as their input is available.
const EPS=1e-8;
export const materialChains={
    'Woodworking Bench':['rough_lumber','standard_planks','laminated_beams','densified_timber_component'],
    'Chimney Kiln':['coarse_sifted_ore','sintered_ore_brick','refined_ore','microcrystalline_ore_plate'],
};
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

function scheduleChain(input,facility,jobs,initialStock) {
    const day=input.daySeconds,raw=jobs[0];
    const change=raw.batches*raw.seconds-day;
    if(change<=EPS||change>=day-EPS)return null;
    const sites=input.buildings.filter(b=>b.facility===facility&&b.electric_level==null);
    const accepts=(b,j)=>b.recipes.includes(j.recipe)&&(!b.jobs||b.jobs.includes(j.id));
    // Reserve the most restrictive (high-tier) jobs first.
    const assigned=[];
    for(const tier of [3,2,1,0]) {
        const at=sites.findIndex(b=>accepts(b,jobs[tier])&&(tier!==2||accepts(b,raw)));
        if(at<0)return null;
        assigned[tier]=sites.splice(at,1)[0];
    }
    const rawInput=Object.keys(raw.inputs)[0],quantity=raw.inputs[rawInput];
    const income=input.backgroundOutputs?.[rawInput]||0;
    if(income*day+EPS<raw.batches*quantity)return null;
    const reserve=Math.max(0,(2*quantity/raw.seconds-income)*change);
    if(reserve>EPS)initialStock[rawInput]=reserve;
    const profiles=[[{start:0,end:change,rate:2/raw.seconds},{start:change,end:day,rate:1/raw.seconds}]];
    for(let i=1;i<jobs.length;i++) {
        const j=jobs[i],ingredient=jobs[i-1].recipe;
        const next=processStage(profiles[i-1],p=>i===2&&p.start<change?0:1/j.seconds,j.inputs[ingredient]);
        if(!next)return null;
        if(next.initial>EPS)initialStock[ingredient]=next.initial;
        profiles.push(next.intervals);
    }
    return {assigned,jobs,profiles,change};
}

export function materialFlowSchedule(input) {
    const groups=independentMaterialChains(input);
    if(!groups||groups.size>input.maxBuildings)return null;
    const initialStock={},chains=[];
    for(const [facility,jobs] of groups) {
        const chain=scheduleChain(input,facility,jobs,initialStock);
        if(!chain)return null;
        chains.push(chain);
    }
    if(new Set(chains.map(c=>c.change)).size>input.maxSwitches)return null;
    const cuts=[...new Set(chains.flatMap(c=>c.profiles.flatMap(profile=>profile.map(p=>p.end))))].sort((a,b)=>a-b);
    const phases=[];
    let start=0;
    for(const end of cuts) {
        const duration=end-start,mid=start+duration/2,assignments=[];
        for(const {jobs,profiles,assigned,change} of chains) {
            for(let tier=0;tier<4;tier++) {
                if(tier===2&&mid<change)continue;
                const rate=profiles[tier].find(p=>mid>=p.start&&mid<=p.end)?.rate;
                if(rate==null)return null;
                const sites=tier===0&&mid<change?[assigned[0],assigned[2]]:[assigned[tier]];
                for(const site of sites)assignments.push({building:site.id,job:jobs[tier].id,batches:rate*duration/sites.length});
            }
        }
        phases.push({duration,assignments});
        start=end;
    }
    return {approximate:true,materialFlow:true,phases,initialStock};
}
