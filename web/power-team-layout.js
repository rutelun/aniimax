import {createInsideTest} from './layout.js';
import {analyzePowerNetworks} from './power-islands.js';
import {powerCoverage,powerLinked} from './power-layout.js';
import {isIdlePiece} from './idle-layout.js';
import {rectangleMask} from './rectangle-mask.js';

const overlaps=(a,b)=>a.x<b.x+b.w-1e-7 && b.x<a.x+a.w-1e-7 && a.y<b.y+b.h-1e-7 && b.y<a.y+a.h-1e-7;
const footprint=m=>JSON.stringify([m.facility,Math.min(m.w,m.h),Math.max(m.w,m.h),!!m.sensitive]);
const cropRole=m=>JSON.stringify([footprint(m),m.mode,m.zone,m.crop]);
const clusterKey=p=>JSON.stringify([p.buildings.map(b=>[cropRole(b),b.x,b.y]),p.plots.map(cropRole).sort()]);
const at=(member,slot)=>({...member,x:slot.x,y:slot.y,w:slot.w,h:slot.h,
    ...(slot.productionGroup!=null?{productionGroup:slot.productionGroup}:{})});
const contains=(a,b)=>b.x>=a.x-1e-7&&b.y>=a.y-1e-7&&b.x+b.w<=a.x+a.w+1e-7&&b.y+b.h<=a.y+a.h+1e-7;
const location=m=>[m.x,m.y,m.w,m.h].join(',');

const recipes=m=>(m.jobs??[]).map(j=>j.item).sort().join('|');

function assignSites(candidates,slots,reachable) {
    // Match all exact uses first. A changed recipe may move into a vacant
    // copy but must not take another recipe's own site on an early iteration.
    const pairs=[];
    for(const piece of candidates)for(const slot of slots) {
        const m=piece.members[0];
        const accessible=reachable?.has(slot);
        const powerMatch=accessible==null?0:Number(accessible===(m.electric_level!=null));
        const score=64*powerMatch+32*Number(m.crop===slot.crop)+16*Number(!!m.weight===!!slot.weight)+
            8*Number(recipes(m)===recipes(slot))+4*Number(m.scheduleId!=null && m.scheduleId===slot.scheduleId)+
            2*Number(m.electric_level===slot.electric_level);
        pairs.push({piece,slot,score});
    }
    pairs.sort((a,b)=>b.score-a.score);
    const used=new Set(),placed=new Set();
    for(const {piece,slot} of pairs)if(!placed.has(piece) && !used.has(slot)) {
        piece.members=[at(piece.members[0],slot)];
        used.add(slot);
        placed.add(piece);
    }
}

function generatorSpot(generator,cells,inside,blocked,generators,consumers) {
    const mask=rectangleMask(cells);
    for(const r of blocked)mask?.add(r);
    // Give each added generator a chance to serve consumers outside the
    // preceding generators' reach. The network check accounts for all watts.
    const targets=consumers.map(m=>({m,weight:generators.some(g=>powerLinked(g,m))?1:4}));
    let best=null;
    for(const cell of cells)for(let y=cell.y;y<cell.y+cell.h;y+=1)for(let x=cell.x;x<cell.x+cell.w;x+=1) {
        const r={x,y,w:generator.w,h:generator.h,generator:true};
        if(!inside(r)||(mask?.overlaps(r)??blocked.some(b=>overlaps(b,r))))continue;
        let coverage=0,travel=0;
        for(const {m,weight} of targets) {
            if(powerLinked(r,m))coverage+=weight;
            travel+=weight*(Math.abs(x+r.w/2-m.x-m.w/2)+Math.abs(y+r.h/2-m.y-m.h/2));
        }
        if(!best||coverage>best.coverage||coverage===best.coverage&&travel<best.travel)best={x,y,coverage,travel};
    }
    return best;
}

function componentRelays(gens,poles) {
    const relayGroups=[];
    const remaining=new Set([...gens,...poles]);
    for(const gen of gens) {
        if(!remaining.delete(gen))continue;
        const group=[gen];
        for(let i=0;i<group.length;i++)for(const r of remaining)if(powerLinked(group[i],r)) {
            group.push(r);remaining.delete(r);
        }
        relayGroups.push(group);
    }
    return relayGroups;
}

