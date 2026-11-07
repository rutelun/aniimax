// Web Worker hosting the wasm optimizer and the HiGHS solver. Solving can take long enough that
// running it on the main thread would freeze the page's own rendering, which is what makes the
// browser offer to kill the tab; every wasm call is dispatched through here instead, so the main
// thread stays free to paint a progress indicator while a solve is in flight. See `web/app.js`'s
// `callWorker` for the request/response contract this expects.
// The page starts this worker as `worker.js?load=<page load time>` (see app.js), and the wasm
// module is loaded with the same query and a revalidated fetch, so a page never pairs new page
// code with an older cached solver.
// The message handler below is installed right away and waits on this, so no request can arrive
// before there's a handler for it.
const load = new URL(import.meta.url).search;
const ready = import('./pkg/aniimax.js' + load).then(async (pkg) => {
    await pkg.default({ module_or_path: fetch(new URL('./pkg/aniimax_bg.wasm', import.meta.url), { cache: 'no-cache' }) });
    return pkg;
});

// Handlers taking a single string argument and returning one; `find_plan` and
// `rank_improvements` are handled separately below since they report progress.
const HANDLER_NAMES = ['time_to_reach', 'get_version', 'get_all_items'];

// Reuse the WASM runtime within a worker. The bundled solve() creates/destroys its native
// model and frees its LP file and allocations in finally, so consecutive solves stay isolated
// without repeatedly instantiating WASM and allocating another linear memory.
let highsBytes = null;
let highsRuntime = null;
async function newHighs() {
    if (!highsBytes) {
        highsBytes = fetch(new URL('./vendor/highs/highs.wasm', import.meta.url)).then(r => {
            if (!r.ok) throw new Error(`Could not load HiGHS (${r.status})`);
            return r.arrayBuffer();
        });
    }
    if (!highsRuntime) {
        highsRuntime = (async () => {
            const { default: highsModule } = await import('./vendor/highs/highs.mjs' + load);
            return highsModule({ wasmBinary: await highsBytes, print: () => {}, printErr: line => console.warn(line) });
        })().catch(error => { highsRuntime = null; throw error; });
    }
    return highsRuntime;
}

// Seconds HiGHS may search before settling for the best plan found so far.
const EXACT_TIME_LIMIT = 30;

// The season's points as a priority target (`SEASON_POINTS` in src/models.rs).
const SEASON_POINTS = 'season_points';

// HiGHS options for every solve.
const SOLVE_OPTIONS = { mip_rel_gap: 0, time_limit: EXACT_TIME_LIMIT };

// A tighter feasibility tolerance, used only to solve again when the plan built from an answer
// doesn't hold up: HiGHS can otherwise lean on rounding noise, a hair of negative production
// making something from nothing (seen at RV 9 with Coins then Aniimo EXP). It isn't the default
// because on a big model it can have HiGHS call a perfectly feasible plan infeasible (seen on the
// RV 17 level-up).
const STRICT_OPTIONS = { ...SOLVE_OPTIONS, mip_feasibility_tolerance: 1e-9 };

// Solves one exact-planner model with HiGHS: `{ values, proven, objective }`, or null if HiGHS
// found no plan at all. `objective` leaves out the model's tie-break (see `BUILDING_TIE_BREAK` in
// exact.rs), so it's what the plan really makes and can be a floor for a later solve.
async function solveModel(problem, options = SOLVE_OPTIONS, infeasibleMessage) {
    let result;
    try {
        const highs = await newHighs();
        result = highs.solve(problem.lp, options);
        if (result.Status === 'Infeasible') {
            // Presolve can call a tightly constrained model infeasible when it isn't.
            result = highs.solve(problem.lp, { ...options, presolve: 'off' });
        }
    } catch (error) {
        // A WASM trap must not poison subsequent requests handled by this worker.
        highsRuntime = null;
        throw error;
    }
    if (result.Status === 'Infeasible' && infeasibleMessage) throw new Error(infeasibleMessage);
    const proven = result.Status === 'Optimal';
    if (!proven && result.Status !== 'Time limit reached') return null;
    // Out of time before finding any plan at all.
    if (!Number.isFinite(result.ObjectiveValue) || !result.Columns) return null;
    const values = columnValues(problem, result);
    return { values, proven, objective: result.ObjectiveValue + tiebreakOf(problem, values) };
}

function hasSeasonCropMinimums(input) {
    return Boolean(input.season && Object.values(input.season_crop_minimums || {}).some(count => count > 0));
}

function hasMaterialProcessors(input) {
    return ['Woodworking Bench', 'Chimney Kiln'].some(facility =>
        (input.facilities?.[facility] ?? [{ count: 1 }]).some(tier => tier.count > 0));
}

