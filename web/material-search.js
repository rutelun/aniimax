// Fill the material processors around the already chosen production plan first. This gives
// the full search a useful incumbent instead of an income plan making no RV materials.
export async function searchMaterials(problem, incumbent, solve, options) {
    // objective omits tie-breaks so it can be used as a production floor. Compare candidates
    // with the actual solver score, including the preference for the player's own workers.
    const score = result => result.objective - (problem.tiebreak || [])
        .reduce((sum, [v, weight]) => sum + weight * (result.values[v] || 0), 0);
    let seed = null;
    if (incumbent?.length === problem.variables && problem.material_fixed?.length) {
        const fixed = problem.material_fixed.map(v => ` material_fix_${v}: x${v} = ${Math.round(incumbent[v])}`).join('\n');
        const local = { ...problem, lp: problem.lp.replace('\nBounds\n', `\n${fixed}\nBounds\n`) };
        seed = await solve(local, { ...options, time_limit: 2 }, undefined, incumbent);
    }
    if (seed && problem.primary_objective?.length) {
        // Keep the same objective in this upper bound. Proving only the raw output could
        // accept a reserve-heavy seed before comparing an equally productive owned team.
        const relaxed = { ...problem, tiebreak: [], lp: problem.lp
            .replace(/\nGeneral\n[\s\S]*\nEnd/, '\nEnd') };
        const bound = await solve(relaxed, { ...options, time_limit: 2 });
        if (bound?.proven && score(seed) >= bound.objective - 1e-9) {
            return { ...seed, proven: true };
        }
    }
    const full = await solve(problem, options, undefined, seed?.values || incumbent);
    // A restricted optimum is only an incumbent for the unrestricted model.
    const best = seed && (!full || (!full.proven && score(seed) > score(full) + 1e-9))
        ? { ...seed, proven: false } : full;
    // A timeout holding only the original zero-work seed cannot masquerade as completion.
    if (!best || (!best.proven && best.objective <= 1e-9)) return null;
    return best;
}
