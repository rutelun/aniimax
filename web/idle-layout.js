import {createInsideTest} from './layout.js';
import {FACILITY_CATEGORY_BY_NAME} from './facility-config.js?v=leisure-families';

export const isIdlePiece=piece=>!piece.cluster&&piece.members?.length>0&&piece.members.every(r=>
    !r.generator&&r.electric_level==null&&!(r.weight>0)&&!(r.load>0)&&!r.crop&&!r.crew&&!r.workers?.length
    &&!r.jobs?.length&&(FACILITY_CATEGORY_BY_NAME.has(r.facility)||(r.building&&r.mode===null)));
const overlaps=(a,b)=>a.x<b.x+b.w-1e-6&&b.x<a.x+a.w-1e-6&&a.y<b.y+b.h-1e-6&&b.y<a.y+a.h-1e-6;

// Only relocate unused facilities: active production, climate and power remain
// untouched, so the accepted delivery score and crew demand cannot get worse.
export function parkIdleBuildings(input,cells){
    const indices=input.pieces.flatMap((p,i)=>isIdlePiece(p)?[i]:[]);
    if(!indices.length||!cells.length||input.unplaced.length)return input;
    const inside=createInsideTest(cells),idle=new Set(indices),blocked=[...input.pieces.flatMap((p,i)=>idle.has(i)?[]:p.members),...input.storages,...input.power?.poles||[]];
    // Climate coverage is kept clear even for unused sensitive facilities.
    for(const p of input.pieces)if(p.cluster)for(const b of p.members.slice(0,p.buildings.length))blocked.push({x:b.x+b.w/2-4.5,y:b.y+b.h/2-4.5,w:9,h:9});
    const rows=indices.flatMap(i=>input.pieces[i].members.map((r,j)=>({i,j,r}))).sort((a,b)=>b.r.h-a.r.h||b.r.w-a.r.w);
    const area=rows.reduce((s,{r})=>s+r.w*r.h,0),allBounds={x:Math.min(...cells.map(c=>c.x)),y:Math.min(...cells.map(c=>c.y))};
    allBounds.w=Math.max(...cells.map(c=>c.x+c.w))-allBounds.x;allBounds.h=Math.max(...cells.map(c=>c.y+c.h))-allBounds.y;
    let best=null;
    for(const scale of [1,.65,1.5,2]){
        const width=Math.max(...rows.map(({r})=>r.w),Math.ceil(Math.sqrt(area)*scale));
        let x=0,y=0,h=0,w=0;const slots=[];
        for(const {r} of rows){if(x&&x+r.w>width){y+=h;x=0;h=0;}slots.push({...r,x,y});x+=r.w;w=Math.max(w,x);h=Math.max(h,r.h);}
        h+=y;
        for(const cell of [allBounds,...cells])for(const at of [{x:cell.x,y:cell.y},{x:cell.x+cell.w-w,y:cell.y},{x:cell.x,y:cell.y+cell.h-h},{x:cell.x+cell.w-w,y:cell.y+cell.h-h}]){
            const box={...at,w,h};if(!inside(box))continue;
            const placed=slots.map(r=>({...r,x:r.x+at.x,y:r.y+at.y}));
            if(placed.some(r=>blocked.some(b=>overlaps(b,r))))continue;
            const edge=Math.min(at.x-allBounds.x,at.y-allBounds.y,allBounds.x+allBounds.w-at.x-w,allBounds.y+allBounds.h-at.y-h);
            const score=edge*10000+w*h;
            if(!best||score<best.score)best={placed,box,score};
        }
    }
    if(!best)return input;
    const result=structuredClone(input);
    rows.forEach(({i,j},k)=>Object.assign(result.pieces[i].members[j],{x:best.placed[k].x,y:best.placed[k].y}));
    result.idleArea={indices,bounds:best.box};
    return result;
}
