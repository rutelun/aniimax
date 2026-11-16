# Independent power networks

User requested this after publishing the compact-group corrections (published a9f58d6).

Compare a shared network with physically separate networks without sacrificing the solved production rates. Each network must use its own generator output and rated building draw. Supply is capped at 120%; slower supply is legal only when each physical building's combined recipe workload still fits. Workers and generator count remain those of the solved plan.

Use bounded map refinement rather than multiplying the production solver by every possible partition. This first implementation optimizes network routing for the existing production allocation; it does not claim to search every production/E-mode allocation jointly with separate networks.

1. Add graph-component power analysis and regression cases: unequal networks, shared consumption, insufficient output, partial processors versus full-time gathering, recipe sharing, unknown data.
2. Compare bounded spatial partitions and removable power bridges; keep the shared layout as fallback. Reject disconnected, overloaded, colliding or out-of-land alternatives.
3. Integrate final routing into both map modes. Carry actual generator watts from the plan. Report each network's supply and adjust displayed E-mode cycle/load on the map.
4. Run JS suite, actual-input map checks and browser checks. Preserve immutable solved production and original recipe metadata.
