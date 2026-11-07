// Fill the material processors around the already chosen production plan first. This gives
// the full search a useful incumbent instead of an income plan making no RV materials.
export async function searchMaterials(problem, incumbent, solve, options) {
    let seed = null;
    if (incumbent?.length === problem.variables && problem.material_fixed?.length) {
        const fixed = problem.material_fixed.map(v => ` material_fix_${v}: x${v} = ${Math.round(incumbent[v])}`).join('\n');
        const local = { ...problem, lp: problem.lp.replace('\nBounds\n', `\n${fixed}\nBounds\n`) };
        seed = await solve(local, { ...options, time_limit: 2 }, undefined, incumbent);
    }
    if (seed && problem.primary_objective?.length) {
        // Removing all integer restrictions gives an upper bound on the primary workload.
        // Strip tie-breaks too: their penalized optimum is not an upper bound on raw work.
        const objective = problem.primary_objective.map(([v, c]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} x${v}`).join(' ');
        const relaxed = { ...problem, tiebreak: [], lp: problem.lp
            .replace(/obj:[^\n]*/, `obj: ${objective}`)
            .replace(/\nGeneral\n[\s\S]*\nEnd/, '\nEnd') };
        const bound = await solve(relaxed, { ...options, time_limit: 2 });
        if (bound?.proven && seed.objective >= bound.objective - 1e-6) {
            return { ...seed, proven: true };
        }
    }
    const full = await solve(problem, options, undefined, seed?.values || incumbent);
    // A restricted optimum is only an incumbent for the unrestricted model.
    const best = seed && (!full || seed.objective > full.objective + 1e-9)
        ? { ...seed, proven: false } : full;
    // A timeout holding only the original zero-work seed cannot masquerade as completion.
    if (!best || (!best.proven && best.objective <= 1e-9)) return null;
    return best;
}