function columnValues(problem, result) {
    return Array.from({ length: problem.variables }, (_, i) => result.Columns?.['x' + i]?.Primal ?? 0);
}

// What the model's tie-break (see `BUILDING_TIE_BREAK` in exact.rs) took off an objective.
function tiebreakOf(problem, values) {
    return (problem.tiebreak || []).reduce((sum, [v, weight]) => sum + weight * (values[v] || 0), 0);
}

// The exact planner (see `exact_problem` in wasm.rs): builds the model in wasm, solves it with
// HiGHS, and turns the answer back into a plan. With "prioritize byproducts" on, it first finds
// the most of each byproduct the facilities can make and requires the plan to keep that much.
// With priorities (coins, Aniimo EXP, Aniipods, Wood Blocks, Mineral Sand), it makes as much of
// each as the ones before it allow, then earns coins with what's left.
// For the level-up strategy, it first finds the soonest level-up and requires the plan to keep
// that pace; if the facilities can't make the level-up at all, the plan is for coins and says so.
// During a season it then makes the most season points that pace allows, which the coin solve
// keeps.
// Returns the plan's JSON, or throws with the reason it couldn't, so the caller can fall back to
// `find_plan` and say why. `step(key, state, proven)` reports each solve as it starts and ends,
// and whether it proved its answer, for the page's progress card: `priority:<target>`,
// `level_up`, `season`, `final`, `stock_up` and `check`. `first(top)` gets the plan's first solve with
// nothing before it, `{ measure, objective, proven }`: the most of its first priority, its
// level-up pace, or its Home Coins. The page's Opportunities solve that same model for the plan
// as it stands, so they take it from here.
async function exactPlanJson(pkg, payload, step = () => {}, first = () => {}) {
    const { exact_byproduct_problems, exact_priority_problem, exact_level_up_problem, exact_problem, exact_plan } = pkg;
    const input = JSON.parse(payload);
    const stage = { floors: [] };
    const solve = problem => solveModel(problem, SOLVE_OPTIONS,
        hasSeasonCropMinimums(input) && !stage.floors.length && !stage.pace
            ? 'The minimum event crop plots cannot be met. Check plot levels, growing conditions, and the seed budget.'
            : undefined);
    let allProven = true;
    if (!input.level_up_strategy && (input.crop_variety || input.season)) {
        step('crop_variety', 'start');
        const model = JSON.parse(pkg.exact_crop_variety_problem(payload));
        const most = model.lp ? await solve(model) : { objective: 0, proven: true };
        if (!most) throw new Error('no plan found for crop and tree variety');
        stage.crop_variety = Math.round(most.objective);
        allProven &&= most.proven;
        step('crop_variety', 'done', most.proven);
    }
    for (const problem of JSON.parse(exact_byproduct_problems(payload))) {
        const most = await solve(problem);
        if (!most) throw new Error(`no plan found for the most ${problem.resource}`);
        allProven &&= most.proven;
        stage.floors.push([problem.resource, most.objective]);
    }
    // The player's priorities, in order: each is made as much as the ones before it allow, and
    // the coin solve after them has to keep all of it up.
    for (const target of input.priorities || []) {
        step(`priority:${target}`, 'start');
        const alone = stage.floors.length === 0;
        const priority = JSON.parse(exact_priority_problem(payload, JSON.stringify(stage), target));
        if (!priority.lp) throw new Error('this setup isn\'t covered by the exact planner');
        const most = await solve(priority);
        step(`priority:${target}`, 'done', most?.proven);
        if (!most) throw new Error(`no plan found for the most ${target}`);
        if (alone) first({ measure: target, objective: most.objective, proven: most.proven });
        allProven &&= most.proven;
        stage.floors.push([target, Math.max(0, most.objective)]);
    }

    let levelUpNote = null;
    const levelUp = JSON.parse(exact_level_up_problem(payload));
    if (levelUp.lp) {
        step('level_up', 'start');
        const fastest = await solve(levelUp);
        step('level_up', 'done', fastest?.proven);
        if (!fastest) throw new Error('no plan found for the level-up');
        if (stage.floors.length === 0) first({ measure: 'level_up', objective: fastest.objective, proven: fastest.proven });
        if (fastest.objective > 1e-9) {
            allProven &&= fastest.proven;
            stage.pace = fastest.objective;
        } else {
            levelUpNote = 'unreachable';
        }
    }
    // During a season, a level-up plan makes as much of the season as that pace leaves room for
    // (or, with the level-up out of reach, already in stock or past RV 20, as the homeland can),
    // and the coin solve after it keeps those points. `level_up_strategy` says the player picked
    // the level-up strategy even when there's no level-up left to plan (`level_up` is null at RV
    // 20); the Priorities strategy ranks the points itself instead. Without this, season items only made it into a level-up
    // plan when they happened to pay the most coins: the Harvest Moon Festival's did, Magical
    // Wonder Night's (behind a Sunlamp, worth less) never do.
    if (input.level_up_strategy && input.season) {
        step('season', 'start');
        const most = await solve(JSON.parse(exact_priority_problem(payload, JSON.stringify(stage), SEASON_POINTS)));
        step('season', 'done', most?.proven);
        if (!most) throw new Error('no plan found for the most season points');
        allProven &&= most.proven;
        if (most.objective > 1e-12) stage.floors.push([SEASON_POINTS, most.objective]);
    }
    let stageJson = JSON.stringify(stage);
    let problem = JSON.parse(exact_problem(payload, stageJson));
    if (!problem.lp) throw new Error('this setup isn\'t covered by the exact planner');
    step('final', 'start');
    const alone = stage.floors.length === 0 && !stage.pace;
    let solved = await solve(problem);
    if (!solved) throw new Error('the solver found no plan');
    if (alone) first({ measure: 'coins', objective: solved.objective, proven: solved.proven });
    let proven = solved.proven && allProven;
    let bound = solved.objective;
    if (!proven) {
        // The same model without whole units: the most any plan could earn.
        const relaxed = (await newHighs()).solve(problem.lp.replace(/\nGeneral\n[\s\S]*\nEnd/, '\nEnd'), {});
        if (Number.isFinite(relaxed.ObjectiveValue)) {
            bound = Math.max(bound, relaxed.ObjectiveValue + tiebreakOf(problem, columnValues(problem, relaxed)));
        }
    }
    step('final', 'done', solved.proven);
    const coins = solved.objective;
    let materialWork;
    if (hasMaterialProcessors(input)) {
        const workStage = stage.pace ? { ...stage, coins } : { ...stage, floors: [...stage.floors, [input.currency || 'coins', coins]] };
        const workJson = JSON.stringify({ ...workStage, maximize_material_work: true });
        const workProblem = JSON.parse(exact_problem(payload, workJson));
        if (workProblem.lp) {
            step('materials', 'start');
            const worked = await solveModel(workProblem);
            step('materials', 'done', worked?.proven);
            if (!worked) throw new Error('no plan found for the Woodworking Bench and Chimney Kiln workload');
            allProven &&= solved.proven;
            materialWork = worked.objective;
            stageJson = workJson;
            problem = workProblem;
            solved = worked;
            proven &&= worked.proven;
        }
    }
    if (stage.pace) {
        // Prefer the materials the level-up needs while keeping the maximum workload.
        const stockStage = { ...stage, coins, material_work: materialWork };
        const stockJson = JSON.stringify(stockStage);
        step('stock_up', 'start');
        const stocked = await solveModel(JSON.parse(exact_problem(payload, stockJson)));
        step('stock_up', 'done', stocked?.proven);
        step('check', 'start');
        const stockedPlan = stocked
            && JSON.parse(exact_plan(payload, stockJson, JSON.stringify({ values: stocked.values, proven: proven && stocked.proven, bound })));
        if (stockedPlan && stockedPlan.success) {
            step('check', 'done');
            stockedPlan.level_up_note = levelUpNote;
            return JSON.stringify(stockedPlan);
        }
        console.warn('Level-up stock solve found no usable plan; keeping the plan without it.');
    }
    step('check', 'start');
    let json = exact_plan(payload, stageJson, JSON.stringify({ values: solved.values, proven, bound }));
    let plan = JSON.parse(json);
    if (!plan.success) {
        // The answer didn't survive being rebuilt exactly; solve again, this time refusing the
        // rounding noise it may have leaned on.
        const strict = await solveModel(problem, STRICT_OPTIONS);
        if (strict) {
            json = exact_plan(payload, stageJson, JSON.stringify({ values: strict.values, proven: strict.proven && allProven, bound }));
            plan = JSON.parse(json);
        }
    }
    if (!plan.success) throw new Error(plan.error || 'the plan failed its check');
    step('check', 'done');
    if (!levelUpNote) return json;
    plan.level_up_note = levelUpNote;
    return JSON.stringify(plan);
}

