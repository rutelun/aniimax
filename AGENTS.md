# Planner performance

Do not introduce or tighten wall-clock time limits to speed up the planner,
including in experiments. Use elapsed time for profiling and benchmarking.

# Example configs

Real user configs from past sessions are stored in `tests/fixtures/session-configs.json`
as base64url-gzipped UI share strings (`share`), covering:

- `rv15-custom25-mwn` — RV15 custom roster (25), Magical Wonder Night (4+4), 5 priorities
- `rv17-custom27-mwn` — RV17 custom roster (27), Magical Wonder Night (4+4), `aniipods -> level_up -> Wood Blocks -> coins -> Mineral Sand` (reproduces depleted-worker climate minimization)
- `rv17-custom24-mwn` — RV17 custom roster (24), Magical Wonder Night (4+4), `level_up -> Wood Blocks -> aniipods -> coins -> Mineral Sand`
- `rv17-best-mwn` — RV17 Best Aniimo, Magical Wonder Night (4+4), `level_up -> coins`
- `rv20-best-offseason` — RV20 Best Aniimo, no season event, `level_up -> coins`
- `rv21-best-mwn` — RV21 Best Aniimo, Magical Wonder Night (9+9), `level_up -> coins`
- `rv21-custom31-mwn` — RV21 custom roster (31), Magical Wonder Night (5+5), `level_up -> coins`

Decode a `share` entry with `JSON.parse(zlib.gunzipSync(Buffer.from(entry.share, 'base64url')))`.
When building an `exact_problem` payload from a UI share config, note that `SPECIAL_RECIPES`
in `web/facility-config.js` are `{name, facility}` objects (`exclude` expects recipe `name` strings).

Additional solver inputs and benchmark captures already in the repo:

- `tests/fixtures/rv15-delivery-layout.json`, `tests/fixtures/rv16-best-production.json`
- `target/roster-latency/before/my-mixed-rv17-magical_wonder_night-inputs.json` — RV17 custom roster draft + measured dispatch (4 climate modes, overlapping `Scorching|Cool` pair)
- `target/rv19-22-solvers/captures/` — 13 RV19–22 solver captures (useful for speed & regression benchmarking)
- `target/planner-batch/competitors-integrated-visible/` — multi-RV seasonal/custom captures (e.g. `my-small-rv21-magical_wonder_night`)

