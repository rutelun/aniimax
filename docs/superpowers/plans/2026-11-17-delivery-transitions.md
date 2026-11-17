# Delivery transitions

User-approved scope: score previous task → pickup → storage → next pickup, including cross-storage travel, without counting a leg twice. Preserve fast layout search and production groups.

1. Introduce a shared delivery routing model: all eligible couriers can take tasks from every building. Weight previous storage endpoints by global pickup frequency; include each worker's other completed work as alternative origins. No territorial pools or distance-based task priority. One approach leg and one loaded leg per trip.
2. Use its exact score when comparing layouts. Feed frozen per-store origin probabilities to the fast WASM proposal search, then accept only improvements to the recomputed full score. Refresh probabilities between passes. Keep all geometry, power and grouping constraints.
3. Use the same approach estimate in hauling and reactive dispatch; attach courier rates to physical producer sites for custom teams. No extra return-trip multiplier.
4. Regression tests: equal local delivery distances but different inter-group distances, global queue across courier profiles, no duplicate leg, storage movement and zero-flow handling. Run existing tests, rebuild WASM, reproduce saved RV15 setup and benchmark both map modes. Do not claim global optimality.
