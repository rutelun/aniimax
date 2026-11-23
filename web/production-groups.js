// Compact semantic blocks. Infrastructure, Aniipod Maker and Dance Pad Polisher
// may fill gaps in any category; other producers retain their semantic group.
import { FACILITY_CATEGORY_BY_NAME } from './facility-config.js?v=leisure-families';
import { layOut, layOutHomeland, layoutDeliveryCost, createInsideTest, improveFixedStorage, refineDistrictDeliveries } from './layout.js';
import { connectPower, updatePowerConnections, powerLinked } from './power-layout.js';
import { layoutKeepsIncome, incomeWalking } from './group-layout.js';

export {normalizeMapStyle} from './map-style.js';
const contains=(a,b)=>b.x>=a.x-1e-6&&b.y>=a.y-1e-6&&b.x+b.w<=a.x+a.w+1e-6&&b.y+b.h<=a.y+a.h+1e-6;
const overlaps=(a,b)=>a.x<b.x+b.w-1e-6&&b.x<a.x+a.w-1e-6&&a.y<b.y+b.h-1e-6&&b.y<a.y+a.h-1e-6;
const bounds=rs=>{const x=Math.min(...rs.map(r=>r.x)),y=Math.min(...rs.map(r=>r.y));return {x,y,w:Math.max(...rs.map(r=>r.x+r.w))-x,h:Math.max(...rs.map(r=>r.y+r.h))-y};};
const english=new Intl.Collator('en');
const sourceMembers=p=>p.cluster?[...p.buildings,...p.plots.map((r,j)=>({...r,...p.planned[j]}))]:p.members;
const flexibleFacility=name=>name==='Aniipod Maker'||name==='Dance Pad Polisher';
function themeOf(p){
    const rs=sourceMembers(p),names=new Set(rs.map(r=>r.facility));
    if(rs.some(r=>r.generator))return 'infrastructure';
    if(!p.cluster&&rs.length===1&&flexibleFacility(rs[0].facility))return 'flexible';
    if(names.has('Farmland')&&names.has('Woodland'))return 'growing';
    if(names.has('Farmland'))return 'fields';
    if(names.has('Woodland'))return 'woodland';
    if(names.has('Mine')||names.has('Well'))return 'extraction';
    if(rs.some(r=>FACILITY_CATEGORY_BY_NAME.get(r.facility)==='Materials Processing'))return 'processing';
    return 'aniimo';
}

export function buildProductionBlocks(pieces,{width=16,targetSize=24,wiringGap=1.5}={}){
    const categories=new Map();
    pieces.forEach((p,i)=>{
        const theme=themeOf(p),rs=sourceMembers(p).map((r,j)=>({...r,sourcePiece:i,sourceMember:j}));
        // Reserve climate extent against unrelated sensitive crops, not for decoration.
        const climate=p.cluster?p.buildings.map(r=>({x:r.x+r.w/2-4.5,y:r.y+r.h/2-4.5,w:9,h:9})):[];
        const box=bounds([...rs,...climate]);
        const item={i,count:rs.length,box,members:rs.map(r=>({...r,x:r.x-box.x,y:r.y-box.y})),name:rs[0].facility||''};
        const key=['infrastructure','flexible'].includes(theme)?`${theme}:${i}`:theme;
        if(!categories.has(key))categories.set(key,{theme,items:[]});
        categories.get(key).items.push(item);
    });
    const blocks=[];
    for(const {theme,items} of categories.values()){
        items.sort((a,b)=>english.compare(a.name,b.name)||a.i-b.i);
        const total=items.reduce((s,i)=>s+i.count,0);
        // Climate assemblies are indivisible; small tails merge back into the
        // previous part. Processing remains a continuous alphabetical sequence.
        const parts=Math.max(1,Math.min(Math.floor(total/6),Math.ceil(total/Math.max(6,targetSize))));
        const chunks=[];let chunk=[],count=0,remaining=total;
        for(const item of items){
            if(chunk.length&&count>=Math.ceil(remaining/(parts-chunks.length))&&chunks.length<parts-1&&remaining-count>=6){
                chunks.push(chunk);remaining-=count;chunk=[];count=0;
            }
            chunk.push(item);count+=item.count;
        }
        if(count<6&&chunks.length)chunks.at(-1).push(...chunk);else if(chunk.length)chunks.push(chunk);
        for(const entries of chunks){
            const powered=entries.some(e=>e.members.some(r=>r.electric_level!=null));
            const maxWidth=Math.max(width,...entries.map(e=>e.box.w));
            let x=0,y=0,rowHeight=0,w=0;const members=[];
            for(const entry of entries){
                if(x>0&&x+entry.box.w>maxWidth+1e-6){y+=rowHeight+(powered?wiringGap:0);x=0;rowHeight=0;}
                members.push(...entry.members.map(r=>({...r,x:r.x+x,y:r.y+y})));
                x+=entry.box.w;rowHeight=Math.max(rowHeight,entry.box.h);w=Math.max(w,x);
            }
            const h=y+rowHeight;
            if(theme==='processing')for(const r of members)r.y=h-r.y-r.h;
            if(powered){for(const r of members){r.x+=wiringGap;r.y+=wiringGap;}w+=wiringGap;}
            blocks.push({theme,members,w,h:h+(powered?wiringGap:0),reserved:[],indices:entries.map(e=>e.i),
                range:theme==='processing'?[entries[0].name,entries.at(-1).name]:null});
        }
    }
    return blocks;
}

