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
to the building just serviced. The basic walking speed is the application's existing 4 tiles/s.
The workload model applies a 2× time allowance to both legs. It also doubles the estimated
work of each Farmland/Woodland job, including both waterings; crop growth time and ordinary
worker travel between workplaces retain their existing values.

Building stock limits by tier are shared by the browser and the Rust optimizer in
`web/facility-stock.json`. They come from the `facilities[].lv[].lim` fields of the
[extracted game tables](https://aniimocamp.com/aniimotools/homefarm.json) (build 3584014).
[GameWith's Farmland guide](https://gamewith.ai/aniimo/en/articles/how-to-farm#farmland-levels-and-item-count)
also shows the 5–35 item limits and that farming can deliver a single oversized harvest intact.

The estimate combines as many whole batches as fit in the building's local stock before
collection. An oversized harvest still goes out as a whole batch. Output and byproducts share
the estimated buffer and are carried in separate loads. If the building has no recorded
limit or switches between recipes, the estimate uses one batch per pickup. With mixed
building tiers the layout assigns compatible owned levels; the route bound uses the busiest
compatible tier. The in-game pickup threshold and queues are not verified for every building.
The animation shows accumulation, but does not simulate individual dispatch queues.

Hauling shares the assigned courier's available hours with production, crop jobs, generator
staffing and optional worker travel. The fast allocation uses free hours first. If a specified
headcount limit does not fit, linear route variables let the optimizer reassign jobs or lower
production, including differences between couriers' Hauling levels. Rechecks independently
validate delivery coverage and each member's capacity. Geometry refinement is bounded.

Worker travel initially reserves 20 tiles per workplace change. A shorter measured route
does not restart optimization. If that allowance is exceeded, one correction uses the open
homeland's diagonal for every worker, including reserves introduced by the new plan. This
is conservative rather than an exact simulation of the next placement. A delivery headcount
shortage similarly triggers one correction using a whole-map route bound for every recipe;
the model's checked courier assignment is retained when a greedy reallocation misses it.

Each active recipe occupies a separate building. Recipe switching is not used to share one
Bench or Kiln between different material recipes. Optional worker travel treats them as
different workplaces.