// Ranks changes the player could make (see `rankImprovements` in app.js). `payload` is
// `{ measure, base, candidates }`: `measure` is the priority target the plan leads with, or
// 'level_up' for the soonest level-up; `base` and each candidate are plan inputs. Each input's
// best `measure` is solved, and where that doesn't move, the most Home Coins while keeping it.
// Reports one `{ index, top, coins, proven }` per input as it goes, the base first (index -1).
async function rankImprovements(pkg, payload, report) {
    const { measure, base, candidates, baseTop: given } = JSON.parse(payload);
    const options = { ...SOLVE_OPTIONS, time_limit: 5 };
    const topOf = async (input) => {
        const json = JSON.stringify(input);
        const problem = JSON.parse(measure === 'level_up'
            ? pkg.exact_level_up_problem(json)
            : pkg.exact_priority_problem(json, JSON.stringify({ floors: [] }), measure));
        if (!problem.lp) return null;
        return solveModel(problem, options);
    };
    // Home Coins while keeping `top` of the measure; the same solve the plan itself runs next.
    const coinsAt = async (input, top) => {
        if (measure === 'coins') return null;
        const json = JSON.stringify(input);
        const problem = JSON.parse(measure === 'level_up'
            ? pkg.exact_problem(json, JSON.stringify({ floors: [], pace: top }))
            : pkg.exact_priority_problem(json, JSON.stringify({ floors: [[measure, Math.max(0, top)]] }), 'coins'));
        if (!problem.lp) return null;
        return solveModel(problem, options);
    };
    // The plan as it stands was solved just now; the page passes that on when it can.
    const baseTop = given?.measure === measure ? given : await topOf(base);
    if (!baseTop) {
        report({ index: -1, top: null });
        return;
    }
    let baseCoins;
    report({ index: -1, top: baseTop.objective, proven: baseTop.proven });
    for (const [index, input] of candidates.entries()) {
        const top = await topOf(input);
        if (!top) {
            report({ index, top: null });
            continue;
        }
        let coins = null;
        let proven = top.proven;
        // Only when the measure itself doesn't move does the Home Coins tiebreak matter.
        if (measure !== 'coins' && top.objective <= baseTop.objective * (1 + RANK_MIN_GAIN)) {
            if (baseCoins === undefined) baseCoins = await coinsAt(base, baseTop.objective);
            const candidateCoins = await coinsAt(input, top.objective);
            if (baseCoins && candidateCoins) {
                coins = { base: baseCoins.objective, value: candidateCoins.objective };
                proven &&= baseCoins.proven && candidateCoins.proven;
            }
        }
        report({ index, top: top.objective, coins, proven });
    }
}