// Find a shortest legal pole chain on a regular lattice. Adjacent poles
// cannot overlap. A shortest path cannot overlap a nonadjacent ancestor,
// since it could have connected directly to that ancestor instead.
function poleRoute(from,to,blocked,inside,maximum,step,reached) {
    const left=Math.floor(Math.min(...blocked.map(r=>r.x)))-6,top=Math.floor(Math.min(...blocked.map(r=>r.y)))-6;
    const right=Math.ceil(Math.max(...blocked.map(r=>r.x+r.w)))+6,bottom=Math.ceil(Math.max(...blocked.map(r=>r.y+r.h)))+6;
    const w=Math.ceil((right-left)/step),h=Math.ceil((bottom-top)/step);
    if(w*h>1_000_000)return null;
    const mask=rectangleMask(blocked);
    for(const r of blocked)mask?.add(r);
    const previous=new Int32Array(w*h).fill(-2),queue=new Int32Array(w*h);
    const pole=k=>({x:left+k%w*step,y:top+Math.floor(k/w)*step,w:1.5,h:1.5,pole:true,facility:'Crackle Power Pole'});
    const legal=p=>inside(p)&&!(mask?.overlaps(p)??blocked.some(r=>overlaps(r,p)));
    let i=0,end=0;
    function visit(k,parent) {
        if(previous[k]!==-2)return;
        const p=pole(k);
        if(!legal(p)){previous[k]=-3;return;}
        previous[k]=parent;
        queue[end++]=k;
    }
    for(const r of from) {
        const radius=r.generator?5.5:3.5,cx=r.x+r.w/2,cy=r.y+r.h/2;
        const startX=Math.max(0,Math.ceil((cx-radius-1.25-left)/step)),endX=Math.min(w-1,Math.floor((cx+radius-.25-left)/step));
        const startY=Math.max(0,Math.ceil((cy-radius-1.25-top)/step)),endY=Math.min(h-1,Math.floor((cy+radius-.25-top)/step));
        for(let y=startY;y<=endY;y++)for(let x=startX;x<=endX;x++)visit(y*w+x,-1);
    }
    const reach=Math.floor(4/step);
    for(let depth=1;i<end&&depth<=maximum;depth++) {
        const frontier=end;
        let last=-1,best=0;
        for(let at=i;at<frontier;at++) {
            const p=pole(queue[at]);
            let count=0;
            for(const target of to)if(!reached?.has(target) && powerLinked(p,target)) {
                count++;reached?.add(target);
            }
            if(reached?.size===to.length)return null;
            if(count>best){best=count;last=queue[at];}
        }
        if(!reached && last>=0) {
            const route=[];
            for(let k=last;k>=0;k=previous[k])route.push(pole(k));
            return route;
        }
        for(;i<frontier;i++) {
            const k=queue[i],px=k%w,py=Math.floor(k/w);
            for(let dy=-reach;dy<=reach;dy++)for(let dx=-reach;dx<=reach;dx++) {
                if(Math.abs(dx)*step<1.5&&Math.abs(dy)*step<1.5)continue;
                const x=px+dx,y=py+dy;
                if(x>=0&&x<w&&y>=0&&y<h)visit(y*w+x,k);
            }
        }
    }
    return null;
}

function wire(layout,gens,consumers,inside,blocked,maximum) {
    const poles=layout.power.poles;
    while(true) {
        analyzePowerNetworks(layout);
        if(!layout.power.disconnected)return layout;
        if(!gens.length||poles.length>=maximum)return null;
        const groups=componentRelays(gens,poles);
        let from=groups.flat(),to=consumers.filter(m=>!m.power_networks.length);
        if(!to.length) {
            const short=layout.power.networks.find(n=>n.generators&&n.percent+1e-6<n.required);
            if(!short || groups.length<2)return null;
            from=groups[short.id];to=groups.filter(g=>g!==from).flat();
        }
        const obstacles=blocked.concat(poles);
        const route=poleRoute(from,to,obstacles,inside,maximum-poles.length,1)
            ??poleRoute(from,to,obstacles,inside,maximum-poles.length,.5);
        if(!route)return null;
        poles.push(...route);
    }
}

