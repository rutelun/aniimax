# Delivery workload model

Checked 2026-11-07. This is an estimate of steady-state courier workload, not a reproduction
of the game's automatic dispatcher.

## Sources and limits

- [GameVault's Hauling description](https://aniimo.gamevault.in/en/homeland/abilities/hauling/)
  describes collecting stockpiled products and taking them to Home storage. Its workload
  numbers are not carrying capacities and are not used as such.
- Wikily lists carrying capacity 60 for [Skippy](https://wikily.gg/aniimo/aniilog/skippy/homeland/),
  80 for [Fenrier](https://wikily.gg/aniimo/aniilog/fenrier/homeland), and 100 for
  [Bouldus](https://new.wikily.gg/aniimo/aniilog/bouldus/homeland) and
  [Glacy](https://wikily.gg/aniimo/aniilog/glacy/homeland), corresponding to Hauling levels 1–3.
  These are community database values. Level 4's carrying count has not been verified;
  the calculation conservatively uses the verified level-3 count of 100.
- [GameWith's farming guide](https://gamewith.ai/aniimo/en/articles/how-to-farm)
  describes stock accumulation up to a facility's item limit before hauling, and harvests
  exceeding that limit. Consequently, a production batch is not necessarily one delivery.
- [ANIIMO Central](https://aniimocentral.com/guides/homeland/), which references live-client
  help screens, explicitly does not establish hauling-rate or efficiency formulas.

## Implemented estimate

The model groups nearby delivery jobs around their nearest Storage Unit. A delivery consists
of carrying cargo to storage and walking to the next pickup. Next pickups are weighted by
the delivery frequency of the buildings in that storage pool. There is no mandatory return
to the building just serviced. The walking speed is the application's existing 4 tiles/s,
as requested by the user; this has not been independently measured in the game.

Each production batch is one pickup group. Each output type, including byproducts, is split
into trips by the courier's carrying capacity. Accumulation of several production batches
into a single pickup, mixing different output types in one load, pickup/drop-off animation
times, hunger, and the game's dispatch priorities are not simulated. Reported minutes and
headcounts are therefore estimates, not verified guarantees of in-game throughput.

Hauling shares the assigned courier's available hours with production, crop jobs, generator
staffing and optional worker travel. The fast allocation uses free hours first. If a specified
headcount limit does not fit, linear route variables let the optimizer reassign jobs or lower
production, including differences between couriers' Hauling levels. Rechecks independently
validate delivery coverage and each member's capacity. Geometry refinement is bounded.

Each active recipe occupies a separate building. Recipe switching is not used to share one
Bench or Kiln between different material recipes. Optional worker travel treats them as
different workplaces.