function expand(pieces,blocks,macro){
    const out={...macro,pieces:pieces.map(p=>({...p,members:[]})),groups:[],groupStyle:'groups',groupGap:0};
    blocks.forEach((block,i)=>{
        const at=macro.pieces[i].members[0];if(!at)return;
        const group=out.groups.length;
        const free=['infrastructure','flexible'].includes(block.theme);
        if(!free)out.groups.push({bounds:{x:at.x,y:at.y,w:block.w,h:block.h},
            reserved:[],purpose:'support',themes:[block.theme],range:block.range,indices:block.indices,storageIndices:[]});
        for(const r of block.members)out.pieces[r.sourcePiece].members[r.sourceMember]={...r,x:r.x+at.x,y:r.y+at.y,
            productionGroup:free?-1:group};
    });
    out.unplaced=out.pieces.flatMap((p,i)=>p.members.length?[]:[i]);
    return out;
}

function alphabetical(layout){
    const groups=layout.groups.filter(g=>g.themes.includes('processing')).sort((a,b)=>(b.bounds.y+b.bounds.h)-(a.bounds.y+a.bounds.h)||a.bounds.x-b.bounds.x);
    let previous='';
    for(const group of groups){
        const rs=group.indices.flatMap(i=>layout.pieces[i].members).filter(r=>!flexibleFacility(r.facility)).sort((a,b)=>(b.y+b.h)-(a.y+a.h)||a.x-b.x);
        for(const r of rs){if(english.compare(previous,r.facility)>0)return false;previous=r.facility;}
    }
    return true;
}

export function refineGroupedMembers(layout,cells,{accept=()=>true}={}){
    const inside=createInsideTest(cells);
    return refineDistrictDeliveries(layout,layout.groups,{passes:2,includeMines:true,costOf:layoutDeliveryCost,quarterGrid:true,
        canPlace:(i,_,rs)=>{const group=layout.pieces[i].members[0]?.productionGroup;return group>=0&&rs.every(r=>inside(r)&&contains(layout.groups[group].bounds,r));},
        accept:candidate=>alphabetical(candidate)&&accept(candidate)});
}

function climateSafe(layout){
    const zones=layout.pieces.map(p=>p.cluster?p.members.slice(0,p.buildings.length).map(r=>({x:r.x+r.w/2-4.5,y:r.y+r.h/2-4.5,w:9,h:9})):[]);
    return layout.pieces.every((p,i)=>p.members.every((r,j)=>{
        if(!(r.sensitive||p.cluster&&j>=p.buildings.length))return true;
        return zones.every((zs,k)=>k===i||zs.every(z=>!overlaps(z,r)));
    }));
}

