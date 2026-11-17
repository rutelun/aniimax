# Crop peak deadline implementation plan

**Goal:** Size crop support for mean complete-peak processing within 90 seconds in all team modes.

**Architecture:** Retain eight deterministic occupancy scenarios and checked production assignments. Measure each scenario's last critical operation, then average these completion times. Stop adding copies at the deadline. Separate owned activation from suggested additions. Feed Best and Minimum through the same simulator using canonical recipe work durations and their actual team allocations.

**Tech stack:** JavaScript modules, Rust WASM recipe metadata, node:test, browser CDP.

- [x] Regression tests: mean completion rather than mean queue delay; sufficient teams unchanged; cap and unavailable additions; watering excluded.
- [x] Implement deadline selection, completion diagnostics and additional-copy recommendations.
- [x] Export canonical crop work durations; build Best/Minimum adapters without changing production output or double counting workers.
- [x] Show deadline and shortages in all team views; preserve counts in imports.
- [x] Reproduce shared setup (expected 2 Shrubclaw and 2 Rainfall Stellarys, about 89 seconds); test all modes and run full suite.


Validation: 424 local tests passed; release WASM built successfully. Browser completed all three modes with no runtime errors. Saved comparison fixture: 88.859 seconds with two Shrubclaw and two Rainfall Stellarys, 25ms selection. Fresh browser layout: My 82.35s (30 total), Minimum 88.16s, Best 94.77s at RV cap38; diagnostic recommends two further copies for85.54s, explicitly beyond cap. Mean, worst-case distinction, residual courier trip, same-ability multi-job duration, and independent bottlenecks have regression coverage.
