// Constraint generation: unused recipes need no availability/count products.
// Each pass solves a relaxation of the full always-running model. A result is
// executable only once every recipe it actually uses was constrained in that pass.
export async function continuousProduction(input, solve, progress = () => {}) {
    if (!input.always_running) return solve(input);
    const checked = new Set(input.always_running_recipes || []);
    for (let pass = 0; pass < 8; pass++) {
        const plan = await solve({...input, always_running_recipes: [...checked]}, pass);
        if (!plan?.success) return plan;
        if(plan.continuous_production_checked)return plan;
        for(const recipe of plan.continuous_checked_recipes||[])checked.add(recipe);
        if (!Array.isArray(plan.coin_items)) throw new Error('Missing active recipes for continuous production validation');
        const active = plan.active_continuous_recipes || plan.coin_items.filter(row => row.status === 'producing' && row.item_name)
            .map(row => row.item_name);
        const missing = active.filter(name => !checked.has(name));
        if (!missing.length) return {...plan, continuous_production_checked: true};
        missing.forEach(name => checked.add(name));
        progress({pass: pass + 1, recipes: checked.size});
    }
    // Never return an optimistic intermediate plan if the chosen recipes keep
    // changing. The full model is the bounded fallback, not another relaxation.
    const plan = await solve({...input, always_running_recipes: undefined}, 8);
    return plan?.success ? {...plan, continuous_production_checked: true} : plan;
}
