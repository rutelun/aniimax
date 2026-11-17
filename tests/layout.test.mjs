import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { improveFixedStorage, layOut, layOutHomeland, nearestStorage, layoutCost, refineDistrictClimate, refineDistrictDeliveries,
    refineStorageNeighborhood, seededStorageLayouts, layoutDeliveryCost, createInsideTest } from '../web/layout.js';
import { storageUnitLimit } from '../web/facility-config.js';
import { fastLayoutSeed } from '../web/fast-layout.js';

const cells = [{ x: 0, y: 0, w: 20, h: 15 }, { x: 20, y: 0, w: 20, h: 15 }];
const pieces = Array.from({ length: 24 }, (_, index) => ({
    members: [{ x: 0, y: 0, w: 2, h: 2, weight: 5 + index, facility: 'Farmland' }],
}));
const overlap = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6
    && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;
const cost = layout => layout.pieces.flatMap(p => p.members).reduce((sum, member) => {
    const storage = nearestStorage(member, layout.storages);
    return sum + member.weight * Math.hypot(member.x + member.w / 2 - storage.x - storage.w / 2,
        member.y + member.h / 2 - storage.y - storage.h / 2);
}, 0);

test('storage placement follows the RV rank table', () => {
    assert.deepEqual(Array.from({ length: 20 }, (_, index) => storageUnitLimit(index + 1)),
        [0, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 8]);
});

test('shortest delivery can move an active powered mine into free supplied space', () => {
    const open = [{ x: 0, y: 0, w: 4, h: 12 }, { x: 4, y: 8, w: 10, h: 4 }];
    const bounds = { x: 0, y: 0, w: 14, h: 12 };
    const mine = { x: 10, y: 8, w: 3, h: 3, facility: 'Mine', weight: 10, electric_level: 2 };
    const layout = { storages: [{ x: 0, y: 0, w: 2, h: 2 }], pieces: [{ members: [mine] }],
        power: { poles: [], coverage: [{ ...bounds, connected: true }] } };
    const inside = createInsideTest(open);
    const refined = refineDistrictDeliveries(layout, [{ bounds, reserved: [] }], {
        passes: 1, includeMines: true, costOf: layoutDeliveryCost,
        canPlace: (_, __, rectangles) => rectangles.every(inside),
    });
    const relocated = refined.pieces[0].members[0];
    assert.ok(layoutDeliveryCost(refined) < layoutDeliveryCost(layout));
    assert.ok(inside(relocated) && !overlap(relocated,layout.storages[0]));
    assert.equal(relocated.electric_level,2);
});

test('shortest delivery repositions the climate source and the trees it covers together', () => {
    const open = [{ x: 0, y: 0, w: 24, h: 24 }];
    const store = { x: 0, y: 0, w: 2, h: 2 };
    const source = { x: 0, y: 0, w: 2, h: 2, facility: 'Cooling Unit' };
    const trees = [12,8].map(weight => ({ w: 2, h: 2, zone: 0, weight, facility: 'Woodland' }));
    const cluster = { cluster: true, buildings: [source], plots: trees, planned: [{ x: 2, y: 0 }, { x: 0, y: 2 }] };
    const workshop = { members: [{ x: 0, y: 0, w: 2, h: 2, weight: 0 }] };
    const existing = { storages: [store], pieces: [{ ...cluster, members: [
        { ...source, x: 10, y: 15 }, { ...trees[0], x: 12, y: 15 }, { ...trees[1], x: 10, y: 17 },
    ] }, { members: [{ ...workshop.members[0], x: 12, y: 12 }] }], unplaced: [] };
    const refined = refineDistrictClimate(existing, [cluster, workshop], open,
        { fast: true, accountForWorkers: false, clusterTries: 3, costOf: layoutDeliveryCost });
    assert.ok(layoutDeliveryCost(refined) < layoutDeliveryCost(existing) / 2);
    const [cooler, ...moved] = refined.pieces[0].members;
    assert.ok(cooler.y < 15);
    const coverage = { x: cooler.x + cooler.w / 2 - 4.5, y: cooler.y + cooler.h / 2 - 4.5, w: 9, h: 9 };
    assert.ok(moved.every(tree => overlap(tree, coverage) && !overlap(tree, store)));
    assert.deepEqual(refined.pieces[1].members, existing.pieces[1].members);
});

