# Two map modes implementation plan

> Execute inline with executing-plans; use test-driven-development for the grouping contract.

**Goal:** Keep Shortest deliveries and add compact Production groups, with delivery optimization in both.

**Architecture:** Preserve the existing delivery kernel. Build rigid, compact semantic blocks from source pieces (climate clusters remain intact), place the blocks, connect power without breaking block boundaries, and optimize storage and deliveries under grouping constraints. No reserved decorative space. Legacy styles migrate to groups.

**Tech stack:** Browser JavaScript, existing layout/power algorithms, Node test runner.

**Approved spec:** User approved two modes and the following structure: fields/trees with climate mixing, mines/wells, other primary/Leisure, alphabetical processing. Split categories only into parts of at least eight objects; categories smaller than eight remain whole. Optimize paths for both modes. Preserve output, coverage and RV limits.

## Tasks
- [x] Add tests for categories, balanced splits, alphabetical rows, climate preservation and monotone delivery refinement.
- [x] Implement semantic blocks and constrained layout/refinement in web/production-groups.js. Use existing source-piece indices to reconstruct metadata.
- [x] Integrate worker, two-choice UI, saved-value migration and readable group labels; remove decorative spacing and sale split controls.
- [x] Test real user input plus RV matrix, geometry, power and both modes. Run full JS suite and review.

## Review focus
Small categories; climate clusters spanning categories; irregular open plots; no storage or no generators; legacy saved modes.

## Execution notes
Continuing in the existing workspace as authorized by the ongoing implementation request; unrelated proof research is excluded. No new dependencies. Finite search is a heuristic, not a global optimality claim.

User refinements: unused buildings park together at an edge only in delivery mode; grouped mode retains them in their category. Technical gaps for power are permitted. Added idle-layout.js and classification/parking tests.

Validation: 324 Node tests pass. Independent geometry, metadata, climate coverage and grid checks pass for the user input and 14 RV 3–20 mixed/tree-heavy inputs. Actual worker checks cover both modes at RV 3, 12, 15 and 20. Headless Chrome checks legacy saved-style migration, both map renders, idle parking, narrow controls and runtime exceptions. Reviewer findings (stale cache-key variable and missing validated walking metadata) fixed and covered by regressions.

Shortest-delivery score on the captured user input remains 444.0959657030084 after parking 12 idle buildings. Grouped search optimizes actual delivery weights through row-width/split candidates, storage placement, constrained member refinement and whole-group translations. No required decorative strips; powered blocks leave technical wiring space. If grouping cannot preserve feasibility and output, the existing explicit delivery fallback remains.
