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
    pub automatic: Option<GeneratorLimits>,
}

/// RV permits up to this many generators, upgraded as far as the Power Module allows.
/// Output/workload are the five generator recipes in game build 3584014.
#[derive(Debug, Clone, Copy)]
pub struct GeneratorLimits {
    pub count: u32,
    tier: usize,
    lightning: u32,
}

const GENERATOR_TIERS: [(u32, u32, u32, u32); 5] = [
    // RV unlock, recommended Lightning, watts, workload
    (12, 1, 600, 60), (14, 2, 800, 60), (16, 3, 1000, 75),
    (18, 3, 1200, 90), (20, 3, 1500, 105),
];

impl GeneratorLimits {
    pub fn for_rv(rv: u32, lightning: u32) -> Option<Self> {
        let tier = GENERATOR_TIERS.iter().rposition(|&(unlock, ..)| unlock <= rv)?;
        let count = if rv >= 18 { 3 } else if rv >= 15 { 2 } else { 1 };
        Some(Self { count, tier, lightning: lightning.clamp(1, 4) })
    }

    pub fn with_placed(self, count: u32, level: u32) -> Option<Self> {
        if count == 0 || level == 0 {
            return None;
        }
        Some(Self { count: count.min(self.count), tier: self.tier.min(level as usize - 1), ..self })
    }

    /// Choose the strongest available generator recipe supported by this worker.
    pub fn generator(self, lightning: u32) -> (u32, u32) {
        let Some(tier) = GENERATOR_TIERS[..=self.tier].iter().rposition(|&(_, required, ..)| required <= lightning) else {
            return (0, 0);
        };
        let (_, _, watts, workload) = GENERATOR_TIERS[tier];
        let work_rate = 45 + 15 * lightning.min(4);
        // Round down so the planner never budgets more power than is generated.
        (tier as u32 + 1, watts * work_rate.min(workload) / workload)
    }

    pub fn max_output(self) -> u32 { self.generator(self.lightning).1 }

    /// The fewest generators, then the lowest Lightning levels that cover the demand.
    pub fn staffing(self, watts: f64) -> Vec<u32> {
        let max = self.max_output() as f64;
        let count = ((watts - 1e-6) / max).ceil().max(0.0) as u32;
        let mut remaining = watts;
        (0..count).rev().map(|others| {
            let level = (1..=self.lightning)
                .find(|&level| self.generator(level).1 as f64 + others as f64 * max + 1e-6 >= remaining)
                .unwrap_or(self.lightning);
            remaining -= self.generator(level).1 as f64;
            level
        }).collect()
    }
}

impl PowerPlan {
    pub fn generator_limit(&self) -> u32 {
        self.automatic.map_or_else(|| generator_workers(self.grid.watts as f64), |g| g.count)
    }
    pub fn generator_output(&self, lightning: u32) -> f64 {
        self.automatic.map_or(WATTS_PER_GENERATOR_ANIIMO, |g| g.generator(lightning).1 as f64)
    }
    pub fn max_generator_output(&self) -> f64 {
        self.automatic.map_or(WATTS_PER_GENERATOR_ANIIMO, |g| g.max_output() as f64)
    }
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
