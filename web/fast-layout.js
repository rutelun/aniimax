// WASM boundary shared by the layout worker and offline benchmarks. No saved
// placements or RV-specific coordinates are used by the search.
import {layoutDeliveryCost,layoutLocalDeliveryCost,layOutHomeland,createInsideTest,refineDistrictDeliveries,improveFixedStorage} from './layout.js';
import {deliveryRouting} from './delivery-routing.js';
import {updatePowerConnections,connectPower} from './power-layout.js';

export function fastLayoutSeed({pieces,cells,storageCount,poleLimit}) {
    let layout=connectPower(layOutHomeland(pieces,cells,{w:2,h:2},storageCount,{fast:true,accountForWorkers:false}),cells,poleLimit);
    if(!cells.length||layout.unplaced.length||layout.power.disconnected)return layout;
    const inside=createInsideTest(cells),x=Math.min(...cells.map(c=>c.x)),y=Math.min(...cells.map(c=>c.y));
    const bounds={x,y,w:Math.max(...cells.map(c=>c.x+c.w))-x,h:Math.max(...cells.map(c=>c.y+c.h))-y};
    layout=refineDistrictDeliveries(layout,[{bounds,reserved:[]}],{passes:1,includeMines:true,costOf:layoutLocalDeliveryCost,canPlace:(_,__,rs)=>rs.every(inside)});
    return improveFixedStorage(layout,cells,0);
}

export function encodeRefinement(layout,cells,options={}) {
    const rectangles=[],climates=[];
    const flow=deliveryRouting(layout);
    for(const piece of layout.pieces){
        const start=rectangles.length,owner=piece.cluster?climates.length:-1;
        if(piece.cluster)climates.push(piece.buildings.map((_,j)=>start+j));
        for(const [j,r] of piece.members.entries())rectangles.push({
            x:r.x,y:r.y,w:r.w,h:r.h,weight:flow.arrivals[start+j].trips,
            arrival_weights:flow.arrivals[start+j].storeWeights,
            owner:piece.cluster&&j>=piece.buildings.length?owner:-1,zone:r.zone||0,
            sensitive:!!r.sensitive,generator:!!r.generator,electric:r.electric_level!=null,
            movable:piece.cluster?j>=piece.buildings.length:piece.members.length===1&&!r.generator,
        });
    }
    const producer_count=rectangles.length;
    for(const r of layout.storages)rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h});
    for(const r of layout.power?.poles||[])rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h,pole:true});
    // Scale exploration by the delivery cost that can still be improved.
    // A busy producer already touching storage must not overheat the search
    // for the many low-throughput buildings which remain far away.
    const weights=rectangles.slice(0,producer_count).filter(r=>r.weight>0).map(r=>{
        let distance=Infinity,floor=Infinity;
        for(const s of layout.storages){
            distance=Math.min(distance,Math.hypot(r.x+r.w/2-s.x-s.w/2,r.y+r.h/2-s.y-s.h/2));
            floor=Math.min(floor,(r.w+s.w)/2,(r.h+s.h)/2);
        }
        return {weight:r.weight,mass:Number.isFinite(distance)?r.weight*Math.max(0,distance-floor):0};
    }).sort((a,b)=>a.weight-b.weight);
    const half=weights.reduce((sum,w)=>sum+w.mass,0)/2;
    let cumulative=0;
    const median=half>0?(weights.find(w=>(cumulative+=w.mass)>=half)?.weight||0):0;
    const temperature=Math.max(1,median/3);
    return {rectangles,climates,producer_count,store_count:layout.storages.length,cells,
        iterations:5000000,seed:1,temperature,penalty:30,mobile_relays:true,...options};
}

export function refineFastLayout(layout,cells,refineJSON,options={}) {
    if(layout.unplaced?.length||layout.power?.disconnected||!layout.storages.length)return layout;
    const result=JSON.parse(refineJSON(JSON.stringify(encodeRefinement(layout,cells,options))));
    const out=structuredClone(layout),all=[...out.pieces.flatMap(p=>p.members),...out.storages,...out.power?.poles||[]];
    if(result.poses.length!==all.length)throw new Error('Refinement changed the building count');
    result.poses.forEach(([x,y,w,h],i)=>Object.assign(all[i],{x,y,w,h}));
    updatePowerConnections(out);
    return out.power.disconnected||layoutDeliveryCost(out)>layoutDeliveryCost(layout)+1e-8?layout:out;
}

// Follow the broad search with a small exchange neighborhood and deterministic
// polishing. Every stage retains the previous feasible result unless it wins.
export function polishFastLayout(layout,seed,cells,refineJSON) {
    if(layout.unplaced?.length||layout.power?.disconnected||!layout.storages.length)return layout;
    const exchanged=refineFastLayout(layout,cells,refineJSON,{iterations:0,exchange_trials:6});
    // Keep the original workload scale: a successful first pass must not
    // abruptly change the cooling schedule for the remaining neighborhoods.
    const temperature=encodeRefinement(seed,cells).temperature;
    let best=exchanged;
    for(const [iterations,scale,exchange_trials] of [[1500000,.4,0],[1000000,.2,6],[500000,.1,6]]) {
        best=refineFastLayout(best,cells,refineJSON,{
            iterations,temperature:temperature*scale,exchange_trials,unequal_swaps:true,polish_passes:4,
        });
    }
    return best;
}