// The smallest gain worth ranking, as a share of what the plan already makes: below it, a
// difference is as likely to be the solver's tolerances as a real improvement.
const RANK_MIN_GAIN = 1e-3;

self.onmessage = async (event) => {
    const { id, type, payload } = event.data;
    try {
        const pkg = await ready;
        if (type === 'rank_improvements') {
            await rankImprovements(pkg, payload, (result) => self.postMessage({ id, type: 'progress', count: result }));
            self.postMessage({ id, ok: true, result: null });
            return;
        }
        if (type === 'find_plan') {
            let result = null;
            let fallbackReason = null;
            // Each solve's start and end go to the page as progress, as `{ step, state, proven }`.
            const step = (key, state, proven) => self.postMessage({ id, type: 'progress', count: { step: key, state, proven } });
            try {
                let top = null;
                result = await exactPlanJson(pkg, payload, step, found => { top ||= found; });
                if (top) {
                    const plan = JSON.parse(result);
                    plan.measure_top = top;
                    result = JSON.stringify(plan);
                }
            } catch (error) {
                fallbackReason = error && error.message ? error.message : String(error);
                // The backup planner doesn't know the player's roster, so a roster plan stops here.
                const input = JSON.parse(payload);
                if (input.electricity || hasSeasonCropMinimums(input) || hasMaterialProcessors(input) || (!input.level_up_strategy && (input.crop_variety || input.season))) {
                    result = JSON.stringify({ success: false, error: fallbackReason });
                } else if (input.aniimo?.startsWith('roster')) {
                    console.warn('Exact planner failed on a roster:', error);
                    result = JSON.stringify({ success: false, error: `No plan found with these Aniimo: ${fallbackReason}.` });
                } else {
                    step('backup', 'start');
                    console.warn('Exact planner failed; using the backup planner instead:', error);
                }
            }
            if (!result) {
                // Forwarded straight from the wasm solver's own real trial-solve count (see
                // `find_plan`'s doc comment in wasm.rs); a `type: 'progress'` message, distinct
                // from the final `{ ok, result }` response below, so `app.js`'s `callWorker` can
                // relay it to a live progress bar without resolving the request early.
                const onProgress = (count) => self.postMessage({ id, type: 'progress', count });
                const plan = JSON.parse(pkg.find_plan(payload, onProgress));
                plan.fallback_reason = fallbackReason;
                result = JSON.stringify(plan);
            }
            self.postMessage({ id, ok: true, result });
            return;
        }
        const handler = HANDLER_NAMES.includes(type) ? pkg[type] : null;
        if (!handler) {
            throw new Error(`Unknown worker request type: ${type}`);
        }
        const result = payload === undefined ? handler() : handler(payload);
        self.postMessage({ id, ok: true, result });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error && error.message ? error.message : String(error) });
    }
};