// Group envelopes can interlock by one building, but never swallow another
// category. Real footprints, coverage and power remain hard constraints.
function envelopeFits(box,group,layout){
    const depth=Math.max(...group.indices.flatMap(i=>layout.pieces[i].members.map(r=>Math.max(r.w,r.h))));
    return layout.groups.every(g=>{
        if(g===group||!overlaps(box,g.bounds))return true;
        const w=Math.min(box.x+box.w,g.bounds.x+g.bounds.w)-Math.max(box.x,g.bounds.x);
        const h=Math.min(box.y+box.h,g.bounds.y+g.bounds.h)-Math.max(box.y,g.bounds.y);
        return Math.min(w,h)<=depth+1e-6;
    });
}

export function refineProductionGroups(input,cells,{accept=()=>true,passes=2,steps=[4,2,.5],diagonals=false}={}){
    const layout=structuredClone(input),inside=createInsideTest(cells);
    let cost=layoutDeliveryCost(layout);
    for(const step of steps)for(let pass=0;pass<passes;pass++){
        let changed=false;
        for(const group of layout.groups){
            const members=group.indices.flatMap(i=>layout.pieces[i].members);
            const carried=[...members,...layout.storages.filter(r=>contains(group.bounds,r)),
                ...layout.power.poles.filter(r=>contains(group.bounds,r))];
            const moving=new Set(carried),blocked=[...layout.pieces.flatMap(p=>p.members),...layout.storages,...layout.power.poles].filter(r=>!moving.has(r));
            const directions=[[-step,0],[step,0],[0,-step],[0,step]];
            if(diagonals)directions.push([-step,-step],[-step,step],[step,-step],[step,step]);
            for(const [dx,dy] of directions){
                const box={...group.bounds,x:group.bounds.x+dx,y:group.bounds.y+dy};
                if(!inside(box)||!envelopeFits(box,group,layout))continue;
                if(carried.some(r=>{const next={...r,x:r.x+dx,y:r.y+dy};return !inside(next)||blocked.some(b=>overlaps(b,next));}))continue;
                for(const r of carried){r.x+=dx;r.y+=dy;}group.bounds.x+=dx;group.bounds.y+=dy;
                const next=layoutDeliveryCost(layout);
                if(next<cost-1e-8&&alphabetical(layout)&&climateSafe(layout)&&!updatePowerConnections(layout).power.disconnected&&accept(layout)){
                    cost=next;changed=true;break;
                }
                for(const r of carried){r.x-=dx;r.y-=dy;}group.bounds.x-=dx;group.bounds.y-=dy;
                updatePowerConnections(layout);
            }
        }
        if(!changed)break;
    }
    return layout;
}

function spreadGenerators(layout,cells){
    const members=layout.pieces.flatMap(p=>p.members),generators=members.filter(r=>r.generator);
    const remaining=new Set(members.filter(r=>r.electric_level!=null)),inside=createInsideTest(cells);
    for(const generator of generators){
        const blocked=[...members.filter(r=>r!==generator),...layout.storages];let best=null;
        for(const cell of cells)for(let y=cell.y;y<cell.y+cell.h;y+=1)for(let x=cell.x;x<cell.x+cell.w;x+=1){
            const r={...generator,x,y};let count=0,distance=0;
            for(const target of remaining){count+=powerLinked(r,target)?1:0;distance+=Math.hypot(x+r.w/2-target.x-target.w/2,y+r.h/2-target.y-target.h/2);}
            const score=count*1000-distance;
            if(best&&score<=best.score)continue;
            if(!inside(r)||blocked.some(b=>overlaps(b,r)))continue;
            best={r,score};
        }
        if(best)Object.assign(generator,best.r);
        for(const target of remaining)if(powerLinked(generator,target))remaining.delete(target);
    }
}

