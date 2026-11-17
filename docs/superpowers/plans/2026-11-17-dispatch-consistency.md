# Dispatch consistency and grouped-map refinement

Approved scope: fix climate/production swaps under measured dispatch, remove false travel for a worker serving one physical workplace, improve whole-group translations, publish after verification.

- [ ] Add regressions for dispatched climate swaps, isolated wells, and a group requiring fine translation after a large gap.
- [ ] Keep climate swaps and their conserved production policies atomic; validate candidate workload, retain rates, expose revised policy to the frontend.
- [ ] Bind unambiguous single-task workers to physical sites when estimating origins and destinations; retain global hauling and actual multi-job travel.
- [ ] Refine whole groups to convergence on a bounded multiscale grid, with optional carried depots/poles and full route/power/climate/income checks. Repeat after final storage refinement.
- [ ] Rebuild WASM, run regression/full suites, replay saved setup in browser, review results and publish.