test('the fast RV 15 search improves the full-route seed with all facilities powered', async () => {
    const input = JSON.parse(await readFile(new URL('./fixtures/rv15-delivery-layout.json', import.meta.url), 'utf8'));
    let result;
    globalThis.self = { postMessage: layout => { result = layout; } };
    try {
        await import('../web/layout-worker.js');
        await self.onmessage({ data: input });
    } finally {
        delete globalThis.self;
    }
    assert.equal(result.unplaced.length, 0);
    assert.equal(result.power.disconnected, 0);
    assert.equal(result.storages.length, input.storageCount);
    assert.ok(layoutDeliveryCost(result) <= layoutDeliveryCost(fastLayoutSeed(input))+1e-8);
    const rectangles = [...result.storages, ...result.power.poles, ...result.pieces.flatMap(piece => piece.members)];
    const inside = createInsideTest(input.cells);
    assert.ok(rectangles.every((rect, i) => inside(rect) && rectangles.slice(i + 1).every(other => !overlap(rect, other))));
});

test('moving a storage after wiring shortens routes without moving facilities or covering poles', () => {
    const storage = { x: 0, y: 0, w: 2, h: 2 };
    const member = { x: 10, y: 4, w: 2, h: 2, weight: 4 };
    const pole = { x: 8, y: 4, w: 1.5, h: 1.5 };
    const layout = { storages: [storage], pieces: [{ members: [member] }], unplaced: [],
        power: { disconnected: 0, poles: [pole] } };
    const better = improveFixedStorage(layout, cells);
    assert.ok(cost(better) < cost(layout));
    assert.deepEqual(better.pieces[0].members, [member]);
    assert.deepEqual(better.power, layout.power);
    assert.ok(!overlap(better.storages[0], pole) && !overlap(better.storages[0], member));
});

test('multiple storage units shorten hauling and keep every placed facility clear', () => {
    const single = layOutHomeland(pieces, cells);
    const multiple = layOutHomeland(pieces, cells, { w: 2, h: 2 }, 3);
    assert.equal(multiple.unplaced.length, 0);
    assert.ok(multiple.storages.length > 1 && multiple.storages.length <= 3);
    assert.ok(cost(multiple) < cost(single));
    const rectangles = [...multiple.storages, ...multiple.pieces.flatMap(p => p.members)];
    rectangles.forEach((rectangle, index) => {
        assert.ok(rectangle.x >= 0 && rectangle.y >= 0
            && rectangle.x + rectangle.w <= 40 && rectangle.y + rectangle.h <= 15);
        assert.ok(rectangles.slice(index + 1).every(other => !overlap(rectangle, other)));
    });
});

test('multi-storage seeds reserve delivery destinations before packing buildings', () => {
    const layout = layOutHomeland(pieces, cells);
    const trials = [...seededStorageLayouts(layout, pieces, cells, { w: 2, h: 2 }, 3)];
    assert.ok(trials.length >= 1 && trials.length <= 2);
    for (const trial of trials) {
        assert.equal(trial.storages.length, 3);
        assert.deepEqual(trial.unplaced, []);
        assert.ok(cost(trial) < cost(layout));
        const rectangles = [...trial.storages, ...trial.pieces.flatMap(piece => piece.members)];
        assert.ok(rectangles.every((rectangle, index) => rectangles.slice(index + 1).every(other => !overlap(rectangle, other))));
    }
});

test('storage additions keep environment plots in their planned coverage', () => {
    const cluster = {
        cluster: true,
        buildings: [{ x: 0, y: 0, w: 2, h: 2, facility: 'Sunlamp', building: true }],
        plots: Array.from({ length: 4 }, () => ({ w: 2, h: 2, weight: 15, zone: 0, facility: 'Farmland' })),
        planned: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }],
    };
    const layout = layOutHomeland([cluster, ...pieces.slice(0, 8)], cells, { w: 2, h: 2 }, 3);
    assert.equal(layout.unplaced.length, 0);
    const [building, ...plots] = layout.pieces[0].members;
    const coverage = { x: building.x + building.w / 2 - 4.5, y: building.y + building.h / 2 - 4.5, w: 9, h: 9 };
    assert.ok(plots.every(plot => overlap(plot, coverage)));
    assert.ok(layout.storages.every(storage => layout.pieces.flatMap(p => p.members).every(member => !overlap(storage, member))));
});

