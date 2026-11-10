export function hasSeasonCropMinimums(input) {
    return Boolean(input.season && Object.values(input.season_crop_minimums || {}).some(count => count > 0));
}

// With reserved plots, the harvest is required but the level-up plan needn't earn event points.
// An explicitly selected points priority still runs like any other priority.
export function autoMaximizeSeasonPoints(input) {
    return Boolean(input.level_up_strategy && input.season && !hasSeasonCropMinimums(input));
}
