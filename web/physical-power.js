const heavy=new Set(['Mine','Well','Aniipod Maker','Dance Pad Polisher']);
const light=new Set(['Carousel Mill','Crafting Table','Jukebox Dryer','Claw Game Cooker','Joy Wheel Loom',
    'Phonolfactory Table','Bouncy Brew Keg','Simmering Pot','Blazing Stove','Woodworking Bench','Chimney Kiln','Pickling Jar']);
export const ratedSiteWatts=m=>(heavy.has(m.facility)?30:light.has(m.facility)?15:NaN)*m.electric_level;

// Every occupied powered building draws its full rating while configured in
// E-mode. A schedule specifies which recipes actually share a building.
export function physicalPlanPower(plan, sites = plan.recipe_schedule?.sites ?? [], percent = 120) {
    const scheduled = new Set();
    const key = (facility, item, level) => JSON.stringify([facility, item, level]);
    let rated = 0;
    for (const site of sites) {
        if (site.electric_level == null || !site.jobs?.length) continue;
        rated += ratedSiteWatts({facility: site.facility, electric_level: site.level ?? site.electric_level});
        for (const job of site.jobs) scheduled.add(key(site.facility, job.item, site.electric_level));
    }
    for (const row of plan.coin_items ?? []) {
        if (row.status !== 'producing' || row.electric_level == null) continue;
        if (!scheduled.has(key(row.facility, row.item_name, row.electric_level))) {
            rated += ratedSiteWatts(row) * row.facility_count;
        }
    }
    return rated * percent / 100;
}
