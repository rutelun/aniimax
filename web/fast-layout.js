// WASM boundary shared by the layout worker and offline benchmarks. No saved
// placements or RV-specific coordinates are used by the search.
import {layoutDeliveryCost,layOutHomeland,createInsideTest,refineDistrictDeliveries,improveFixedStorage} from './layout.js';
import {updatePowerConnections,connectPower} from './power-layout.js';

export function fastLayoutSeed({pieces,cells,storageCount,poleLimit}) {
    let layout=connectPower(layOutHomeland(pieces,cells,{w:2,h:2},storageCount,{fast:true,accountForWorkers:false}),cells,poleLimit);
    if(!cells.length||layout.unplaced.length||layout.power.disconnected)return layout;
    const inside=createInsideTest(cells),x=Math.min(...cells.map(c=>c.x)),y=Math.min(...cells.map(c=>c.y));
    const bounds={x,y,w:Math.max(...cells.map(c=>c.x+c.w))-x,h:Math.max(...cells.map(c=>c.y+c.h))-y};
    layout=refineDistrictDeliveries(layout,[{bounds,reserved:[]}],{passes:1,includeMines:true,costOf:layoutDeliveryCost,canPlace:(_,__,rs)=>rs.every(inside)});
    return improveFixedStorage(layout,cells,0);
}

export function encodeRefinement(layout,cells,options={}) {
    const rectangles=[],climates=[];
    for(const piece of layout.pieces){
        const start=rectangles.length,owner=piece.cluster?climates.length:-1;
        if(piece.cluster)climates.push(piece.buildings.map((_,j)=>start+j));
        for(const [j,r] of piece.members.entries())rectangles.push({
            x:r.x,y:r.y,w:r.w,h:r.h,weight:r.weight||0,
            owner:piece.cluster&&j>=piece.buildings.length?owner:-1,zone:r.zone||0,
            sensitive:!!r.sensitive,generator:!!r.generator,electric:r.electric_level!=null,
            movable:piece.cluster?j>=piece.buildings.length:piece.members.length===1&&!r.generator,
        });
    }
    const producer_count=rectangles.length;
    for(const r of layout.storages)rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h});
    for(const r of layout.power?.poles||[])rectangles.push({x:r.x,y:r.y,w:r.w,h:r.h,pole:true});
    // A fixed temperature freezes layouts whose delivery cost is concentrated
    // in a few high-throughput producers. Use the weight-weighted median so
    // numerous near-idle buildings cannot hide that concentration.
    const weights=rectangles.map(r=>r.weight||0).filter(w=>w>0).sort((a,b)=>a-b);
    const half=weights.reduce((sum,w)=>sum+w,0)/2;
    let cumulative=0;
    const median=weights.find(w=>(cumulative+=w)>=half)||0;
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
