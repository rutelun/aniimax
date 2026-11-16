# Fast layout search

Goal: approach the best known feasible placement quickly across supported RV levels and configurations. The user has postponed global-optimality certification.

The corrected RV15 reference has delivery cost 452.05864535348496; the current browser path produces 507.67736599832125 in 13.75 seconds on this machine. These costs use Lv4 hauling weights and must not be compared with the old Lv3 objective.

Approach: preserve search candidates while accelerating geometry and power checks first, then measure joint storage/building search. Do not replace optimization with a timeout or embed the user's placement as a solution. Exact offline solving remains a source of reference placements, not a browser dependency.

- [x] Record reproducible input, objective, validity and elapsed time for the worker.
- [x] Remove repeated geometry and scoring work without changing candidate ordering or acceptance.
- [ ] Compare against the baseline and independently validate power, climate, land and inventory.
- [ ] Improve joint neighborhoods and benchmark supported RV levels and all four layout styles.
- [ ] Report measured quality gaps and timings; do not claim global or universal guarantees.

No deployment is requested in this turn.

## First measured iteration

Power placement now reuses summed-area containment checks and rejects generator candidates whose cost cannot beat the incumbent before checking their geometry. The complete RV15 worker output is deep-equal to the saved baseline. Measured delivery runtime changed from 13.75 s to 10.85 s, and 9.05 s in a subsequent run; timing varies with warmup and machine load. Delivery cost remains 507.67736599832125, so the quality target is NOT achieved.

50 focused tests pass, including exhaustive generator placement comparisons on 20 land sizes. These synthetic land cases are not a full RV1–20 production benchmark. All three grouped modes were also timed on the captured configuration, but all fell back to delivery due to space: that measurement does not establish grouped-layout quality.

Reproduction: `node scripts/benchmark-layout.mjs target/user-current-layout-input-lv4.json --styles --output target/fast-layout-first-pass.json`.

Experiments kept outside the app: deterministic annealing improved cost to 496.07 but added 2.93 s; allowing climate groups into the storage displacement search took 14.72 s without improvement. Neither is enabled in the application. The nine-tree climate group accounts for 28.11 of the 55.62 reference gap; joint cluster/storage construction remains the next quality task.

## WASM search, 2026-11-16

The delivery worker now constructs a generic seed, then calls a bounded Rust/WASM annealing kernel. It jointly moves producers, climate sources and their paired partner, storage units and power relays. Temporary collisions are penalized during exploration; only collision-free incumbents are returned. Land, climate and rooted electrical coverage remain hard constraints. No saved user coordinates are embedded. An unsupported input, incomplete seed, missing WASM export or staffing check failure falls back to the earlier worker search. Grouped layouts keep their grouping constraints and existing search; their delivery fallback uses the new kernel.

Five million iterations at the original temperature found **447.9128420998466** on the corrected Lv4 user input. The complete integrated worker took **2.20–2.24 seconds**, including initial placement and WASM loading. The old offline reference was 452.05864535348496; the previous new JS experiment took roughly 10 seconds for 450.3162876652967. Smaller iteration counts do not monotonically imply worse results because they also change the annealing schedule.

Independent certificate validation passed for 100 members, five stores and 12 poles. Capacity validation retained production rate 57.578045717368 with no additional couriers. The final estimate has 28 active copies and one assumed copy; this geometric objective does not claim to minimize worker count or prove game scheduler behavior.

The first generic matrix found a 9% gap to long search on an RV6 tree-heavy workload. A fixed temperature under-explored expensive producer moves. The temperature now uses the weight-weighted median (divided by three, with a minimum of one). That case improved to 299.38378841491004 versus 299.37513446225887 for a 16-million-iteration reference. The user input retains temperature one and its exact result.

Across RV 3, 6, 9, 12, 15, 18 and 20, two synthetic activity patterns using real land unlocks, building footprints, inventory and power/storage caps all improve on the old worker. Complete times range from about 0.8 to 3.1 seconds. These are **not** fourteen actual solved production plans. Two other captured RV15 production inputs also improve: 700.8418 → 651.4224 and 129.5625 → 124.6503. Geometry/determinism/incumbent tests cover RV1–20, plus paired climates, sensitivity and electrical connectivity.

Reproduction:

```powershell
./scripts/build-fast-wasm.ps1
node --test tests/fast_layout_wasm.test.mjs
node scripts/bench-fast-layout.mjs target/user-current-layout-input-lv4.json
node scripts/bench-layout-rv-matrix.mjs
node scripts/benchmark-layout.mjs target/user-current-layout-input-lv4.json --styles --output target/fast-worker-all-styles.json
```

The local WASM benchmark build is in `target/fast-wasm`; browser bindings were regenerated in ignored `web/pkg`. Nothing has been published or pushed in this task. The worst large-RV cases and grouped search still exceed two seconds; universal best-known quality and a global optimum are not certified.

## Follow-up research after deployment

Commit `dda287d` was published successfully in Actions run `43862800908`. The following experiments are **not enabled on the site**.

