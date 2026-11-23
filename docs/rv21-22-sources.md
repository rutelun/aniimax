# RV 21–22 data audit (17 November 2026)

## Sources and method

- [Game-data export, build 3846247](https://github.com/Shinumino/aniimo-homeland-planner/blob/main/data.js), MIT-licensed: recipe IDs, ingredients, outputs, workloads, prices, ability levels, families, modules and electrical formulas. Numerical data only; no UI or artwork imported.
- Current game database tables: [RV 21](https://aniimo.th.gl/db/rv_levels/rv_level_21), [RV 22](https://aniimo.th.gl/db/rv_levels/rv_level_22).
- Independent shipped-data recipe checks: [Sorghum](https://www.aniimo.gg/homeland/recipe/sorghum/), [Bright Silver Powder](https://www.aniimo.gg/homeland/recipe/bright-silver-powder/), [Gold-Speck Cap](https://www.aniimo.gg/homeland/recipe/gold-speck-cap/), [Sweet Cone](https://www.aniimo.gg/homeland/recipe/sweet-cone/).
- In-game station tables cross-check recipe quantities, prices, workloads and climate requirements: [station index](https://aniimotools.dev/systems/homeland/stations/). Checked individual Farmland, Mine, Well, Starfall Hammock, Tidewhisper Sandcastle, Carousel Mill, Crafting Table, Jukebox Dryer, Joy Wheel Loom, Phonolfactory Table, Bouncy Brew Keg, Simmering Pot, Blazing Stove and Pickling Jar pages. No article prose or images copied.

## Conflicts resolved explicitly

- Historical export lists 3,720 / 10,580 Microcrystalline Ore Plates for RV 21 / 22. Current database and current RV reference agree on **460 / 1,320**. Use those current values; timber 830 / 1,190 and coins 34,300,000 / 52,600,000 agree.
- Phonolfactory Table level 7: current station commentary mentions RV 21 purchase versus RV 22 recipe access. Both shipped-data export and current RV database gate it at **RV 22**. Planner uses that conservative recipe-access gate; custom facility input can override an individually verified unlock.
- Tidewhisper Sandcastle level 4: historical export says RV 19, current station table says **RV 20**. Use RV 20 together with Resource Detector 9. This previously omitted Quick Pearl formula is needed for correct late-RV plans.
- Export's 1,800-second crop growth excludes watering; existing planner CSV convention and displayed game cycle are **2,400 seconds**. New crops use the same convention and existing watering-work adjustment, not a faster special rule.
- Beskor's Potato Starch page includes a Potato Seed nested under Premium Potato. Export and station recipe agree the direct ingredients are six Premium Potatoes and six Snowmelt Cold Springs. Seed cost belongs to growing potatoes and is not charged again by the pot.

## Applied changes

32 added formulas: 31 at RV 21–22 plus the omitted Quick Pearl prerequisite. Orange Flower Rice Drink requires its recipe note and stays locked until selected.

RV 21: 46 Aniimo; Farmland 8, Mine 7, Well 6, Starfall Hammock 2, Carousel Mill 7, Jukebox Dryer 8, Joy Wheel Loom 5, Simmering Pot 7, Pickling Jar 6; Ecological Module 9.

RV 22: 47 Aniimo; 42 Farmland and 21 Woodland; Tidewhisper Sandcastle 5, Crafting Table 9, Phonolfactory Table 7, Bouncy Brew Keg 6, Blazing Stove 6; Crafting Module 8 and Resource Detector 10.

Both levels retain 10 Mines, 4 Wells, 8 Storage Units, 3 generators at level 5, 30 power poles, three of each climate unit, and the existing 16-plot map. No extra land or generator output is inferred.

Gold-Speck Cap requires the Coinwisp/Pouchwisp family and Warm; Sweet Cone requires Sugarfish/Sugarslime/Sugartini and Freeze. The catalog includes the matching Prismana workers; arbitrary Leisure workers cannot substitute.

Non-production requirements, recorded for completeness: RV 21 requires Trailblazer I, 22,000 Habitability and RV to the Future; RV 22 requires 24,000 Habitability, 40 level-8 fields and four wells. Upgrade construction takes 13 / 14 hours; the existing readiness estimate remains the time to collect materials, not construction time. Paint jobs, furniture, rewards and Habitability are not economic outputs in this planner.
