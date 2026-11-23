import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLinearLp} from '../web/highs-reuse.js';
import {withWorkshopCapacityCuts} from '../web/bound-tightening.js';

function workshop(capacity) {
    return {variables:7, variable_keys:['units:a','units:b','extra#0','extra#1','extra#2','extra#3','units:c'],
        lp:`Maximize
 obj: x0
Subject To
 sites: x0 + x1 + x6 <= ${capacity}
 a: x2 + 2 x3 - x0 = 0
 b: x4 + 2 x5 - x1 = 0
Bounds
 0 <= x0 <= 3
 0 <= x1 <= 3
 0 <= x2 <= 1
 0 <= x3 <= 1
 0 <= x4 <= 1
 0 <= x5 <= 1
 0 <= x6 <= 3
General
 x0
 x1
 x2
 x3
 x4
 x5
End`};
}

test('capacity cuts exclude fractional double bookings and preserve all whole recipe assignments',()=>{
    for(const capacity of [2,3,4,5]){
        const model=withWorkshopCapacityCuts(workshop(capacity));
        const cuts=parseLinearLp(model.lp,model.variables).rows.filter(row=>row.name.startsWith('machine_'));
        assert.ok(cuts.length);
        const fits=values=>cuts.every(({coefficients,hi})=>
            coefficients.reduce((n,[v,c])=>n+c*values[v],0)<=hi);
        for(let a=0;a<=3;a++)for(let b=0;b<=3;b++)for(const other of [0,.5,1]){
            if(a+b+other<=capacity)assert.ok(fits([a,b,a%2,a>>1,b%2,b>>1,other]));
        }
        // The relaxed counts consume exactly two sites. The second recipe's
        // half-activated pair cannot coexist with a whole single-site recipe.
        if(capacity===2)assert.equal(fits([1,1,1,0,0,.5,0]),false);
    }
});

test('a signed capacity row or a fractional selector cannot prove a workshop cover',()=>{
    const original=workshop(2);
    for(const lp of [original.lp.replace('0 <= x6','-2 <= x6'), original.lp.replace(' x3\n x4',' x4').replace(' x5\nEnd','End')]){
        const problem={...original,lp};
        assert.equal(withWorkshopCapacityCuts(problem),problem);
    }
});