- A sequential offline portfolio of 16 annealing restarts, eight million proposals each, improved the validated incumbent from 447.9128420998466 to 444.89705272407787. Independent restarts from the generic seed were less effective than continuing the incumbent.
- Exact local neighborhood searches improved first to 444.8655818675901 (forest) and then to 444.71065923585616 (mixed climate group). Their local lower bounds are not global bounds.
- Full-domain CP-SAT search with the verified packing certificate, homogeneous cuts and a complete incumbent hint found **444.19196527961367**. The two solves lasted 55.03 and 47.00 seconds, excluding model construction. Status remains `FEASIBLE`; the global lower bound remains **428.447387**. The gap is approximately **3.54% of the incumbent**, not a claim that that improvement is attainable.
- The final candidate passed independent land, nonoverlap, inventory, climate and power validation, plus production/courier validation. It retains 100 members, five stores, 12 poles and production rate 57.578045717368, with no additional couriers. Proof artifacts: `target/global-proof-fast-incumbent.json`, its `.candidate.json`, and `target/global-fast-incumbent-validated.json`.
- Experimental rigid climate-group/store translation and rotation passes preserve constraints, but did not improve either captured incumbent. They remain in `scripts/joint-layout-polish.mjs`, outside the browser path.
- Proposal weighting was tested and then removed from the application kernel: bias 0.5 improved some RV workloads and regressed others. Failed contact, penalty-ramp, push, district-translation and distance/overlap-cache experiments are retained only as research artifacts under `target/`.

Next useful target: learn a cheap neighborhood/portfolio selector from these counterexamples, then verify it against independent RV/configuration cases. Do not replace the fast default with an unbounded search or label the new incumbent a global optimum.


## Joint exchanges and progressive polishing, 2026-11-16

The generic fast path now improves **447.9128420998466 → 444.0959657030084**, beating the earlier offline incumbent 444.19196527961367. A fresh run starts with the same generic placement, not a saved map. The complete local pipeline measured **2.75–2.82 seconds** before final integration checks; this is not a claim of a universal two-second bound.

After broad annealing, a small WASM exchange search relocates up to four blockers to make room for a more valuable producer. Three cooler passes (1.5m, 1m and 0.5m proposals) preserve the incumbent and finish with deterministic quarter-grid single-building relocations, local storage relocation and aligned unequal-footprint pair exchanges. The schedule is independent of RV and user coordinates. Only feasible, cheaper candidates survive; worker capacity is checked by the existing guard, retaining the broad candidate if polishing fails that guard.

Geometry acceleration preserves the search trajectory: disjoint rectangles return zero area immediately; a globally collision-free state needs no rescan of its old overlap area. Generator/site optimizations remain intact. JavaScript preparation caches storage sites blocked by stationary facilities, rejects noncompetitive partial storage costs, uses numeric district occupancy keys and skips duplicate collision checks. Initial packing remembers the earliest potentially free probe for repeated footprints while occupancy only grows; this optimization is disabled for arbitrary placement callbacks and after relocation starts.

The 14 real-inventory/synthetic-workload RV cases all improve versus the deployed five-million-proposal results. Relative to separate 16-million-proposal searches, eight are better and six retain small gaps (largest approximately 0.48%). Timings range from about 0.9 to 4.4 seconds before the final preparation optimization. Large RVs still exceed two seconds. These are neither exhaustive configuration coverage nor global certificates.

The 444.0959657030084 result passed independent certificate and capacity validation (`target/fast-444-certificate.json`, `target/fast-444-validated.json`): all 100 members, five stores and 12 poles remain valid, production stays at 57.578045717368, no additional couriers are required, and active/assumed copies stay at 28/1 as in the deployed fast result. The proven global lower bound is unchanged at 428.447387. A smaller measured objective is an upper-bound improvement, not proof of global optimality.

Reproduction: `node scripts/bench-layout-polishing.mjs target/user-current-layout-input-lv4.json target/rv-20-trees-input.json`. The prior 139-test suite passed, including a narrow-bay exact minimum without random steps, a joint exchange needing two blockers, and RV1–20 geometry/determinism tests with quarter-size footprints, exchanges, climate and power. The monotone initial-packing equivalence test was added subsequently. No new deployment has been triggered.


Final integration checks found a temperature-scaling counterexample in the other captured Best plan: two very busy processors already at their geometric distance floor dominated the weighted median. Scaling now weights each producer by its remaining cost above the individual nonoverlap distance floor, not by raw throughput alone. This is only a scale heuristic, not a global bound. The initial scale is held constant through the three cooling passes. The captured plan improved **124.65031697706961 → 124.1032602010299**, while the corrected user input keeps 444.0959657030084. A focused regression test covers this scale selection.

The actual worker (with locally regenerated ignored `web/pkg`) produced 444.0959657030084 in 2.778 seconds. All three grouped modes correctly fell back to delivery because this input lacks room: courtyards 4.106 s, avenues 4.524 s, districts 3.471 s. This does not certify grouped-layout optimality or two-second timing. Other captured inputs were checked through the worker too. The reviewed code had no actionable review findings; 140 tests passed before the final temperature regression test, and final verification is recorded separately. There has been no push or deployment after dda287d.


Final verification for this iteration: **141 tests passed, zero failures/skips**. Independent certificate checks passed for the corrected user input and all 14 RV workload cases; the final matrix retained no regressions against the deployed baseline. Updated timing range is **0.898–4.121 seconds**, with the user case **2.789 seconds / 444.0959657030084**. The worker-capacity check preserves production, no extra couriers, and 28 active plus one assumed copy. Reviewer follow-up found no actionable issue in monotone packing, site-cache lifetime, partial-score pruning or exact overlap shortcuts. The additional temperature regression test passed. Global optimality and a universal two-second limit remain unproven.