test('RV without storage keeps the layout available without delivery targets', () => {
    const layout = layOutHomeland(pieces.slice(0, 3), cells, { w: 2, h: 2 }, 0);
    assert.deepEqual(layout.storages, []);
    assert.equal(layout.storage, null);
    assert.equal(layout.unplaced.length, 0);
    assert.equal(nearestStorage(layout.pieces[0].members[0], layout.storages), null);
});

test('refinement fills nearby holes with idle facilities even when worker routes are enabled', () => {
    const pieces = [
        { members: [{ x: 0, y: 0, w: 2, h: 2, weight: 5, workers: [[0, 2]] }] },
        { members: [{ x: 0, y: 0, w: 2, h: 2, weight: 0, facility: 'Idle table' }] },
    ];
    const initialLayout = { pieces: [
        { members: [{ ...pieces[0].members[0], x: 1, y: -1 }] },
        { members: [{ ...pieces[1].members[0], x: 9, y: -1 }] },
    ] };
    const layout = layOut(pieces, { cells: [{ x: -12, y: -8, w: 24, h: 16 }], initialLayout });
    assert.equal(layout.unplaced.length, 0);
    const idle = layout.pieces[1].members[0];
    assert.ok(Math.hypot(idle.x + 1, idle.y + 1) <= 2.01, 'idle building must use a free nearby position');
    assert.ok(!overlap(idle, layout.pieces[0].members[0]));
});

test('continuing a rotated environment layout preserves coverage and all physical units', () => {
    const pieces = [{ cluster: true,
        buildings: [{ x: 0, y: 0, w: 2, h: 2, weight: 0 }],
        plots: Array.from({ length: 4 }, () => ({ w: 2, h: 2, weight: 3, zone: 0, sensitive: true })),
        planned: [{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 2 }],
    }, ...Array.from({ length: 5 }, () => ({ members: [{ x: 0, y: 0, w: 2, h: 3, weight: 1 }] }))];
    const initialLayout = layOut(pieces);
    const layout = layOut(pieces, { initialLayout });
    assert.equal(layout.unplaced.length, 0);
    assert.equal(layout.pieces.flatMap(p => p.members).length, 10);
    const [building, ...plots] = layout.pieces[0].members;
    const coverage = { x: building.x - 3.5, y: building.y - 3.5, w: 9, h: 9 };
    assert.ok(plots.every(plot => overlap(plot, coverage)));
    const rectangles = [...layout.storages, ...layout.pieces.flatMap(p => p.members)];
    assert.ok(rectangles.every((r, i) => rectangles.slice(i + 1).every(other => !overlap(r, other))));
    assert.ok(cost(layout) <= cost(initialLayout) + 1e-5);
});

test('a frequent large producer can replace four small units in a fully occupied nearer bay', () => {
    const members = [
        { x: 10, y: 0, w: 4, h: 4, weight: 100, facility: 'Frequent producer' },
        ...[2, 4].flatMap(x => [0, 2].map(y => ({ x, y, w: 2, h: 2, weight: 0.1, facility: 'Infrequent producer' }))),
        { x: 6, y: 0, w: 4, h: 4, weight: 0, facility: 'Fixed building' },
    ];
    const pieces = members.map(m => ({ members: [{ ...m, x: 0, y: 0 }] }));
    const initialLayout = { pieces: members.map(m => ({ members: [m] })) };
    const options = { cells: [{ x: 0, y: 0, w: 14, h: 4 }],
        storages: [{ x: 0, y: 0, w: 2, h: 2 }], initialLayout, fixedPieces: new Set([5]) };
    const singleMoves = layOut(pieces, options);
    assert.equal(singleMoves.pieces[0].members[0].x, 10, 'single-building moves cannot escape this packing');
    const exchanged = layOut(pieces, { ...options, exchangeBudget: 24 });
    assert.equal(exchanged.pieces[0].members[0].x, 2);
    assert.equal(exchanged.unplaced.length, 0);
    assert.equal(exchanged.pieces.flatMap(p => p.members).length, members.length);
    assert.ok(layoutCost(exchanged) < layoutCost(singleMoves) / 2);
    assert.deepEqual(exchanged.pieces[5].members[0], members[5]);
    const rectangles = [...exchanged.storages, ...exchanged.pieces.flatMap(p => p.members)];
    assert.ok(rectangles.every((r, i) => rectangles.slice(i + 1).every(other => !overlap(r, other))));
});

