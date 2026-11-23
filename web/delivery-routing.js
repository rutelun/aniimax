// Stationary flow estimate, not a fixed in-game worker assignment. A finished
// delivery leaves its worker at storage; other jobs leave it at their worksite.
const center=r=>[r.x+r.w/2,r.y+r.h/2];
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const compiled=new WeakMap();
export function deliveryRouteCost(layout){
    const sites=layout.pieces.flatMap(p=>p.members),stores=layout.storages||[];
    if(!stores.length)return 0;
    let cache=compiled.get(layout.pieces);
    if(!cache||cache.storeCount!==stores.length||cache.refs.length!==sites.length||sites.some((s,i)=>
        cache.refs[i]!==s||cache.weights[i]!==s.weight||cache.crews[i]!==s.deliveryWorkers||cache.jobs[i]!==s.deliveryOrigins)){
        const flow=deliveryRouting(layout);
        cache={refs:sites,weights:sites.map(s=>s.weight),crews:sites.map(s=>s.deliveryWorkers),jobs:sites.map(s=>s.deliveryOrigins),storeCount:stores.length,
            rows:flow.arrivals.map(r=>({trips:r.trips,fromStores:r.trips*r.storeWeights.reduce((s,w)=>s+w,0),
                origins:r.origins.map(o=>[o.site,o.share*r.trips])}))};
        compiled.set(layout.pieces,cache);
    }
    const points=sites.map(center),depots=stores.map(center),flows=Array(stores.length).fill(0),distances=[];
    let cost=0,total=0;
    for(let i=0;i<sites.length;i++){
        const r=cache.rows[i];if(!(r.trips>0))continue;
        const ds=depots.map(p=>distance(points[i],p));distances[i]=ds;
        let closest=0;for(let s=1;s<ds.length;s++)if(ds[s]<ds[closest])closest=s;
        flows[closest]+=r.trips;total+=r.trips;cost+=r.trips*ds[closest];
        for(const [j,w] of r.origins)cost+=w*distance(points[i],points[j]);
    }
    if(total>0)for(let i=0;i<sites.length;i++)if(distances[i]){
        const r=cache.rows[i];for(let s=0;s<flows.length;s++)cost+=r.fromStores*flows[s]/total*distances[i][s];
    }
    return cost;
}
export function deliveryOrigins(layout){
    const sites=layout.pieces.flatMap(p=>p.members),stores=layout.storages||[];
    const points=sites.map(center),depots=stores.map(center),pools=new Map();
    const pool=id=>{if(!pools.has(id))pools.set(id,{stores:new Map(),other:new Map(),total:0});return pools.get(id);};
    const nearest=points.map(p=>depots.reduce((best,s,i)=>best<0||distance(p,s)<distance(p,depots[best])?i:best,-1));
    const crews=sites.map(s=>s.deliveryWorkers?.length?s.deliveryWorkers:[['any',Math.max(0,s.weight||0)]]);
    for(let i=0;i<sites.length;i++){
        if(nearest[i]>=0)for(const [id,rate] of crews[i])if(rate>0){
            const p=pool(id);p.total+=rate;p.stores.set(nearest[i],(p.stores.get(nearest[i])||0)+rate);
        }
        for(const [id,rate] of sites[i].deliveryOrigins||[])if(rate>0){
            const p=pool(id);p.total+=rate;p.other.set(i,(p.other.get(i)||0)+rate);
        }
    }
    // Jobs are drawn from one global queue, not assigned to a courier's depot.
    // Existing per-worker rates describe availability/capacity, never territory.
    const globalStores=new Map();let globalTrips=0;
    for(const p of pools.values())for(const [s,rate] of p.stores){
        globalStores.set(s,(globalStores.get(s)||0)+rate);globalTrips+=rate;
    }
    if(globalTrips>0)for(const p of pools.values()){
        const ownTrips=[...p.stores.values()].reduce((s,n)=>s+n,0);
        if(ownTrips>0)p.stores=new Map([...globalStores].map(([s,rate])=>[s,ownTrips*rate/globalTrips]));
    }
    return {sites,stores,points,depots,pools,nearest,crews};
}
export function deliveryRouting(layout){
    const {sites,stores,points,depots,pools,nearest,crews}=deliveryOrigins(layout);
    let cost=0;
    const arrivals=sites.map((site,i)=>{
        const weights=Array(stores.length).fill(0),origins=new Map();
        let trips=0,approach=0;
        for(const [id,rate] of crews[i]){
            const p=pools.get(id);if(!(rate>0)||!p?.total)continue;
            trips+=rate;
            for(const [s,n] of p.stores)weights[s]+=rate*n/p.total;
            for(const [s,n] of p.other)origins.set(s,(origins.get(s)||0)+rate*n/p.total);
        }
        weights.forEach((w,s)=>approach+=w*distance(points[i],depots[s]));
        for(const [s,w] of origins)approach+=w*distance(points[i],points[s]);
        const loaded=nearest[i]>=0?trips*distance(points[i],depots[nearest[i]]):0;
        cost+=loaded+approach;
        return {trips,approach:trips?approach/trips:0,loaded:trips?loaded/trips:0,
            storeWeights:weights.map(w=>trips?w/trips:0),
            origins:[...origins].map(([site,w])=>({site,share:trips?w/trips:0}))};
    });
    return {cost,arrivals,pools,sites,stores};
}

export function deliveryApproach(flow,worker,point,storeDistances=[],siteDistances=[]){
    const p=flow.pools.get(worker);
    if(!p?.total)return null;
    let result=0;
    for(const [i,rate] of p.stores)result+=rate*(storeDistances[i]??=distance(point,center(flow.stores[i])));
    for(const [i,rate] of p.other)result+=rate*(siteDistances[i]??=distance(point,center(flow.sites[i])));
    return result/p.total;
}
