import {refineElectricStaffing, keepsProduction} from './electric-staffing.js';

const total = (terms, values) => terms.reduce((sum, [v, coefficient]) => sum + coefficient * values[v], 0);
const expression = terms => terms.map(([v, c]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} x${v}`).join(' ');

// Reassign a completed shift inside the same continuous-production and dispatch model.
// Holding the totals across worker variants preserves every harvest, sale, RV reserve,
// production rate and physical recipe choice. A faster worker can still change how long
// a kiln runs, provided its input availability and every competing job remain feasible.
export async function refineStaffing(problem, incumbent, solve, context) {
    const input=context?.input;
    const report=context?.report ? (() => {
        const reports=new Map();
        return values=>{
            if(!reports.has(values))reports.set(values,context.report(values));
            return reports.get(values);
        };
    })() : null;
    if(!report){
        let candidate=await refineClimate(problem,incumbent,solve);
        candidate=await refineShift(problem,candidate,solve,context);
        return refineClimate(problem,candidate,solve);
    }
    let candidate=await refineClimate(problem,incumbent,solve);
    if(candidate!==incumbent && !keepsProduction(report(incumbent.values),report(candidate.values)))candidate=incumbent;
    const shifted=await refineShift(problem,candidate,solve,{...context,report});
    if(shifted!==candidate && keepsProduction(report(candidate.values),report(shifted.values)))candidate=shifted;
    const climate=await refineClimate(problem,candidate,solve);
    if(climate!==candidate && keepsProduction(report(candidate.values),report(climate.values)))candidate=climate;
    return input?.roster ? preferOwnedPostWorkers(problem,candidate,context.input,report) : candidate;
}

// An owned pool can have a grower in the field and a second, completely idle
// copy. Swap only full-time posts. The mobile crew and its routes stay intact.
function preferOwnedPostWorkers(problem,shift,input,report){
    const members=input.roster.members;
    if(!members?.length || !problem.variable_keys || !problem.staffing_pools)return shift;
    const pools=problem.staffing_pools,posts=new Map();
    const climateSkills=new Map(problem.climate_skills);
    for(const [member,pool] of pools.entries())for(const v of pool.anchors){
        const key=problem.variable_keys[v];
        if(!key.startsWith('staff:'))continue;
        const building=key.split(':')[1];
        if(!posts.has(building))posts.set(building,[]);
        posts.get(building).push({member,pool,v});
    }
    const deployed=(pool,values)=>Math.max(Math.ceil(total(pool.work,values)-1e-6),
        Math.round(pool.anchors.reduce((n,v)=>n+values[v],0)));
    for(const options of posts.values())options.sort((a,b)=>Number(a.pool.reserve)-Number(b.pool.reserve)
        || (climateSkills.get(a.v)??0)-(climateSkills.get(b.v)??0));
    for(const options of posts.values())for(const source of options){
        if(shift.values[source.v]<0.5)continue;
        for(const dest of options){
            if(dest.pool.reserve || !members[dest.member])continue;
            // Climate output is fixed by the mode. Leave the more versatile
            // owned worker free when a less skilled one can cover the same post.
            if(!source.pool.reserve && !(climateSkills.get(dest.v)<climateSkills.get(source.v)))continue;
            const capacity=members[dest.member].count-(input.crop_peak_helpers?.[dest.member]??0);
            while(shift.values[source.v]>0.5 && deployed(dest.pool,shift.values)<capacity){
                const values=shift.values.slice();
                values[source.v]--;values[dest.v]++;
                for(const p of [source.pool,dest.pool])if(p.active!=null)values[p.active]=deployed(p,values);
                if(!keepsProduction(report(shift.values),report(values)))break;
                shift={...shift,values};
            }
        }
    }
    return shift;
}

// Minimize climate buildings (and avoid redundant overlapping pairs or empty units)
// while holding every recipe, site, route, power and sale variable fixed.
export async function refineClimate(problem, incumbent, solve) {
    const keys = problem?.variable_keys, original = incumbent?.values;
    if (!keys?.length || original?.length !== problem.variables || !problem.lp) return incumbent;
    const envVars = [], pairVars = [], pairRelaxVars = [], climateStaff = [], activeVars = [], extraVars = [];
    for (let v = 0; v < keys.length; v++) {
        const key = keys[v];
        if (key.startsWith('environment:')) envVars.push(v);
        else if (key.startsWith('pair:')) pairVars.push(v);
        else if (key.startsWith('pair_relax:')) pairRelaxVars.push(v);
        else if (key.startsWith('staff:') && !key.startsWith('staff:Crackle Generator:')) climateStaff.push(v);
        else if (key.startsWith('active:')) activeVars.push(v);
        else if (key.startsWith('extra#')) extraVars.push(v);
    }
    if (!envVars.length && !pairVars.length) return incumbent;
    const hasActiveClimate = envVars.some(v => original[v] > 0.5) || pairVars.some(v => original[v] > 0.5);
    if (!hasActiveClimate) return incumbent;

    const pools = problem.staffing_pools ?? [];
    const reserves = pools.filter(pool => pool.reserve);
    const reserveWork = reserves.flatMap(pool => pool.work);
    const reserveTime = total(reserveWork, original);
    const growers = pools.filter(pool => pool.crop.some(v => original[v] > 1e-9));
    const headcount = (team, values) => team.reduce((sum, pool) => sum + Math.max(0,
        Math.ceil(total(pool.work, values) - 1e-6),
        Math.round(pool.anchors.reduce((n, v) => n + values[v], 0))), 0);
    const people = headcount(pools, original), extra = headcount(reserves, original);
    const reserveStaffSet = new Set();
    const ownedClimateBuilding = new Set();
    for (const pool of pools) {
        for (const v of pool.anchors) {
            const key = keys[v];
            if (!key?.startsWith('staff:') || key.startsWith('staff:Crackle Generator:')) continue;
            if (pool.reserve) reserveStaffSet.add(v);
            else ownedClimateBuilding.add(key.split(':')[1]);
        }
    }
    const climateSkills = new Map(problem.climate_skills ?? []);
    const costs = new Map();
    for (const v of envVars) {
        const mode = keys[v].split(':')[2];
        costs.set(v, mode === 'Scorching' || mode === 'Freeze' ? -1.01 : -1.0);
    }
    for (const v of pairVars) costs.set(v, -2.05);
    for (const v of climateStaff) {
        if (reserveStaffSet.has(v)) costs.set(v, (costs.get(v) || 0) - 100);
        else {
            const skills = climateSkills.get(v) ?? 0;
            if (skills > 0) costs.set(v, (costs.get(v) || 0) - 1e-4 * skills);
        }
    }
    for (const pool of reserves) {
        if (pool.active != null) costs.set(pool.active, (costs.get(pool.active) || 0) - 1000);
    }
    const climateScore = values => {
        let s = 0;
        for (const [v, c] of costs) s += c * (values[v] ?? 0);
        return s;
    };

    const rows = [];
    if (pools.length) {
        if (reserveWork.length) rows.push(` climate_reserve_work: ${expression(reserveWork)} <= ${reserveTime + 1e-9}`);
        growers.forEach((pool, i) => rows.push(` climate_grower_${i}: ${expression(pool.work)} <= ${total(pool.work, original) + 1e-9}`));
        for (const [name, team, limit] of [['team', pools, people], ['reserves', reserves, extra]]) {
            const active = team.filter(pool => pool.active != null).map(pool => [pool.active, 1]);
            if (active.length) rows.push(` climate_people_${name}: ${expression(active)} <= ${limit}`);
        }
    }
    const generalSection = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const integers = new Set([...(generalSection?.[1] ?? '').matchAll(/\bx(\d+)\b/g)].map(m => Number(m[1])));
    const fixedVal = v => {
        const raw = original[v] ?? 0;
        return integers.has(v) ? Math.round(raw) : Math.max(0, raw);
    };

    // Extract bounds for all candidate climate/staffing variables once.
    const allManaged = new Set([...envVars, ...pairVars, ...(pools.length ? [...climateStaff, ...activeVars] : [])]);
    const extraSet = new Set(extraVars);
    const envOrPairSet = new Set([...envVars, ...pairVars]);
    const staffSet = new Set(climateStaff);
    const origBounds = new Map();
    const boundsMatch = problem.lp.match(/\nBounds\n([\s\S]*?)(?:\nGeneral\n|\nEnd)/);
    for (const line of (boundsMatch?.[1] ?? '').split('\n')) {
        const mRange = /^ ([^\s]+) <= x(\d+) <= ([^\s]+)$/.exec(line);
        if (mRange) {
            const v = Number(mRange[2]);
            if (allManaged.has(v)) origBounds.set(v, [Number(mRange[1]), Number(mRange[3])]);
            continue;
        }
        const mLower = /^ x(\d+) >= ([^\s]+)$/.exec(line);
        if (mLower) {
            const v = Number(mLower[1]);
            if (allManaged.has(v)) origBounds.set(v, [Number(mLower[2]), Infinity]);
        }
    }

    // Parse only the LP rows that touch climate/staffing/active variables, separating
    // out always_running worker-availability rows (-busy[m] + C * depleted[m] <= 0)
    // so dropping a climate building can free a worker when no starved recipe needs them.
    const subjMatch = problem.lp.match(/\nSubject To\n([\s\S]*?)\nBounds\n/);
    const subjLines = subjMatch ? subjMatch[1].split('\n') : [];
    const termRe = /([+-]?)\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?\s+)?x(\d+)/g;
    const opRe = /\s(<=|>=|=)\s([^\s]+)\s*$/;
    const parsedRows = [];
    const depletedRows = []; // { depletedVar, cap, staffTerms: [[v, c]], fixedBusy }
    const depletedSet = new Set();

    for (const line of subjLines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const rest = line.slice(colon + 1);
        const opMatch = opRe.exec(rest);
        if (!opMatch) continue;
        const lhsStr = rest.slice(0, opMatch.index);
        let hasManaged = false, hasEnvOrPair = false, hasStaff = false;
        const extrasInRow = [];
        for (const m of lhsStr.matchAll(/\bx(\d+)\b/g)) {
            const v = Number(m[1]);
            if (allManaged.has(v)) {
                hasManaged = true;
                if (envOrPairSet.has(v)) hasEnvOrPair = true;
                if (staffSet.has(v)) hasStaff = true;
            } else if (extraSet.has(v)) {
                extrasInRow.push(v);
            }
        }
        if (!hasManaged) continue;
        const managedTerms = [];
        let fixedSum = 0;
        let depletedVar = -1, depletedCoeff = 0;
        const op = opMatch[1], rhs = Number(opMatch[2]);
        const isDepletedRow = hasStaff && !hasEnvOrPair && extrasInRow.length === 1 && op === '<=' && Math.abs(rhs) < 1e-9;
        for (const t of lhsStr.matchAll(termRe)) {
            const v = Number(t[4]);
            const c = (t[1] === '-' ? -1 : 1) * Number((t[2] || '1') + (t[3] || ''));
            if (allManaged.has(v)) {
                managedTerms.push([v, c]);
            } else if (isDepletedRow && v === extrasInRow[0]) {
                depletedVar = v;
                depletedCoeff = c;
            } else if (!pairRelaxVars.includes(v)) {
                fixedSum += c * fixedVal(v);
            }
        }
        if (isDepletedRow && depletedVar >= 0 && depletedCoeff > 0) {
            depletedSet.add(depletedVar);
            depletedRows.push({
                depletedVar,
                cap: depletedCoeff,
                staffTerms: managedTerms.map(([v, c]) => [v, -c]), // busy[m] contribution
                fixedBusy: -fixedSum,
            });
            continue;
        }
        parsedRows.push({ name: line.slice(0, colon).trim(), terms: managedTerms, op, rhs: rhs - fixedSum });
    }

    // Add the reserve/grower/headcount guard rows in the same compact representation.
    const foldRow = (name, terms, op, rhs) => {
        const managed = [];
        let fixedSum = 0;
        for (const [v, c] of terms) {
            if (allManaged.has(v)) managed.push([v, c]);
            else fixedSum += c * fixedVal(v);
        }
        if (managed.length) parsedRows.push({ name, terms: managed, op, rhs: rhs - fixedSum });
    };
    if (pools.length) {
        if (reserveWork.length) foldRow('climate_reserve_work', reserveWork, '<=', reserveTime + 1e-9);
        growers.forEach((pool, i) => foldRow(`climate_grower_${i}`, pool.work, '<=', total(pool.work, original) + 1e-9));
        for (const [name, team, limit] of [['team', pools, people], ['reserves', reserves, extra]]) {
            const active = team.filter(pool => pool.active != null).map(pool => [pool.active, 1]);
            if (active.length) foldRow(`climate_people_${name}`, active, '<=', limit);
        }
    }

    // Check if freeing depleted climate workers would violate always_running work
    // conservation for any active starved recipe, and when valid, update the
    // coupled availability DAG (depleted -> factor -> pool_availability -> minimum
    // & selector reasons) so the spliced vector satisfies every native LP row.
    const updateAvailabilityDag = fullValues => {
        const freed = [];
        for (const d of depletedRows) {
            if ((original[d.depletedVar] ?? 0) <= 0.5) continue;
            const newBusy = d.fixedBusy + d.staffTerms.reduce((s, [v, c]) => s + c * (fullValues[v] ?? 0), 0);
            if (newBusy < d.cap - 1e-6) freed.push(d);
        }
        if (!freed.length) return [];
        const freedDepletedSet = new Set(freed.map(d => d.depletedVar));
        const raised = new Set();
        const factorToDepleted = new Map();
        const poolEdges = new Map(); // factor -> [maxVar, ...]
        const poolChoices = new Map(); // maxVar -> [{ factor, chosen }]
        const minReasonRows = new Map(); // minVar -> [{ factor, reason }]
        const unitReasonRows = new Map(); // unitKey -> [{ factor, reason, load }]
        const envelopeRows = [];
        const activeProductMin = new Set();
        for (const line of subjLines) {
            const colon = line.indexOf(':');
            if (colon < 0) continue;
            const rest = line.slice(colon + 1);
            const opMatch = opRe.exec(rest);
            if (!opMatch) continue;
            const op = opMatch[1], rhs = Number(opMatch[2]);
            const lhsStr = rest.slice(0, opMatch.index);
            const terms = [];
            let hasExtra = false;
            for (const t of lhsStr.matchAll(termRe)) {
                const v = Number(t[4]);
                const c = (t[1] === '-' ? -1 : 1) * Number((t[2] || '1') + (t[3] || ''));
                terms.push([v, c]);
                if (extraSet.has(v)) hasExtra = true;
            }
            if (!hasExtra) continue;
            // factor + depleted >= 1
            if (op === '>=' && Math.abs(rhs - 1) < 1e-9 && terms.length === 2 && terms[0][1] === 1 && terms[1][1] === 1) {
                const [a, b] = [terms[0][0], terms[1][0]];
                if (freedDepletedSet.has(a) && extraSet.has(b)) {
                    raised.add(b);
                    factorToDepleted.set(b, a);
                } else if (freedDepletedSet.has(b) && extraSet.has(a)) {
                    raised.add(a);
                    factorToDepleted.set(a, b);
                }
                continue;
            }
            // pool_availability: maximum - factor >= 0 (both extra#)
            if (op === '>=' && Math.abs(rhs) < 1e-9 && terms.length === 2
                && extraSet.has(terms[0][0]) && extraSet.has(terms[1][0]) && terms[0][1] * terms[1][1] === -1) {
                const maxV = terms[0][1] === 1 ? terms[0][0] : terms[1][0];
                const facV = terms[0][1] === -1 ? terms[0][0] : terms[1][0];
                if (!poolEdges.has(facV)) poolEdges.set(facV, []);
                poolEdges.get(facV).push(maxV);
                continue;
            }
            // pool_availability selector: maximum - factor + chosen <= 1 (all extra#, chosen integer)
            if (op === '<=' && Math.abs(rhs - 1) < 1e-9 && terms.length === 3
                && terms.every(([v]) => extraSet.has(v))) {
                const neg = terms.find(([, c]) => c === -1);
                const pos = terms.filter(([, c]) => c === 1);
                if (neg && pos.length === 2) {
                    const chosen = pos.find(([v]) => integers.has(v));
                    const maxV = pos.find(([v]) => v !== chosen?.[0]);
                    if (chosen && maxV) {
                        if (!poolChoices.has(maxV[0])) poolChoices.set(maxV[0], []);
                        poolChoices.get(maxV[0]).push({ factor: neg[0], chosen: chosen[0] });
                    }
                }
                continue;
            }
            // minimum selector: minimum - factor - reason >= -1 (all extra#, reason integer)
            // OR capacity_product: product - factor - bit >= -1 (all extra#, bit integer)
            if (op === '>=' && Math.abs(rhs + 1) < 1e-9 && terms.length === 3
                && terms.every(([v]) => extraSet.has(v))) {
                const pos = terms.find(([, c]) => c === 1);
                const negs = terms.filter(([, c]) => c === -1);
                if (pos && negs.length === 2) {
                    const intNeg = negs.find(([v]) => integers.has(v));
                    const contNeg = negs.find(([v]) => v !== intNeg?.[0]);
                    if (intNeg && contNeg) {
                        // Track both: if contNeg is a minimum var and intNeg is an active bit (>0.5), mark activeProductMin;
                        // if pos is a minimum var and intNeg is a reason binary, record for reason update.
                        if ((original[intNeg[0]] ?? 0) > 0.5 && (original[contNeg[0]] ?? 0) < 1 - 1e-6) {
                            activeProductMin.add(contNeg[0]);
                        }
                        if (!minReasonRows.has(pos[0])) minReasonRows.set(pos[0], []);
                        minReasonRows.get(pos[0]).push({ factor: contNeg[0], reason: intNeg[0] });
                        continue;
                    }
                }
            }
            // max==1 single-site selector: load - factor - reason >= -1 (non-extra load + 2 extra#)
            if (op === '>=' && Math.abs(rhs + 1) < 1e-9) {
                const nonExtra = terms.filter(([v]) => !extraSet.has(v));
                const negExtras = terms.filter(([v, c]) => extraSet.has(v) && c === -1);
                if (nonExtra.length && negExtras.length === 2) {
                    const reason = negExtras.find(([v]) => integers.has(v));
                    const factor = negExtras.find(([v]) => v !== reason?.[0]);
                    if (reason && factor) {
                        const key = nonExtra.map(([v, c]) => `${v}:${c}`).join(',');
                        const load = nonExtra.reduce((s, [v, c]) => s + c * fixedVal(v), 0);
                        if (!unitReasonRows.has(key)) unitReasonRows.set(key, []);
                        unitReasonRows.get(key).push({ factor: factor[0], reason: reason[0], load });
                    }
                }
            }
            // Envelope rows: minimum - sum(factors) >= 1 - n  OR  load - units - sum(factors) >= -n
            if (op === '>=' && rhs <= -0.5) {
                const negExtras = terms.filter(([v, c]) => extraSet.has(v) && c === -1).map(([v]) => v);
                if (negExtras.length) envelopeRows.push({ terms, rhs, negExtras });
            }
        }
        // Propagate raised=1 through pool_availability edges.
        const originOf = new Map();
        for (const [f, d] of factorToDepleted) originOf.set(f, new Set([d]));
        const queue = [...raised];
        while (queue.length) {
            const f = queue.pop();
            const origins = originOf.get(f);
            for (const maxV of (poolEdges.get(f) ?? [])) {
                if (!originOf.has(maxV)) originOf.set(maxV, new Set());
                const dst = originOf.get(maxV);
                let grew = false;
                for (const d of origins) if (!dst.has(d)) { dst.add(d); grew = true; }
                if (!raised.has(maxV) || grew) {
                    raised.add(maxV);
                    queue.push(maxV);
                }
            }
        }
        const locks = new Set();
        const minUpdates = [];
        for (const row of envelopeRows) {
            if (!row.negExtras.some(v => raised.has(v))) continue;
            const nonExtra = row.terms.filter(([v]) => !extraSet.has(v));
            const posExtras = row.terms.filter(([v, c]) => extraSet.has(v) && c === 1).map(([v]) => v);
            if (!nonExtra.length && posExtras.length === 1) {
                // minimum - sum(factors) >= 1 - n
                const minV = posExtras[0];
                const minVal = original[minV] ?? 1;
                const newMin = Math.min(...row.negExtras.map(f => raised.has(f) ? 1 : (original[f] ?? 1)));
                if (minVal < 1 - 1e-6 && activeProductMin.has(minV) && newMin > minVal + 1e-6) {
                    for (const f of row.negExtras) for (const d of (originOf.get(f) ?? [])) locks.add(d);
                } else {
                    minUpdates.push({ minV, factors: row.negExtras, newMin });
                }
            } else if (nonExtra.length) {
                // load - units - sum(factors) >= -n (single-site recipe)
                let loadMinusUnits = 0;
                let hasActiveUnit = false;
                for (const [v, c] of nonExtra) {
                    const val = fixedVal(v);
                    loadMinusUnits += c * val;
                    if (c === -1 && val > 0.5) hasActiveUnit = true;
                }
                if (!hasActiveUnit || loadMinusUnits >= -1e-6) continue;
                const load = 1 + loadMinusUnits;
                const stillStarved = row.negExtras.some(f => !raised.has(f) && (original[f] ?? 1) <= load + 1e-6);
                if (!stillStarved) {
                    for (const f of row.negExtras) for (const d of (originOf.get(f) ?? [])) locks.add(d);
                }
            }
        }
        if (locks.size) return freed.filter(d => locks.has(d.depletedVar));

        // Safe to free! Update depleted -> factor -> pool maximum/chosen -> minimum/reason -> single-site reason.
        for (const d of freed) fullValues[d.depletedVar] = 0;
        for (const f of raised) fullValues[f] = 1;
        for (const maxV of raised) {
            const choices = poolChoices.get(maxV);
            if (!choices?.length) continue;
            let picked = false;
            for (const { factor, chosen } of choices) {
                if (!picked && (fullValues[factor] ?? 0) >= 1 - 1e-6) {
                    fullValues[chosen] = 1;
                    picked = true;
                } else {
                    fullValues[chosen] = 0;
                }
            }
        }
        for (const { minV, newMin } of minUpdates) {
            fullValues[minV] = newMin;
            const reasons = minReasonRows.get(minV);
            if (!reasons?.length) continue;
            let picked = false;
            for (const { factor, reason } of reasons) {
                if (!picked && (fullValues[factor] ?? 1) <= newMin + 1e-6) {
                    fullValues[reason] = 1;
                    picked = true;
                } else {
                    fullValues[reason] = 0;
                }
            }
        }
        for (const reasons of unitReasonRows.values()) {
            if (!reasons.some(({ factor }) => raised.has(factor))) continue;
            const sumOrig = reasons.reduce((s, { reason }) => s + (original[reason] ?? 0), 0);
            if (sumOrig < 0.5) continue; // inactive site (units == 0)
            let picked = false;
            for (const { factor, reason, load } of reasons) {
                if (!picked && (fullValues[factor] ?? 1) <= load + 1e-6) {
                    fullValues[reason] = 1;
                    picked = true;
                } else {
                    fullValues[reason] = 0;
                }
            }
        }
        return [];
    };

    const baseFreeList = [...envVars, ...(pools.length ? [...climateStaff, ...activeVars] : [])];
    const runClimate = async (allowPairs, warm, lockedDepleted = []) => {
        const freeList = allowPairs ? [...baseFreeList, ...pairVars] : baseFreeList;
        const compactIdx = new Map(freeList.map((v, i) => [v, i]));
        const compactCosts = [];
        for (const v of freeList) {
            const c = costs.get(v);
            if (c) compactCosts.push([compactIdx.get(v), c]);
        }
        const compactRows = [];
        for (const row of parsedRows) {
            const terms = [];
            for (const [v, c] of row.terms) {
                const ci = compactIdx.get(v);
                if (ci !== undefined) terms.push([ci, c]);
            }
            if (!terms.length) continue;
            compactRows.push(` ${row.name}: ${expression(terms)} ${row.op} ${row.rhs}`);
        }
        for (const d of lockedDepleted) {
            const terms = d.staffTerms.filter(([v]) => compactIdx.has(v)).map(([v, c]) => [compactIdx.get(v), c]);
            if (terms.length) compactRows.push(` lock_dep_${d.depletedVar}: ${expression(terms)} >= ${d.cap - d.fixedBusy}`);
        }
        const boundLines = freeList.map((v, i) => {
            const [lo, hi] = origBounds.get(v) ?? [0, Infinity];
            return Number.isFinite(hi) ? ` ${lo} <= x${i} <= ${hi}` : ` x${i} >= ${lo}`;
        });
        const genLines = freeList.flatMap((v, i) => integers.has(v) ? [` x${i}`] : []);
        const lp = `Maximize\n obj: ${compactCosts.length ? expression(compactCosts) : '0'}\nSubject To\n${compactRows.join('\n')}\nBounds\n${boundLines.join('\n')}\n${genLines.length ? 'General\n' + genLines.join('\n') + '\n' : ''}End\n`;
        const sub = {
            variables: freeList.length,
            variable_keys: freeList.map(v => keys[v]),
            lp,
            primary_objective: compactCosts,
            tiebreak: [],
        };
        const compactWarm = warm ? freeList.map(v => warm[v] ?? 0) : undefined;
        let res;
        try {
            res = await solve(sub, {
                mip_max_nodes: 2048,
                mipIterations: 40000,
                mip_rel_gap: 0,
                mip_abs_gap: 0,
                mip_feasibility_tolerance: 1e-9,
                primal_feasibility_tolerance: 1e-9,
            }, undefined, compactWarm);
        } catch (error) {
            console.warn('Keeping the checked climate layout after a climate solve error.', error);
            return null;
        }
        if (!res?.values || res.values.length !== freeList.length || !res.values.every(Number.isFinite)) return null;
        const full = original.slice();
        for (const v of pairVars) full[v] = 0;
        for (const v of pairRelaxVars) full[v] = 0;
        for (let i = 0; i < freeList.length; i++) {
            const v = freeList[i];
            full[v] = integers.has(v) ? Math.round(res.values[i]) : Math.max(0, res.values[i]);
        }
        const locks = updateAvailabilityDag(full);
        if (locks.length && locks.some(d => !lockedDepleted.includes(d))) {
            return runClimate(allowPairs, warm, [...new Set([...lockedDepleted, ...locks])]);
        }
        return { ...res, values: full };
    };
    const isValid = values => {
        if (values?.length !== original.length || !values.every(Number.isFinite)) return false;
        if (!pools.length) return true;
        return total(reserveWork, values) <= reserveTime + 1e-8
            && headcount(pools, values) <= people
            && headcount(reserves, values) <= extra
            && !growers.some(pool => total(pool.work, values) > total(pool.work, original) + 1e-8);
    };

    const hasOriginalPair = pairVars.some(v => original[v] > 0.5);
    let bestValues = original, bestScore = climateScore(original);
    const standalone = await runClimate(false, hasOriginalPair ? undefined : original);
    let standaloneOk = false;
    if (standalone?.values && isValid(standalone.values)) {
        standaloneOk = true;
        const s = climateScore(standalone.values);
        if (s > bestScore + 1e-6) {
            bestValues = standalone.values;
            bestScore = s;
        }
    }
    let needPairs = pairVars.length > 0 && !standaloneOk;
    if (!needPairs && pairVars.length > 0 && standaloneOk) {
        const tempModes = new Set();
        for (const v of envVars) {
            if (standalone.values[v] <= 0.5) continue;
            const mode = keys[v].split(':')[2];
            if (mode === 'Warm' || mode === 'Scorching' || mode === 'Cool' || mode === 'Freeze') tempModes.add(mode);
        }
        const reserveHF = climateStaff.some(v =>
            reserveStaffSet.has(v) && standalone.values[v] > 0.5 && keys[v].startsWith('staff:Heat Furnace:'));
        const reserveCU = climateStaff.some(v =>
            reserveStaffSet.has(v) && standalone.values[v] > 0.5 && keys[v].startsWith('staff:Cooling Unit:'));
        const pairCanSaveReserve = (reserveHF && ownedClimateBuilding.has('Cooling Unit'))
            || (reserveCU && ownedClimateBuilding.has('Heat Furnace'));
        if (tempModes.size >= 3 || pairCanSaveReserve) needPairs = true;
    }
    if (needPairs) {
        const paired = await runClimate(true, standaloneOk ? standalone.values : original);
        if (paired?.values && isValid(paired.values)) {
            const s = climateScore(paired.values);
            if (s > bestScore + 1e-6) {
                bestValues = paired.values;
                bestScore = s;
            }
        }
    }
    return bestValues === original ? incumbent : { ...incumbent, values: bestValues };
}

async function refineShift(problem, incumbent, solve, context) {
    try {
        incumbent=await refineElectricStaffing(problem,incumbent,solve,context);
    } catch (error) {
        console.warn('Keeping the checked power settings after a staffing solve error.',error);
    }
    const pools = problem.staffing_pools, groups = problem.staffing_groups;
    if (!pools?.length || !groups?.length || incumbent?.values?.length !== problem.variables || !problem.lp) return incumbent;
    const work = pools.flatMap(pool => pool.work);
    if (!work.length) return incumbent;
    const original = incumbent.values;
    const keys = problem.variable_keys;
    const isClimateStaff = v => Boolean(keys?.[v]?.startsWith('staff:') && !keys[v].startsWith('staff:Crackle Generator:'));
    const retained = groups.map(group => group.reduce((sum, v) => sum + original[v], 0));
    const reserves = pools.filter(pool => pool.reserve);
    const poolHeadcount = (pool, values) => Math.max(0,
        Math.ceil(total(pool.work, values) - 1e-6),
        Math.round(pool.anchors.reduce((n, v) => n + values[v], 0)));
    const poolNonClimate = pool => ({
        work: pool.work.filter(([v]) => !isClimateStaff(v)),
        anchors: pool.anchors.filter(v => !isClimateStaff(v)),
    });
    const nonClimateByReserve = reserves.map(poolNonClimate);
    const poolNonClimateHeadcount = (nc, values) => Math.max(0,
        Math.ceil(total(nc.work, values) - 1e-6),
        Math.round(nc.anchors.reduce((n, v) => n + values[v], 0)));
    const headcount = (team, values) => team.reduce((sum, pool) => sum + poolHeadcount(pool, values), 0);
    const nonClimateReserveCount = values => nonClimateByReserve.reduce((sum, nc) => sum + poolNonClimateHeadcount(nc, values), 0);
    const nonClimateReserveWork = nonClimateByReserve.flatMap(nc => nc.work);
    const nonClimateReserveTime = total(nonClimateReserveWork, original);
    const growers = pools.filter(pool => !pool.reserve && pool.crop.some(v => original[v] > 1e-9));
    const people = headcount(pools, original), extra = headcount(reserves, original);
    const origNonClimateReserves = nonClimateReserveCount(original);
    const workDays = total(work, original);
    const climate = problem.climate_skills || [];

    const generalSection = problem.lp.match(/\nGeneral\n([\s\S]*?)\nEnd/);
    const integers = new Set([...(generalSection?.[1] ?? '').matchAll(/\bx(\d+)\b/g)].map(m => Number(m[1])));
    const fixedVal = v => {
        const raw = original[v] ?? 0;
        return integers.has(v) ? Math.round(raw) : Math.max(0, raw);
    };

    // Exact variable fixing: singleton groups, zero-sum groups, and inactive
    // route/post/haul columns cannot change while holding every recipe total fixed.
    const fixed = new Map();
    const activeGroups = [];
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        if (group.length === 1) {
            fixed.set(group[0], fixedVal(group[0]));
        } else if (retained[i] <= 1e-12) {
            for (const v of group) fixed.set(v, 0);
        } else {
            activeGroups.push([i, group, retained[i]]);
        }
    }
    if (keys?.length === problem.variables) {
        const byKey = new Map(keys.map((k, v) => [k, v]));
        for (let v = 0; v < keys.length; v++) {
            if (fixed.has(v) || (original[v] ?? 0) > 1e-12) continue;
            const key = keys[v];
            if (!key.startsWith('route:') && !key.startsWith('post:') && !key.startsWith('haul:')) continue;
            const m = /^(?:route|post|haul):(.+?):(?:owned|reserve):/.exec(key);
            if (!m) continue;
            const rateVar = byKey.get(`rate:${m[1]}#0`);
            if (rateVar !== undefined && fixed.get(rateVar) === 0) fixed.set(v, 0);
        }
    }

    // Parse bounds and LP rows once so fixed variables can be substituted out,
    // shrinking multi-thousand-variable shift models to only the active staffing core.
    const origBounds = new Map();
    const boundsMatch = problem.lp.match(/\nBounds\n([\s\S]*?)(?:\nGeneral\n|\nEnd)/);
    for (const line of (boundsMatch?.[1] ?? '').split('\n')) {
        const mRange = /^ ([^\s]+) <= x(\d+) <= ([^\s]+)$/.exec(line);
        if (mRange) {
            origBounds.set(Number(mRange[2]), [Number(mRange[1]), Number(mRange[3])]);
            continue;
        }
        const mLower = /^ x(\d+) >= ([^\s]+)$/.exec(line);
        if (mLower) origBounds.set(Number(mLower[1]), [Number(mLower[2]), Infinity]);
    }
    const subjMatch = problem.lp.match(/\nSubject To\n([\s\S]*?)\nBounds\n/);
    const subjLines = subjMatch ? subjMatch[1].split('\n') : [];
    const termRe = /([+-]?)\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:([eE][+-]?\d+))?\s+)?x(\d+)/g;
    const opRe = /\s(<=|>=|=)\s([^\s]+)\s*$/;
    let parsedRows = [];
    for (const line of subjLines) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const rest = line.slice(colon + 1);
        const opMatch = opRe.exec(rest);
        if (!opMatch) continue;
        const lhsStr = rest.slice(0, opMatch.index);
        const terms = [];
        for (const t of lhsStr.matchAll(termRe)) {
            const v = Number(t[4]);
            const c = (t[1] === '-' ? -1 : 1) * Number((t[2] || '1') + (t[3] || ''));
            terms.push([v, c]);
        }
        if (terms.length) parsedRows.push({ name: line.slice(0, colon).trim(), terms, op: opMatch[1], rhs: Number(opMatch[2]) });
    }
    for (const [i, group, rhs] of activeGroups) {
        parsedRows.push({ name: `retain_shift_${i}`, terms: group.map(v => [v, 1]), op: '=', rhs });
    }

    // Substitute fixed variables and propagate forced equalities / zero rows.
    const substituteRows = rows => {
        const kept = [];
        for (const row of rows) {
            const terms = [];
            let rhs = row.rhs;
            for (const [v, c] of row.terms) {
                const fv = fixed.get(v);
                if (fv !== undefined) rhs -= c * fv;
                else terms.push([v, c]);
            }
            if (terms.length) kept.push({ name: row.name, terms, op: row.op, rhs });
        }
        return kept;
    };
    for (let pass = 0; pass < 4; pass++) {
        parsedRows = substituteRows(parsedRows);
        let newlyFixed = 0;
        for (const row of parsedRows) {
            if (row.terms.length === 1 && row.op === '=') {
                const [v, c] = row.terms[0];
                if (!fixed.has(v) && Math.abs(c) > 1e-12) {
                    const val = row.rhs / c;
                    if (Number.isFinite(val) && Math.abs(val - fixedVal(v)) < 1e-5) {
                        fixed.set(v, integers.has(v) ? Math.round(val) : Math.max(0, val));
                        newlyFixed++;
                    }
                }
            } else if (row.op === '<=' && row.rhs <= 1e-12
                && row.terms.every(([v, c]) => c > 0 && (origBounds.get(v)?.[0] ?? 0) >= 0)) {
                for (const [v] of row.terms) {
                    if (!fixed.has(v) && (original[v] ?? 0) <= 1e-6) {
                        fixed.set(v, 0);
                        newlyFixed++;
                    }
                }
            } else if (row.op === '>=' && row.rhs >= -1e-12
                && row.terms.every(([v, c]) => c < 0 && (origBounds.get(v)?.[0] ?? 0) >= 0)) {
                for (const [v] of row.terms) {
                    if (!fixed.has(v) && (original[v] ?? 0) <= 1e-6) {
                        fixed.set(v, 0);
                        newlyFixed++;
                    }
                }
            }
        }
        if (!newlyFixed) break;
    }
    parsedRows = substituteRows(parsedRows);

    // Fix auxiliary extra# variables that live in components disconnected from
    // every free non-extra variable (e.g., inactive always_running recipes).
    if (keys?.length === problem.variables) {
        const adj = new Map();
        const seeds = new Set();
        const addEdge = (a, b) => {
            if (!adj.has(a)) adj.set(a, []);
            adj.get(a).push(b);
        };
        for (const row of parsedRows) {
            for (const [v] of row.terms) {
                if (!keys[v].startsWith('extra#')) seeds.add(v);
            }
            const first = row.terms[0][0];
            for (let j = 1; j < row.terms.length; j++) {
                const other = row.terms[j][0];
                addEdge(first, other);
                addEdge(other, first);
            }
        }
        const reachable = new Set(seeds);
        const queue = [...seeds];
        while (queue.length) {
            const cur = queue.pop();
            for (const nxt of (adj.get(cur) ?? [])) {
                if (!reachable.has(nxt)) {
                    reachable.add(nxt);
                    queue.push(nxt);
                }
            }
        }
        let prunedExtra = false;
        for (const row of parsedRows) {
            for (const [v] of row.terms) {
                if (keys[v].startsWith('extra#') && !reachable.has(v) && !fixed.has(v)) {
                    fixed.set(v, fixedVal(v));
                    prunedExtra = true;
                }
            }
        }
        if (prunedExtra) parsedRows = substituteRows(parsedRows);
    }

    // Collect every remaining free original variable.
    const freeSet = new Set();
    for (const row of parsedRows) for (const [v] of row.terms) freeSet.add(v);
    for (const pool of pools) {
        if (pool.active != null && !fixed.has(pool.active)) freeSet.add(pool.active);
        for (const [v] of pool.work) if (!fixed.has(v)) freeSet.add(v);
        for (const v of pool.anchors) if (!fixed.has(v)) freeSet.add(v);
    }
    if (!freeSet.size) return incumbent;
    const freeList = [...freeSet].sort((a, b) => a - b);
    const compactIdx = new Map(freeList.map((v, i) => [v, i]));
    const compactWarm = freeList.map(v => original[v] ?? 0);
    const compactBounds = freeList.map(v => origBounds.get(v) ?? [0, Infinity]);
    const compactInts = new Set(freeList.flatMap((v, i) => integers.has(v) ? [i] : []));
    const compactRows = [];
    const addCompactRow = (name, origTerms, op, rhs, extraCompactTerms = []) => {
        const terms = [...extraCompactTerms];
        let adjRhs = rhs;
        for (const [v, c] of origTerms) {
            const ci = compactIdx.get(v);
            if (ci !== undefined) terms.push([ci, c]);
            else adjRhs -= c * (fixed.get(v) ?? fixedVal(v));
        }
        if (terms.length) compactRows.push(` ${name}: ${expression(terms)} ${op} ${adjRhs}`);
    };
    for (const row of parsedRows) {
        const terms = row.terms.map(([v, c]) => [compactIdx.get(v), c]);
        compactRows.push(` ${row.name}: ${expression(terms)} ${row.op} ${row.rhs}`);
    }

    // Track exact integer headcounts (total, reserves, and non-climate reserves)
    // even when max_working_aniimo is unset and pool.active is absent.
    const addAuxInt = warmVal => {
        const idx = compactWarm.length;
        compactWarm.push(warmVal);
        compactBounds.push([0, Infinity]);
        compactInts.add(idx);
        return idx;
    };
    const allActiveCompact = [];
    const reserveActiveCompact = [];
    const nonClimateReserveActiveCompact = [];
    for (let pIdx = 0; pIdx < pools.length; pIdx++) {
        const pool = pools[pIdx];
        const hasFree = pool.work.some(([v]) => compactIdx.has(v)) || pool.anchors.some(v => compactIdx.has(v));
        let actIdx = pool.active != null ? compactIdx.get(pool.active) : undefined;
        if (actIdx === undefined && hasFree) {
            actIdx = addAuxInt(poolHeadcount(pool, original));
            addCompactRow(`aux_act_w_${pIdx}`, pool.work, '<=', 0, [[actIdx, -1]]);
            if (pool.anchors.length) {
                addCompactRow(`aux_act_a_${pIdx}`, pool.anchors.map(v => [v, 1]), '<=', 0, [[actIdx, -1]]);
            }
        }
        if (actIdx !== undefined) {
            allActiveCompact.push([actIdx, 1]);
            if (pool.reserve) reserveActiveCompact.push([actIdx, 1]);
        }
        if (pool.reserve) {
            const nc = poolNonClimate(pool);
            const hasNcFree = nc.work.some(([v]) => compactIdx.has(v)) || nc.anchors.some(v => compactIdx.has(v));
            if (hasNcFree) {
                const ncIdx = addAuxInt(poolNonClimateHeadcount(nc, original));
                if (nc.work.length) addCompactRow(`aux_nc_w_${pIdx}`, nc.work, '<=', 0, [[ncIdx, -1]]);
                if (nc.anchors.length) addCompactRow(`aux_nc_a_${pIdx}`, nc.anchors.map(v => [v, 1]), '<=', 0, [[ncIdx, -1]]);
                nonClimateReserveActiveCompact.push([ncIdx, 1]);
            }
        }
    }

    // Hold non-climate reserve load and grower workloads so swapping a versatile
    // owned worker off a static climate post onto workshops (placing an assumed
    // worker on climate instead) is permitted and rewarded, without degrading harvests.
    if (nonClimateReserveWork.length) {
        addCompactRow('retain_non_climate_reserve', nonClimateReserveWork, '<=', nonClimateReserveTime + 1e-9);
    }
    growers.forEach((pool, i) => addCompactRow(`retain_harvest_${i}`, pool.work, '<=', total(pool.work, original) + 1e-9));
    if (reserveActiveCompact.length) {
        const fixedReserveHeadcount = reserves.reduce((s, pool) =>
            s + (pool.work.some(([v]) => compactIdx.has(v)) || pool.anchors.some(v => compactIdx.has(v)) || (pool.active != null && compactIdx.has(pool.active))
                ? 0 : poolHeadcount(pool, original)), 0);
        compactRows.push(` retain_people_reserves: ${expression(reserveActiveCompact)} <= ${Math.max(0, extra - fixedReserveHeadcount)}`);
    }
    if (extra === 0 && allActiveCompact.length) {
        const fixedHeadcount = pools.reduce((s, pool) =>
            s + (pool.work.some(([v]) => compactIdx.has(v)) || pool.anchors.some(v => compactIdx.has(v)) || (pool.active != null && compactIdx.has(pool.active))
                ? 0 : poolHeadcount(pool, original)), 0);
        compactRows.push(` retain_people_team: ${expression(allActiveCompact)} <= ${Math.max(0, people - fixedHeadcount)}`);
    }

    // Lexicographic staffing objective (Maximize):
    // 1. Minimize total assumed reserves headcount
    // 2. Minimize total active team headcount
    // 3. Minimize non-climate assumed reserves headcount (prefer assumed on static climate posts over workshops)
    // 4. Minimize non-climate reserve work and total work-days (prefer faster owned Lv.4/trait workers)
    // 5. Minimize climate_skills on owned climate/generator posts
    // 6. Prefer focused growers (no Hauling, fewer unrelated abilities) on crop work
    const W = 2 + Math.ceil(Math.max(workDays, people, 1));
    const compactCosts = new Map();
    const addCost = (ci, delta) => {
        if (ci !== undefined && delta) compactCosts.set(ci, (compactCosts.get(ci) || 0) + delta);
    };
    for (const [ci] of reserveActiveCompact) addCost(ci, -10 * W);
    for (const [ci] of allActiveCompact) addCost(ci, -3 * W);
    for (const [ci] of nonClimateReserveActiveCompact) addCost(ci, -W);
    for (const [v, days] of nonClimateReserveWork) addCost(compactIdx.get(v), -2 * days);
    for (const [v, days] of work) addCost(compactIdx.get(v), -days);
    for (const [v, skills] of climate) addCost(compactIdx.get(v), -1e-3 * skills);
    const cropDistractionTerms = [];
    const members = context?.input?.roster?.members;
    if (members?.length) {
        for (const [member, pool] of pools.entries()) {
            if (pool.reserve || !pool.crop?.length || !members[member]?.abilities) continue;
            const abilities = members[member].abilities;
            const hauling = Math.min(4, abilities.Hauling || 0);
            const skillCount = Object.values(abilities).filter(lv => lv > 0).length;
            const penalty = hauling * 4 + skillCount;
            if (penalty <= 1) continue;
            const cropSet = new Set(pool.crop);
            for (const [v, days] of pool.work) {
                if (!cropSet.has(v)) continue;
                addCost(compactIdx.get(v), -1e-4 * penalty * days);
                cropDistractionTerms.push([v, penalty * days]);
            }
        }
    }

    const boundLines = compactBounds.map(([lo, hi], i) =>
        Number.isFinite(hi) ? ` ${lo} <= x${i} <= ${hi}` : ` x${i} >= ${lo}`);
    const genLines = [...compactInts].sort((a, b) => a - b).map(i => ` x${i}`);
    const objTerms = [...compactCosts];
    const lp = `Maximize\n obj: ${objTerms.length ? expression(objTerms) : '0'}\nSubject To\n${compactRows.join('\n')}\nBounds\n${boundLines.join('\n')}\n${genLines.length ? 'General\n' + genLines.join('\n') + '\n' : ''}End\n`;
    const staffing = {
        variables: compactWarm.length,
        variable_keys: [
            ...freeList.map(v => keys?.[v] ?? `v${v}`),
            ...Array.from({ length: compactWarm.length - freeList.length }, (_, i) => `aux_staff#${i}`),
        ],
        lp,
        primary_objective: objTerms,
        tiebreak: [],
    };
    // Fast exact LP ceiling check: if the continuous relaxation cannot improve
    // upon the feasible warm staffing score, the incumbent is already optimal.
    if (context?.highs?.solve && objTerms.length) {
        const warmScore = total(objTerms, compactWarm);
        const lpCheck = context.highs.solve(lp.replace(/\nGeneral\n[\s\S]*?\nEnd/, '\nEnd'));
        if (lpCheck.Status === 'Optimal' && Number.isFinite(lpCheck.ObjectiveValue)
            && lpCheck.ObjectiveValue <= warmScore + 1e-7) {
            return incumbent;
        }
    }
    let result;
    try {
        result = await solve(staffing, {
            mip_max_nodes: 2048,
            mipIterations: 40000,
            mip_rel_gap: 0,
            mip_abs_gap: 0,
            mip_feasibility_tolerance: 1e-9,
            primal_feasibility_tolerance: 1e-9,
        }, undefined, compactWarm);
    } catch (error) {
        console.warn('Keeping the checked production shift after a staffing solve error.',error);
        return incumbent;
    }
    if (!result?.values || result.values.length < freeList.length || !result.values.slice(0, freeList.length).every(Number.isFinite)) return incumbent;
    const values = original.slice();
    for (const [v, fv] of fixed) values[v] = fv;
    for (let i = 0; i < freeList.length; i++) {
        const v = freeList[i];
        values[v] = integers.has(v) ? Math.round(result.values[i]) : Math.max(0, result.values[i]);
    }
    const sameShift = groups.every((group, i) =>
        Math.abs(group.reduce((sum, v) => sum + values[v], 0) - retained[i]) <= 1e-9 * Math.max(1, Math.abs(retained[i])));
    if (!sameShift || total(nonClimateReserveWork, values) > nonClimateReserveTime + 1e-8) return incumbent;
    const newReserves = headcount(reserves, values);
    const newPeople = headcount(pools, values);
    const newNonClimateReserves = nonClimateReserveCount(values);
    if (newReserves > extra || (newReserves === extra && newPeople > people)
        || growers.some(pool => total(pool.work, values) > total(pool.work, original) + 1e-8)) return incumbent;
    const saved = workDays - total(work, values);
    const nonClimateWorkSaved = nonClimateReserveTime - total(nonClimateReserveWork, values);
    const cropFocusImproved = cropDistractionTerms.length > 0
        && total(cropDistractionTerms, original) - total(cropDistractionTerms, values) > 1e-6;
    const improved = newReserves < extra
        || (newReserves === extra && newPeople < people)
        || (newReserves === extra && newPeople === people && newNonClimateReserves < origNonClimateReserves)
        || (newReserves === extra && newPeople === people && newNonClimateReserves === origNonClimateReserves && (
            nonClimateWorkSaved > 1e-8
            || saved > 1e-8
            || (saved >= -1e-9 && (total(climate, original) - total(climate, values) > 0.5 || cropFocusImproved))
        ));
    if (improved) {
        // The secondary solve's score and bound concern staffing. Retain the production proof.
        return {...incumbent, values};
    }
    return incumbent;
}