test('a shorter delivery route is rejected when the joint move increases shared worker travel more', () => {
    const members = [
        { x: 10, y: 0, w: 4, h: 4, weight: 100, workers: [[0, 10000]] },
        ...[2, 4].flatMap(x => [0, 2].map(y => ({ x, y, w: 2, h: 2, weight: 0.1 }))),
        { x: 6, y: 0, w: 4, h: 4, weight: 0 },
        { x: 14, y: 0, w: 2, h: 4, weight: 0, workers: [[0, 10000]] },
    ];
    const pieces = members.map(m => ({ members: [{ ...m, x: 0, y: 0 }] }));
    const options = { cells: [{ x: 0, y: 0, w: 16, h: 4 }], storages: [{ x: 0, y: 0, w: 2, h: 2 }],
        initialLayout: { pieces: members.map(m => ({ members: [m] })) }, fixedPieces: new Set([5, 6]) };
    const initial = layOut(pieces, options);
    const exchanged = layOut(pieces, { ...options, exchangeBudget: 24 });
    assert.equal(exchanged.pieces[0].members[0].x, 10);
    assert.equal(exchanged.unplaced.length, 0);
    assert.ok(layoutCost(exchanged) <= layoutCost(initial) + 1e-6);
});

test('storage can exchange an occupied position with buildings without losing a physical unit', () => {
    // The useful 8x8 plot is completely full. A storage-only move cannot enter it.
    const members = [];
    for (let x=10;x<18;x+=2) for (let y=0;y<8;y+=2)
        members.push({x,y,w:2,h:2,weight:x===12&&y===2?0:10,facility:'Processor'});
    const pieces=members.map(m=>({members:[{...m,x:0,y:0}]}));
    const layout={pieces:members.map(m=>({members:[m]})),storages:[{x:0,y:0,w:2,h:2}],unplaced:[],tried:0};
    const cells=[{x:0,y:0,w:2,h:2},{x:10,y:0,w:8,h:8}];
    const before=structuredClone(layout);
    let checked = 0;
    const guarded = refineStorageNeighborhood(layout,pieces,cells,4,{
        accept: () => { checked++; return false; },
    });
    assert.ok(checked > 0, 'profitable physical moves were checked against the plan');
    assert.deepEqual(guarded, before, 'a route improvement cannot override the production check');
    const result=refineStorageNeighborhood(layout,pieces,cells);
    assert.ok(result.storages[0].x>=10);
    assert.equal(result.storages.length,1);
    assert.equal(result.unplaced.length,0);
    assert.equal(result.pieces.flatMap(p=>p.members).length,members.length);
    assert.ok(layoutCost(result)<layoutCost(layout));
    assert.deepEqual(layout,before,'joint moves must not mutate the previous layout');
    const rectangles=[...result.storages,...result.pieces.flatMap(p=>p.members)];
    assert.ok(rectangles.every((r,i)=>rectangles.slice(i+1).every(other=>!overlap(r,other))));
    assert.ok(rectangles.every(r=>cells.some(c=>r.x>=c.x&&r.y>=c.y&&r.x+r.w<=c.x+c.w&&r.y+r.h<=c.y+c.h)));
});

