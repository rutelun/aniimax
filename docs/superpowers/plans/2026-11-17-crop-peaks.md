# Crop peak staffing

Approved scope: publish the physical-map fix first, then choose workers for simultaneous crop maturity while accounting for other work. Watering uses average capacity, not peak staffing.

- [x] Publish and verify map fix 4c5e45d.
- [x] Add a deterministic, bounded crop queue evaluator. Critical stages exclude Watering; travel starts at release, busy production and hauling delay availability. Keep queue delay separate from average work.
- [x] Use the evaluator to select extra owned copies within RV capacity. Preserve the checked mean dispatch and production demand: a peak-only distribution must not replace average allocation and reduce output. Distribute real crop routes across the selected copies with capacity checks, preserving permanent posts and average watering. Do not invent reserved workload or select idle pools with no real crop routes.
- [x] Cover simultaneous maturity, occupied multi-role workers, travel, watering-only plans, capacity limits, conservation and repeatability with tests. Verify current shared configuration and runtime.

The peak scenario is an estimate, not a claim to reproduce the game's unknown queue rules. Additional workers are accepted only when they reduce the modeled crop queue. No artificial travel multipliers and no workload clipping.

Implemented scope: My Aniimo spare copies of checked crop pools. The simulation retains per-crop/ability eligibility from the actual routes; no cross-pool mean work reassignment. Eight deterministic occupation phases approximate work in progress at simultaneous maturity. New arrivals of unrelated work during the burst are not an event-level game simulation.

Validation: ten focused regressions, full JS suite, current user configuration in headless browser (both map styles ~4s, no fallback/errors). Final selection benchmark on captured layout:23ms; additional two Shrubclaw and one Stellarys (Rainfall Form). Production totals and dispatch shares are not mutated.
