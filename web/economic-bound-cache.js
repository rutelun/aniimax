// Workers come and go between setup edits. Reuse only a completed proof for
// the same build, LP, column identities and solver settings.
const memory = new Map();
const maxEntries = 64;
const maxEntryChars = 128 * 1024;
let database;

function openDatabase() {
    if (!globalThis.indexedDB) return null;
    return database ??= new Promise(resolve => {
        const request = indexedDB.open('aniimax-economic-bounds', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('bounds', {keyPath:'key'}).createIndex('written', 'written');
        };
        request.onerror = request.onblocked = () => resolve(null);
        request.onsuccess = () => {
            const db = request.result;
            db.onversionchange = () => { db.close(); database = undefined; };
            resolve(db);
        };
    });
}

async function read(key) {
    const db = await openDatabase();
    if (!db) return;
    return new Promise((resolve,reject) => {
        const request = db.transaction('bounds').objectStore('bounds').get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result?.value);
    });
}

async function write(key,value) {
    const db = await openDatabase();
    if (!db) return;
    await new Promise((resolve,reject) => {
        const tx = db.transaction('bounds','readwrite');
        const store = tx.objectStore('bounds');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
        store.put({key,value,written:Date.now()});
        const count = store.count();
        count.onsuccess = () => {
            let excess = count.result - maxEntries;
            if (excess <= 0) return;
            const oldest = store.index('written').openCursor();
            oldest.onsuccess = () => {
                const cursor = oldest.result;
                if (!cursor) return;
                cursor.delete();
                if (--excess > 0) cursor.continue();
            };
        };
    });
}

function remember(key,value) {
    if (memory.size >= maxEntries) memory.delete(memory.keys().next().value);
    memory.set(key,value);
}

export async function cachedEconomicBound(problem,options,solve) {
    if (options.discovery || !globalThis.crypto?.subtle) return solve(problem,options);
    // A certification solve uses seed presence only to select its iteration
    // budget. Candidate values themselves never enter this solve.
    const {signal: _signal, onRecipes: _onRecipes, ...cacheable} = options;
    const settings = {...cacheable,seed:!!options.seed};
    const bytes = new TextEncoder().encode(JSON.stringify([2,import.meta.url,problem,settings]));
    let digest;
    try { digest = await crypto.subtle.digest('SHA-256',bytes); }
    catch { return solve(problem,options); }
    const key = Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
    let hit = memory.get(key);
    if (!hit) {
        try { hit = await read(key); } catch { /* Storage is optional in private browsing. */ }
        if (hit) remember(key,hit);
    }
    if (hit) {
        const result = structuredClone(hit.result);
        if (hit.useModelKeys) result.keys = problem.variable_keys.slice();
        return result;
    }
    const result = await solve(problem,options);
    if (!Number.isFinite(result?.upper) || !Number.isFinite(result.objective)
        || result.values?.length !== problem.variables || !result.values.every(Number.isFinite)) return result;
    const gap = result.upper - result.objective;
    const epsilon = 1e-8 * Math.max(1,Math.abs(result.objective));
    const closed = result.proven && Math.abs(gap) <= epsilon;
    // Keep the native dual bound and proof status. A measured search can also
    // finish by certifying the physical income target or its requested MIP gap.
    const withinTarget = options.exact && options.relativeGap > 0 && options.incomeTarget > 0
        && gap >= -epsilon && (result.upper <= options.incomeTarget
            || (result.objective >= options.incomeTarget && gap <= options.relativeGap * Math.abs(result.objective)));
    if (closed || withinTarget) {
        const entry = {result:{...result}};
        // Column identities already form part of the cache key. Storing them
        // a second time put measured roster models over the entry size limit.
        if (result.keys && result.keys.length === problem.variable_keys?.length
            && result.keys.every((key,i)=>key===problem.variable_keys[i])) {
            delete entry.result.keys;
            entry.useModelKeys = true;
        }
        if (JSON.stringify(entry).length <= maxEntryChars) {
            remember(key,structuredClone(entry));
            try { await write(key,entry); } catch { /* Quota or storage permissions can change mid-solve. */ }
        }
    }
    return result;
}
