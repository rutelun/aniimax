// The first material-switch trial has the same workshops regardless of the
// ordinary plan's layout. Bound that plan before paying for its lower priorities.
import {priorityCeiling} from './priority-ceilings.js';
import {productionObjective} from './priority-search.js';

export function upgradeSwitchBounds(pkg, highs, input, trial) {
    const payload = settings => JSON.stringify({...settings, always_running_recipes:[], restrict_to_checked_recipes:false});
    const pace = data => {
        const problem = JSON.parse(pkg.exact_priority_problem(data, '{"floors":[]}', 'level_up'));
        return priorityCeiling(highs, productionObjective(problem), 'level_up');
    };
    const ordinary = payload(input), fixed = pace(ordinary);
    if (!(fixed > 0) || !Number.isFinite(fixed)) return null;
    const switched = pace(payload(trial));
    // A relaxation already too slow to beat the fixed-plan bound cannot
    // furnish this proof. Leave the ordinary comparison to rank those plans.
    if (!(switched > fixed * (1 + 2e-5))) return null;
    const crop = input.crop_variety || input.season
        ? priorityCeiling(highs, JSON.parse(pkg.exact_crop_variety_problem(ordinary)), 'crop_variety') : null;
    if ((input.crop_variety || input.season) && !Number.isFinite(crop)) return null;
    return {seconds:86400 / fixed, crop};
}
