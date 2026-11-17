# Shared daily recipe switching

**Goal:** Optimize at most B distinct switching buildings and N shared changes after the free morning setup.

**Architecture:** Keep the ordinary production optimizer as a valid baseline. A separate bounded scheduling MIP uses physical sites, approximate batch rates and at most N+1 shared phases. Independently validate its certificate before integrating its rates, map and crew reporting. Repeating-day material buffers are allowed and reported; they must replenish every day.

**Tech stack:** JavaScript, bundled HiGHS WASM, existing Rust production optimizer.

**Spec:** User instructions in this chat, including free morning reset and explicit permission for reported initial inventory.

## Constraints

- Default disabled; preserve legacy results.
- Count distinct physical buildings across the entire day, not separately per event.
- Phase boundaries are common; individual buildings may retain their recipe.
- User-approved approximate timing: finish the current batch at a boundary; rates use the existing steady-state model. Conservative renewable starting inventory is shown.
- Every phase must respect worker and electrical capacity.
- Existing priority ordering, resource balances, environment compatibility and peak crop staffing must remain valid.
- Bounded search with the baseline as fallback; never report a heuristic result as globally proven.

## Work

- [x] Setup accordion, persistence/share and input tests.
- [x] Separate schedule model and independent certificate validation, tested with actual HiGHS.
- [x] Adapt prepared production recipes and physical sites to the schedule model, preserving fixed climate/electricity and worker identity.
- [x] Compare validated schedules against baseline using the original priority order; revalidate crop peaks and map after changes.
- [x] Show common times, physical building recipes and necessary initial stock.
- [x] Verify disabled, zero switches, tier incompatibility, global building budget, phase overload and inventory renewal regressions.
- [x] Browser integration and review before release.

## Review focus

- A per-day average cannot authorize an overloaded phase.
- Changing crew variants is not a recipe change.
- Free morning reset must not become a charged cyclic switch.
- Initial inventory must not become an unbounded daily source.
- Layout and crew postprocessing must not invalidate the schedule certificate.

## Implementation rulings and verification

- Approximate mode intentionally allows fractional daily batch estimates; timestamps are not an exact executable second-by-second certificate. The map completes an active batch before changing recipes.
- Keep the original plan unless a validated candidate improves the first differing priority. RV priority compares level-up seconds, not its zero-valued production-rate field.
- Limit extra production/schedule search to 10 seconds. Try a normal-worker material-chain template before generic E-mode sharing: two raw processors, then switch one to tier 3 while tier 2 and tier 4 retain recipes.
- Fixed custom maps retain the original plan; switching is supported with generated layouts. UI supports up to 24 shared changes.
- Review finding fixed: layout postprocessing may not replace a certified phase allocation with average-spare-time hauling assignments. Generated crop support uses worst-phase worker occupancy. Electric islands must sustain peak, not average, site load.
- WASM release build succeeded. JavaScript suite: 463/463. Browser Best/Minimum switching cases had no uncaught exceptions.
- RV21 Best benchmark, level-up then coins, 3 allowed switching buildings and 2 allowed events: 2,393,839 s to 1,843,384 s; the simple template uses one event and was found in 2.44 s additional search. This is a feasible improvement, not a global-optimum proof.
