export function hasSeasonCropMinimums(input) {
    return Boolean(input.season && Object.values(input.season_crop_minimums || {}).some(count => count > 0));
}

// Each reserved plot must grow at least one batch per day (or per natural
// cycle). If all distinct event crops are reserved, every feasible shift
// already has the maximum seasonal-only variety score.
export function reservedSeasonScore(pkg,input) {
    if(input.crop_variety || !hasSeasonCropMinimums(input) || !pkg.get_all_items)return null;
    const crops=JSON.parse(pkg.get_all_items()).filter(item=>item.season===input.season
        && (item.facility==='Farmland' || item.facility==='Woodland'));
    if(!crops.length || !crops.every(({name})=>!name.startsWith('quick_') && !name.includes('__')
        && Number.isSafeInteger(input.season_crop_minimums[name]) && input.season_crop_minimums[name]>0))return null;
    return new Set(crops.map(item=>item.name)).size;
}

// With reserved plots, the harvest is required but the level-up plan needn't earn event points.
// An explicitly selected points priority still runs like any other priority.
export function autoMaximizeSeasonPoints(input) {
    return Boolean(input.level_up_strategy && input.season && !hasSeasonCropMinimums(input));
}
