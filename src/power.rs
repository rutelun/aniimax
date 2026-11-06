//! E-mode on a connected grid with a guaranteed supply percentage.
use crate::models::{base_item_name, base_work_rate, AniimoRequirements, FacilityCounts, GrowerSteps, ProductionItem};
use std::collections::BTreeMap;

const SUFFIX: &str = "__electric";
pub const WATTS_PER_GENERATOR_ANIIMO: f64 = 600.0;
pub const GENERATOR: &str = "Crackle Generator";

pub fn generator_workers(watts: f64) -> u32 {
    ((watts - 1e-6) / WATTS_PER_GENERATOR_ANIIMO).ceil().max(0.0) as u32
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct Electricity {
    pub watts: u32,
    pub percent: u32,
    #[serde(default)]
    pub max_aniimo: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct PowerPlan {
    pub grid: Electricity,
    pub grower_steps: GrowerSteps,
}

pub fn electric_level(name: &str) -> Option<u32> {
    name.rsplit_once(SUFFIX)?.1.parse().ok()
}

pub(crate) fn without_electric_suffix(name: &str) -> &str {
    if electric_level(name).is_some() {
        name.rsplit_once(SUFFIX).unwrap().0
    } else {
        name
    }
}

/// Rated watts per level of the physical building, rather than the level the formula unlocks at.
pub fn watts_per_level(facility: &str) -> u32 {
    match facility {
        "Mine" | "Well" | "Aniipod Maker" | "Dance Pad Polisher" => 30,
        "Carousel Mill" | "Crafting Table" | "Jukebox Dryer" | "Claw Game Cooker" | "Joy Wheel Loom"
        | "Phonolfactory Table" | "Bouncy Brew Keg" | "Simmering Pot" | "Blazing Stove"
        | "Woodworking Bench" | "Chimney Kiln" | "Pickling Jar" => 15,
        _ => 0,
    }
}

/// Add a copy at each eligible owned level. With a roster, the solve accounts for workers'
/// shared time and can trade local recipe speed for a better allocation across the homeland.
pub fn add_electric_variants(
    items: &mut Vec<ProductionItem>,
    originals: Vec<ProductionItem>,
    counts: &FacilityCounts,
    requirements: &AniimoRequirements,
    grid: &Electricity,
) {
    let mut fastest = BTreeMap::<&str, f64>::new();
    if counts.crew().is_none() {
        for item in items.iter().filter(|i| i.facility_level != u32::MAX && i.production_time > 0.0) {
            fastest.entry(base_item_name(&item.name)).and_modify(|t| *t = t.min(item.production_time)).or_insert(item.production_time);
        }
    }
    let speed = grid.percent as f64 / 100.0;
    let mut variants = Vec::new();
    for item in originals {
        let watts = watts_per_level(&item.facility);
        let (Some(workload), Some((_, required))) = (item.workload, requirements.get(&item.name)) else { continue };
        if watts == 0 {
            continue;
        }
        let time = workload / (base_work_rate(required) * speed);
        if fastest.get(item.name.as_str()).is_some_and(|&normal| time > normal + 1e-9) {
            continue;
        }
        let levels: std::collections::BTreeSet<_> = counts.tiers(&item.facility).into_iter()
            .filter(|&(count, level)| count > 0 && level >= item.facility_level && watts as f64 * level as f64 * speed <= grid.watts as f64)
            .map(|(_, level)| level).collect();
        for level in levels {
            variants.push(ProductionItem {
                name: format!("{}{SUFFIX}{level}", item.name),
                production_time: time,
                facility_level: level,
                crew: None,
                ..item.clone()
            });
        }
    }
    items.extend(variants);
}