// These two producers have no semantic district: search the whole buildable
// area, retaining power and worker capacity checks for every accepted move.
export function refineFlexibleProduction(input,cells,{accept=()=>true}={}){
    const layout=structuredClone(input),inside=createInsideTest(cells);
    for(const piece of layout.pieces){
        if(piece.cluster||piece.members.length!==1||!flexibleFacility(piece.members[0].facility))continue;
        const r=piece.members[0];
        if(!(r.weight>0))continue;
        const old={x:r.x,y:r.y},blocked=[...layout.pieces.flatMap(p=>p.members).filter(b=>b!==r),...layout.storages,...(layout.power?.poles||[])];
        const distance=spot=>Math.min(...layout.storages.map(s=>Math.hypot(spot.x+spot.w/2-s.x-s.w/2,spot.y+spot.h/2-s.y-s.h/2)));
        const previous=distance(r),sites=[];
        for(const cell of cells)for(let x=cell.x;x<cell.x+cell.w;x+=.5)for(let y=cell.y;y<cell.y+cell.h;y+=.5){
            const spot={...r,x,y},cost=distance(spot);
            if(cost>=previous-1e-8||!inside(spot)||blocked.some(b=>overlaps(b,spot)))continue;
            sites.push({x,y,cost});
        }
        sites.sort((a,b)=>a.cost-b.cost);
        for(const spot of sites){
            r.x=spot.x;r.y=spot.y;
            if(!updatePowerConnections(layout).power.disconnected&&climateSafe(layout)&&accept(layout))break;
            Object.assign(r,old);
        }
        updatePowerConnections(layout);
    }
    return layout;
}

function attachFlexibleGroups(layout){
    for(const [i,piece] of layout.pieces.entries()){
        if(piece.cluster||piece.members.length!==1||!flexibleFacility(piece.members[0].facility))continue;
        const r=piece.members[0];
        let nearest=-1,distance=Infinity;
        layout.groups.forEach((g,j)=>{
            const b=g.bounds;
            const gap=Math.hypot(Math.max(b.x-r.x-r.w,r.x-b.x-b.w,0),Math.max(b.y-r.y-r.h,r.y-b.y-b.h,0));
            if(gap<distance){nearest=j;distance=gap;}
        });
        if(nearest<0){nearest=layout.groups.length;layout.groups.push({bounds:{x:r.x,y:r.y,w:r.w,h:r.h},reserved:[],purpose:'support',themes:['aniimo'],range:null,indices:[],storageIndices:[]});}
        const group=layout.groups[nearest];
        group.indices.push(i);
        group.bounds=bounds([group.bounds,r]);
        r.productionGroup=nearest;
    }
}

const packings=[[22,Infinity,1.5],[28,Infinity,1.5],[32,Infinity,1.5],[16,24,1.5],[24,24,1.5],[16,Infinity,2],[24,Infinity,2],[32,Infinity,2]];
const narrowPacking=[12,Infinity,2];