// Recover an ungrouped layout when a newly powered workshop has no route.
// Stay on legal ground and only keep moves that improve the actual network.
function reconnectWorkshops(layout,inside,blocked,relays) {
    const workshops=layout.pieces.filter(p=>!p.cluster && !isIdlePiece(p)).map(p=>p.members[0])
        .filter(m=>!m.generator && !m.building && !m.sensitive);
    let missing=analyzePowerNetworks(layout).power.disconnected;
    while (missing) {
        const targets=workshops.filter(m=>m.electric_level!=null && !m.power_connected);
        const improves=()=>analyzePowerNetworks(layout).power.disconnected<missing;
        const moved=targets.some(m=>{
            const original={x:m.x,y:m.y};
            for (const peer of workshops) {
                if (peer.electric_level!=null || peer.w!==m.w || peer.h!==m.h) continue;
                const slot={x:peer.x,y:peer.y};
                Object.assign(m,slot);
                Object.assign(peer,original);
                if (improves()) return true;
                Object.assign(m,original);
                Object.assign(peer,slot);
            }
            const obstacles=blocked.filter(r=>r!==m).concat(layout.power.poles);
            if (layout.idleArea?.bounds) obstacles.push(layout.idleArea.bounds);
            for (const relay of relays) {
                const reach=powerCoverage(relay);
                for (let y=Math.ceil((reach.y-m.h)*2)/2;y<=reach.y+reach.h;y+=.5) {
                    for (let x=Math.ceil((reach.x-m.w)*2)/2;x<=reach.x+reach.w;x+=.5) {
                        const spot={x,y,w:m.w,h:m.h};
                        if (!powerLinked(relay,spot)||!inside(spot)||obstacles.some(r=>overlaps(spot,r))) continue;
                        Object.assign(m,{x,y});
                        if (improves()) return true;
                        Object.assign(m,original);
                    }
                }
            }
            return false;
        });
        if (!moved) return false;
        missing=layout.power.disconnected;
    }
    return true;
}

