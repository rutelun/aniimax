# Delivery workload model

Checked 2026-11-15. This is an estimate of steady-state courier workload, not a reproduction
of the game's automatic dispatcher.

## Sources and limits

- [GameVault's Hauling description](https://aniimo.gamevault.in/en/homeland/abilities/hauling/)
  describes collecting stockpiled products and taking them to Home storage. Its workload
  numbers are not carrying capacities and are not used as such.
- Hauling capacities are 60, 80, 100 and 120 items per trip at levels 1–4, based on the
  profiles of [Skippy](https://wikily.gg/aniimo/aniilog/skippy/homeland/),
  [Fenrier](https://wikily.gg/aniimo/aniilog/fenrier/homeland),
  [Glacy](https://wikily.gg/aniimo/aniilog/glacy/homeland) and
  [Prismana Glacy](https://wikily.gg/aniimo/aniilog/glacy-prismana-form/homeland/).
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
The workload model applies a 2× time allowance to both legs. Enabling Aniimo travel in My
Aniimo triples the walking-time estimates for workplace changes and deliveries. Estimated
work for Farmland and Woodland jobs, including both waterings, is doubled separately.

Building stock limits by tier are shared by the browser and the Rust optimizer in
`web/facility-stock.json`. They come from the `facilities[].lv[].lim` fields of the
[extracted game tables](https://aniimocamp.com/aniimotools/homefarm.json) (build 3584014).
[GameWith's Farmland guide](https://gamewith.ai/aniimo/en/articles/how-to-farm#farmland-levels-and-item-count)
also shows the 5–35 item limits and that farming can deliver a single oversized harvest intact.

For crops, the estimate includes the harvest that first reaches or exceeds the stock limit.
For other facilities it uses the whole batches that fit. Quick Aromathyst uses a pickup
threshold of 36 items based on [an observed Dewy House](https://www.reddit.com/r/Aniimo/comments/1wzy2m5/rv_hauling_issue/).
The model lets products and byproducts use the same load, based on [a report of five items
remaining after a 100-item pickup from a 105-item Maple harvest](https://www.reddit.com/r/Aniimo/comments/1x2bq37/maple_not_being_picked_up/).
That observation suggests shared capacity but does not directly show the mix of items on
each trip. A missing stock limit or a building switching recipes uses one batch per pickup.
The route bound uses the busiest compatible building tier. The animation shows accumulation
and omits the game's individual dispatch queues.

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

Each active recipe occupies a separate building. Optional worker travel treats them as
different workplaces. An Aniimo can work locally at one of them and use the time between
batches for other work, with travel charged for visits to the other workplaces.