test('district delivery polish swaps compatible climate slots but rejects losing required coverage', () => {
    const groups = [{ bounds: { x: 0, y: 0, w: 18, h: 12 }, reserved: [] }];
    const heat = { x: 2, y: 2, w: 1, h: 1 };
    const cool = { x: 9, y: 2, w: 1, h: 1 };
    const pearl = { x: 4, y: 5, w: 2, h: 2, weight: 8, facility: 'Tidewhisper Sandcastle', zone: 1 };
    const layout = (x, zone) => ({
        storages: [{ x: 12, y: 5, w: 2, h: 2 }],
        pieces: [{ cluster: true, buildings: [heat, cool], members: [heat, cool, pearl,
            { x, y: 5, w: 2, h: 2, weight: 2, facility: 'Starfall Hammock', zone }] }],
    });
    const useSlots = (x) => ({ canPlace: (_, __, [rect]) => rect.y === 5 && (rect.x === 4 || rect.x === x) });
    const compatible = layout(6, 1);
    const swapped = refineDistrictDeliveries(compatible, groups, useSlots(6));
    assert.deepEqual(swapped.pieces[0].members.slice(2).map(r => r.x), [6, 4]);
    const incompatible = layout(10, 2);
    assert.deepEqual(refineDistrictDeliveries(incompatible, groups, useSlots(10)), incompatible);
});

test('district delivery polish moves distant wells toward final storage and respects the plan guard', () => {
    const groups = [{ bounds: { x: 0, y: 0, w: 20, h: 12 }, reserved: [] }];
    const layout = {
        storages: [{ x: 2, y: 4, w: 2, h: 2 }],
        pieces: [{ members: [{ x: 14, y: 5, w: 2, h: 2, weight: 4, facility: 'Well' }] }],
    };
    assert.deepEqual(refineDistrictDeliveries(layout, groups, { accept: () => false }), layout);
    const closer = refineDistrictDeliveries(layout, groups);
    assert.ok(cost(closer) <= cost(layout) * .2);
    assert.equal(overlap(closer.pieces[0].members[0], layout.storages[0]), false);
});

test('overlapping open cells cannot count the same land twice to cover a hole', () => {
    const inside = createInsideTest([{x:0,y:0,w:1,h:2},{x:0,y:0,w:1,h:2}]);
    assert.equal(inside({x:0,y:0,w:2,h:2}), false);
    assert.equal(inside({x:0,y:0,w:1,h:2}), true);
});

test('delivery refinement reaches the exhaustive quarter-grid optimum for a narrow bay', () => {
    const cells = [{x:0,y:0,w:2,h:2},{x:4.25,y:0,w:1,h:1}];
    const layout = {storages:[{x:0,y:0,w:2,h:2}], pieces:[{members:[
        {x:4.75,y:0,w:.5,h:.5,weight:10,facility:'Producer'},
    ]}]};
    const inside = createInsideTest(cells);
    let optimum = Infinity;
    for (let x=0;x<=5.25;x+=.25) for(let y=0;y<=2;y+=.25) {
        const r={...layout.pieces[0].members[0],x,y};
        if(inside(r)&&!overlap(r,layout.storages[0]))
            optimum=Math.min(optimum,layoutDeliveryCost({...layout,pieces:[{members:[r]}]}));
    }
    const result=refineDistrictDeliveries(layout,[{bounds:{x:0,y:0,w:5.25,h:2},reserved:[]}],{
        costOf:layoutDeliveryCost,quarterGrid:true,canPlace:(_,__,rs)=>rs.every(inside),
    });
    assert.ok(Math.abs(layoutDeliveryCost(result)-optimum)<1e-9);
});

test('small complete layout matches exhaustive global search on the quarter grid', () => {
    const cells=[{x:0,y:0,w:4,h:3}];
    const positions=(w,h)=>{
        const result=[];
        for(let x=0;x+w<=4;x+=.25)for(let y=0;y+h<=3;y+=.25)result.push({x,y,w,h});
        return result;
    };
    const sites=positions(1,1);
    let optimum=Infinity,checked=0;
    for(const storage of positions(2,2)) {
        const available=sites.filter(site=>!overlap(site,storage));
        for(const a of available)for(const b of available)if(!overlap(a,b)) {
            checked++;
            const d=r=>Math.hypot(r.x+.5-storage.x-1,r.y+.5-storage.y-1);
            optimum=Math.min(optimum,10*d(a)+d(b));
        }
    }
    const input=[10,1].map(weight=>({members:[{x:0,y:0,w:1,h:1,weight}]}));
    const result=layOutHomeland(input,cells,{w:2,h:2},1,{fast:true,accountForWorkers:false});
    assert.equal(checked,28210);
    assert.equal(result.unplaced.length,0);
    assert.ok(Math.abs(layoutDeliveryCost(result)-optimum)<1e-9);
});