export function searchGroupPackings(pieces,cells,variants,{storageCount=1,poleLimit=0,recipes=[],staffing=null,onCandidate=null}={}){
    if(!pieces.length||!cells.length)return null;
    const keeps=layout=>layoutKeepsIncome(layout,staffing,recipes);
    let best=null;
    // Different row widths avoid tuning the result to one RV or inventory.
    for(const [width,targetSize,wiringGap] of variants){
        const blocks=buildProductionBlocks(pieces,{width,targetSize,wiringGap});
        const proxies=blocks.map(b=>({members:[{x:0,y:0,w:b.w,h:b.h,weight:b.members.reduce((s,r)=>s+(r.weight||0),0)}]}));
        const seed=layOutHomeland(proxies,cells,{w:2,h:2},Math.min(1,storageCount),{fast:true,accountForWorkers:false});
        if(seed.unplaced.length)continue;
        // Reject rotated block footprints; reading order and climate offsets must
        // remain unchanged. Repack in the same storage field with fixed orientation.
        const macro=layOut(proxies,{cells,storages:seed.storages,fast:true,passes:0,accountForWorkers:false,fixedOrientation:true,
            placementPriority:blocks.map(b=>['processing','extraction'].includes(b.theme)?10:0),
            canPlace:(_,__,rs)=>Number.isInteger(rs[0].x*2)&&Number.isInteger(rs[0].y*2)});
        if(macro.unplaced.length)continue;
        let layout=expand(pieces,blocks,macro);
        if(!alphabetical(layout)){onCandidate?.({width,rejected:'alphabet'});continue;}
        spreadGenerators(layout,cells);
        layout=connectPower(layout,cells,poleLimit,false,()=>false,null,true);
        if(layout.power.disconnected){
            const generators=layout.pieces.flatMap((p,i)=>p.members.some(r=>r.generator)?[i]:[]);
            if(generators.length>1){
                const trial=structuredClone(layout),a=generators[0],b=generators.at(-1);
                [trial.pieces[a],trial.pieces[b]]=[trial.pieces[b],trial.pieces[a]];
                connectPower(trial,cells,poleLimit,false,()=>false,null,true);
                [trial.pieces[a],trial.pieces[b]]=[trial.pieces[b],trial.pieces[a]];
                if(trial.power.disconnected<layout.power.disconnected)layout=trial;
            }
        }
        onCandidate?.({width,unplaced:layout.unplaced.length,disconnected:layout.power.disconnected,income:keeps(layout),layout});
        if(layout.power.disconnected)continue;
        const seedCost=layoutDeliveryCost(layout);
        // Move storage against the true per-building trip frequencies, not proxy centers.
        const stored=improveFixedStorage(layout,cells,0,storageCount);
        layout=stored;
        if(!keeps(layout))continue;
        const refined=refineGroupedMembers(layout,cells,{accept:keeps});
        updatePowerConnections(refined);
        if(!refined.power.disconnected&&layoutDeliveryCost(refined)<=layoutDeliveryCost(layout)+1e-8)layout=refined;
        layout=refineProductionGroups(layout,cells,{accept:keeps});
        layout=refineFlexibleProduction(layout,cells,{accept:keeps});
        layout.groupSearch={seedCost,cost:layoutDeliveryCost(layout)};
        if(staffing?.movement)layout.incomeWalking=incomeWalking(layout,staffing,recipes);
        layout.groups.forEach(g=>{g.storageIndices=layout.storages.flatMap((s,i)=>contains(g.bounds,s)?[i]:[]);});
        if(!best||layoutDeliveryCost(layout)<layoutDeliveryCost(best))best=layout;
    }
    return best;
}

export async function productionGroupLayout(pieces,cells,options={}){
    const {storageCount=1,staffing=null,recipes=[],searchPackings}=options;
    const keeps=layout=>layoutKeepsIncome(layout,staffing,recipes);
    let best=searchPackings ? await searchPackings(packings) : searchGroupPackings(pieces,cells,packings,options);
    if(!best)best=searchGroupPackings(pieces,cells,[narrowPacking],options);
    if(!best)return null;
    // Polish the selected layout, not every discarded packing candidate.
    for(let pass=0;pass<3;pass++){
        const before=layoutDeliveryCost(best);
        const next=refineGroupedMembers(best,cells,{accept:keeps});
        updatePowerConnections(next);
        if(!next.power.disconnected&&keeps(next)&&layoutDeliveryCost(next)<=layoutDeliveryCost(best)+1e-8)best=next;
        const stored=improveFixedStorage(best,cells,0,storageCount);
        if(keeps(stored)&&layoutDeliveryCost(stored)<=layoutDeliveryCost(best)+1e-8)best=stored;
        // Storage/member moves can unlock translations rejected earlier. Polish
        // only the winner, on the same quarter-tile grid as individual sites.
        best=refineProductionGroups(best,cells,{accept:keeps,passes:12,steps:[8,4,2,1,.5,.25],diagonals:true});
        if(layoutDeliveryCost(best)>=before-1e-8)break;
    }
    best=refineFlexibleProduction(best,cells,{accept:keeps});
    attachFlexibleGroups(best);
    best.groupSearch.cost=layoutDeliveryCost(best);
    if(staffing?.movement)best.incomeWalking=incomeWalking(best,staffing,recipes);
    best.groups.forEach(g=>{g.storageIndices=best.storages.flatMap((s,i)=>contains(g.bounds,s)?[i]:[]);});
    return best;
}
