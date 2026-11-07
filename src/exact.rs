//! Exact planner: finds the provably best plan as one mixed-integer program over the whole
//! production network, instead of a continuous solve followed by rounding and heuristic passes.
//!
//! ## Model
//! - Every available recipe `r` gets a rate `b_r` (batches/sec) and a whole number of units
//!   `u_r` set to it (plots for a crop, machines for a processed item): `b_r * t_r <= u_r`, where
//!   `t_r` is the recipe's time per batch. A unit makes one thing and is left running, so units
//!   are never shared between recipes, including the tiers of RV upgrade materials.
//! - Every item balances: what's made covers what recipes use plus what's sold. A quick variant
//!   (e.g. `quick_wheat`) makes the same item as the regular one (`wheat`).
//! - Each facility's units per recipe add up to at most what's owned, counting only units at a
//!   high enough level for each recipe.
//! - A crop that needs a growing environment needs its plots covered: each environment building
//!   runs one mode and one coverage mix (see [`crate::coverage::single_building_options`]).
//! - Woodland and Mine byproducts (Wood Blocks, Mineral Sand) balance like any other item, so the
//!   Woodworking Bench and Chimney Kiln can use them.
//! - During a season, its items also earn points when sold, which a priority or floor can name
//!   as [`crate::models::SEASON_POINTS`]. Season seeds cost the season currency, which plans treat
//!   as unlimited (see [`crate::models::SeasonTerms`]) unless the player sets a daily budget:
//!   `86400 * sum of seed_cost_r * b_r <= currency per day`.
//! - The objective is the target currency per second from everything sold; for coins, minus seed
//!   costs (seeds are paid in coins, so they don't come off an Aniimo EXP total). A floor can
//!   name another currency, so a plan keeps up the Aniimo EXP or Aniipods an earlier solve found
//!   while earning as many coins as that leaves room for. For an RV level-up
//!   ([`Goal::LevelUp`]) it's the pace instead: level-ups per day, where making the coins and
//!   items it costs, on top of what's already in stock, takes a day per level-up. Stock enters each
//!   balance as `pace * stock`, and the cost as `-pace * cost`, which keeps the model linear.
//!
//! ## Search
//! Branch and bound over the whole-unit variables, with each node's continuous relaxation solved
//! from scratch by `microlp` (its own integer search isn't robust enough here). Nodes are explored
//! best bound first; a node whose relaxation can't beat the best plan found so far is dropped. When
//! the search runs out of nodes the plan is proven optimal; if it hits the time limit, the best
//! open bound says how far from optimal it could be.

use std::collections::{BTreeMap, BinaryHeap, HashMap};
use std::time::{Duration, Instant};

use microlp::{ComparisonOp, OptimizationDirection, Problem};

use crate::coverage::{
    facility_footprint, mode_temperature, single_building_options, temperature_mode, CoverageOption,
    building_size, pair_options_over_offsets, Offset, PairOption, PairSizes, Zone, ENVIRONMENT_GATED_FACILITIES,
};
use crate::models::{byproduct_item, FacilityCounts, ModuleLevels, ProductionItem};
use crate::power::{electric_level, generator_workers, watts_per_level, GENERATOR, WATTS_PER_GENERATOR_ANIIMO};

/// Whether plans may place two environment buildings to overlap, for the zone their temperatures
/// make together. Confirmed in game: a plot reached by Scorching and Cool reads Warm and grows a
/// Warm crop at 100%, and one reached by Warm and Cool reads Room temp, growing a Scorching crop
/// at 50% and a Warm one at 80%.
const OVERLAP_ZONES: bool = true;

/// Switched on only to measure how much the coverage model could be leaving on the table. It lets
/// a building or a pair take a fraction of each arrangement instead of committing to one, so the
/// plan solves an easier problem than the game and earns at least what the true best possibly
/// could. Mixing arrangements is a far tighter relaxation than allowing the most of every type in
/// every zone at once, which no layout comes near: for a Farmland and Woodland pair that box
/// holds 103 plots where 55 really fit, so it reported a gap whatever the plan did. Off in every
/// real plan; the `coverage_gap` test turns it on.
static COVERAGE_RELAXED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[doc(hidden)]
pub fn set_coverage_relaxed(on: bool) {
    COVERAGE_RELAXED.store(on, std::sync::atomic::Ordering::Relaxed);
}

