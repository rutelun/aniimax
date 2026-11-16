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
