// Compare physical networks at the solved output. A lower supply percentage
// consumes spare machine time, never silently lowers the promised production.
import { powerLinked, powerCoverage, connectPower } from './power-layout.js';
import { createInsideTest } from './layout.js';

const EPS=1e-6;
const center=r=>({x:r.x+r.w/2,y:r.y+r.h/2});
const overlap=(a,b)=>a.x<b.x+b.w-EPS&&b.x<a.x+a.w-EPS&&a.y<b.y+b.h-EPS&&b.y<a.y+a.h-EPS;
const heavy=new Set(['Mine','Well','Aniipod Maker','Dance Pad Polisher']);
const light=new Set(['Carousel Mill','Crafting Table','Jukebox Dryer','Claw Game Cooker','Joy Wheel Loom',
    'Phonolfactory Table','Bouncy Brew Keg','Simmering Pot','Blazing Stove','Woodworking Bench','Chimney Kiln','Pickling Jar']);
const rated=m=>(heavy.has(m.facility)?30:light.has(m.facility)?15:NaN)*m.electric_level;
const minimum=m=>120*(m.schedulePeak??(m.jobs?.length?m.jobs.reduce((s,j)=>s+(j.rate!=null&&j.cycle>0?j.rate*j.cycle:j.load??1),0):m.load??1));

export function analyzePowerNetworks(layout){
    const members=layout.pieces.flatMap(p=>p.members),generators=members.filter(m=>m.generator);
    const consumers=members.filter(m=>m.electric_level!=null),poles=layout.power?.poles??[];
    const relays=[...generators,...poles],remaining=new Set(relays),components=[],links=[];
    while(remaining.size){
        const root=remaining.values().next().value,group=[root];remaining.delete(root);
        for(let i=0;i<group.length;i++)for(const next of remaining)if(powerLinked(group[i],next)){
            remaining.delete(next);group.push(next);links.push({from:center(group[i]),to:center(next)});
        }
        components.push({relays:group,consumers:[]});
    }
    for(const m of consumers){
        m.power_networks=[];
        components.forEach((c,i)=>{
            const parent=c.relays.find(r=>powerLinked(r,m));
            if(parent){c.consumers.push(m);m.power_networks.push(i);links.push({from:center(parent),to:center(m)});}
        });
    }
    const networks=components.map((c,id)=>{
        const gens=c.relays.filter(m=>m.generator),generated=gens.reduce((s,g)=>s+(g.generatedWatts??NaN),0);
        const draw=c.consumers.reduce((s,m)=>s+rated(m),0);
        const percent=Number.isFinite(generated)&&Number.isFinite(draw)&&generated>0?Math.min(120,draw>0?generated/draw*100:120):0;
        for(const g of gens){g.power_generator_id=generators.indexOf(g)+1;g.power_networks=[id];}
        return {id,generated,rated:draw,percent,generators:gens.length,generator_ids:gens.map(g=>g.power_generator_id),consumers:c.consumers.length,
            required:Math.max(0,...c.consumers.map(minimum))};
    });
    for(const m of consumers){
        // A consumer touching two separate grids is charged to both. Do not
        // invent power sharing through a building which cannot relay power.
        m.power_percent=m.power_networks.length?Math.min(...m.power_networks.map(i=>networks[i].percent)):0;
        m.power_connected=m.power_percent>0&&m.power_percent+EPS>=minimum(m);
    }
    const orphanPoles=components.filter(c=>!c.relays.some(r=>r.generator)).reduce((s,c)=>s+c.relays.length,0);
    layout.power={...layout.power,islands:true,poles,links,networks,generators:generators.length,consumers:consumers.length,
        disconnected:consumers.filter(m=>!m.power_connected).length+orphanPoles,
        coverage:components.flatMap((c,i)=>c.relays.map(m=>({...powerCoverage(m),connected:networks[i].generated>0,network:i})))};
    return layout;
}

// The same recipe can run on several physical buildings and networks. Keep the
// per-generator breakdown rather than averaging away a slower machine.
export function powerJobDetails(layout,step){
    if(step.electric_level==null||!layout?.power?.networks)return [];
    return layout.pieces.flatMap(p=>p.members).filter(m=>m.facility===step.facility&&m.electric_level===step.electric_level)
        .flatMap(m=>(m.jobs??[{item:m.crop,cycle:m.cycle,load:m.load}]).filter(j=>j.item===step.item_name).map(j=>{
            const factor=m.power_percent>0?120/m.power_percent:1;
            return {cycle:j.cycle*factor,load:(j.rate!=null?j.rate*j.cycle:j.load??1)*factor,
                percent:m.power_percent,networks:(m.power_networks??[]).map(i=>layout.power.networks[i])};
        }));
}

export function optimizePowerNetworks(input,cells,maximum){
    const members=input.pieces.flatMap(p=>p.members),generators=members.filter(m=>m.generator);
    if(generators.length<2||generators.some(g=>!(g.generatedWatts>0))||!members.some(m=>m.electric_level!=null))return input;
    let best=analyzePowerNetworks(structuredClone(input));
    const score=l=>[l.power.disconnected,l.power.poles.length,l.power.links.reduce((s,e)=>s+Math.hypot(e.from.x-e.to.x,e.from.y-e.to.y),0)];
    const better=(a,b)=>{const x=score(a),y=score(b);for(let i=0;i<x.length;i++)if(Math.abs(x[i]-y[i])>EPS)return x[i]<y[i];return false;};
    const consider=trial=>{analyzePowerNetworks(trial);if(!trial.power.disconnected&&better(trial,best))best=trial;};
    // Cutting unnecessary bridges is cheap and keeps the production layout intact.
    for(let pass=0;pass<2;pass++)for(let i=best.power.poles.length-1;i>=0;i--){
        const trial=structuredClone(best);trial.power.poles.splice(i,1);consider(trial);
    }
    const inside=createInsideTest(cells);
    for(const axis of [null,'x','y']){
        const trial=structuredClone(input),all=trial.pieces.flatMap(p=>p.members);
        const gens=all.filter(m=>m.generator),consumers=all.filter(m=>m.electric_level!=null);
        if(axis){
            consumers.sort((a,b)=>center(a)[axis]-center(b)[axis]);
            for(let i=0;i<gens.length;i++){
                const targets=consumers.slice(Math.floor(i*consumers.length/gens.length),Math.floor((i+1)*consumers.length/gens.length));
                if(!targets.length)continue;
                const cx=targets.reduce((s,r)=>s+center(r).x,0)/targets.length,cy=targets.reduce((s,r)=>s+center(r).y,0)/targets.length;
                const g=gens[i],blocked=[...all.filter(m=>m!==g),...trial.storages];let spot=null;
                for(let dx=-7;dx<=7;dx++)for(let dy=-7;dy<=7;dy++){
                    const r={...g,x:Math.round(cx-g.w/2)+dx,y:Math.round(cy-g.h/2)+dy};
                    const cost=targets.reduce((s,t)=>s+Math.hypot(center(r).x-center(t).x,center(r).y-center(t).y),0);
                    if(spot&&cost>=spot.cost||!inside(r)||blocked.some(b=>overlap(b,r)))continue;
                    spot={r,cost};
                }
                if(spot)Object.assign(g,spot.r);
            }
        }
        connectPower(trial,cells,maximum,false,()=>false,null,true,true);
        consider(trial);
    }
    return best.power.disconnected?input:best;
}
