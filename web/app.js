import {siteSchedule,scheduledRate} from './recipe-timeline.js';
import {renderRecipeSchedule} from './recipe-schedule-view.js';
import {scheduleProfiles,haulingScheduleProfile} from './recipe-schedule-plan.js';
import {splitPhaseTasks} from './phase-work.js';
// Aniimax Web Application

import { currentLocale, sourceAttribute, translate } from './i18n.js?v=recommendations';
import './math-translation.js?v=results-columns';
import { autoMaximizeSeasonPoints } from './season-planning.js?v=optional-season-points';
import { normalizeMapStyle } from './map-style.js?v=production-groups';
import { productionGroupOutline } from './group-outline.js?v=compact-groups';
import { powerJobDetails } from './power-islands.js?v=independent-grids';
import { questIncome } from './quest-income.js';
import { splitProductionSites } from './physical-production.js';
import { cropPeakInput, selectCropPeakTeam, criticalCropJob } from './crop-peaks.js?v=team-support';
import { withCropSupport } from './crop-support.js?v=team-support';

import {
    FACILITIES, FACILITY_CATEGORIES, FACILITY_CATEGORY_BY_NAME, FACILITY_FOOTPRINTS, HOMELAND_PLOTS, HOMELAND_PLOT_SIZE,
    MAX_HOME_LEVEL, ANIIMO_MAX, simpleSetup, storageUnitLimit, powerPoleLimit, generatorLimit, LEISURE_FAMILIES,
    LEVEL_UP_COSTS, SPECIAL_RECIPES, SEASONS, RUNNING_SEASONS, seasonById, runningSeason, ANIIPOD_TIERS, PERSONALITY_PAIRS, personalityLetter, opposedPersonality,
} from './facility-config.js?v=leisure-families';
import { allocateTurnFacilities, redistributeTurnFacilityRows } from './turn-jobs.js?v=auto-worker-travel';
import { createShareUrl, readShareHash, urlWithoutShare } from './share-config.js?v=compact-roster';
import { nearestStorage } from './layout.js?v=logic-audit';
import { projectLayoutWork, layoutWalkingAdjustments, workerTravelDistances, workerTravelSeconds, measuredMovementEstimates } from './worker-travel.js?v=finite-movement';
import { assignFacilityStock, bufferedBatches, haulingWorkload, allocateHauling, haulingBatchTrips,
    haulingTravelSeconds, haulingWorkSeconds, pickupStockLimit } from './hauling.js?v=base-travel';
import { personalityInput, replacementCandidates, compareRecommendations, usefulUpgrade, keepBetterComparison, workerUsage } from './opportunity-comparison.js?v=logic-audit';
import { comparisonConcurrency, startComparisonQueue } from './comparison-queue.js?v=parallel-comparisons';
import { prepareOpportunities } from './opportunity-effects.js?v=auto-e-mode';
import aniimoCatalog from './aniimo-catalog.json' with { type: 'json' };
import { aniimoPortrait, attachRosterPicker, rosterCatalogId, rosterCatalogFamily, rosterFormName } from './roster-picker.js?v=rv22-families';
import { placeRosterCopy, ROSTER_ROW_SIZE, rosterSlotsFor, swapRosterSlots } from './roster-slots.js';
import { scheduleRosterCopies } from './roster-work.js?v=measured-walking';
import { buildDispatch, rosterJobSwitching, TASK_SWITCHING } from './task-switching.js?v=base-travel';
import { buildReactiveDispatch, permanentWorkers, measuredDispatchWork, routeDispatchKey, attachDeliveryFlows } from './reactive-dispatch.js';
import { placeBestJobs, recommendBestTeam } from './best-team.js?v=team-support';
import facilityIcons from './facility-icons.json' with { type: 'json' };
import { abilityGlyph, gameAbilityIcon } from './ability-icons.js?v=game-heads';

let wasmReady = false;

// The wasm optimizer runs in a Web Worker (see worker.js), not on the main thread: `find_plan`
// can take long enough on a complex facility setup that running it here would freeze the page's
// own rendering, which is what makes the browser offer to kill the tab. Every call site below
// goes through `callWorker` instead of calling a wasm-bindgen function directly.
let worker = null;
let nextRequestId = 0;
const pendingWorkerRequests = new Map();

// Tags this page load's worker (and, through it, the wasm solver; see worker.js) so the browser
// never runs a cached older solver next to newer page code.
const WORKER_URL = `./worker.js?load=${Date.now()}`;

function initWorker() {
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (event) => {
        const { id, type, ok, result, error, count } = event.data;
        const pending = pendingWorkerRequests.get(id);
        if (!pending) return;
        // A `find_plan` request can receive several `type: 'progress'` messages (the solver's own
        // real trial-solve count; see `find_plan`'s doc comment in wasm.rs) before its one final
        // `{ ok, result }` response; only the latter resolves/removes the pending request.
        if (type === 'progress') {
            if (pending.onProgress) pending.onProgress(count);
            return;
        }
        pendingWorkerRequests.delete(id);
        clearTimeout(pending.timer);
        if (ok) {
            pending.resolve(result);
        } else {
            pending.reject(new Error(error));
        }
    };
    worker.onerror = (event) => {
        console.error('Worker error:', event.message || event);
        pendingWorkerRequests.forEach(pending => {
            clearTimeout(pending.timer);
            pending.reject(new Error(event.message || 'The planner stopped'));
        });
        pendingWorkerRequests.clear();
    };
}

// Throws away the worker and anything still running in it, e.g. a Minimum-setup solve from an
// older Calculate click that would otherwise hold up the new one, and starts a fresh worker.
function restartWorker() {
    worker.terminate();
    pendingWorkerRequests.forEach(pending => {
        clearTimeout(pending.timer);
        pending.reject(new Error('Cancelled by a newer calculation'));
    });
    pendingWorkerRequests.clear();
    initWorker();
}

// Sends one request to the worker and resolves with its result (or rejects with its error);
// `type` is one of worker.js's `HANDLER_NAMES` or `'find_plan'`, and `payload` that function's
// own single string argument (omit for `get_version`/`get_all_items`, which take none).
// `onProgress(count)`, if given, gets each progress message before the result: `find_plan`
// sends every solve step and, from the backup planner, its trial count; see worker.js.
function callWorker(type, payload, onProgress) {
    return new Promise((resolve, reject) => {
        const id = ++nextRequestId;
        const timer = setTimeout(() => {
            pendingWorkerRequests.delete(id);
            reject(new Error('This setup took too long. Try simplifying the priorities.'));
            restartWorker();
        }, type === 'find_plan' ? SETUP_TIMEOUT : 30_000);
        pendingWorkerRequests.set(id, { resolve, reject, onProgress, timer });
        worker.postMessage({ id, type, payload });
    });
}

// Converts the solver's real, running trial-solve count (from `find_plan`'s progress callback;
// see worker.js) into a progress-bar fill percentage. The algorithm's exact total trial count
// isn't knowable in advance: several of its exclusion passes stop once they converge rather than
// running a fixed number of times (see `find_production_plan`'s doc comments in optimizer.rs), so
// there's no true denominator to divide by. Every tick this responds to is a genuinely completed
// trial solve, so unlike a purely decorative animation, a faster machine or a simpler facility
// setup visibly reaches each milestone sooner. Capped at 96% (not 100%) while still running, so
// the bar never visually claims "done" before `find_plan` actually returns; `runFindPlan` sets it
// to a literal 100% only once the result is actually back.
//
// Two phases, not one asymptotic curve for the whole run: the solver's own shape is bimodal, not
// smoothly decaying. The first `EARLY_PHASE_TRIALS` or so cover just the initial candidate
// solve (fast, and roughly the ENTIRE cost for a simple facility setup with nothing contested).
// Everything past that is the environment-coverage-CHOICE exclusion pass (see its doc comment in
// optimizer.rs), which reruns the full packing pipeline per trial and, for a facility setup with
// real contested resources, routinely runs into the hundreds of trials across its rounds of
// per-processor, per-ingredient, and pairs searches. A single asymptotic curve tuned to feel right
// for the fast, simple case (a low halfway trial count) makes that expensive long tail nearly
// invisible -- it's already past 90% by trial 100, then creeps for the remaining several hundred,
// which is exactly the "gets exponentially slower towards the end" complaint this two-phase
// version fixes: the SECOND phase gets its own, much larger halfway trial count, so the visual
// progress keeps moving noticeably through that long tail instead of flatlining near the cap.
const EARLY_PHASE_TRIALS = 15;
const EARLY_PHASE_PERCENT = 25;
const LATE_PHASE_HALFWAY_TRIALS = 120;
function trialCountToPercent(count) {
    if (count <= EARLY_PHASE_TRIALS) {
        return Math.round((EARLY_PHASE_PERCENT * count) / EARLY_PHASE_TRIALS);
    }
    const trialsIntoLatePhase = count - EARLY_PHASE_TRIALS;
    const latePhasePercentRange = 96 - EARLY_PHASE_PERCENT;
    const latePhaseFraction = trialsIntoLatePhase / (trialsIntoLatePhase + LATE_PHASE_HALFWAY_TRIALS);
    return Math.min(96, Math.round(EARLY_PHASE_PERCENT + latePhasePercentRange * latePhaseFraction));
}

// The most recently computed plan (the full JS object returned by find_plan, including
// `success`/`error`); held in memory so changing the goal amount can call time_to_reach directly
// without re-running the facility-allocation solve. Cleared whenever facilities/currency/modules
// change, since those invalidate the plan.
let lastPlan = null;

// Cache only the setups requested since the latest Calculate. A newer calculation invalidates
// in-flight results; unselected teams aren't solved speculatively.
let plansBySetup = {};
let planRunId = 0;

// A name for the setup on screen, spelling out what was said so each distinct one is worked out
// and kept apart; the levels themselves travel in `aniimo_levels`, the roster in `roster`.
function selectedAniimoSetup() {
    const tab = selectedSetupTab();
    if (tab === 'minimum') return 'minimum';
    if (tab === 'custom') return `roster:${JSON.stringify({ members: roster.map(({ count, abilities, personalities, family }) => ({ count, abilities, personalities, family })), movementDistance: movementDefaultDistance, movementDistances, haulingSeconds, haulingDefaultSeconds, dispatch: reactiveDispatch })}`;
    return bestAniimoSetup();
}

function bestAniimoSetup() {
    return `best:${levelledAbilities().map(a => `${a}${bestAniimoLevel(a)}`).join(',')}`;
}

// What the last plan was solved from, so switching setup can work out another one without the
// player filling the form in again.
let lastPlanInput = null;

// Solves for `setup` if it isn't already worked out, and shows it when it lands if that's still
// what's selected. It runs in a worker of its own, which a newer pick stops, so quick roster
// edits don't queue a solve each. A run id guards against a newer Find the best plan click.
let setupSolve = null;
let mainSolve = null;
const SETUP_TIMEOUT = 300_000;
function ensurePlanFor(setup, refining = false) {
    if (plansBySetup[setup] || !lastPlanInput || setupSolve?.setup === setup
        || (mainSolve?.runId === planRunId && mainSolve.setup === setup)) return;
    stopSetupSolve();
    const runId = planRunId;
    const solver = new Worker(WORKER_URL, { type: 'module' });
    const timer = setTimeout(() => done({ success: false, error: 'This setup took too long. Try simplifying the priorities.' }), SETUP_TIMEOUT);
    setupSolve = { setup, worker: solver, timer, refining };
    if (refining && progress?.runId === runId) {
        if (!progress.steps.some(s => s.key === 'refine')) progress.steps.push({key:'refine',label:'Refining deliveries and worker loads',state:'pending'});
        setStep('refine','start');
    } else startProgress({ ...lastPlanInput, ...aniimoInput(setup) }, runId);
    if (!refining) document.getElementById('aniimo-pending').textContent = translate('Updating Aniimo setup...');
    const done = (plan) => {
        clearTimeout(timer);
        solver.terminate();
        if (setupSolve?.worker === solver) setupSolve = null;
        if (runId !== planRunId) return;
        plansBySetup[setup] = plan;
        if (selectedAniimoSetup() === setup) {
            if (!plan.success) resetPlanButton();
            if (refining && !plan.success) {
                setStep('refine','fail');
                showError(`Delivery refinement failed: ${plan.error || 'No feasible plan found'}`);
                return;
            }
            finishSolveSteps();
            showSelectedPlan(refining);
        }
    };
    solver.onmessage = (event) => {
        const { type, ok, result, error, count } = event.data;
        if (type === 'progress') {
            if (!refining && setupSolve?.worker === solver && runId === planRunId && count && typeof count === 'object') {
                setStep(count.step, count.state, undefined, count.proven);
            }
            return;
        }
        let plan;
        try {
            plan = ok ? JSON.parse(result) : { success: false, error };
        } catch (error) {
            plan = { success: false, error: error.message };
        }
        done(plan);
    };
    solver.onerror = (event) => done({ success: false, error: event.message || 'The planner stopped' });
    solver.onmessageerror = () => done({ success: false, error: 'The planner returned an unreadable response.' });
    // The levels are read afresh: the player may have changed which abilities they have since
    // the plan this input came from.
    solver.postMessage({ id: 1, type: 'find_plan', payload: JSON.stringify({ ...lastPlanInput, ...aniimoInput(setup) }) });
}

function stopSetupSolve() {
    if (setupSolve) {
        progress = null;
        renderProgress();
    }
    clearTimeout(setupSolve?.timer);
    setupSolve?.worker.terminate();
    setupSolve = null;
}

// Shows the selected setup, and works it out first if this is the first time it's been asked for.
function switchAniimoSetup() {
    if (setupSolve && setupSolve.setup !== selectedAniimoSetup()) stopSetupSolve();
    if (mainSolve?.runId === planRunId && mainSolve.setup !== selectedAniimoSetup()) {
        mainSolve = null;
        restartWorker();
    }
    showSelectedPlan();
    ensurePlanFor(selectedAniimoSetup());
}

// Shows the plan for the selected Aniimo setup, or a "still working" note if it isn't ready.
function showSelectedPlan(keepLayout = false) {
    const setup = selectedAniimoSetup();
    document.querySelectorAll('[data-roster="from-best"], [data-roster="from-minimum"]').forEach(button => {
        button.disabled = !lastPlanInput;
    });
    const plan = plansBySetup[setup];
    const pending = document.getElementById('aniimo-pending');
    const content = document.getElementById('results-content');
    document.getElementById('roster-summary').hidden = true;
    refreshRosterTileWorkloads();
    content.classList.toggle('stale', !plan);
    if (!plan) {
        pending.style.display = lastPlanInput ? 'block' : 'none';
        stopRanking();
        stopLayout();
        ensurePlanFor(setup);
        return;
    }
    pending.style.display = 'none';
    lastPlan = plan;
    if (selectedSetupTab() === 'custom' && plan.roster_dispatch && Object.keys(plan.roster_dispatch).length) {
        reactiveDispatch = plan.roster_dispatch;
        plansBySetup[selectedAniimoSetup()] = plan;
    }
    displayPlan(plan, keepLayout);
    if (plan.success) {
        runTimeToGoal();
        // Opportunities wait until the layout and any travel refinements have finished.
    } else {
        stopRanking();
        ranking = null;
        renderImprovements();
    }
}

// The most recently computed goal result, held the same way as `lastPlan` so switching the rate
// unit can re-render the Product Breakdown table's Profit column without recomputing the goal.
let lastGoalResult = null;

// Display name for each optimizable currency. Coins are the only one since the full release
// removed Bud Tickets; kept as a map so a plan's `currency` still resolves to its label.
const CURRENCY_LABELS = {
    coins: 'Home Coins',
    aniimo_exp: 'Aniimo EXP',
    aniipods: 'Aniipods',
};

// Multiplier from the solver's native per-second rate to each display unit, and the short suffix
// shown next to the currency label (e.g. "Coins/hour"). "Your Rate" is stored and computed
// per-second throughout; this only affects how that one number is displayed.
const RATE_UNIT_SECONDS = {
    second: { multiplier: 1, suffix: '/sec' },
    minute: { multiplier: 60, suffix: '/min' },
    hour: { multiplier: 3600, suffix: '/hour' },
    day: { multiplier: 86400, suffix: '/day' },
};

// Per-facility owned tiers: `{ 'Farmland': [{count: 5, level: 3}, {count: 4, level: 5}], ... }`.
// The single source of truth for what's owned; rendering reads FROM this, input edits write
// BACK into it, and `getPlanInputValues()` sends it straight to the solver as-is. A player
// commonly upgrades some but not all of their plots of one facility type (e.g. 5 Farmland at
// level 3 and 4 more upgraded to level 5), so a facility can own more than one tier; facilities
// that don't level up at all (`hasLevels: false`) only ever have exactly one.
let facilityTiers = {};

function defaultFacilityTiers() {
    const tiers = {};
    FACILITIES.forEach(f => {
        tiers[f.name] = [{ count: f.defaultCount, level: 1 }];
    });
    return tiers;
}

// Renders one facility's tier rows (Count + Level inputs, a remove button once there's more than
// one tier, and, only for facilities that level up, an "Add level" button) into its
// `.facility-tiers` container. Called on initial render and again, for just that one facility,
// whenever a tier is added or removed, so editing one facility never disturbs another's inputs.
function renderTierRows(name) {
    const f = FACILITIES.find(fac => fac.name === name);
    const container = document.querySelector(`.facility-tiers[data-facility="${name}"]`);
    if (!f || !container) return;
    const tiers = facilityTiers[name];
    const showRemove = tiers.length > 1;
    container.innerHTML = tiers.map((tier, i) => `
        <div class="facility-inputs tier-row" data-tier-index="${i}">
            <div class="input-field">
                <label>Count</label>
                <input type="number" class="tier-count" value="${tier.count}" min="0" max="999">
            </div>
            ${f.hasLevels === false ? '' : `
            <div class="input-field">
                <label>Level</label>
                <input type="number" class="tier-level" value="${tier.level}" min="1" max="10">
            </div>
            `}
            ${showRemove ? '<button type="button" class="tier-remove-btn" title="Remove this level">&times;</button>' : ''}
        </div>
    `).join('');
}

// Build the facility-card inputs, grouped into a labeled section per category. Runs before other
// DOM setup. Tier-row inputs and buttons are handled via event delegation (see
// `attachFacilityTierHandlers`) rather than per-element listeners, since rows are added/removed
// dynamically after this initial render.
function renderFacilityCards() {
    const grid = document.getElementById('facilities-grid');
    grid.innerHTML = FACILITY_CATEGORIES.map(category => {
        const cards = FACILITIES.filter(f => f.category === category).map(f => `
            <div class="facility-card" data-facility-name="${f.name}">
                <h4>${f.name} <span class="info-icon" data-tooltip="${f.tooltip}">?</span></h4>
                <div class="facility-tiers" data-facility="${f.name}"></div>
                ${f.hasLevels === false ? '' : '<button type="button" class="add-tier-btn" data-facility="' + f.name + '">+ Add level</button>'}
            </div>
        `).join('');
        return `
            <details class="explain facility-category">
                <summary class="facility-category-title">${category} <span class="hint small">(${FACILITIES.filter(f => f.category === category).length})</span></summary>
                <div class="facilities-grid">${cards}</div>
            </details>
        `;
    }).join('');
    FACILITIES.forEach(f => renderTierRows(f.name));
}

// Delegated handlers for the facility grid, covering tier rows added/removed after initial
// render: editing a Count/Level input updates `facilityTiers` and persists it; "+ Add level"
// appends a new tier (guessing the next level up from the highest owned, capped at 10); "×"
// removes a tier. Attach once, on the grid container, rather than per-row.
function attachFacilityTierHandlers() {
    const grid = document.getElementById('facilities-grid');

    grid.addEventListener('input', (e) => {
        const row = e.target.closest('.tier-row');
        if (!row) return;
        const container = e.target.closest('.facility-tiers');
        const name = container.dataset.facility;
        const idx = parseInt(row.dataset.tierIndex, 10);
        const tier = facilityTiers[name][idx];
        if (e.target.classList.contains('tier-count')) {
            tier.count = numberOrDefault(e.target.value, 0);
        } else if (e.target.classList.contains('tier-level')) {
            tier.level = numberOrDefault(e.target.value, 1);
        }
        saveInputsToStorage();
    });

    grid.addEventListener('click', (e) => {
        const addBtn = e.target.closest('.add-tier-btn');
        if (addBtn) {
            const name = addBtn.dataset.facility;
            const tiers = facilityTiers[name];
            const nextLevel = Math.min(10, Math.max(...tiers.map(t => t.level)) + 1);
            tiers.push({ count: 1, level: nextLevel });
            renderTierRows(name);
            saveInputsToStorage();
            return;
        }
        const removeBtn = e.target.closest('.tier-remove-btn');
        if (removeBtn) {
            const row = removeBtn.closest('.tier-row');
            const container = removeBtn.closest('.facility-tiers');
            const name = container.dataset.facility;
            const idx = parseInt(row.dataset.tierIndex, 10);
            facilityTiers[name].splice(idx, 1);
            renderTierRows(name);
            saveInputsToStorage();
        }
    });

    // Enter key inside a tier input triggers a full plan recalculation, same as every other
    // input; delegated (rather than the per-input listener loop used for static inputs) since
    // tier inputs come and go as levels are added/removed.
    grid.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) {
            runFindPlan();
        }
    });
}

function searchTerms(value) {
    return value.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchesSearch(terms, text) {
    const label = text.toLocaleLowerCase();
    return terms.every(term => label.includes(term));
}

function attachFacilitySearch() {
    const input = document.getElementById('facility-search');
    const groups = [...document.querySelectorAll('#facilities-grid .facility-category')];
    let beforeSearch = null;
    input.addEventListener('input', () => {
        const terms = searchTerms(input.value);
        if (terms.length && !beforeSearch) beforeSearch = new Map(groups.map(group => [group, group.open]));
        let found = false;
        for (const group of groups) {
            let visible = false;
            for (const card of group.querySelectorAll('[data-facility-name]')) {
                const name = card.dataset.facilityName;
                card.hidden = !matchesSearch(terms, `${name} ${translate(name)}`);
                visible ||= !card.hidden;
            }
            group.hidden = !visible;
            if (terms.length && visible) group.open = true;
            else if (!terms.length && beforeSearch) group.open = beforeSearch.get(group);
            found ||= visible;
        }
        if (!terms.length) beforeSearch = null;
        document.getElementById('facility-search-empty').hidden = found;
    });
}

// --- Local persistence -----------------------------------------------------------------
// Saves/restores form inputs via localStorage so values survive a page reload. Purely
// client-side (no account, no server); works identically on localhost and once this is
// hosted on GitHub Pages, since localStorage is scoped to the page's own origin.
const STORAGE_KEY = 'aniimax-config-v1';

// True once the player has picked a rate unit themselves this visit. Until then a fresh plan
// picks the unit it reads best at; after it, their choice stands.
let rateUnitChosen = false;

// Every plain input ID whose value should be persisted (facility tiers are saved separately;
// see `facilityTiers`/`initFacilityTiers`, since they're a dynamic list rather than one fixed
// element per facility).
function getPersistedFieldIds() {
    return [
        'target-amount', 'current-amount', 'recipe-switching-buildings', 'recipe-switching-switches',
        'crop-variety', 'level-up-target',
        'electricity-on',
        'home-level',
        'ecological-module-level', 'kitchen-module-level',
        'resource-detector-level', 'crafting-module-level',
        'rate-unit', 'season-on', 'season-event', 'layout-sim-on', 'layout-recipes', 'layout-workers', 'layout-storage-count',
        'layout-style', 'layout-icons',
        'aniimo-best', 'aniimo-minimum', 'aniimo-custom'
    ];
}

// Reads and parses the saved config blob, or `null` if there isn't one / it's corrupt.
function readStorage() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? migrateSavedConfig(JSON.parse(raw)) : null;
    } catch (e) {
        console.warn('Could not load saved inputs from localStorage:', e);
        return null;
    }
}

// Carries a save made under an older name forward to its current one, so a returning user keeps
// their inputs across a rename instead of silently falling back to defaults. The full release
// renamed Mineral Pile to Mine and the Mineral Detector module to Resource Detector.
function migrateSavedConfig(data) {
    if (!data || typeof data !== 'object') return data;
    if (data['crop-variety'] === undefined && data['strategy-crop-variety']) {
        data['crop-variety'] = true;
        data['strategy-level-up'] = false;
    }
    if (data.customBuildings === undefined) {
        // Saves from before Simple held hand-entered building counts.
        data.customBuildings = Boolean(data['mode-advanced'] || data['mode-simple'] === false
            || (data['mode-simple'] === undefined && data.facilityTiers));
        if (data.customBuildings) data['home-level'] = data['layout-rv-level'] ?? '';
    }
    const tiers = data.facilityTiers;
    if (tiers && tiers['Mine'] === undefined && tiers['Mineral Pile'] !== undefined) {
        tiers['Mine'] = tiers['Mineral Pile'];
    }
    if (data['resource-detector-level'] === undefined && data['mineral-detector-level'] !== undefined) {
        data['resource-detector-level'] = data['mineral-detector-level'];
    }
    // One budget field served every season before each got its own; it belongs to the season picked
    // then, or to the Harvest Moon Festival from before there was a picker.
    if (data.seasonBudgets === undefined && data['season-currency-per-day'] !== undefined) {
        data.seasonBudgets = { [data['season-event'] || 'harvest_moon_festival']: data['season-currency-per-day'] };
    }
    delete data['material-work-on'];
    delete data.materialWorkFor;
    return data;
}

// Populates the module-level `facilityTiers` from a saved config blob (see `readStorage`),
// falling back to defaults for any facility missing from it; covers both a fresh page load
// (no save yet) and a facility newly added to `FACILITIES` since the user's last save.
function initFacilityTiers(data) {
    const defaults = defaultFacilityTiers();
    const saved = (data && data.facilityTiers) || {};
    facilityTiers = {};
    FACILITIES.forEach(f => {
        const tiers = saved[f.name];
        facilityTiers[f.name] = Array.isArray(tiers) && tiers.length > 0
            ? tiers.map(t => ({
                count: numberOrDefault(t.count, 0),
                level: f.hasLevels === false ? 1 : numberOrDefault(t.level, 1)
            }))
            : defaults[f.name];
    });

}

function currentConfig() {
    const data = { facilityTiers, customBuildings, questIncomePerDay:questIncome(questIncomePerDay), skippedRecipes: [...skippedRecipes], unlockedSpecial: [...unlockedSpecial], priorities: priorityOrder, aniimoLevels, roster, rosterSlots, seasonBudgets, seasonCropMinimums };
    getPersistedFieldIds().forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        data[id] = (el.type === 'checkbox' || el.type === 'radio') ? el.checked : el.value;
    });
    if (!customBuildings || !data['level-up-target']) delete data['level-up-target'];
    return data;
}

function clearShareHash() {
    const url = urlWithoutShare(window.location.href);
    if (url === window.location.href) return false;
    window.history.replaceState(null, '', url);
    return true;
}

function saveInputsToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(currentConfig()));
        const imported = clearShareHash();
        document.getElementById('share-config-status').textContent = imported
            ? 'Your changes are saved in this browser.' : '';
        document.getElementById('share-config-result').hidden = true;
        const rosterSave = document.querySelector('[data-roster="save-import"]');
        if (rosterSave) rosterSave.hidden = true;
        return true;
    } catch (e) {
        console.warn('Could not save inputs to localStorage:', e);
        return false;
    }
}

async function shareCurrentConfig() {
    const link = document.getElementById('share-config-link');
    const result = document.getElementById('share-config-result');
    const status = document.getElementById('share-config-status');
    try {
        link.value = await createShareUrl(window.location.href, currentConfig());
        result.hidden = false;
        link.focus();
        link.select();
        try {
            await navigator.clipboard.writeText(link.value);
            status.textContent = 'Link copied. It includes your current setup.';
        } catch (_) {
            status.textContent = 'Copy the link above to share your setup.';
        }
    } catch (error) {
        status.textContent = 'Could not create a share link for this setup.';
        console.warn('Could not create share link:', error);
    }
}

function loadInputsFromStorage(data) {
    document.getElementById('recipe-switching-buildings').value='0';
    document.getElementById('recipe-switching-switches').value='2';
    if (!data) return;
    customBuildings = Boolean(data.customBuildings);
    questIncomePerDay = questIncome(data.questIncomePerDay);
    if (Array.isArray(data.skippedRecipes)) skippedRecipes = new Set(data.skippedRecipes.filter(n => typeof n === 'string'));
    if (Array.isArray(data.unlockedSpecial)) unlockedSpecial = new Set(data.unlockedSpecial.filter(n => typeof n === 'string'));
    if (data.seasonBudgets && typeof data.seasonBudgets === 'object') {
        seasonBudgets = Object.fromEntries(Object.entries(data.seasonBudgets)
            .filter(([id, value]) => SEASONS.some(s => s.id === id) && (typeof value === 'string' || typeof value === 'number'))
            .map(([id, value]) => [id, String(value)]));
    }
    if (data.seasonCropMinimums && typeof data.seasonCropMinimums === 'object') {
        seasonCropMinimums = Object.fromEntries(Object.entries(data.seasonCropMinimums)
            .filter(([, count]) => Number.isInteger(count) && count > 0 && count <= MAX_SEASON_PLOTS));
    }
    if (data['strategy-level-up']) {
        priorityOrder = defaultPriorities();
    } else if (Array.isArray(data.priorities)) {
        const saved = new Map();
        for (const { target, on } of data.priorities.filter(p => PRIORITY_TARGETS.some(t => t.id === p?.target))) {
            if (!saved.has(target)) saved.set(target, Boolean(on));
        }
        for (const { id } of PRIORITY_TARGETS) {
            if (!saved.has(id)) saved.set(id, false);
        }
        priorityOrder = [...saved].map(([target, on]) => ({ target, on }));
    } else if (data['strategy-coins'] || data['strategy-exp'] || data['strategy-aniipods']) {
        // Saves from before Priorities picked one "Most ..." tab; carry that choice over.
        const first = data['strategy-exp'] ? 'aniimo_exp' : data['strategy-aniipods'] ? 'aniipods' : 'coins';
        priorityOrder = [first, ...PRIORITY_TARGETS.map(t => t.id).filter(id => id !== first)]
            .map(target => ({ target, on: target === first }));
    }
    if (data.aniimoLevels && typeof data.aniimoLevels === 'object') {
        aniimoLevels = Object.fromEntries(Object.entries(data.aniimoLevels)
            .filter(([ability, level]) => ABILITY_BY_NAME.has(ability) && Number.isInteger(Number(level)) && level >= 1 && level <= 4)
            .map(([ability, level]) => [ability, Number(level)]));
    }
    if (Array.isArray(data.roster)) {
        roster = data.roster
            .filter(a => a && typeof a === 'object' && a.abilities && typeof a.abilities === 'object')
            .map(a => ({
                name: typeof a.name === 'string' ? a.name : '',
                catalogId: rosterCatalogId(a.catalogId, typeof a.name === 'string' ? a.name : ''),
                count: Number.isSafeInteger(Number(a.count)) ? Math.max(1, Number(a.count)) : 1,
                family: LEISURE_FAMILIES.some(f => f.id === a.family) ? a.family
                    : rosterCatalogFamily(a.catalogId, a.name || ''),
                abilities: Object.fromEntries(Object.entries(a.abilities)
                    .filter(([ability, level]) => ABILITY_BY_NAME.has(ability) && Number.isInteger(Number(level)) && level >= 1 && level <= 4)
                    .map(([ability, level]) => [ability, Number(level)])),
                personalities: PERSONALITY_PAIRS.map(pair => {
                    if (!Array.isArray(a.personalities)) return pair.names[0];
                    return pair.names.find(name => a.personalities.includes(name)) ?? null;
                }),
            }));
    }
    rosterSlots = rosterSlotsFor(roster, Array.isArray(data.rosterSlots) ? data.rosterSlots : []);
    getPersistedFieldIds().forEach(id => {
        if (!(id in data)) return;
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox' || el.type === 'radio') {
            el.checked = !!data[id];
        } else if (id === 'level-up-target' && !customBuildings) {
            return;
        } else if (id === 'layout-style') {
            el.value = normalizeMapStyle(data[id]);
        } else if (el.tagName !== 'SELECT' || [...el.options].some(option => option.value === String(data[id]))) {
            el.value = data[id];
        }
    });
}

// Auto-save on every change to a persisted static field (facility tier inputs save themselves;
// see `attachFacilityTierHandlers`).
function attachAutoSave() {
    getPersistedFieldIds().forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const eventName = (el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(eventName, saveInputsToStorage);
    });
}

function clearSavedInputs() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('Could not clear saved inputs from localStorage:', e);
    }
    clearShareHash();
    window.location.reload();
}

// Initialize the worker and its wasm module.
async function initWasm() {
    try {
        initWorker();
        const version = await callWorker('get_version');
        wasmReady = true;
        document.querySelector('#optimize-btn .btn-text').textContent = 'Find the best plan';
        resetPlanButton();

        document.getElementById('version').textContent = version;
        loadRecipeIndex();

        console.log(`Aniimax v${version} loaded successfully`);
    } catch (error) {
        console.error('Failed to initialize WASM:', error);
        showError('Failed to load the optimizer. Please refresh the page.');
    }
}

// Use the RV's full set of buildings and upgrades until the player edits their inventory.
let customBuildings = false;

function isSimpleMode() {
    return !customBuildings;
}

function selectedHomeLevel() {
    return numberOrDefault(document.getElementById('home-level').value, MAX_HOME_LEVEL);
}

function populateHomeLevels() {
    const options = ['<option value="">Auto</option>'];
    for (let level = 1; level <= MAX_HOME_LEVEL; level++) {
        options.push(`<option value="${level}">${level}${level === MAX_HOME_LEVEL ? ' (everything unlocked)' : ''}</option>`);
    }
    const select = document.getElementById('home-level');
    select.innerHTML = options.join('');
    select.value = String(MAX_HOME_LEVEL);
}

function renderBuildingSettings() {
    document.getElementById('home-level').options[0].hidden = !customBuildings;
    document.getElementById('reset-buildings').hidden = !customBuildings;
    document.getElementById('building-setup-note').textContent = customBuildings
        ? 'Uses your building counts and upgrade levels.'
        : 'Uses all buildings and upgrades available at your RV level.';
}

function fillBuildingInputs(homeLevel) {
    const { facilities, modules } = simpleSetup(homeLevel);
    FACILITIES.forEach(f => {
        facilityTiers[f.name] = facilities[f.name].map(t => ({ ...t }));
        renderTierRows(f.name);
    });
    document.getElementById('ecological-module-level').value = modules.ecological_module;
    document.getElementById('kitchen-module-level').value = modules.kitchen_module;
    document.getElementById('resource-detector-level').value = modules.resource_detector;
    document.getElementById('crafting-module-level').value = modules.crafting_module;
}

function attachModeHandlers() {
    const rv = document.getElementById('home-level');
    rv.addEventListener('change', () => {
        if (isSimpleMode()) fillBuildingInputs(selectedHomeLevel());
        if (lastPlanInput) clearPlanResults();
        renderStrategy();
    });
    const markCustom = () => {
        if (customBuildings) return;
        customBuildings = true;
        renderBuildingSettings();
        renderStrategy();
    };
    document.getElementById('advanced-config').addEventListener('input', event => {
        if (event.target.matches('input[type="number"]')) markCustom();
    }, true);
    document.getElementById('facilities-grid').addEventListener('click', event => {
        if (event.target.closest('.add-tier-btn, .tier-remove-btn')) markCustom();
    }, true);
    document.getElementById('reset-buildings').addEventListener('click', () => {
        if (!rv.value) rv.value = String(layoutHomeLevel(null));
        customBuildings = false;
        document.getElementById('level-up-target').value = '';
        fillBuildingInputs(selectedHomeLevel());
        renderBuildingSettings();
        if (lastPlanInput) clearPlanResults();
        renderStrategy();
        saveInputsToStorage();
        document.getElementById('custom-buildings').querySelector('summary').focus();
    });
}

// --- Special recipes -------------------------------------------------------------------
// Recipes unlocked with a rare currency (see `SPECIAL_RECIPES`): left out of plans unless ticked.

let unlockedSpecial = new Set();
const SPECIAL_NAMES = new Set(SPECIAL_RECIPES.map(r => r.name));

function renderSpecialRecipes() {
    document.getElementById('special-grid').innerHTML = SPECIAL_RECIPES.map(r => `
        <label class="special-option">
            <input type="checkbox" data-special="${r.name}"${unlockedSpecial.has(r.name) ? ' checked' : ''}>
            <span>${prettyItem(r.name)}</span>
        </label>`).join('');
}

function attachSpecialHandlers() {
    document.getElementById('special-grid').addEventListener('change', (e) => {
        const name = e.target.dataset.special;
        if (!name) return;
        if (e.target.checked) unlockedSpecial.add(name); else unlockedSpecial.delete(name);
        renderRecipeCount();
        saveInputsToStorage();
    });
}

// --- Opportunities ---------------------------------------------------------------------
// After each plan, what the player could change to do better, best first: a locked recipe, an
// personality or Aniimo upgrade, and Advanced-mode facility/module changes. Suggestions are
// prepared after layout; full comparisons run only on request in a cancellable worker pool.

let rankWorkers = [];
let rankRunId = 0;
// Finished rankings by Aniimo setup, for the plan they were worked out from.
let rankingsBySetup = {};
// The comparison queue and partial results for the plan on screen.
let ranking = null;
let rankCleanups = [];

const MODULE_NAMES = {
    ecological_module: 'Ecological Module',
    kitchen_module: 'Kitchen Module',
    resource_detector: 'Resource Detector',
    crafting_module: 'Crafting Module',
};

function stopRanking() {
    rankRunId++;
    rankWorkers.forEach(worker => worker.terminate());
    rankWorkers = [];
    rankCleanups.forEach(cleanup => cleanup());
    rankCleanups = [];
    if (ranking?.running) {
        ranking.running = false;
        ranking.paused = true;
        ranking.activeIndex = null;
        ranking.activeIndices = [];
    }
}

// How many of a facility `tiers` hold, and the highest level among them.
const tierCount = tiers => (tiers || []).reduce((sum, t) => sum + t.count, 0);
const tierLevel = tiers => Math.max(0, ...(tiers || []).filter(t => t.count > 0).map(t => t.level));

// The lowest RV level whose facilities and modules cover everything in `input`, for Advanced
// mode, where the player enters what they have rather than their RV level.
function homeLevelCovering(input) {
    for (let level = 1; level <= MAX_HOME_LEVEL; level++) {
        const allowed = simpleSetup(level);
        const facilitiesFit = FACILITIES.every(f => {
            const have = input.facilities[f.name];
            if (tierCount(have) === 0) return true;
            const cap = allowed.facilities[f.name];
            return tierCount(have) <= tierCount(cap) && (f.hasLevels === false || tierLevel(have) <= tierLevel(cap));
        });
        const modulesFit = Object.entries(input.modules).every(([name, level_]) => level_ <= (allowed.modules[name] ?? 0));
        if (facilitiesFit && modulesFit) return level;
    }
    return MAX_HOME_LEVEL;
}

const opportunityTabs = [
    { kind: 'Aniimo', action: 'Check Aniimo upgrades' },
    { kind: 'Personalities', action: 'Check personality changes' },
    { kind: 'Recipes', action: 'Check recipes' },
    { kind: 'Buildings', action: 'Check buildings and modules' },
];

function improvementCandidates(base, setup, plan) {
    const candidates = [];
    const owns = name => tierCount(base.facilities[name]) > 0;
    const skipped = new Set(planContext?.skipped ?? skippedRecipes);
    const locked = [...SPECIAL_RECIPES,
        ...(base.season ? seasonById(base.season).recipeNotes : [])];
    for (const recipe of locked) {
        if (!base.exclude.includes(recipe.name) || skipped.has(recipe.name)) continue;
        if (recipe.facility && !owns(recipe.facility)) continue;
        candidates.push({ kind: 'Recipes', change: { kind: 'recipe', name: recipe.name },
            label: `Unlock ${prettyItem(recipe.name)}`, facilities: recipe.facility ? [recipe.facility] : [],
            input: { ...base, exclude: base.exclude.filter(name => name !== recipe.name) } });
    }

    if (setup.startsWith('roster') && base.roster) {
        const memberName = i => roster[i]?.name?.trim() || rosterLabel(base.roster.members[i], i);
        for (const candidate of replacementCandidates(base, plan, recipeIndex, aniimoCatalog.entries, PERSONALITY_PAIRS)) {
            const reserve = plan.assumed_aniimo?.find(([index]) => index === candidate.index);
            const who = reserve ? `${translate('Assumed Aniimo')} (${translate(reserve[1])} Lv.${reserve[2]})` : memberName(candidate.index);
            const name = rosterFormName(candidate.entry);
            candidates.push({ kind: 'Aniimo', label: `${who} → ${name}`, member: candidate.index,
                changedMember: candidate.changedMember,
                portrait: aniimoPortrait(candidate.entry.id), traits: candidate.traits, facilities: candidate.facilities, input: candidate.input });
        }
        const traits = new Map();
        for (const step of plan.coin_items || []) {
            const trait = base.roster.personalities[step.facility];
            const member = base.roster.members[step.crew];
            if (!member || !trait || step.status !== 'producing' || step.electric_level != null
                || member.personalities.includes(trait)) continue;
            const key = `${step.crew}:${trait}`;
            const suggestion = traits.get(key) || { member: step.crew, trait, facilities: new Set(), load: 0 };
            suggestion.facilities.add(step.facility);
            suggestion.load += step.busy_units ?? step.facility_count;
            traits.set(key, suggestion);
        }
        for (const { member, trait, facilities } of [...traits.values()].sort((a,b)=>b.load-a.load).slice(0,10)) {
            const changedMember = base.roster.members[member].count > 1 ? base.roster.members.length : member;
            candidates.push({ kind: 'Personalities', label: `${memberName(member)} → ${translate(trait)}`,
                member, changedMember, traits: [trait], facilities: [...facilities],
                portrait: aniimoPortrait(rosterCatalogId(roster[member]?.catalogId, roster[member]?.name)),
                change: { kind: 'personality', member: changedMember, trait },
                input: personalityInput(base, member, trait, PERSONALITY_PAIRS) });
        }
    } else if (setup.startsWith('best')) {
        for (const ability of levelledAbilities().filter(ability => FACILITIES.some(f => f.ability === ability && owns(f.name)))) {
            const next = defaultLevelFor(ability);
            if ((base.aniimo_levels[ability] ?? next) >= next) continue;
            const entry = aniimoCatalog.entries.find(entry => entry.abilities[ability] >= next);
            if (!entry) continue;
            candidates.push({ kind: 'Aniimo', label: `${rosterFormName(entry)} · ${translate(ability)} Lv.${next}`,
                portrait: aniimoPortrait(entry.id), input: { ...base, aniimo_levels: { ...base.aniimo_levels, [ability]: next } } });
        }
    }

    // Advanced mode: a module at a higher level, one more facility, or one facility at a higher
    // level, within what the RV level covering the rest allows.
    const levelsAbove = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + 1 + i);
    if (planContext && !planContext.simple) {
        const allowed = simpleSetup(homeLevelCovering(base));
        for (const [module, level] of Object.entries(base.modules)) {
            for (const next of levelsAbove(level, allowed.modules[module] ?? 0)) {
                candidates.push({
                    kind: 'Buildings',
                    label: `${MODULE_NAMES[module] || module} Lv.${next}`,
                    input: { ...base, modules: { ...base.modules, [module]: next } },
                });
            }
        }
        for (const f of FACILITIES) {
            const tiers = (base.facilities[f.name] || []).filter(t => t.count > 0);
            const cap = allowed.facilities[f.name];
            const capLevel = f.hasLevels === false ? 1 : tierLevel(cap);
            if (tierCount(tiers) < tierCount(cap)) {
                for (const level of levelsAbove(0, capLevel)) {
                    candidates.push({
                        kind: 'Buildings',
                        label: f.hasLevels === false || capLevel === 1 ? `+1 ${f.name}` : `+1 ${f.name} (Lv.${level})`,
                        input: { ...base, facilities: { ...base.facilities, [f.name]: [...tiers, { count: 1, level }] } },
                    });
                }
            }
            if (f.hasLevels === false || tiers.length === 0) continue;
            const lowest = tiers.reduce((a, b) => (b.level < a.level ? b : a));
            for (const level of levelsAbove(lowest.level, capLevel)) {
                const raised = tiers
                    .map(t => (t === lowest ? { ...t, count: t.count - 1 } : t))
                    .filter(t => t.count > 0)
                    .concat({ count: 1, level });
                candidates.push({
                    kind: 'Buildings',
                    label: tierCount(tiers) > 1 ? `1 ${f.name} to Lv.${level}` : `${f.name} to Lv.${level}`,
                    input: { ...base, facilities: { ...base.facilities, [f.name]: raised } },
                });
            }
        }
    }
    return prepareOpportunities(base, candidates.filter(c => usefulUpgrade(c.input, c.change, recipeIndex)), recipeIndex, plan);
}

// Prepare suggestions after planning. Full comparisons run only when the player requests
// a row or the batch, in a small cancellable pool; the current plan stays intact.
function rankImprovementsFor(setup, requested = null, detailed = false) {
    if (requested != null && (mainSolve || setupSolve || layoutWorker)) return;
    stopRanking();
    const plan = plansBySetup[setup] || lastPlan;
    if (!lastPlanInput || !plan?.success) { ranking = null; renderImprovements(); return; }
    let current = rankingsBySetup[setup];
    if (!current || current.plan !== plan) {
        const base = structuredClone({ ...lastPlanInput, ...aniimoInput(setup) });
        if (base.roster && plan.hauling_estimates) {
            base.roster = { ...base.roster, hauling_seconds: plan.hauling_estimates,
                hauling_default_seconds: haulingRouteBound(setup.startsWith('roster:')) };
        }
        if (base.roster && plan.layout_walking?.length && lastLayout) {
            const distances = workerTravelDistances(lastLayout.layout.pieces.flatMap(piece => piece.members));
            base.roster.movement_by_member = measuredMovementEstimates(base.roster.movement_by_member,
                distances, plan.layout_walking.map(([member]) => member));
        }
        const prepared = improvementCandidates(base, setup, plan);
        const layout = lastLayout?.plan === plan ? lastLayout.layout : null;
        current = { setup, plan, input: base, candidates: prepared.candidates, layout, measured: opportunityIndividualLoads(opportunityWorkload(plan, base, layout), base),
            results: [], reports: [], tab: 'Aniimo', running: false, paused: false, activeIndex: null, activeIndices: [], phase: '' };
        rankingsBySetup[setup] = current;
    }
    ranking = current;
    if (requested == null) { renderImprovements(); return; }
    const indices = typeof requested === 'string'
        ? current.candidates.map((c,i)=>i).filter(i=>current.candidates[i].kind === requested && !current.results[i])
        : requested.filter(i=>current.candidates[i]);
    if (!indices.length) { renderImprovements(); return; }
    current.running = true; current.paused = false;
    const runId = rankRunId;
    const queue = startComparisonQueue({indices,parallel:comparisonConcurrency(navigator,indices.length),
        createWorker:()=>new Worker(WORKER_URL,{type:'module'}), timeout:SETUP_TIMEOUT,
        setTimer:setTimeout,clearTimer:clearTimeout,
        payload:index=>({base:current.input,basePlan:plan,candidates:[current.candidates[index].input],detailed}),
        onProgress:active=>{
            if (runId !== rankRunId) return;
            const indices = active.map(s => s.index);
            const changed = indices.length !== current.activeIndices.length
                || indices.some((index, i) => index !== current.activeIndices[i]);
            current.activeIndices = indices;
            current.activeIndex = active[0]?.index ?? null;
            current.phase = active[0]?.step ? comparisonPhase(active[0].step) : '';
            if (ranking === current) renderImprovements(changed);
        },
        onResult:(index,result)=>{
            if (runId !== rankRunId) return;
            const candidate = current.candidates[index];
            const chosen = keepBetterComparison(current.results[index], result, candidate.input);
            if (chosen === result && result.plan?.success) {
                const projected = opportunityWorkload(result.plan, candidate.input, current.layout);
                const report = compareRecommendations(current.measured, opportunityIndividualLoads(projected, candidate.input), current.input, candidate.input);
                if (candidate.changedMember != null && report.finish && !report.finish.assignments.get(candidate.changedMember)) {
                    report.direction = 0;
                }
                current.reports[index] = report;
            }
            current.results[index] = chosen;
            if (ranking === current) renderImprovements();
        },
        onDone:failed=>{
            if (runId !== rankRunId) return;
            current.running=false; current.paused=failed; current.activeIndex=null; current.activeIndices=[];
            rankWorkers=[]; rankCleanups=[];
            if (ranking === current) renderImprovements();
        },
    });
    rankWorkers = queue.workers;
    rankCleanups = [()=>queue.stop()];
    renderImprovements();
}

function comparisonPhase(step) {
    if (step.startsWith('priority:')) return priorityLabel(step.slice(9),planContext?.aniipod);
    return translate({crop_variety:'Crop and Tree Variety',level_up:'Fastest Level-Up',season:'Season Points',
        final:'Home Coins',materials:'RV materials',stock_up:'RV materials',check:'Checking the plan'}[step] || 'Checking the plan');
}

function opportunityWorkload(plan, input, layout) {
    if (!input.roster || !layout) return plan;
    layout = projectLayoutWork(layout, plan);
    if (!layout) return { ...plan, comparison_workload_valid: false };
    const members = [...input.roster.members];
    const reserves = [...(plan.assumed_aniimo || [])];
    for (const [index, ability, level, count, family] of reserves) {
        members[index] = { count, abilities: { [ability]: level }, assumed: true, family };
    }
    if (Object.keys(input.roster.dispatch || {}).length) {
        const policy = buildReactiveDispatch({layout, recipes:recipeIndex, members,
            busy:plan.roster_workload || [], permanent:permanentWorkers(plan,members,RESIDENT_FACILITIES),
            routes:plan.roster_routes || [], previous:input.roster.dispatch});
        const measured = measuredDispatchWork(plan,policy,recipeIndex);
        return {...plan, reactive_dispatch:policy, layout_walking:measured.walking,
            delivery_assignments:measured.delivery, dedicated_delivery:[], job_switching:[]};
    }
    // Rebuild layout-dependent work equally for rendered and fresh solver plans.
    const production = { ...plan,
        layout_walking: layoutWalkingAdjustments(layout.pieces.flatMap(piece => piece.members), plan),
        hauling_staffing: [], delivery_assignments: [], dedicated_delivery: [],
        job_switching: [], comparison_workloads: undefined };
    const usage = workerUsage(production, input);
    const busy = members.map((_, index) => usage.busy.get(index) || 0);
    const anchored = members.map((_, index) => usage.assignments.get(index) || 0);
    const work = haulingWorkload(layout, plan.coin_items || [], input.roster.hauling_default_seconds, recipeIndex, input.facilities, true);
    const jobs = rosterJobSwitching(buildDispatch(layout, recipeIndex, work, RESIDENT_FACILITIES), plan.roster_routes, members, busy, anchored);
    const switching = [];
    for (const [member, share] of jobs) { switching[member] = share; busy[member] += share; }
    const growers = new Set((plan.crop_assignments || []).filter(([, , , share]) => share > 1e-9).map(([, , member]) => member));
    const allocation = allocateHauling(members, busy, work, Infinity, anchored, switching, growers);
    if (allocation.unassigned > 1e-6) return plan;
    if (allocation.reserveCount) {
        reserves.push([members.length, 'Hauling', 3, allocation.reserveCount, null]);
        allocation.assignments.push([members.length, allocation.reserveBusy]);
    }
    return { ...production, assumed_aniimo: reserves, delivery_assignments: allocation.assignments,
        dedicated_delivery: allocation.dedicated, job_switching: jobs };
}

function opportunityIndividualLoads(plan, input) {
    if (!input.roster || plan.comparison_workload_valid === false) return plan;
    const { assignments } = workerUsage(plan, input);
    const members = [...input.roster.members];
    for (const [index, ability, level, count, family] of plan.assumed_aniimo || []) {
        members[index] = { count, abilities: { [ability]: level }, family };
    }
    const dedicated = new Map(plan.dedicated_delivery || []);
    const regular = members.map((_, index) => (assignments.get(index) || 0) - Math.ceil((dedicated.get(index) || 0) - 1e-6));
    const walking = members.map(() => 0);
    for (const [member, share] of [...(plan.movement_staffing || []), ...(plan.layout_walking || [])]) {
        if (members[member]) walking[member] += share;
    }
    const shifts = rosterCopyShifts(plan, members, regular, walking);
    return { ...plan, comparison_workloads: shifts.map(pool => pool.map(shift => shift.busy)) };
}

function comparisonMetricLabel(row) {
    if (row.id.startsWith('item:')) return prettyItem(row.id.slice(5));
    const labels = {crop_variety:'Planting variety score',rv_time:'RV level-up time',
        material_pace:'RV material production',material_work:'Material production',stock:'Extra RV supplies',
        working_aniimo:'Working Aniimo',additional_aniimo:'Additional Aniimo',work_hours:'Combined Aniimo work',peak_workload:'Peak Aniimo workload'};
    return labels[row.id] ? translate(labels[row.id]) : priorityLabel(row.id,planContext?.aniipod);
}

function comparisonValue(row,value) {
    if (value == null) return row.kind === 'duration' ? translate('Not reached with this plan') : '—';
    if (row.kind === 'duration') return formatDuration(value);
    if (row.kind === 'count') return formatNumber(value);
    if (row.kind === 'percent') return formatPercent(value);
    if (row.kind === 'work') return `${formatRate(value)} ${translate('hours/day')}`;
    const unit = RATE_UNIT_SECONDS[document.getElementById('rate-unit').value] || RATE_UNIT_SECONDS.second;
    return `${formatRate(value*unit.multiplier)}${unit.suffix}`;
}

function improvementGain(comparison) {
    if (!comparison || comparison.direction <= 0) return null;
    const row = comparison.decisive;
    const about = comparison.approximate ? '~' : '';
    const label = comparisonMetricLabel(row);
    let text;
    if (row.kind === 'duration') text = row.before == null
        ? `${label}: ${about}${formatDuration(row.after)}`
        : `${label}: ${about}−${formatDuration(row.before-row.after)}`;
    else if (row.kind === 'score') text = `${label}: ${about}+${formatPercent((row.after-row.before)/(row.before||row.after||1))}`;
    else if (row.kind === 'percent') text = `${label}: ${about}−${formatRate((row.before - row.after) * 100)} pp`;
    else text = `${label}: ${about}${row.lower ? '−' : '+'}${comparisonValue(row,Math.abs(row.after-row.before))}`;
    return {score:comparison.score,text,comparison};
}

function formatPercent(share) {
    const percent = share * 100;
    return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

function comparisonTable(comparison) {
    if (comparison.inconclusiveLoss) return `<p class="hint small">${translate('The search did not match the current plan. This does not show that the upgrade reduces production. Use Detailed search.')}</p>`;
    return `<p class="hint small">${translate(comparison.approximate
        ? 'Estimated comparison: at least one search did not prove its optimum.'
        : 'Both plans were checked by the optimizer.')}</p>
        ${comparison.workloadUnavailable ? '<p class="hint small">Worker savings need a new layout for this alternative.</p>' : ''}
        <div class="table-wrapper"><table class="comparison-table"><thead><tr>
        <th>${translate('Metric')}</th><th>${translate('Current plan')}</th><th>${translate('With change')}</th><th>${translate('Change')}</th>
        </tr></thead><tbody>${comparison.rows.map(row=>{
            // Solver floors allow small numerical drift. Do not present that as a gain/loss
            // (or let rounding make virtually equal rates appear one item apart).
            const changed = row.direction !== 0;
            const delta = row.before != null && row.after != null ? row.after-row.before : null;
            const difference = !changed ? '—' : delta == null ? comparisonValue(row,row.after)
                : `${delta<0?'−':'+'}${comparisonValue(row,Math.abs(delta))}`;
            const colour = row.direction > 0 ? 'improve-gain' : row.direction < 0 ? 'compare-loss' : 'hint';
            return `<tr><td>${comparisonMetricLabel(row)}</td><td>${comparisonValue(row,row.before)}</td>
                <td>${comparisonValue(row,changed ? row.after : row.before)}</td><td class="${colour}">${difference}</td></tr>`;
        }).join('')}</tbody></table></div>`;
}

function opportunityDescription(candidate) {
    const lines = (candidate.effect?.lines || []).map(effect=>{
        if (effect.kind==='unlocks') return translate('Opens recipe chains: {recipes}.')
            .replace('{recipes}',effect.recipes.slice(0,5).map(name=>translate(prettyItem(name))).join(', ')+(effect.recipes.length>5?'…':''));
        if (effect.kind==='capacity') return translate('Adds capacity at {facility}; {assigned} of {owned} buildings are currently assigned.')
            .replace('{facility}',translate(effect.facility)).replace('{assigned}',effect.assigned).replace('{owned}',effect.owned);
        if (effect.kind==='electric') return translate('Changes recipe capacity and E-mode power use at {facility}.').replace('{facility}',translate(effect.facility));
        if (effect.kind==='level') return translate('Increases recipe capacity at {facility}.').replace('{facility}',translate(effect.facility));
        if (effect.kind==='ability') return translate('Speeds up {ability} jobs at {facilities}.')
            .replace('{ability}',translate(effect.ability)).replace('{facilities}',effect.facilities.slice(0,4).map(translate).join(', '));
        if (effect.kind==='personality') return translate('Applies the matching personality bonus at {facilities}.')
            .replace('{facilities}',effect.facilities.slice(0,4).map(translate).join(', '));
        if (effect.kind==='allocated') return translate('All current production of {ingredients} is allocated. {facility} uses these inputs.')
            .replace('{facility}',translate(effect.facility))
            .replace('{ingredients}',effect.ingredients.slice(0,4).map(name=>translate(prettyItem(name))).join(', '));
        return '';
    }).filter(Boolean);
    return lines.slice(0,3).map(line=>`<p class="hint small">${escapeText(line)}</p>`).join('')
        + (candidate.description ? `<p class="hint small">${candidate.description}</p>` : '');
}

function renderImprovements(rebuild = true) {
    const card = document.getElementById('improve-card');
    if (!ranking || !lastPlan?.success) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const { tab, candidates, results, reports, running, paused, activeIndex } = ranking;
    const matching = kind => candidates.flatMap((candidate, i) => candidate.kind === kind ? [i] : []);
    for (const button of card.querySelectorAll('[data-opportunity-tab]')) {
        const kind = button.dataset.opportunityTab;
        if (kind === 'Buildings') button.hidden = !matching(kind).length;
        button.setAttribute('aria-pressed', String(kind === tab));
        const gain = Math.max(0, ...matching(kind).map(i => {
            const report = reports[i];
            const row = report?.income;
            return report?.direction > 0 && row?.direction > 0 && row.before > 0 ? (row.after - row.before) / row.before : 0;
        }));
        button.querySelector('.opportunity-tab-gain').textContent = gain > 0 ? `+${formatPercent(gain)}` : '';
    }
    const indices = matching(tab);
    const checked = indices.filter(i => results[i]).length;
    const phase = activeIndex != null ? ` · ${translate(candidates[activeIndex].label)}${ranking.phase ? ` · ${ranking.phase}` : ''}` : '';
    const status = indices.length ? translate(running ? 'Checking {checked} of {total}' : 'Checked {checked} of {total}')
        .replace('{checked}', checked).replace('{total}', indices.length) : '';
    document.getElementById('improve-status').textContent = `${paused ? `${translate('Checking stopped')} · ` : ''}${status}${phase}`;
    const check = document.getElementById('improve-check-btn');
    check.disabled = running || checked === indices.length;
    check.hidden = checked === indices.length;
    check.textContent = translate(checked ? 'Check remaining' : opportunityTabs.find(option => option.kind === tab).action);
    document.getElementById('improve-stop-btn').hidden = !running;
    if (!rebuild) return;
    const holder = document.getElementById('improve-list');
    const open = new Set([...holder.querySelectorAll('details[open][data-opportunity-open]')].map(el => el.dataset.opportunityOpen));
    const ranked = indices.filter(i => reports[i]?.direction > 0).sort((a,b) => reports[b].score - reports[a].score);
    const rest = indices.filter(i => !ranked.includes(i));
    const row = index => {
        const candidate = candidates[index], report = reports[index], checked = results[index];
        const context = candidate.facilities?.slice(0,3).map(translate).join(', ') || '';
        const gain = improvementGain(report);
        const active = ranking.activeIndices.includes(index);
        const status = gain?.text || translate(active ? 'Checking…' : !checked ? 'Not checked'
            : checked.error || report?.inconclusiveLoss ? 'Search inconclusive' : report?.direction < 0
                ? 'Current priorities or income decrease' : 'No improvement found');
        const proof = checked?.retained ? `<p class="hint small">${translate('Kept the better plan from the previous search.')}</p>` : '';
        const trait = candidate.traits?.length
            ? `<span class="opportunity-trait">${translate('Required personality')}: ${escapeText(candidate.traits.map(translate).join(', '))}</span>` : '';
        const before = report?.start?.busy.get(candidate.member), after = report?.finish?.busy.get(candidate.changedMember);
        const assignments = report?.start?.assignments.get(candidate.member) || 1;
        const changed = report?.finish?.assignments.get(candidate.changedMember) || 1;
        const memberLoad = before != null && after != null
            ? `<p class="hint small">${translate('Load per assigned Aniimo')} · ${formatPercent(Math.min(1,before/assignments))} → ${formatPercent(Math.min(1,after/changed))}</p>` : '';
        const canCheck = !checked && !running;
        const canRefine = checked && (checked.error || report?.approximate) && !running;
        const button = canCheck || canRefine ? `<button type="button" class="skip-add-btn" data-opportunity-check="${index}"
            ${canRefine?'data-detailed':''}>${translate(canRefine ? 'Detailed search' : 'Quick compare')}</button>` : '';
        const portrait = candidate.portrait ? `<img src="${escapeText(candidate.portrait)}" class="opportunity-portrait" alt="" loading="lazy">` : '';
        return `<details class="opportunity-row" data-opportunity-open="${tab}:${index}"${open.has(`${tab}:${index}`) ? ' open' : ''}>
            <summary><span class="opportunity-title">${portrait}<span><strong>${escapeText(translate(candidate.label))}</strong>
            ${context ? `<small class="hint">${escapeText(context)}</small>` : ''}</span></span>
            <span class="${gain ? 'improve-gain' : 'improve-none'}">${escapeText(status)}</span></summary>
            <div class="opportunity-detail">${trait}${memberLoad}${proof}${opportunityDescription(candidate)}
            ${report ? `<details class="comparison-result" data-opportunity-open="${tab}:preview:${index}"${open.has(`${tab}:preview:${index}`)?' open':''}>
                <summary>${translate('Preview change')}</summary>${comparisonTable(report)}</details>` : ''}
            ${button}</div></details>`;
    };
    if (!indices.length) {
        holder.innerHTML = `<p class="hint small">${translate(['Aniimo', 'Personalities'].includes(tab) && !ranking.input.roster
            ? 'Use My Aniimo to compare named replacements and personality changes.' : 'No eligible changes found.')}</p>`;
        return;
    }
    if (tab === 'Recipes' && checked === 0 && !running) {
        holder.innerHTML = `<p class="hint small">${translate('Compare unlockable recipes with the current plan.')}</p>`;
        return;
    }
    const elementKey = `${tab}:rest`;
    holder.innerHTML = ranked.map(row).join('') + (rest.length
        ? `<details class="opportunity-rest" data-opportunity-open="${elementKey}"${open.has(elementKey) ? ' open' : ''}>
            <summary>${translate('Other candidates')} (${rest.length})</summary>${rest.map(row).join('')}</details>` : '');
}

// --- Homeland layout -------------------------------------------------------------------
// The whole homeland around one Storage Unit (see layout.js): each finished batch is carried
// there, so the busiest facilities sit closest. Environment buildings keep the plots they cover
// exactly as planned, moving as one block. Facilities with no known size are left out and named.

// Trips per hour for each unit of a plan row: one per finished batch.
function tripsPerUnit(step) {
    if (step.status !== 'producing' || !step.cycle_time || !step.facility_count) return 0;
    const busy = step.busy_units ?? step.facility_count;
    return (busy / step.cycle_time / step.facility_count) * 3600;
}

// Whether a crop needs a growing environment: grown without one, a building's temperature
// would change it. Crops that need none grow the same anywhere.
const needsEnvironment = item => !!recipeIndex.find(r => r.name === item)?.environment;
const takesTurns = step => step.status === 'producing' && !!recipeIndex.find(r => r.name === step.item_name)?.turns;

// The plan as pieces for `layOut`: environment blocks, then one piece per other facility unit,
// then whatever the player owns that the plan doesn't use.
function homelandPieces(plan, input) {
    const pieces = [];
    const placed = {};
    const count = (facility, n = 1) => { placed[facility] = (placed[facility] || 0) + n; };
    const unplaced = new Set();
    const steps = (plan.coin_items || []).filter(s => s.facility);
    const envSteps = steps.filter(s => s.environment && s.status === 'producing');
    const assignments = plan.environment_assignments || [];

    // Environment blocks, grouped as the plan's own maps are (see `renderFacilityPlan`).
    const units = [];
    ENVIRONMENT_MODE_ORDER.forEach(mode => {
        const rows = envSteps.filter(s => s.environment === mode);
        if (rows.length) splitByEnvironmentUnit(rows, assignments.filter(a => a.mode === mode)).forEach(unit => units.push({ mode, unit }));
    });
    const blocks = new Map();
    units.forEach(({ mode, unit }, i) => {
        const key = unit.pairKey ?? `#${i}`;
        const block = blocks.get(key) || { mode, unit, parts: [] };
        block.parts.push({ zone: unit.zone ?? 0, layout: unit.layout, rows: unit.rows });
        blocks.set(key, block);
    });
    const placedInBlocks = {};
    // Each is a cluster for `layOut`: its buildings, and the plots they cover, which may go
    // anywhere in their zone.
    blocks.forEach(({ mode, unit, parts }) => {
        const size = environmentBuildingSize(unit.building);
        const buildings = [{ x: 0, y: 0, w: size, h: size, facility: unit.building, mode: unit.pairModes ? unit.pairModes[0] : mode, building: true }];
        count(unit.building);
        if (unit.partner) {
            const partnerSize = environmentBuildingSize(unit.partner[0]);
            buildings.push({ x: unit.partner[1], y: unit.partner[2], w: partnerSize, h: partnerSize, facility: unit.partner[0], mode: unit.pairModes ? unit.pairModes[1] : mode, building: true });
            count(unit.partner[0]);
        }
        const plots = [];
        const planned = [];
        parts.forEach(({ zone, layout, rows }) => {
            // Each plot in this zone gets one of the crops planned for its facility here.
            const crops = {};
            rows.forEach(r => {
                for (let n = 0; n < r.facility_count; n++) (crops[r.facility] ||= []).push({ crop: r.item_name, trips: tripsPerUnit(r), cycle: r.cycle_time });
            });
            layout.forEach(p => {
                const crop = (crops[p.facility] || []).shift() || { crop: null, trips: 0 };
                plots.push({ w: p.size, h: p.size, weight: crop.trips, cycle: crop.cycle, zone: unit.partner ? zone : 0, facility: p.facility, crop: crop.crop });
                planned.push({ x: p.x, y: p.y });
                count(p.facility);
                placedInBlocks[`${p.facility}|${crop.crop}`] = (placedInBlocks[`${p.facility}|${crop.crop}`] || 0) + 1;
            });
        });
        pieces.push({ cluster: true, buildings, plots, planned });
    });

    // For every facility type, recipes allowed to take turns share a unit only when there are not
    // enough owned units to give each recipe its own. No facility names are special-cased here.
    const turnAllocations = allocateTurnFacilities(steps, facility => tierCount(input.facilities[facility]), takesTurns);
    const scheduledSites=new Map();
    for(const site of plan.recipe_schedule?.sites||[]){
        if(!scheduledSites.has(site.facility))scheduledSites.set(site.facility,[]);
        scheduledSites.get(site.facility).push(site);
    }
    for(const [facility,sites] of scheduledSites)turnAllocations.set(facility,sites.map(site=>site.jobs));
    turnAllocations.forEach((allocations, facility) => {
        const footprint = FACILITY_FOOTPRINTS[facility];
        if (!footprint) {
            unplaced.add(facility);
            return;
        }
        allocations.forEach((jobs,index) => {
            const weight = jobs.reduce((sum, j) => sum + j.rate * 3600, 0);
            pieces.push({ members: [{ x: 0, y: 0, w: footprint[0], h: footprint[1], weight, scheduleId: scheduledSites.get(facility)?.[index]?.id, schedulePhases:siteSchedule(plan.recipe_schedule,scheduledSites.get(facility)?.[index]?.id), schedulePeak:scheduledSites.get(facility)?.[index]?.peakLoad, jobs: jobs.length ? jobs : undefined, electric_level: jobs[0]?.electric_level, cycle: jobs[0]?.cycle, facility, crop: jobs[0]?.item ?? null, sensitive: false }] });
        });
        count(facility, allocations.length);
    });

    // Everything else, one unit at a time; environment crops no map took count here too. Rows for
    // a turn facility are already represented above, including its idle row and physical units.
    steps.filter(step => !turnAllocations.has(step.facility)).forEach(step => {
        let n = step.facility_count;
        if (step.environment && step.status === 'producing') {
            const key = `${step.facility}|${step.item_name}`;
            const taken = Math.min(n, placedInBlocks[key] || 0);
            placedInBlocks[key] = (placedInBlocks[key] || 0) - taken;
            n -= taken;
        }
        const footprint = FACILITY_FOOTPRINTS[step.facility];
        if (!footprint) {
            if (n > 0) unplaced.add(step.facility);
            return;
        }
        const physicalCrew = n===step.facility_count ? splitProductionSites(step,plan.roster_routes) : null;
        for (let i = 0; i < n; i++) {
            // A crop that needs an environment but is grown without one stays out of every
            // coverage square, so no building's temperature changes it.
            const growing = step.status === 'producing';
            const assigned=physicalCrew?.[i];
            pieces.push({ members: [{ x: 0, y: 0, w: footprint[0], h: footprint[1], weight: assigned?assigned.rate*3600:tripsPerUnit(step), crew: assigned?.crew??step.crew,
                electric_level: step.electric_level, cycle: assigned?.cycle??step.cycle_time,
                load: assigned?.load??(growing ? (step.busy_units ?? step.facility_count) / step.facility_count : 0),
                facility: step.facility, crop: growing ? step.item_name : null, sensitive: growing && needsEnvironment(step.item_name) }] });
        }
        count(step.facility, n);
    });

    // Keep unused production facilities visible. Climate buildings are placed
    // only with the growing clusters that actually need their coverage above.
    FACILITIES.forEach(f => {
        if (f.name in ENVIRONMENT_BUILDING_SIZES) return;
        const owned = tierCount(input.facilities[f.name]);
        const extra = owned - (placed[f.name] || 0);
        if (extra <= 0) return;
        const footprint = FACILITY_FOOTPRINTS[f.name];
        if (!footprint) {
            unplaced.add(f.name);
            return;
        }
        for (let i = 0; i < extra; i++) pieces.push({ members: [{ x: 0, y: 0, w: footprint[0], h: footprint[1], weight: 0, facility: f.name, crop: null, building: false, mode: null }] });
    });
    const generators = Math.min(plan.power_generators || 0, generatorLimit(layoutHomeLevel()));
    for (let i = 0; i < generators; i++) pieces.push({ members: [{ x: 0, y: 0, w: 2, h: 2,
        weight: 0, facility: 'Crackle Generator', generator: true, generatorTier: plan.power_generator_levels?.[i]?.[0],
        lightningLevel: plan.power_generator_levels?.[i]?.[1],
        generatedWatts: plan.generator_watts_by_lightning?.[(plan.power_generator_levels?.[i]?.[1]??0)-1] }] });
    const physical = pieces.flatMap(p => p.cluster ? p.plots : p.members);
    for (const [item, facility, worker, visits, cropWork] of plan.mobile_work || []) {
        const targets = physical.filter(m => m.facility === facility && (m.jobs
            ? m.jobs.some(j => j.item === item && (cropWork || j.crew === worker))
            : m.crop === item && (cropWork || m.crew === worker)));
        for (const m of targets) {
            const share = visits / targets.length;
            const existing = (m.workers ||= []).find(([member]) => member === worker);
            if (existing) existing[1] += share; else m.workers.push([worker, share]);
        }
    }
    const recipesByName = new Map(recipeIndex.map(recipe => [recipe.name, recipe]));
    assignFacilityStock(physical, input.facilities, recipesByName);
    for (const member of physical) {
        if (!(member.weight > 0)) continue;
        member.batchWeight = member.weight;
        const limit = pickupStockLimit(member);
        member.weight = member.jobs ? member.jobs.reduce((sum, job) => sum + job.rate * 3600
            * haulingBatchTrips(recipesByName.get(job.item), 3, limit, member.facility), 0)
            : member.weight * haulingBatchTrips(recipesByName.get(member.crop), 3, limit, member.facility);
    }
    if(selectedSetupTab()==='custom'&&Object.keys(reactiveDispatch).length){
        attachDeliveryFlows({pieces:[{members:physical}]},reactiveDispatch,recipeIndex,rosterWorkload(plan).members,plan.roster_routes||[]);
    }
    return { pieces, unplaced: [...unplaced] };
}

// Colors for the layout: crops and Aniimo materials as in the environment maps, the rest by
// category.
const LAYOUT_CATEGORY_COLORS = {
    'Materials': '#8d8f5a',
    'Aniimo Materials': '#5c9bd6',
    'Materials Processing': '#8a7fc4',
    'Environment': '#9aa0a8',
};
const layoutColor = m => m.building
    ? (ENVIRONMENT_MODE_COLORS[m.mode] || '#9aa0a8')
    : ENVIRONMENT_FACILITY_COLORS[m.facility] || LAYOUT_CATEGORY_COLORS[FACILITY_CATEGORY_BY_NAME.get(m.facility)] || '#888888';
const initialsOf = name => name.split(/[\s-]+/).map(w => w[0]).join('').toUpperCase();

let layoutRunId = 0;
let layoutWorker = null;
const layoutsByPlan = new WeakMap();
let layoutStorageTimer = null;

// Every plot of the homeland, `{ number, x, y, w, h }` in tiles, with the top left at the origin.
function homelandPlots() {
    return HOMELAND_PLOTS.flatMap((row, r) => row.map((number, c) => ({
        number, x: c * HOMELAND_PLOT_SIZE.w, y: r * HOMELAND_PLOT_SIZE.h, w: HOMELAND_PLOT_SIZE.w, h: HOMELAND_PLOT_SIZE.h,
    })));
}

// The RV level the layout is for: the one given in Simple mode, else the lowest that allows
// everything entered (see `homeLevelCovering`).
function layoutHomeLevel(input = lastPlanInput) {
    if (isSimpleMode()) return selectedHomeLevel();
    const minimum = homeLevelCovering(input ?? buildingInventory());
    return Math.min(MAX_HOME_LEVEL, Math.max(minimum,
        Math.floor(numberOrDefault(document.getElementById('home-level').value, minimum))));
}

function layoutStyle() {
    const value = document.getElementById('layout-style').value;
    return normalizeMapStyle(value);
}

function groupPurposeName(purpose) {
    return { sales: 'For sale', support: 'Supply and support', rv: 'RV upgrade and support', mixed: 'Mixed production' }[purpose];
}

const rangeLabel = range => range ? range[0] === range[1] ? range[0] : range.join('–') : '';
const resourceZoneName = theme => ({ fields: 'Crop fields', woodland: 'Tree groves', mining: 'Mining area',
    water: 'Water wells', aniimo: 'Primary and Leisure production', growing: 'Fields and trees', extraction: 'Mines and wells', processing: 'Workshops' })[theme];
const resourceZoneTheme = group => group.range ? '' : group.themes?.[0] ?? '';
const districtLabel = (group, index) => !group?.storageIndices ? `SU${index + 1}`
    : group.storageIndices.length ? group.storageIndices.map(i => `SU${i + 1}`).join(' + ')
        : translate('Zone {n}').replace('{n}', index + 1);

function updateLayoutStyleControls() {
    const grouped = layoutStyle() !== 'delivery';
    document.getElementById('layout-group-hint').hidden = !grouped;
}

function attachLayoutHandlers() {
    document.getElementById('layout-building-index').addEventListener('click', event => {
        const button = event.target.closest('[data-layout-sites]');
        const svg = document.querySelector('#layout-diagram .layout-svg');
        if (!button || !svg) return;
        const sites = new Set(button.dataset.layoutSites.split(','));
        const matches = [...svg.querySelectorAll('[data-layout-site]')].filter(element => {
            const chosen = sites.has(element.dataset.layoutSite);
            element.classList.toggle('layout-site-focused', chosen);
            return chosen;
        });
        if (!matches.length) return;
        document.querySelectorAll('#layout-building-index [aria-pressed]').forEach(entry =>
            entry.setAttribute('aria-pressed', String(entry === button)));
        const rectangles = matches.map(element => element.querySelector('rect'));
        const left = Math.min(...rectangles.map(rectangle => Number(rectangle.getAttribute('x'))));
        const top = Math.min(...rectangles.map(rectangle => Number(rectangle.getAttribute('y'))));
        const right = Math.max(...rectangles.map(rectangle => Number(rectangle.getAttribute('x')) + Number(rectangle.getAttribute('width'))));
        const bottom = Math.max(...rectangles.map(rectangle => Number(rectangle.getAttribute('y')) + Number(rectangle.getAttribute('height'))));
        const [, , baseWidth, baseHeight] = layoutBaseOf(svg);
        const width = Math.min(baseWidth, Math.max(baseWidth / LAYOUT_MAX_ZOOM, right - left + 8, (bottom - top + 8) * baseWidth / baseHeight));
        const height = width * baseHeight / baseWidth;
        setLayoutView(svg, [(left + right - width) / 2, (top + bottom - height) / 2, width, height]);
        svg.scrollIntoView({ block: 'nearest' });
    });
    ['layout-style'].forEach(id => document.getElementById(id).addEventListener('change', () => {
        updateLayoutStyleControls();
        if (!lastPlan?.success) return;
        stopRanking();
        delete rankingsBySetup[selectedAniimoSetup()];
        travelRefinements = 0;
        haulingRefinements = 0;
        renderHomelandLayout(lastPlan);
    }));
    document.getElementById('layout-storage-count').addEventListener('input', () => {
        clearTimeout(layoutStorageTimer);
        layoutStorageTimer = setTimeout(() => {
            stopRanking();
            delete rankingsBySetup[selectedAniimoSetup()];
            travelRefinements = 0;
            haulingRefinements = 0;
            if (haulingDefaultSeconds > 0 && selectedSetupTab() === 'custom') {
                haulingSeconds = {};
                haulingDefaultSeconds = 0;
                switchAniimoSetup();
                return;
            }
            if (lastPlan?.success) renderHomelandLayout(lastPlan);
        }, 300);
    });
    document.getElementById('layout-whole').addEventListener('change', (e) => {
        layoutShowsWhole = e.target.checked;
        if (lastLayout) drawLayout(lastLayout);
    });
    document.getElementById('layout-sim-on').addEventListener('change', () => {
        if (lastLayout) drawLayout(lastLayout);
    });
    for (const id of ['layout-recipes', 'layout-workers', 'layout-icons']) document.getElementById(id).addEventListener('change', () => {
        if (lastLayout) drawLayout(lastLayout);
    });
    document.getElementById('layout-replay').addEventListener('click', () => {
        if (layoutSim) resetLayoutSim(layoutSim);
    });
    const diagram = document.getElementById('layout-diagram');
    diagram.addEventListener('load', event => {
        if (event.target.matches?.('.layout-facility-icon')) event.target.classList.add('loaded');
    }, true);
    attachLayoutZoom(diagram);
}

// --- Layout zoom -----------------------------------------------------------------------
// Ctrl + scroll (or a trackpad pinch, which browsers send as one) zooms the layout around the
// pointer, from the drawn view up to `LAYOUT_MAX_ZOOM` times into it; zoomed in, dragging moves
// around and a double-click goes back. It works on the SVG's viewBox, so everything stays sharp.
const LAYOUT_MAX_ZOOM = 8;

// The zoomed-in viewBox `[x, y, w, h]`, kept across redraws of the same view (the recipe or
// simulation toggles), or null when not zoomed.
let layoutZoom = null;

const viewBoxOf = svg => svg.getAttribute('viewBox').split(' ').map(Number);

// The drawn view the zoom works within, as `homelandSvg` set it.
const layoutBaseOf = svg => svg.dataset.base.split(' ').map(Number);

// Sets the layout's viewBox to `view`, kept within the drawn view; back to it when zoomed all the
// way out.
function setLayoutView(svg, [x, y, w, h]) {
    const [bx, by, bw, bh] = layoutBaseOf(svg);
    if (w >= bw - 1e-9) {
        layoutZoom = null;
        svg.setAttribute('viewBox', svg.dataset.base);
    } else {
        x = Math.min(Math.max(x, bx), bx + bw - w);
        y = Math.min(Math.max(y, by), by + bh - h);
        layoutZoom = { base: svg.dataset.base, view: [x, y, w, h] };
        svg.setAttribute('viewBox', layoutZoom.view.join(' '));
    }
    svg.classList.toggle('zoomed', !!layoutZoom);
    updateMapZoomControls(svg);
}

function updateMapZoomControls(svg) {
    const controls = document.getElementById('layout-zoom-controls');
    controls.hidden = !svg;
    if (!svg) return;
    const width = viewBoxOf(svg)[2];
    const max = layoutBaseOf(svg)[2];
    controls.querySelector('[data-map-zoom="in"]').disabled = width <= max / LAYOUT_MAX_ZOOM + 1e-9;
    for (const action of ['out', 'fit']) controls.querySelector(`[data-map-zoom="${action}"]`).disabled = width >= max - 1e-9;
}

function attachLayoutZoom(diagram) {
    document.getElementById('layout-zoom-controls').addEventListener('click', event => {
        const button = event.target.closest('[data-map-zoom]');
        const svg = diagram.querySelector('.layout-svg');
        if (!button || !svg) return;
        const action = button.dataset.mapZoom;
        if (action === 'fit') return setLayoutView(svg, layoutBaseOf(svg));
        const [x, y, w, h] = viewBoxOf(svg);
        const max = layoutBaseOf(svg)[2];
        const width = Math.max(max / LAYOUT_MAX_ZOOM, Math.min(max, w * (action === 'in' ? 0.67 : 1 / 0.67)));
        const height = h * width / w;
        setLayoutView(svg, [x + (w - width) / 2, y + (h - height) / 2, width, height]);
        if (button.disabled) document.querySelector('#layout-zoom-controls [data-map-zoom]:enabled')?.focus({ preventScroll: true });
    });
    diagram.addEventListener('wheel', (e) => {
        const svg = diagram.querySelector('.layout-svg');
        if (!e.ctrlKey || !svg) return;
        // Keeps the browser from zooming the whole page instead.
        e.preventDefault();
        const [x, y, w, h] = viewBoxOf(svg);
        const bw = layoutBaseOf(svg)[2];
        const width = Math.min(Math.max(w * Math.exp(e.deltaY * 0.002), bw / LAYOUT_MAX_ZOOM), bw);
        const scale = width / w;
        // The point under the pointer stays put.
        const at = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
        setLayoutView(svg, [at.x - (at.x - x) * scale, at.y - (at.y - y) * scale, width, h * scale]);
    }, { passive: false });

    // A drag pans only once it has moved a few pixels, so a tap still shows a facility's details.
    let drag = null;
    diagram.addEventListener('pointerdown', (e) => {
        const svg = diagram.querySelector('.layout-svg');
        if (!svg || !layoutZoom || e.button !== 0) return;
        drag = { svg, id: e.pointerId, x: e.clientX, y: e.clientY, view: viewBoxOf(svg), moving: false };
    });
    diagram.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (!drag.moving && Math.hypot(dx, dy) < 4) return;
        if (!drag.moving) {
            drag.moving = true;
            drag.svg.setPointerCapture(e.pointerId);
            drag.svg.classList.add('panning');
        }
        const perPixel = 1 / drag.svg.getScreenCTM().a;
        const [x, y, w, h] = drag.view;
        setLayoutView(drag.svg, [x - dx * perPixel, y - dy * perPixel, w, h]);
    });
    const endDrag = () => {
        drag?.svg.classList.remove('panning');
        drag = null;
    };
    diagram.addEventListener('pointerup', endDrag);
    diagram.addEventListener('pointercancel', endDrag);
    diagram.addEventListener('dblclick', () => {
        const svg = diagram.querySelector('.layout-svg');
        if (svg && layoutZoom) setLayoutView(svg, layoutBaseOf(svg));
    });
}

function drawLayout(drawn) {
    const diagram = document.getElementById('layout-diagram');
    diagram.innerHTML = homelandSvg(drawn.layout, drawn.homeLevel, drawn.plan);
    renderBuildingIndex(drawn.layout);
    // A redraw of the same view keeps its zoom; a new plan or the whole homeland starts over.
    const svg = diagram.querySelector('.layout-svg');
    updateMapZoomControls(svg);
    if (!svg) return;
    if (layoutZoom && layoutZoom.base === svg.dataset.base) setLayoutView(svg, layoutZoom.view);
    else layoutZoom = null;
    // With the simulation off, the layout is drawn on its own.
    const on = document.getElementById('layout-sim-on').checked;
    diagram.classList.toggle('no-sim', !on);
    startLayoutSim(on ? diagram.querySelector('.layout-svg') : null, layoutFlows(drawn.layout), new Map(Object.entries(drawn.plan.recipe_schedule?.initialStock||{})));
}

function renderBuildingIndex(layout) {
    const panel = document.getElementById('layout-building-index');
    if (!layout.groups?.length && layout.groupFallback !== 'space') {
        panel.hidden = true;
        return;
    }
    const members = layout.pieces.flatMap(piece => piece.members);
    const processors = new Set(recipeIndex.filter(recipe => recipe.ingredients?.length).map(recipe => recipe.name));
    const byDistrict = (layout.groups ?? layout.storages).map(() => new Map());
    members.forEach((member, index) => {
        const products = member.jobs?.map(job => job.item) ?? [member.crop];
        const workshop = FACILITY_CATEGORY_BY_NAME.get(member.facility) === 'Materials Processing';
        if (!workshop && (!(member.weight > 0) || !products.some(item => processors.has(item)))) return;
        const storageIndex = layout.groups ? layout.groups.findIndex(({ bounds: { x, y, w, h } }) =>
            member.x >= x && member.y >= y && member.x + member.w <= x + w && member.y + member.h <= y + h)
            : layout.storages.indexOf(nearestStorage(member, layout.storages));
        const names = byDistrict[storageIndex];
        if (!names) return;
        if (!names.has(member.facility)) names.set(member.facility, { sites: [], products: new Set() });
        const entry = names.get(member.facility);
        entry.sites.push(index);
        products.filter(Boolean).forEach(item => entry.products.add(prettyItem(item)));
    });
    const groups = byDistrict.map((names, i) => {
        if (!names.size) return '';
        const sorted = [...names].sort(([a], [b]) => a.localeCompare(b, 'en'));
        const range = rangeLabel(layout.groups?.[i]?.range);
        return `<div class="layout-index-group"><strong>${escapeText(districtLabel(layout.groups?.[i], i))}${range ? ` · ${range}` : ''}</strong><div>${sorted.map(([name, entry]) =>
            `<button type="button" data-layout-sites="${entry.sites.join(',')}" aria-pressed="false" title="${escapeText([...entry.products].join(', '))}" translate="no">${escapeText(name)}</button>`).join('')}</div></div>`;
    }).filter(Boolean);
    document.getElementById('layout-index-nearest').hidden = !!layout.groups;
    document.getElementById('layout-building-index-list').innerHTML = groups.join('');
    panel.hidden = !groups.length;
}

function layoutOptionsFor(plan, homeLevel, setup = selectedSetupTab()) {
    const limit = storageUnitLimit(homeLevel);
    const storageCount = Math.min(limit, Math.max(0, Math.floor(numberOrDefault(
        document.getElementById('layout-storage-count').value, limit))));
    const style = layoutStyle();
    const groupGap = 0;
    const saleProducts = null;
    const recipes = style === 'delivery' ? [] : [...new Set((plan.coin_items || [])
        .filter(step => step.status === 'producing' && step.item_name).map(step => step.item_name))]
        .map(item => ({ item, ...recipeTerms(item) }));
    let staffing = null;
    if (recipes.length) {
        const ownedPlan = setup === 'custom';
        const team = ownedPlan ? rosterWorkload({ ...plan, layout_walking: [],
            assumed_aniimo: haulingBaseByPlan.get(plan) ?? plan.assumed_aniimo }) : null;
        const bestTeam = (setup === 'best'||setup!=='custom'&&plan.recipe_schedule) ? bestPlanTeam(plan, 0, null) : null;
        const accountForTravel = true;
        const rvLimit = ANIIMO_MAX[homeLevel - 1] ?? Infinity;
        const visits = {};
        for (const [, , member, count] of plan.mobile_work || []) visits[member] = (visits[member] || 0) + count;
        staffing = {
            limit: rvLimit,
            dispatch:ownedPlan&&Object.keys(reactiveDispatch).length?reactiveDispatch:null,
            routes:ownedPlan?plan.roster_routes:[],
            dispatchRecipes:ownedPlan?recipeIndex.filter(r=>(plan.coin_items||[]).some(s=>s.status==='producing'&&s.item_name===r.name)):[],
            permanent:ownedPlan?permanentWorkers(plan,team.members,RESIDENT_FACILITIES):[],
            members: team?.members,
            busy: team?.busy,
            anchored: team?.anchored,
            minimumWorkers: ownedPlan ? 0 : bestTeam?.shifts.length ?? aniimoTeam({ ...plan, hauling_busy: 0 }).total,
            haulingSpare: bestTeam?.haulingSpare ?? 0,
            movement: ownedPlan && plan.mobile_work?.length
                ? { defaultDistance: movementDefaultDistance, byMember: movementDistances, visits } : null,
            haulingLevel: setup === 'minimum' ? 1 : 3,
            haulingBound: haulingRouteBound(accountForTravel),
            accountForTravel,
            facilities: lastPlanInput?.facilities,
            steps: (plan.coin_items || []).filter(step => step.status === 'producing'),
        };
    }
    return {
        key: `${homeLevel}:${storageCount}:${style}`,
        storageCount, poleLimit: powerPoleLimit(homeLevel), style, groupGap, saleProducts, recipes, staffing,
        cells: homelandPlots().filter(p => p.number <= homeLevel).map(({ x, y, w, h }) => ({ x, y, w, h })),
    };
}

function rememberLayout(plan, key, layout) {
    let cached = layoutsByPlan.get(plan);
    if (!cached) {
        cached = new Map();
        layoutsByPlan.set(plan, cached);
    }
    if (!cached.has(key) && cached.size >= 4) cached.delete(cached.keys().next().value);
    cached.set(key, layout);
}

function renderHomelandLayout(plan, keepLayout = false) {
    const card = document.getElementById('layout-card');
    if (!plan?.success || !lastPlanInput) {
        card.style.display = 'none';
        return;
    }
    const runId = ++layoutRunId;
    lastLayout = null;
    layoutZoom = null;
    stopLayoutSim();
    const layoutStep = keepLayout ? 'refine' : 'layout';
    setStep(layoutStep, 'start');
    card.style.display = 'block';
    document.getElementById('layout-summary').textContent = keepLayout ? 'Updating map and worker loads…' : 'Laying out…';
    if (!keepLayout) document.getElementById('layout-diagram').innerHTML = '';
    updateMapZoomControls(null);
    document.getElementById('layout-group-legend').hidden = true;
    document.getElementById('layout-building-index').hidden = true;
    document.getElementById('layout-group-notice').hidden = true;
    document.getElementById('layout-group-hint').hidden = true;
    updateLayoutStyleControls();
    // Worked out in a worker of its own: a large homeland takes a few seconds.
    const { pieces, unplaced } = homelandPieces(plan, lastPlanInput);
    const homeLevel = layoutHomeLevel();
    const storageLimit = storageUnitLimit(homeLevel);
    const { key: layoutKey, ...layoutOptions } = layoutOptionsFor(plan, homeLevel);
    const storageInput = document.getElementById('layout-storage-count');
    storageInput.max = storageLimit;
    storageInput.placeholder = String(storageLimit);
    if (storageInput.value !== '') storageInput.value = layoutOptions.storageCount;
    document.getElementById('layout-storage-limit').textContent = translate('Maximum at RV {level}: {n}')
        .replace('{level}', homeLevel).replace('{n}', storageLimit);
    if (layoutWorker) layoutWorker.terminate();
    layoutWorker = null;
    const applyLayout = layout => {
        if (runId !== layoutRunId) return;
        rememberLayout(plan, layoutKey, layout);
        const storages = layout.storages;
        // Buildings carry nothing themselves.
        const members = layout.pieces.flatMap(p => p.members).map(m => ({ ...m, weight: m.weight || 0 }));
        const trips = members.reduce((sum, m) => sum + m.weight, 0);
        const walked = members.reduce((sum, m) => {
            const storage = nearestStorage(m, storages);
            return sum + (storage ? m.weight * Math.hypot(m.x + m.w / 2 - storage.x - storage.w / 2,
                m.y + m.h / 2 - storage.y - storage.h / 2) : 0);
        }, 0);
        const noRoom = [...new Set(layout.unplaced.map(i => {
            const piece = pieces[i];
            return piece.cluster ? `${piece.buildings[0].facility} and its plots` : piece.members[0].facility;
        }))];
        const missingGenerators = Math.max(0, (plan.power_generators || 0) - generatorLimit(homeLevel));
        const powerSummary = layout.power.consumers ? translate('Power grid: {n} generators, {p} / {max} poles, {w} W.')
            .replace('{n}', layout.power.generators).replace('{p}', layout.power.poles.length)
            .replace('{max}', layout.power.maximum).replace('{w}', formatNumber(plan.power_used || 0)) : '';
        const notes = [
            powerSummary,
            ...(layout.power.networks??[]).filter(n=>n.generators).map(powerNetworkLabel),
            layout.power.disconnected ? translate('Power connection not found for {n} buildings.').replace('{n}', layout.power.disconnected) : '',
            missingGenerators ? translate('The plan needs {n} more generators than can be placed at this RV level.').replace('{n}', missingGenerators) : '',
            layout.groups ? translate('{n} production groups.').replace('{n}', layout.groups.length) : '',
            noRoom.length ? `No room found in RV ${homeLevel}'s plots for: ${noRoom.join(', ')}.` : '',
            unplaced.length ? `Not placed, size unknown: ${unplaced.join(', ')}.` : '',
        ].filter(Boolean).join(' ');
        if(layout.power.networks?.length){
            const power=document.getElementById('power-used');
            power.textContent=layout.power.networks.filter(n=>n.generators).map(powerNetworkLabel).join(' · ');
        }else{
            document.getElementById('power-used').textContent=plan.power_used==null?'':translate('E-mode load: {draw} W · Generation: {output} W · Supply: 120%')
                .replace('{draw}',formatNumber(plan.power_used)).replace('{output}',formatNumber(plan.power_generated??0));
        }
        const arrangementNotice = [
            layout.groupFallback === 'storage' ? translate('Grouped maps need at least one Storage Unit. Showing the delivery layout.') : '',
            layout.groupFallback === 'space' ? translate('The grouped map could not fit every facility and connect the grid. Showing the delivery layout.') : '',
            layout.groupFallback === 'workload' ? translate('Grouped layouts could not preserve this plan’s worker capacity and output. Showing the delivery layout.') : '',
            layout.groupPurposeFallback ? translate('Separate sale and support groups did not fit. Showing mixed groups.') : '',
            layout.rangeMixedPurposes ? translate('Some sale and support workshops share a block to keep letter ranges intact.') : '',
            layout.groupGap < layout.requestedGroupGap ? translate('The selected gap did not fit. The map uses {gap} tile(s) between groups.')
                .replace('{gap}', layout.groupGap) : '',
        ].filter(Boolean).join(' ');
        const notice = document.getElementById('layout-group-notice');
        notice.textContent = arrangementNotice;
        notice.hidden = !arrangementNotice;
        const summary = storages.length === 0
            ? translate('No Storage Units placed.')
            : trips > 0
                ? translate('{trips} trips/hour to {n} Storage Units, {distance} tiles each on average.')
                    .replace('{trips}', formatNumber(Math.round(trips))).replace('{n}', storages.length)
                    .replace('{distance}', (walked / trips).toFixed(1))
                : translate('Nothing in this plan is carried to storage.');
        document.getElementById('layout-summary').textContent = `${summary}${notes ? ` ${notes}` : ''}`;
        const legend = document.getElementById('layout-group-legend');
        legend.innerHTML = (layout.groups || []).map((group, i) => {
            const parts = [group.range && !group.themes?.includes('processing') ? 'Workshops' : null,
                !group.themes?.length && !group.range || ['sales', 'rv'].includes(group.purpose) ? groupPurposeName(group.purpose) : null,
                ...(group.themes ?? []).map(resourceZoneName)].filter(Boolean);
            return `<li data-purpose="${group.purpose}" data-theme="${resourceZoneTheme(group)}"><strong>${escapeText(districtLabel(group, i))}${group.range ? ` · ${rangeLabel(group.range)}` : ''}</strong>
                ${escapeText(parts.map(translate).join(' · '))}</li>`;
        }).join('');
        legend.hidden = !layout.groups;
        document.getElementById('layout-group-hint').hidden = !layout.groups;
        lastLayout = { layout, homeLevel, plan };
        renderFacilityPlan(plan);
        drawLayout(lastLayout);
        setStep(layoutStep, 'done');
        if (selectedSetupTab() === 'custom') {
            if (refineReactiveDispatch(layout, plan)) return;
        } else {
            if (refineWorkerMovement(layout, plan)) return;
            plan.layout_walking = layoutWalkingAdjustments(layout.pieces.flatMap(piece => piece.members), plan);
            if (assignLayoutHauling(layout, plan)) return;
        }
        renderAniimoSummary(plan);
        if (!setupSolve && !mainSolve) {
            resetPlanButton();
            rankImprovementsFor(selectedAniimoSetup());
        }
    };
    const cached = layoutsByPlan.get(plan)?.get(layoutKey);
    if (cached) {
        // Keep the same asynchronous boundary as a worker response while displayPlan renders.
        queueMicrotask(() => applyLayout(cached));
        return;
    }
    const solver = new Worker(WORKER_URL.replace('worker.js', 'layout-worker.js'), { type: 'module' });
    layoutWorker = solver;
    solver.onmessage = (event) => {
        solver.terminate();
        if (layoutWorker === solver) layoutWorker = null;
        applyLayout(event.data);
    };
    solver.onerror = (event) => {
        console.error('Homeland layout failed:', event.message || event);
        if (runId !== layoutRunId) return;
        stopLayout();
        document.getElementById('layout-summary').textContent = 'The layout couldn\'t be worked out.';
        setStep(layoutStep, 'fail');
        if (!setupSolve && !mainSolve) resetPlanButton();
        if (selectedSetupTab() === 'best') renderBestTeam(plan, translate('Unavailable'));
        if (!setupSolve && !mainSolve) rankImprovementsFor(selectedAniimoSetup());
    };
    solver.postMessage({ pieces, ...layoutOptions });
}

// Stops a layout still being worked out, so it can't land over a newer plan.
function stopLayout() {
    clearTimeout(layoutStorageTimer);
    stopLayoutSim();
    layoutRunId++;
    layoutWorker?.terminate();
    layoutWorker = null;
    lastLayout = null;
}

// A map piece's game icon and optional recipe names. Use initials while the art loads.
function pieceLabel(m, showRecipes, showIcons) {
    const x = m.x + m.w / 2;
    const y = m.y + m.h / 2;
    const initials = Math.min(0.8, m.w / 3);
    const recipe = showRecipes ? (m.jobs ? m.jobs.map(j => prettyItem(j.item)).join(', ') : m.crop ? prettyItem(m.crop) : '') : '';
    const size = Math.min(initials * 0.62, (m.w - 0.16) / (recipe.length * 0.56));
    const labelY = !showIcons && recipe ? y - (size + 0.08) / 2 : y;
    const fallback = `<text class="layout-icon-fallback" x="${x}" y="${labelY}" font-size="${initials}">${m.generator ? '⚡G' : initialsOf(m.facility)}</text>`;
    const art = showIcons ? layoutFacilityIcon(m.facility, m, recipe ? 0.16 : 0) : '';
    if (!recipe) return fallback + art;
    const recipeY = showIcons ? m.y + m.h - size * 0.8 : y + (initials + 0.08) / 2;
    return `${fallback}${art}<text class="layout-recipe" x="${x}" y="${recipeY}" font-size="${size}">${escapeText(recipe)}</text>`;
}

function facilityIconUrl(facility) {
    const id = facilityIcons[facility];
    return id ? `https://aniimo.gamevault.in/generated/media/items/ui_item_${id}.webp` : '';
}

function layoutFacilityIcon(facility, { x, y, w, h }, labelSpace = 0) {
    const icon = facilityIconUrl(facility);
    if (!icon) return '';
    return `<image class="layout-facility-icon" href="${icon}"
        x="${x}" y="${y}" width="${w}" height="${h * (1 - labelSpace)}" aria-hidden="true"/>`;
}

// Whether the layout shows the whole homeland rather than just what's placed; the player's toggle.
let layoutShowsWhole = false;
let lastLayout = null;

function layoutWorkAtSites(plan, sites, layout) {
    const dedicated = new Map();
    for (const [facility, crew, count] of plan.staffing || []) {
        const workers = dedicated.get(facility) ?? [];
        for (let i = 0; i < Math.round(count); i++) workers.push(crew);
        dedicated.set(facility, workers);
    }
    const assumed = new Map((plan.assumed_aniimo || []).map(([id, ability, level]) => [id, { ability, level }]));
    const owned = selectedSetupTab() === 'custom';
    const rows = new Map();
    for (const step of plan.coin_items || []) {
        if (step.status !== 'producing') continue;
        rows.set(JSON.stringify([step.facility, step.item_name, step.crew, step.electric_level]), step);
    }
    const percent = value => `${formatNumber(Math.min(100, Math.max(0, value * 100)))}%`;
    const iconFor = (id, ability, level) => {
        const member = owned && roster[id];
        const label = ability ? `${translate(ability)}${level ? ` Lv.${level}` : ''}` : '';
        if (member) {
            const form = rosterCatalogId(member.catalogId, member.name);
            return {
                key: `member:${id}`, label: rosterTileLabel(member, id),
                portrait: aniimoPortrait(form), prismana: form?.includes('prismana'), ability, level,
            };
        }
        return { key: label, label: id != null ? `${translate('Assumed Aniimo')} · ${label}` : label, ability, level };
    };
    const matchingCropWorkers = (ability, level) => new Set((plan.crop_assignments || [])
        .filter(([job, required]) => ability === job && level === required).map(([, , id]) => id));
    return sites.map(m => {
        if (m.generator || (m.building && m.mode)) {
            const team = dedicated.get(m.facility) ?? [];
            const ability = ENVIRONMENT_BUILDING_ABILITY[m.facility];
            const matching = m.lightningLevel ? team.findIndex(id => (roster[id]?.abilities[ability] ?? assumed.get(id)?.level) === m.lightningLevel) : -1;
            const id = team.length ? team.splice(Math.max(0, matching), 1)[0] : undefined;
            const worker = iconFor(id, ability, m.lightningLevel ?? roster[id]?.abilities[ability] ?? assumed.get(id)?.level);
            return [{ worker, text: `${worker.label} · 100%` },
                ...(m.power_networks??[]).map(i=>({text:powerNetworkLabel(layout.power.networks[i])}))];
        }
        const jobs = m.jobs ?? (m.crop ? [{ item: m.crop, cycle: m.cycle, load: m.load, crew: m.crew, electric_level: m.electric_level }] : []);
        return jobs.flatMap(job => {
            const row = rows.get(JSON.stringify([m.facility, job.item, job.crew, job.electric_level]));
            const speedFactor=job.electric_level!=null&&m.power_percent>0?120/m.power_percent:1;
            const load = speedFactor*(job.rate != null ? job.rate * job.cycle : (job.load ?? ((row?.busy_units ?? row?.facility_count ?? 0) / (row?.facility_count || 1))));
            const batch = job.cycle > 0 ? translate('{duration} per batch').replace('{duration}', cycleDuration(job.cycle*speedFactor)) : '';
            const suffix = [percent(load), batch].filter(Boolean).join(' · ');
            const item = translate(prettyItem(job.item));
            if (job.electric_level != null) return [{ text: `${item} · ${translate('E-mode')} · ${suffix}` },
                ...(m.power_networks??[]).map(i=>({text:powerNetworkLabel(layout.power.networks[i])}))];
            const captured = owned && job.crew == null ? (plan.roster_routes || []).filter(route =>
                route.facility === m.facility && route.item === job.item && route.jobs.some(([name, share]) => !name && share > 1e-9)) : [];
            if (captured.length) return [...new Map(captured.map(route => [route.member,route])).values()].map(route => {
                const ability = recipeIndex.find(recipe => recipe.name === job.item)?.aniimo?.[0];
                const worker = iconFor(route.member,ability,roster[route.member]?.abilities[ability]);
                return {worker,text:`${item} · ${worker.label} · ${suffix}`};
            });
            const task = row?.aniimo ?? assumed.get(job.crew);
            if (task || job.crew != null) {
                const worker = iconFor(job.crew, task?.ability, task?.level);
                return [{ worker, text: `${item} · ${worker.label} · ${suffix}` }];
            }
            const crops = (recipeIndex.find(recipe => recipe.name === job.item && recipe.facility === m.facility)?.jobs || []);
            const byWorker = new Map();
            for (const [action, ability, level] of crops) {
                const ids = owned ? matchingCropWorkers(ability, level) : new Set();
                const estimate = row?.aniimo_tasks?.find(task => task.ability === ability && task.jobs?.includes(action));
                for (const id of ids.size ? ids : [null]) {
                    const worker = iconFor(id, ability, estimate?.level ?? level);
                    if (!byWorker.has(worker.key)) byWorker.set(worker.key, { worker, actions: new Set() });
                    byWorker.get(worker.key).actions.add(translate(action));
                }
            }
            const pool = [...byWorker.values()].map(({ worker, actions }) => ({
                text: `${worker.label} · ${[...actions].join(', ')}`,
            }));
            return [{ text: `${item} · ${suffix}` }, ...(pool.length ? [{ text: translate('Shared field crew') }, ...pool] : [])];
        });
    });
}

function powerNetworkLabel(network){
    return translate('Grid {n} ({generators}): {percent}% · {draw} / {output} W')
        .replace('{n}',network.id+1).replace('{percent}',formatNumber(network.percent))
        .replace('{generators}',network.generator_ids.map(id=>`G${id}`).join(' + '))
        .replace('{draw}',formatNumber(network.rated)).replace('{output}',formatNumber(network.generated));
}

function layoutWorkerBadges(site, work, electric) {
    const workers = [...new Map(work.filter(line => line.worker).map(({ worker }) => [worker.key, worker])).values()];
    if (!electric && !workers.length) return '';
    const size = Math.min(1.6, site.h * 0.46, site.w * 0.65);
    const width = size * 0.8660254;
    const border = size * 0.05;
    const position = `translate(${site.x + 0.08} ${site.y + site.h - size - 0.08})`;
    const frame = `<use href="#roster-hex-shape" transform="scale(${width} ${size})"`;
    const glyphArt = (glyph, scale, className) => `<svg x="${(width - size * scale) / 2}" y="${size * (1 - scale) / 2}" width="${size * scale}" height="${size * scale}" viewBox="0 0 24 24" class="${className}">${glyph}</svg>`;
    if (electric) return `<g transform="${position}" class="layout-worker-badges layout-emode-badge${site.power_connected ? '' : ' disconnected'}" aria-hidden="true">
        ${frame} class="layout-emode-frame"/>
        ${glyphArt(abilityGlyph('Lightning'), 0.74, 'layout-emode-bolt')}
    </g>`;
    const visible = site.w < 3 ? 1 : 2;
    const advance = width * 0.96;
    const group = workers.slice(0, visible).map(({ portrait, prismana, ability, level }, index) => {
        const fill = portrait ? '#303743' : ABILITY_BY_NAME.get(ability)?.color ?? '#4f5b6c';
        const glyph = abilityGlyph(ability);
        const x = index * advance;
        const innerWidth = width - 2 * border;
        const innerHeight = size - 2 * border;
        const backing = prismana && portrait ? `<use href="#roster-hex-shape" transform="translate(${border} ${border}) scale(${innerWidth} ${innerHeight})" fill="url(#layout-prismana-fill)"/>` : '';
        return `<g transform="translate(${x} 0)">
            ${frame} fill="${prismana && portrait ? 'url(#layout-prismana-border)' : fill}"/>
            ${backing}
            ${portrait ? `<image href="${escapeText(portrait)}" x="${border}" y="${border}" width="${innerWidth}" height="${innerHeight}" preserveAspectRatio="xMidYMid slice" clip-path="url(#roster-hex)" class="layout-worker-icon"/>`
                : glyph ? glyphArt(glyph, 0.66, 'layout-worker-icon')
                : level ? `<text x="${width / 2}" y="${size / 2}" font-size="${size * .55}">${level}</text>` : ''}</g>`;
    });
    const extra = workers.length - visible;
    if (extra > 0) group.push(`<text class="layout-worker-more" x="${visible * advance + size * 0.25}" y="${size * 0.5}" font-size="${size * 0.45}">+${extra}</text>`);
    return `<g transform="${position}" class="layout-worker-badges" aria-hidden="true">${group.join('')}</g>`;
}

function homelandSvg(layout, homeLevel, plan) {
    // Each environment building in use covers the 9x9 square around its center, drawn under
    // everything in its mode's color as on the building's own map.
    const coverage = layout.pieces.flatMap(p => p.members)
        .filter(m => m.building && m.mode)
        .map(m => ({ x: m.x + m.w / 2 - ENVIRONMENT_COVERAGE_RADIUS, y: m.y + m.h / 2 - ENVIRONMENT_COVERAGE_RADIUS, w: ENVIRONMENT_COVERAGE_RADIUS * 2, h: ENVIRONMENT_COVERAGE_RADIUS * 2, mode: m.mode }));
    // The whole homeland, its plots marked out and the ones not open yet shaded.
    const plots = homelandPlots();
    // Zoomed to what's placed, a couple of tiles around it, unless the whole homeland is asked for.
    const groups = layout.groups || [];
    const placed = [...layout.storages, ...layout.pieces.flatMap(p => p.members), ...(layout.power?.poles || []),
        ...groups.flatMap(group => group.reserved)];
    if (!placed.length) return '';
    const whole = layoutShowsWhole;
    const minX = whole ? -1 : Math.floor(Math.min(...placed.map(r => r.x))) - 2;
    const minY = whole ? -1 : Math.floor(Math.min(...placed.map(r => r.y))) - 2;
    const maxX = whole ? Math.max(...plots.map(p => p.x + p.w)) + 1 : Math.ceil(Math.max(...placed.map(r => r.x + r.w))) + 2;
    const maxY = whole ? Math.max(...plots.map(p => p.y + p.h)) + 1 : Math.ceil(Math.max(...placed.map(r => r.y + r.h))) + 2;
    // Locked plots last, so where one meets an open plot, the edge between them reads red.
    const plotShapes = [...plots].sort((a, b) => (b.number <= homeLevel) - (a.number <= homeLevel)).map(p => {
        const open = p.number <= homeLevel;
        // An open plot is named by its number; one still to come by the RV level that opens it.
        return `<g class="layout-plot${open ? '' : ' locked'}"><rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" />
            <text x="${p.x + 0.6}" y="${p.y + 0.9}" font-size="0.9">${open ? 'Plot' : 'RV'} ${p.number}</text></g>`;
    }).join('');
    const lines = [];
    for (let x = minX; x <= maxX; x++) lines.push(`<line x1="${x}" y1="${minY}" x2="${x}" y2="${maxY}" />`);
    for (let y = minY; y <= maxY; y++) lines.push(`<line x1="${minX}" y1="${y}" x2="${maxX}" y2="${y}" />`);
    const maxTrips = Math.max(...layout.pieces.flatMap(p => p.members.map(m => m.weight || 0)), 1e-9);
    const showRecipes = document.getElementById('layout-recipes').checked;
    const showIcons = document.getElementById('layout-icons').checked;
    const showWorkers = document.getElementById('layout-workers').checked;
    const sites = layout.pieces.flatMap(p => p.members);
    const workAtSites = layoutWorkAtSites(plan, sites, layout);
    const shapes = sites.map((m, index) => {
        const color = layoutColor(m);
        const storage = nearestStorage(m, layout.storages);
        const away = storage ? Math.hypot(m.x + m.w / 2 - storage.x - storage.w / 2, m.y + m.h / 2 - storage.y - storage.h / 2) : 0;
        const electric = m.electric_level != null;
        const electricDetail = electric ? ` · ${translate('E-mode')} · ${translate(m.power_connected ? 'Connected to power' : 'No power connection')}` : '';
        const tip = tipAttrs(m.power_generator_id?`${m.facility} · G${m.power_generator_id}`:m.scheduleId?`${m.facility} #${m.scheduleId.split(':').at(-1)}`:m.facility, {
            detail: m.generatorTier ? translate('Building Lv.{level}').replace('{level}', m.generatorTier)
                : m.jobs ? m.jobs.map(j => prettyItem(j.item)).join(', ') : m.crop ? prettyItem(m.crop) : m.building && m.mode ? m.mode : 'Idle',
            stats: [
                m.weight > 0 && storage ? `${formatRate(m.weight)} trips/hour · ${away.toFixed(1)} tiles from storage` : '',
                m.stockLimit ? translate('Local output stock: {n} items').replace('{n}', m.stockLimit) : '',
            ].filter(Boolean).join(' · ') + electricDetail,
            work: [...workAtSites[index].map(line => line.text),...(m.schedulePhases?m.schedulePhases.map((p,i)=>`Period ${i+1}: ${Object.keys(p.rates).map(prettyItem).join(', ')||'Idle'}`):[])].join('\n'),
            color,
        });
        const focus = workAtSites[index].length ? 'tabindex="0" role="group"' : '';
        const workers = electric || showWorkers ? layoutWorkerBadges(m, workAtSites[index], electric) : '';
        const label = pieceLabel(m, showRecipes, showIcons)+(m.power_generator_id
            ? `<text x="${m.x+m.w/2}" y="${m.y+m.h-.1}" font-size=".55" class="layout-number-label">G${m.power_generator_id}</text>`:'');
        // Busier pieces are filled more solidly; idle ones are an outline.
        const fill = m.weight > 0 ? 0.13 + 0.18 * Math.sqrt(m.weight / maxTrips) : 0.07;
        if (m.building) {
            // The footprint and coverage stay colored by climate mode.
            return `<g class="env-building" ${focus} ${tip}><rect x="${m.x + 0.05}" y="${m.y + 0.05}" width="${m.w - 0.1}" height="${m.h - 0.1}" rx="0.3"
                fill="${color}" fill-opacity="${m.mode ? 0.24 : 0.09}" stroke="currentColor" stroke-opacity="0.6" stroke-width="0.08" />
                ${label}${workers}</g>`;
        }
        return `<g class="layout-piece${electric ? ' layout-emode' : ''}${m.generator ? ' layout-generator' : ''}" data-layout-site="${index}" ${focus} ${tip}><rect x="${m.x + 0.04}" y="${m.y + 0.04}" width="${m.w - 0.08}" height="${m.h - 0.08}" rx="0.2"
            fill="${m.generator ? '#f6cd58' : color}" fill-opacity="${m.generator ? 0.18 : fill.toFixed(2)}" stroke="${color}" stroke-width="0.06" />${label}${workers}</g>`;
    }).join('');
    const coverageShapes = coverage.map(c => {
        const tint = ENVIRONMENT_MODE_COLORS[c.mode] || '#9aa0a8';
        const shade = (0.12 * (ENVIRONMENT_MODE_SHADE[c.mode] ?? 1)).toFixed(3);
        return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="${tint}" fill-opacity="${shade}" />`;
    }).join('');
    // Its edge goes over the pieces, so the square reads through whatever stands in it.
    const coverageEdges = coverage.map(c => {
        const tint = ENVIRONMENT_MODE_COLORS[c.mode] || '#9aa0a8';
        return `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" fill="none"
            stroke="${tint}" stroke-opacity="0.8" stroke-dasharray="0.35,0.25" stroke-width="0.08" />`;
    }).join('');
    // A line from everything carried to the Storage Unit, each drawn once its first batch is in,
    // and a ring for the batch it's on (see "Deliveries"), in the same order as `layoutFlows`.
    const flowList = layoutFlows(layout);
    const flows = flowList.map(f => `<line x1="${f.x1}" y1="${f.y1}" x2="${f.x2}" y2="${f.y2}" class="layout-flow-line" />`).join('');
    const rings = flowList.map(f => `<g class="layout-ring" transform="translate(${f.rx.toFixed(2)} ${f.ry.toFixed(2)})">
            <circle r="${f.ring.toFixed(2)}" class="ring-track" /><circle r="${f.ring.toFixed(2)}" class="ring-fill" pathLength="1" stroke-dasharray="0 1" transform="rotate(-90)" /></g>`).join('');
    const storageShapes = layout.storages.map((s, index) => {
        const trips = flowList.filter(flow => flow.storage === index).reduce((sum, flow) => sum + flow.trips, 0);
        return `<g class="layout-piece layout-storage-unit" ${tipAttrs('Storage Unit', { detail: 'Nearest storage for its deliveries', stats: trips > 0 ? `${formatRate(trips)} trips/hour` : '' })}>
            <rect x="${s.x + 0.04}" y="${s.y + 0.04}" width="${s.w - 0.08}" height="${s.h - 0.08}" rx="0.2" class="layout-storage" />
            ${showIcons ? layoutFacilityIcon('Storage Unit', s, 0.10) : ''}
            <text x="${s.x + s.w / 2}" y="${s.y + s.h * (showIcons ? 0.82 : 0.5)}" font-size="${showIcons ? 0.52 : 0.65}" class="layout-number-label">SU${index + 1}</text></g>`;
    }).join('');
    const view = `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
    const power = layout.power;
    const powerZones = (power?.coverage || []).map(r => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" />`).join('');
    const powerLines = (power?.links || []).map(link => `<line x1="${link.from.x}" y1="${link.from.y}" x2="${link.to.x}" y2="${link.to.y}" />`).join('');
    const poleShapes = (power?.poles || []).map((p, i) => `<g class="layout-power-pole" ${tipAttrs('Crackle Power Pole', { detail: `${i + 1} · 7×7` })}>
        <rect x="${p.x + 0.04}" y="${p.y + 0.04}" width="${p.w - 0.08}" height="${p.h - 0.08}" rx="0.2" />
        ${showIcons ? layoutFacilityIcon('Crackle Power Pole', p, 0.10) : ''}
        <text x="${p.x + p.w / 2}" y="${p.y + p.h * (showIcons ? 0.82 : 0.5)}" font-size="${showIcons ? 0.48 : 0.7}" class="layout-number-label">${showIcons ? '' : '⚡'}${i + 1}</text></g>`).join('');
    const rectangle = (r, css) => `<rect class="${css}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" />`;
    const districts = layout.groupStyle === 'districts';
    const groupShapes = groups.map(group => {
        const outline=layout.groupStyle==='groups'&&group.indices?productionGroupOutline(group,layout):null;
        return `<g class="layout-district${districts ? ' layout-district-structured' : ''}" data-purpose="${group.purpose}" data-theme="${resourceZoneTheme(group)}">
        ${outline?`<path class="layout-group-fill" d="${outline.fill}"/><path class="layout-group-edge" d="${outline.edge}"/>`:rectangle(group.bounds, 'layout-district-boundary')}
        ${group.reserved.map(r => rectangle(r, 'layout-decor')).join('')}
        ${group.workshop ? rectangle(group.workshop, 'layout-workshop-zone') : ''}
        ${districts ? rectangle(group.feature, 'layout-district-frontage') : ''}
        </g>`;}).join('');
    const idle = layout.idleArea?.bounds;
    const idleShape = idle ? `<g class="layout-idle-area" pointer-events="none">
        ${rectangle(idle, 'layout-idle-boundary')}
        <text x="${idle.x + .3}" y="${idle.y - .3}" font-size=".65">${escapeText(translate('Unused buildings'))}</text></g>` : '';
    return `<svg class="layout-svg" viewBox="${view}" data-base="${view}" role="group" aria-label="Homeland layout">
        <defs><pattern id="layout-locked" width="1" height="1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="1" class="layout-hatch" /></pattern>
            <pattern id="layout-decor-hatch" width="0.65" height="0.65" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="0.65" class="layout-decor-stripe" />
            </pattern></defs>
        <g class="env-grid">${lines.join('')}</g>
        <g class="layout-plots">${plotShapes}</g>
        <g class="layout-districts" pointer-events="none">${groupShapes}${idleShape}</g>
        <g class="layout-coverage">${coverageShapes}</g>
        <g class="layout-power-zones" pointer-events="none">${powerZones}</g>
        <g class="layout-power-links" pointer-events="none">${powerLines}</g>
        ${shapes}
        <g class="layout-coverage-edges" pointer-events="none">${coverageEdges}</g>
        <g class="layout-rings" pointer-events="none">${rings}</g>
        <g class="layout-flows" pointer-events="none">${flows}<g class="layout-dots"></g></g>
        ${storageShapes}
        ${poleShapes}
    </svg>`;
}

// --- Deliveries ------------------------------------------------------------------------
// The layout plays its homeland out in sped-up game time, from the moment everything is set up.
// Finished batches build up at each facility until the estimated pickup size is reached.
// A recipe starts a batch once the shared warehouse has its ingredients. Each unit
// also keeps to the plan's pace for each recipe it runs, so it doesn't take more than its share
// of what others need; a Bench or Kiln runs its tiers in turn. A ring on each shows its batch,
// amber while it waits for materials. Pickup dots illustrate the route; the warehouse receives
// stock at dispatch in this visualization. Recipes competing for inputs take turns at random.

// Roughly how many real seconds the build-up takes, however long it is in game (at least a
// minute a second, at most an hour); a guess from first batches, not the whole wait.
const SIM_BUILD_UP = 10;
// Tiles a second a delivery walks, in real time.
const SIM_PACE = 1 / haulingTravelSeconds(1);
// Game seconds per step of the simulation.
const SIM_STEP = 2;
// Real seconds between two dots on the same line, at the least.
const SIM_DOT_GAP = 0.12;
let layoutSim = null;

// Each piece carried to the Storage Unit: its line and ring, and its jobs: what it makes, how
// long a batch takes and its pace in the plan (batches a second). Most pieces have one; a Bench
// or Kiln unit has one per tier it takes turns on (see `homelandPieces`).
function layoutFlows(layout) {
    if (!layout.storages.length) return [];
    return layout.pieces.flatMap(p => p.members).filter(m => m.weight > 0 && m.crop && m.cycle > 0).map(m => {
        const x1 = m.x + m.w / 2;
        const y1 = m.y + m.h / 2;
        const s = nearestStorage(m, layout.storages);
        const x2 = s.x + s.w / 2;
        const y2 = s.y + s.h / 2;
        const ring = Math.min(0.45, Math.min(m.w, m.h) * 0.22);
        return {
            x1, y1, x2, y2, storage: layout.storages.indexOf(s), length: Math.hypot(x2 - x1, y2 - y1),
            ring, rx: m.x + m.w - ring - 0.12, ry: m.y + ring + 0.12,
            schedulePhases:m.schedulePhases, trips: m.weight, stockLimit: pickupStockLimit(m), facility: m.facility,
            jobs: (m.jobs || [{ item: m.crop, cycle: m.cycle, rate: (m.batchWeight ?? m.weight) / 3600 }])
                .map(job=>({...job,cycle:job.cycle*(m.electric_level!=null&&m.power_percent>0?120/m.power_percent:1)})),
        };
    });
}

// What a recipe takes and gives, from the recipe list: ingredients with amounts, its item and
// yield (a quick variant makes the regular item), and its byproduct.
function recipeTerms(name) {
    const r = recipeIndex.find(r => r.name === name);
    return {
        takes: (r?.ingredients || []).map((ingredient, i) => [ingredient, r.amounts?.[i] ?? 1]),
        facility_level: r?.facility_level,
        makes: name.replace(/^quick_/, ''),
        yield: r?.yieldAmount || 1,
        byproduct: r?.byproduct ? [r.byproduct, r.byproductAmount || 0] : null,
    };
}

// When an item's first batch could be ready, from the moment everything is set up: a crop's grow
// time, or a recipe's own batch time after its slowest ingredient is first there, as the planner
// works it out (see `item_lead_time` in optimizer.rs). Only sets the simulation's speed.
function firstBatchTimes(flows) {
    const batch = new Map();
    flows.flatMap(f => f.jobs).forEach(j => batch.set(j.item, Math.min(batch.get(j.item) ?? Infinity, j.cycle)));
    const makers = new Map();
    batch.forEach((_, name) => {
        const terms = recipeTerms(name);
        [terms.makes, terms.byproduct?.[0]].filter(Boolean).forEach(item => makers.set(item, [...(makers.get(item) || []), name]));
    });
    const known = new Map();
    const first = (name, depth = 0) => {
        if (depth > 8) return 0;
        if (!known.has(name)) {
            known.set(name, 0);
            const waits = recipeTerms(name).takes
                .map(([ingredient]) => makers.get(ingredient))
                .filter(Boolean)
                .map(list => Math.min(...list.map(m => first(m, depth + 1))));
            known.set(name, Math.max(0, ...waits) + (batch.get(name) || 0));
        }
        return known.get(name);
    };
    return first;
}

function startLayoutSim(svg, flows, stock) {
    stopLayoutSim();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('layout-sim').hidden = !svg || flows.length === 0 || reduce;
    if (!svg || flows.length === 0) return;
    const lines = [...svg.querySelectorAll('.layout-flow-line')];
    const rings = [...svg.querySelectorAll('.layout-ring')];
    if (reduce) {
        lines.forEach(line => line.classList.add('live'));
        rings.forEach(ring => ring.remove());
        return;
    }
    const first = firstBatchTimes(flows);
    const latest = Math.max(...flows.flatMap(f => f.jobs).map(j => first(j.item)));
    const speed = Math.min(3600, Math.max(60, latest / SIM_BUILD_UP));
    const units = flows.map((flow, k) => ({
        flow,
        jobs: flow.jobs.map(job => ({ ...job, terms: recipeTerms(job.item) })),
        line: lines[k], ring: rings[k], fill: rings[k]?.querySelector('.ring-fill'),
    }));
    // Something no piece here makes, and no stock covers, is taken as always there, so a recipe
    // using it isn't held up forever.
    const made = new Set(units.flatMap(u => u.jobs).flatMap(j => [j.terms.makes, j.terms.byproduct?.[0]].filter(Boolean)));
    const sim = { svg, units, speed, stock, made, layer: svg.querySelector('.layout-dots'), dots: [], frame: 0, visible: true };
    layoutSim = sim;
    document.getElementById('layout-clock').title = `Game time since everything was set up, at ${formatNumber(Math.round(speed))}× speed`;
    // Only plays while the diagram is on screen.
    sim.observer = new IntersectionObserver(([entry]) => {
        sim.visible = entry.isIntersecting;
        if (sim.visible && !sim.frame && layoutSim === sim) sim.frame = requestAnimationFrame(now => tickLayoutSim(sim, now));
    });
    sim.observer.observe(svg);
    resetLayoutSim(sim);
}

function resetLayoutSim(sim) {
    sim.game = 0;
    sim.real = 0;
    sim.last = null;
    sim.store = new Map(sim.stock);
    sim.units.forEach(unit => {
        unit.jobs.forEach(job => { job.pace = 1; });
        unit.job = null;
        unit.until = null;
        unit.free = 0;
        unit.lastDot = -Infinity;
        unit.pending = new Map();
        unit.buffered = 0;
        unit.line?.classList.remove('live');
        showRing(unit, 0, false);
    });
    sim.dots.forEach(dot => dot.el.remove());
    sim.dots = [];
    showSimClock(0);
    if (!sim.frame) sim.frame = requestAnimationFrame(now => tickLayoutSim(sim, now));
}

function stopLayoutSim() {
    if (!layoutSim) return;
    cancelAnimationFrame(layoutSim.frame);
    layoutSim.observer?.disconnect();
    layoutSim = null;
}

// Whether the Storage Unit has what `job` needs for a batch.
function simHas(sim, job) {
    return job.terms.takes.every(([item, n]) => !sim.made.has(item) && !sim.stock.has(item) || (sim.store.get(item) || 0) >= n);
}

// Whether `job` is due a batch by its pace. Pace may run a little over one, so a batch noticed at
// the end of a step doesn't lose the time since.
const simDue = job => job.pace >= 1 - 1e-9;

// Starts the first job of `unit` that's due and has its materials, at game time `at`.
function simStart(sim, unit, at) {
    const job = unit.jobs.find(j => (scheduledRate(unit.flow.schedulePhases,j.item,at)??j.rate)>0 && simDue(j) && simHas(sim, j));
    if (!job) return;
    job.terms.takes.forEach(([item, n]) => {
        if (sim.made.has(item) || sim.stock.has(item)) sim.store.set(item, (sim.store.get(item) || 0) - n);
    });
    job.pace -= 1;
    unit.job = job;
    unit.started = at;
    unit.until = at + job.cycle;
}

function stepLayoutSim(sim, dt) {
    const from = sim.game;
    sim.game += dt;
    // Recipes wanting the same thing take turns at random.
    const order = [...sim.units];
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    for (const unit of order) {
        unit.jobs.forEach(job => { const rate=scheduledRate(unit.flow.schedulePhases,job.item,sim.game)??job.rate; job.pace = rate>0?Math.min(1 + rate * SIM_STEP, job.pace + rate * dt):0; });
        // Only full estimated pickup groups leave the facility's local buffer.
        while (unit.until != null && unit.until <= sim.game) {
            const { makes, byproduct, yield: amount } = unit.job.terms;
            unit.pending.set(makes, (unit.pending.get(makes) || 0) + amount);
            if (byproduct) unit.pending.set(byproduct[0], (unit.pending.get(byproduct[0]) || 0) + byproduct[1]);
            unit.buffered++;
            if (unit.buffered >= bufferedBatches({ name: unit.job.item, yieldAmount: amount, byproductAmount: byproduct?.[1] }, unit.flow.stockLimit, unit.flow.facility)) {
                for (const [item, count] of unit.pending) sim.store.set(item, (sim.store.get(item) || 0) + count);
                unit.pending.clear();
                unit.buffered = 0;
                deliver(sim, unit, (sim.game - unit.until) / sim.speed);
            }
            unit.free = unit.until;
            unit.until = null;
            unit.job = null;
            simStart(sim, unit, unit.free);
        }
        if (unit.until == null) simStart(sim, unit, Math.max(from, unit.free));
    }
}

function deliver(sim, unit, age) {
    unit.line?.classList.add('live');
    const walk = unit.flow.length / SIM_PACE;
    // A line busier than the eye can follow shows only some of its dots.
    if (age >= walk || sim.real - age - unit.lastDot < SIM_DOT_GAP) return;
    unit.lastDot = sim.real - age;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('r', '0.2');
    el.setAttribute('class', 'layout-dot');
    sim.layer.appendChild(el);
    sim.dots.push({ el, flow: unit.flow, age });
}

function showRing(unit, progress, waiting) {
    if (!unit.ring) return;
    unit.fill.setAttribute('stroke-dasharray', `${progress.toFixed(3)} 1`);
    unit.ring.classList.toggle('waiting', waiting);
}

function tickLayoutSim(sim, now) {
    sim.frame = 0;
    if (layoutSim !== sim || !sim.svg.isConnected) return;
    // A long gap between frames (a hidden tab) isn't counted as time passing.
    const dt = sim.last == null ? 0 : Math.min(now - sim.last, 100) / 1000;
    sim.last = now;
    const until = sim.game + dt * sim.speed;
    // Animation is illustrative: slow it under load instead of monopolising a frame.
    const frameBudget = performance.now() + 5;
    let steps = 0;
    while (sim.game < until - 1e-9 && steps++ < 32 && performance.now() < frameBudget) {
        stepLayoutSim(sim, Math.min(SIM_STEP, until - sim.game));
    }
    sim.real += dt;
    sim.units.forEach(unit => {
        const busy = unit.until != null;
        showRing(unit, busy ? Math.min(1, (sim.game - unit.started) / unit.job.cycle) : 0, !busy && unit.jobs.some(simDue));
    });
    sim.dots = sim.dots.filter(dot => {
        dot.age += dt;
        const along = (dot.age * SIM_PACE) / dot.flow.length;
        if (along >= 1) {
            dot.el.remove();
            return false;
        }
        dot.el.setAttribute('cx', (dot.flow.x1 + (dot.flow.x2 - dot.flow.x1) * along).toFixed(2));
        dot.el.setAttribute('cy', (dot.flow.y1 + (dot.flow.y2 - dot.flow.y1) * along).toFixed(2));
        return true;
    });
    showSimClock(sim.game);
    if (sim.visible) sim.frame = requestAnimationFrame(t => tickLayoutSim(sim, t));
    else sim.last = null;
}

function showSimClock(seconds) {
    const minutes = Math.floor(seconds / 60);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes / 60) % 24;
    const text = `${days ? `${days}d ` : ''}${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    const clock = document.getElementById('layout-clock');
    if (clock.dataset.sourceText !== text) {
        clock.dataset.sourceText = text;
        clock.textContent = text;
    }
}

// --- Progress card ---------------------------------------------------------------------
// Under the button, every step of working out a plan in the order it runs, each with a spinner
// while it runs and its time once done: the solves in the worker (see `exactPlanJson` in
// worker.js), then the layout and the opportunities.

let progress = null;

function startProgress(input, runId) {
    const priorities = input.priorities || [];
    const seasonFirst = autoMaximizeSeasonPoints(input);
    const planting = input.crop_variety || input.season;
    const season = seasonFirst ? [{ key: 'season', label: `Most ${seasonById(input.season).points}` }] : [];
    const steps = [
        ...(planting ? [{ key: 'crop_variety', label: input.crop_variety ? 'Crop and Tree Variety' : 'Season Crops' }] : []),
        ...priorities.map(target => ({ key: `priority:${target}`, label: target === 'level_up'
            ? priorityLabel(target) : `Most ${priorityLabel(target, planContext.aniipod)}` })),
        ...season,
        { key: 'plan', label: priorities.at(-1) === 'coins'
            ? 'Finish Production Plan' : priorities.length || seasonFirst || planting ? "Home Coins with What's Left" : 'Most Home Coins' },
        ...(input.recipe_switching?.max_buildings?[{key:'recipe_switching',label:'Daily recipe schedule'}]:[]),
        { key: 'layout', label: 'Homeland Layout' },
    ];
    progress = { runId, steps: steps.map(step => ({ ...step, state: 'pending' })) };
    renderProgress();
}

// The worker's solves that make up the card's 'plan' step; it's done once the plan is checked.
const PLAN_SOLVES = ['level_up', 'final', 'materials', 'stock_up', 'check'];

// Moves step `key` on: 'start', 'done', 'skip' or 'fail', with an optional note such as
// "3 of 12", and for a solve, whether HiGHS proved its answer. The backup planner only appears
// if the exact one couldn't run.
function setStep(key, state, detail, proven) {
    if (!progress || progress.runId !== planRunId) return;
    if (PLAN_SOLVES.includes(key)) {
        const plan = progress.steps.find(s => s.key === 'plan');
        if (proven === false) plan.unproven = true;
        if (state === 'start' && plan.state !== 'running') setStep('plan', 'start');
        else if (state === 'done' && key === 'check') setStep('plan', 'done', undefined, !plan.unproven);
        else renderProgress();
        return;
    }
    let step = progress.steps.find(s => s.key === key);
    if (!step && key === 'backup') {
        step = { key, label: 'Backup Planner', state: 'pending' };
        progress.steps.splice(progress.steps.findIndex(s => s.key === 'layout'), 0, step);
    }
    if (!step) return;
    const now = performance.now();
    if (state === 'start') {
        if (step.state !== 'running' || key === 'layout') step.started = now;
        step.state = 'running';
    } else if (state === 'done' || state === 'fail') {
        step.ms = step.started ? now - step.started : null;
        step.state = state;
    } else if (state === 'skip') {
        step.state = 'skipped';
    }
    if (detail !== undefined) step.detail = detail;
    if (proven !== undefined) step.proven = proven;
    renderProgress();
}

// What "proven best" means, shown on hovering it.
const PROVEN_MEANS = 'No plan the model allows does better. Some of its options, such as how plots can be arranged around an environment building, come from a shortlist rather than every possibility.';

// Whether a solve proved its plan the best the model allows, or ran out of time first.
function searchNote(proven) {
    if (proven === undefined) return '';
    return proven
        ? `<span title="${PROVEN_MEANS}">proven best</span>`
        : '<span title="The solver ran out of time before it could prove nothing does better.">best found in time</span>';
}

// Once the plan is back, any solve that never ran (a level-up out of reach skips the last one;
// the backup planner skips them all) is marked skipped.
function finishSolveSteps() {
    if (!progress) return;
    progress.steps
        .filter(s => s.key === 'plan' || s.key.startsWith('priority:'))
        .forEach(s => { if (s.state === 'pending' || s.state === 'running') s.state = 'skipped'; });
    if (progress.steps.some(s => s.key === 'backup')) setStep('backup', 'done');
    renderProgress();
}

function renderProgress() {
    const card = document.getElementById('solve-progress');
    if (!progress) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    const icon = state => ({
        running: '<span class="step-spinner" aria-label="Running"></span>',
        done: '<span class="step-icon done" aria-label="Done">✓</span>',
        fail: '<span class="step-icon fail" aria-label="Failed">✕</span>',
        skipped: '<span class="step-icon skipped" aria-label="Skipped">–</span>',
    }[state] || '<span class="step-icon pending" aria-label="Waiting">•</span>');
    const time = ms => ms == null ? '' : ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
    card.innerHTML = `<ol class="progress-steps">${progress.steps.map(step => {
        const finished = step.state === 'done' || step.state === 'fail';
        const note = [step.detail, finished ? searchNote(step.proven) : '', finished ? time(step.ms) : ''].filter(Boolean).join(' · ');
        return `
        <li class="progress-step ${step.state}">${icon(step.state)}<span class="step-label">${step.label}</span>
            <span class="step-note">${note}</span></li>`;
    }).join('')}</ol>`;
    const running = progress.steps.find(step => step.state === 'running');
    if (running) announcePlanner(running.label);
}

function announcePlanner(message) {
    const status = document.getElementById('planner-status');
    const text = translate(message);
    if (status.textContent !== text) status.textContent = text;
}

function jumpToPlannerSection(id) {
    const section = document.getElementById(id);
    if (!section) return;
    if (id === 'roster-config') {
        openPlannerEditor('team');
        section.hidden = false;
    }
    if (section instanceof HTMLDetailsElement) section.open = true;
    const heading = section.querySelector('h2, summary') || section;
    if (!heading.matches('summary')) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
}

function openPlannerEditor(panel) {
    document.querySelectorAll('[data-planner-editor]').forEach(button => {
        const expanded = button.dataset.plannerEditor === panel;
        button.setAttribute('aria-expanded', String(expanded));
        document.getElementById(button.getAttribute('aria-controls')).hidden = !expanded;
    });
    if (panel === 'team' && selectedSetupTab() === 'custom') document.getElementById('roster-config').open = true;
}

function updateRecipeSwitchingSummary() {
    const settings=recipeSwitchingInput();
    document.getElementById('recipe-switching-summary').textContent=!settings?translate('Off'):
        `${settings.max_buildings} ${settings.max_buildings===1?'building':'buildings'} · ${settings.max_switches} ${settings.max_switches===1?'switch':'switches'}/day`;
}

function attachPlannerEditor() {
    updateRecipeSwitchingSummary();
    for(const id of ['recipe-switching-buildings','recipe-switching-switches']){
        document.getElementById(id).addEventListener('input',updateRecipeSwitchingSummary);
        document.getElementById(id).addEventListener('change',updateRecipeSwitchingSummary);
    }
    document.querySelector('.planner-editor-options').addEventListener('click', event => {
        const button = event.target.closest('[data-planner-editor]');
        if (!button) return;
        openPlannerEditor(button.getAttribute('aria-expanded') === 'true' ? null : button.dataset.plannerEditor);
    });
}

// --- My Aniimo -------------------------------------------------------------------------
// The Aniimo the player actually has, card by card (see `Crew` in models.rs): each card's homeland
// abilities with their levels, its four personalities (one from each pair) and how many are alike.
// The plan shares their hours out, so one level-4 Earth Aniimo covers what it can and no more.

let roster = [];
let rosterSlots = rosterSlotsFor(roster);
let movementDistances = {};
let reactiveDispatch = {};
let movementDefaultDistance = 20;
let travelRefinements = 0;
let haulingSeconds = {};
let haulingDefaultSeconds = 0;
let haulingRefinements = 0;
const haulingBaseByPlan = new WeakMap();
const HAULING_ESTIMATE_HINT = 'Deliveries start at 40% output storage, rounded up to a complete batch. Carrying capacity and travel are included; pickup timing is approximate.';

function refineReactiveDispatch(layout, plan) {
    const { members, busy } = rosterWorkload(plan);
    const permanent = permanentWorkers(plan, members, RESIDENT_FACILITIES);
    const existing = Object.keys(reactiveDispatch).length > 0;
    const context={layout, recipes:recipeIndex, members, busy, permanent, routes:plan.roster_routes || []};
    const policy = buildReactiveDispatch({...context, previous:existing ? reactiveDispatch : null});
    const delivery=measuredDispatchWork(plan,policy,recipeIndex).delivery;
    plan.crop_peaks=selectCropPeakTeam(cropPeakInput({...context,delivery,limit:ANIIMO_MAX[layoutHomeLevel()-1]}));
    if (!existing && Object.keys(policy).length) {
        reactiveDispatch = policy;
        stopRanking();
        // This is the same calculation with measured routes, not a team change.
        // Keep the completed steps/results visible while the final solve runs.
        ensurePlanFor(selectedAniimoSetup(), true);
        return true;
    }
    if(plan.recipe_schedule){
        // The certificate already allocates both production and hauling by phase.
        // A daily-average postpass must not move that hauling to another worker.
        plan.delivery_assignments=[...(plan.hauling_staffing||[])];
        return false;
    }
    const measured = measuredDispatchWork(plan, policy, recipeIndex);
    plan.reactive_dispatch = policy;
    plan.layout_walking = measured.walking;
    plan.delivery_assignments = measured.delivery;
    plan.hauling_busy = measured.delivery.reduce((sum,[,share])=>sum+share,0);
    plan.dedicated_delivery = [];
    plan.job_switching = [];
    return false;
}

function haulingRouteBound(accountForTravel = false) {
    const open = homelandPlots().filter(p => p.number <= layoutHomeLevel());
    return open.length ? haulingWorkSeconds(2 * Math.hypot(
        Math.max(...open.map(p => p.x + p.w)) - Math.min(...open.map(p => p.x)),
        Math.max(...open.map(p => p.y + p.h)) - Math.min(...open.map(p => p.y))), accountForTravel) : 0;
}

function assignLayoutHauling(layout, plan) {
    const setup = selectedSetupTab();
    const accountForTravel = true;
    const bound = haulingRouteBound(accountForTravel);
    const work = haulingWorkload(layout, plan.coin_items || [], bound, recipeIndex, lastPlanInput?.facilities, accountForTravel);
    plan.hauling_estimates = work.seconds;
    plan.hauling_busy = work.busyByLevel[setup === 'minimum' ? 1 : 3];
    if (setup !== 'custom') bestTeamLayouts.set(plan, { layout, hauling: work });
    if (setup !== 'custom') return false;
    if(plan.recipe_schedule){plan.delivery_assignments=[...(plan.hauling_staffing||[])];return false;}
    if (!haulingBaseByPlan.has(plan)) haulingBaseByPlan.set(plan, [...(plan.assumed_aniimo || [])]);
    plan.assumed_aniimo = [...haulingBaseByPlan.get(plan)];
    plan.dedicated_delivery = [];
    const { members, busy, anchored } = rosterWorkload(plan);
    const switching = [];
    plan.job_switching = plan.roster_routes?.length
        ? rosterJobSwitching(buildDispatch(layout, recipeIndex, work, RESIDENT_FACILITIES), plan.roster_routes, members, busy, anchored)
        : [];
    for (const [member, share] of plan.job_switching) {
        switching[member] = share;
        busy[member] += share;
    }
    const growers = new Set((plan.crop_assignments || []).filter(([, , , share]) => share > 1e-9)
        .map(([, , member]) => member));
    const allocation = allocateHauling(members, busy, work, Infinity, anchored, switching, growers);
    if (allocation.unassigned > 1e-6) {
        if (haulingDefaultSeconds >= bound && plan.hauling_staffing?.length) {
            // The final model used a whole-homeland route bound. Its independently checked
            // assignment remains feasible when the fast greedy allocator misses a packing.
            plan.delivery_assignments = plan.hauling_staffing;
            plan.job_switching = [];
            return false;
        }
        // Only a real shortage triggers a solve. A full-map route bound covers every recipe
        // in the next layout as well, avoiding repeated optimization as its positions change.
        haulingRefinements++;
        haulingDefaultSeconds = bound;
        haulingSeconds = {};
        if (haulingRefinements > 1) {
            showError('The planned deliveries could not be assigned. Try adding Storage Units.');
            return true;
        }
        switchAniimoSetup();
        return true;
    }
    plan.delivery_assignments = allocation.assignments;
    plan.dedicated_delivery = allocation.dedicated;
    if (allocation.reserveCount) {
        const member = members.length;
        plan.assumed_aniimo.push([member, 'Hauling', 3, allocation.reserveCount, null]);
        plan.delivery_assignments.push([member, allocation.reserveBusy]);
    }
    return false;
}

function refineWorkerMovement(layout, plan) {
    if (selectedSetupTab() !== 'custom' || !plan.mobile_work?.length) return false;
    if (Array.isArray(layout.incomeWalking)) return false;
    const measured = workerTravelDistances(layout.pieces.flatMap(p => p.members));
    // A shorter measured route is already covered by the model's walking allowance. It
    // must not restart every priority and material solve just to save a few walking seconds.
    if (![...measured].some(([member, distance]) => distance > (movementDistances[member] ?? movementDefaultDistance) + 1e-6)) return false;
    const open = homelandPlots().filter(p => p.number <= layoutHomeLevel());
    const bound = Math.hypot(Math.max(...open.map(p => p.x + p.w)) - Math.min(...open.map(p => p.x)),
        Math.max(...open.map(p => p.y + p.h)) - Math.min(...open.map(p => p.y)));
    // Use the bound for all workers, including reserves a corrected plan may start using.
    // Any next placement fits it, so one correction is sufficient.
    movementDefaultDistance = Math.ceil(Math.max(bound, ...measured.values()) * 10) / 10;
    movementDistances = {};
    travelRefinements++;
    stopRanking();
    switchAniimoSetup();
    return true;
}
let rosterFillVersion = 0;

function newRosterAniimo(abilities = {}, personalities = PERSONALITY_PAIRS.map(() => null)) {
    return { name: '', count: 1, abilities, personalities, family: null };
}

const leisureFamilyName = family => LEISURE_FAMILIES.find(f => f.id === family)?.name || '';

// Facilities whose Aniimo lives there: every Aniimo Materials facility.
const RESIDENT_FACILITIES = new Set(FACILITIES.filter(f => f.category === 'Aniimo Materials').map(f => f.name));

// The roster for the solver (see `JsRoster` in wasm.rs).
function rosterPayload() {
    return {
        dispatch: reactiveDispatch,
        hauling_seconds: haulingSeconds,
        hauling_default_seconds: haulingDefaultSeconds,
        movement_seconds: workerTravelSeconds(movementDefaultDistance),
        movement_by_member: Object.fromEntries(Object.entries(movementDistances).map(([member, distance]) => [member, workerTravelSeconds(distance)])),
        members: roster.map(a => ({ count: a.count, abilities: a.abilities, personalities: a.personalities.filter(Boolean), family: a.family })),
        residents: [...RESIDENT_FACILITIES],
        environment: ENVIRONMENT_BUILDING_ABILITY,
        personalities: Object.fromEntries(FACILITIES.filter(f => f.personality).map(f => [f.name, f.personality])),
    };
}

const escapeText = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// A card's name: what the player called it, else its abilities.
function rosterLabel(aniimo, i) {
    if (aniimo.name?.trim()) return escapeText(aniimo.name.trim());
    const abilities = Object.entries(aniimo.abilities).map(([ability, level]) => `${ability} ${level}`).join(', ');
    return abilities || `Aniimo ${i + 1}`;
}

function tileAbilities(abilities) {
    return Object.entries(abilities).map(([name, level]) => `<span class="roster-skill" style="--ability:${ABILITY_BY_NAME.get(name)?.color ?? 'var(--accent)'}"
        aria-label="${escapeText(translate(name))} ${level}"><svg viewBox="0 0 24 24" aria-hidden="true">${abilityGlyph(name)}</svg>
        <img src="${gameAbilityIcon(name)}" alt="" width="24" height="24" loading="lazy" draggable="false"><b aria-hidden="true">${level}</b></span>`).join('');
}

function portraitTile(member, label, id = rosterCatalogId(member.catalogId, member.name)) {
    const portrait = aniimoPortrait(id);
    const traits = member.personalities?.map(personalityLetter).join('');
    const ability = Object.keys(member.abilities)[0];
    const glyph = abilityGlyph(ability);
    return `<span class="roster-portrait${id?.includes('prismana') ? ' prismana' : ''}${portrait.includes('/UI_PetHead_') ? ' game-head' : ''}">
        <span class="roster-portrait-fill"><span aria-hidden="true">${glyph ? `<svg viewBox="0 0 24 24">${glyph}</svg>` : '◇'}</span>
            ${portrait ? `<img src="${escapeText(portrait)}" alt="" width="96" height="96" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">` : ''}</span>
        <span class="roster-card-tags">${tileAbilities(member.abilities)}</span></span>
        <strong class="roster-tile-name">${escapeText(label)}</strong>${traits ? `<small>${traits}</small>` : ''}`;
}

let openRosterCard = null;
let openRosterSlot = null;
let rosterAddSlot = null;
let rosterMoveFrom = null;
let rosterPicker;
let rosterTileWorkloads = [];

function rosterBoard(slots, tile) {
    const rows = [];
    const seen = new Map();
    for (let i = 0; i < slots.length; i += ROSTER_ROW_SIZE) {
        rows.push(`<div class="roster-slot-row">${Array.from({ length: ROSTER_ROW_SIZE }, (_, offset) => {
            const member = slots[i + offset];
            const copy = seen.get(member) ?? 0;
            if (member != null) seen.set(member, copy + 1);
            return `<div class="roster-slot">${tile(member, i + offset, copy)}</div>`;
        }).join('')}</div>`);
    }
    return rows.join('');
}

function emptyRosterCell(position) {
    return position == null
        ? '<span class="roster-tile roster-empty-tile" aria-hidden="true"><span class="roster-portrait"></span></span>'
        : `<button type="button" class="roster-tile roster-empty-tile" data-roster="browse" data-roster-position="${position}" aria-label="Add Aniimo" aria-haspopup="dialog">
            <span class="roster-portrait" aria-hidden="true"><span class="roster-add-mark"></span></span></button>`;
}

function rosterTileLabel(member, index) {
    return member.name.trim() || Object.entries(member.abilities).map(([name, level]) => `${translate(name)} ${level}`).join(', ') || `Aniimo ${index + 1}`;
}

function refreshRosterTileWorkloads(workloads = []) {
    rosterTileWorkloads = workloads;
    document.querySelectorAll('#roster-editor [data-roster-tile]').forEach(tile => {
        const i = Number(tile.dataset.rosterTile);
        const member = roster[i];
        if (!member) return;
        const work = workloads[i]?.[Number(tile.dataset.rosterCopy)];
        tile.dataset.tip = rosterTileLabel(member, i);
        tile.dataset.tipStats = work ? work.summary : translate('Calculate a plan with My Aniimo to see assignments.');
        tile.dataset.tipDetail = work?.lines.join('\n') ?? '';
        tile.dataset.rosterTasks = JSON.stringify(work?.tasks ?? []);
        tile.classList.toggle('is-assigned', work?.active ?? false);
        tile.setAttribute('aria-description', [tile.dataset.tipStats, tile.dataset.tipDetail].filter(Boolean).join('. '));
    });
    const fields = document.querySelector('#roster-edit-dialog[open] .roster-card-fields');
    if (fields) updateRosterEditorWorkload(fields);
}

function updateRosterEditorWorkload(fields) {
    const member = Number(fields.dataset.rosterCard);
    const copy = rosterSlots.slice(0, openRosterSlot).filter(slot => slot === member).length;
    const work = rosterTileWorkloads[member]?.[copy];
    const workload = fields.querySelector('.roster-edit-workload');
    workload.hidden = !work;
    workload.textContent = work ? [work.summary, ...work.lines].join('\n') : '';
}

function renderRoster() {
    const editor = document.getElementById('roster-editor');
    editor.querySelector('.roster-cards').innerHTML = rosterBoard(rosterSlots, (i, position, copy) => i == null
        ? emptyRosterCell(position)
        : `<button type="button" class="roster-tile" data-roster-tile="${i}" data-roster-position="${position}" data-roster-copy="${copy}" draggable="true" aria-haspopup="dialog">
            ${portraitTile(roster[i], rosterTileLabel(roster[i], i))}</button>`);
    editor.querySelector('[data-roster-move-hint]').hidden = rosterMoveFrom == null;
    editor.querySelector(`[data-roster-position="${rosterMoveFrom}"]`)?.classList.add('is-moving');
    if (openRosterCard != null && roster[openRosterCard]) renderRosterCardFields(openRosterCard);
    document.getElementById('roster-config-count').textContent = String(roster.reduce((total, member) => total + member.count, 0));
    const tab = selectedSetupTab();
    const summary = document.getElementById('planner-team-summary');
    if (tab === 'custom') {
        const count = document.getElementById('roster-config-count').textContent;
        summary.textContent = `${translate('My Aniimo')} (${count})`;
    } else {
        summary.textContent = tab === 'minimum' ? 'Minimum' : 'Best';
    }
    editor.querySelectorAll('[data-roster="from-best"], [data-roster="from-minimum"]').forEach(button => {
        button.disabled = !lastPlanInput;
    });
    rosterPicker?.filter();
    refreshRosterTileWorkloads(rosterTileWorkloads);
}

function rosterBoardChanged(position) {
    saveInputsToStorage();
    renderRoster();
    const plan = plansBySetup[selectedAniimoSetup()];
    if (selectedSetupTab() === 'custom' && plan?.success && !document.getElementById('roster-summary').hidden) renderRosterSummary(plan);
    document.querySelector(`#roster-editor [data-roster-position="${position}"]`)?.focus();
}

function moveRosterCopy(from, to) {
    rosterMoveFrom = null;
    if (swapRosterSlots(rosterSlots, from, to)) rosterBoardChanged(to);
    else renderRoster();
}

function removeRosterCopy(position) {
    const index = rosterSlots[position];
    rosterSlots[position] = null;
    if (--roster[index].count > 0) return;
    roster.splice(index, 1);
    rosterSlots = rosterSlots.map(member => member != null && member > index ? member - 1 : member);
}

function editableRosterCopy() {
    const member = roster[openRosterCard];
    if (member.count === 1) return member;
    member.count--;
    const copy = { ...structuredClone(member), count: 1 };
    openRosterCard = roster.length;
    rosterSlots[openRosterSlot] = openRosterCard;
    roster.push(copy);
    return copy;
}

function renderRosterCardFields(i) {
    const aniimo = roster[i];
    const fields = document.querySelector('#roster-edit-dialog .roster-card-fields');
    fields.dataset.rosterCard = i;
    const abilities = Object.entries(aniimo.abilities).map(([ability, level]) => `
        <div class="roster-ability">
            <span>${abilityTag(ability)}</span>
            <span class="tabs level-picker" role="radiogroup" aria-label="${ability}">${[1, 2, 3, 4].map(l =>
                `<label><input type="radio" name="roster-${i}-${ability}" data-level="${i}|${ability}" value="${l}"${l === level ? ' checked' : ''}> ${l}</label>`).join('')}
            </span>
            <button type="button" class="roster-x" data-drop="${i}|${ability}" aria-label="Remove ${ability}" title="Remove ${ability}">✕</button>
        </div>`).join('');
    const missing = ABILITIES.map(a => a.name).filter(name => !(name in aniimo.abilities));
    const add = missing.length
        ? `<select class="roster-add-ability" data-add="${i}" aria-label="Add an ability"><option value="">+ Ability</option>${missing.map(name => `<option value="${name}">${name}</option>`).join('')}</select>`
        : '';
    const personalities = PERSONALITY_PAIRS.map((pair, p) => `<span class="tabs level-picker roster-pair" role="radiogroup" aria-label="${pair.names.join(' or ')}">${pair.names.map((name, k) =>
        `<label title="${name}"><input type="radio" name="roster-${i}-pair-${p}" data-personality="${i}|${p}" value="${name}"${aniimo.personalities[p] === name ? ' checked' : ''}> ${pair.letters[k]}</label>`).join('')}</span>`).join('');
    fields.innerHTML = `
        <div class="input-field">
            <label for="roster-member-name">Name</label>
            <input id="roster-member-name" type="text" class="roster-name" data-name="${i}" value="${escapeText(aniimo.name)}" placeholder="Aniimo ${i + 1}">
        </div>
        <section class="roster-edit-section" aria-labelledby="roster-abilities-title">
            <div class="roster-edit-section-head">
                <h4 id="roster-abilities-title">Work abilities</h4>
                ${add}
            </div>
            ${abilities ? `<div class="roster-abilities">${abilities}</div>` : ''}
            ${aniimo.abilities.Leisure ? `<div class="input-field roster-family"><label for="roster-family-${i}">Leisure family</label>
                <select id="roster-family-${i}" data-family="${i}"><option value="">Choose a family</option>${LEISURE_FAMILIES.map(f => `<option value="${f.id}"${aniimo.family === f.id ? ' selected' : ''}>${f.name} — ${translate(f.product)}</option>`).join('')}</select>
                ${aniimo.family ? '' : '<p class="hint small">Choose a family to use this Aniimo for Leisure recipes.</p>'}</div>` : ''}
        </section>
        <section class="roster-edit-section" aria-labelledby="roster-personality-title">
            <div class="roster-edit-section-head">
                <h4 id="roster-personality-title">Personality</h4>
                <button type="button" class="skip-add-btn" data-clear-personality="${i}"${aniimo.personalities.some(Boolean) ? '' : ' hidden'}>No personality</button>
            </div>
            <div class="roster-personalities">${personalities}</div>
        </section>
        <p class="roster-edit-workload hint small" hidden></p>
        <div class="roster-actions roster-edit-actions">
            <button type="button" class="skip-add-btn" data-roster="move">Move Aniimo</button>
            <button type="button" class="skip-add-btn" data-roster="duplicate">Add a copy</button>
            <button type="button" class="skip-add-btn roster-remove-btn" data-remove="${openRosterSlot}">Remove this Aniimo</button>
        </div>`;
    updateRosterEditorWorkload(fields);
}

function editRosterCard(position) {
    openRosterSlot = position;
    openRosterCard = rosterSlots[position];
    renderRosterCardFields(openRosterCard);
    document.getElementById('roster-edit-dialog').showModal();
    if (!roster[openRosterCard].name) document.getElementById('roster-member-name').focus();
}

// When the roster can't make a plan: keeps the Aniimo card, and its editor, on screen so the
// player can add to it.
function showRosterShortfall() {
    document.getElementById('error-message').style.display = 'none';
    showSetupOnly();
    const anyAble = roster.some(a => a.count > 0 && Object.keys(a.abilities).length);
    // An empty roster's editor already says to add some.
    document.getElementById('aniimo-collapsed-summary').textContent = anyAble ? 'No plan found with these Aniimo.' : '';
}

// Of the results, only the Aniimo card, emptied of the last plan's team: its setup may be what
// to change.
function showSetupOnly() {
    const content = document.getElementById('results-content');
    content.style.display = 'block';
    content.classList.add('setup-only');
    document.getElementById('aniimo-collapsed-summary').textContent = '';
    document.getElementById('aniimo-summary').innerHTML = '';
    document.getElementById('aniimo-abilities').innerHTML = '';
    document.getElementById('aniimo-count').hidden = true;
}

// Plans again once the player stops changing the roster for a moment, not on every click.
let rosterReplan = null;
function rosterChanged(rerender = true) {
    reactiveDispatch = {};
    refreshRosterTileWorkloads();
    travelRefinements = 0;
    movementDistances = {};
    movementDefaultDistance = 20;
    haulingSeconds = {};
    haulingDefaultSeconds = 0;
    haulingRefinements = 0;
    rosterFillVersion++;
    saveInputsToStorage();
    if (rerender) renderRoster();
    document.getElementById('roster-summary').hidden = true;
    clearTimeout(rosterReplan);
    rosterReplan = setTimeout(switchAniimoSetup, 700);
}

async function fillRosterFrom(setup) {
    if (!lastPlanInput) return;
    const version = ++rosterFillVersion;
    const runId = planRunId;
    const status = document.getElementById('roster-fill-status');
    status.textContent = 'Working out the source team…';
    try {
        const sourceInput = { ...lastPlanInput, ...aniimoInput(setup) };
        const plan = plansBySetup[setup] || JSON.parse(await callWorker('find_plan', JSON.stringify(sourceInput)));
        if (runId !== planRunId || version !== rosterFillVersion) return;
        if (!plan.success) {
            status.textContent = 'No working team to copy from this plan.';
            return;
        }
        const haulingLevel = setup === 'minimum' ? 1 : 3;
        const layout = await sourceTeamLayout(plan, sourceInput, setup.split(':')[0]);
        if (runId !== planRunId || version !== rosterFillVersion) return;
        const accountForTravel = true;
        const hauling = haulingWorkload(layout, plan.coin_items || [], haulingRouteBound(accountForTravel),
            recipeIndex, sourceInput.facilities, accountForTravel);
        const haulingBusy = hauling.busyByLevel[haulingLevel];
        if (setup.startsWith('best:') || setup === 'best' || plan.recipe_schedule) {
            const { shifts } = bestPlanTeam(plan, haulingBusy, layout, hauling);
            if (!shifts.length) {
                status.textContent = 'No working team to copy from this plan.';
                return;
            }
            const cards = new Map();
            for (const shift of shifts) {
                const member = bestRosterMember(shift);
                const key = JSON.stringify(member);
                if (cards.has(key)) cards.get(key).count++;
                else cards.set(key, member);
            }
            plansBySetup[setup] = plan;
            roster = [...cards.values()];
            rosterSlots = rosterSlotsFor(roster);
            rosterChanged();
            return;
        }
        bestTeamLayouts.set(plan, { layout, hauling });
        plan.hauling_busy = haulingBusy;
        const { kept } = aniimoTeam(plan);
        if (!kept.length && haulingBusy <= 1e-6) {
            status.textContent = 'No working team to copy from this plan.';
            return;
        }
        plansBySetup[setup] = plan;
        const cards = new Map();
        kept.forEach(g => {
            const personalities = PERSONALITY_PAIRS.map(pair => pair.names.find(name => g.personalities.has(name)) ?? null);
            if(g.entry){
                const member=bestRosterMember(g),key=JSON.stringify(member);
                if(cards.has(key))cards.get(key).count+=g.count;
                else cards.set(key,{...member,count:g.count});
                return;
            }
            const key = `${g.ability}|${g.level}|${personalities.join()}|${g.family || ''}`;
            if (cards.has(key)) cards.get(key).count += g.count;
            else cards.set(key, { ...newRosterAniimo({ [g.ability]: g.level }, personalities), count: g.count, family: g.family || null });
        });
        roster = [...cards.values()];
        if (haulingBusy > 1e-6) roster.push({ ...newRosterAniimo({ Hauling: haulingLevel }), count: Math.ceil(haulingBusy - 1e-6) });
        rosterSlots = rosterSlotsFor(roster);
        rosterChanged();
    } catch (error) {
        if (runId === planRunId && version === rosterFillVersion) status.textContent = 'No working team to copy from this plan.';
        console.warn('Could not copy the planned Aniimo team:', error);
    }
}

async function sourceTeamLayout(plan, input, setup) {
    const { key, ...options } = layoutOptionsFor(plan, layoutHomeLevel(), setup);
    let layout = layoutsByPlan.get(plan)?.get(key);
    if (!layout) {
        const { pieces } = homelandPieces(plan, input);
        layout = await new Promise((resolve, reject) => {
            const solver = new Worker(WORKER_URL.replace('worker.js', 'layout-worker.js'), { type: 'module' });
            const finish = (error, result) => {
                solver.terminate();
                if (error) reject(error);
                else resolve(result);
            };
            solver.onerror = event => finish(new Error(event.message || 'The layout worker stopped'));
            solver.onmessage = event => finish(null, event.data);
            solver.postMessage({ pieces, ...options });
        });
        rememberLayout(plan, key, layout);
    }
    return layout;
}

function attachRosterHandlers() {
    const editor = document.getElementById('roster-editor');
    document.addEventListener('load', event => {
        if (event.target.matches?.('.roster-portrait-fill img, .roster-skill img')) event.target.classList.add('loaded');
    }, true);
    document.addEventListener('error', event => {
        if (event.target.matches?.('.roster-portrait-fill img, .roster-skill img')) event.target.hidden = true;
    }, true);
    editor.innerHTML = `<div class="roster-editor-layout">
        <div class="roster-tools">
            <div class="input-field"><label for="roster-filter">Filter your team</label>
                <input id="roster-filter" type="search" autocomplete="off" placeholder="Name or ability"></div>
            <div class="roster-actions">
                <button type="button" class="skip-add-btn" data-roster="save-import" hidden>Save this roster</button>
                <button type="button" class="skip-add-btn" data-roster="add-row">Add row</button>
                <button type="button" class="skip-add-btn" data-roster="from-best" disabled>Start from the Best team</button>
                <button type="button" class="skip-add-btn" data-roster="from-minimum" disabled>Start from the Minimum team</button>
            </div>
            <p class="hint small" id="roster-fill-status" role="status"></p>
            <div class="roster-move-hint" data-roster-move-hint hidden>
                <p class="hint small" role="status">Choose a destination slot. Occupied slots swap places.</p>
                <button type="button" class="skip-add-btn" data-roster="cancel-move">Cancel</button>
            </div>
        </div>
        <div class="roster-cards"></div>
    </div>
    <dialog class="roster-dialog" id="roster-picker-dialog" aria-labelledby="roster-picker-title">
        <div class="roster-dialog-head"><h3 id="roster-picker-title">Add Aniimo</h3>
            <button type="button" class="roster-x" data-close-dialog aria-label="Close">✕</button></div>
        <div class="input-field"><label for="roster-catalog-search">Search Aniimo or form</label>
            <input id="roster-catalog-search" type="search" autofocus autocomplete="off"></div>
        <div class="roster-catalog-scroll">
            <div class="roster-catalog-results" id="roster-catalog-results"></div>
            <p data-catalog-empty hidden role="status">No matching Aniimo.</p>
            <button type="button" class="skip-add-btn" data-catalog-more>Load more Aniimo</button>
        </div>
        <div class="roster-dialog-foot"><button type="button" class="skip-add-btn" data-catalog-manual>Add manually</button>
            <small class="hint">Art · <a href="https://aniimo.gg/aniilog/" target="_blank" rel="noreferrer">Beskor Aniilog</a></small></div>
    </dialog>
    <dialog class="roster-dialog roster-edit-dialog" id="roster-edit-dialog" aria-labelledby="roster-edit-title">
        <div class="roster-dialog-head"><h3 id="roster-edit-title">Edit Aniimo</h3>
            <button type="button" class="roster-x" data-close-dialog aria-label="Close">✕</button></div>
        <div class="roster-card-fields"></div>
    </dialog>`;
    rosterPicker = attachRosterPicker(editor, {
        add(entry) {
            const name = rosterFormName(entry);
            const same = roster.findIndex(member => member.name === name && !member.personalities.some(Boolean)
                && member.family === (entry.family ?? null)
                && Object.keys(member.abilities).length === Object.keys(entry.abilities).length
                && Object.entries(entry.abilities).every(([ability, level]) => member.abilities[ability] === level));
            const i = same < 0 ? roster.length : same;
            if (same >= 0) {
                roster[i].catalogId = entry.id;
                roster[i].count++;
            } else {
                roster.push({ ...newRosterAniimo({ ...entry.abilities }), catalogId: entry.id, name, family: entry.family ?? null });
            }
            const position = placeRosterCopy(rosterSlots, i, rosterAddSlot);
            rosterChanged();
            editor.querySelector(`[data-roster-position="${position}"]`).focus();
        },
        manual() {
            roster.push(newRosterAniimo());
            const position = placeRosterCopy(rosterSlots, roster.length - 1, rosterAddSlot);
            rosterChanged();
            editRosterCard(position);
        },
        label: i => [rosterTileLabel(roster[i], i), ...Object.keys(roster[i].abilities).flatMap(ability => [ability, translate(ability)])].join(' '),
        paint: (entry, name) => portraitTile(entry, name, entry.id),
        tr: translate,
    });
    editor.querySelector('#roster-edit-dialog').addEventListener('close', () => {
        const tile = editor.querySelector(`[data-roster-position="${openRosterSlot}"]`);
        openRosterCard = null;
        openRosterSlot = null;
        (tile ?? editor.querySelector('[data-roster="add-row"]')).focus();
    });
    document.getElementById('edit-roster-btn').addEventListener('click', () => jumpToPlannerSection('roster-config'));
    editor.addEventListener('click', (e) => {
        const button = e.target.closest('button');
        if (!button) return;
        const { remove, drop, clearPersonality, roster: action, rosterTile, rosterPosition, closeDialog } = button.dataset;
        if (rosterPosition !== undefined && rosterMoveFrom != null) {
            moveRosterCopy(rosterMoveFrom, Number(rosterPosition));
            return;
        }
        if (closeDialog !== undefined) {
            button.closest('dialog').close();
            return;
        } else if (action === 'browse') {
            hideTip();
            rosterAddSlot = Number(rosterPosition);
            rosterPicker.open();
            return;
        } else if (rosterTile !== undefined) {
            hideTip();
            editRosterCard(Number(rosterPosition));
            return;
        } else if (action === 'add-row') {
            const start = rosterSlots.length;
            rosterSlots.push(...Array(ROSTER_ROW_SIZE).fill(null));
            rosterBoardChanged(start);
            return;
        } else if (action === 'save-import') {
            if (saveInputsToStorage()) {
                editor.querySelector('#roster-fill-status').textContent = 'Your changes are saved in this browser.';
                editor.querySelector('#roster-filter').focus();
            }
            return;
        } else if (action === 'cancel-move') {
            moveRosterCopy(rosterMoveFrom, rosterMoveFrom);
            return;
        } else if (action === 'move') {
            rosterMoveFrom = openRosterSlot;
            button.closest('dialog').close();
            const filter = editor.querySelector('#roster-filter');
            filter.value = '';
            rosterPicker.filter();
            editor.querySelector('[data-roster-move-hint]').hidden = false;
            editor.querySelector(`[data-roster-position="${rosterMoveFrom}"]`).classList.add('is-moving');
            return;
        } else if (action === 'duplicate') {
            roster[openRosterCard].count++;
            placeRosterCopy(rosterSlots, openRosterCard);
        } else if (remove !== undefined) {
            removeRosterCopy(Number(remove));
            openRosterCard = null;
            editor.querySelector('#roster-edit-dialog').close();
        } else if (drop) {
            delete editableRosterCopy().abilities[drop.split('|')[1]];
        } else if (clearPersonality !== undefined) {
            editableRosterCopy().personalities.fill(null);
        } else if (action === 'from-best' || action === 'from-minimum') {
            fillRosterFrom(action === 'from-best' ? bestAniimoSetup() : 'minimum');
            return;
        } else {
            return;
        }
        rosterChanged();
    });
    editor.addEventListener('change', (e) => {
        const { level, personality, add, name, family } = e.target.dataset;
        if (level) {
            editableRosterCopy().abilities[level.split('|')[1]] = Number(e.target.value);
        } else if (personality) {
            editableRosterCopy().personalities[Number(personality.split('|')[1])] = e.target.value;
        } else if (add) {
            if (!e.target.value) return;
            editableRosterCopy().abilities[e.target.value] = 1;
        } else if (family !== undefined) {
            editableRosterCopy().family = e.target.value || null;
        } else if (name !== undefined) {
            const previous = openRosterCard;
            const member = editableRosterCopy();
            const i = openRosterCard;
            member.catalogId = rosterCatalogId(member.catalogId, e.target.value);
            member.name = e.target.value;
            const tile = editor.querySelector(`[data-roster-position="${openRosterSlot}"]`);
            tile.dataset.rosterTile = i;
            tile.dataset.rosterCopy = 0;
            tile.innerHTML = portraitTile(member, rosterTileLabel(member, i));
            if (previous !== i) {
                editor.querySelector('.roster-card-fields').dataset.rosterCard = i;
                const remaining = editor.querySelectorAll(`[data-roster-tile="${previous}"]`);
                remaining.forEach((copy, index) => { copy.dataset.rosterCopy = index; });
                rosterChanged(false);
                rosterPicker.filter();
                return;
            }
            saveInputsToStorage();
            refreshRosterTileWorkloads(rosterTileWorkloads);
            rosterPicker.filter();
            const plan = plansBySetup[selectedAniimoSetup()];
            if (plan?.success) renderRosterSummary(plan);
            return;
        } else {
            return;
        }
        rosterChanged();
    });
    const board = editor.querySelector('.roster-cards');
    let draggedSlot = null;
    const clearDrag = () => {
        draggedSlot = null;
        board.querySelectorAll('.is-drop-target').forEach(tile => tile.classList.remove('is-drop-target'));
    };
    board.addEventListener('dragstart', event => {
        const tile = event.target.closest('[data-roster-tile]');
        if (!tile) return;
        draggedSlot = Number(tile.dataset.rosterPosition);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(draggedSlot));
    });
    board.addEventListener('dragover', event => {
        const tile = event.target.closest('[data-roster-position]');
        if (draggedSlot == null || !tile) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        board.querySelector('.is-drop-target')?.classList.remove('is-drop-target');
        tile.classList.add('is-drop-target');
    });
    board.addEventListener('drop', event => {
        const tile = event.target.closest('[data-roster-position]');
        if (draggedSlot == null || !tile) return;
        event.preventDefault();
        const source = draggedSlot;
        clearDrag();
        moveRosterCopy(source, Number(tile.dataset.rosterPosition));
    });
    board.addEventListener('dragend', clearDrag);
    editor.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || rosterMoveFrom == null) return;
        moveRosterCopy(rosterMoveFrom, rosterMoveFrom);
    });
    const workDialog = document.getElementById('aniimo-work-dialog');
    workDialog.querySelector('button').addEventListener('click', () => workDialog.close());
    document.addEventListener('click', event => {
        const worker = event.target.closest('[data-production-worker]');
        if (worker) {
            event.preventDefault();
            const tiles = productionWorkerTiles(worker);
            if (!tiles.length) return;
            hideTip();
            workDialog.querySelector('h3').textContent = worker.dataset.tip;
            const details = workDialog.querySelector('.roster-work-details');
            details.replaceChildren();
            for (const tile of tiles) {
                const copy = document.createElement('div');
                details.append(copy);
                renderAssignmentDetails(copy, tile);
            }
            workDialog.showModal();
            return;
        }
        const tile = event.target.closest('[data-roster-work]');
        if (!tile) return;
        hideTip();
        workDialog.querySelector('h3').textContent = tile.dataset.tip;
        renderAssignmentDetails(workDialog.querySelector('.roster-work-details'), tile);
        workDialog.showModal();
    });
}

// The Aniimo Team card for a roster plan: how busy each card's Aniimo are and where. A resident
// facility keeps its Aniimo all day; environment buildings too (see `staffing`).
function rosterWorkload(plan) {
    const members = [...roster];
    (plan.assumed_aniimo || []).forEach(([index, ability, level, capacity = 1, family = null]) => {
        members[index] = { count: capacity, abilities: { [ability]: level }, personalities: [], assumed: true, family };
    });
    const busy = members.map(() => 0);
    const walking = members.map(() => 0);
    const anchored = members.map(() => 0);
    (plan.coin_items || []).forEach(step => {
        if (step.crew == null || step.status !== 'producing' || !members[step.crew]) return;
        const resident = RESIDENT_FACILITIES.has(step.facility);
        busy[step.crew] += resident ? step.facility_count : (step.busy_units ?? step.facility_count);
        if (resident) anchored[step.crew] += step.facility_count;
    });
    (plan.staffing || []).forEach(([, member, share]) => {
        if (!members[member]) return;
        busy[member] += share;
        anchored[member] += share;
    });
    (plan.movement_staffing || []).forEach(([member, travel]) => {
        if (!members[member]) return;
        busy[member] += travel;
        walking[member] += travel;
    });
    (plan.workplace_anchors || []).forEach(([member, count]) => {
        if (members[member]) anchored[member] += count;
    });
    for (const [, , member, share] of plan.crop_assignments || []) {
        if (!members[member] || share <= 0) continue;
        busy[member] += share;
    }
    const checked = plan.roster_workload;
    const workload = checked?.length ? members.map((_, i) => checked[i] ?? 0) : busy;
    for (const [member, extra] of plan.layout_walking || []) {
        if (!members[member]) continue;
        workload[member] += extra;
        walking[member] += extra;
    }
    return { members, busy: workload, walking, anchored };
}

function rosterCopyShifts(plan, members, assigned, walking) {
    const fixed = members.map(() => []);
    const posts = members.map(() => []);
    const routes = members.map(() => []);
    const addMobile = (member, label, share) => routes[member]?.push({ jobs: [[label, share]] });
    const walkingLabel = translate('Walking between jobs');
    const detailed = plan.roster_routes?.length > 0;
    for (const step of plan.coin_items || []) {
        if (step.status !== 'producing' || !members[step.crew]) continue;
        const label = `${translate(step.facility)} (${prettyItem(step.item_name)})`;
        if (RESIDENT_FACILITIES.has(step.facility)) {
            fixed[step.crew].push([label, step.facility_count]);
        } else if (!detailed) {
            addMobile(step.crew, label, step.busy_units ?? step.facility_count);
        }
    }
    for (const [building, member, share] of plan.staffing || []) {
        fixed[member]?.push([translate(building), Math.round(share)]);
    }
    for (const [station, member, count] of plan.roster_posts || []) {
        posts[member]?.push([station, Math.round(count)]);
    }
    if (detailed) {
        const visits = members.map(() => 0);
        for (const route of plan.roster_routes) visits[route.member] += route.visits;
        const extraWalking = new Map(plan.layout_walking || []);
        for (const route of plan.roster_routes) {
            const item = prettyItem(route.item);
            const jobs = route.jobs.map(([job, share]) => [
                job ? `${translate(job)} · ${item}` : `${translate(route.facility)} (${item})`, share,
            ]);
            if (route.visits > 0) {
                const extra = (extraWalking.get(route.member) || 0) * route.visits / visits[route.member];
                const entry = plan.reactive_dispatch?.[routeDispatchKey(route, recipeIndex)]?.find(e => e.member === route.member);
                const duration = entry ? entry.travel_seconds * route.visits : Math.max(0, route.walking + extra);
                if (duration > 1e-6) jobs.push([
                    `${walkingLabel} → ${translate(route.facility)} (${item})`, duration,
                ]);
            }
            const key=routeDispatchKey(route,recipeIndex);
            routes[route.member].push({ station: route.station, jobs, localPlots: route.local_plots,
                copyShares:plan.crop_peaks?.copyShares?.[`${key}|${route.member}`] });
        }
    } else {
        for (const [ability, , member, share] of plan.crop_assignments || []) {
            addMobile(member, `${translate('Crop work')} · ${translate(ability)}`, share);
        }
        for (const [member, share] of walking.entries()) {
            if (share > 0) addMobile(member, walkingLabel, share);
        }
    }
    for (const [member, share] of plan.delivery_assignments || plan.hauling_staffing || []) {
        addMobile(member, translate('Hauling to Storage Units'), share);
    }
    for (const [member, share] of plan.job_switching || []) routes[member]?.push({
        spread: true, jobs: [[translate(TASK_SWITCHING), share]],
    });
    const dedicated = new Map(plan.dedicated_delivery || []);
    return members.map((_, member) => {
        const shifts = scheduleRosterCopies(assigned[member], fixed[member], posts[member], routes[member]);
        const hours = dedicated.get(member) || 0;
        if (hours > 1e-6) shifts.push(...scheduleRosterCopies(Math.ceil(hours - 1e-6), [], [],
            [{ jobs: [[translate('Hauling to Storage Units'), hours]] }]));
        if(plan.recipe_schedule){
            const profiles=scheduleProfiles(plan),labels=new Map(),totals=new Map();
            for(const [key,value] of profiles){const [facility,item]=key.split('|'),label=`${translate(facility)} (${prettyItem(item)})`;labels.set(label,value);labels.set(`${walkingLabel} → ${label}`,value);}
            labels.set(translate('Hauling to Storage Units'),plan.recipe_schedule.haulingProfiles?.[member]);
            for(const shift of shifts)for(const [label,busy] of shift.tasks)totals.set(label,(totals.get(label)||0)+busy);
            return splitPhaseTasks([...totals].map(([label,busy])=>({label,busy,profile:labels.get(label),fixed:fixed[member].some(([name])=>name===label)})),plan.recipe_schedule.phases.map(p=>p.duration),assigned[member]);
        }
        return shifts;
    });
}

function renderRosterSummary(plan) {
    const { members, busy, walking, anchored } = rosterWorkload(plan);
    (plan.delivery_assignments || plan.hauling_staffing || []).forEach(([member, share]) => {
        if (!members[member] || share <= 0) return;
        busy[member] += share;
    });
    for (const [member, share] of plan.job_switching || []) busy[member] += share;
    const have = roster.reduce((sum, a) => sum + a.count, 0);
    const regular = busy.map((load, member) => Math.min(members[member].count, Math.max(anchored[member], Math.ceil(load - 1e-6),Math.ceil(Math.max(0,...(plan.recipe_schedule?.workerProfiles?.[member]||[]))-1e-6),plan.crop_peaks?.counts?.[member]||0)));
    const assigned = [...regular];
    for (const [member, share] of plan.dedicated_delivery || []) {
        busy[member] += share;
        assigned[member] += Math.ceil(share - 1e-6);
    }
    const working = assigned.slice(0, roster.length).reduce((sum, n) => sum + n, 0);
    const reserves = assigned.slice(roster.length).reduce((sum, n) => sum + n, 0);
    const workload = share => {
        const percent = share * 100;
        if (percent > 0 && percent < 0.01) return '<0.01%';
        if (percent < 100 - 1e-5 && percent > 99.99) return '99.99%';
        return `${formatNumber(percent)}%`;
    };
    const shifts = rosterCopyShifts(plan, members, regular, walking);
    const unassigned = { active: false, summary: translate('Unassigned'), tasks: [], lines: [] };
    const copyWork = (i, copy) => {
        const shift = shifts[i][copy];
        if (!shift) return unassigned;
        const tasks = [...shift.tasks].sort((a, b) => b[1] - a[1]).map(([job, share]) => [job, workload(share)]);
        if(shift.phaseBusy?.length)tasks.unshift(['Peak during recipe schedule',workload(Math.max(...shift.phaseBusy))]);
        const summary = translate('{load} busy').replace('{load}', workload(shift.busy));
        return { active: true, summary, tasks, lines: tasks.map(([job, share]) => `${job} · ${share}`) };
    };
    refreshRosterTileWorkloads(roster.map((member, i) =>
        Array.from({ length: member.count }, (_, copy) => copyWork(i, copy))
    ));
    const buildTile = (i, _position, copy) => {
        if (i == null) return emptyRosterCell();
        const member = members[i];
        const work = copyWork(i, copy);
        const label = member.assumed ? translate('Assumed Aniimo') : rosterTileLabel(member, i);
        const count = member.assumed ? assigned[i] : member.count;
        let context = count > 1
            ? translate('Copy {copy} of {total} · {assigned} assigned').replace('{copy}', copy + 1)
                .replace('{total}', count).replace('{assigned}', assigned[i])
            : '';
        if(work.active&&copy>=(plan.crop_peaks?.baseCounts?.[i]??Infinity))
            context += `${context?' · ':''}${translate('Crop peak support')}`;
        return assignmentTile(member, label, work.tasks, work.summary, work.active, context, i);
    };
    const additional = members.flatMap((member, i) => member.assumed && assigned[i] > 0 ? Array(assigned[i]).fill(i) : []);
    const summary = document.getElementById('roster-summary');
    const total = working + reserves;
    const cap = ANIIMO_MAX[layoutHomeLevel() - 1];
    const capNote = cap && total > cap ? `<p class="hint small">${translate('This RV level can host {n} Aniimo.').replace('{n}', cap)}</p>` : '';
    summary.innerHTML = `${capNote}${cropPeakNote(plan.crop_peaks, members)}
        <div class="roster-cards">${rosterBoard(rosterSlots, buildTile)}</div>
        ${additional.length ? `<h3 class="roster-additional-title">Additional Aniimo</h3>
            <div class="roster-cards">${rosterBoard(additional, buildTile)}</div>` : ''}`;
    summary.hidden = false;
    const own = translate('{assigned} of {owned} assigned').replace('{assigned}', formatNumber(working)).replace('{owned}', formatNumber(have));
    const extra = translate('{n} assumed').replace('{n}', formatNumber(reserves));
    document.getElementById('aniimo-collapsed-summary').textContent = reserves ? `${own} · ${extra}` : own;
    document.getElementById('aniimo-abilities').innerHTML = '';
    document.getElementById('aniimo-summary').innerHTML = '';
    document.getElementById('aniimo-count').hidden = true;
}

function cropPeakNote(peak, members, generated = false) {
    if (!peak) return '';
    const seconds = generated ? peak.recommendedCompletion : peak.completion;
    const met = generated ? peak.recommendedTargetMet : peak.targetMet;
    const time = Number.isFinite(seconds) ? `${formatNumber(seconds)} s` : 'not covered';
    const additions = !generated && peak.additions.length ? ` Add ${peak.additions.map(({member,count}) => {
        const m=members[member];
        return `${count} x ${escapeText(m.name || Object.entries(m.abilities).map(([a,l])=>`${a} Lv.${l}`).join(' / '))}`;
    }).join(', ')}: ${formatNumber(peak.recommendedCompletion)} s with additions.` : '';
    const shortfall = peak.shortfall?.length ? ` Beyond the RV limit: ${peak.shortfall.map(a=>`${a.count} x ${Object.entries(a.abilities).map(([name,level])=>`${escapeText(name)} Lv.${level}`).join(' / ')}`).join(', ')} would give ${formatNumber(peak.shortfallCompletion)} s${peak.shortfallCompletion > peak.targetSeconds ? "; still above the target" : ""}.` : '';
    return `<p class="hint small">Crop peak: <strong>${time}</strong> average; target &le;${peak.targetSeconds} s.${additions}${!met&&(!additions||!peak.recommendedTargetMet)?' Target not met within the available team/RV limit.':''}${shortfall}<br>Harvest, reclaim and sow; includes approach and ongoing work. Watering uses average demand.</p>`;
}

function assignmentTile(member, label, detail, status, active = true, context = '', memberIndex = null) {
    const tasks = Array.isArray(detail) ? detail : detail.split('\n').filter(Boolean).map(line => [line, '']);
    const tip = tipAttrs(label, {
        detail: tasks.map(([job, share]) => share ? `${job} · ${share}` : job).join('\n'),
        stats: status, work: context,
    });
    return `<button type="button" class="roster-tile${active ? ' is-assigned' : ' is-idle'}" data-roster-work ${memberIndex == null ? '' : `data-work-member="${memberIndex}"`}
        data-roster-tasks="${escapeText(JSON.stringify(tasks))}" ${tip} aria-haspopup="dialog">
        ${portraitTile(member, label)}<small>${escapeText(status)}</small></button>`;
}

function renderAssignmentDetails(container, tile, maxTasks = Infinity) {
    container.replaceChildren();
    const status = document.createElement('strong');
    status.textContent = tile.dataset.tipStats || '';
    container.append(status);
    if (tile.dataset.tipWork) {
        const context = document.createElement('p');
        context.className = 'hint small';
        context.textContent = tile.dataset.tipWork;
        container.append(context);
    }
    const rows = JSON.parse(tile.dataset.rosterTasks || '[]');
    if (!rows.length) return;
    const tasks = document.createElement('ul');
    tasks.className = 'roster-work-tasks';
    for (const [job, load] of rows.slice(0, maxTasks)) {
        const task = document.createElement('li');
        task.textContent = job;
        if (load) {
            const share = document.createElement('b');
            share.textContent = load;
            task.append(share);
        }
        tasks.append(task);
    }
    container.append(tasks);
    if (rows.length > maxTasks) {
        const more = document.createElement('p');
        more.className = 'hint small';
        more.textContent = translate('+{n} more · click for details').replace('{n}', rows.length - maxTasks);
        container.append(more);
    }
}

function setAniimoExpanded(expanded) {
    const toggle = document.getElementById('aniimo-toggle');
    toggle.setAttribute('aria-expanded', String(expanded));
    document.getElementById('aniimo-body').hidden = !expanded;
}

let aniimoExpansionChosen = false;

// --- Season ----------------------------------------------------------------------------
// The limited-time season picked in the selector (see `SEASONS`): on the page from its RV level, or
// always in Advanced mode, where there's no RV level to go by. While it's on, plans may use the
// season's recipes, bar Recipe Notes the player hasn't unlocked, and say how much of the season's
// currency their seeds use. Only running seasons are offered (`RUNNING_SEASONS`): one that has
// ended (`over`) is off the page altogether, so nothing can turn it on, and with none running the
// section is hidden. Its recipes stay in the recipe reference, marked as ended.

// The season picked in the selector (the current one until the player picks another), or `null`
// when no season is running.
function currentSeason() {
    return runningSeason(document.getElementById('season-event').value);
}

// The daily currency budget typed for each season, by season id, as typed (blank for no limit).
// Kept apart so one event's budget is never read as another's: 500 Moonray Wheat isn't 500 Weird
// Jelly Beans.
let seasonBudgets = {};
function renderElectricity() {
    const available = !isSimpleMode() || selectedHomeLevel() >= 12;
    document.getElementById('electricity-section').hidden = !available;
    document.getElementById('electricity-best-minimum-note').hidden = !document.getElementById('electricity-on').checked;
}

function eModeRv(input) {
    if (!document.getElementById('electricity-on').checked) return null;
    const rv = layoutHomeLevel(input);
    return rv >= 12 ? rv : null;
}

function attachElectricityHandlers() {
    document.getElementById('electricity-section').addEventListener('input', () => {
        renderElectricity();
        if (lastPlanInput) clearPlanResults();
    });
}

let seasonCropMinimums = {};
const MAX_SEASON_PLOTS = 2 ** 32 - 1;

function seasonCrops(season) {
    return recipeIndex.filter(r => r.season === season.id && (r.facility === 'Farmland' || r.facility === 'Woodland') && !r.ingredients.length);
}

function activeSeasonCropMinimums() {
    if (!seasonActive()) return {};
    return Object.fromEntries(seasonCrops(currentSeason())
        .map(({ name }) => [name, Number(document.getElementById(`season-minimum-${name}`)?.value || 0)])
        .filter(([, count]) => count > 0));
}

function renderSeasonCropMinimums() {
    const season = currentSeason();
    const crops = season ? seasonCrops(season) : [];
    document.getElementById('season-crop-minimums').hidden = crops.length === 0;
    document.getElementById('season-crop-minimum-fields').innerHTML = crops.map(({ name }) => `
        <div class="input-field">
            <label for="season-minimum-${name}">${prettyItem(name)}</label>
            <input type="number" id="season-minimum-${name}" data-crop="${name}"
                min="0" max="${MAX_SEASON_PLOTS}" step="1" value="${seasonCropMinimums[name] || 0}">
        </div>`).join('');
    renderSeasonSummary();
}

function renderSeasonSummary() {
    const summary = document.getElementById('planner-season-summary');
    const season = currentSeason();
    const button = summary.closest('button');
    button.hidden = !seasonAvailable();
    if (button.hidden && button.getAttribute('aria-expanded') === 'true') openPlannerEditor(null);
    if (!seasonActive()) {
        summary.textContent = 'Off';
        return;
    }
    const counts = seasonCrops(season).map(crop => seasonCropMinimums[crop.name] || 0).filter(Boolean);
    const plots = counts.length ? translate('{plots} plots').replace('{plots}', counts.join(' + ')) : '';
    summary.textContent = [translate(season.name), plots].filter(Boolean).join(' · ');
}

// The picked season's currency a day the player can spend on seeds, or `null` when blank (no limit).
function seasonCurrencyPerDay() {
    const value = String(seasonBudgets[currentSeason()?.id] ?? '').trim();
    return value !== '' && Number(value) >= 0 ? Number(value) : null;
}

function seasonAvailable() {
    const season = currentSeason();
    if (!season) return false;
    return !isSimpleMode() || selectedHomeLevel() >= season.minHomeLevel;
}

function seasonActive() {
    return seasonAvailable() && document.getElementById('season-on').checked;
}

// The id of the season plans may use, or `null` while it's off (see `JsPlanInput::season`).
function activeSeasonId() {
    return seasonActive() ? currentSeason().id : null;
}

// The season the plans on screen were worked out with, for naming their currency and points even
// if the selector has moved on since (see `planContext`).
function planSeason() {
    return seasonById(planContext?.season);
}

function renderSeason() {
    const season = currentSeason();
    document.getElementById('season-section').hidden = !seasonAvailable();
    document.getElementById('season-config').hidden = !seasonActive();
    if (!season) {
        renderSeasonSummary();
        return;
    }
    // A saved pick that has since ended left the selector blank; show the season it fell back to.
    const select = document.getElementById('season-event');
    if (select.value !== season.id) select.value = season.id;
    // The picker only matters with several events running at once.
    document.getElementById('season-event-row').hidden = RUNNING_SEASONS.length < 2;
    document.getElementById('season-title').textContent = season.name;
    document.getElementById('season-hint').textContent = season.hint;
    document.getElementById('season-currency-label').textContent = season.budgetLabel;
    const budget = document.getElementById('season-currency-per-day');
    const typed = String(seasonBudgets[season.id] ?? '');
    if (budget.value !== typed) budget.value = typed;
    renderSeasonCropMinimums();
    document.getElementById('season-notes').innerHTML = season.recipeNotes.map(r => `
        <label class="special-option">
            <input type="checkbox" data-special="${r.name}"${unlockedSpecial.has(r.name) ? ' checked' : ''}>
            <span>${prettyItem(r.name)}</span>
        </label>`).join('');
}

// Fills the season selector with the running seasons, newest first.
function initSeasonSelect() {
    const select = document.getElementById('season-event');
    select.innerHTML = RUNNING_SEASONS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    select.value = currentSeason()?.id ?? '';
}

function attachSeasonHandlers() {
    document.getElementById('season-on').addEventListener('change', renderStrategy);
    // Another season changes its recipes, currency, budget and points, and so the priorities shown.
    // The plan on screen was made for the old one, so it goes rather than be read as the new one's.
    document.getElementById('season-event').addEventListener('change', () => {
        clearPlanResults();
        renderStrategy();
    });
    document.getElementById('season-currency-per-day').addEventListener('input', (e) => {
        const season = currentSeason();
        if (!season) return;
        seasonBudgets[season.id] = e.target.value;
        saveInputsToStorage();
    });
    document.getElementById('season-crop-minimum-fields').addEventListener('input', ({ target }) => {
        const crop = target.dataset.crop;
        if (!crop) return;
        if (lastPlanInput) clearPlanResults();
        if (!target.validity.valid) return;
        const count = Number(target.value);
        if (count) seasonCropMinimums[crop] = count;
        else delete seasonCropMinimums[crop];
        renderSeasonSummary();
        saveInputsToStorage();
    });
    document.getElementById('season-notes').addEventListener('change', (e) => {
        const name = e.target.dataset.special;
        if (!name) return;
        if (e.target.checked) unlockedSpecial.add(name); else unlockedSpecial.delete(name);
        renderRecipeCount();
        saveInputsToStorage();
    });
}

// Every recipe plans may not use: the player's skips and any special recipe not unlocked.
function excludedRecipes() {
    const locked = [...SPECIAL_RECIPES, ...SEASONS.flatMap(s => s.recipeNotes)].map(r => r.name).filter(name => !unlockedSpecial.has(name));
    // Going for Aniipods means the best tier only; the others would be cheaper but catch worse.
    const best = wantsAniipods() ? bestAniipod() : null;
    const lesser = best ? ANIIPOD_TIERS.filter(name => name !== best) : [];
    return [...new Set([...skippedRecipes, ...locked, ...lesser])];
}

// --- Recipes to skip -------------------------------------------------------------------
// Recipes plans may not use (see `JsPlanInput::exclude` in wasm.rs), for things the player can't
// make yet. Saved with the other inputs.

let skippedRecipes = new Set();

// Every recipe as `{ name, facility }`, loaded once for the search box.
let recipeIndex = [];

function recipeLabel(recipe) {
    return `${translate(prettyItem(recipe.name))} (${translate(recipe.facility)})`;
}

function renderRecipeOptions() {
    document.getElementById('skip-options').innerHTML =
        recipeIndex.map(r => `<option value="${escapeText(recipeLabel(r))}"></option>`).join('');
}

document.addEventListener('aniimax-language-change', () => {
    renderImprovements();
    const input = document.getElementById('skip-input');
    const options = document.getElementById('skip-options');
    const selected = Array.from(options.options)
        .findIndex(option => option.value.toLowerCase() === input.value.trim().toLowerCase());
    renderRecipeOptions();
    if (selected >= 0) {
        input.value = options.options[selected].value;
        input.setCustomValidity('');
    }
});

async function loadRecipeIndex() {
    try {
        recipeIndex = JSON.parse(await callWorker('get_all_items'))
            .map(r => ({ name: r.name, facility: r.facility, facility_level:r.facility_level, module_requirement:r.module_requirement,
                workload:r.workload, family:r.family, aniimo: r.aniimo, season: r.season, cost: r.cost || 0, seasonSeedCost: r.season_seed_cost || 0, environment: r.environment || null, jobs: r.jobs || [], job_workloads: r.job_workloads || [], ingredients: r.raw_materials || [], amounts: r.required_amount || [], yieldAmount: r.yield_amount || 1, byproduct: r.byproduct_item || null, byproductAmount: r.byproduct?.[1] || 0, turns: false }))
            .sort((a, b) => a.facility.localeCompare(b.facility) || a.name.localeCompare(b.name));
        renderRecipeOptions();
        renderSkippedRecipes();
        renderSeasonCropMinimums();
    } catch (error) {
        console.warn('Could not load the recipe list:', error);
    }
}

// The Recipes section's badge, e.g. " (2 on, 3 skipped)", so what's set shows while it's closed.
function renderRecipeCount() {
    const parts = [];
    const on = [...unlockedSpecial].filter(name => SPECIAL_NAMES.has(name)
        || (seasonActive() && currentSeason()?.recipeNotes.some(recipe => recipe.name === name))).length;
    if (on) parts.push(translate('{n} on').replace('{n}', on));
    if (skippedRecipes.size) parts.push(translate('{n} skipped').replace('{n}', skippedRecipes.size));
    document.getElementById('recipe-count').textContent = parts.length ? parts.join(' · ') : 'All standard recipes';
}

function renderSkippedRecipes() {
    renderRecipeCount();
    const facilityOf = name => recipeIndex.find(r => r.name === name)?.facility;
    document.getElementById('skip-chips').innerHTML = [...skippedRecipes]
        .sort((a, b) => prettyItem(a).localeCompare(prettyItem(b)))
        .map(name => {
            const facility = facilityOf(name);
            return `<span class="skip-chip">${escapeText(prettyItem(name))}${facility ? ` <span class="skip-chip-facility">${facility}</span>` : ''}<button type="button" data-unskip="${escapeText(name)}" aria-label="Stop skipping ${escapeText(prettyItem(name))}" title="Stop skipping">✕</button></span>`;
        }).join('');
}

function setSkipped(name, skipped) {
    if (skipped) skippedRecipes.add(name); else skippedRecipes.delete(name);
    renderSkippedRecipes();
    saveInputsToStorage();
}

// Adds what's typed in the search box: a full "Item (Facility)" pick, or a unique partial match.
function addSkipFromInput() {
    const input = document.getElementById('skip-input');
    const text = input.value.trim().toLowerCase();
    if (!text) return;
    let match = recipeIndex.find(r => recipeLabel(r).toLowerCase() === text);
    if (!match) {
        const partial = recipeIndex.filter(r => recipeLabel(r).toLowerCase().includes(text));
        if (partial.length === 1) match = partial[0];
    }
    if (!match) {
        input.setCustomValidity(translate('Pick a recipe from the list.'));
        input.reportValidity();
        return;
    }
    input.setCustomValidity('');
    input.value = '';
    setSkipped(match.name, true);
}

function attachSkipHandlers() {
    document.getElementById('skip-add-btn').addEventListener('click', addSkipFromInput);
    const input = document.getElementById('skip-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addSkipFromInput();
        }
    });
    input.addEventListener('input', () => input.setCustomValidity(''));
    document.getElementById('skip-chips').addEventListener('click', (e) => {
        const name = e.target.closest('[data-unskip]')?.dataset.unskip;
        if (name) setSkipped(name, false);
    });
    const cards = document.getElementById('facility-plan-container');
    document.addEventListener('aniimax-language-change', () => {
        if (lastPlan?.success) renderFacilityPlan(lastPlan);
    });
    cards.addEventListener('load', (e) => {
        if (e.target.matches('img')) e.target.classList.add('loaded');
    }, true);
    cards.addEventListener('click', (e) => {
        const name = e.target.closest('[data-skip]')?.dataset.skip;
        if (!name) return;
        setSkipped(name, true);
        runFindPlan();
    });
}

// --- Strategy ----------------------------------------------------------------------------
// "Level up" plans the soonest next RV level-up (its coins plus Wood Blocks and Mineral Sand, or
// from RV 7 a Woodworking Bench item and a Chimney Kiln item, less what's already in stock);
// "Priorities" makes as much of each ticked priority as the ones above it allow.

// What the player has toward a level-up, by item name ('coins' for coins).
let questIncomePerDay = {};

// The highest ability level an Aniimo reaches, and the abilities that stop short of it; mirrors
// `MAX_ANIIMO_LEVEL` and `ABILITY_DEFAULTS` in models.rs.
const MAX_ANIIMO_LEVEL = 4;
// Abilities to assume less of unless the player says otherwise: there is no level-4 Perfumery
// Aniimo in the game yet, so one isn't assumed, but a player who has one can say so.
const ABILITY_DEFAULTS = { Perfumery: 3 };
const defaultLevelFor = ability => ABILITY_DEFAULTS[ability] ?? MAX_ANIIMO_LEVEL;

// Which abilities a level matters for: the ones a facility works with, since a crop's grow time
// is fixed; climate jobs use their own mode-dependent minimum levels. Largest
// first so the list reads in the game's ability order.
function levelledAbilities() {
    const used = new Set(FACILITIES.map(f => f.ability).filter(Boolean));
    return ABILITIES.map(a => a.name).filter(name => used.has(name));
}

// The ability levels the player says they have, for the plan input. An ability left out is taken
// as level 4; the game's own ceiling applies on top (see `max_level_for` in models.rs).
let aniimoLevels = {};

// What to send the solver for `setup`: the per-ability levels, or the player's roster (see
// `aniimo_setup_from` and `JsRoster` in wasm.rs).
function aniimoInput(setup) {
    if (setup.startsWith('roster')) return {
        aniimo: 'roster', roster: rosterPayload(), aniimo_levels: {},
    };
    const levels = {};
    levelledAbilities().forEach(ability => { levels[ability] = bestAniimoLevel(ability); });
    return { aniimo: setup.split(':')[0], aniimo_levels: levels };
}

function bestAniimoLevel(ability) {
    return aniimoLevels[ability] ?? defaultLevelFor(ability);
}


// Which of the three setups is on screen.
function selectedSetupTab() {
    if (document.getElementById('aniimo-minimum')?.checked) return 'minimum';
    if (document.getElementById('aniimo-custom')?.checked) return 'custom';
    return 'best';
}

// A row of level buttons, one picked, in the same segmented style as the tabs above. A level the
// game isn't known to have is marked, and asks before it's taken.
function levelPicker(group, chosen, ability, label) {
    const usual = defaultLevelFor(ability);
    return `<span class="tabs level-picker" role="radiogroup" aria-label="${label}">${[1, 2, 3, 4]
        .map(level => {
            const unheardOf = level > usual;
            const mark = unheardOf ? ` class="unheard-of" title="No level-${level} ${ability} Aniimo is known in the game yet"` : '';
            const confirm = unheardOf ? ` data-confirm="${ability}"` : '';
            return `<label${mark}><input type="radio" name="${group}" value="${level}"${chosen === level ? ' checked' : ''}${confirm}> ${level}</label>`;
        })
        .join('')}</span>`;
}

// Best: the level the player has of each ability a level matters for.
function renderAbilityLevels() {
    const list = document.getElementById('ability-levels');
    if (!list) return;
    list.innerHTML = levelledAbilities().map(ability => {
        return `<div class="ability-level">${abilityTag(ability)}${levelPicker(`level-${ability}`, bestAniimoLevel(ability), ability, `${ability} level`)}</div>`;
    }).join('');
}

// Shows the settings for whichever setup is picked, and works that plan out.
function showAniimoSetup() {
    travelRefinements = 0;
    const tab = selectedSetupTab();
    document.getElementById('ability-level-settings').hidden = tab !== 'best';
    document.getElementById('edit-roster-btn').hidden = tab !== 'custom';
    const rosterConfig = document.getElementById('roster-config');
    rosterConfig.hidden = tab !== 'custom';
    if (tab === 'custom') rosterConfig.open = true;
    const hints = {
        custom: 'The plan shares your Aniimo’s available hours between jobs.',
        minimum: 'Uses the minimum ability level each recipe requires.',
        best: 'Uses the selected ability levels and the preferred personality for each facility.',
    };
    document.getElementById('aniimo-setup-hint').textContent = hints[tab];
    if (tab === 'best') renderAbilityLevels();
    renderRoster();
    switchAniimoSetup();
}

const ITEM_NAMES = {
    coins: 'Home Coins',
    wood_block: 'Wood Blocks',
    mineral_sand: 'Mineral Sand',
    umbral_sweet_and_spicy_sauce: 'Umbral Sweet and Spicy Sauce',
    honey_glazed_pumpkin_cup: 'Honey-Glazed Pumpkin Cup',
    coarse_sifted_ore: 'Coarse-Sifted Ore',
    river_washed_stones: 'River-Washed Stones',
    premium_river_washed_stones: 'Premium River-Washed Stones',
    sugar_roasted_chestnuts: 'Sugar-Roasted Chestnuts',
    flowers_in_a_bottle: 'Flowers in a Bottle',
};

// --- Priorities ------------------------------------------------------------------------
// The plan optimizes each active priority in order, then earns coins with what's left (see
// `JsPlanInput::priorities` in wasm.rs).
const PRIORITY_TARGETS = [
    { id: 'level_up', label: 'Minimum level-up time' },
    { id: 'coins', label: 'Home Coins' },
    { id: 'aniimo_exp', label: 'Aniimo EXP' },
    { id: 'aniipods', label: 'Aniipods' },
    { id: 'Wood Blocks', label: 'Wood Blocks' },
    { id: 'Mineral Sand', label: 'Mineral Sand' },
    // The running season's points, named for whichever season is picked.
    { id: 'season_points', get label() { return currentSeason()?.points ?? 'Season Points'; }, season: true },
];

// Drawn arrows rather than the ↑/↓ characters, which some systems render as colored emoji.
const ARROW_UP = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2.5 L10 7 H2 Z" fill="currentColor"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 9.5 L10 5 H2 Z" fill="currentColor"/></svg>';

function defaultPriorities() {
    return PRIORITY_TARGETS.map(t => ({ target: t.id, on: t.id === 'level_up' || t.id === 'coins' }));
}

let priorityOrder = defaultPriorities();

function wantsCropVariety() {
    return document.getElementById('crop-variety').checked;
}

// The priorities on the page: season points only while the season is on.
function shownPriorities() {
    const season = seasonActive();
    return priorityOrder.filter(p => season || !PRIORITY_TARGETS.find(t => t.id === p.target)?.season);
}

function activePriorities() {
    return shownPriorities().filter(p => p.on).map(p => p.target);
}

function wantsAniipods() {
    return activePriorities().includes('aniipods');
}

// A priority's name, with the Aniipod tier the plan would make.
function priorityLabel(target, aniipod = bestAniipod()) {
    if (target === 'aniipods') return aniipod ? prettyItem(aniipod) : 'Aniipods';
    return PRIORITY_TARGETS.find(t => t.id === target)?.label || CURRENCY_LABELS[target] || target;
}

function renderPriorities() {
    const best = bestAniipod();
    const shown = shownPriorities();
    const active = shown.filter(p => p.on);
    const inactive = shown.filter(p => !p.on);
    document.getElementById('add-priority').innerHTML = '<option value="">+ Add priority</option>'
        + inactive.map(p => `<option value="${escapeText(p.target)}">${escapeText(priorityLabel(p.target, best))}</option>`).join('');
    document.getElementById('add-priority').disabled = !inactive.length;
    document.getElementById('priority-list').innerHTML = active.map((p, at) => {
        // Indices into `priorityOrder`, which also holds any priority that isn't shown.
        const i = priorityOrder.indexOf(p);
        const above = at > 0 ? priorityOrder.indexOf(active[at - 1]) : -1;
        const below = at < active.length - 1 ? priorityOrder.indexOf(active[at + 1]) : -1;
        const label = escapeText(priorityLabel(p.target, best));
        const note = p.target === 'aniipods' && !best ? ' <span class="hint small">(no Aniipod Maker yet)</span>' : '';
        return `
        <li class="priority" draggable="true" data-index="${i}">
            <span class="drag-handle" aria-hidden="true">⋮⋮</span>
            <span class="priority-rank" aria-hidden="true">${at + 1}</span>
            <span class="priority-name">${label}${note}</span>
            <span class="priority-move">
                <button type="button" data-move="${i}" data-to="${above}" data-by="-1" aria-label="Move ${label} up"${above < 0 ? ' disabled' : ''}>${ARROW_UP}</button>
                <button type="button" data-move="${i}" data-to="${below}" data-by="1" aria-label="Move ${label} down"${below < 0 ? ' disabled' : ''}>${ARROW_DOWN}</button>
                <button type="button" data-remove-priority="${i}" aria-label="${escapeText(translate('Remove {name}').replace('{name}', priorityLabel(p.target, best)))}">×</button>
            </span>
        </li>`;
    }).join('');
}

function movePriority(from, to) {
    if (to < 0 || to >= priorityOrder.length || from === to) return;
    const [moved] = priorityOrder.splice(from, 1);
    priorityOrder.splice(to, 0, moved);
    renderPriorities();
    saveInputsToStorage();
}

function attachPriorityHandlers() {
    const list = document.getElementById('priority-list');
    const add = document.getElementById('add-priority');
    add.addEventListener('change', () => {
        const from = priorityOrder.findIndex(p => p.target === add.value && !p.on);
        if (from < 0) return;
        const [priority] = priorityOrder.splice(from, 1);
        priority.on = true;
        priorityOrder.push(priority);
        renderPriorities();
        saveInputsToStorage();
    });
    list.addEventListener('click', (e) => {
        const remove = e.target.closest('[data-remove-priority]');
        if (remove) {
            priorityOrder[Number(remove.dataset.removePriority)].on = false;
            renderPriorities();
            saveInputsToStorage();
            add.focus();
            return;
        }
        const button = e.target.closest('[data-move]');
        if (!button) return;
        const to = Number(button.dataset.to);
        movePriority(Number(button.dataset.move), to);
        const row = list.querySelector(`li[data-index="${to}"]`);
        (row?.querySelector(`[data-by="${button.dataset.by}"]:enabled`) ?? row?.querySelector('button:enabled'))?.focus();
    });
    let dragFrom = null;
    list.addEventListener('dragstart', (e) => {
        const item = e.target.closest('li[data-index]');
        if (!item) return;
        dragFrom = Number(item.dataset.index);
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(dragFrom));
    });
    list.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        const over = e.target.closest('li[data-index]');
        list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        if (over) over.classList.add('drop-target');
    });
    list.addEventListener('drop', (e) => {
        e.preventDefault();
        const over = e.target.closest('li[data-index]');
        if (dragFrom !== null && over) movePriority(dragFrom, Number(over.dataset.index));
        dragFrom = null;
    });
    list.addEventListener('dragend', () => {
        dragFrom = null;
        renderPriorities();
    });
}

// The best Aniipod the owned Aniipod Maker can make, or null without one. A better Aniipod
// catches better, so the strategy makes only this one.
function bestAniipod() {
    const tiers = isSimpleMode()
        ? simpleSetup(selectedHomeLevel()).facilities['Aniipod Maker']
        : facilityTiers['Aniipod Maker'];
    const level = Math.max(0, ...(tiers || []).filter(t => t.count > 0).map(t => t.level));
    return level > 0 ? ANIIPOD_TIERS[Math.min(level, ANIIPOD_TIERS.length) - 1] : null;
}

// The RV level being worked toward: the next one in simple mode, the picked one in advanced.
function levelUpTarget() {
    const target = document.getElementById('level-up-target').value;
    if (customBuildings && target) return Number(target);
    const rv = document.getElementById('home-level').value;
    return (rv ? Number(rv) : layoutHomeLevel(null)) + 1;
}

// The target's cost, or null if it isn't known.
function levelUpCost() {
    return LEVEL_UP_COSTS[levelUpTarget()] || null;
}

// Why the level-up can't be planned, or null if it can.
function levelUpUnavailable() {
    const target = levelUpTarget();
    if (target > MAX_HOME_LEVEL) return `RV ${MAX_HOME_LEVEL} is the top level, so there's no level-up to plan.`;
    if (!LEVEL_UP_COSTS[target]) return `There's no level-up cost for RV ${target}.`;
    return null;
}

function renderQuestIncome(updateInput=true) {
    const income=questIncome(questIncomePerDay),names=Object.keys(income);
    if(updateInput)for(const name of ['wood_block','mineral_sand'])document.getElementById(`quest-${name}`).value=income[name]??0;
    const summary=income.wood_block&&income.mineral_sand
        ?translate('{wood} wood and {sand} sand/day')
        :income.wood_block?translate('{wood} wood/day'):translate('{sand} sand/day');
    document.getElementById('quest-income-summary').textContent=names.length
        ?summary.replace('{wood}',income.wood_block??0).replace('{sand}',income.mineral_sand??0)
        :translate('Off');
}

function populateLevelUpTargets() {
    const select = document.getElementById('level-up-target');
    select.innerHTML = '<option value="">Next RV</option>'
        + Object.keys(LEVEL_UP_COSTS).map(level => `<option value="${level}">${level}</option>`).join('');
}

function renderStrategy() {
    renderSeason();
    renderElectricity();
    document.getElementById('crop-variety-config').hidden = !wantsCropVariety();
    renderPriorities();
    renderRecipeCount();

    // Simple mode always plans the next RV level, so only Advanced picks one.
    document.getElementById('level-up-target-row').style.display = isSimpleMode() ? 'none' : '';

    renderQuestIncome();
}

function attachStrategyHandlers() {
    document.getElementById('crop-variety').addEventListener('change', renderStrategy);
    document.getElementById('level-up-target').addEventListener('change', () => {
        if (lastPlanInput) clearPlanResults();
        renderStrategy();
    });
    for(const name of ['wood_block','mineral_sand']){
    const amount=document.getElementById(`quest-${name}`);
    amount.addEventListener('input', (e) => {
        questIncomePerDay[name]=e.target.value;
        renderQuestIncome(false);
        if (lastPlanInput) clearPlanResults();
        saveInputsToStorage();
    });
    amount.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && e.target.matches('input')) runFindPlan();
    });
    }
}

// The RV target used by the level-up priority and the results preview.
function levelUpInput() {
    if (levelUpUnavailable()) return null;
    const cost = levelUpCost();
    return {
        cost: [['coins', cost.coins], ...cost.items],
        stock: [],
    };
}

// A per-second rate as a per-hour figure, with a decimal when it's small.
function perHour(perSecond) {
    const hourly = perSecond * 3600;
    return hourly < 10 ? hourly.toFixed(1) : formatNumber(Math.round(hourly));
}

// "2d 4h", "5h 12m", "12m": how long until a level-up is covered.
function formatDuration(seconds) {
    const minutes = Math.ceil(seconds / 60);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

// What the plans on screen were asked for, so they're described against the right target even
// after the inputs change.
let planContext = null;

// Show one row per upgrade cost, using the production rates of this plan.
function renderLevelUp(plan) {
    const card = document.getElementById('level-up-card');
    const select = document.getElementById('rate-unit');
    const context = planContext;
    const metric = document.getElementById('level-up-metric');
    card.hidden = metric.hidden = !context || Boolean(context.unavailable);
    if (card.hidden) return;
    const bottleneck = document.getElementById('level-up-bottleneck');
    bottleneck.hidden = true;
    const time = document.getElementById('level-up-time');
    const lines = document.getElementById('level-up-lines');
    document.getElementById('level-up-label').textContent = `RV ${context.target} level-up`;
    document.getElementById('level-up-summary').textContent = `RV ${context.target} costs`;
    const report = plan.level_up_preview;
    if (context.ready) {
        time.textContent = 'Ready now';
        lines.innerHTML = '<p class="level-up-note">You already have everything it costs.</p>';
        return;
    }
    if (!report) {
        const why = plan.level_up_note === 'unreachable'
            ? `These facilities can't make everything it costs.`
            : `The level-up couldn't be planned.`;
        time.textContent = '-';
        lines.innerHTML = `<p class="level-up-note">${why}</p>`;
        return;
    }
    time.textContent = report.seconds == null ? 'Not reached with this plan' : `in ${formatDuration(report.seconds)}`;
    const { multiplier } = RATE_UNIT_SECONDS[select.value] || RATE_UNIT_SECONDS.second;
    const unitLabel = select.selectedOptions[0].textContent;
    const perUnit = perSecond => formatRate(perSecond * multiplier);
    const slowest = Math.max(...report.requirements.map(r => r.seconds ?? Infinity));
    const bottlenecks = report.requirements.filter(r => slowest > 0 && (r.seconds ?? Infinity) >= slowest * (1 - 1e-6));
    if (bottlenecks.length) {
        const items = bottlenecks.map(r => translate(ITEM_NAMES[r.name] || prettyItem(r.name))).join(', ');
        bottleneck.textContent = translate('Finishes last: {items}').replace('{items}', items);
        bottleneck.hidden = false;
    }
    const rows = report.requirements.map(r => {
        const ready = r.seconds === null ? 'never' : r.seconds === 0 ? 'have it' : formatDuration(r.seconds);
        const isSlowest = bottlenecks.includes(r);
        return `<tr${isSlowest ? ' class="slowest"' : ''}>
            <td data-label="Cost">${ITEM_NAMES[r.name] || prettyItem(r.name)}</td>
            <td data-label="Need">${formatNumber(r.need)}</td>
            <td data-label="Have">${formatNumber(r.have)}</td>
            <td data-label="${escapeText(unitLabel)}">${perUnit(r.per_second)}</td>
            <td data-label="Ready in">${ready}</td>
        </tr>`;
    }).join('');
    // What's left over once everything is ready and paid for: costs that finish early keep coming
    // in while the slowest one finishes.
    const surplus = report.seconds == null ? [] : report.requirements
        .map(r => ({ name: r.name, spare: Math.floor(r.have + r.per_second * report.seconds - r.need) }))
        .concat((report.leftovers || []).map(([name, amount]) => ({ name, spare: Math.floor(amount) })))
        .filter(r => r.spare >= 1)
        .map(r => `${formatNumber(r.spare)} ${r.name === 'coins' ? 'Home Coins' : ITEM_NAMES[r.name] || prettyItem(r.name)}`);
    const coinsNote = surplus.length
        ? `<p class="level-up-coins"><span>Surplus:</span> <strong>${surplus.join(', ')}</strong></p>`
        : '';
    lines.innerHTML = `
        <table class="level-up-lines">
            <thead><tr><th>Cost</th><th>Need</th><th>Have</th><th>${escapeText(unitLabel)}</th><th>Ready in</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        ${coinsNote}`;
}

// A seed per planting of each Farmland and Woodland crop, and what it costs.
function renderSeedTable(plan) {
    const card = document.getElementById('seed-card');
    const metric = document.getElementById('seed-cost-metric');
    const el = document.getElementById('seed-table');
    const unit = document.getElementById('rate-unit');
    const multiplier = (RATE_UNIT_SECONDS[unit.value] || RATE_UNIT_SECONDS.second).multiplier;
    const rows = (plan.coin_items || [])
        .filter(s => (s.facility === 'Farmland' || s.facility === 'Woodland') && s.status === 'producing' && s.cycle_time > 0)
        .map(s => {
            const perSecond = (s.busy_units ?? s.facility_count) / s.cycle_time;
            const recipe = recipeIndex.find(r => r.name === s.item_name);
            const cost = recipe?.cost || 0;
            const seeds = perSecond * multiplier;
            const wheat = seeds * (recipe?.seasonSeedCost || 0);
            return { name: s.item_name, facility: s.facility, plots: s.facility_count, seeds, cost: seeds * cost, wheat };
        })
        .sort((a, b) => b.seeds - a.seeds);
    card.hidden = metric.hidden = !rows.length;
    if (card.hidden) return;
    const amount = formatRate;
    const totalCost = rows.reduce((sum, r) => sum + r.cost, 0);
    const totalWheat = rows.reduce((sum, r) => sum + r.wheat, 0);
    const currency = totalWheat > 0 ? planSeason().currency : '';
    const costs = [
        totalCost > 0 ? [totalCost, 'Home Coins'] : null,
        totalWheat > 0 ? [totalWheat, currency] : null,
    ].filter(Boolean);
    const [first, second] = costs;
    const extra = document.getElementById('seed-cost-extra');
    const price = ([value, name]) => `${amount(value)} ${translate(name)}`;
    document.getElementById('seed-cost-period').textContent = unit.selectedOptions[0].textContent;
    document.getElementById('seed-cost-value').textContent = first ? amount(first[0]) : 'free';
    extra.hidden = !first;
    extra.textContent = first ? translate(first[1]) + (second ? ` + ${price(second)}` : '') : '';
    el.innerHTML = `
        <table>
            <thead><tr><th>Crop</th><th>Plots</th><th>Seeds</th><th>Cost</th></tr></thead>
            <tbody>${rows.map(r => `<tr>
                <td>${prettyItem(r.name)}</td>
                <td>${r.plots}</td>
                <td>${amount(r.seeds)}</td>
                <td>${r.wheat > 0 ? `${amount(r.wheat)} <span class="seed-cost-currency">${currency}</span>`
                    : r.cost > 0 ? `${amount(r.cost)} <span class="seed-cost-currency">Home Coins</span>` : 'free'}</td>
            </tr>`).join('')}</tbody>
            ${costs.length ? `<tfoot><tr><th scope="row" colspan="2">Total</th><td colspan="2">${costs.map(cost => `<span>${price(cost)}</span>`).join(' + ')}</td></tr></tfoot>` : ''}
        </table>`;
}

// What each product sold earns in a level-up plan, per hour and by the time the level-up is
// ready. (Priorities plans show this in the goal card instead.)
function renderProfitBreakdown(plan) {
    const card = document.getElementById('profit-card');
    const report = plan.level_up;
    const streams = (plan.income_streams || []).filter(s => s.units_per_second > 0);
    if (!report || streams.length === 0) {
        card.style.display = 'none';
        return;
    }
    card.style.display = 'block';
    const total = streams.reduce((sum, s) => sum + s.rate_per_second, 0);
    const rows = [...streams]
        .sort((a, b) => b.rate_per_second - a.rate_per_second)
        .map(s => `<tr>
            <td data-label="Product">${prettyItem(s.item_name)}</td>
            <td data-label="Facility">${s.facility}</td>
            <td data-label="Sold per hour">${perHour(s.units_per_second)}</td>
            <td data-label="Profit per hour">${formatNumber(Math.round(s.rate_per_second * 3600))}</td>
            <td data-label="Share">${total > 0 ? Math.round(s.rate_per_second / total * 100) : 0}%</td>
            <td data-label="Profit until RV ${planContext?.target}">${formatNumber(Math.floor(s.rate_per_second * report.seconds))}</td>
        </tr>`).join('');
    document.getElementById('profit-breakdown').innerHTML = `
        <div class="table-wrapper">
            <table class="facility-plan-table">
                <thead><tr><th>Product</th><th>Facility</th><th>Sold per hour</th><th>Profit per hour</th><th>Share</th><th>Profit until RV ${planContext?.target}</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// Get plan-level input values from the form (facilities/modules/prioritize-byproducts, nothing
// goal-related, since find_plan doesn't need a target). Currency is always coins: the full
// release removed Bud Tickets, the only other sellable currency.
function buildingInventory() {
    // `facilityTiers` is the live source of truth for owned counts (kept in sync with the DOM by
    // `attachFacilityTierHandlers`), sent straight through as a list of tiers per facility; see
    // `JsPlanInput::facilities` in wasm.rs for the shape (`[{count, level}, ...]` per facility).
    if (isSimpleMode()) {
        return simpleSetup(selectedHomeLevel());
    }

    const facilities = {};
    FACILITIES.forEach(f => {
        facilities[f.name] = facilityTiers[f.name].map(t => ({
            count: t.count,
            level: f.hasLevels === false ? 1 : t.level
        }));
    });

    const modules = {
        ecological_module: numberOrDefault(document.getElementById('ecological-module-level').value, 0),
        kitchen_module: numberOrDefault(document.getElementById('kitchen-module-level').value, 0),
        resource_detector: numberOrDefault(document.getElementById('resource-detector-level').value, 0),
        crafting_module: numberOrDefault(document.getElementById('crafting-module-level').value, 0)
    };
    return { facilities, modules };
}

function recipeSwitchingInput() {
    const count=id=>{const n=Number(document.getElementById(id)?.value);return Number.isFinite(n)?Math.max(0,Math.floor(n)):0;};
    const max_buildings=count('recipe-switching-buildings');
    return max_buildings?{max_buildings,max_switches:count('recipe-switching-switches')}:undefined;
}
function getPlanInputValues() {
    const { facilities, modules } = buildingInventory();
    return {
        currency: 'coins',
        recipe_switching: recipeSwitchingInput(),
        priorities: activePriorities(),
        prioritize_byproducts: false,
        level_up_preview: levelUpInput(),
        quest_income_per_day: questIncome(questIncomePerDay),
        crop_variety: wantsCropVariety(),
        exclude: excludedRecipes(),
        season: activeSeasonId(),
        season_currency_per_day: seasonCurrencyPerDay(),
        season_crop_minimums: activeSeasonCropMinimums(),
        e_mode_rv: eModeRv({ facilities, modules }),
        facilities,
        modules
    };
}

// parseInt/parseFloat that fall back to `fallback` only when the input doesn't parse to a number
// at all (blank/invalid); unlike `value || fallback`, these correctly keep a legitimate 0 (e.g.
// "I own zero of this facility"), which `||` would silently discard since 0 is falsy in JS.
// "quick_aromathyst" -> "Quick Aromathyst": the data uses snake_case names.
function prettyItem(name) {
    if (!name) return name;
    if (ITEM_NAMES[name]) return ITEM_NAMES[name];
    return name.split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
}

// A plan row's reason with its item names made readable: "Used for dried_strawberries, jam; the
// rest sells directly" -> "Used for Dried Strawberries, Jam; the rest sells directly".
function prettyReason(reason) {
    if (!reason) return reason;
    const names = list => list.split(', ').map(prettyItem).join(', ');
    return reason
        .replace(/^Used for ([^;]+)/, (_, list) => 'Used for ' + names(list))
        .replace(/takes turns with ([^;]+)$/, (_, list) => 'takes turns with ' + names(list));
}

// Keys ("Facility|item") of the shown plan's rows that rely on recipes not yet checked in game;
// set by `displayPlan` so the facility tables can tag those rows.
let unverifiedRowKeys = new Set();

function numberOrDefault(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

function floatOrDefault(value, fallback) {
    const parsed = parseFloat(value);
    return Number.isNaN(parsed) ? fallback : parsed;
}

// Format number with commas
function formatNumber(num) {
    return num.toLocaleString(currentLocale(), { maximumFractionDigits: 2 });
}

// A rate at the chosen unit: a whole number once it's big enough to read that way, otherwise two
// significant figures, so a slow trickle doesn't round away to zero.
function formatRate(n) {
    return n >= 10 ? formatNumber(Math.round(n)) : String(Number(n.toPrecision(2)));
}

// Show an error in the results section (plan-level failures only; goal-level failures are rare
// and shown inline in the goal section instead, since the plan above it is still valid).
function showError(message) {
    const errorEl = document.getElementById('error-message');
    const resultsContent = document.getElementById('results-content');
    const resultsSection = document.getElementById('results-section');

    errorEl.textContent = message;
    errorEl.style.display = 'block';
    resultsContent.style.display = 'none';
    resultsSection.style.display = 'block';
}

// The goal card's choices: coins and every priority that's on, in the player's order. Keeps the
// current choice when the new plan still has it.
function renderGoalTargets(plan) {
    const select = document.getElementById('goal-target');
    const previous = select.value;
    const rows = priorityRows(plan);
    select.innerHTML = rows.map(r => `<option value="${r.target}">${goalName(r)}</option>`).join('');
    if (rows.some(r => r.target === previous)) select.value = previous;
}

function goalName(row) {
    return row.target === 'coins' ? 'Home Coins' : row.label;
}

// Renders the item-level production breakdown from `goalResult.products`; one row per income
// stream (a selected item, or the leftover-capacity portion of a split facility), already
// sorted by net profit descending by the solver. Wood Blocks/Mineral Sand byproducts
// (`goalResult.byproducts`) are appended as extra rows at the bottom, styled distinctly since
// they're a side effect of the plan above rather than something sold for the chosen currency.
// The Profit column scales with whichever unit is selected in `#rate-unit` (see
// `updateRateDisplay`), same as "Your Rate" above.
function renderProductBreakdown(goalResult) {
    const section = document.getElementById('product-breakdown-section');
    const tbody = document.getElementById('product-breakdown-tbody');

    const products = goalResult.products || [];
    const byproducts = (goalResult.byproducts || []).filter(([, amount]) => Math.floor(amount) > 0);
    if (products.length === 0 && byproducts.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    const unit = document.getElementById('rate-unit').value;
    const { multiplier, suffix } = RATE_UNIT_SECONDS[unit] || RATE_UNIT_SECONDS.second;
    document.getElementById('product-breakdown-rate-header').innerHTML = `Profit <span class="th-unit">Home Coins${suffix}</span>`;
    // During the season, what each item counts toward the season's points.
    const season = lastPlan?.season_points != null;
    const pointsEach = new Map((lastPlan?.income_streams || []).map(s => [s.item_name, s.points || 0]));
    const pointsHeader = document.getElementById('product-breakdown-points-header');
    pointsHeader.hidden = !season;
    pointsHeader.textContent = planSeason().points;
    const pointsCell = amount => season ? `<td>${amount > 0 ? formatNumber(amount) : '&mdash;'}</td>` : '';

    tbody.innerHTML = '';
    products.forEach(p => {
        const row = document.createElement('tr');
        // Amount is floored to a whole number; the underlying rate math is a continuous
        // approximation (same steady-state model used throughout this calculator), but you
        // can't actually receive a fractional item; whatever fraction is left over represents
        // a batch still in progress at the moment the goal is reached. Worth is then computed
        // from THAT same whole number (amount * sell price), not the unrounded rate total, so
        // the two columns always reconcile by hand-multiplication; Profit stays net of
        // ingredient costs (matches Total Time/Amount Produced above), so it won't equal Worth
        // / time; they're intentionally different figures (gross vs. net).
        const wholeAmount = Math.floor(p.total_units);
        const worth = wholeAmount * p.sell_value;
        row.innerHTML = `
            <td>${prettyItem(p.item_name)}</td>
            <td>${p.facility}</td>
            <td>${wholeAmount.toLocaleString(currentLocale())}</td>
            <td>${formatRate(p.rate_per_second * multiplier)}</td>
            <td>${formatNumber(worth)}</td>
            ${pointsCell(wholeAmount * (pointsEach.get(p.item_name) || 0))}
        `;
        tbody.appendChild(row);
    });

    byproducts.forEach(([name, amount]) => {
        const row = document.createElement('tr');
        row.className = 'byproduct-row';
        row.innerHTML = `
            <td>${name} <span class="hint small">(bonus)</span></td>
            <td>&mdash;</td>
            <td>${Math.floor(amount).toLocaleString(currentLocale())}</td>
            <td>&mdash;</td>
            <td>not sold</td>
            ${pointsCell(0)}
        `;
        tbody.appendChild(row);
    });
}

// Renders `goalResult.seed_requirements`; one row per grower crop actually being planted, how
// many times each of its dedicated plots needs replanting over the goal's total time, so a
// player can have enough seeds ready ahead of time. Never includes processor facilities; they
// aren't planted (see `SeedRequirement` in models.rs).
function renderSeedsNeeded(goalResult) {
    const section = document.getElementById('seeds-needed-section');
    const tbody = document.getElementById('seeds-needed-tbody');

    const requirements = goalResult.seed_requirements || [];
    if (requirements.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    tbody.innerHTML = requirements.map(r => `
        <tr>
            <td>${prettyItem(r.item_name)}</td>
            <td>${r.facility}</td>
            <td>${r.facility_count.toLocaleString(currentLocale())}</td>
            <td>${r.seeds_per_plot.toLocaleString(currentLocale())}</td>
            <td>${r.total_seeds.toLocaleString(currentLocale())}</td>
        </tr>
    `).join('');
}

// Fixed display order for environment groups; matches ENVIRONMENT_BUILDINGS's mode order in
// optimizer.rs (Heat Furnace's two modes, then Cooling Unit's two, then Sunlamp's one).
const ENVIRONMENT_MODE_ORDER = ['Warm', 'Scorching', 'Cool', 'Freeze', 'Adequate'];

// "Fire Lv.4 · Practical" for a row that needs a specific Aniimo, or '-' when it doesn't (crops,
// trees, idle facilities).
// Every Aniimo ability in the game's own order, with its in-game color and what it's for.
// `dark` marks colors light enough to need dark text.
const ABILITIES = [
    { name: 'Fire', color: '#e5484d', about: 'Cooking, smelting and heat' },
    { name: 'Grass', color: '#3fa36b', about: 'Planting seeds and gathering' },
    { name: 'Water', color: '#2b8fe8', about: 'Brewing, fetching water and watering' },
    { name: 'Earth', color: '#b39a74', about: 'Reclaiming land and mining' },
    { name: 'Lightning', color: '#e6c317', about: 'Electricity', dark: true },
    { name: 'Ice', color: '#45c4de', about: 'Cooling the homeland' },
    { name: 'Wind', color: '#2fbfa5', about: 'Processing with wind' },
    { name: 'Dark', color: '#7d4bb3', about: 'Harvesting, cutting, pickling and drying' },
    { name: 'Light', color: '#f5a524', about: 'Lighting the homeland', dark: true },
    { name: 'Hauling', color: '#5f7fd1', about: 'Carrying produce to storage' },
    { name: 'Artisanship', color: '#5fb14f', about: 'Handcrafted goods' },
    { name: 'Leisure', color: '#e8678a', about: 'Making things while playing' },
    { name: 'Perfumery', color: '#b877d9', about: 'Perfumes and incense' },
];
const ABILITY_BY_NAME = new Map(ABILITIES.map(a => [a.name, a]));

// The ability each environment building's Aniimo needs (confirmed in game).
const ENVIRONMENT_BUILDING_ABILITY = {
    'Crackle Generator': 'Lightning',
    'Heat Furnace': 'Fire',
    'Cooling Unit': 'Ice',
    'Sunlamp': 'Light',
};

// A colored ability tag, like the game's.
function abilityTag(name) {
    const a = ABILITY_BY_NAME.get(name);
    if (!a) return name;
    return `<span class="ability${a.dark ? ' dark' : ''}" style="--ability:${a.color}" title="${a.about}">${name}</span>`;
}

// "Fire Lv.4 · Practical": one kind of Aniimo, with the facility's personality when the plan
// counts on its bonus. `tagged` shows the ability as a colored tag.
function taskLabel(task, facility, tagged = false) {
    const ability = tagged ? abilityTag(task.ability) : task.ability;
    if (!task.personality_bonus) return `${ability} Lv.${task.level}`;
    const personality = FACILITIES.find(f => f.name === facility)?.personality;
    if (!personality) return `${ability} Lv.${task.level} · matching personality`;
    // The letter the game shows over an Aniimo's portrait, so a player can read a team off the
    // four it carries.
    const letter = personalityLetter(personality);
    return `${ability} Lv.${task.level} · ${personality}${letter ? ` (${letter})` : ''}`;
}

function facilityPlanCards(rows, plan, heading, first = []) {
    const buildings = new Map();
    for (const step of rows) {
        if (!(step.facility_count > 0)) continue;
        if (!buildings.has(step.facility)) buildings.set(step.facility, []);
        buildings.get(step.facility).push(step);
    }
    if (!buildings.size) return '';
    const rank = new Map(first.map((name, index) => [name, index]));
    const ordered = [...buildings].sort(([a], [b]) =>
        (rank.get(a) ?? first.length) - (rank.get(b) ?? first.length)
        || translate(a).localeCompare(translate(b), currentLocale()));
    return `
      <section class="production-section">
        <h3>${heading}</h3>
        <div class="production-grid">${ordered.map(([facility, jobs]) => {
            const icon = facilityIconUrl(facility);
            const initials = facility.split(' ').map(word => word[0]).join('').slice(0, 3);
            return `<article class="production-building-card${jobs.some(job => job.status === 'producing') ? '' : ' is-idle'}"
                data-facility="${escapeText(facility)}">
                <h4 class="production-building-title">
                    <span class="production-building" aria-hidden="true">
                        <span>${escapeText(initials)}</span>
                        ${icon ? `<img src="${icon}" alt="" width="40" height="40" loading="lazy" decoding="async">` : ''}
                    </span><span>${escapeText(facility)}</span>
                </h4>
                ${jobs.map(step => productionCard(step, plan)).join('')}
            </article>`;
        }).join('')}</div>
      </section>
    `;
}

function productionWorkers(step, recipe, plan) {
    if (selectedSetupTab() !== 'custom' || step.electric_level != null) return [];
    const actual = (plan.roster_routes || []).filter(route => route.facility === step.facility
        && route.item === step.item_name && route.jobs.some(([, share]) => share > 1e-9));
    const crew = step.crew != null ? [[step.crew, step.aniimo?.ability]] : actual.length
        ? [...new Map(actual.map(route => [route.member,recipe?.aniimo?.[0] ?? recipe?.jobs?.find(([job])=>route.jobs.some(([name])=>name===job))?.[1]]))]
        : [...new Map((plan.crop_assignments || [])
        .filter(([ability, required, , share]) => share > 1e-9
            && recipe?.jobs.some(([, job, level]) => job === ability && level === required))
        .map(([ability, , id]) => [id, ability]))].sort(([a], [b]) => a - b);
    return crew.map(([id, job]) => {
        const member = roster[id];
        const assumed = (plan.assumed_aniimo || []).find(([index]) => index === id);
        const ability = assumed?.[1] ?? job ?? (member ? Object.keys(member.abilities)[0] : '');
        const name = member ? rosterTileLabel(member, id)
            : [translate('Assumed Aniimo'), ability && translate(ability)].filter(Boolean).join(' · ');
        const form = member && rosterCatalogId(member.catalogId, member.name);
        const portrait = aniimoPortrait(form);
        const fallback = abilityGlyph(ability);
        return {
            name: escapeText(name),
            badge: `<span class="production-portrait${form?.includes('prismana') ? ' prismana' : ''}" ${tipAttrs(name)}
                data-production-worker="${id}" data-worker-job="${escapeText(`${translate(step.facility)} (${prettyItem(step.item_name)})`)}"
                data-worker-item="${escapeText(prettyItem(step.item_name))}" tabindex="0" role="button" aria-haspopup="dialog">
                <span class="production-portrait-art">
                    <span aria-hidden="true">${fallback ? `<svg viewBox="0 0 24 24">${fallback}</svg>` : '◇'}</span>
                    ${portrait ? `<img class="${portrait.includes('/UI_PetHead_') ? 'game-head' : ''}" src="${escapeText(portrait)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
                </span></span>`,
        };
    });
}

function productionCard(step, plan) {
    const producing = step.status === 'producing';
    const item = prettyItem(step.item_name);
    const recipe = item && recipeIndex.find(r => r.name === step.item_name && r.facility === step.facility);
    const requirements = new Map();
    const required = recipe?.aniimo ? [recipe.aniimo] : recipe?.jobs.map(([, ability, level]) => [ability, level]);
    for (const [ability, level] of required?.length ? required : (step.aniimo_tasks || []).map(t => [t.ability, t.level])) {
        requirements.set(ability, Math.max(level, requirements.get(ability) ?? 0));
    }
    if (!requirements.size && step.aniimo) requirements.set(step.aniimo.ability, step.aniimo.level);
    const colors = [...requirements.keys()].map(ability => ABILITY_BY_NAME.get(ability)?.color).filter(Boolean);
    const requirementText = [...requirements].map(([ability, level]) => translate('{ability} Lv.{level}')
        .replace('{ability}', translate(ability)).replace('{level}', level)).join(', ');
    const icons = [...requirements.keys()].map(ability => `<img class="production-ability-icon" src="${gameAbilityIcon(ability)}"
        alt="" width="23" height="23" loading="lazy">`).join('');
    const workers = producing ? productionWorkers(step, recipe, plan) : [];
    const electric = step.electric_level != null;
    const poweredJobs=lastLayout?.plan===plan?powerJobDetails(lastLayout.layout,step):[];
    const slowerNetworks=[...new Map(poweredJobs.flatMap(j=>j.networks).filter(n=>n.percent<120-1e-6).map(n=>[n.id,n])).values()];
    const gridLabels=slowerNetworks.map(n=>`${n.generator_ids.map(id=>`G${id}`).join('+')} · ${formatNumber(n.percent)}%`);
    const cycles=poweredJobs.map(j=>j.cycle).filter(c=>c>0);
    const cycleText=cycles.length&&Math.max(...cycles)-Math.min(...cycles)>1e-6
        ? `${cycleDuration(Math.min(...cycles))}–${cycleDuration(Math.max(...cycles))}`
        : cycleDuration(cycles[0]??step.cycle_time);
    const load = producing && step.cycle_time > 0 && step.facility_count > 0
        ? Math.max(0, Math.min(100, (poweredJobs.length?poweredJobs.reduce((s,j)=>s+j.load,0)/poweredJobs.length
            :(step.busy_units ?? step.facility_count)/step.facility_count)*100)) : null;
    const loadText = load == null ? '' : `${formatNumber(load)}%`;
    const crew = electric
        ? `<span class="production-electric"><svg viewBox="0 0 24 24" aria-hidden="true">${abilityGlyph('Lightning')}</svg><span class="production-grid-labels">${gridLabels.length?gridLabels.map(label=>`<span>${escapeText(label)}</span>`).join(''):'E-mode'}</span></span>`
        : workers.length
            ? `<span class="production-workers">${workers.slice(0, 5).map(worker => worker.badge).join('')}${workers.length > 5 ? `<span class="production-more">+${workers.length - 5}</span>` : ''}</span>`
            : icons ? `<span class="production-workers" title="${escapeText(requirementText)}">${icons}</span>` : '';
    const unverified = unverifiedRowKeys.has(`${step.facility}|${step.item_name}`);
    return `
        <details class="production-tile" data-status="${escapeText(step.status)}" data-search="${escapeText(item || '')}">
            <summary class="production-summary">
                ${colors.length ? `<span class="production-edge" aria-hidden="true">${colors.map(color => `<span style="background:${color}"></span>`).join('')}</span>` : ''}
                <span class="production-title">
                    <span class="production-item">${escapeText(item || 'Idle')}</span>
                    <span class="production-count">×${formatNumber(step.facility_count)}</span>
                    ${unverified ? '<span class="tag unverified" title="Not yet checked in game">unverified</span>' : ''}
                </span>
                <span class="production-state">
                    ${crew}
                    ${loadText ? `<span class="production-load" title="${escapeText(translate('Building load'))}">
                        <span class="production-load-track" aria-hidden="true"><span style="width:${load}%"></span></span><strong>${loadText}</strong>
                    </span>` : ''}
                </span>
                <span class="production-chevron" aria-hidden="true"></span>
            </summary>
            <div class="production-detail">
                ${step.reason ? `<p>${escapeText(prettyReason(step.reason))}</p>` : ''}
                ${loadText ? `<p><span>Building load</span> <strong>${loadText}</strong> <span>·</span>
                    <span>${translate('{duration} per batch').replace('{duration}', cycleText)}</span></p>` : ''}
                ${slowerNetworks.map(n=>`<p>${escapeText(powerNetworkLabel(n))}</p>`).join('')}
                ${requirementText ? `<p><span>${electric ? 'Minimum for normal mode' : 'Required abilities'}</span><strong>${escapeText(requirementText)}</strong></p>` : ''}
                ${workers.length ? `<ul class="production-crew" aria-label="${escapeText(translate(step.crew != null ? 'Aniimo' : 'Shared field crew'))}">
                    ${workers.map(worker => `<li>${worker.badge}<span>${worker.name}</span></li>`).join('')}
                </ul>` : ''}
                ${step.aniimo?.personality_bonus ? `<p>${escapeText(taskLabel(step.aniimo, step.facility))}</p>` : ''}
                ${item && producing ? `<button type="button" class="production-skip" data-skip="${escapeText(step.item_name)}" aria-label="Skip recipe and replan">
                    <span class="production-skip-mark" aria-hidden="true">×</span><span>Skip recipe</span></button>` : ''}
            </div>
        </details>
    `;
}

function cycleDuration(seconds) {
    const total = Math.max(1, Math.round(seconds));
    return [
        total >= 3600 ? translate('{hours}h').replace('{hours}', Math.floor(total / 3600)) : '',
        total % 3600 >= 60 ? translate('{minutes}m').replace('{minutes}', Math.floor(total / 60) % 60) : '',
        total % 60 ? translate('{seconds}s').replace('{seconds}', total % 60) : '',
    ].filter(Boolean).join(' ');
}

function filterFacilityPlan() {
    const terms = searchTerms(document.getElementById('plan-facility-search').value);
    const container = document.getElementById('facility-plan-container');
    for (const building of container.querySelectorAll('.production-building-card')) {
        const name = building.dataset.facility;
        const facility = `${name} ${translate(name)}`;
        for (const card of building.querySelectorAll('.production-tile')) {
            const item = card.dataset.search || 'Idle';
            card.hidden = !matchesSearch(terms, `${facility} ${item} ${translate(item)}`);
        }
        building.hidden = !building.querySelector('.production-tile:not([hidden])');
    }
    for (const diagram of container.querySelectorAll('.production-environment-grid > article')) {
        diagram.hidden = !matchesSearch(terms, `${diagram.dataset.search} ${diagram.textContent}`);
    }
    const sections = [...container.querySelectorAll('.production-section')];
    for (const section of sections) {
        section.hidden = !section.querySelector('article:not([hidden])');
    }
    document.getElementById('plan-facility-empty').hidden = !sections.length || sections.some(section => !section.hidden);
}

// "Sowing", "Sowing and Collecting", "Reaping, Logging and Collecting".
function listOf(items) {
    if (items.length < 2) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}



// A growing environment named in its own colour.
function modeTag(mode) {
    const tint = ENVIRONMENT_MODE_COLORS[mode] || '#9aa0a8';
    return `<span class="env-mode-tag" style="--tint:${tint}">${mode}</span>`;
}

// What a row's Aniimo work on: each growing job ("Sowing crops" when it covers both Farmland and
// Woodland, "Reaping farmland" when it's one facility's), then the facilities.
function whereText(g) {
    return [...g.jobs]
        .map(([job, at]) => `${job} ${at.size > 1 ? 'crops' : listOf([...at].map(facility => facility.toLowerCase()))}`)
        .concat([...g.where.entries()].map(([place, n]) => `${n > 1 ? n + '× ' : ''}${place}`))
        .join(', ');
}

// What one Aniimo of a team row has to be: its level, then every personality it carries, each
// with the letter the game shows. "Lv.4 · Judicious (J), Faithful (F)" is one Aniimo working a
// Nimbus Bed and a Starfall Hammock, which it can because those never want opposites.
function aniimoNeeds(g) {
    if (g.environment) return g.label.slice(g.ability.length).trim();
    const personalities = [...g.personalities]
        .sort()
        .map(name => `${name} (${personalityLetter(name)})`)
        .join(', ');
    return `Lv.${g.level}${g.family ? ` · ${leisureFamilyName(g.family)}` : ''}${personalities ? ` · ${personalities}` : ''}`;
}

function environmentTeamJobs(plan) {
    const jobs = [];
    const add = (building, busy, label, level) => {
        const ability = ENVIRONMENT_BUILDING_ABILITY[building];
        if (ability && busy) jobs.push({ ability, level: level || 1, anyLevel: !level, busy, label, fixed: true });
    };
    const pairs = new Map();
    for (const a of plan.environment_assignments || []) {
        if (!a.partner) {
            add(a.building, a.units, `${a.building} (${a.mode})`, ['Scorching', 'Freeze'].includes(a.mode) ? 2 : 1);
            continue;
        }
        const key = environmentPairKey(a);
        const seen = pairs.get(key);
        pairs.set(key, { building: a.building, partner: a.partner[0],
            units: Math.max(seen?.units ?? 0, a.units), modes: a.pair_modes || [a.mode, a.mode] });
    }
    pairs.forEach(({ building, partner, units, modes }) => {
        add(building, units, `${building} (${modes[0]})`, ['Scorching', 'Freeze'].includes(modes[0]) ? 2 : 1);
        add(partner, units, `${partner} (${modes[1]})`, ['Scorching', 'Freeze'].includes(modes[1]) ? 2 : 1);
    });
    for (const [tier, lightning] of plan.power_generator_levels || []) {
        add('Crackle Generator', 1, `Crackle Generator Lv.${tier}`, lightning);
    }
    return jobs;
}

const bestTeamCache = new WeakMap();
const bestTeamLayouts = new WeakMap();
const minimumTeamCache = new WeakMap();

function bestPlanTeam(plan, haulingBusy = plan.hauling_busy || 0,
    layout = bestTeamLayouts.get(plan)?.layout ?? null, hauling = bestTeamLayouts.get(plan)?.hauling) {
    let cached = bestTeamCache.get(plan);
    if (!cached) {
        const jobs = environmentTeamJobs(plan);
        const profiles=scheduleProfiles(plan);
        const families = new Map(recipeIndex.filter(recipe => recipe.family).map(recipe => [recipe.name, recipe.family]));
        const personalities = new Map(FACILITIES.map(facility => [facility.name, facility.personality]));
        for (const step of plan.coin_items || []) {
            if (step.status !== 'producing' || step.electric_level != null) continue;
            for (const task of step.aniimo_tasks || []) {
                const item = prettyItem(step.item_name);
                const label = task.jobs?.length
                    ? `${task.jobs.map(translate).join(' / ')} · ${item}`
                    : `${translate(step.facility)} (${item})`;
                const resident = RESIDENT_FACILITIES.has(step.facility);
                const batches = step.cycle_time > 0 ? (step.busy_units ?? step.facility_count) / step.cycle_time : 0;
                jobs.push({
                    ability: task.ability, level: task.level, label,
                    profile:profiles.get(`${step.facility}|${step.item_name}`),
                    busy: resident ? step.facility_count : task.busy,
                    siteKey: resident ? null : `${step.facility}|${step.item_name}`,
                    visitsPerShare: !resident && task.busy > 0 ? batches * (task.jobs?.length || 1) / task.busy : 0,
                    growing: task.jobs?.length > 0, fixed: resident,
                    critical: (task.jobs || []).some(criticalCropJob),
                    duration: batches > 0 ? task.busy / batches / (task.jobs?.length || 1) : 0,
                    personality: task.personality_bonus ? personalities.get(step.facility) : null,
                    family: task.ability === 'Leisure' ? families.get(step.item_name) : null,
                });
            }
        }
        cached = { jobs };
        bestTeamCache.set(plan, cached);
    }
    const scheduleOptions={phaseDurations:plan.recipe_schedule?.phases.map(p=>p.duration),haulingProfile:haulingScheduleProfile(plan,hauling)};
    if (!layout && !haulingBusy) return cached.baseline ??= recommendBestTeam(cached.jobs,0,[],scheduleOptions);
    if (cached.layout !== layout || cached.haulingBusy !== haulingBusy || cached.hauling !== hauling) {
        cached.layout = layout;
        cached.haulingBusy = haulingBusy;
        cached.hauling = hauling;
        const dispatch = layout && buildDispatch(layout, recipeIndex, hauling, RESIDENT_FACILITIES);
        cached.result = recommendBestTeam(placeBestJobs(cached.jobs, layout, dispatch?.locations), haulingBusy, dispatch?.opportunities||[],scheduleOptions);
        if (layout) {
            const pools = cached.result.shifts.map(shift => ({ ...shift, busy:Math.max(shift.busy,...(shift.phaseBusy||[])), count: 1 }));
            const support = withCropSupport({ layout, recipes: recipeIndex, pools, limit: ANIIMO_MAX[layoutHomeLevel()-1] });
            const peak = support.peak;
            cached.result.cropPeaks = peak;
            for (const { member, count } of peak.additions) for (let i=0;i<count;i++) {
                const source = support.pools[member];
                cached.result.shifts.push({ ...source, busy: 0, tasks: new Map(), allocations: [], peakSupport: true });
            }
        }
    }
    return cached.result;
}

function bestRosterMember(shift) {
    const personalities = PERSONALITY_PAIRS.map(pair => pair.names.find(name => shift.personalities.has(name)) ?? null);
    const member = { ...newRosterAniimo({ ...shift.abilities }, personalities), family: shift.family };
    if (shift.entry) {
        member.catalogId = shift.entry.id;
        member.name = rosterFormName(shift.entry);
    }
    return member;
}

function renderBestTeam(plan, routeStatus = translate('Calculating…')) {
    const { shifts, cropPeaks } = bestPlanTeam(plan);
    const total = shifts.length;
    const cap = ANIIMO_MAX[layoutHomeLevel() - 1];
    const summary = document.getElementById('aniimo-collapsed-summary');
    summary.textContent = total
        ? translate('{n} Aniimo assigned').replace('{n}', formatNumber(total))
        : translate('No Aniimo needed.');
    const capNote = cap && total > cap
        ? `<p class="hint small">${translate('This RV level can host {n} Aniimo.').replace('{n}', cap)}</p>`
        : '';
    document.getElementById('roster-summary').hidden = true;
    document.getElementById('aniimo-abilities').textContent = '';
    document.getElementById('aniimo-count').hidden = true;
    const container = document.getElementById('aniimo-summary');
    if (container.contains(tipTarget)) hideTip();
    const routesReady = bestTeamLayouts.has(plan);
    const routeLabels = ['Walking between jobs', 'Hauling to Storage Units'];
    const percent = share => share > 0 && share < .0001 ? '<0.01%' : `${formatNumber(share * 100)}%`;
    container.innerHTML = total
        ? `${capNote}${cropPeakNote(cropPeaks, [], true)}<div class="roster-cards">${rosterBoard(shifts.map((_, index) => index), index => {
            if (index == null) return emptyRosterCell();
            const shift = shifts[index];
            const member = bestRosterMember(shift);
            const label = member.name || translate('Assumed Aniimo');
            const tasks = routeLabels.filter(label => !shift.peakSupport && (!routesReady || shift.tasks.has(label))).map(label => [
                translate(label), routesReady ? percent(shift.tasks.get(label)) : routeStatus,
            ]);
            if (shift.peakSupport) {
                const jobs = [...new Set(recipeIndex.flatMap(r => (r.jobs || []).filter(([name,ability,level]) => criticalCropJob(name) && (shift.abilities[ability] || 0) >= level).map(([name]) => translate(name))))];
                tasks.push([jobs.join(' / '), translate('Crop peak support')]);
            }
            if (shift.tasks.has(TASK_SWITCHING)) tasks.push([translate(TASK_SWITCHING), percent(shift.tasks.get(TASK_SWITCHING))]);
            for (const [job, share] of [...shift.tasks].sort((a, b) => b[1] - a[1])) {
                if (!routeLabels.includes(job) && job !== TASK_SWITCHING) tasks.push([translate(job), percent(share)]);
            }
            if(shift.phaseBusy?.length)tasks.unshift(['Peak during recipe schedule',percent(Math.max(...shift.phaseBusy))]);
            const status = shift.peakSupport ? translate('Crop peak support') : translate('{load} busy').replace('{load}', percent(shift.busy));
            const traits = [...shift.personalities].map(translate).join(' · ');
            return assignmentTile(member, label, tasks, status, true, traits);
        })}</div>`
        : '';
    if (!aniimoExpansionChosen) setAniimoExpanded(true);
}

// The Aniimo team the shown plan needs, one row per distinct ability / level / personality.
// A row asks for enough Aniimo to cover its work on average (a facility waiting on ingredients
// frees its Aniimo), rounded up; facilities with a resident Aniimo (Sandcastle and the like) are
// always busy, so they count one each.
function aniimoTeam(plan) {
    const cachedTeam = minimumTeamCache.get(plan), placedTeam = bestTeamLayouts.get(plan);
    if (cachedTeam && cachedTeam.layout === placedTeam?.layout && cachedTeam.hauling === plan.hauling_busy) return cachedTeam.team;
    const groups = new Map();
    (plan.coin_items || []).forEach(step => {
        (step.aniimo_tasks || []).forEach(task => {
            const family = recipeIndex.find(r => r.name === step.item_name)?.family || null;
            const key = `${taskLabel(task, step.facility)}${family ? ` · ${leisureFamilyName(family)}` : ''}`;
            if (!groups.has(key)) {
                const personality = task.personality_bonus
                    ? FACILITIES.find(f => f.name === step.facility)?.personality ?? null
                    : null;
                groups.set(key, { label: key, ability: task.ability, level: task.level, bonus: task.personality_bonus, personality, family, busy: 0, where: new Map(), jobs: new Map(), allocations: [] });
            }
            const g = groups.get(key);
            g.busy += RESIDENT_FACILITIES.has(step.facility) ? step.facility_count : task.busy;
            const batches = step.cycle_time > 0 ? (step.busy_units ?? step.facility_count) / step.cycle_time : 0;
            g.allocations.push({ ability: task.ability, siteKey: `${step.facility}|${step.item_name}`,
                busy: RESIDENT_FACILITIES.has(step.facility) ? step.facility_count : task.busy,
                fixed: RESIDENT_FACILITIES.has(step.facility), critical: (task.jobs || []).some(criticalCropJob),
                duration: batches > 0 ? task.busy / batches / (task.jobs?.length || 1) : 0 });
            // A growing job reads as the job itself, however many crops it covers.
            if ((task.jobs || []).length) {
                // Where a job happens matters: reaping is Farmland's, logging Woodland's.
                task.jobs.forEach(job => {
                    if (!g.jobs.has(job)) g.jobs.set(job, new Set());
                    g.jobs.get(job).add(step.facility);
                });
                return;
            }
            const place = `${step.facility} (${prettyItem(step.item_name)})`;
            g.where.set(place, (g.where.get(place) || 0) + step.facility_count);
        });
    });
    // Environment buildings in use each keep an Aniimo busy (abilities confirmed in game; whether
    // minimum level comes from the selected climate mode; personality gives no bonus).
    const needsAniimo = ({ ability, busy, label, level, anyLevel }) => {
        const key = `${ability} (environment:${anyLevel ? 0 : level})`;
        if (!groups.has(key)) {
            groups.set(key, { label: anyLevel ? `${ability} any level` : `${ability} Lv.${level}`, ability, level, anyLevel, bonus: false, busy: 0, where: new Map(), jobs: new Map(), environment: true });
        }
        const g = groups.get(key);
        g.busy += busy;
        g.where.set(label, (g.where.get(label) || 0) + busy);
    };
    environmentTeamJobs(plan).forEach(needsAniimo);
    // Each row gets its own Aniimo, which is the clearer team to keep. Only when that asks for
    // more than the homeland holds does work that takes any level (the Farmland and Woodland jobs)
    // move into another row's spare time, so a plot's watering is a job of its own where there's
    // room for one.
    //
    // An Aniimo carries four personalities, one from each opposed pair, so one can hold the bonus
    // at several facilities at once as long as none of them want opposites and there are hours
    // left in its day. The team is the best combination that allows: each Aniimo is listed with
    // every personality it has to have.
    const assign = () => {
        const rows = [...groups.values()]
            .map(g => ({ ...g, where: new Map(g.where), jobs: new Map([...g.jobs].map(([job, at]) => [job, new Set(at)])) }))
            .sort((a, b) => b.level - a.level || Number(b.bonus) - Number(a.bonus) || a.label.localeCompare(b.label));
        const kept = [];
        // One Aniimo can take another row's work when it has the ability at a high enough level,
        // hours to spare, and nothing on it already wanting the opposite personality.
        const holds = (host, g) => host.ability === g.ability && (host.family || null) === (g.family || null) && host.level >= g.level && host.spare >= g.busy - 1e-6
            && (!g.personality || !host.personalities.has(opposedPersonality(g.personality)));
        rows.forEach(g => {
            // A facility with a resident Aniimo keeps it to itself.
            const host = g.environment ? null : kept.find(k => holds(k, g));
            if (host) {
                host.allocations = [...(host.allocations || []), ...(g.allocations || [])];
                host.spare -= g.busy;
                host.busy += g.busy;
                if (g.personality) host.personalities.add(g.personality);
                g.where.forEach((n, place) => host.where.set(place, (host.where.get(place) || 0) + n));
                g.jobs.forEach((at, job) => {
                    if (!host.jobs.has(job)) host.jobs.set(job, new Set());
                    at.forEach(facility => host.jobs.get(job).add(facility));
                });
                return;
            }
            g.count = Math.max(1, Math.ceil(g.busy - 1e-6));
            g.spare = g.count - g.busy;
            g.personalities = new Set(g.personality ? [g.personality] : []);
            kept.push(g);
        });
        return { kept, total: kept.reduce((sum, g) => sum + g.count, Math.max(0, Math.ceil((plan.hauling_busy || 0) - 1e-6))) };
    };
    const team = assign();
    const placed = bestTeamLayouts.get(plan);
    if (placed) {
        const pools = team.kept.map(g => ({ count: g.count, abilities: { [g.ability]: g.level },
            allocations: g.environment ? [{fixed:true,busy:g.count}] : g.allocations }));
        const couriers = Math.max(0, Math.ceil((plan.hauling_busy || 0)-1e-6));
        const support = withCropSupport({layout:placed.layout,recipes:recipeIndex,pools,limit:ANIIMO_MAX[layoutHomeLevel()-1]-couriers});
        const peak = support.peak;
        team.cropPeaks = peak;
        for (const {member,count} of peak.additions) {
            if(member<pools.length)team.kept[member].count+=count;
            else {
                const source=support.pools[member];
                const [ability,level]=Object.entries(source.abilities)[0];
                team.kept.push({...source,count,ability,level,busy:0,spare:count,label:rosterFormName(source.entry),where:new Map(),jobs:new Map([['Crop peak support',new Set(['Farmland','Woodland'])]])});
            }
            team.total+=count;
        }
    }
    minimumTeamCache.set(plan, {layout:placedTeam?.layout, hauling:plan.hauling_busy, team});
    return team;
}

function renderAniimoSummary(plan) {
    const setup = selectedSetupTab();
    const custom = setup === 'custom';
    const workloadNote = document.getElementById('aniimo-workload-note');
    const travelNote = ' Travel uses base movement speed without workload multipliers.';
    const dispatchNote = setup !== 'minimum'
        ? translate(' Assignments are estimates. An available Aniimo can start walking to another eligible job when it appears.') : '';
    workloadNote.textContent = plan.hauling_busy != null ? HAULING_ESTIMATE_HINT + travelNote + dispatchNote : '';
    workloadNote.hidden = plan.hauling_busy == null;
    if (custom) {
        if (!aniimoExpansionChosen) setAniimoExpanded(true);
        renderRosterSummary(plan);
        return;
    }
    if (setup === 'best'||setup!=='custom'&&plan.recipe_schedule) {
        renderBestTeam(plan);
        return;
    }
    const container = document.getElementById('aniimo-summary');
    const collapsedSummary = document.getElementById('aniimo-collapsed-summary');
    const { kept, total: assigned, cropPeaks } = aniimoTeam(plan);
    const haulingCount = Math.max(0, Math.ceil((plan.hauling_busy || 0) - 1e-6));
    if (!kept.length && !haulingCount) {
        container.innerHTML = '<p class="hint">Nothing in this plan needs an Aniimo.</p>';
        collapsedSummary.textContent = 'No Aniimo needed.';
        const count = document.getElementById('aniimo-count');
        if (count) count.hidden = true;
        document.getElementById('aniimo-abilities').innerHTML = '';
        return;
    }
    const homelandHolds = isSimpleMode() ? ANIIMO_MAX[selectedHomeLevel() - 1] : null;
    const groups = kept
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(g => ({
            count: g.count, busy: g.busy, abilities: g.abilities || { [g.ability]: g.anyLevel ? '·' : g.level },
            entry:g.entry,peakSupport:g.peakSupport,
            label: g.entry ? rosterFormName(g.entry) : `${translate(g.ability)} ${translate(aniimoNeeds(g))}`, detail: translate(whereText(g)),
        }));
    const haulingLevel = 1;
    if (haulingCount) groups.push({
        count: haulingCount, busy: plan.hauling_busy, abilities: { Hauling: haulingLevel },
        label: `${translate('Hauling')} Lv.${haulingLevel}`, detail: translate('Carrying produce to storage'),
    });
    const tiles = groups.flatMap((group, index) => Array(group.count).fill(index));
    const total = assigned;

    // The count above says how many; this is only said when it's more than the homeland holds.
    const cap = homelandHolds;
    const capNote = cap && total > cap
        ? `<p class="hint small">That's ${total} Aniimo, more than the ${cap} an RV level ${selectedHomeLevel()} homeland holds.</p>`
        : '';
    const have = document.getElementById('aniimo-count-have');
    const of = document.getElementById('aniimo-count-of');
    const count = document.getElementById('aniimo-count');
    if (have && of && count) {
        have.textContent = total;
        of.textContent = cap ?? '';
        of.hidden = !cap;
        count.hidden = false;
        count.classList.toggle('over', !!cap && total > cap);
        count.title = cap
            ? `${total} Aniimo for this plan; an RV level ${selectedHomeLevel()} homeland holds ${cap}`
            : `${total} Aniimo for this plan`;
    }
    collapsedSummary.textContent = '';
    // How many of each ability the plan needs, in the game's order, like its Abilities screen.
    const needed = new Map(ABILITIES.map(a => [a.name, 0]));
    kept.forEach(g => Object.keys(g.abilities || { [g.ability]:g.level }).forEach(ability => needed.set(ability, (needed.get(ability) || 0) + g.count)));
    // Under each count, one circle per kind of Aniimo (with "×N" when several are the same): its
    // level inside (a dot for any level), a ring for the personality bonus, and what it's for in
    // the tooltip.
    const dot = (ability, text, bonus, tip) => {
        const a = ABILITY_BY_NAME.get(ability);
        return `<span class="ability-dot small${a && a.dark ? ' dark' : ''}${bonus ? ' bonus' : ''}" style="--ability:${a ? a.color : '#888888'}" title="${tip}" aria-label="${tip}">${text}</span>`;
    };
    const teamDots = g => {
        const where = whereText(g);
        const tip = `${g.count > 1 ? `${g.count}× ` : ''}${g.label}${g.bonus ? ' (+20% speed)' : ''} · ${where}`;
        const times = g.count > 1 ? `<span class="ability-times">×${g.count}</span>` : '';
        return `<span class="ability-kind">${dot(g.ability, g.anyLevel ? '·' : g.level, g.bonus, tip)}${times}</span>`;
    };
    document.getElementById('aniimo-abilities').innerHTML = ABILITIES.map(a => {
        const n = a.name === 'Hauling' ? needed.get(a.name) + haulingCount : needed.get(a.name);
        const zero = n === 0;
        const dots = kept
            .filter(g => g.ability === a.name || g.abilities?.[a.name])
            .map(g => g.abilities ? {...g,ability:a.name,level:g.abilities[a.name]} : g)
            .sort((x, y) => y.level - x.level || Number(y.bonus) - Number(x.bonus))
            .map(teamDots);
        if (a.name === 'Hauling' && haulingCount) {
            dots.push(`<span class="ability-kind">${dot('Hauling', '·', false, translate('Carrying produce to storage'))}${haulingCount > 1 ? `<span class="ability-times">×${haulingCount}</span>` : ''}</span>`);
        }
        const stack = dots.length ? `<div class="ability-stack">${dots.join('')}</div>` : '';
        return `<div class="ability-col" style="--ability:${a.color}">
            <div class="ability-cell${zero ? ' zero' : ''}" title="${a.name}: ${a.about}">
                <span class="ability-count">${n}</span><span class="ability-name">${a.name}</span>
            </div>${stack}</div>`;
    }).join('');
    container.innerHTML = `${capNote}${cropPeakNote(cropPeaks, [], true)}<div class="roster-cards">${rosterBoard(tiles, i => {
        if (i == null) return emptyRosterCell();
        const member = groups[i];
        return assignmentTile(member.entry ? {...member,catalogId:member.entry.id} : member, member.label, member.detail, member.peakSupport ? translate('Crop peak support') : `${formatNumber(member.busy / member.count * 100)}%`);
    })}</div>`;
}

// Splits one environment mode's rows across its individual building units. Unlike the old
// preset-based version, each unit's exact facility-type capacity now comes straight from the
// solver's own geometric packing (`assignment.layouts[i]`; see `FacilityPlacement` in
// models.rs), not an evenly-divided share, since real per-building layouts aren't always
// identical (e.g. one Cooling Unit might host Farmland+Woodland while another hosts only
// Farmland). Still greedily fills each unit's per-facility-type capacity in row order, splitting
// a single row across units when its count exceeds one unit's remaining capacity; the exact
// split is arbitrary (any unit can host any plot of the crops sharing its mode), only the
// per-unit totals (and the diagram's exact positions) are load-bearing.
function environmentPairKey(assignment) {
    return assignment.pair_id != null ? `pair:${assignment.pair_id}`
        : JSON.stringify([assignment.building, assignment.partner, assignment.pair_modes]);
}

function withFacilityCount(step, count) {
    return { ...step, facility_count: count,
        busy_units: step.busy_units == null ? step.busy_units : step.busy_units * count / step.facility_count };
}

function splitByEnvironmentUnit(rows, assignmentsForMode) {
    const units = [];
    assignmentsForMode.forEach(a => {
        (a.layouts || []).forEach((layout, i) => {
            const remaining = {};
            layout.forEach(p => {
                remaining[p.facility] = (remaining[p.facility] || 0) + 1;
            });
            units.push({ building: a.building, remaining, rows: [], layout, partner: a.partner || null, zone: a.zone ?? null,
                pairModes: a.pair_modes || null, pairKey: a.partner ? `${environmentPairKey(a)}:${i}` : null });
        });
    });

    rows.forEach(step => {
        let remaining = step.facility_count;
        for (const unit of units) {
            if (remaining <= 0) break;
            const available = unit.remaining[step.facility] || 0;
            const take = Math.min(remaining, available);
            if (take <= 0) continue;
            unit.remaining[step.facility] -= take;
            unit.rows.push(withFacilityCount(step, take));
            remaining -= take;
        }
    });

    // A building's geometric layout is capacity, not a production guarantee; a facility type can
    // sit unused in a unit's coverage if there wasn't enough demand to fill every plot the fill
    // loop above offered it. Drawing that unused capacity in the diagram would show the player
    // squares they shouldn't actually place anything in (and that don't match this unit's own
    // table), so trim `layout` down to just the placements this unit's `rows` actually accounted
    // for, per facility type.
    units.forEach(unit => {
        const totalByFacility = {};
        unit.layout.forEach(p => {
            totalByFacility[p.facility] = (totalByFacility[p.facility] || 0) + 1;
        });
        const takenSoFar = {};
        unit.layout = unit.layout.filter(p => {
            const unused = unit.remaining[p.facility] || 0;
            const used = (totalByFacility[p.facility] || 0) - unused;
            takenSoFar[p.facility] = takenSoFar[p.facility] || 0;
            if (takenSoFar[p.facility] < used) {
                takenSoFar[p.facility]++;
                return true;
            }
            return false;
        });
    });

    return units.filter(u => u.rows.length > 0);
}

// Fixed color per environment-gated facility type, used by the layout diagram below; purely
// categorical (not theme-dependent), so it stays distinguishable in both light and dark mode.
const ENVIRONMENT_FACILITY_COLORS = {
    'Farmland': '#8b5e34',
    'Woodland': '#4caf50',
    'Starfall Hammock': '#42a5f5',
    'Tidewhisper Sandcastle': '#26c6da',
    'Floral Windmill': '#ab47bc',
    'Dewy House': '#ef8a80',
};

// Matches the confirmed geometry in src/coverage.rs: every environment building is a 2x2
// footprint, radiating coverage as a square of side 2*radius centered on its own center.
// Footprints, matching `ENVIRONMENT_BUILDING_SIZES` in coverage.rs: a Cooling Unit takes a 2x2
// like a Farmland, a Heat Furnace and a Sunlamp a single tile. All three cover the same 9x9 from
// their own center, so the smaller ones' squares land on tile lines and the Cooling Unit's sits
// half a tile off.
const ENVIRONMENT_BUILDING_SIZES = { 'Heat Furnace': 1.0, 'Cooling Unit': 2.0, 'Sunlamp': 1.0 };
const DEFAULT_ENVIRONMENT_BUILDING_SIZE = 2.0;
const environmentBuildingSize = name => ENVIRONMENT_BUILDING_SIZES[name] ?? DEFAULT_ENVIRONMENT_BUILDING_SIZE;
const ENVIRONMENT_COVERAGE_RADIUS = 4.5;

// Coverage tint for each growing environment, used to shade a building's coverage area.
// Adequate's yellow carries further than the others at the same opacity, so it's laid on lighter.
const ENVIRONMENT_MODE_SHADE = { Adequate: 0.55 };

const ENVIRONMENT_MODE_COLORS = {
    Warm: '#f59e0b',
    Scorching: '#ef4444',
    Cool: '#67e8f9',
    Freeze: '#2563eb',
    Adequate: '#facc15',
};

// Renders one building's layout as an SVG: faint one-tile gridlines, the building, its coverage
// area shaded in the environment's color, and every plot the plan puts in it, nearest the
// building first. `rows` are this building's plan rows; each plot is matched to one of them so
// hovering a plot names its crop, and when one facility type grows more than one crop here (so
// color alone can't tell them apart) each plot shows its crop's number from the legend.
// Positions are the solver's own, in game tiles.
// What each environment building does, drawn on it in the layout diagram, after the game's own
// symbols: a flame for Warm and two for Scorching, a six-armed snowflake for Cool and two for
// Freeze, a sun for Adequate. Paths rather than emoji, which some systems render in their own
// colours.
const ENVIRONMENT_ICON_INK = 'rgba(255, 255, 255, 0.92)';

function flameIcon(cx, cy, size) {
    const s = size;
    return `<path d="M ${cx} ${cy - 0.62 * s}
                     C ${cx + 0.12 * s} ${cy - 0.3 * s} ${cx + 0.42 * s} ${cy - 0.16 * s} ${cx + 0.4 * s} ${cy + 0.12 * s}
                     C ${cx + 0.38 * s} ${cy + 0.42 * s} ${cx + 0.16 * s} ${cy + 0.6 * s} ${cx} ${cy + 0.6 * s}
                     C ${cx - 0.16 * s} ${cy + 0.6 * s} ${cx - 0.4 * s} ${cy + 0.42 * s} ${cx - 0.4 * s} ${cy + 0.1 * s}
                     C ${cx - 0.4 * s} ${cy - 0.1 * s} ${cx - 0.24 * s} ${cy - 0.18 * s} ${cx - 0.18 * s} ${cy - 0.36 * s}
                     C ${cx - 0.1 * s} ${cy - 0.22 * s} ${cx - 0.04 * s} ${cy - 0.3 * s} ${cx} ${cy - 0.62 * s} Z"
                   fill="${ENVIRONMENT_ICON_INK}" />`;
}

function snowflakeIcon(cx, cy, size) {
    const arms = [0, 60, 120].map(angle => {
        const radians = angle * Math.PI / 180;
        const [dx, dy] = [Math.cos(radians) * 0.62 * size, Math.sin(radians) * 0.62 * size];
        return `<line x1="${cx - dx}" y1="${cy - dy}" x2="${cx + dx}" y2="${cy + dy}" />`;
    }).join('');
    return `<g stroke="${ENVIRONMENT_ICON_INK}" stroke-width="${0.17 * size}" stroke-linecap="round">${arms}</g>`;
}

function sunIcon(cx, cy, size) {
    const rays = [0, 45, 90, 135, 180, 225, 270, 315].map(angle => {
        const radians = angle * Math.PI / 180;
        const [dx, dy] = [Math.cos(radians), Math.sin(radians)];
        return `<line x1="${cx + dx * 0.42 * size}" y1="${cy + dy * 0.42 * size}"
                      x2="${cx + dx * 0.64 * size}" y2="${cy + dy * 0.64 * size}" />`;
    }).join('');
    return `<circle cx="${cx}" cy="${cy}" r="${0.28 * size}" fill="${ENVIRONMENT_ICON_INK}" />
            <g stroke="${ENVIRONMENT_ICON_INK}" stroke-width="${0.15 * size}" stroke-linecap="round">${rays}</g>`;
}

// A building's symbol, drawn to fit whatever footprint it has: a Heat Furnace and a Sunlamp sit
// on one tile, so their symbols are half the size of a Cooling Unit's.
function environmentBuildingIcon(building, mode, cx, cy) {
    const scale = environmentBuildingSize(building) / 2;
    // The stronger of a building's two modes shows its symbol twice, as the game does: the main
    // one low and left, a smaller one off its top right, both clear of the building's edge.
    const twice = draw => `${draw(cx - 0.12 * scale, cy + 0.14 * scale, 0.92 * scale)}${draw(cx + 0.38 * scale, cy - 0.32 * scale, 0.56 * scale)}`;
    if (building === 'Heat Furnace') {
        return mode === 'Scorching' ? twice(flameIcon) : flameIcon(cx, cy, scale);
    }
    if (building === 'Cooling Unit') {
        return mode === 'Freeze' ? twice(snowflakeIcon) : snowflakeIcon(cx, cy, scale);
    }
    if (building === 'Sunlamp') {
        return sunIcon(cx, cy, scale);
    }
    return '';
}

function renderEnvironmentDiagram(layout, mode, building, rows = [], unit = null, zones = null) {
    if (!layout || layout.length === 0) return '';
    const margin = 5;
    const half = ENVIRONMENT_COVERAGE_RADIUS + margin;
    const buildingSize = environmentBuildingSize(building);
    const buildingCenter = buildingSize / 2;
    // Centered on the building's own center (it sits at (0,0)-(size,size)), not world origin.
    const viewMin = buildingCenter - half;
    const viewSize = half * 2;
    const coverageMin = buildingCenter - ENVIRONMENT_COVERAGE_RADIUS;
    const coverageSize = ENVIRONMENT_COVERAGE_RADIUS * 2;
    const tint = ENVIRONMENT_MODE_COLORS[mode] || '#9aa0a8';
    // Two buildings placed to overlap: the plots shown are one of the three zones they make, in
    // a frame with this building at the origin and its partner dx tiles along and dy tiles up.
    const dx = unit && unit.partner ? unit.partner[1] : 0;
    const dy = unit && unit.partner ? unit.partner[2] : 0;
    const zone = unit && unit.partner ? unit.zone : null;
    const partnerSize = unit && unit.partner ? environmentBuildingSize(unit.partner[0]) : buildingSize;
    const partnerCenter = partnerSize / 2;
    const partnerMin = {
        x: partnerCenter - ENVIRONMENT_COVERAGE_RADIUS + dx,
        y: partnerCenter - ENVIRONMENT_COVERAGE_RADIUS + dy,
    };
    const viewWidth = Math.max(viewSize, partnerMin.x + coverageSize + margin - viewMin);
    const viewHeight = Math.max(viewSize, partnerMin.y + coverageSize + margin - viewMin);
    // Each building covers its own 9x9 square; this zone is the part of them that gives this
    // temperature: only the first's, only the second's, or where the two meet.
    const modes = unit && unit.pairModes ? unit.pairModes : null;
    const tintOf = m => ENVIRONMENT_MODE_COLORS[m] || '#9aa0a8';
    const shadeOf = (m, opacity) => (opacity * (ENVIRONMENT_MODE_SHADE[m] ?? 1)).toFixed(3);
    // Where the two coverage squares cross. It is always a rectangle; each building's own zone is
    // its square with that rectangle taken out, which is an L unless the buildings line up.
    const shared = {
        x: Math.max(coverageMin, partnerMin.x),
        y: Math.max(coverageMin, partnerMin.y),
        w: Math.min(coverageMin, partnerMin.x) + coverageSize - Math.max(coverageMin, partnerMin.x),
        h: Math.min(coverageMin, partnerMin.y) + coverageSize - Math.max(coverageMin, partnerMin.y),
    };
    const box = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}Z`;
    // A zone as one path: the shared rectangle on its own, or a square with it cut out (two
    // subpaths, which the even-odd rule reads as the difference).
    const zonePath = z => {
        if (z === 1) return box(shared.x, shared.y, shared.w, shared.h);
        const own = z === 2 ? box(partnerMin.x, partnerMin.y, coverageSize, coverageSize)
            : box(coverageMin, coverageMin, coverageSize, coverageSize);
        return `${own}${box(shared.x, shared.y, shared.w, shared.h)}`;
    };

    // Gridlines like the game's: stronger on whole tiles, very faint on the quarter tiles
    // facilities snap to.
    const gridLines = [];
    for (let t = Math.ceil(viewMin * 4) / 4; t <= viewMin + Math.max(viewWidth, viewHeight); t += 0.25) {
        // Every other tile line is a major one, in step with the 2x2 buildings.
        const cls = !Number.isInteger(t) ? 'quarter' : t % 2 === 0 ? 'tile major' : 'tile';
        if (t <= viewMin + viewWidth) {
            gridLines.push(`<line class="${cls}" x1="${t}" y1="${viewMin}" x2="${t}" y2="${viewMin + viewHeight}" />`);
        }
        if (t <= viewMin + viewHeight) {
            gridLines.push(`<line class="${cls}" x1="${viewMin}" y1="${t}" x2="${viewMin + viewWidth}" y2="${t}" />`);
        }
    }

    // Plots nearest the building first, each matched to a plan row of its facility type. On a
    // shared map every zone matches its own rows to its own plots.
    const distance = p => Math.hypot(p.x + p.size / 2 - buildingCenter, p.y + p.size / 2 - buildingCenter);
    const matchCrops = (plots, plotRows) => {
        const queue = {};
        plotRows.forEach(r => {
            if (!r.item_name) return;
            (queue[r.facility] = queue[r.facility] || []).push({ item: r.item_name, left: r.facility_count });
        });
        return [...plots].sort((a, b) => distance(a) - distance(b)).map(p => {
            const q = queue[p.facility];
            while (q && q.length && q[0].left <= 0) q.shift();
            if (!q || !q.length) return { ...p, crop: null };
            q[0].left--;
            return { ...p, crop: q[0].item };
        });
    };
    const assigned = zones ? zones.flatMap(z => matchCrops(z.layout, z.rows)) : matchCrops(layout, rows);
    const crops = [...new Set(assigned.map(p => `${p.facility}|${p.crop}`))];
    const cropsPerFacility = {};
    crops.forEach(key => {
        const facility = key.split('|')[0];
        cropsPerFacility[facility] = (cropsPerFacility[facility] || 0) + 1;
    });
    const numbered = Object.values(cropsPerFacility).some(n => n > 1);
    const numberOf = key => crops.indexOf(key) + 1;

    // A small inset keeps edge-touching plots visibly separate; purely cosmetic.
    const inset = 0.08;
    const rects = assigned.map(p => {
        const color = ENVIRONMENT_FACILITY_COLORS[p.facility] || '#888888';
        const size = p.size - inset * 2;
        const initials = numbered && p.crop
            ? `<text x="${p.x + p.size / 2}" y="${p.y + p.size / 2}" font-size="${Math.min(0.9, p.size * 0.4)}">${numberOf(`${p.facility}|${p.crop}`)}</text>`
            : '';
        return `<g class="env-plot" ${tipAttrs(p.facility, { detail: p.crop ? prettyItem(p.crop) : '', color })}>
            <rect x="${p.x + inset}" y="${p.y + inset}" width="${size}" height="${size}" rx="0.25" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="0.06" />${initials}</g>`;
    }).join('');

    const counts = {};
    assigned.forEach(p => {
        const key = `${p.facility}|${p.crop}`;
        counts[key] = (counts[key] || 0) + 1;
    });
    // What the colours mean: the coverage, then each crop with how many plots it gets here.
    const swatch = (color, label) => `
        <span class="env-legend-item">
            <span class="env-legend-swatch coverage" style="background:${color}33;border-color:${color}"></span>${label}
        </span>`;
    // On a shared map the heading already names both buildings and what they're set to; the
    // legend only has to say what the middle is and which crop is which.
    const coverageLegend = modes
        ? (zones
            ? []
            : [
                swatch(tintOf(modes[0]), `${building}: ${modes[0]}`),
                swatch(tintOf(modes[1]), `${unit.partner[0]}: ${modes[1]}`),
                swatch(tint, zone === 1 ? `${mode} where both reach` : `${mode}, this plan's plots`),
            ])
        : [swatch(tint, `${mode} coverage`)];
    const legend = coverageLegend.concat(Object.entries(counts).map(([key, n]) => {
        const [facility, crop] = key.split('|');
        // The number a plot carries in the diagram reads as part of the facility's name, as the
        // plots themselves do: "Farmland 1: Sugarcane".
        const named = `${facility}${numbered ? ` <b>${numberOf(key)}</b>` : ''}`;
        const name = crop && crop !== 'null' ? `${named}: ${prettyItem(crop)}` : named;
        return `
        <span class="env-legend-item">
            <span class="env-legend-swatch" style="background:${ENVIRONMENT_FACILITY_COLORS[facility] || '#888888'}"></span>${name} ×${n}
        </span>`;
    })).join('');

    return `
        <div class="env-diagram">
            <svg viewBox="${viewMin} ${viewMin} ${viewWidth} ${viewHeight}" role="img" aria-label="${building} layout, ${mode} coverage">
                <g class="env-grid">${gridLines.join('')}</g>
                <rect x="${coverageMin}" y="${coverageMin}" width="${coverageSize}" height="${coverageSize}"
                      fill="${modes ? tintOf(modes[0]) : tint}" fill-opacity="${shadeOf(modes ? modes[0] : mode, 0.12)}" />
                ${modes ? `<rect x="${partnerMin.x}" y="${partnerMin.y}" width="${coverageSize}" height="${coverageSize}"
                      fill="${tintOf(modes[1])}" fill-opacity="${shadeOf(modes[1], 0.12)}" />` : ''}
                ${rects}
                ${(zones || [{ mode, zone }]).map(z => {
                    const path = z.zone === null || z.zone === undefined
                        ? box(coverageMin, coverageMin, coverageSize, coverageSize)
                        : zonePath(z.zone);
                    const zoneTint = tintOf(z.mode);
                    return `<path class="env-coverage-top" d="${path}" fill-rule="evenodd"
                      fill="${zoneTint}" fill-opacity="${shadeOf(z.mode, 0.3)}" stroke="${zoneTint}" stroke-opacity="0.9" stroke-dasharray="0.35,0.25" stroke-width="0.1" />`;
                }).join('')}
                ${modes ? `<rect x="${coverageMin}" y="${coverageMin}" width="${coverageSize}" height="${coverageSize}" fill="none"
                      stroke="${tintOf(modes[0])}" stroke-opacity="0.55" stroke-width="0.07" />
                    <rect x="${partnerMin.x}" y="${partnerMin.y}" width="${coverageSize}" height="${coverageSize}" fill="none"
                      stroke="${tintOf(modes[1])}" stroke-opacity="0.55" stroke-width="0.07" />` : ''}
                <g class="env-building" ${tipAttrs(building, { detail: modes ? modes[0] : mode, color: modes ? tintOf(modes[0]) : tint })}>
                    <rect x="0.05" y="0.05" width="${buildingSize - 0.1}" height="${buildingSize - 0.1}" rx="0.3"
                          fill="${modes ? tintOf(modes[0]) : tint}" stroke="currentColor" stroke-opacity="0.6" stroke-width="0.08" />
                    ${environmentBuildingIcon(building, modes ? modes[0] : mode, buildingCenter, buildingCenter)}
                </g>
                ${unit && unit.partner ? `<g class="env-building" ${tipAttrs(unit.partner[0], { detail: modes ? modes[1] : mode, color: tintOf(modes ? modes[1] : mode) })}>
                    <rect x="${dx + 0.05}" y="${dy + 0.05}" width="${partnerSize - 0.1}" height="${partnerSize - 0.1}" rx="0.3"
                          fill="${modes ? tintOf(modes[1]) : tint}" stroke="currentColor" stroke-opacity="0.6" stroke-width="0.08" />
                    ${environmentBuildingIcon(unit.partner[0], modes ? modes[1] : mode, dx + partnerCenter, dy + partnerCenter)}
                </g>` : ''}
            </svg>
            <div class="env-legend">${legend}</div>
        </div>
    `;
}

// List each facility once, with its recipes underneath. Environment diagrams show
// which crops share a physical Heat Furnace, Cooling Unit or Sunlamp.
function renderFacilityPlan(plan) {
    const container = document.getElementById('facility-plan-container');
    const steps = redistributeTurnFacilityRows(
        plan.coin_items || [],
        facility => tierCount(lastPlanInput?.facilities?.[facility]),
        takesTurns
    );

    if (steps.length === 0) {
        container.innerHTML = '<p class="hint">Nothing profitable to produce with the current facilities.</p>';
        document.getElementById('plan-facility-empty').hidden = true;
        return;
    }

    const envGroups = new Map();
    steps.forEach(step => {
        if (step.environment) {
            if (!envGroups.has(step.environment)) envGroups.set(step.environment, []);
            envGroups.get(step.environment).push(step);
        }
    });

    const assignments = plan.environment_assignments || [];
    // Split every mode's crops across the buildings covering them, then show one map per
    // building: two that overlap share a single map, since they're one place on the homeland.
    const byMode = new Map();
    ENVIRONMENT_MODE_ORDER.filter(mode => envGroups.has(mode)).forEach(mode => {
        byMode.set(mode, splitByEnvironmentUnit(envGroups.get(mode), assignments.filter(a => a.mode === mode)));
    });
    const pairs = new Map();
    const singles = [];
    byMode.forEach((units, mode) => {
        units.forEach(unit => {
            if (!unit.partner) {
                singles.push({ mode, unit });
                return;
            }
            const key = unit.pairKey;
            if (!pairs.has(key)) pairs.set(key, { unit, zones: [] });
            pairs.get(key).zones.push({ mode, layout: unit.layout, rows: unit.rows, zone: unit.zone });
        });
    });

    const pairSections = [...pairs.values()].map(({ unit, zones }) => {
        zones.sort((a, b) => a.zone - b.zone);
        const modes = unit.pairModes || [unit.mode, unit.mode];
        const middle = zones.find(z => z.zone === 1)?.mode;
        return `
            <article data-search="${escapeText([unit.building, unit.partner[0], ...modes, middle,
                ...zones.flatMap(z => z.rows.map(row => prettyItem(row.item_name)))].filter(Boolean).join(' '))}">
                <h4 class="facility-category-title">${unit.building} ${modeTag(modes[0])}<span class="env-head-sep">|</span>${unit.partner[0]} ${modeTag(modes[1])}</h4>
                <div class="env-unit">
                    ${renderEnvironmentDiagram(zones.flatMap(z => z.layout), zones[0].mode, unit.building, zones.flatMap(z => z.rows), unit, zones)}
                </div>
            </article>
        `;
    }).join('');

    const modeSections = ENVIRONMENT_MODE_ORDER.map(mode => {
        const units = singles.filter(s => s.mode === mode).map(s => s.unit);
        return units.map((unit, i) => `
            <article data-search="${escapeText([unit.building, mode, ...unit.rows.map(row => prettyItem(row.item_name))].filter(Boolean).join(' '))}">
                <h4 class="facility-category-title"><span>${unit.building}</span>${units.length > 1 ? ` ${i + 1}` : ''} ${modeTag(mode)}</h4>
                <div class="env-unit">${renderEnvironmentDiagram(unit.layout, mode, unit.building, unit.rows, unit)}</div>
            </article>
        `).join('');
    }).join('');
    const environmentSections = pairSections + modeSections;

    const materials = [];
    const other = [];
    for (const step of steps) {
        const category = FACILITY_CATEGORY_BY_NAME.get(step.facility);
        (category === 'Materials' || category === 'Aniimo Materials' ? materials : other).push(step);
    }
    container.innerHTML = facilityPlanCards(materials, plan, 'Raw material production', ['Farmland', 'Woodland', 'Mine'])
        + (environmentSections
        ? `<section class="production-section"><h3>Growing environments</h3>
            <div class="production-environment-grid">${environmentSections}</div></section>` : '')
        + facilityPlanCards(other, plan, 'Other buildings');
    filterFacilityPlan();
}

// Re-renders "Your Rate" from `lastPlan` at whichever unit is currently selected in the
// `#rate-unit` dropdown; called after a fresh plan and again whenever the user switches units, so
// switching units never needs a facility-allocation re-solve. `pickUnit` is for a fresh plan
// only: it chooses the unit the plan reads best at. Switching units must never do that, or the
// choice would be undone the moment it's made.
function updateRateDisplay(pickUnit = false) {
    if (!lastPlan || !lastPlan.success) return;
    const select = document.getElementById('rate-unit');
    const rows = priorityRows(lastPlan, true);
    // Step the unit up until the smallest rate reads at least 1 (Aniipods per hour, Rough Lumber
    // per hour, not 0.01 per second); a plain coin rate only needs to read above zero.
    const rates = rows.filter(r => r.target !== 'level_up' && r.perSecond > 1e-9).map(r => r.perSecond);
    const smallest = rates.length ? Math.min(...rates) : lastPlan.rate_per_second;
    const least = rates.length ? 1 : 0.05;
    while (pickUnit && smallest * RATE_UNIT_SECONDS[select.value].multiplier < least) {
        const next = { second: 'minute', minute: 'hour', hour: 'day' }[select.value];
        if (!next) break;
        select.value = next;
    }
    const { multiplier } = RATE_UNIT_SECONDS[select.value] || RATE_UNIT_SECONDS.second;
    const unitLabel = select.selectedOptions[0].textContent;
    document.getElementById('plan-rate').textContent = formatRate(lastPlan.rate_per_second * multiplier);
    document.getElementById('plan-rate-period').textContent = unitLabel;
    // Priorities: one row each, in the player's order, at the selected unit.
    const amount = formatRate;
    const body = rows.map(r => {
        if (r.target === 'level_up') {
            const seconds = lastPlan.level_up_preview?.seconds;
            const time = seconds === 0 ? 'Ready now' : seconds == null ? 'Not reached with this plan' : formatDuration(seconds);
            return `<tr${r.rank === 1 ? ' class="top"' : ''}><td>${r.rank ?? ''}</td><td>${r.label}</td><td>${time}</td></tr>`;
        }
        const why = r.perSecond <= 1e-9 ? r.missing || '' : '';
        // Aniimo EXP names the Growth items making it; an Aniipod row is already named by tier.
        const made = r.target === 'aniimo_exp'
            ? r.items.filter(([, n]) => n > 1e-9).map(([item, n]) => `${amount(n * multiplier)} ${prettyItem(item)}`).join(', ')
            : '';
        return `<tr${r.rank === 1 ? ' class="top"' : ''}>
            <td>${r.rank ?? ''}</td>
            <td>${r.label}${why || made ? `<span class="priority-rate-note">${why || made}</span>` : ''}</td>
            <td>${why ? 'none' : amount(r.perSecond * multiplier)}</td>
        </tr>`;
    }).join('');
    document.getElementById('priority-rates').innerHTML = `
        <table class="rate-table">
            <thead><tr><th scope="col">#</th><th scope="col">Priority</th><th scope="col">${escapeText(unitLabel)}</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

// A Priorities plan's rate rows, in the player's order: each priority, then coins from what's
// left if coins wasn't one of them. A priority the homeland can't make yet says why.
function priorityRows(plan, includeTime = false) {
    const missing = {
        aniimo_exp: planContext?.hasPolisher ? null : 'No Dance Pad Polisher yet',
        aniipods: planContext?.aniipod ? null : 'No Aniipod Maker yet',
    };
    const rows = (plan.priorities || []).map((p, i) => ({
        rank: i + 1,
        target: p.target,
        label: priorityLabel(p.target, planContext?.aniipod),
        perSecond: p.per_second,
        items: p.items || [],
        streams: p.streams || [],
        missing: missing[p.target] || null,
    })).filter(row => includeTime || row.target !== 'level_up');
    if (!rows.some(r => r.target === 'coins')) {
        rows.push({ rank: null, target: 'coins', label: rows.length ? "Home Coins, from what's left" : 'Home Coins', perSecond: plan.rate_per_second, items: [], missing: null });
    }
    // During the season, points come with every season item sold, ranked or not.
    if (plan.season_points != null && !rows.some(r => r.target === 'season_points')) {
        rows.push({ rank: null, target: 'season_points', label: planSeason().points, perSecond: plan.season_points, items: [], missing: null });
    }
    return rows;
}

// Re-renders every rate-unit-dependent display ("Your Rate" and the Product Breakdown table's
// Profit column) from the already-computed `lastPlan`/`lastGoalResult`; the `#rate-unit` change
// listener target, so switching units never needs a re-solve.
function updateRateUnitDisplays() {
    updateRateDisplay();
    renderImprovements();
    if (lastPlan && lastPlan.success) {
        renderSeedTable(lastPlan);
        renderLevelUp(lastPlan);
    }
    if (lastGoalResult) {
        renderProductBreakdown(lastGoalResult);
    }
}

// Render a successfully computed plan: rate summary + facility plan table. Goal-independent,
// called once per Calculate click (or facility/currency/module change), not on every goal
// keystroke.
function displayPlan(plan, keepLayout = false) {
    const scheduleCard=document.getElementById('recipe-schedule-container');
    scheduleCard.innerHTML=renderRecipeSchedule(plan.recipe_schedule,{itemName:prettyItem,buildingIcon:facilityIconUrl,buildingName:b=>`${translate(b.facility)} #${b.id.split(':').at(-1)}`});
    if(!plan.recipe_schedule&&plan.recipe_switching_note){const note=document.createElement('p');note.className='hint';note.textContent=plan.recipe_switching_note;scheduleCard.append(note);}
    const resultsSection = document.getElementById('results-section');
    const errorEl = document.getElementById('error-message');
    const resultsContent = document.getElementById('results-content');
    const goalSection = document.getElementById('goal-section');

    resultsSection.style.display = 'block';

    if (!plan.success) {
        goalSection.style.display = 'none';
        if (selectedSetupTab() === 'custom') {
            showRosterShortfall();
            errorEl.textContent = plan.error || 'No plan found with these Aniimo.';
            errorEl.style.display = 'block';
            return;
        }
        showError(plan.error || 'An unknown error occurred.');
        showSetupOnly();
        return;
    }

    errorEl.style.display = 'none';
    resultsContent.style.display = 'block';
    const power = document.getElementById('power-used');
    power.hidden = plan.power_used == null;
    power.textContent = plan.power_used == null ? '' : translate('E-mode load: {draw} W · Generation: {output} W · Supply: 120%')
        .replace('{draw}', formatNumber(plan.power_used)).replace('{output}', formatNumber(plan.power_generated ?? 0));
    resultsContent.classList.remove('setup-only');
    // A level-up plan's own card says how long it takes; the goal is for coin plans.
    goalSection.style.display = plan.level_up ? 'none' : 'block';

    updateRateDisplay(!rateUnitChosen);
    renderGoalTargets(plan);
    renderHomelandLayout(plan, keepLayout);

    // Said only when the plan might not be the best: the solver ran out of time, or the backup
    // planner made it.
    const explored = document.getElementById('plan-explored-hint');
    const materialHint = document.getElementById('material-work-hint');
    materialHint.hidden = !plan.material_work_note;
    materialHint.textContent = !plan.material_work_note ? ''
        : plan.material_work_note === 'unavailable' ? translate('The production plan is valid. The extra Bench and Kiln workload could not be optimized in time.')
        : translate('Bench and Kiln workload is the best found in the time allowed; its maximum is not proven.');
    explored.style.display = plan.proven_optimal === true ? 'none' : '';
    if (plan.proven_optimal === true) {
        explored.textContent = '';
    } else if (plan.proven_optimal === false && plan.upper_bound > 0) {
        const gap = Math.max(0, (plan.upper_bound - plan.rate_per_second) / plan.upper_bound * 100);
        explored.textContent = `Best plan found in the time allowed; the best possible is at most ${gap.toFixed(1)}% higher.`;
    } else {
        const reason = plan.fallback_reason ? ` (${plan.fallback_reason})` : '';
        explored.textContent = `The exact planner couldn't run${reason}, so this plan comes from the backup planner and may not be the very best. Reloading the page usually fixes this.`;
    }

    const unverifiedEl = document.getElementById('plan-unverified');
    const unverified = plan.unverified || [];
    unverifiedRowKeys = new Set(unverified.map(u => `${u.facility}|${u.item_name}`));
    if (unverified.length) {
        unverifiedEl.textContent = `${unverified.length} recipe${unverified.length === 1 ? '' : 's'} in this plan ${unverified.length === 1 ? "hasn't" : "haven't"} been checked in game yet (tagged below). If any of those numbers are off, so is this plan.`;
        unverifiedEl.style.display = 'block';
    } else {
        unverifiedEl.style.display = 'none';
    }

    const skippedEl = document.getElementById('plan-skipped');
    const skipped = planContext?.skipped || [];
    skippedEl.style.display = skipped.length ? 'block' : 'none';
    skippedEl.textContent = skipped.length ? `Skipping ${skipped.map(prettyItem).join(', ')}.` : '';

    renderSeedTable(plan);
    renderLevelUp(plan);
    renderProfitBreakdown(plan);
    renderFacilityPlan(plan);
    renderAniimoSummary(plan);
    announcePlanner('Plan ready. Use Results to jump to a section.');
    // The page stays where the player is; the results appear without scrolling to them.
}

// Render a time-to-goal result: Total Time / Amount Produced summary + Product Breakdown. Called
// live on every goal-field keystroke once a plan exists; cheap, no facility-allocation re-solve.
function displayGoal(goalResult) {
    if (!goalResult.success) {
        lastGoalResult = null;
        document.getElementById('total-time').textContent = '-';
        document.getElementById('amount-produced').textContent = '-';
        document.getElementById('product-breakdown-section').style.display = 'none';
        document.getElementById('seeds-needed-section').style.display = 'none';
        console.warn('Goal calculation failed:', goalResult.error);
        return;
    }

    lastGoalResult = goalResult;
    document.getElementById('total-time').textContent = goalResult.total_time_seconds > 0 ? formatDuration(goalResult.total_time_seconds) : '0m';
    document.getElementById('amount-produced').textContent = formatNumber(goalResult.amount_produced);

    renderProductBreakdown(goalResult);
    renderSeedsNeeded(goalResult);
}

// Solve for the best achievable plan (facilities + currency + modules); the heavier computation,
// triggered explicitly by the Calculate button or Enter in a facility/module field.
async function runFindPlan() {
    reactiveDispatch = {};
    travelRefinements = 0;
    movementDistances = {};
    movementDefaultDistance = 20;
    haulingSeconds = {};
    haulingDefaultSeconds = 0;
    haulingRefinements = 0;
    const invalid = seasonActive() && document.querySelector('#season-crop-minimum-fields input:invalid');
    if (invalid) {
        openPlannerEditor('season');
        invalid.reportValidity();
        return;
    }
    if (!wasmReady) {
        showError('Optimizer not ready. Please wait...');
        return;
    }
    const btn = document.getElementById('optimize-btn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoading = btn.querySelector('.btn-loading');
    const progressBar = document.getElementById('progress-bar-container');
    const progressFill = document.getElementById('progress-bar-fill');
    const progressCaption = document.getElementById('progress-bar-caption');

    btn.disabled = true;
    const previousError = document.getElementById('error-message');
    previousError.style.display = 'none';
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline';
    // The progress card below the button follows each step; the bar only shows if the backup
    // planner runs, since that one counts its trials.
    progressBar.style.display = 'none';
    progressCaption.style.display = 'none';
    progressFill.style.width = '';

    const runId = ++planRunId;
    let requestedSetup = null;
    plansBySetup = {};
    rankingsBySetup = {};
    stopRanking();
    ranking = null;
    renderImprovements();
    stopSetupSolve();
    stopLayout();
    if (pendingWorkerRequests.size > 0) restartWorker();
    try {
        const input = getPlanInputValues();
        const rvTarget = input.level_up ?? input.level_up_preview;
        lastPlanInput = input;
        planContext = {
            target: levelUpTarget(),
            unavailable: levelUpUnavailable(),
            ready: !!(rvTarget && rvTarget.cost.every(([name, need]) =>
                (rvTarget.stock.find(([item]) => item === name)?.[1] ?? 0) >= need)),
            aniipod: wantsAniipods() ? bestAniipod() : null,
            hasPolisher: (input.facilities['Dance Pad Polisher'] || []).some(t => t.count > 0),
            // Only what the player skipped; locked special recipes are the default, not news.
            skipped: [...skippedRecipes].sort((a, b) => prettyItem(a).localeCompare(prettyItem(b))),
            simple: isSimpleMode(),
            // The season the plan used, if any, so its currency and points keep their names.
            season: input.season,
        };
        startProgress(input, runId);

        // Runs in the worker (see worker.js); the main thread stays free to paint the progress
        // bar above for however long this takes, instead of freezing. `onTrialProgress` receives
        // the solver's own real, running trial-solve count after every trial solve; converted to
        // a fill percentage by `trialCountToPercent` below.
        // Only the backup planner reports progress (see worker.js); the exact planner is quick.
        // Solve the selected team first; other teams wait until requested.
        const bestSetup = selectedAniimoSetup();
        requestedSetup = bestSetup;
        mainSolve = { setup: bestSetup, runId };
        Object.assign(input, aniimoInput(bestSetup));
        const bestJson = await callWorker('find_plan', JSON.stringify({ ...input, aniimo: bestSetup }), (count) => {
            // The exact planner reports each solve; the backup planner counts its trials.
            if (typeof count === 'object') {
                setStep(count.step, count.state, undefined, count.proven);
                return;
            }
            setStep('backup', 'start', `trial ${count}`);
            progressBar.style.display = 'block';
            progressFill.style.width = `${trialCountToPercent(count)}%`;
        });
        progressFill.style.width = '100%';
        if (runId !== planRunId) return;
        finishSolveSteps();
        plansBySetup[bestSetup] = JSON.parse(bestJson);
        mainSolve = null;
        showSelectedPlan();
        // With no plan there's nothing to lay out or improve on.
        if (!plansBySetup[bestSetup].success && progress) {
            progress.steps.forEach(s => { if ((s.key === 'layout' || s.key === 'improve') && s.state === 'pending') s.state = 'skipped'; });
            renderProgress();
        }

        // Other teams are solved on demand when selected or copied into My Aniimo.
    } catch (error) {
        // A run a newer one cancelled leaves the screen to it.
        if (runId !== planRunId) return;
        if (requestedSetup && requestedSetup !== selectedAniimoSetup()) return;
        if (progress) {
            progress.steps.forEach(s => { if (s.state === 'running') s.state = 'fail'; else if (s.state === 'pending') s.state = 'skipped'; });
            renderProgress();
        }
        console.error('Plan calculation error:', error);
        lastPlan = null;
        document.getElementById('aniimo-pending').style.display = 'none';
        showError(`Plan calculation failed: ${error.message}`);
    } finally {
        if (mainSolve?.runId === runId) mainSolve = null;
        if (runId === planRunId && !layoutWorker && !setupSolve) resetPlanButton();
    }
}

// Puts the Find the best plan button back once a run is over or called off.
function resetPlanButton() {
    const btn = document.getElementById('optimize-btn');
    btn.disabled = !wasmReady;
    btn.querySelector('.btn-text').style.display = 'inline';
    btn.querySelector('.btn-loading').style.display = 'none';
    document.getElementById('progress-bar-container').style.display = 'none';
    document.getElementById('progress-bar-caption').style.display = 'none';
    document.getElementById('progress-bar-fill').classList.remove('indeterminate');
}

// Takes the plans off the page and calls off any still being worked out, for an input change that
// makes them wrong rather than just out of date (another season: its items, currency and points
// would be shown under the new one's names). Bumping `planRunId` makes a run in flight drop its
// results when they land.
function clearPlanResults() {
    planRunId++;
    plansBySetup = {};
    rankingsBySetup = {};
    lastPlan = null;
    lastPlanInput = null;
    lastGoalResult = null;
    planContext = null;
    refreshRosterTileWorkloads();
    stopRanking();
    stopSetupSolve();
    stopLayout();
    if (pendingWorkerRequests.size > 0) restartWorker();
    progress = null;
    renderProgress();
    resetPlanButton();
    document.getElementById('results-section').style.display = 'none';
    announcePlanner('');
}

// Compute time-to-goal against the already-computed `lastPlan`; cheap, safe to call on every
// keystroke of the goal-amount fields. No-op until a plan exists.
async function runTimeToGoal() {
    if (!lastPlan || !lastPlan.success) return;
    const rows = priorityRows(lastPlan);
    const chosen = rows.find(r => r.target === document.getElementById('goal-target').value) || rows[0];
    const name = goalName(chosen);
    document.getElementById('target-amount-label').textContent = `Target ${name}`;
    document.getElementById('current-amount-label').textContent = `Current ${name}`;
    document.getElementById('amount-produced-label').textContent = `${name} produced`;

    const target = floatOrDefault(document.getElementById('target-amount').value, 0);
    const current = floatOrDefault(document.getElementById('current-amount').value, 0);

    if (chosen.target === 'coins') {
        // Coins account for each product's start-up delay and list what's sold along the way.
        try {
            const resultJson = await callWorker('time_to_reach', JSON.stringify({ plan: lastPlan, target, current }));
            const result = JSON.parse(resultJson);
            displayGoal(result);
            renderGoalAlso(rows, chosen, result.success ? result.total_time_seconds : null, result);
        } catch (error) {
            console.error('Goal calculation error:', error);
        }
        return;
    }
    // Anything else waits on each item's first batch too (see `madeBy`). The breakdown covers
    // that long.
    const needed = Math.max(0, target - current);
    const seconds = needed <= 0 ? 0 : chosen.perSecond <= 1e-12 ? null : timeToMake(chosen, needed);
    if (seconds === null) {
        lastGoalResult = null;
        document.getElementById('total-time').textContent = chosen.missing || 'Not made by this plan';
        document.getElementById('amount-produced').textContent = '-';
        document.getElementById('product-breakdown-section').style.display = 'none';
        document.getElementById('seeds-needed-section').style.display = 'none';
        renderGoalAlso(rows, chosen, null);
        return;
    }
    try {
        const result = JSON.parse(await callWorker('time_to_reach', JSON.stringify({ plan: lastPlan, seconds })));
        displayGoal(result);
        document.getElementById('amount-produced').textContent = formatNumber(Math.round(needed));
        renderGoalAlso(rows, chosen, seconds, result);
    } catch (error) {
        console.error('Goal calculation error:', error);
    }
}

// How much of a rates row the plan has made after `seconds`: each item counts from its first batch
// on (see `production_over` in optimizer.rs, which does the same for Home Coins). Season points
// not ranked as a priority come from the income streams, which carry each item's points.
function madeBy(row, seconds) {
    const streams = row.streams?.length ? row.streams
        : row.target === 'season_points'
            ? (lastPlan?.income_streams || []).map(s => [(s.points || 0) * s.units_per_second, s.lead_time_seconds])
            : [[row.perSecond, 0]];
    return streams.reduce((sum, [rate, lead]) => sum + rate * Math.max(0, seconds - lead), 0);
}

// Seconds until the plan has made `needed` of a rates row, or null if it never does.
function timeToMake(row, needed) {
    let lo = 0;
    let hi = 3600;
    while (madeBy(row, hi) < needed) {
        hi *= 2;
        if (hi > 1e10) return null;
    }
    for (let i = 0; i < 100; i++) {
        const mid = (lo + hi) / 2;
        if (madeBy(row, mid) >= needed) hi = mid; else lo = mid;
    }
    return hi;
}

// What else the plan makes by the time the goal is met, e.g. "4.6M Home Coins, 39 Aniipod Mega",
// each counted from its first batch as the goal itself is.
function renderGoalAlso(rows, chosen, seconds, result) {
    const el = document.getElementById('goal-also');
    const made = r => r.target === 'coins' && result?.success ? result.amount_produced : madeBy(r, seconds);
    const also = seconds > 0
        ? rows.filter(r => r !== chosen && r.perSecond > 1e-12)
            .map(r => `${formatNumber(Math.floor(made(r)))} ${goalName(r)}`)
        : [];
    el.style.display = also.length ? 'block' : 'none';
    el.innerHTML = also.length ? `<span>By then you'll also have:</span> <strong>${also.join(', ')}</strong>` : '';
}

// --- Facility recipe reference modal ----------------------------------------------------
// A static reference table of every recipe in the game data, grouped by facility. Unlike the
// facility input cards, this isn't tied to owned facility counts or levels; it just lists what's
// possible to unlock. Recipe data comes from `get_all_items()` (see wasm.rs), which dumps every
// `ProductionItem` unfiltered.

const RECIPE_MODULE_LABELS = {
    ecological_module: 'Ecological Module',
    kitchen_module: 'Kitchen Module',
    resource_detector: 'Resource Detector',
    crafting_module: 'Crafting Module',
};

// Cached after the first render, since the underlying data never changes for a given wasm build.
let recipesRendered = false;

// Mirrors the Rust `format_time` helper in wasm.rs (hours/minutes/seconds, dropping leading
// zero units) so times read the same way here as they would in-game.
function formatRecipeTime(seconds) {
    const total = Math.round(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
}

function formatRecipeInputs(recipe) {
    if (recipe.raw_materials && recipe.raw_materials.length > 0) {
        const amounts = recipe.required_amount || [];
        return recipe.raw_materials
            .map((mat, i) => `${amounts[i] ?? '?'}× ${prettyItem(mat)}`)
            .join(', ');
    }
    if (recipe.cost && recipe.cost > 0) {
        return `Plant cost: ${recipe.cost}`;
    }
    return '-';
}

function formatRecipeYield(recipe) {
    let text = `${recipe.yield_amount}`;
    if (recipe.byproduct) {
        const [name, amount] = recipe.byproduct;
        text += ` <span class="hint small">(+${amount} ${name})</span>`;
    }
    return text;
}

// "Fire Lv.2+, best Lv.4 Practical": the minimum ability level a recipe accepts, then the best
// Aniimo for it. Crops and trees list the ability of each job (sowing, reaping and so on).
function formatRecipeAniimo(recipe, facility) {
    if (!recipe.aniimo) {
        const jobs = [];
        (recipe.jobs || []).forEach(job => {
            const last = jobs[jobs.length - 1];
            // Watering is listed once per time it happens; show it as one job done twice.
            if (last && last.job[0] === job[0]) last.times += 1;
            else jobs.push({ job, times: 1 });
        });
        if (jobs.length === 0) return '-';
        return `<span class="job-list">${jobs.map(({ job: [step, ability, level], times }) =>
            `<span class="job"><span class="job-step">${step}${times > 1 ? ` &times;${times}` : ''}</span> ${abilityTag(ability)}${level > 1 ? ` Lv.${level}+` : ''}</span>`).join('')}</span>`;
    }
    const [ability, minLevel] = recipe.aniimo;
    const best = `best Lv.${bestAniimoLevel(ability)}${facility.personality ? ' ' + facility.personality : ''}`;
    return `<span>${abilityTag(ability)} Lv.${minLevel}+<span class="recipe-best">${best}</span></span>`;
}

// "44 Home Coins", or what a level-up material is for.
function formatRecipeSell(recipe) {
    if (recipe.sell_currency === 'none') return '<span class="hint small">RV level-ups</span>';
    return `${formatNumber(recipe.sell_value)} ${recipe.sell_value === 1 ? 'Home Coin' : 'Home Coins'}`;
}

function formatRecipeModule(recipe) {
    if (!recipe.module_requirement) return '-';
    const [name, level] = recipe.module_requirement;
    const label = RECIPE_MODULE_LABELS[name] || name;
    return `${label} Lv.${level}`;
}

// Renders one table per facility (grouped into category sections, same grouping/order as the
// facility input cards), each listing every recipe available at that facility sorted by required
// level then name.
function renderRecipeTables(recipes) {
    const container = document.getElementById('facilities-modal-container');

    const byFacility = new Map();
    recipes.forEach(r => {
        if (!byFacility.has(r.facility)) byFacility.set(r.facility, []);
        byFacility.get(r.facility).push(r);
    });
    byFacility.forEach(list => {
        list.sort((a, b) => a.facility_level - b.facility_level || a.name.localeCompare(b.name));
    });

    container.innerHTML = FACILITY_CATEGORIES.map(category => {
        const facilitiesInCategory = FACILITIES.filter(f => f.category === category && byFacility.has(f.name));
        if (facilitiesInCategory.length === 0) return '';

        const tables = facilitiesInCategory.map(f => {
            // `data-label` names each cell when rows stack on phones; empty cells are left out there.
            const cell = (label, value) => `<td data-label="${label}"${value === '-' ? ' class="empty"' : ''}>${value}</td>`;
            // A season item's tag: muted once its event has ended, still listed for reference.
            const seasonTag = season => season.over
                ? ` <span class="tag ended" title="${season.name} has ended; these are no longer available">season</span>`
                : ` <span class="tag special" title="${season.name} only">season</span>`;
            // A row's classes: unchecked numbers, and items from an event that has ended.
            const rowClass = r => [r.verified === false && 'unverified', r.season && seasonById(r.season).over && 'ended']
                .filter(Boolean).join(' ');
            const rows = byFacility.get(f.name).map(r => `
                <tr${rowClass(r) ? ` class="${rowClass(r)}"` : ''}>
                    <td class="recipe-name">${prettyItem(r.name)}${SPECIAL_NAMES.has(r.name) ? ' <span class="tag special" title="Takes a rare currency to unlock">special</span>' : ''}${r.season ? seasonTag(seasonById(r.season)) : ''}${r.verified === false ? ' <span class="info-icon" data-tooltip="Not yet checked in game.">?</span>' : ''}</td>
                    ${cell('Level', r.facility_level)}
                    ${cell('Inputs', formatRecipeInputs(r))}
                    ${cell('Yield', formatRecipeYield(r))}
                    ${cell('Time', r.workload ? `${r.workload} workload` : formatRecipeTime(r.production_time))}
                    ${cell('Sell', formatRecipeSell(r))}
                    ${cell('Module', formatRecipeModule(r))}
                    ${cell('Aniimo', formatRecipeAniimo(r, f))}
                </tr>
            `).join('');

            return `
                <div class="facility-recipe-table">
                    <h4>${f.name}</h4>
                    <div class="table-wrapper">
                        <table class="recipe-table">
                            <thead>
                                <tr>
                                    <th>Item</th>
                                    <th>Level</th>
                                    <th>Inputs</th>
                                    <th>Yield</th>
                                    <th>Time <span class="info-icon" data-tooltip="Grow time for crops and trees, before watering takes an eighth off it twice. Everything else lists workload: at 100% Efficiency a processor gets through one workload a second, a gathering facility 1.25 on a level-2 recipe and 1.5 on a level-3 one. An Aniimo at the level a recipe needs works at 100%; higher levels are faster, up to level 4 (at a processor, 300% one level above, then +100% per level; at gathering facilities each level adds half a workload a second, reading as +50% on a level-1 recipe, +40% on a level-2 one and +33% on a level-3 one).">?</span></th>
                                    <th>Sell</th>
                                    <th>Module</th>
                                    <th>Aniimo <span class="info-icon" data-tooltip="The lowest ability level that can make this, and the best Aniimo for it: level 4, the top, with the facility's personality (+20% speed). For crops and trees, the ability each job needs, in order.">?</span></th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="facility-category">
                <h4 class="facility-category-title">${category}</h4>
                ${tables}
            </div>
        `;
    }).join('');
}

window.showFacilities = async function() {
    document.getElementById('facilitiesModal').classList.add('show');
    if (recipesRendered) return;
    if (!wasmReady) {
        document.getElementById('facilities-loading-hint').textContent = 'Optimizer not ready. Please wait...';
        return;
    }
    try {
        const recipesJson = await callWorker('get_all_items');
        const recipes = JSON.parse(recipesJson);
        renderRecipeTables(recipes);
        recipesRendered = true;
        document.getElementById('facilities-loading-hint').style.display = 'none';
    } catch (error) {
        console.error('Failed to load recipe data:', error);
        document.getElementById('facilities-loading-hint').textContent = 'Failed to load recipe data. Please refresh the page.';
    }
}

window.closeFacilities = function() {
    document.getElementById('facilitiesModal').classList.remove('show');
}

window.closeFacilitiesOnBackdrop = function(event) {
    if (event.target.id === 'facilitiesModal') {
        closeFacilities();
    }
}

// Event listeners
async function initApp() {
    let sharedData = null;
    try {
        sharedData = await readShareHash(window.location.hash);
    } catch (error) {
        document.getElementById('share-config-status').textContent = 'This share link is invalid. Your saved setup was kept.';
        console.warn('Could not load shared config:', error);
    }
    const sharedRoster = sharedData?.kind === 'roster';
    const savedData = sharedRoster ? {
        ...readStorage(), roster: sharedData.roster, rosterSlots: sharedData.rosterSlots,
    } : sharedData ? migrateSavedConfig(sharedData) : readStorage();
    initFacilityTiers(savedData);
    renderFacilityCards();
    populateHomeLevels();
    populateLevelUpTargets();
    initSeasonSelect();
    loadInputsFromStorage(savedData);
    attachAutoSave();
    attachFacilityTierHandlers();
    attachFacilitySearch();
    attachPlannerEditor();
    document.getElementById('plan-facility-search').addEventListener('input', filterFacilityPlan);
    attachModeHandlers();
    attachStrategyHandlers();
    attachSkipHandlers();
    renderSkippedRecipes();
    attachSpecialHandlers();
    renderSpecialRecipes();
    attachSeasonHandlers();
    attachElectricityHandlers();
    attachRosterHandlers();
    attachLayoutHandlers();
    attachPriorityHandlers();
    if (isSimpleMode()) fillBuildingInputs(selectedHomeLevel());
    renderBuildingSettings();
    renderStrategy();
    showAniimoSetup();
    initWasm();

    document.getElementById('optimize-btn').addEventListener('click', runFindPlan);
    document.getElementById('clear-saved-btn').addEventListener('click', clearSavedInputs);
    document.getElementById('share-config-btn').addEventListener('click', shareCurrentConfig);
    document.getElementById('improve-check-btn').addEventListener('click', () => {
        if (ranking) rankImprovementsFor(selectedAniimoSetup(), ranking.tab);
    });
    document.getElementById('improve-stop-btn').addEventListener('click', () => { stopRanking(); renderImprovements(); });
    const opportunities = document.getElementById('improve-card');
    new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting || !ranking || ranking.running || ranking.autoChecked || ranking.tab !== 'Aniimo'
            || !ranking.candidates.some(candidate => candidate.kind === 'Aniimo')) return;
        ranking.autoChecked = true;
        const shortlist = ranking.candidates.flatMap((candidate, index) => candidate.kind === 'Aniimo' && !ranking.results[index] ? [index] : []);
        rankImprovementsFor(selectedAniimoSetup(), shortlist.slice(0, 4));
    }).observe(opportunities);
    opportunities.querySelector('.opportunity-tabs').addEventListener('click', event => {
        const tab = event.target.closest('[data-opportunity-tab]');
        if (!tab || !ranking) return;
        ranking.tab = tab.dataset.opportunityTab;
        renderImprovements();
    });
    document.getElementById('improve-list').addEventListener('click', event => {
        const button = event.target.closest('[data-opportunity-check]');
        if (button && ranking) rankImprovementsFor(selectedAniimoSetup(), [Number(button.dataset.opportunityCheck)], button.hasAttribute('data-detailed'));
    });
    if (sharedRoster) {
        openPlannerEditor('team');
        const config = document.getElementById('roster-config');
        config.hidden = false;
        config.open = true;
        const save = config.querySelector('[data-roster="save-import"]');
        save.hidden = false;
        save.focus();
    } else if (sharedData) {
        document.getElementById('share-config-status').textContent = 'Shared setup loaded. Your saved setup is kept until you edit this one.';
    } else if (window.location.hash === '#roster-config') {
        jumpToPlannerSection('roster-config');
    }
    document.getElementById('rate-unit').addEventListener('change', () => {
        rateUnitChosen = true;
        updateRateUnitDisplays();
    });
    ['aniimo-best', 'aniimo-minimum', 'aniimo-custom'].forEach(id =>
        document.getElementById(id).addEventListener('change', () => {
            saveInputsToStorage();
            showAniimoSetup();
        }));
    document.getElementById('aniimo-toggle').addEventListener('click', () => {
        aniimoExpansionChosen = true;
        setAniimoExpanded(document.getElementById('aniimo-body').hidden);
    });
    // Best's level buttons are named `level-<ability>`; the roster editor handles its own.
    document.getElementById('ability-level-settings').addEventListener('change', event => {
        const { name, value, checked } = event.target;
        const unheardOf = event.target.dataset?.confirm;
        if (unheardOf && checked) {
            const ok = window.confirm(translate(
                `No level-${value} ${unheardOf} Aniimo is known in the game yet. Plan as though you have one?`
            ));
            if (!ok) {
                showAniimoSetup();
                return;
            }
        }
        if (name?.startsWith('level-')) {
            aniimoLevels[name.slice('level-'.length)] = Number(value);
        } else {
            return;
        }
        saveInputsToStorage();
        switchAniimoSetup();
    });

    // Goal fields update live; no need to re-run the facility-allocation solve just because the
    // goal amount changed.
    document.getElementById('target-amount').addEventListener('input', runTimeToGoal);
    document.getElementById('current-amount').addEventListener('input', runTimeToGoal);
    document.getElementById('goal-target').addEventListener('change', runTimeToGoal);

    // Allow Enter key to trigger a full plan recalculation; but not in the goal fields, which
    // already update live on every keystroke via the listeners above. Facility tier inputs are
    // excluded here since they're already covered by the delegated listener in
    // `attachFacilityTierHandlers` (their rows come and go, so a per-element listener attached
    // once at startup wouldn't reach a tier added later).
    document.querySelectorAll('input').forEach(input => {
        if (input.id === 'target-amount' || input.id === 'current-amount') return;
        if (input.closest('#facilities-grid, #planner-edit-quests, #roster-config') || input.id === 'skip-input') return;
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                runFindPlan();
            }
        });
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initApp);
else initApp();

// --- Hover tips --------------------------------------------------------------------------
// One card for hover tips, shown at once instead of after the browser's delay. Diagram pieces
// carry `data-tip` (see `tipAttrs`); anything else with a `title` shows it in the same card, the
// title moved aside so the browser's own tip doesn't show as well. (The info icons' `data-tooltip`
// is a CSS tip of its own; see style.css.)
const tipCard = document.createElement('div');
tipCard.className = 'tip-card';
tipCard.setAttribute('role', 'tooltip');
tipCard.hidden = true;
document.body.appendChild(tipCard);
let tipTarget = null;
const TIP_SELECTOR = '[data-tip], [data-tip-text], [title]';

// The attributes for a diagram piece's tip: its name, then what it's doing and its numbers.
function tipAttrs(title, { detail = '', stats = '', work = '', color = '' } = {}) {
    const attr = (name, value) => value ? ` ${name}="${escapeText(value)}"` : '';
    const label = [title, detail, stats, work].filter(Boolean).join(', ');
    return `data-tip="${escapeText(title)}"${attr('data-tip-detail', detail)}${attr('data-tip-stats', stats)}${attr('data-tip-work', work)}${attr('data-tip-color', color)} aria-label="${escapeText(label)}"`;
}

function productionWorkerTiles(worker) {
    return [...document.querySelectorAll('#roster-summary [data-work-member]')].filter(tile =>
        tile.dataset.workMember === worker.dataset.productionWorker
        && JSON.parse(tile.dataset.rosterTasks || '[]').some(([job]) =>
            job === worker.dataset.workerJob || job.endsWith(` · ${worker.dataset.workerItem}`)));
}

function showTip(el) {
    // A title set since the last hover replaces the one kept aside.
    if (el.hasAttribute('title')) {
        const text = sourceAttribute(el, 'title');
        el.removeAttribute('title');
        el.dataset.tipText = text;
        if (!el.hasAttribute('aria-label')) el.setAttribute('aria-description', text);
    }
    if (!el.dataset.tip && !el.dataset.tipText) return hideTip();
    const line = (className, text) => {
        const div = document.createElement('div');
        div.className = className;
        div.textContent = text;
        return tipCard.appendChild(div);
    };
    tipCard.replaceChildren();
    tipCard.classList.toggle('has-swatch', !!el.dataset.tipColor);
    if (el.dataset.tip) {
        const title = line('tip-title', el.dataset.tip);
        if (el.dataset.tipColor) {
            const swatch = document.createElement('span');
            swatch.className = 'tip-swatch';
            swatch.style.background = el.dataset.tipColor;
            title.prepend(swatch);
        }
        if (el.dataset.productionWorker != null) {
            for (const tile of productionWorkerTiles(el)) {
                renderAssignmentDetails(line('roster-work-details', ''), tile, 5);
            }
        } else if (el.dataset.rosterTasks != null) {
            renderAssignmentDetails(line('roster-work-details', ''), el, 5);
        } else {
            if (el.dataset.tipDetail) line('tip-detail', el.dataset.tipDetail);
            if (el.dataset.tipWork) line('tip-work', el.dataset.tipWork);
            if (el.dataset.tipStats) line('tip-stats', el.dataset.tipStats);
        }
    } else {
        line('tip-text', translate(el.dataset.tipText));
    }
    tipTarget = el;
    tipCard.hidden = false;
}

function hideTip() {
    tipTarget = null;
    tipCard.hidden = true;
}

document.addEventListener('aniimax-language-change', hideTip);

// Above the point, centered on it and kept on screen; below it where there's no room above.
function placeTip(x, y, below = y) {
    const margin = 12;
    const { width, height } = tipCard.getBoundingClientRect();
    const left = Math.min(Math.max(margin, x - width / 2), window.innerWidth - width - margin);
    const top = y - height - 14 >= margin ? y - height - 14 : Math.min(below + 18, window.innerHeight - height - margin);
    tipCard.style.left = `${left}px`;
    tipCard.style.top = `${top}px`;
}

document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.(TIP_SELECTOR);
    if (!el) return hideTip();
    if (el !== tipTarget || el.hasAttribute('title') || el.hasAttribute('data-roster-tile')) showTip(el);
    if (tipTarget) placeTip(e.clientX, e.clientY);
});
document.addEventListener('pointermove', (e) => {
    if (!tipTarget) return;
    if (!tipTarget.isConnected) return hideTip();
    placeTip(e.clientX, e.clientY);
}, { passive: true });
// A tap's tip stays until the next tap; a mouse's goes when it leaves.
document.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'touch' && tipTarget && !tipTarget.contains(e.relatedTarget)) hideTip();
});
document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.(TIP_SELECTOR);
    if (!el || !e.target.matches(':focus-visible')) return;
    showTip(el);
    const box = el.getBoundingClientRect();
    if (tipTarget) placeTip(box.left + box.width / 2, box.top, box.bottom);
});
document.addEventListener('focusout', hideTip);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideTip();
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-production-worker]')) {
        event.preventDefault();
        event.target.click();
    }
});
window.addEventListener('scroll', hideTip, { passive: true, capture: true });
