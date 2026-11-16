// Draw the union boundary rather than the enclosing rectangle. Concave groups
// can interlock without painting their shared envelope as occupied land.
export function rectangleUnion(rectangles){
    if(!rectangles.length)return {fill:'',edge:''};
    const xs=[...new Set(rectangles.flatMap(r=>[r.x,r.x+r.w]))].sort((a,b)=>a-b);
    const ys=[...new Set(rectangles.flatMap(r=>[r.y,r.y+r.h]))].sort((a,b)=>a-b);
    const w=xs.length-1,h=ys.length-1,occupied=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
        const cx=(xs[x]+xs[x+1])/2,cy=(ys[y]+ys[y+1])/2;
        if(rectangles.some(r=>cx>=r.x&&cx<r.x+r.w&&cy>=r.y&&cy<r.y+r.h))occupied[y*w+x]=1;
    }
    const has=(x,y)=>x>=0&&x<w&&y>=0&&y<h&&occupied[y*w+x];
    const edges=[];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(has(x,y)){
        if(!has(x,y-1))edges.push(`M${xs[x]},${ys[y]}H${xs[x+1]}`);
        if(!has(x,y+1))edges.push(`M${xs[x]},${ys[y+1]}H${xs[x+1]}`);
        if(!has(x-1,y))edges.push(`M${xs[x]},${ys[y]}V${ys[y+1]}`);
        if(!has(x+1,y))edges.push(`M${xs[x+1]},${ys[y]}V${ys[y+1]}`);
    }
    return {fill:rectangles.map(r=>`M${r.x},${r.y}h${r.w}v${r.h}h${-r.w}Z`).join(''),edge:edges.join('')};
}

export function productionGroupOutline(group,layout){
    const members=group.indices.flatMap(i=>layout.pieces[i].members);
    const margin=.25;
    const rectangles=members.map(r=>({x:r.x-margin,y:r.y-margin,w:r.w+2*margin,h:r.h+2*margin}));
    const indices=new Set(group.indices),other=layout.pieces.flatMap((p,i)=>indices.has(i)?[]:p.members);
    const overlaps=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
    // Join neighbouring rows across technical wiring gaps, but leave notches
    // occupied by another category visibly outside this zone.
    for(let i=0;i<members.length;i++)for(let j=0;j<i;j++){
        const a=members[i],b=members[j],x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
        const w=Math.min(a.x+a.w,b.x+b.w)-x,h=Math.min(a.y+a.h,b.y+b.h)-y;
        const bridge=w>0&&h<=0&&h>=-2.5?{x:x-margin,y:y+h-margin,w:w+2*margin,h:-h+2*margin}
            :h>0&&w<=0&&w>=-2.5?{x:x+w-margin,y:y-margin,w:-w+2*margin,h:h+2*margin}:null;
        if(bridge&&!other.some(r=>overlaps(bridge,r)))rectangles.push(bridge);
    }
    return rectangleUnion(rectangles);
}