// A candidate can inherit the map only when its inventory and climate
// assignments still describe the same occupied land. Generator count may vary.
export function reusePowerTeamLayout(incumbent,pieces,cells,poleLimit) {
    if(!incumbent?.pieces || incumbent.unplaced?.length || !cells?.length ||
        !Array.isArray(pieces) || !Array.isArray(incumbent.storages) || !(poleLimit>=0))return null;
    const storage=incumbent.storages.map(r=>({...r})),inside=createInsideTest(cells);
    // Modern production groups use facility-based themes. Older purpose-based
    // districts require recipe-specific zoning which this placement cannot infer.
    if(incumbent.groups && (incumbent.groupStyle!=='groups'||incumbent.groups.some(g=>!Array.isArray(g.indices))))return null;
    const oldClusters=new Map(),oldSites=new Map(),oldGenerators=[];
    function append(map,key,item) { if(!map.has(key))map.set(key,[]);map.get(key).push(item); }
    for(const p of incumbent.pieces) {
        if(!p.members?.length)return null;
        if(p.cluster)append(oldClusters,clusterKey(p),p);
        else if(p.members.length!==1)return null;
        else if(p.members[0].generator)oldGenerators.push(p.members[0]);
        else append(oldSites,footprint(p.members[0]),p.members[0]);
    }
    const next=[],bySite=new Map(),generators=[];
    for(const p of pieces) {
        if(p.cluster) {
            const old=oldClusters.get(clusterKey(p))?.pop();
            if(!old)return null;
            const slots=new Map();
            for(const m of old.members)append(slots,cropRole(m),m);
            const members=[];
            for(const m of [...p.buildings,...p.plots]) {
                const slot=slots.get(cropRole(m))?.shift();
                if(!slot)return null;
                members.push(at(m,slot));
            }
            if(members.length!==old.members.length)return null;
            next.push({...p,members});
        } else {
            if(p.members?.length!==1)return null;
            const piece={...p,members:[{...p.members[0]}]};
            next.push(piece);
            if(piece.members[0].generator)generators.push(piece);
            else append(bySite,footprint(piece.members[0]),piece);
        }
    }
    if([...oldClusters.values()].some(a=>a.length)||bySite.size!==oldSites.size)return null;
    const mixed=[...bySite].filter(([,items])=>items.some(p=>p.members[0].electric_level!=null)&&items.some(p=>p.members[0].electric_level==null));
    const targets=mixed.flatMap(([key])=>oldSites.get(key)??[]);
    const reachable=new Set();
    if(oldGenerators.length && targets.length) {
        const relays=componentRelays(oldGenerators,incumbent.power?.poles??[]).flat();
        for(const m of targets)if(relays.some(r=>powerLinked(r,m)))reachable.add(m);
        if(reachable.size<targets.length)poleRoute(relays,targets,[...incumbent.pieces.flatMap(p=>p.members),...storage,
            ...(incumbent.groups??[]).flatMap(g=>g.reserved??[])],inside,Infinity,1,reachable);
    }
    for(const [key,sites] of bySite) {
        const slots=oldSites.get(key);
        if(slots?.length!==sites.length)return null;
        const needsChoice=slots.some(m=>reachable.has(m))&&slots.some(m=>!reachable.has(m));
        assignSites(sites,slots,needsChoice?reachable:null);
    }
    const blocked=[...storage,...next.flatMap(p=>p.members.filter(m=>!m.generator))];
    if(blocked.some((r,i)=>!inside(r)||blocked.slice(0,i).some(b=>overlaps(r,b))))return null;
    const groupObstacles=(incumbent.groups??[]).flatMap(g=>g.reserved??[]);
    if(groupObstacles.some(r=>blocked.some(b=>overlaps(r,b))))return null;
    blocked.push(...groupObstacles);
    const consumers=blocked.filter(m=>m.electric_level!=null),placed=[];
    for(const p of generators) {
        const m=p.members[0];
        const index=oldGenerators.findIndex(g=>g.w===m.w && g.h===m.h && inside(g) && !blocked.some(b=>overlaps(g,b)));
        const spot=index>=0?oldGenerators.splice(index,1)[0]:generatorSpot(m,cells,inside,blocked,componentRelays(placed,incumbent.power?.poles??[]).flat(),consumers);
        if(!spot)return null;
        m.x=spot.x;m.y=spot.y;
        blocked.push(m);placed.push(m);
    }
    const poles=(incumbent.power?.poles??[]).filter(p=>inside(p)&&!blocked.some(b=>overlaps(p,b))).slice(0,poleLimit);
    const layout={...incumbent,pieces:next,storage:storage[0]??null,storages:storage,storageAt:incumbent.storageAt,unplaced:[],tried:0,
        power:{poles,maximum:poleLimit}};
    // Keep the incumbent's useful poles. Rerouting without them can recover
    // a pole slot or split an unnecessarily merged grid.
    const tryWiring=()=>{
        let best=null;
        for(const path of [poles,[]]) {
            const trial={...layout,power:{poles:path.slice(),maximum:poleLimit}};
            const wired=wire(trial,placed,consumers,inside,blocked,poleLimit);
            if(!wired)continue;
            const active=wired.power.networks.filter(n=>n.generators&&n.consumers).length;
            if(!best||active>best.active||active===best.active&&wired.power.poles.length<best.layout.power.poles.length)
                best={active,layout:wired};
            if(active===placed.length||!poles.length)break;
        }
        return best?analyzePowerNetworks(best.layout):null;
    };
    let result=tryWiring();
    if(!result) {
        // Dense blocks can leave a workshop beyond every pole's reach. Its
        // manual sibling has the same footprint and can exchange locations.
        const swapped=new Set();
        for(const m of consumers.filter(m=>!m.power_connected)) {
            const peer=next.flatMap(p=>p.cluster?[]:p.members).find(r=>r.facility===m.facility &&
                r.electric_level==null && r.w===m.w && r.h===m.h && r.productionGroup===m.productionGroup &&
                !m.sensitive && !r.sensitive && !swapped.has(r));
            if(!peer)continue;
            swapped.add(peer);
            [m.x,peer.x]=[peer.x,m.x];[m.y,peer.y]=[peer.y,m.y];
        }
        if(swapped.size)result=tryWiring();
    }
    if (!result && !incumbent.groups && reconnectWorkshops(layout,inside,blocked,[...placed,...poles])) {
        result=tryWiring();
    }
    if(!result)return null;
    if(incumbent.groups) {
        const oldAt=new Map(incumbent.pieces.flatMap((p,i)=>p.members.map(m=>[location(m),i])));
        const remap=new Map();
        for(const [i,p] of next.entries()) {
            const before=oldAt.get(location(p.members[0]));
            if(before!=null)remap.set(before,i);
            for(const [j,m] of p.members.entries()) {
                m.sourcePiece=i;m.sourceMember=j;
                if(m.generator)m.productionGroup=-1;
            }
        }
        result.groups=[];
        for(const [index,g] of incumbent.groups.entries()) {
            const indices=g.indices.map(i=>remap.get(i));
            if(indices.some(i=>i==null||next[i].members.some(m=>m.productionGroup!==index||!contains(g.bounds,m))))return null;
            if(g.storageIndices?.some(i=>!storage[i]||!contains(g.bounds,storage[i])))return null;
            result.groups.push({...g,indices});
        }
        delete result.groupSearch;
    }
    if(incumbent.idleArea) {
        const indices=next.flatMap((p,i)=>isIdlePiece(p)?[i]:[]);
        const bounds=incumbent.idleArea.bounds;
        if(indices.length && bounds && next.every((p,i)=>p.members.every(m=>indices.includes(i)?contains(bounds,m):!overlaps(bounds,m)))
            && result.power.poles.every(p=>!overlaps(bounds,p)))
            result.idleArea={bounds,indices};
        else delete result.idleArea;
    }
    return result;
}