fn coverage_relaxed() -> bool {
    // A wasm build has no switch to flip from the outside, so the measurement builds its own copy
    // with `ANIIMAX_RELAX_COVERAGE` set and runs it through the same solver the app uses.
    option_env!("ANIIMAX_RELAX_COVERAGE").is_some()
        || COVERAGE_RELAXED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Environment buildings and the modes each can run.
const ENVIRONMENT_BUILDINGS: &[(&str, &[&str])] = &[
    ("Heat Furnace", &["Warm", "Scorching"]),
    ("Cooling Unit", &["Cool", "Freeze"]),
    ("Sunlamp", &["Adequate"]),
];

/// Two environment buildings placed to overlap, and what their three zones cover.
#[derive(Debug, Clone)]
pub struct ExactPair {
    /// The two buildings, e.g. `("Cooling Unit", "Heat Furnace")`.
    pub buildings: (String, String),
    /// What each is set to, e.g. `("Freeze", "Warm")`.
    pub modes: (String, String),
    /// Where the second building sits relative to the first.
    pub offset: Offset,
    /// How many pairs like this the plan uses.
    pub count: u32,
    /// The mode each zone reads as: the first building's, the two added, then the second's.
    pub zone_modes: [Option<String>; 3],
    /// Plots covered per zone, as `(facility, count)`.
    pub zone_covers: [Vec<(String, u32)>; 3],
}

/// How an environment building is set up in an exact plan.
#[derive(Debug, Clone)]
pub struct ExactEnvironment {
    pub building: String,
    pub mode: String,
    /// How many of the owned buildings run this mode and coverage mix.
    pub count: u32,
    /// Facilities covered per building, e.g. `[("Farmland", 16)]`.
    pub covers: Vec<(String, u32)>,
    pub option: CoverageOption,
}

/// The result of [`solve_exact`].
#[derive(Debug, Clone)]
pub struct ExactPlan {
    /// Coins (or other target currency) per second.
    pub rate_per_second: f64,
    /// The goal's value: the same as `rate_per_second` when earning, otherwise the most of a
    /// byproduct per second or the level-up pace.
    pub objective: f64,
    /// No plan can earn more than this: the same as `rate_per_second` once proven optimal.
    pub upper_bound: f64,
    /// `true` if the search finished, so `rate_per_second` is the best possible.
    pub proven_optimal: bool,
    /// Relaxations solved during the search.
    pub nodes: u32,
    /// Batches/sec of each recipe that runs.
    pub recipe_rates: BTreeMap<String, f64>,
    /// Whole units set to each recipe that runs.
    pub units: BTreeMap<String, u32>,
    /// Units/sec sold of each item.
    pub sold: BTreeMap<String, f64>,
    pub environment: Vec<ExactEnvironment>,
    /// Overlapping pairs of environment buildings (see [`ExactPair`]).
    pub pairs: Vec<ExactPair>,
    /// Level-ups per day, for a level-up goal (see [`PACE_UNIT`]).
    pub pace: Option<f64>,
    /// When planning with the player's roster, `(building, member, share of its day)` for each
    /// environment building kind a member staffs (see [`crate::models::Crew`]).
    pub staffing: Vec<(String, usize, f64)>,
    /// Crop work assigned to each roster member under a headcount limit.
    pub crop_staffing: Vec<(String, u32, usize, f64)>,
    pub work_routes: Vec<WorkRoute>,
    pub work_posts: Vec<(String, usize, f64)>,
    /// Member, walking days/day, reserved idle days/day at a dedicated workplace.
    pub movement_staffing: Vec<(usize, f64, f64)>,
    /// Hauling days/day assigned to each roster member, sharing its production capacity.
    pub hauling_staffing: Vec<(usize, f64)>,
    pub hauling_routes: Vec<(String, usize, f64)>,
}

#[derive(Debug, Clone)]
pub struct WorkRoute {
    pub recipe: String,
    pub member: usize,
    pub crop: Option<(String, u32)>,
    pub mobile: bool,
    pub rate: f64,
}

/// What a plan optimizes.
#[derive(Debug, Clone, Copy)]
pub enum Goal<'a> {
    /// The most currency per second while making at least each `(byproduct, per second)` floor
    /// (e.g. `("Wood Blocks", 1.2)`), for "prioritize byproducts".
    Earn { floors: &'a [(String, f64)] },
    /// Grow as many seasonal crops as possible, then diversify ordinary crops at the owned levels.
    CropVariety { seasonal_only: bool },
    /// Maximize a currency or byproduct while preserving planting coverage and earlier priorities.
    EarnWithCropVariety { minimum: u32, seasonal_only: bool, floors: &'a [(String, f64)] },
    /// The most of one byproduct per second (e.g. `"Wood Blocks"`), ignoring currency: how high
    /// that byproduct's floor can go.
    MostOf(&'a str),
    /// The soonest RV level-up: the most level-ups per day (see [`PACE_UNIT`]).
    LevelUp(&'a LevelUp),
    /// The most of `target` per second, a currency other than coins (season points), while
    /// keeping up at least `pace` level-ups per day, which coins still pay for: during a season,
    /// the fastest level-up with as much of the season as it leaves room for.
    MostWhileLevelingUp(&'a LevelUp, f64, &'a str),
    /// The most currency per second while keeping up at least `pace` level-ups per day and each
    /// `(currency, per second)` floor (the season points the solve above found): the fastest
    /// level-up, earning as much as it leaves room for.
    EarnWhileLevelingUp(&'a LevelUp, f64, &'a [(String, f64)]),
    /// With the pace, coins per second and floors all kept, the most extra of what the level-up
    /// costs (each as a share of its cost): spare Bench and Kiln time processes whatever the
    /// level-up doesn't need yet, instead of leaving it raw.
    StockUp(&'a LevelUp, f64, f64, &'a [(String, f64)]),
    /// Maximize productive material work, independent of the worker's speed, or keep its maximum.
    MaterialWork { base: &'a Goal<'a>, minimum: Option<f64> },
    /// Balanced net production of the outstanding RV materials, keeping the main priorities.
    UpgradeMaterials { base: &'a Goal<'a>, level_up: &'a LevelUp, minimum: Option<f64> },
}

impl Goal<'_> {
    /// The `(byproduct or currency, per second)` floors a plan for this goal has to keep.
    fn floors(&self) -> &[(String, f64)] {
        match self {
            Goal::Earn { floors } | Goal::EarnWithCropVariety { floors, .. } | Goal::EarnWhileLevelingUp(.., floors)
            | Goal::StockUp(.., floors) => floors,
            Goal::MaterialWork { base, .. } | Goal::UpgradeMaterials { base, .. } => base.floors(),
            Goal::CropVariety { .. } | Goal::MostOf(_) | Goal::LevelUp(_) | Goal::MostWhileLevelingUp(..) => &[],
        }
    }
}

/// What an RV level-up costs and what's already in stock, as `(item, amount)` with `"coins"` for
/// coins, e.g. cost `[("coins", 69000.0), ("rough_lumber", 290.0), ("coarse_sifted_ore", 360.0)]`.
/// Stock can hold anything, including Wood Blocks and Mineral Sand (`wood_block`, `mineral_sand`)
/// or a lower tier the Bench or Kiln can still turn into what's needed.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct LevelUp {
    pub cost: Vec<(String, f64)>,
    #[serde(default)]
    pub stock: Vec<(String, f64)>,
}

impl LevelUp {
    fn amount(list: &[(String, f64)], name: &str) -> f64 {
        list.iter().filter(|(n, _)| n == name).map(|(_, a)| a).sum()
    }

    /// Whether the stock already covers the whole cost.
    pub fn ready(&self) -> bool {
        self.cost.iter().all(|(name, amount)| Self::amount(&self.stock, name) >= *amount)
    }
}

/// Seconds per unit of pace: a pace of 1 is one level-up per day. Keeps the pace variable near 1
/// rather than near 1e-6, where a solver's absolute tolerances would swamp it.
pub const PACE_UNIT: f64 = 86_400.0;

/// The weight of coins per second in the level-up stock solve, whose goal is extra level-up items:
/// enough to sell what would otherwise be left over, nowhere near enough to trade an item for.
const STOCK_UP_COIN_WEIGHT: f64 = 1e-6;

/// The highest pace the model allows (a level-up every second), so a level-up the stock already
/// covers doesn't leave the model unbounded.
const MAX_PACE: f64 = PACE_UNIT;

/// Every byproduct any recipe makes (e.g. `"Wood Blocks"`, `"Mineral Sand"`), sorted.
pub fn byproducts(items: &[ProductionItem]) -> Vec<String> {
    let mut names: Vec<String> = items.iter().filter_map(|i| i.byproduct.as_ref().map(|(r, _)| r.clone())).collect();
    names.sort_unstable();
    names.dedup();
    names
}

pub fn is_upgrade_material(recipe: &ProductionItem) -> bool {
    recipe.sell_currency == "none"
}

/// One recipe occupies its own physical building, including upgrade-material chains.
/// Retain the shared-unit machinery for compatibility, but do not enable automatic recipe changes.
pub fn takes_turns(recipe: &ProductionItem) -> bool {
    const SHARE_RECIPE_BUILDINGS: bool = false;
    SHARE_RECIPE_BUILDINGS && is_upgrade_material(recipe)
}

fn processes_upgrade_materials(recipe: &ProductionItem) -> bool {
    is_upgrade_material(recipe) && matches!(recipe.facility.as_str(), "Woodworking Bench" | "Chimney Kiln")
}

/// The item a recipe makes: a quick variant makes the regular item, and an uncovered crop (see
/// [`crate::models::add_uncovered_variants`]) makes the same crop, just slower.
fn made_item<'a>(name: &'a str, all: &HashMap<&str, &ProductionItem>) -> &'a str {
    let name = crate::models::base_item_name(name);
    match name.strip_prefix("quick_") {
        Some(base) if all.contains_key(base) => base,
        _ => name,
    }
}

/// What a model variable stands for.
enum VarKind<'a> {
    Rate(&'a ProductionItem),
    Units(&'a ProductionItem),
    Sold(&'a str),
    Pace,
    MaterialPace,
    CropVariety,
    LowerLevelPlots,
    UnavailableCrop,
    PoweredUnits,
    PowerGenerators,
    /// Made beyond what the level-up needs, of one of its costs.
    Extra,
    Environment { building: &'a str, mode: &'a str, types: Vec<&'a str>, option: CoverageOption },
    /// Two buildings placed to overlap, covering three zones at once.
    EnvironmentPair {
        buildings: (&'a str, &'a str),
        modes: (&'a str, &'a str),
        types: Vec<&'a str>,
        option: PairOption,
    },
    /// How much of a roster member's day goes to staffing environment buildings of one kind
    /// (see [`crate::models::Crew`]).
    Staff { building: String, member: usize },
    CropStaff { ability: String, level: u32, member: usize },
    WorkPost { station: String, member: usize },
    WorkRoute { recipe: &'a ProductionItem, member: usize, crop: Option<(String, u32)>, mobile: bool, seconds: f64, travel: f64 },
    ActiveAniimo,
    HaulingStaff { recipe: &'a ProductionItem, member: usize, seconds: f64 },
}

/// One linear constraint: `(variable, coefficient)` terms, comparison, right-hand side.
type Constraint = (Vec<(usize, f64)>, ComparisonOp, f64);

/// The mixed-integer program, kept independent of any one `microlp` solve so every node of the
/// search can rebuild its relaxation with its own bounds.
struct Model<'a> {
    objective: Vec<f64>,
    /// Currency per second per unit of each variable, whatever the objective is.
    earnings: Vec<f64>,
    bounds: Vec<(f64, f64)>,
    integer: Vec<bool>,
    /// Branching order for whole-unit variables, lowest first: environment buildings, then
    /// gatherers, then processors.
    priority: Vec<u8>,
    kinds: Vec<VarKind<'a>>,
    constraints: Vec<Constraint>,
    /// `(variable, weight)` for the tie-break in the objective (see [`BUILDING_TIE_BREAK`]),
    /// so a solve's objective can be given back without it.
    tiebreak: Vec<(usize, f64)>,
}

/// What each environment building a plan sets up costs in the objective: far too little to give
/// up anything real for (0.036 coins an hour), but enough that of plans that are otherwise equal,
/// the one with the fewest buildings wins. Each building in use needs an Aniimo, and otherwise
/// the solver is free to spread three plots over two Heat Furnaces that one would cover.
const BUILDING_TIE_BREAK: f64 = 1e-5;
const LOWER_LEVEL_PLOT_TIE_BREAK: f64 = 1e-6;

impl<'a> Model<'a> {
    fn add(&mut self, objective: f64, bounds: (f64, f64), integer: bool, kind: VarKind<'a>) -> usize {
        self.objective.push(objective);
        self.bounds.push(bounds);
        self.integer.push(integer);
        self.priority.push(match &kind {
            VarKind::Environment { .. } | VarKind::EnvironmentPair { .. } => 0,
            VarKind::Units(recipe) if recipe.raw_materials.is_none() => 1,
            _ => 2,
        });
        self.kinds.push(kind);
        self.objective.len() - 1
    }

    fn constrain(&mut self, terms: Vec<(usize, f64)>, op: ComparisonOp, rhs: f64) {
        // One term per variable: `microlp` rejects a constraint naming the same variable twice
        // (a recipe that uses an item twice, or makes and uses the same item).
        let mut merged: BTreeMap<usize, f64> = BTreeMap::new();
        for (v, c) in terms {
            *merged.entry(v).or_default() += c;
        }
        self.constraints.push((merged.into_iter().collect(), op, rhs));
    }

    /// Solves the relaxation with `bounds`: its objective and variable values, or `None` if
    /// infeasible.
    fn relax(&self, bounds: &[(f64, f64)]) -> Option<(f64, Vec<f64>)> {
        let mut problem = Problem::new(OptimizationDirection::Maximize);
        let vars: Vec<microlp::Variable> =
            self.objective.iter().zip(bounds).map(|(&c, &b)| problem.add_var(c, b)).collect();
        for (terms, op, rhs) in &self.constraints {
            let expr: Vec<(microlp::Variable, f64)> = terms.iter().map(|&(v, c)| (vars[v], c)).collect();
            problem.add_constraint(&expr, *op, *rhs);
        }
        let solution = problem.solve().ok()?;
        Some((solution.objective(), vars.iter().map(|v| solution[*v]).collect()))
    }
}

/// The daily season currency budget, if set, and each season crop's seed cost per batch against
/// its rate in `rates` (see [`crate::models::SeasonTerms::currency_per_day`]).
fn season_budget<T: Copy>(rates: &[(&ProductionItem, T)]) -> Option<(f64, Vec<(T, f64)>)> {
    let mut budget = None;
    let mut spent = Vec::new();
    for &(recipe, rate) in rates {
        let Some(terms) = recipe.season.filter(|s| s.seed_cost > 0.0) else { continue };
        if let Some(limit) = terms.currency_per_day {
            budget = Some(limit);
            spent.push((rate, terms.seed_cost));
        }
    }
    budget.map(|b| (b, spent))
}

fn is_season_crop(recipe: &ProductionItem, crop: &str) -> bool {
    recipe.season.is_some()
        && matches!(recipe.facility.as_str(), "Farmland" | "Woodland")
        && crate::models::base_item_name(&recipe.name) == crop
}

fn crop_work<'a, T: Copy>(
    rates: &[(&ProductionItem, T)],
    steps: &'a crate::models::GrowerSteps,
    crew: &crate::models::Crew,
) -> BTreeMap<(&'a str, u32), Vec<(T, f64)>> {
    let waters = crew.members.iter().any(|m| m.count > 0 && m.level("Water") > 0);
    let mut work = BTreeMap::<_, Vec<_>>::new();
    for &(recipe, rate) in rates {
        for job in steps.get(&recipe.name) {
            if job.step == "Watering" && !waters {
                continue;
            }
            let time = crate::models::Worker::new(job.min_level, false).seconds_for(job.workload, job.min_level, true);
            work.entry((job.ability.as_str(), job.min_level)).or_default().push((rate, time));
        }
    }
    work
}

fn work_station(recipe: &ProductionItem) -> String {
    if takes_turns(recipe) { format!("facility:{}", recipe.facility) } else { format!("recipe:{}", recipe.name) }
}

fn work_spec(recipe: &ProductionItem, crop: Option<&(String, u32)>, member: usize,
    counts: &FacilityCounts) -> Option<(f64, u32)> {
    let crew = counts.crew()?;
    match crop {
        None if recipe.crew == Some(member) && !crew.residents.contains(&recipe.facility) => Some((recipe.production_time, 1)),
        Some((ability, level)) if crew.can_work(member, ability, *level) => {
            let jobs: Vec<_> = counts.grower_steps()?.get(&recipe.name).iter()
                .filter(|j| j.ability == *ability && j.min_level == *level).collect();
            if jobs.is_empty() { return None; }
            let worker = crate::models::Worker::new(crew.members[member].level(ability), false);
            Some((jobs.iter().map(|j| worker.seconds_for(j.workload, *level, true)).sum(), jobs.len() as u32))
        }
        _ => None,
    }
}

fn work_groups(recipe: &ProductionItem, counts: &FacilityCounts) -> Vec<Option<(String, u32)>> {
    let Some(crew) = counts.crew() else { return Vec::new() };
    if recipe.crew.is_some() {
        return if crew.residents.contains(&recipe.facility) { Vec::new() } else { vec![None] };
    }
    let Some(steps) = counts.grower_steps() else { return Vec::new() };
    steps.get(&recipe.name).iter()
        .filter(|j| j.step != "Watering" || crew.members.iter().any(|m| m.count > 0 && m.level("Water") > 0))
        .map(|j| Some((j.ability.clone(), j.min_level))).collect::<std::collections::BTreeSet<_>>().into_iter().collect()
}

// Dedicated workers reserve the whole shift at one physical unit. Mobile workers may share
// jobs, but pay the estimated walk to their next workplace on every batch/job visit.
fn add_movement_work<'a>(model: &mut Model<'a>, rates: &[(&'a ProductionItem, usize)],
    units: &[(&'a ProductionItem, usize)], counts: &FacilityCounts, busy: &mut [Vec<(usize, f64)>]) {
    let crew = counts.crew().unwrap();
    let mut posts = BTreeMap::<(String, usize), usize>::new();
    let mut local_work = BTreeMap::<usize, Vec<(usize, f64)>>::new();
    let mut turn_posts = BTreeMap::<String, Vec<(usize, f64)>>::new();
    for (&(recipe, rate), &(_, unit)) in rates.iter().zip(units) {
        for crop in work_groups(recipe, counts) {
            let mut demand = vec![(rate, -1.0)];
            for member in 0..crew.members.len() {
                let Some((seconds, visits)) = work_spec(recipe, crop.as_ref(), member, counts) else { continue };
                let key = (work_station(recipe), member);
                let post = *posts.entry(key.clone()).or_insert_with(|| {
                    let post = model.add(0.0, (0.0, counts.get_count(&recipe.facility).min(crew.members[member].count) as f64), true,
                        VarKind::WorkPost { station: key.0.clone(), member });
                    busy[member].push((post, 1.0));
                    if takes_turns(recipe) { turn_posts.entry(recipe.facility.clone()).or_default().push((post, 1.0)); }
                    else { model.constrain(vec![(post, 1.0), (unit, -1.0)], ComparisonOp::Le, 0.0); }
                    post
                });
                for mobile in [false, true] {
                    let travel = if mobile { counts.member_movement_seconds(member) * visits as f64 } else { 0.0 };
                    let allocation = model.add(0.0, (0.0, f64::INFINITY), false, VarKind::WorkRoute {
                        recipe, member, crop: crop.clone(), mobile, seconds, travel });
                    demand.push((allocation, 1.0));
                    if mobile { busy[member].push((allocation, seconds + travel)); }
                    else {
                        local_work.entry(post).or_default().push((allocation, seconds));
                        if crop.is_some() {
                            model.constrain(vec![(allocation, recipe.production_time), (post, -1.0)], ComparisonOp::Le, 0.0);
                        }
                    }
                }
            }
            model.constrain(demand, ComparisonOp::Eq, 0.0);
        }
    }
    for (post, mut terms) in local_work { terms.push((post, -1.0)); model.constrain(terms, ComparisonOp::Le, 0.0); }
    for (facility, terms) in turn_posts { model.constrain(terms, ComparisonOp::Le, counts.get_count(&facility) as f64); }
    for terms in busy.iter() { for &(v, time) in terms {
        if matches!(model.kinds[v], VarKind::WorkPost { .. } | VarKind::WorkRoute { .. }) {
            let weight = 1e-8 * time;
            model.objective[v] -= weight; model.tiebreak.push((v, weight));
        }
    } }
}

fn check_movement(plan: &ExactPlan, all: &HashMap<&str, &ProductionItem>, counts: &FacilityCounts,
    busy: &mut [f64]) -> Result<(), String> {
    const EPS: f64 = 1e-5;
    let mut posts = BTreeMap::<(&str, usize), f64>::new();
    for (station, member, count) in &plan.work_posts {
        if *member >= busy.len() || !count.is_finite() || *count < 0.0 || (count - count.round()).abs() > EPS {
            return Err("invalid dedicated worker count".into());
        }
        *posts.entry((station.as_str(), *member)).or_default() += count;
        busy[*member] += count;
    }
    let mut covered = BTreeMap::<(&str, Option<(String, u32)>), f64>::new();
    let mut local_used = BTreeMap::<(String, usize), f64>::new();
    let mut local_groups = BTreeMap::<(String, usize, Option<(String, u32)>), f64>::new();
    for route in &plan.work_routes {
        let recipe = all.get(route.recipe.as_str()).ok_or("unknown workplace recipe")?;
        let (seconds, visits) = work_spec(recipe, route.crop.as_ref(), route.member, counts).ok_or("invalid workplace assignment")?;
        if !work_groups(recipe, counts).contains(&route.crop) || !route.rate.is_finite() || route.rate < 0.0 {
            return Err("invalid workplace rate".into());
        }
        *covered.entry((&route.recipe, route.crop.clone())).or_default() += route.rate;
        if route.mobile { busy[route.member] += route.rate * (seconds + visits as f64 * counts.member_movement_seconds(route.member)); }
        else {
            *local_used.entry((work_station(recipe), route.member)).or_default() += route.rate * seconds;
            *local_groups.entry((work_station(recipe), route.member, route.crop.clone())).or_default() += route.rate;
        }
    }
    for (name, rate) in &plan.recipe_rates {
        for group in work_groups(all[name.as_str()], counts) {
            if (covered.get(&(name.as_str(), group)).copied().unwrap_or(0.0) - rate).abs() > EPS {
                return Err(format!("unassigned production or crop visits for {name}"));
            }
        }
    }
    for ((name, _), rate) in &covered {
        if !plan.recipe_rates.contains_key(*name) && *rate > EPS { return Err("visits assigned to an idle recipe".into()); }
    }
    let mut turn_posts = BTreeMap::<&str, f64>::new();
    for ((station, member), count) in &posts {
        if station.starts_with("facility:") {
            let facility = station.trim_start_matches("facility:");
            *turn_posts.entry(facility).or_default() += count;
        } else {
            let name = station.strip_prefix("recipe:").ok_or("invalid workplace")?;
            if !all.contains_key(name) || *count > plan.units.get(name).copied().unwrap_or(0) as f64 + EPS {
                return Err("dedicated workers exceed physical workplaces".into());
            }
        }
        if local_used.get(&(station.to_string(), *member)).copied().unwrap_or(0.0) > count + EPS {
            return Err("dedicated worker is overloaded".into());
        }
    }
    for ((station, member), work) in &local_used {
        if *work > posts.get(&(station.as_str(), *member)).copied().unwrap_or(0.0) + EPS {
            return Err("local work has no dedicated worker".into());
        }
    }
    for ((station, member, group), rate) in local_groups {
        if group.is_some() {
            let recipe = all[station.trim_start_matches("recipe:")];
            if rate * recipe.production_time > posts.get(&(station.as_str(), member)).copied().unwrap_or(0.0) + EPS {
                return Err("dedicated crop worker visits multiple plots".into());
            }
        }
    }
    for (facility, count) in turn_posts {
        if count > counts.get_count(facility) as f64 + EPS { return Err("too many dedicated turn-facility workers".into()); }
    }
    Ok(())
}

/// Builds the model for `items` (production times already set for the Aniimo working them).
fn build_model<'a>(
    items: &'a [ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
    goal: Goal,
) -> Model<'a> {
    let mut goal = goal;
    let mut material_work = None;
    let mut material_stock = None;
    loop {
        match goal {
            Goal::MaterialWork { base, minimum } => { material_work = Some(minimum); goal = *base; }
            Goal::UpgradeMaterials { base, level_up, minimum } => { material_stock = Some((level_up, minimum)); goal = *base; }
            _ => break,
        }
    }
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let recipes: Vec<&ProductionItem> = items
        .iter()
        .filter(|item| {
            facility_counts.get_count(&item.facility) > 0
                && facility_counts.can_produce(&item.facility, item.facility_level)
                && item.module_requirement.as_ref().is_none_or(|(m, l)| module_levels.can_use(m, *l))
                && item.production_time > 0.0
        })
        .collect();
    let mut model = Model {
        objective: Vec::new(),
        earnings: Vec::new(),
        bounds: Vec::new(),
        integer: Vec::new(),
        priority: Vec::new(),
        kinds: Vec::new(),
        constraints: Vec::new(),
        tiebreak: Vec::new(),
    };

    // Seeds are paid in coins, so they only come off a coin total.
    let seed_cost = |recipe: &ProductionItem| if currency == "coins" { recipe.cost.unwrap_or(0.0) } else { 0.0 };

    // Recipe rates and units.
    let mut rate_of: Vec<(&ProductionItem, usize)> = Vec::new();
    let mut units_of: Vec<(&ProductionItem, usize)> = Vec::new();
    for &recipe in &recipes {
        let rate = model.add(-seed_cost(recipe), (0.0, f64::INFINITY), false, VarKind::Rate(recipe));
        let max = facility_counts.get_count(&recipe.facility) as f64;
        let units = model.add(0.0, (0.0, max), !takes_turns(recipe), VarKind::Units(recipe));
        model.constrain(vec![(rate, recipe.production_time), (units, -1.0)], ComparisonOp::Le, 0.0);
        rate_of.push((recipe, rate));
        units_of.push((recipe, units));
    }
    // The season currency the player can spend on seeds a day.
    if let Some((budget, spent)) = season_budget(&rate_of) {
        model.constrain(spent.into_iter().map(|(v, cost)| (v, cost * PACE_UNIT)).collect(), ComparisonOp::Le, budget);
    }
    for (crop, &minimum) in facility_counts.season_crop_minimums() {
        let mut growing = Vec::new();
        for (&(recipe, rate), &(_, units)) in rate_of.iter().zip(&units_of) {
            if is_season_crop(recipe, crop) {
                // A tight seed budget can slow a crop down. Each assigned plot still has to
                // grow at least one batch a day, or one natural cycle if that takes longer.
                model.constrain(vec![(rate, recipe.production_time.max(PACE_UNIT)), (units, -1.0)], ComparisonOp::Ge, 0.0);
                growing.push((units, 1.0));
            }
        }
        if growing.is_empty() {
            let unavailable = model.add(0.0, (0.0, 0.0), false, VarKind::UnavailableCrop);
            growing.push((unavailable, 1.0));
        }
        model.constrain(growing, ComparisonOp::Ge, minimum as f64);
    }

    // Item balances: made >= used + sold.
    let mut balance: BTreeMap<&str, Vec<(usize, f64)>> = BTreeMap::new();
    for &(recipe, rate) in &rate_of {
        balance.entry(made_item(&recipe.name, &all)).or_default().push((rate, recipe.yield_amount as f64));
        if let Some((resource, amount)) = &recipe.byproduct {
            if let Some(item) = byproduct_item(resource) {
                balance.entry(item).or_default().push((rate, *amount as f64));
            }
        }
        if let (Some(inputs), Some(amounts)) = (&recipe.raw_materials, &recipe.required_amount) {
            for (input, &amount) in inputs.iter().zip(amounts) {
                balance.entry(input.as_str()).or_default().push((rate, -(amount as f64)));
            }
        }
    }
    // A floor naming a currency ("aniimo_exp", "aniipods") keeps a plan making that much of it
    // while it earns `currency`; those items need sell variables too, worth nothing here. So does
    // the season's points a level-up plan makes the most of while coins pay for the level-up.
    let mut floor_currencies: Vec<&str> = goal.floors().iter().map(|(name, _)| name.as_str()).collect();
    if let Goal::MostWhileLevelingUp(_, _, target) = goal {
        floor_currencies.push(target);
    }
    let mut sold_of: Vec<(usize, &ProductionItem)> = Vec::new();
    for (&item_name, terms) in &mut balance {
        if let Some(&item) = all.get(item_name) {
            if item.earns(currency) > 0.0 || floor_currencies.iter().any(|&c| item.earns(c) > 0.0) {
                let sold = model.add(item.earns(currency), (0.0, f64::INFINITY), false, VarKind::Sold(item.name.as_str()));
                sold_of.push((sold, item));
                terms.push((sold, -1.0));
            }
        }
    }
    // Every variable added from here on earns nothing.
    model.earnings = model.objective.clone();
    // A level-up: stock and cost per unit of pace, in coins and in every item they name.
    let level_up = match goal {
        Goal::LevelUp(level_up) => Some((level_up, 0.0)),
        // Slack of 0.01% (about 9 seconds a day): `pace` is another solve's maximum, and the pace
        // terms are small enough that a tighter floor sits inside the solver's tolerances.
        Goal::MostWhileLevelingUp(level_up, pace, _)
        | Goal::EarnWhileLevelingUp(level_up, pace, _)
        | Goal::StockUp(level_up, pace, ..) => Some((level_up, pace * (1.0 - 1e-4))),
        _ => None,
    };
    if let Some((level_up, min_pace)) = level_up {
        let pace = model.add(0.0, (min_pace.min(MAX_PACE), MAX_PACE), false, VarKind::Pace);
        let per_pace = |name: &str| (LevelUp::amount(&level_up.stock, name) - LevelUp::amount(&level_up.cost, name)) / PACE_UNIT;
        let coin_terms: Vec<(usize, f64)> =
            model.earnings.iter().enumerate().filter(|(_, c)| **c != 0.0).map(|(v, c)| (v, *c)).collect();
        let mut earned = coin_terms.clone();
        earned.push((pace, per_pace(currency)));
        model.constrain(earned, ComparisonOp::Ge, 0.0);
        if let Goal::StockUp(_, _, coins, _) = goal {
            // Slack of 0.1%: `coins` is another solve's maximum, and a tighter floor can leave no
            // whole-unit plan the independent re-check accepts (seen at RV 9 and 14).
            model.constrain(coin_terms, ComparisonOp::Ge, coins - 1e-3 * coins.abs());
        }
        for (name, _) in level_up.cost.iter().chain(&level_up.stock) {
            if name != currency {
                balance.entry(name.as_str()).or_default();
            }
        }
        for (&name, terms) in &mut balance {
            let net = per_pace(name);
            if net != 0.0 {
                terms.push((pace, net));
            }
        }
        match goal {
            Goal::LevelUp(_) => {
                model.objective.iter_mut().for_each(|c| *c = 0.0);
                model.objective[pace] = 1.0;
            }
            Goal::MostWhileLevelingUp(_, _, target) => {
                // Coins still have to cover the level-up (above); what's left goes to `target`.
                model.objective.iter_mut().for_each(|c| *c = 0.0);
                for &(sold, item) in &sold_of {
                    model.objective[sold] = item.earns(target);
                }
            }
            Goal::StockUp(..) => {
                // Coins only break ties, so anything spare (clay a Mine makes beyond what's used,
                // say) still sells instead of piling up; far too little to cost a level-up item.
                for (c, &earned) in model.objective.iter_mut().zip(&model.earnings) {
                    *c = earned * STOCK_UP_COIN_WEIGHT;
                }
                for (name, need) in &level_up.cost {
                    if let Some(terms) = balance.get_mut(name.as_str()).filter(|_| *need > 0.0) {
                        // Per day, as a share of the cost: comparable across costs.
                        let extra = model.add(PACE_UNIT / need, (0.0, f64::INFINITY), false, VarKind::Extra);
                        terms.push((extra, -1.0));
                    }
                }
            }
            _ => {}
        }
    }
    let material_requirements: Vec<_> = material_stock.into_iter().flat_map(|(level_up, _)| {
        level_up.cost.iter().filter_map(|(name, need)| {
            let remaining = (need - LevelUp::amount(&level_up.stock, name)).max(0.0);
            (name != currency && remaining > 0.0)
                .then(|| (balance.get(name.as_str()).cloned().unwrap_or_default(), remaining))
        })
    }).collect();
    for terms in balance.into_values() {
        model.constrain(terms, ComparisonOp::Ge, 0.0);
    }

    // Owned units per facility, by level: a recipe needing level L can only use units at L or
    // above, and higher-level units can run lower-level recipes too.
    let mut by_facility: BTreeMap<&str, Vec<(u32, usize)>> = BTreeMap::new();
    let mut powered: BTreeMap<(&str, u32), Vec<(usize, bool)>> = BTreeMap::new();
    let mut generator_count = None;
    for &(recipe, units) in &units_of {
        if let Some(level) = electric_level(&recipe.name) {
            powered.entry((recipe.facility.as_str(), level)).or_default().push((units, takes_turns(recipe)));
            if takes_turns(recipe) {
                continue;
            }
        }
        by_facility.entry(recipe.facility.as_str()).or_default().push((recipe.facility_level, units));
    }
    if let Some(power) = facility_counts.power() {
        let mut draw = Vec::new();
        for ((facility, level), vars) in powered {
            let owned: u32 = facility_counts.tiers(facility).iter().filter(|(_, l)| *l == level).map(|(n, _)| n).sum();
            let mut exact_tier: Vec<_> = vars.iter().filter(|(_, turns)| !turns).map(|&(v, _)| (v, 1.0)).collect();
            let mut shared: Vec<_> = vars.iter().filter(|(_, turns)| *turns).map(|&(v, _)| (v, 1.0)).collect();
            if !shared.is_empty() {
                // An electric unit can take turns between electric formulas only.
                let reserved = model.add(0.0, (0.0, owned as f64), true, VarKind::PoweredUnits);
                shared.push((reserved, -1.0));
                model.constrain(shared, ComparisonOp::Le, 0.0);
                by_facility.entry(facility).or_default().push((level, reserved));
                exact_tier.push((reserved, 1.0));
            }
            let watts = watts_per_level(facility) as f64 * level as f64 * power.grid.percent as f64 / 100.0;
            draw.extend(exact_tier.iter().map(|&(v, _)| (v, watts)));
            model.constrain(exact_tier, ComparisonOp::Le, owned as f64);
        }
        if !draw.is_empty() {
            model.constrain(draw.clone(), ComparisonOp::Le, power.grid.watts as f64);
            let generators = model.add(0.0, (0.0, generator_workers(power.grid.watts as f64) as f64), true, VarKind::PowerGenerators);
            draw.push((generators, -WATTS_PER_GENERATOR_ANIIMO));
            model.constrain(draw, ComparisonOp::Le, 0.0);
            generator_count = Some(generators);
        }
    }
    for (&facility, entries) in &by_facility {
        let mut levels: Vec<u32> = entries.iter().map(|(l, _)| *l).collect();
        levels.sort_unstable();
        levels.dedup();
        for level in levels {
            let terms: Vec<(usize, f64)> = entries.iter().filter(|(l, _)| *l >= level).map(|(_, v)| (*v, 1.0)).collect();
            model.constrain(terms, ComparisonOp::Le, facility_counts.capacity_at_level(facility, level) as f64);
        }
    }

    // Growing environments: plots of a crop needing environment E at facility F must be covered.
    let gated_types: Vec<&str> = ENVIRONMENT_GATED_FACILITIES.iter().map(|(f, _)| *f).collect();
    let mut needs_cover: BTreeMap<(&str, &str), Vec<usize>> = BTreeMap::new();
    for &(recipe, units) in &units_of {
        if let Some(environment) = recipe.environment.as_deref() {
            if gated_types.contains(&recipe.facility.as_str()) {
                needs_cover.entry((recipe.facility.as_str(), environment)).or_default().push(units);
            }
        }
    }
    let mut cover_terms: BTreeMap<(&str, &str), Vec<(usize, f64)>> = BTreeMap::new();
    // Every building a variable uses, so no plan sets out more than are owned.
    let mut usage: BTreeMap<&str, Vec<(usize, f64)>> = BTreeMap::new();
    // The facility types wanting a given mode, largest footprint first (see
    // `single_building_options`).
    let types_for = |modes: &[&str]| -> Vec<&str> {
        let mut types: Vec<&str> =
            needs_cover.keys().filter(|(_, e)| modes.contains(e)).map(|(f, _)| *f).collect();
        types.sort_unstable();
        types.dedup();
        types.sort_by(|a, b| {
            let (fa, fb) = (facility_footprint(a).unwrap_or(0.0), facility_footprint(b).unwrap_or(0.0));
            fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(b))
        });
        types
    };
    for &(building, modes) in ENVIRONMENT_BUILDINGS {
        let owned = facility_counts.get_count(building);
        if owned == 0 {
            continue;
        }
        for &mode in modes {
            let types = types_for(&[mode]);
            if types.is_empty() {
                continue;
            }
            for option in single_building_options(building_size(building), &types) {
                let counts = option.counts.clone();
                let kind = VarKind::Environment { building, mode, types: types.clone(), option };
                let count = model.add(0.0, (0.0, owned as f64), !coverage_relaxed(), kind);
                usage.entry(building).or_default().push((count, 1.0));
                for (t, &facility) in types.iter().enumerate() {
                    if counts[t] > 0 {
                        cover_terms.entry((facility, mode)).or_default().push((count, counts[t] as f64));
                    }
                }
            }
        }
    }
    // Two buildings placed to overlap: where both reach, their temperatures add, giving a third
    // zone. Only worth a variable when that zone is a mode some crop actually wants and neither
    // building already provides it on its own.
    for (i, &(first, first_modes)) in ENVIRONMENT_BUILDINGS.iter().enumerate().take(if OVERLAP_ZONES { usize::MAX } else { 0 }) {
        for &(second, second_modes) in &ENVIRONMENT_BUILDINGS[i..] {
            let (owned_first, owned_second) = (facility_counts.get_count(first), facility_counts.get_count(second));
            let most = if first == second { owned_first / 2 } else { owned_first.min(owned_second) };
            if most == 0 {
                continue;
            }
            for &mode_a in first_modes {
                for &mode_b in second_modes {
                    let (Some(a), Some(b)) = (mode_temperature(mode_a), mode_temperature(mode_b)) else {
                        continue; // the Sunlamp's Adequate is off the temperature line
                    };
                    let Some(middle) = temperature_mode(a + b) else { continue };
                    // A pair earns its place only by covering three temperatures from two
                    // buildings. Set both the same and the outer zones agree, so the pair offers
                    // the same two modes two separate buildings do, over less ground; likewise
                    // when the shared zone reads as one of the buildings' own settings.
                    if mode_a == mode_b
                        || middle == mode_a
                        || middle == mode_b
                        || !needs_cover.keys().any(|(_, e)| *e == middle)
                    {
                        continue;
                    }
                    let types = types_for(&[mode_a, mode_b, middle]);
                    if types.is_empty() {
                        continue;
                    }
                    for option in pair_options_over_offsets(PairSizes::of(first, second), &types) {
                        let zones = [(Zone::First, mode_a), (Zone::Both, middle), (Zone::Second, mode_b)];
                        let counts = option.counts.clone();
                        let kind = VarKind::EnvironmentPair {
                            buildings: (first, second),
                            modes: (mode_a, mode_b),
                            types: types.clone(),
                            option,
                        };
                        let count = model.add(0.0, (0.0, most as f64), !coverage_relaxed(), kind);
                        usage.entry(first).or_default().push((count, 1.0));
                        usage.entry(second).or_default().push((count, 1.0));
                        for (zone, mode) in zones {
                            for (t, &facility) in types.iter().enumerate() {
                                let covered = counts[zone as usize][t];
                                if covered > 0 {
                                    cover_terms.entry((facility, mode)).or_default().push((count, covered as f64));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    for (building, terms) in usage {
        model.constrain(terms, ComparisonOp::Le, facility_counts.get_count(building) as f64);
    }
    for (key, plots) in &needs_cover {
        let mut terms: Vec<(usize, f64)> = plots.iter().map(|v| (*v, 1.0)).collect();
        for &(count, covered) in cover_terms.get(key).map(Vec::as_slice).unwrap_or(&[]) {
            terms.push((count, -covered));
        }
        model.constrain(terms, ComparisonOp::Le, 0.0);
    }
    // Byproducts: made per batch of any recipe that yields one.
    let byproduct_terms = |resource: &str| -> Vec<(usize, f64)> {
        rate_of
            .iter()
            .filter_map(|&(recipe, rate)| match &recipe.byproduct {
                Some((r, amount)) if r == resource => Some((rate, *amount as f64)),
                _ => None,
            })
            .collect()
    };
    for (resource, floor) in goal.floors() {
        if *floor <= 0.0 {
            continue;
        }
        let byproduct = byproduct_terms(resource);
        if !byproduct.is_empty() {
            // A hair of slack: the floor is another solve's exact maximum.
            model.constrain(byproduct, ComparisonOp::Ge, floor * (1.0 - 1e-6));
            continue;
        }
        // Otherwise it's a currency: everything sold for it, at its value, less seed costs
        // for coins (seeds are paid in coins).
        let mut sold: Vec<(usize, f64)> =
            sold_of.iter().filter(|(_, item)| item.earns(resource) > 0.0).map(|&(v, item)| (v, item.earns(resource))).collect();
        if resource == "coins" {
            sold.extend(rate_of.iter().filter(|(r, _)| r.cost.unwrap_or(0.0) > 0.0).map(|&(r, v)| (v, -r.cost.unwrap_or(0.0))));
        }
        if !sold.is_empty() {
            model.constrain(sold, ComparisonOp::Ge, floor * (1.0 - 1e-4));
        }
    }
    match goal {
        Goal::Earn { .. } | Goal::EarnWithCropVariety { .. } => {
            // Maximizing a byproduct (Wood Blocks, Mineral Sand) rather than a currency.
            let byproduct = byproduct_terms(currency);
            if !byproduct.is_empty() {
                model.objective.iter_mut().for_each(|c| *c = 0.0);
                for (v, amount) in byproduct {
                    model.objective[v] += amount;
                }
            }
        }
        Goal::MostOf(resource) => {
            model.objective.iter_mut().for_each(|c| *c = 0.0);
            for (v, amount) in byproduct_terms(resource) {
                model.objective[v] += amount;
            }
        }
        Goal::CropVariety { .. } | Goal::LevelUp(_) | Goal::MostWhileLevelingUp(..) | Goal::EarnWhileLevelingUp(..)
        | Goal::StockUp(..) | Goal::MaterialWork { .. } | Goal::UpgradeMaterials { .. } => {}
    }
    // With the player's own Aniimo (see `Crew`), each member's day covers everything it works:
    // a recipe's time per batch at its rate, or at a facility it lives in, the whole day per unit.
    // Every environment building in use is staffed all day by a member with its ability.
    let mut reserve_work = Vec::new();
    if let Some(crew) = facility_counts.crew() {
        let mut busy: Vec<Vec<(usize, f64)>> = vec![Vec::new(); crew.members.len()];
        for (&(recipe, rate), &(_, units)) in rate_of.iter().zip(&units_of) {
            let Some(member) = recipe.crew.filter(|&m| m < busy.len()) else { continue };
            if crew.residents.contains(&recipe.facility) {
                busy[member].push((units, 1.0));
            } else if facility_counts.movement_seconds() <= 0.0 {
                busy[member].push((rate, recipe.production_time));
            }
        }
        // The environment buildings of each kind the plan sets up; a pair counts each of its two.
        let mut set_up: BTreeMap<String, BTreeMap<usize, f64>> = BTreeMap::new();
        for (v, kind) in model.kinds.iter().enumerate() {
            let named: Vec<&str> = match kind {
                VarKind::Environment { building, .. } => vec![building],
                VarKind::EnvironmentPair { buildings: (a, b), .. } => vec![a, b],
                _ => continue,
            };
            for building in named {
                *set_up.entry(building.to_string()).or_default().entry(v).or_default() += 1.0;
            }
        }
        if let Some(generators) = generator_count {
            set_up.entry(GENERATOR.into()).or_default().insert(generators, 1.0);
        }
        for (building, used) in set_up {
            // A building with no ability listed needs no Aniimo (as `check_plan` takes it).
            let ability = if building == GENERATOR { Some("Lightning") } else { crew.environment.get(&building).map(String::as_str) };
            let Some(ability) = ability else { continue };
            let mut staffed: Vec<(usize, f64)> = used.into_iter().map(|(v, n)| (v, -n)).collect();
            for (member, aniimo) in crew.members.iter().enumerate() {
                if !crew.can_work(member, ability, 1) {
                    continue;
                }
                let staff = model.add(0.0, (0.0, aniimo.count as f64), building == GENERATOR, VarKind::Staff { building: building.clone(), member });
                staffed.push((staff, 1.0));
                busy[member].push((staff, 1.0));
            }
            model.constrain(staffed, ComparisonOp::Ge, 0.0);
        }
        let team_limit = facility_counts.power().and_then(|power| power.grid.max_aniimo.map(|n| (power, n)));
        if facility_counts.movement_seconds() > 0.0 {
            add_movement_work(&mut model, &rate_of, &units_of, facility_counts, &mut busy);
        } else if let Some(steps) = facility_counts.grower_steps() {
            for ((ability, level), mut needs) in crop_work(&rate_of, steps, crew) {
                for (member, aniimo) in crew.members.iter().enumerate().filter(|(member, _)| crew.can_work(*member, ability, level)) {
                    let staff = model.add(0.0, (0.0, aniimo.count as f64), false,
                        VarKind::CropStaff { ability: ability.to_string(), level, member });
                    let speed = crate::models::Worker::new(aniimo.level(ability), false).speed(level, true);
                    needs.push((staff, -speed));
                    busy[member].push((staff, 1.0));
                }
                model.constrain(needs, ComparisonOp::Eq, 0.0);
            }
        }
        for &(recipe, rate) in &rate_of {
            if facility_counts.hauling_seconds(recipe) <= 0.0 { continue; }
            let mut deliveries = vec![(rate, -1.0)];
            for (member, aniimo) in crew.members.iter().enumerate().filter(|(member, _)| crew.can_work(*member, "Hauling", 1)) {
                let seconds = facility_counts.hauling_seconds_for(recipe, aniimo.level("Hauling"));
                let staff = model.add(0.0, (0.0, f64::INFINITY), false, VarKind::HaulingStaff { recipe, member, seconds });
                deliveries.push((staff, 1.0));
                busy[member].push((staff, seconds));
            }
            model.constrain(deliveries, ComparisonOp::Eq, 0.0);
        }
        if let Some(first) = crew.assumed_from {
            reserve_work.extend(busy.iter().skip(first).flatten().copied());
        }
        if let Some((_, limit)) = team_limit {
            let mut active = Vec::new();
            for (member, mut terms) in busy.into_iter().enumerate().filter(|(_, terms)| !terms.is_empty()) {
                let count = model.add(0.0, (0.0, crew.members[member].count as f64), true, VarKind::ActiveAniimo);
                terms.push((count, -1.0));
                model.constrain(terms, ComparisonOp::Le, 0.0);
                active.push((count, 1.0));
            }
            if !active.is_empty() {
                model.constrain(active, ComparisonOp::Le, limit as f64);
            }
        } else {
            for (member, terms) in busy.into_iter().enumerate() {
                if !terms.is_empty() {
                    model.constrain(terms, ComparisonOp::Le, crew.members[member].count as f64);
                }
            }
        }
    }
    match goal {
        Goal::CropVariety { seasonal_only } => {
            add_crop_variety(&mut model, &all, facility_counts, &rate_of, &units_of, seasonal_only, None);
            return model;
        }
        Goal::EarnWithCropVariety { minimum, seasonal_only, .. } => {
            add_crop_variety(&mut model, &all, facility_counts, &rate_of, &units_of, seasonal_only, Some(minimum));
        }
        _ => {}
    }
    if let Some((_, minimum)) = material_stock {
        // Append after all existing variables: the currency solution remains a usable prefix.
        let pace = model.add(0.0, (minimum.unwrap_or(0.0) * (1.0 - 1e-4), MAX_PACE), false, VarKind::MaterialPace);
        for (mut terms, remaining) in material_requirements {
            terms.push((pace, -remaining / PACE_UNIT));
            model.constrain(terms, ComparisonOp::Ge, 0.0);
        }
        if minimum.is_none() {
            model.objective.fill(0.0);
            model.objective[pace] = 1.0;
        }
    }
    if let Some(minimum) = material_work {
        let work = rate_of.iter().filter(|(recipe, _)| processes_upgrade_materials(recipe))
            // The same batch must earn the same score for a fast owned worker, a slow
            // reserve or E-mode. Busy seconds would reward deliberately slower staffing.
            .map(|(recipe, rate)| (*rate, recipe.workload.unwrap_or(recipe.production_time)));
        if let Some(minimum) = minimum {
            model.constrain(work.collect(), ComparisonOp::Ge, (minimum - 1e-6).max(0.0));
        } else {
            model.objective.fill(0.0);
            for (rate, time) in work {
                model.objective[rate] = time;
            }
        }
    }
    // Prefer the listed crew when it can sustain the same output.
    for (variable, time) in reserve_work {
        // At this final stage all main priorities and the RV material pace are already
        // constrained. Keep the preference above the external solver's absolute MIP gap.
        let weight = if material_work.is_some() { 1e-4 } else { 1e-6 } * time;
        model.objective[variable] -= weight;
        model.tiebreak.push((variable, weight));
    }
    for &(recipe, rate) in &rate_of {
        if electric_level(&recipe.name).is_some() {
            // Prefer the worker-free alternative when the production objective is tied.
            let weight = 1e-6 * recipe.production_time;
            model.objective[rate] += weight;
            model.tiebreak.push((rate, -weight));
        }
    }
    // Of plans otherwise equal, the fewest environment buildings: a pair is two.
    for v in 0..model.kinds.len() {
        let weight = match model.kinds[v] {
            VarKind::Environment { .. } => BUILDING_TIE_BREAK,
            VarKind::EnvironmentPair { .. } => 2.0 * BUILDING_TIE_BREAK,
            VarKind::LowerLevelPlots => LOWER_LEVEL_PLOT_TIE_BREAK,
            VarKind::PowerGenerators => 1e-7,
            _ => continue,
        };
        model.objective[v] -= weight;
        model.tiebreak.push((v, weight));
    }
    model
}

fn count_crop(model: &mut Model, mut harvest: Vec<(usize, f64)>) -> usize {
    let present = model.add(0.0, (0.0, 1.0), true, VarKind::CropVariety);
    // Count only crops producing at least a batch per day (or per natural cycle if slower).
    harvest.push((present, -1.0));
    model.constrain(harvest, ComparisonOp::Ge, 0.0);
    present
}

fn add_crop_variety(
    model: &mut Model,
    all: &HashMap<&str, &ProductionItem>,
    counts: &FacilityCounts,
    rates: &[(&ProductionItem, usize)],
    units: &[(&ProductionItem, usize)],
    seasonal_only: bool,
    minimum: Option<u32>,
) {
    let maximize = minimum.is_none();
    if maximize {
        model.objective.fill(0.0);
    }
    let mut by_resource = BTreeMap::<&str, Vec<(usize, f64)>>::new();
    for facility in ["Farmland", "Woodland"].into_iter().filter(|_| !seasonal_only) {
        let tiers = counts.tiers(facility);
        let mut plots_by_level = BTreeMap::<u32, Vec<(usize, f64)>>::new();
        for &(recipe, unit) in units {
            if recipe.facility == facility && recipe.season.is_none() {
                plots_by_level.entry(recipe.facility_level).or_default().push((unit, 1.0));
            }
        }
        for (level, mut plots) in plots_by_level {
            let owned: u32 = tiers.iter().filter(|(_, l)| *l == level).map(|(count, _)| count).sum();
            if !maximize && tiers.iter().any(|&(count, l)| l > level && count > 0) {
                // Prefer matching plots when the net earnings tie. A lower-level crop can
                // still win with a better sale price or by feeding a profitable recipe.
                let lower = model.add(0.0, (0.0, counts.get_count(facility) as f64), false, VarKind::LowerLevelPlots);
                plots.push((lower, -1.0));
                model.constrain(plots, ComparisonOp::Le, owned as f64);
            }
            if owned == 0 {
                continue;
            }
            let mut resources = BTreeMap::<&str, Vec<(usize, f64)>>::new();
            for &(recipe, rate) in rates.iter().filter(|(r, _)| r.facility == facility && r.facility_level == level && r.season.is_none()) {
                // Quick, uncovered and crew variants of the same resource count once.
                resources.entry(made_item(&recipe.name, all)).or_default().push((rate, recipe.production_time.max(PACE_UNIT)));
            }
            let mut matching_plots = Vec::new();
            for (resource, harvest) in resources {
                let present = count_crop(model, harvest);
                matching_plots.push((present, 1.0));
                by_resource.entry(resource).or_default().push((present, 1.0));
            }
            model.constrain(matching_plots, ComparisonOp::Le, owned as f64);
        }
    }
    // Seasonal crop levels are minimums. Prefer one more event crop over any number of
    // ordinary crops when land, the required environment, or the seed budget is limited.
    let seasonal_weight = (by_resource.len() + 1) as f64;
    let mut seasonal = BTreeMap::<&str, Vec<(usize, f64)>>::new();
    for &(recipe, rate) in rates {
        if recipe.season.is_some() && matches!(recipe.facility.as_str(), "Farmland" | "Woodland") {
            seasonal.entry(made_item(&recipe.name, all)).or_default().push((rate, recipe.production_time.max(PACE_UNIT)));
        }
    }
    let mut covered = Vec::new();
    for harvest in seasonal.into_values() {
        covered.push((count_crop(model, harvest), seasonal_weight));
    }
    for mut matches in by_resource.into_values() {
        let resource = if matches.len() == 1 {
            matches[0].0
        } else {
            // A regular crop and its quick variant may be unlocked at different owned levels.
            let resource = model.add(0.0, (0.0, 1.0), true, VarKind::CropVariety);
            matches.push((resource, -1.0));
            model.constrain(matches, ComparisonOp::Ge, 0.0);
            resource
        };
        covered.push((resource, 1.0));
    }
    match minimum {
        None => {
            for (resource, weight) in covered {
                model.objective[resource] = weight;
            }
        }
        Some(minimum) if minimum > 0 => model.constrain(covered, ComparisonOp::Ge, minimum as f64),
        Some(_) => {}
    }
}

impl Model<'_> {
    /// A solve's objective without the tie-break (see [`BUILDING_TIE_BREAK`]): what it really
    /// made of what it maximized.
    fn untied(&self, objective: f64, values: &[f64]) -> f64 {
        objective + self.tiebreak.iter().map(|&(v, w)| w * values.get(v).copied().unwrap_or(0.0)).sum::<f64>()
    }
}

const INTEGRAL: f64 = 1e-6;

fn is_integral(value: f64) -> bool {
    (value - value.round()).abs() <= INTEGRAL
}

/// An open node of the search: its relaxation's bound and the bounds that define it.
struct Node {
    bound: f64,
    depth: u32,
    bounds: Vec<(f64, f64)>,
    values: Vec<f64>,
}

impl PartialEq for Node {
    fn eq(&self, other: &Self) -> bool {
        self.bound == other.bound && self.depth == other.depth
    }
}
impl Eq for Node {}
impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Node {
    /// Highest bound first; deeper first among equal bounds, to reach whole-unit plans sooner.
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.bound.partial_cmp(&other.bound).unwrap_or(std::cmp::Ordering::Equal).then(self.depth.cmp(&other.depth))
    }
}

/// Finds the best plan for `items` (production times already set for the Aniimo working them)
/// with the owned `facility_counts` and `module_levels`, earning `currency`. `time_limit` bounds
/// the search; `None` runs until optimality is proven.
pub fn solve_exact(
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
    goal: Goal,
    time_limit: Option<Duration>,
    start: Option<&crate::models::ProductionPlan>,
) -> Option<ExactPlan> {
    let model = build_model(items, currency, facility_counts, module_levels, goal);
    let began = Instant::now();
    let out_of_time = || time_limit.is_some_and(|limit| began.elapsed() >= limit);
    let mut nodes = 0u32;

    let (root_bound, root_values) = model.relax(&model.bounds)?;
    nodes += 1;
    if std::env::var("EXACT_DEBUG").is_ok() {
        for (i, kind) in model.kinds.iter().enumerate() {
            let v = root_values[i];
            if model.integer[i] && !is_integral(v) {
                let label = match kind {
                    VarKind::Units(r) => format!("units {} ({})", r.name, r.facility),
                    VarKind::Environment { building, mode, option, .. } => format!("env {building} {mode} {:?}", option.counts),
                    VarKind::EnvironmentPair { buildings, modes, option, .. } => {
                        format!("env pair {}+{} {}+{} at {}", buildings.0, buildings.1, modes.0, modes.1, option.offset)
                    }
                    _ => String::new(),
                };
                eprintln!("  fractional {v:.3} {label}");
            }
        }
    }
    let mut best: Option<(f64, Vec<f64>)> = None;
    // A plan only counts as better if it beats the best by more than rounding noise.
    let beats = |value: f64, best: &Option<(f64, Vec<f64>)>| {
        best.as_ref().is_none_or(|(b, _)| value > b + 1e-9 * b.abs().max(1.0))
    };

    // Rounds every whole-unit variable down (always still feasible: fewer units and less
    // coverage never break a limit) and re-solves the rates.
    let round_down = |values: &[f64], bounds: &[(f64, f64)]| -> Option<(f64, Vec<f64>)> {
        let fixed: Vec<(f64, f64)> = values
            .iter()
            .zip(bounds)
            .zip(&model.integer)
            .map(|((&v, &b), &int)| if int { let f = (v + INTEGRAL).floor().max(b.0).min(b.1); (f, f) } else { b })
            .collect();
        model.relax(&fixed)
    };

    // Dives from the root: repeatedly fixes the whole-unit variable closest to a whole number and
    // re-solves, which usually lands on a good plan quickly.
    let dive = |mut values: Vec<f64>, mut bounds: Vec<(f64, f64)>, nodes: &mut u32| -> Option<(f64, Vec<f64>)> {
        loop {
            let pick = (0..values.len())
                .filter(|&i| model.integer[i] && !is_integral(values[i]))
                .min_by(|&a, &b| {
                    let da = (values[a] - values[a].round()).abs();
                    let db = (values[b] - values[b].round()).abs();
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                });
            let Some(i) = pick else {
                let objective: f64 = values.iter().zip(&model.objective).map(|(v, c)| v * c).sum();
                return Some((objective, values));
            };
            let target = values[i].round().max(bounds[i].0).min(bounds[i].1);
            bounds[i] = (target, target);
            *nodes += 1;
            match model.relax(&bounds) {
                Some((_, v)) => values = v,
                None => return None,
            }
        }
    };

    let from_start = start.and_then(|plan| {
        nodes += 1;
        model.relax(&start_bounds(&model, plan)?)
    });
    for candidate in [from_start, round_down(&root_values, &model.bounds), dive(root_values.clone(), model.bounds.clone(), &mut nodes)]
        .into_iter()
        .flatten()
    {
        if beats(candidate.0, &best) {
            best = Some(candidate);
        }
    }

    let mut open: BinaryHeap<Node> = BinaryHeap::new();
    open.push(Node { bound: root_bound, depth: 0, bounds: model.bounds.clone(), values: root_values });
    let mut proven = true;
    while let Some(node) = open.pop() {
        if !beats(node.bound, &best) {
            // Best bound first: nothing left can beat the best plan.
            open.clear();
            break;
        }
        if out_of_time() {
            open.push(node);
            proven = false;
            break;
        }
        // Branch on the most fractional whole-unit variable of the most structural kind.
        let pick = (0..node.values.len()).filter(|&i| model.integer[i] && !is_integral(node.values[i])).min_by(|&a, &b| {
            let fa = (node.values[a] - node.values[a].floor() - 0.5).abs();
            let fb = (node.values[b] - node.values[b].floor() - 0.5).abs();
            model.priority[a].cmp(&model.priority[b]).then(fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal))
        });
        let Some(i) = pick else {
            // Whole units throughout: a plan.
            if beats(node.bound, &best) {
                best = Some((node.bound, node.values));
            }
            continue;
        };
        let value = node.values[i];
        for (lo, hi) in [(value.ceil(), node.bounds[i].1), (node.bounds[i].0, value.floor())] {
            if lo > hi {
                continue;
            }
            let mut bounds = node.bounds.clone();
            bounds[i] = (lo, hi);
            nodes += 1;
            let Some((bound, values)) = model.relax(&bounds) else { continue };
            if !beats(bound, &best) {
                continue;
            }
            // Cheap plan from every child: its rounded-down version.
            if let Some(candidate) = round_down(&values, &bounds) {
                if beats(candidate.0, &best) {
                    best = Some(candidate);
                }
            }
            open.push(Node { bound, depth: node.depth + 1, bounds, values });
        }
    }

    let (value, values) = best?;
    let upper_bound = if proven { value } else { open.iter().map(|n| n.bound).fold(value, f64::max) };
    Some(plan_from(&model, value, upper_bound.max(value), proven && open.is_empty(), nodes, &values, root_bound))
}

/// Bounds that fix every whole-unit variable to what `plan` (from the heuristic planner) uses, so
/// solving them gives that plan's units with the best rates for them: a strong first plan to beat.
/// `None` if the plan uses a recipe or coverage the model doesn't have.
fn start_bounds(model: &Model, plan: &crate::models::ProductionPlan) -> Option<Vec<(f64, f64)>> {
    let mut units: HashMap<&str, u32> = HashMap::new();
    for step in &plan.coin_items {
        if let (crate::models::PlanStepStatus::Producing, Some(item)) = (&step.status, &step.item_name) {
            *units.entry(item.as_str()).or_default() += step.facility_count;
        }
    }
    let mut bounds = model.bounds.clone();
    let mut used: HashMap<&str, u32> = HashMap::new();
    for (i, kind) in model.kinds.iter().enumerate() {
        if let VarKind::Units(recipe) = kind {
            let count = units.get(recipe.name.as_str()).copied().unwrap_or(0);
            used.insert(recipe.name.as_str(), count);
            bounds[i] = (count as f64, count as f64);
        } else if let VarKind::Environment { .. } | VarKind::EnvironmentPair { .. } = kind {
            bounds[i] = (0.0, 0.0);
        }
    }
    if units.keys().any(|name| !used.contains_key(name)) {
        return None;
    }
    // Each group of environment buildings gets the smallest coverage mix holding what it covers.
    for assignment in &plan.environment_assignments {
        if assignment.units == 0 {
            continue;
        }
        let mut choice: Option<(usize, u32)> = None;
        for (i, kind) in model.kinds.iter().enumerate() {
            let VarKind::Environment { building, mode, types, option } = kind else { continue };
            if *building != assignment.building || *mode != assignment.mode {
                continue;
            }
            let holds = assignment.covered.iter().all(|(facility, total)| {
                let per_building = total.div_ceil(assignment.units);
                types.iter().position(|t| t == facility).is_some_and(|t| option.counts[t] >= per_building)
            });
            let size: u32 = option.counts.iter().sum();
            if holds && choice.is_none_or(|(_, best)| size < best) {
                choice = Some((i, size));
            }
        }
        let (i, _) = choice?;
        let count = bounds[i].0 + assignment.units as f64;
        bounds[i] = (count, count);
    }
    Some(bounds)
}

/// Solves only the continuous relaxation: the most any plan could earn.
pub fn solve_relaxed(
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
) -> Option<f64> {
    let model = build_model(items, currency, facility_counts, module_levels, Goal::Earn { floors: &[] });
    model.relax(&model.bounds).map(|(value, _)| value)
}

fn plan_from(model: &Model, value: f64, upper_bound: f64, proven_optimal: bool, nodes: u32, values: &[f64], _root: f64) -> ExactPlan {
    let mut recipe_rates = BTreeMap::new();
    let mut units = BTreeMap::new();
    let mut sold = BTreeMap::new();
    let mut environment = Vec::new();
    let mut pairs: Vec<ExactPair> = Vec::new();
    let mut pace = None;
    let mut staffing = Vec::new();
    let mut crop_staffing = Vec::new();
    let mut hauling_staffing = BTreeMap::<usize, f64>::new();
    let mut hauling_routes = Vec::new();
    let mut work_routes = Vec::new();
    let mut work_posts = Vec::new();
    let mut local_used = BTreeMap::<(String, usize), f64>::new();
    let mut travel = BTreeMap::<usize, f64>::new();
    for (kind, &v) in model.kinds.iter().zip(values) {
        match kind {
            VarKind::Pace => pace = Some(v),
            VarKind::Staff { building, member } if v > 1e-9 => staffing.push((building.clone(), *member, v)),
            VarKind::CropStaff { ability, level, member } if v > 1e-9 => crop_staffing.push((ability.clone(), *level, *member, v)),
            VarKind::HaulingStaff { recipe, member, seconds } if v > 1e-9 => {
                *hauling_staffing.entry(*member).or_default() += v * seconds;
                hauling_routes.push((recipe.name.clone(), *member, v));
            }
            VarKind::WorkPost { station, member } if v > 1e-9 => work_posts.push((station.clone(), *member, v)),
            VarKind::WorkRoute { recipe, member, crop, mobile, seconds, travel: walking } if v > 1e-9 => {
                work_routes.push(WorkRoute { recipe: recipe.name.clone(), member: *member, crop: crop.clone(), mobile: *mobile, rate: v });
                if let Some((ability, level)) = crop { crop_staffing.push((ability.clone(), *level, *member, v * seconds)); }
                if *mobile { *travel.entry(*member).or_default() += v * walking; }
                else { *local_used.entry((work_station(recipe), *member)).or_default() += v * seconds; }
            }
            VarKind::Rate(recipe) if v > 1e-9 => {
                recipe_rates.insert(recipe.name.clone(), v);
            }
            VarKind::Units(recipe) if takes_turns(recipe) && v > 1e-9 => {
                // The units it runs on at least part of the time.
                units.insert(recipe.name.clone(), ((v - 1e-6).ceil().max(1.0)) as u32);
            }
            VarKind::Units(recipe) if v > 0.5 => {
                units.insert(recipe.name.clone(), v.round() as u32);
            }
            VarKind::Sold(name) if v > 1e-9 => {
                sold.insert(name.to_string(), v);
            }
            VarKind::EnvironmentPair { buildings, modes, types, option } if v > 0.5 => {
                let middle = crate::coverage::mode_temperature(modes.0)
                    .zip(crate::coverage::mode_temperature(modes.1))
                    .and_then(|(a, b)| temperature_mode(a + b));
                let covers = |zone: Zone| -> Vec<(String, u32)> {
                    types
                        .iter()
                        .enumerate()
                        .filter(|(t, _)| option.counts[zone as usize][*t] > 0)
                        .map(|(t, facility)| (facility.to_string(), option.counts[zone as usize][t]))
                        .collect()
                };
                pairs.push(ExactPair {
                    buildings: (buildings.0.to_string(), buildings.1.to_string()),
                    modes: (modes.0.to_string(), modes.1.to_string()),
                    offset: option.offset,
                    count: v.round() as u32,
                    zone_modes: [
                        Some(modes.0.to_string()),
                        middle.map(str::to_string),
                        Some(modes.1.to_string()),
                    ],
                    zone_covers: [covers(Zone::First), covers(Zone::Both), covers(Zone::Second)],
                });
            }
            VarKind::Environment { building, mode, types, option } if v > 0.5 => environment.push(ExactEnvironment {
                building: building.to_string(),
                mode: mode.to_string(),
                count: v.round() as u32,
                covers: types.iter().zip(&option.counts).filter(|(_, c)| **c > 0).map(|(t, c)| (t.to_string(), *c)).collect(),
                option: option.clone(),
            }),
            _ => {}
        }
    }
    // Units set to a recipe that doesn't run are just idle.
    units.retain(|name, _| recipe_rates.contains_key(name));
    // A feasible external solution may reserve an unused dedicated post, especially when
    // a later objective replaces its staffing tie-break. Idle machines are omitted above;
    // omit posts with no local work too, rather than inventing a worker at a missing machine.
    work_posts.retain(|(station, member, _)| local_used.get(&(station.clone(), *member)).copied().unwrap_or(0.0) > 0.0);
    let rate_per_second = model.earnings.iter().zip(values).map(|(c, v)| c * v).sum();
    let mut idle = BTreeMap::<usize, f64>::new();
    for (station, member, count) in &work_posts {
        *idle.entry(*member).or_default() += (count - local_used.get(&(station.clone(), *member)).copied().unwrap_or(0.0)).max(0.0);
    }
    let movement_staffing = travel.keys().chain(idle.keys()).copied().collect::<std::collections::BTreeSet<_>>()
        .into_iter().map(|member| (member, travel.get(&member).copied().unwrap_or(0.0), idle.get(&member).copied().unwrap_or(0.0))).collect();
    ExactPlan {
        rate_per_second,
        objective: model.untied(value, values),
        upper_bound,
        proven_optimal,
        nodes,
        recipe_rates,
        units,
        sold,
        environment,
        pairs,
        pace,
        staffing,
        crop_staffing,
        work_routes,
        work_posts,
        movement_staffing,
        hauling_staffing: hauling_staffing.into_iter().collect(),
        hauling_routes,
    }
}

/// Re-checks an [`ExactPlan`] from scratch, independently of the solver: whole units, owned units
/// per facility and level, item balances, environment coverage and, for a level-up, its pace,
/// then recomputes its earnings. Returns the recomputed coins/sec, or what's wrong.
pub fn check_plan(
    plan: &ExactPlan,
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
    level_up: Option<&LevelUp>,
) -> Result<f64, String> {
    const TOLERANCE: f64 = 1e-6;
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let mut earned = 0.0;
    let mut made: HashMap<&str, f64> = HashMap::new();
    let mut plots_needing: HashMap<(&str, &str), u32> = HashMap::new();
    // Units in use per facility and level; a recipe taking turns counts only its share of time.
    let mut units_at: HashMap<&str, Vec<(u32, f64)>> = HashMap::new();
    for (name, &rate) in &plan.recipe_rates {
        let recipe = all.get(name.as_str()).ok_or(format!("unknown recipe {name}"))?;
        if !facility_counts.can_produce(&recipe.facility, recipe.facility_level) {
            return Err(format!("{name} needs {} level {}", recipe.facility, recipe.facility_level));
        }
        if let Some((module, level)) = &recipe.module_requirement {
            if !module_levels.can_use(module, *level) {
                return Err(format!("{name} needs {module} {level}"));
            }
        }
        let units = plan.units.get(name).copied().unwrap_or(0);
        if rate * recipe.production_time > units as f64 + TOLERANCE {
            return Err(format!("{name} runs {rate}/s but has {units} units at {}s each", recipe.production_time));
        }
        let in_use = if takes_turns(recipe) { rate * recipe.production_time } else { units as f64 };
        if electric_level(name).is_none() {
            units_at.entry(recipe.facility.as_str()).or_default().push((recipe.facility_level, in_use));
        }
        if let Some(environment) = recipe.environment.as_deref() {
            *plots_needing.entry((recipe.facility.as_str(), environment)).or_default() += units;
        }
        *made.entry(made_item(&recipe.name, &all)).or_default() += rate * recipe.yield_amount as f64;
        if let Some(item) = recipe.byproduct.as_ref().and_then(|(resource, _)| byproduct_item(resource)) {
            *made.entry(item).or_default() += rate * recipe.byproduct.as_ref().map_or(0.0, |(_, a)| *a as f64);
        }
        if let (Some(inputs), Some(amounts)) = (&recipe.raw_materials, &recipe.required_amount) {
            for (input, &amount) in inputs.iter().zip(amounts) {
                *made.entry(input.as_str()).or_default() -= rate * amount as f64;
            }
        }
        if currency == "coins" {
            earned -= rate * recipe.cost.unwrap_or(0.0);
        }
    }
    let rates: Vec<(&ProductionItem, f64)> = plan.recipe_rates.iter().filter_map(|(n, &r)| Some((*all.get(n.as_str())?, r))).collect();
    let electric = electric_usage(plan, &all);
    let mut required_generators = 0;
    if !electric.is_empty() {
        let power = facility_counts.power().ok_or("E-mode requires a power grid")?;
        let mut rated = 0.0;
        for ((facility, level), units) in electric {
            let owned: u32 = facility_counts.tiers(facility).iter().filter(|(_, l)| *l == level).map(|(n, _)| n).sum();
            if units > owned {
                return Err(format!("{units} powered {facility} Lv.{level} but only {owned} owned"));
            }
            units_at.entry(facility).or_default().push((level, units as f64));
            rated += watts_per_level(facility) as f64 * level as f64 * units as f64;
        }
        let watts = rated * power.grid.percent as f64 / 100.0;
        if watts > power.grid.watts as f64 + TOLERANCE {
            return Err("E-mode demand exceeds available power".to_string());
        }
        required_generators = generator_workers(watts);
    }
    for (crop, &minimum) in facility_counts.season_crop_minimums() {
        let mut growing = 0;
        for &(recipe, rate) in rates.iter().filter(|(recipe, _)| is_season_crop(recipe, crop)) {
            let units = plan.units.get(&recipe.name).copied().unwrap_or(0);
            if rate * recipe.production_time.max(PACE_UNIT) + TOLERANCE < units as f64 {
                return Err(format!("{crop} grows too slowly for its {units} assigned plots"));
            }
            growing += units;
        }
        if growing < minimum {
            return Err(format!("{crop} requires at least {minimum} growing plots"));
        }
    }
    if let Some((budget, spent)) = season_budget(&rates) {
        let per_day: f64 = spent.iter().map(|(rate, cost)| rate * cost).sum::<f64>() * PACE_UNIT;
        if per_day > budget * (1.0 + TOLERANCE) + TOLERANCE {
            return Err(format!("seeds take {per_day} season currency a day but the budget is {budget}"));
        }
    }
    for (name, &sold) in &plan.sold {
        let item = all.get(name.as_str()).ok_or(format!("unknown item {name}"))?;
        *made.entry(item.name.as_str()).or_default() -= sold;
        // An item sold for another currency (Aniimo EXP, Aniipods) leaves the balance the same
        // way, but earns nothing towards `currency`.
        earned += sold * item.earns(currency);
    }
    if let Some(level_up) = level_up {
        let pace = plan.pace.ok_or("the plan has no level-up pace")?;
        let per_second = |name: &str| pace * (LevelUp::amount(&level_up.stock, name) - LevelUp::amount(&level_up.cost, name)) / PACE_UNIT;
        for (name, _) in level_up.cost.iter().chain(&level_up.stock) {
            if name != currency {
                made.entry(name.as_str()).or_default();
            }
        }
        for (name, left) in made.iter_mut() {
            *left += per_second(name);
        }
        if earned + per_second(currency) < -TOLERANCE * earned.abs().max(1.0) {
            return Err(format!("earns {earned}/s, too little for a level-up every {} s", PACE_UNIT / pace));
        }
    }
    for (item, left) in &made {
        if *left < -TOLERANCE {
            return Err(format!("{item} is used or sold faster than it's made (short {:.6}/s)", -left));
        }
    }
    for (facility, entries) in &units_at {
        for &(level, _) in entries {
            let needed: f64 = entries.iter().filter(|(l, _)| *l >= level).map(|(_, u)| u).sum();
            let owned = facility_counts.capacity_at_level(facility, level);
            if needed > owned as f64 + TOLERANCE {
                return Err(format!("{facility}: {needed} units at level {level}+ but {owned} owned"));
            }
        }
    }
    let mut buildings_used: HashMap<&str, u32> = HashMap::new();
    let mut covered: HashMap<(&str, &str), u32> = HashMap::new();
    for env in &plan.environment {
        *buildings_used.entry(env.building.as_str()).or_default() += env.count;
        for (facility, count) in &env.covers {
            *covered.entry((facility.as_str(), env.mode.as_str())).or_default() += count * env.count;
        }
    }
    // Overlapping pairs: each uses one of both buildings, and covers a zone per temperature.
    for pair in &plan.pairs {
        *buildings_used.entry(pair.buildings.0.as_str()).or_default() += pair.count;
        *buildings_used.entry(pair.buildings.1.as_str()).or_default() += pair.count;
        let middle = crate::coverage::mode_temperature(&pair.modes.0)
            .zip(crate::coverage::mode_temperature(&pair.modes.1))
            .and_then(|(a, b)| temperature_mode(a + b));
        let modes = [Some(pair.modes.0.as_str()), middle, Some(pair.modes.1.as_str())];
        for (zone, mode) in modes.iter().enumerate() {
            let Some(mode) = mode else { continue };
            if pair.zone_modes[zone].as_deref() != Some(mode) {
                return Err(format!("pair zone {zone} says {:?}, not {mode}", pair.zone_modes[zone]));
            }
            for (facility, count) in &pair.zone_covers[zone] {
                *covered.entry((facility.as_str(), mode)).or_default() += count * pair.count;
            }
        }
    }
    for (&building, &used) in &buildings_used {
        if used > facility_counts.get_count(building) {
            return Err(format!("{used} {building} set up but {} owned", facility_counts.get_count(building)));
        }
    }
    // With the player's own Aniimo: no member works more than its day, and every environment
    // building set up has a member with its ability on it all day.
    if let Some(crew) = facility_counts.crew() {
        let mut busy = vec![0.0; crew.members.len()];
        for (name, &rate) in &plan.recipe_rates {
            let recipe = all.get(name.as_str()).ok_or(format!("unknown recipe {name}"))?;
            let Some(member) = recipe.crew else { continue };
            let slot = busy.get_mut(member).ok_or(format!("{name} is worked by roster member {member}, who isn't there"))?;
            *slot += if crew.residents.contains(&recipe.facility) {
                plan.units.get(name).copied().unwrap_or(0) as f64
            } else if facility_counts.movement_seconds() <= 0.0 {
                rate * recipe.production_time
            } else {
                0.0
            };
        }
        let mut staffed: HashMap<&str, f64> = HashMap::new();
        for (building, member, share) in &plan.staffing {
            let ability = if building == GENERATOR { Some("Lightning") } else { crew.environment.get(building).map(String::as_str) };
            let ability = ability.ok_or(format!("{building} needs no Aniimo"))?;
            if !crew.can_work(*member, ability, 1) {
                return Err(format!("{building} staffed by roster member {member}, who can't do the {ability} job"));
            }
            busy[*member] += share;
            *staffed.entry(building.as_str()).or_default() += share;
        }
        for (&building, &used) in &buildings_used {
            let have = staffed.get(building).copied().unwrap_or(0.0);
            if used as f64 > have + TOLERANCE {
                return Err(format!("{used} {building} set up but only {have} staffed"));
            }
        }
        if staffed.get(GENERATOR).copied().unwrap_or(0.0) + TOLERANCE < required_generators as f64 {
            return Err(format!("{required_generators} Lightning Aniimo required for power"));
        }
        if let Some(steps) = facility_counts.grower_steps() {
            let mut assigned: BTreeMap<(&str, u32), f64> = BTreeMap::new();
            for (ability, level, member, share) in &plan.crop_staffing {
                if !crew.can_work(*member, ability, *level) {
                    return Err(format!("crop work assigned to Aniimo without {ability} Lv.{level}"));
                }
                if facility_counts.movement_seconds() <= 0.0 { busy[*member] += share; }
                let speed = crate::models::Worker::new(crew.members[*member].level(ability), false).speed(*level, true);
                *assigned.entry((ability, *level)).or_default() += share * speed;
            }
            for (job, needs) in crop_work(&rates, steps, crew) {
                let required: f64 = needs.iter().map(|(rate, time)| rate * time).sum();
                if assigned.get(&job).copied().unwrap_or(0.0) + TOLERANCE < required {
                    return Err(format!("unassigned crop work for {}", job.0));
                }
            }
        }
        if facility_counts.movement_seconds() > 0.0 { check_movement(plan, &all, facility_counts, &mut busy)?; }
        let mut delivered = BTreeMap::<&str, f64>::new();
        let mut haul_busy = BTreeMap::<usize, f64>::new();
        for (name, member, rate) in &plan.hauling_routes {
            let recipe = all.get(name.as_str()).ok_or("unknown hauled recipe")?;
            if !rate.is_finite() || *rate < 0.0 || !crew.can_work(*member, "Hauling", 1) {
                return Err(format!("invalid hauling route for roster member {member}"));
            }
            *delivered.entry(name).or_default() += rate;
            *haul_busy.entry(*member).or_default() += rate * facility_counts.hauling_seconds_for(recipe, crew.members[*member].level("Hauling"));
        }
        for (name, rate) in &plan.recipe_rates {
            if facility_counts.hauling_seconds(all[name.as_str()]) > 0.0
                && delivered.get(name.as_str()).copied().unwrap_or(0.0) + TOLERANCE < *rate {
                return Err(format!("unassigned hauling work for {name}"));
            }
        }
        let mut assigned_hauling = BTreeMap::<usize, f64>::new();
        for &(member, share) in &plan.hauling_staffing {
            if !share.is_finite() || share < 0.0 || !crew.can_work(member, "Hauling", 1) {
                return Err(format!("invalid hauling assignment for roster member {member}"));
            }
            busy[member] += share;
            *assigned_hauling.entry(member).or_default() += share;
        }
        for (member, time) in haul_busy {
            if assigned_hauling.get(&member).copied().unwrap_or(0.0) + TOLERANCE < time {
                return Err("unassigned hauling work".into());
            }
        }
        if let Some(limit) = facility_counts.power().and_then(|power| power.grid.max_aniimo) {
            let active: f64 = busy.iter().map(|n| (n - TOLERANCE).ceil().max(0.0)).sum();
            if active > limit as f64 {
                return Err(format!("{active} Aniimo working but limit is {limit}"));
            }
        }
        for (member, (&used, aniimo)) in busy.iter().zip(&crew.members).enumerate() {
            if used > aniimo.count as f64 + TOLERANCE {
                return Err(format!("roster member {member} works {used} days a day but there are {} of it", aniimo.count));
            }
        }
    }
    // The measurement build lets a building mix arrangements, which no whole layout can hold, so
    // its plans are deliberately unbuildable and only their rate is of interest.
    for ((facility, environment), plots) in plots_needing {
        let have = covered.get(&(facility, environment)).copied().unwrap_or(0);
        if plots > have && !coverage_relaxed() {
            return Err(format!("{plots} {facility} plots need {environment} but {have} are covered"));
        }
    }
    if (earned - plan.rate_per_second).abs() > 1e-6 * earned.abs().max(1.0) {
        return Err(format!("plan says {} but its sales and costs add up to {earned}", plan.rate_per_second));
    }
    Ok(earned)
}

/// A model written out for an external solver.
#[derive(Debug, Clone, Default)]
pub struct LpProblem {
    /// CPLEX LP text.
    pub lp: String,
    /// How many variables, `x0` up to `x<variables - 1>`.
    pub variables: usize,
    /// `(variable, weight)` to add back to the solver's objective to take the tie-break out of it
    /// (see [`BUILDING_TIE_BREAK`]), before using it as a floor for a later solve.
    pub tiebreak: Vec<(usize, f64)>,
    /// Primary objective without tie-breaks, for a continuous upper bound.
    pub primary_objective: Vec<(usize, f64)>,
    /// Integers that can be fixed to the income plan while filling material processors.
    pub material_fixed: Vec<usize>,
}

/// The model in CPLEX LP format, for solving with an external solver (a solver may leave out any
/// variable that no constraint mentions).
pub fn write_lp(
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
    goal: Goal,
) -> LpProblem {
    let model = build_model(items, currency, facility_counts, module_levels, goal);
    if matches!(goal, Goal::CropVariety { .. }) && !model.kinds.iter().any(|kind| matches!(kind, VarKind::CropVariety)) {
        return LpProblem::default();
    }
    if matches!(goal, Goal::MaterialWork { minimum: None, .. })
        && !model.kinds.iter().any(|kind| matches!(kind, VarKind::Rate(recipe) if processes_upgrade_materials(recipe)))
    {
        return LpProblem::default();
    }
    let term = |c: f64, v: usize| format!("{} {} x{v}", if c < 0.0 { "-" } else { "+" }, c.abs());
    let mut out = String::from("Maximize\n obj:");
    for (v, &c) in model.objective.iter().enumerate() {
        if c != 0.0 {
            out.push(' ');
            out.push_str(&term(c, v));
        }
    }
    if !model.objective.is_empty() && model.objective.iter().all(|&c| c == 0.0) {
        out.push_str(" + 0 x0");
    }
    out.push_str("\nSubject To\n");
    for (k, (terms, op, rhs)) in model.constraints.iter().enumerate() {
        let op = match op {
            ComparisonOp::Le => "<=",
            ComparisonOp::Ge => ">=",
            ComparisonOp::Eq => "=",
        };
        let lhs: Vec<String> = terms.iter().map(|&(v, c)| term(c, v)).collect();
        out.push_str(&format!(" c{k}: {} {op} {rhs}\n", lhs.join(" ")));
    }
    out.push_str("Bounds\n");
    for (v, &(lo, hi)) in model.bounds.iter().enumerate() {
        if hi.is_finite() {
            out.push_str(&format!(" {lo} <= x{v} <= {hi}\n"));
        } else {
            out.push_str(&format!(" x{v} >= {lo}\n"));
        }
    }
    out.push_str("General\n");
    for (v, &int) in model.integer.iter().enumerate() {
        if int {
            out.push_str(&format!(" x{v}\n"));
        }
    }
    out.push_str("End\n");
    let mut primary = model.objective.clone();
    for &(v, weight) in &model.tiebreak { primary[v] += weight; }
    let primary_objective = primary.into_iter().enumerate().filter(|(_, c)| *c != 0.0).collect();
    let material_fixed = model.kinds.iter().enumerate().filter_map(|(v, kind)| {
        if !model.integer[v] { return None; }
        let flexible = match kind {
            VarKind::Units(recipe) => processes_upgrade_materials(recipe),
            VarKind::WorkPost { station, .. } => station.strip_prefix("recipe:")
                .and_then(|name| items.iter().find(|r| r.name == name)).is_some_and(processes_upgrade_materials),
            VarKind::ActiveAniimo | VarKind::PowerGenerators | VarKind::PoweredUnits => true,
            _ => false,
        };
        (!flexible).then_some(v)
    }).collect();
    LpProblem { lp: out, variables: model.objective.len(), tiebreak: model.tiebreak.clone(), primary_objective, material_fixed }
}

/// Builds an [`ExactPlan`] from an external solver's variable values. Accepts the complete
/// solution after checking every bound, integrality and model constraint. Rounding noise
/// that violates a constraint falls back to fixing whole units and re-solving the rates.
/// `proven_optimal` and `upper_bound` are what the solver reported.
#[allow(clippy::too_many_arguments)]
pub fn plan_from_values(
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
    module_levels: &ModuleLevels,
    goal: Goal,
    values: &[f64],
    proven_optimal: bool,
    upper_bound: f64,
) -> Option<ExactPlan> {
    let model = build_model(items, currency, facility_counts, module_levels, goal);
    if values.len() != model.objective.len() {
        return None;
    }
    let rounded: Vec<f64> = values.iter().zip(&model.integer).zip(&model.bounds).map(|((&v, &int), &(lo, hi))| {
        if int { v.round() }
        else if v < lo && lo - v <= 1e-9 { lo }
        else if v > hi && v - hi <= 1e-9 { hi }
        else { v }
    }).collect();
    let within_bounds = values.iter().zip(&rounded).zip(&model.bounds).zip(&model.integer)
        .all(|(((&original, &value), &(lo, hi)), &int)| value.is_finite()
            && (!int || (original - value).abs() <= 1e-7) && value >= lo && value <= hi);
    let feasible = within_bounds && model.constraints.iter().all(|(terms, op, rhs)| {
        let lhs: f64 = terms.iter().map(|&(v, coefficient)| coefficient * rounded[v]).sum();
        let magnitude: f64 = terms.iter().map(|&(v, coefficient)| (coefficient * rounded[v]).abs()).sum();
        // Tight absolute tolerance for item flow; only cancellation in large sums gets a
        // small relative allowance. The public WASM entry point also runs check_plan.
        let tolerance = 1e-9 + magnitude * 1e-12;
        lhs.is_finite() && match op {
            ComparisonOp::Le => lhs <= rhs + tolerance,
            ComparisonOp::Ge => lhs >= rhs - tolerance,
            ComparisonOp::Eq => (lhs - rhs).abs() <= tolerance,
        }
    });
    if feasible {
        let value: f64 = model.objective.iter().zip(&rounded).map(|(c, v)| c * v).sum();
        let earnings: f64 = model.earnings.iter().zip(&rounded).map(|(c, v)| c * v).sum();
        return Some(plan_from(&model, value, upper_bound.max(earnings), proven_optimal, 0, &rounded, value));
    }
    let fixed: Vec<(f64, f64)> = model
        .bounds
        .iter()
        .zip(&model.integer)
        .zip(values)
        .map(|((&b, &int), &v)| {
            if int {
                let r = v.round().max(b.0).min(b.1);
                (r, r)
            } else {
                b
            }
        })
        .collect();
    let (value, solved) = model.relax(&fixed)?;
    let earnings: f64 = model.earnings.iter().zip(&solved).map(|(c, v)| c * v).sum();
    Some(plan_from(&model, value, upper_bound.max(earnings), proven_optimal, 0, &solved, value))
}

/// What `exact` makes per second of `currency`, at its items' sell values: the Aniimo EXP or
/// Aniipods a coin plan keeps up alongside its coins.
pub fn currency_rate(exact: &ExactPlan, items: &[ProductionItem], currency: &str) -> f64 {
    items
        .iter()
        .map(|item| exact.sold.get(&item.name).copied().unwrap_or(0.0) * item.earns(currency))
        .sum()
}

/// The items `exact` makes for a priority `target` that's a currency, with how many per second:
/// the Growth items behind Aniimo EXP, or the Aniipods. Empty for coins and byproducts.
pub fn target_items(exact: &ExactPlan, items: &[ProductionItem], target: &str) -> Vec<(String, f64)> {
    if target == "coins" {
        return Vec::new();
    }
    items
        .iter()
        .filter(|item| item.earns(target) > 0.0)
        .filter_map(|item| exact.sold.get(&item.name).filter(|&&n| n > 1e-9).map(|&n| (item.name.clone(), n)))
        .collect()
}

/// Where a priority `target` other than coins comes from, as `(per second, seconds until the
/// first batch)` for each item sold for it or each recipe making it as a byproduct, so a goal can
/// count the wait before each one starts. The rates add up to [`target_rate`]. Empty for coins,
/// whose goals go by the plan's income streams instead.
pub fn target_streams(exact: &ExactPlan, items: &[ProductionItem], target: &str) -> Vec<(f64, f64)> {
    if target == "coins" {
        return Vec::new();
    }
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let times = with_active_electric_times(exact, &all);
    let lead = |name: &str| crate::optimizer::item_lead_time(name, &times, 0);
    let byproduct: Vec<(f64, f64)> = exact
        .recipe_rates
        .iter()
        .filter_map(|(name, rate)| match &all.get(name.as_str())?.byproduct {
            Some((resource, amount)) if resource == target => Some((rate * *amount as f64, lead(name))),
            _ => None,
        })
        .collect();
    if !byproduct.is_empty() {
        return byproduct;
    }
    exact
        .sold
        .iter()
        .filter_map(|(name, &sold)| {
            let earns = all.get(name.as_str())?.earns(target);
            (earns > 0.0 && sold > 0.0).then(|| (sold * earns, lead(name)))
        })
        .collect()
}

/// What `exact` makes per second of a priority `target`: coins (net of seed costs), another
/// currency ("aniimo_exp", "aniipods"), or a byproduct ("Wood Blocks", "Mineral Sand").
pub fn target_rate(exact: &ExactPlan, items: &[ProductionItem], target: &str) -> f64 {
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let byproduct: f64 = exact
        .recipe_rates
        .iter()
        .filter_map(|(name, rate)| match &all.get(name.as_str())?.byproduct {
            Some((resource, amount)) if resource == target => Some(rate * *amount as f64),
            _ => None,
        })
        .sum();
    if byproduct > 0.0 {
        return byproduct;
    }
    let seeds: f64 = if target == "coins" {
        exact.recipe_rates.iter().filter_map(|(name, rate)| Some(rate * all.get(name.as_str())?.cost.unwrap_or(0.0))).sum()
    } else {
        0.0
    };
    currency_rate(exact, items, target) - seeds
}

/// Each item's rate per second made, less what the plan's recipes use and sell, including Wood
/// Blocks and Mineral Sand (as `wood_block` and `mineral_sand`). Negative for an item drawn from
/// stock.
pub fn net_rates(exact: &ExactPlan, items: &[ProductionItem]) -> BTreeMap<String, f64> {
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let mut net: BTreeMap<String, f64> = BTreeMap::new();
    for (name, &rate) in &exact.recipe_rates {
        let Some(recipe) = all.get(name.as_str()) else { continue };
        *net.entry(made_item(name, &all).to_string()).or_default() += rate * recipe.yield_amount as f64;
        if let Some((resource, amount)) = &recipe.byproduct {
            if let Some(item) = byproduct_item(resource) {
                *net.entry(item.to_string()).or_default() += rate * *amount as f64;
            }
        }
        if let (Some(inputs), Some(amounts)) = (&recipe.raw_materials, &recipe.required_amount) {
            for (input, &amount) in inputs.iter().zip(amounts) {
                *net.entry(input.clone()).or_default() -= rate * amount as f64;
            }
        }
    }
    for (name, &sold) in &exact.sold {
        *net.entry(name.clone()).or_default() -= sold;
    }
    net
}

/// The seed cost in each unit of every item a plan uses, and the plan's total seed cost, both in
/// coins per second. A crop's seeds are shared by every unit of it that's sold or used, and what's
/// made from it carries its share on, so Rose Concentrate pays for the roses that go into it
/// rather than the few roses sold raw.
fn seed_costs_by_item<'a>(exact: &'a ExactPlan, all: &HashMap<&str, &'a ProductionItem>) -> (HashMap<&'a str, f64>, f64) {
    // Units/sec of each item sold or used as an ingredient.
    let mut used: HashMap<&str, f64> = HashMap::new();
    for (name, &sold) in &exact.sold {
        *used.entry(name.as_str()).or_default() += sold;
    }
    let recipes: Vec<(&ProductionItem, f64)> =
        exact.recipe_rates.iter().filter_map(|(name, &rate)| Some((*all.get(name.as_str())?, rate))).collect();
    for (recipe, rate) in &recipes {
        if let (Some(inputs), Some(amounts)) = (&recipe.raw_materials, &recipe.required_amount) {
            for (input, &amount) in inputs.iter().zip(amounts) {
                *used.entry(input.as_str()).or_default() += rate * amount as f64;
            }
        }
    }
    let total = recipes.iter().map(|(recipe, rate)| recipe.cost.unwrap_or(0.0) * rate).sum();
    // Recipes chain only a few deep, so passing costs along until nothing changes settles fast.
    let mut per_unit: HashMap<&str, f64> = HashMap::new();
    for _ in 0..32 {
        let mut into: HashMap<&str, f64> = HashMap::new();
        for (recipe, rate) in &recipes {
            let mut cost = recipe.cost.unwrap_or(0.0) * rate;
            if let (Some(inputs), Some(amounts)) = (&recipe.raw_materials, &recipe.required_amount) {
                for (input, &amount) in inputs.iter().zip(amounts) {
                    cost += rate * amount as f64 * per_unit.get(input.as_str()).copied().unwrap_or(0.0);
                }
            }
            *into.entry(made_item(&recipe.name, all)).or_default() += cost;
        }
        let next: HashMap<&str, f64> = into
            .into_iter()
            .filter_map(|(item, cost)| {
                let used = used.get(item).copied().unwrap_or(0.0);
                (used > 1e-12 && cost > 0.0).then(|| (item, cost / used))
            })
            .collect();
        let settled = next.len() == per_unit.len()
            && next.iter().all(|(item, cost)| per_unit.get(item).is_some_and(|c| (c - cost).abs() <= 1e-12 * cost.max(1.0)));
        per_unit = next;
        if settled {
            break;
        }
    }
    (per_unit, total)
}

fn electric_usage<'a>(plan: &ExactPlan, all: &HashMap<&str, &'a ProductionItem>) -> BTreeMap<(&'a str, u32), u32> {
    let mut units = BTreeMap::new();
    let mut shared = BTreeMap::<_, f64>::new();
    for (name, &rate) in &plan.recipe_rates {
        let Some(level) = electric_level(name) else { continue };
        let Some(recipe) = all.get(name.as_str()) else { continue };
        let key = (recipe.facility.as_str(), level);
        if takes_turns(recipe) {
            *shared.entry(key).or_default() += rate * recipe.production_time;
        } else {
            *units.entry(key).or_default() += plan.units.get(name).copied().unwrap_or(0);
        }
    }
    for (key, time) in shared {
        *units.entry(key).or_default() += (time - 1e-6).ceil().max(0.0) as u32;
    }
    units
}

fn with_active_electric_times<'a>(plan: &ExactPlan, all: &HashMap<&'a str, &'a ProductionItem>) -> HashMap<&'a str, &'a ProductionItem> {
    let mut times = all.clone();
    let active: Vec<_> = plan.recipe_rates.keys().filter_map(|name| all.get(name.as_str()).copied()).collect();
    let mut earliest = BTreeMap::<&str, &ProductionItem>::new();
    for recipe in active.iter().filter(|item| electric_level(&item.name).is_some()) {
        earliest.insert(made_item(&recipe.name, all), recipe);
    }
    for recipe in active {
        if let Some(current) = earliest.get_mut(made_item(&recipe.name, all)) {
            if recipe.production_time < current.production_time {
                *current = recipe;
            }
        }
    }
    times.extend(earliest);
    times
}

/// Rated watts drawn by the selected E-mode buildings at 100% supply.
pub fn rated_power_draw(plan: &ExactPlan, items: &[ProductionItem]) -> f64 {
    let all = items.iter().map(|i| (i.name.as_str(), i)).collect();
    electric_usage(plan, &all).into_iter()
        .map(|((facility, level), units)| watts_per_level(facility) as f64 * level as f64 * units as f64)
        .sum()
}

/// Turn the solution into facility rows, income streams, byproducts and building layouts.
pub fn to_production_plan(
    exact: &ExactPlan,
    items: &[ProductionItem],
    currency: &str,
    facility_counts: &FacilityCounts,
) -> crate::models::ProductionPlan {
    use crate::models::{EnvironmentAssignment, FacilityPlacement, PlanProduct, PlanStep, PlanStepStatus};
    let all: HashMap<&str, &ProductionItem> = items.iter().map(|i| (i.name.as_str(), i)).collect();
    let is_grower = |facility: &str| !items.iter().any(|i| i.facility == facility && i.raw_materials.is_some());

    // What each made item goes to: the recipes using it, and whether the rest sells.
    let net = net_rates(exact, items);
    let electric = electric_usage(exact, &all);
    let uses_of = |recipe: &ProductionItem| -> String {
        let made = made_item(&recipe.name, &all);
        let mut uses: Vec<&str> = exact
            .recipe_rates
            .keys()
            .filter_map(|name| all.get(name.as_str()))
            .filter(|r| r.raw_materials.as_ref().is_some_and(|inputs| inputs.iter().any(|i| i == made)))
            .map(|r| crate::models::base_item_name(&r.name))
            .collect();
        uses.sort_unstable();
        uses.dedup();
        let sells = exact.sold.get(made).is_some_and(|&s| s > 1e-9);
        // Made, not sold, not all used up and not sellable: kept for the level-up.
        let sellable = all.get(made).is_some_and(|item| item.sell_currency != "none" && item.sell_value > 0.0);
        let kept = !sells && !sellable && net.get(made).is_some_and(|&n| n > 1e-9);
        match (uses.is_empty(), sells || kept) {
            (true, _) if kept && exact.pace.is_some() => "For the level-up".to_string(),
            (true, _) if kept => "Stored for later".to_string(),
            (true, _) => "Sells directly".to_string(),
            (false, false) => format!("Used for {}", uses.join(", ")),
            (false, true) if kept && exact.pace.is_some() => format!("Used for {}; the rest goes to the level-up", uses.join(", ")),
            (false, true) if kept => format!("Used for {}; the rest is stored", uses.join(", ")),
            (false, true) => format!("Used for {}; the rest sells directly", uses.join(", ")),
        }
    };

    let mut facility_names: Vec<&str> = items.iter().map(|i| i.facility.as_str()).collect();
    facility_names.sort_unstable();
    facility_names.dedup();
    let mut coin_items: Vec<PlanStep> = Vec::new();
    for facility in facility_names {
        let owned = facility_counts.get_count(facility);
        if owned == 0 {
            continue;
        }
        let grower = is_grower(facility);
        let mut rows: Vec<(&ProductionItem, u32, f64)> = exact
            .units
            .iter()
            .filter_map(|(name, &units)| all.get(name.as_str()).map(|r| (*r, units)))
            .filter(|(r, _)| r.facility == facility)
            .map(|(r, units)| (r, units, exact.recipe_rates.get(&r.name).copied().unwrap_or(0.0)))
            .collect();
        rows.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.name.cmp(&b.0.name)));
        if rows.is_empty() {
            coin_items.push(PlanStep {
                item_name: None,
                facility: facility.to_string(),
                facility_count: owned,
                status: PlanStepStatus::NothingAvailable,
                reason: "Nothing it can make helps this plan".to_string(),
                is_grower: grower,
                cycle_time: None,
                environment: None,
                busy_units: None,
                crew: None,
                electric_level: None,
            });
            continue;
        }
        // Recipes taking turns share units, so what's in use is their combined time.
        let shared: Vec<&str> = rows.iter().filter(|(r, _, _)| takes_turns(r)).map(|(r, _, _)| r.name.as_str()).collect();
        let shared_time: f64 = rows.iter().filter(|(r, _, _)| takes_turns(r) && electric_level(&r.name).is_none())
            .map(|(r, _, rate)| rate * r.production_time).sum();
        let powered: u32 = electric.iter().filter(|((name, _), _)| *name == facility).map(|(_, n)| n).sum();
        let used: u32 = rows.iter().filter(|(r, _, _)| !takes_turns(r) && electric_level(&r.name).is_none()).map(|(_, u, _)| u).sum::<u32>()
            + ((shared_time - 1e-6).ceil().max(0.0) as u32) + powered;
        let used = used.min(owned);
        for (recipe, units, rate) in rows {
            let mut reason = uses_of(recipe);
            if takes_turns(recipe) {
                let others: Vec<&str> = shared.iter().copied()
                    .filter(|n| *n != recipe.name && electric_level(n) == electric_level(&recipe.name))
                    .map(crate::models::base_item_name).collect();
                if !others.is_empty() {
                    reason = format!("{reason}; takes turns with {}", others.join(", "));
                }
            }
            if recipe.name.ends_with(crate::models::UNCOVERED_SUFFIX) {
                let base = all.get(crate::models::base_item_name(&recipe.name)).and_then(|i| i.environment.as_deref());
                let speed = base.and_then(crate::models::uncovered_efficiency).unwrap_or(1.0) * 100.0;
                let wants = base.unwrap_or("its environment");
                reason = format!("{reason}; grown without {wants} at {speed:.0}% speed");
            }
            coin_items.push(PlanStep {
                item_name: Some(crate::models::base_item_name(&recipe.name).to_string()),
                facility: facility.to_string(),
                facility_count: units,
                status: PlanStepStatus::Producing,
                reason,
                is_grower: grower,
                cycle_time: Some(recipe.production_time),
                environment: if grower { recipe.environment.clone() } else { None },
                // A roster member's row says how much of its time it really takes, gathering too.
                busy_units: (!grower || recipe.crew.is_some() || recipe.season.is_some_and(|s| s.currency_per_day.is_some()))
                    .then(|| (rate * recipe.production_time).min(units as f64)),
                crew: recipe.crew,
                electric_level: electric_level(&recipe.name),
            });
        }
        if owned > used {
            coin_items.push(PlanStep {
                item_name: None,
                facility: facility.to_string(),
                facility_count: owned - used,
                status: PlanStepStatus::Idle,
                reason: "No further profitable use found".to_string(),
                is_grower: grower,
                cycle_time: None,
                environment: None,
                busy_units: None,
                crew: None,
                electric_level: None,
            });
        }
    }

    // One income stream per item sold, less the seed costs that went into it (see
    // `seed_costs_by_item`).
    let times = with_active_electric_times(exact, &all);
    let mut income_streams: Vec<PlanProduct> = exact
        .sold
        .iter()
        .filter_map(|(name, &units)| {
            let item = all.get(name.as_str())?;
            // Only what sells for the plan's currency is income; Growth items or Aniipods a plan
            // also makes (for a priority) are counted separately, not as coins.
            if item.sell_currency != currency {
                return None;
            }
            Some(PlanProduct {
                item_name: name.clone(),
                facility: item.facility.clone(),
                sell_value: item.sell_value,
                rate_per_second: units * item.sell_value,
                units_per_second: units,
                lead_time: crate::optimizer::item_lead_time(name, &times, 0),
                total_units: 0.0,
                total_value: 0.0,
            })
        })
        .collect();
    if currency == "coins" {
        let (per_unit, total) = seed_costs_by_item(exact, &all);
        let mut assigned = 0.0;
        for stream in &mut income_streams {
            let cost = stream.units_per_second * per_unit.get(stream.item_name.as_str()).copied().unwrap_or(0.0);
            stream.rate_per_second -= cost;
            assigned += cost;
        }
        // Seeds for anything not sold for coins (a crop only kept for a level-up, say) still come
        // out of the coins; the biggest stream takes them, so the streams add up to the rate.
        let rest = total - assigned;
        if rest > 1e-9 {
            if let Some(biggest) = income_streams.iter_mut().max_by(|a, b| {
                a.rate_per_second.partial_cmp(&b.rate_per_second).unwrap_or(std::cmp::Ordering::Equal)
            }) {
                biggest.rate_per_second -= rest;
            }
        }
    }

    let mut byproduct_rates: Vec<(String, f64, f64)> = Vec::new();
    for (name, &batches) in &exact.recipe_rates {
        let Some(recipe) = all.get(name.as_str()) else { continue };
        if let Some((resource, amount)) = &recipe.byproduct {
            let rate = batches * *amount as f64;
            byproduct_rates.push((resource.clone(), rate, crate::optimizer::item_lead_time(name, &times, 0)));
        }
    }

    // Environment layouts, trimmed to the plots the plan actually uses.
    let mut still_needed: HashMap<(String, String), u32> = HashMap::new();
    for (name, &units) in &exact.units {
        if let Some(recipe) = all.get(name.as_str()) {
            if let Some(environment) = &recipe.environment {
                *still_needed.entry((recipe.facility.clone(), environment.clone())).or_default() += units;
            }
        }
    }
    // Overlapping pairs show as one assignment per zone, all in the same frame so the diagram can
    // draw both buildings. Worked out before the buildings standing on their own, so the plots
    // they cover are taken off what those still have to cover.
    let mut pair_assignments: Vec<EnvironmentAssignment> = Vec::new();
    for pair in &exact.pairs {
        // Only what the plan actually grows: a zone whose plots went unused isn't worth drawing,
        // and a pair with nothing in the zone they share is really two separate buildings.
        let used: [Vec<(String, u32)>; 3] = std::array::from_fn(|zone| {
            let Some(mode) = pair.zone_modes[zone].clone() else { return Vec::new() };
            pair.zone_covers[zone]
                .iter()
                .filter_map(|(facility, covered)| {
                    let left = still_needed.entry((facility.clone(), mode.clone())).or_default();
                    let take = (*covered * pair.count).min(*left);
                    *left -= take;
                    (take > 0).then(|| (facility.clone(), take))
                })
                .collect()
        });
        let holds = |zone: usize| used[zone].iter().map(|(_, n)| n).sum::<u32>() > 0;
        let types: Vec<&str> = {
            let mut names: Vec<&str> = used.iter().flatten().map(|(f, _)| f.as_str()).collect();
            names.sort_unstable();
            names.dedup();
            names
        };
        let counts: [Vec<u32>; 3] = std::array::from_fn(|zone| {
            types
                .iter()
                .map(|facility| used[zone].iter().find(|(f, _)| f == facility).map_or(0, |(_, n)| *n))
                .collect()
        });
        let sizes = PairSizes::of(&pair.buildings.0, &pair.buildings.1);
        // A plain arrangement of the same plots, for when the tidy one can't be worked out.
        let plain = || {
            crate::coverage::pair_layout_for(sizes, &types, pair.offset, &counts).unwrap_or_default()
        };
        // Standing two buildings a measured distance apart is fiddly, and it only buys anything
        // while all three zones are growing something: with one of them empty the plan wants two
        // temperatures, which two buildings give wherever they stand. So the pair is shown as
        // separate buildings, each set to a zone that is in use, as long as each can be set to
        // the mode it is being given (the shared zone's mode is one of theirs for every pair the
        // plan can build; if some later building breaks that, the pair stands as it is).
        let zones_used: Vec<usize> = (0..3).filter(|&zone| holds(zone)).collect();
        let supports = |building: &String, mode: &String| {
            ENVIRONMENT_BUILDINGS
                .iter()
                .find(|(name, _)| name == building)
                .is_some_and(|(_, modes)| modes.contains(&mode.as_str()))
        };
        let apart: Option<Vec<(usize, &String, String)>> = (zones_used.len() < 3)
            .then(|| {
                let wanted: Vec<(usize, String)> = zones_used
                    .iter()
                    .filter_map(|&zone| pair.zone_modes[zone].clone().map(|mode| (zone, mode)))
                    .collect();
                let buildings = [&pair.buildings.0, &pair.buildings.1];
                // At most two zones are in use, so either order of the two buildings will do.
                [[0, 1], [1, 0]].into_iter().find_map(|order| {
                    wanted
                        .iter()
                        .enumerate()
                        .map(|(i, (zone, mode))| {
                            let building = buildings[order[i]];
                            supports(building, mode).then(|| (*zone, building, mode.clone()))
                        })
                        .collect::<Option<Vec<_>>>()
                })
            })
            .flatten();
        if let Some(apart) = apart {
            for (zone, building, mode) in apart {
                let layout = crate::coverage::tidy_layout(building_size(building), &used[zone])
                    .unwrap_or_else(|| plain()[zone].clone())
                    .into_iter()
                    .map(|p| FacilityPlacement { facility: p.facility, x: p.x, y: p.y, size: p.size })
                    .collect::<Vec<_>>();
                pair_assignments.push(EnvironmentAssignment {
                    building: building.clone(),
                    mode,
                    units: pair.count,
                    covered: used[zone].clone(),
                    layouts: vec![layout; pair.count as usize],
                    partner: None,
                    zone: None,
                    pair_modes: None,
                });
            }
            continue;
        }
        let layouts: [Vec<crate::coverage::Placement>; 3] =
            crate::coverage::tidy_pair_layout(sizes, &types, pair.offset, &counts).unwrap_or_else(plain);
        for zone in 0..3 {
            let (Some(mode), true) = (pair.zone_modes[zone].clone(), holds(zone)) else { continue };
            let layout: Vec<FacilityPlacement> = layouts[zone]
                .iter()
                .map(|p| FacilityPlacement { facility: p.facility.clone(), x: p.x, y: p.y, size: p.size })
                .collect();
            pair_assignments.push(EnvironmentAssignment {
                building: pair.buildings.0.clone(),
                mode,
                units: pair.count,
                covered: used[zone].clone(),
                layouts: vec![layout; pair.count as usize],
                partner: Some((pair.buildings.1.clone(), pair.offset.dx, pair.offset.dy)),
                zone: Some(zone as u8),
                pair_modes: Some((pair.modes.0.clone(), pair.modes.1.clone())),
            });
        }
    }

    let environment_assignments: Vec<EnvironmentAssignment> = exact
        .environment
        .iter()
        .map(|env| {
            let mut layouts: Vec<Vec<FacilityPlacement>> = Vec::new();
            let mut covered: Vec<(String, u32)> = Vec::new();
            // Plots closest to the building first, so a building covering fewer plots than its
            // layout holds shows a compact cluster rather than whichever plots came first. Any
            // subset of a non-overlapping layout is still one.
            let center = crate::coverage::building_size(&env.building) / 2.0;
            let mut nearest_first = env.option.layout.clone();
            nearest_first.sort_by(|a, b| {
                let distance = |p: &crate::coverage::Placement| {
                    let (dx, dy) = (p.x + p.size / 2.0 - center, p.y + p.size / 2.0 - center);
                    dx * dx + dy * dy
                };
                distance(a).partial_cmp(&distance(b)).unwrap_or(std::cmp::Ordering::Equal)
            });
            for _ in 0..env.count {
                let mut layout = Vec::new();
                for placement in &nearest_first {
                    let need = still_needed.entry((placement.facility.clone(), env.mode.clone())).or_default();
                    if *need == 0 {
                        continue;
                    }
                    *need -= 1;
                    match covered.iter_mut().find(|(f, _)| *f == placement.facility) {
                        Some((_, n)) => *n += 1,
                        None => covered.push((placement.facility.clone(), 1)),
                    }
                    layout.push(FacilityPlacement {
                        facility: placement.facility.clone(),
                        x: placement.x,
                        y: placement.y,
                        size: placement.size,
                    });
                }
                // Show a tidy arrangement of the same plots when one fits on whole tiles; the
                // packing's own layout only matters for how many fit, not where they go.
                let mut here: Vec<(String, u32)> = Vec::new();
                for p in &layout {
                    match here.iter_mut().find(|(f, _)| *f == p.facility) {
                        Some((_, n)) => *n += 1,
                        None => here.push((p.facility.clone(), 1)),
                    }
                }
                if let Some(tidy) = crate::coverage::tidy_layout(building_size(&env.building), &here) {
                    layout = tidy
                        .into_iter()
                        .map(|p| FacilityPlacement { facility: p.facility, x: p.x, y: p.y, size: p.size })
                        .collect();
                }
                layouts.push(layout);
            }
            EnvironmentAssignment {
                building: env.building.clone(),
                mode: env.mode.clone(),
                units: env.count,
                covered,
                layouts,
                partner: None,
                zone: None,
                pair_modes: None,
            }
        })
        .filter(|a| !a.covered.is_empty())
        .chain(pair_assignments)
        .collect();

    crate::models::ProductionPlan {
        currency: currency.to_string(),
        rate_per_second: exact.rate_per_second,
        income_streams,
        coin_items,
        byproduct_rates,
        environment_assignments,
        candidates_evaluated: exact.recipe_rates.len() as u32,
        trial_solves: exact.nodes,
    }
}
