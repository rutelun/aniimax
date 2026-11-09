//! Tests for the exact planner (`aniimax::exact`). Each scenario checks that the plan is proven
//! optimal, passes the independent re-check, never earns less than the heuristic planner, and,
//! where worked out by hand, earns exactly what the arithmetic in the comments says.

use aniimax::data::{load_all_data, load_aniimo_requirements};
use aniimax::exact::{check_plan, net_rates, solve_exact, to_production_plan, ExactPlan, Goal, LevelUp, PACE_UNIT};
use aniimax::models::{AniimoSetup, FacilityCounts, ModuleLevels, ProductionItem};
use aniimax::optimizer::find_production_plan;
use std::path::Path;
use std::time::Duration;

#[test]
fn external_values_are_checked_before_skipping_continuous_reoptimization() {
    use aniimax::exact::{plan_from_values, write_lp};
    let items = vec![walking_item("checked_external", "Mine", 10.0, "coins")];
    let counts = FacilityCounts::only(&[("Mine", 1, 1)]);
    let modules = ModuleLevels::default();
    let goal = Goal::Earn { floors: &[] };
    assert_eq!(write_lp(&items, "coins", &counts, &modules, goal).variables, 3);
    let direct = plan_from_values(&items, "coins", &counts, &modules, goal, &[0.05, 1.0, 0.05], false, 0.1).unwrap();
    assert!((direct.rate_per_second - 0.05).abs() < 1e-9);
    check_plan(&direct, &items, "coins", &counts, &modules, None).unwrap();
    // An infeasible flow still takes the repair path, rather than bypassing validation.
    let repaired = plan_from_values(&items, "coins", &counts, &modules, goal, &[1.0, 1.0, 1.0], false, 0.1).unwrap();
    assert!((repaired.rate_per_second - 0.1).abs() < 1e-9);
    let floors = [("coins".into(), 0.09)];
    let floor_goal = Goal::Earn { floors: &floors };
    let repaired = plan_from_values(&items, "coins", &counts, &modules, floor_goal, &[0.05, 1.0, 0.05], false, 0.1).unwrap();
    assert!(repaired.rate_per_second >= 0.09);
}

#[test]
fn warm_start_keys_keep_worker_identity_when_levels_and_reserve_indices_change() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    use aniimax::exact::write_lp;
    let recipe = walking_item("warm_identity", "Mine", 10.0, "coins");
    let mut requirements = AniimoRequirements::default(); requirements.insert(&recipe.name, "Earth", 1);
    let make = |upgraded: bool| {
        let mut crew = crew_of(&[(1, &[("Earth", if upgraded { 4 } else { 3 })])]);
        if upgraded { crew.members.push(aniimax::models::RosterAniimo {count:1,abilities:[("Water".into(),3)].into(),..Default::default()}); }
        crew.assumed_from = Some(crew.members.len());
        crew.members.push(aniimax::models::RosterAniimo {count:20,abilities:[("Earth".into(),3)].into(),..Default::default()});
        let items = crew_variants(vec![recipe.clone()], &crew, &requirements, &GrowerSteps::default());
        let mut counts = FacilityCounts::only(&[("Mine",1,1)]); counts.set_crew(crew); counts.set_movement_seconds(5.0);
        write_lp(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&[]})
    };
    let old = make(false); let changed = make(true);
    assert_eq!(old.variable_keys.len(),old.variables);
    assert_eq!(old.variable_keys.iter().collect::<std::collections::BTreeSet<_>>().len(),old.variables);
    let relevant = |keys: &[String]| keys.iter().filter(|k| k.starts_with("rate:") || k.starts_with("units:"))
        .cloned().collect::<std::collections::BTreeSet<_>>();
    assert_eq!(relevant(&old.variable_keys),relevant(&changed.variable_keys));
    assert_ne!(old.lp,changed.lp);
}

#[test]
fn production_staff_pruning_requires_sufficient_reserves_and_keeps_final_choices() {
    use aniimax::models::{crew_variants,AniimoRequirements,GrowerSteps};
    use aniimax::power::{Electricity,PowerPlan,add_electric_variants};
    use aniimax::exact::write_lp;
    let original=vec![walking_item("staff_pruning","Mine",10.0,"coins")];
    let mut requirements=AniimoRequirements::default();requirements.insert("staff_pruning","Earth",1);
    for (capacity,limit,expected) in [(2,None,true),(1,None,false),(2,Some(2),false)] {
        let mut crew=crew_of(&[(1,&[("Lightning",4)])]);
        crew.add_reserve_workers([("Earth",1),("Lightning",1)],capacity);
        let mut counts=FacilityCounts::only(&[("Mine",1,1)]);counts.set_crew(crew.clone());counts.set_movement_seconds(5.0);
        let grid=Electricity{watts:600,percent:120,max_aniimo:limit};
        counts.set_power(PowerPlan{grid:grid.clone(),grower_steps:GrowerSteps::default()});
        let mut items=crew_variants(original.clone(),&crew,&requirements,&GrowerSteps::default());
        add_electric_variants(&mut items,original.clone(),&counts,&requirements,&grid);
        let problem=write_lp(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&[]});
        let staff=problem.variable_keys.iter().position(|key|key=="staff:Crackle Generator:owned:0#0").unwrap();
        let (_,terms,capacity)=problem.integer_groups.iter().find(|(name,_,_)|name=="staff_pruning").unwrap();
        let variants: Vec<_> = problem.variable_keys.iter().enumerate().filter(|(_,key)|key.starts_with("units:staff_pruning__"))
            .map(|(v,_)|(v,1.0)).collect();
        assert_eq!(*terms,variants,"worker and E-mode units belong to one physical recipe group");
        assert_eq!(*capacity,1);
        assert_eq!(problem.production_zero.contains(&staff),expected,"capacity={capacity}, limit={limit:?}");
        assert!(!problem.lp.contains(&format!(" 0 <= x{staff} <= 0\n")),"final staffing retains the owned worker");
    }
}

fn load_items() -> Option<Vec<ProductionItem>> {
    let data_dir = Path::new("data");
    data_dir.exists().then(|| load_all_data(data_dir).expect("Failed to load data"))
}

/// Solves `counts`/`modules` exactly and checks what every scenario should hold.
fn solve_and_check(items: &[ProductionItem], counts: &FacilityCounts, modules: &ModuleLevels) -> ExactPlan {
    let plan = solve_exact(items, "coins", counts, modules, Goal::Earn { floors: &[] }, Some(Duration::from_secs(60)), None)
        .expect("exact plan");
    assert!(plan.proven_optimal, "not proven optimal: {plan:?}");
    let recomputed = check_plan(&plan, items, "coins", counts, modules, None).expect("plan passes its re-check");
    assert!((recomputed - plan.rate_per_second).abs() < 1e-6);
    let heuristic = find_production_plan(items, "coins", counts, modules, false).map_or(0.0, |p| p.rate_per_second);
    assert!(
        plan.rate_per_second >= heuristic - 1e-6,
        "exact {} below heuristic {heuristic}",
        plan.rate_per_second
    );
    plan
}

// Six Farmland at level 2 with nothing else: watering takes a quarter off both, so wheat (5 per
// 180s, sells for 1) earns 6 x 5/180 = 0.1667/sec and potato (2 per 480s, sells for 8, seed 1)
// earns 6 x 15/480 = 0.1875; quick_wheat needs Ecological Module 1, which isn't owned. Potato wins.
#[test]
fn exact_picks_the_best_crop_on_its_own() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 6, 2)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    assert!((plan.rate_per_second - 6.0 * 15.0 / 480.0).abs() < 1e-9, "got {}", plan.rate_per_second);
    assert_eq!(plan.units.get("potato"), Some(&6));
}

fn solve_crop_variety(items: &[ProductionItem], counts: &FacilityCounts, modules: &ModuleLevels, expected: u32) -> ExactPlan {
    let solve = |goal| solve_exact(items, "coins", counts, modules, goal, Some(Duration::from_secs(10)), None).unwrap();
    let coverage = solve(Goal::CropVariety { seasonal_only: false });
    assert!(coverage.proven_optimal);
    assert_eq!(coverage.objective, expected as f64);
    let plan = solve(Goal::EarnWithCropVariety { minimum: expected, seasonal_only: false, floors: &[] });
    assert!(plan.proven_optimal);
    check_plan(&plan, items, "coins", counts, modules, None).unwrap();
    plan
}

#[test]
fn test_crop_variety_grows_available_level_six_resources() {
    let Some(items) = load_items() else { return };
    let mut counts = FacilityCounts::only(&[("Farmland", 4, 6), ("Woodland", 2, 6)]);
    let modules = ModuleLevels { ecological_module: 5, ..Default::default() };
    let uncovered = solve_crop_variety(&items, &counts, &modules, 4);
    assert!(!uncovered.units.contains_key("grape"));
    assert!(!uncovered.units.contains_key("orange_flower"));

    counts.set("Sunlamp", 1, 1);
    let plan = solve_crop_variety(&items, &counts, &modules, 6);
    let planted: std::collections::BTreeSet<_> = plan.units.keys().map(|name| aniimax::models::base_item_name(name)).collect();
    assert_eq!(planted, ["ginseng", "grape", "premium_wheat", "quick_rice", "cocoa", "orange_flower"].into());
}

#[test]
fn test_crop_variety_counts_quick_and_regular_wheat_once_across_tiers() {
    let Some(items) = load_items() else { return };
    let mut counts = FacilityCounts::only(&[("Farmland", 1, 1)]);
    counts.add_tier("Farmland", 1, 2);
    let modules = ModuleLevels { ecological_module: 1, ..Default::default() };
    let plan = solve_crop_variety(&items, &counts, &modules, 2);
    assert_eq!(plan.units.get("wheat"), Some(&1));
    assert_eq!(plan.units.get("potato"), Some(&1));
    assert!(!plan.units.contains_key("quick_wheat"));
}

#[test]
fn test_crop_variety_uses_a_lower_level_crop_for_a_more_profitable_chain() {
    let Some(mut items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 2, 2), ("Carousel Mill", 1, 1)]);
    let modules = ModuleLevels::default();
    let wheatmeal = items.iter().position(|item| item.name == "wheatmeal").unwrap();
    items[wheatmeal].sell_value = 56.25; // The same profit per plot as potatoes.
    let baseline = solve_crop_variety(&items, &counts, &modules, 1);
    assert_eq!(baseline.units.get("potato"), Some(&2));

    items[wheatmeal].sell_value = 500.0;
    let plan = solve_crop_variety(&items, &counts, &modules, 1);
    assert_eq!(plan.units.get("potato"), Some(&1));
    assert_eq!(plan.units.get("wheat"), Some(&1));
    assert_eq!(plan.units.get("wheatmeal"), Some(&1));
    assert!(plan.rate_per_second > baseline.rate_per_second);
}

// rice_drink (Carousel Mill) needs milled_rice made at a Carousel Mill too; with two Mills, one
// makes each. 3 rice plots, watered, make a rice drink every 1200s: 0.000833/sec x (1860 - 2 x 12
// seed) = 1.53; 4 Wells with level-1 Aniimo make 0.014222 fresh_water/sec, the drinks use 16 each
// and the rest sells at 46.
#[test]
fn exact_matches_the_hand_worked_rice_drink_plan() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 3, 3), ("Well", 4, 2), ("Carousel Mill", 2, 4)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    let drinks = 3.0 * 18.0 / 1800.0 / 18.0 / 2.0;
    let expected = drinks * (1860.0 - 24.0) + (4.0 * 8.0 / 2250.0 - 16.0 * drinks) * 46.0;
    assert!((plan.rate_per_second - expected).abs() < 1e-6, "got {}, expected {expected}", plan.rate_per_second);
    assert_eq!(plan.units.get("rice_drink"), Some(&1));
    assert_eq!(plan.units.get("milled_rice"), Some(&1));
    // The rice seeds come off the rice drink they end up in.
    let shown = to_production_plan(&plan, &items, "coins", &counts);
    let drink = shown.income_streams.iter().find(|s| s.item_name == "rice_drink").expect("rice drink sold");
    assert!((drink.rate_per_second - drinks * (1860.0 - 24.0)).abs() < 1e-9, "rice drink earns {}", drink.rate_per_second);
}

// A mid-game setup with an Aniimo setup applied and a Cooling Unit, so environment coverage and
// whole processor units both matter: the exact plan is proven, re-checks, and beats or ties the
// heuristic planner; its rows cover every owned unit exactly once.
#[test]
fn exact_handles_environments_and_aniimo_speeds() {
    let Some(mut items) = load_items() else { return };
    load_aniimo_requirements(Path::new("data")).unwrap().apply(&AniimoSetup::Best(aniimax::models::AniimoLevels::all(aniimax::models::MAX_ANIIMO_LEVEL)), &mut items);
    let counts = FacilityCounts::only(&[
        ("Farmland", 14, 4),
        ("Woodland", 8, 3),
        ("Mine", 4, 2),
        ("Well", 1, 1),
        ("Cooling Unit", 1, 1),
        ("Carousel Mill", 1, 2),
        ("Crafting Table", 1, 3),
        ("Jukebox Dryer", 1, 3),
        ("Claw Game Cooker", 1, 3),
        ("Phonolfactory Table", 1, 2),
        ("Dewy House", 1, 1),
        ("Tidewhisper Sandcastle", 1, 1),
    ]);
    let modules = ModuleLevels { ecological_module: 2, kitchen_module: 2, resource_detector: 1, crafting_module: 2 };
    let plan = solve_and_check(&items, &counts, &modules);
    let shown = to_production_plan(&plan, &items, "coins", &counts);
    for facility in ["Farmland", "Woodland", "Mine", "Crafting Table", "Jukebox Dryer"] {
        let rows: u32 = shown.coin_items.iter().filter(|s| s.facility == facility).map(|s| s.facility_count).sum();
        assert_eq!(rows, counts.get_count(facility), "{facility} rows: {:?}", shown.coin_items);
    }
    let streams: f64 = shown.income_streams.iter().map(|s| s.rate_per_second).sum();
    assert!((streams - plan.rate_per_second).abs() < 1e-6, "income streams add to {streams}");
    // Seed costs follow a crop into what it's made into, so nothing the plan chose to sell loses
    // money.
    for stream in &shown.income_streams {
        assert!(stream.rate_per_second > 0.0, "{} earns {}", stream.item_name, stream.rate_per_second);
    }
}

// "Prioritize byproducts": the most Wood Blocks the Woodland can make is found first, and the
// earning plan must still make that much.
#[test]
fn exact_keeps_prioritized_byproducts_at_their_maximum() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Woodland", 4, 2), ("Jukebox Dryer", 1, 2)]);
    let modules = ModuleLevels::default();
    let most = solve_exact(&items, "coins", &counts, &modules, Goal::MostOf("Wood Blocks"), None, None).unwrap();
    assert!(most.proven_optimal && most.objective > 0.0);
    let floors = vec![("Wood Blocks".to_string(), most.objective)];
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &floors }, None, None).unwrap();
    assert!(plan.proven_optimal);
    let made: f64 = plan
        .recipe_rates
        .iter()
        .filter_map(|(name, rate)| {
            let item = items.iter().find(|i| &i.name == name)?;
            item.byproduct.as_ref().filter(|(r, _)| r == "Wood Blocks").map(|(_, amount)| rate * *amount as f64)
        })
        .sum();
    assert!(made >= most.objective * (1.0 - 1e-5), "made {made}, most {}", most.objective);
    let unfloored = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    assert!(plan.rate_per_second <= unfloored.rate_per_second + 1e-9);
}

// A crop grows without its environment building, just slower: chestnut (Warm) grows in 3000s
// rather than 2400s at 80% speed, which watering brings to 2400s and 1800s, and it still beats
// every crop that wants no environment.
#[test]
fn exact_grows_crops_without_their_environment() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Woodland", 4, 4)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    assert!((plan.rate_per_second - 4.0 * 653.0 / 2400.0).abs() < 1e-9, "got {}", plan.rate_per_second);
    assert_eq!(plan.units.get("chestnut__uncovered"), Some(&4));

    // A Heat Furnace covers all four plots, and palm bark (Scorching, 673 a harvest over 1800s
    // once watered) is the best thing to put under it.
    let warmed = FacilityCounts::only(&[("Woodland", 4, 4), ("Heat Furnace", 1, 1)]);
    let covered = solve_and_check(&items, &warmed, &ModuleLevels::default());
    assert!((covered.rate_per_second - 4.0 * 673.0 / 1800.0).abs() < 1e-9, "got {}", covered.rate_per_second);
    assert_eq!(covered.units.get("palm_bark"), Some(&4));
    let mut full = to_production_plan(&covered,&items,"coins",&warmed);
    let summary = aniimax::exact::to_production_summary(&covered,&items,"coins",&warmed);
    assert!(!full.environment_assignments.is_empty());
    assert!(summary.environment_assignments.is_empty());
    full.environment_assignments.clear();
    assert_eq!(format!("{full:?}"),format!("{summary:?}"),"comparison reports retain every production metric");

    // Adequate crops still need their Sunlamp: walnut is worth more than chestnut but can't grow
    // without one.
    assert_eq!(plan.units.get("walnut__uncovered"), None);
    assert_eq!(plan.units.get("walnut"), None);
}

fn level_up(cost: &[(&str, f64)], stock: &[(&str, f64)]) -> LevelUp {
    let list = |l: &[(&str, f64)]| l.iter().map(|(n, a)| (n.to_string(), *a)).collect();
    LevelUp { cost: list(cost), stock: list(stock) }
}

#[test]
fn test_material_work_fills_both_facilities_up_to_their_supply() {
    let Some(mut items) = load_items() else { return };
    items.retain(|i| ["bamboo", "rock", "rough_lumber", "coarse_sifted_ore"].contains(&i.name.as_str()));
    for item in &mut items {
        if let Some((_, amount)) = item.byproduct.as_mut() {
            *amount = 2_000;
        }
    }
    let counts = FacilityCounts::only(&[
        ("Woodland", 1, 2), ("Mine", 1, 1), ("Woodworking Bench", 2, 1), ("Chimney Kiln", 2, 1),
    ]);
    let modules = ModuleLevels::default();
    let income = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    let floors = [("coins".into(), income.rate_per_second)];
    let base = Goal::Earn { floors: &floors };
    let work = Goal::MaterialWork { base: &base, minimum: None };
    let problem = aniimax::exact::write_lp(&items, "coins", &counts, &modules, work);
    for (index, item) in items.iter().enumerate() {
        let material = aniimax::exact::is_upgrade_material(item);
        assert_eq!(problem.material_fixed.contains(&(index * 2 + 1)), !material);
        assert_eq!(problem.primary_objective.iter().any(|&(v, _)| v == index * 2), material);
    }
    let full = solve_exact(&items, "coins", &counts, &modules, work, None, None).unwrap();
    assert!((full.objective - 4.0).abs() < 1e-6);
    assert_eq!(full.units.get("rough_lumber"), Some(&2));
    assert_eq!(full.units.get("coarse_sifted_ore"), Some(&2));
    assert!(full.rate_per_second >= income.rate_per_second * 0.9999 - 1e-9);
    check_plan(&full, &items, "coins", &counts, &modules, None).unwrap();

    let bamboo = items.iter_mut().find(|item| item.name == "bamboo").unwrap();
    let bamboo_time = bamboo.production_time;
    bamboo.byproduct.as_mut().unwrap().1 = 1;
    let limited = solve_exact(&items, "coins", &counts, &modules, work, None, None).unwrap();
    let lumber_rate = limited.recipe_rates["rough_lumber"];
    assert!((lumber_rate - 1.0 / (bamboo_time * 8.0)).abs() < 1e-9);
    assert_eq!(limited.units.get("coarse_sifted_ore"), Some(&2));
    check_plan(&limited, &items, "coins", &counts, &modules, None).unwrap();
}

#[test]
fn test_rv_materials_cannot_be_replaced_by_intermediate_workload() {
    let Some(mut items) = load_items() else { return };
    items.retain(|i| ["bamboo", "rock", "rough_lumber", "standard_planks", "coarse_sifted_ore", "sintered_ore_brick"].contains(&i.name.as_str()));
    for item in &mut items {
        if let Some((_, amount)) = item.byproduct.as_mut() { *amount = 2_000; }
    }
    let counts = FacilityCounts::only(&[("Woodland", 1, 2), ("Mine", 1, 1),
        ("Woodworking Bench", 2, 2), ("Chimney Kiln", 2, 2)]);
    let modules = ModuleLevels::default();
    let income = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    let floors = [("coins".into(), income.rate_per_second)];
    let base = Goal::Earn { floors: &floors };
    let target = level_up(&[("standard_planks", 100.0), ("sintered_ore_brick", 100.0)], &[]);
    let reserve = Goal::UpgradeMaterials { base: &base, level_up: &target, minimum: None };
    let stocked = solve_exact(&items, "coins", &counts, &modules, reserve, None, None).unwrap();
    assert!(stocked.objective > 0.0);
    let reserve = Goal::UpgradeMaterials { base: &base, level_up: &target, minimum: Some(stocked.objective) };
    let full = solve_exact(&items, "coins", &counts, &modules,
        Goal::MaterialWork { base: &reserve, minimum: None }, None, None).unwrap();
    let net = net_rates(&full, &items);
    for name in ["standard_planks", "sintered_ore_brick"] {
        assert!(net[name] * PACE_UNIT >= 100.0 * stocked.objective * 0.9998);
        assert_eq!(full.units[name], 1);
    }
    assert!(full.rate_per_second >= income.rate_per_second * 0.9999);
    check_plan(&full, &items, "coins", &counts, &modules, None).unwrap();
    let ordinary = aniimax::exact::write_lp(&items, "coins", &counts, &modules, base);
    let reserved = aniimax::exact::write_lp(&items, "coins", &counts, &modules, reserve);
    assert_eq!(reserved.variables, ordinary.variables + 1);
}

#[test]
fn test_electricity_uses_the_actual_building_level_and_keeps_faster_workers() {
    use aniimax::models::{AniimoLevels, GrowerSteps};
    use aniimax::power::{add_electric_variants, Electricity, PowerPlan};
    let Some(mut originals) = load_items() else { return };
    originals.retain(|item| matches!(item.name.as_str(), "rock" | "clay"));
    let requirements = load_aniimo_requirements(Path::new("data")).unwrap();
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1)]);
    counts.add_tier("Mine", 1, 2);
    let grid = Electricity { watts: 36, percent: 120, max_aniimo: None };
    counts.set_power(PowerPlan { grid: grid.clone(), grower_steps: GrowerSteps::default() });
    let mut items = originals.clone();
    requirements.apply(&AniimoSetup::Minimum, &mut items);
    add_electric_variants(&mut items, originals.clone(), &counts, &requirements, &grid);
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    assert_eq!(plan.units.get("rock__electric1"), Some(&1));
    assert_eq!(plan.units.get("clay"), Some(&1));
    assert_eq!(aniimax::exact::rated_power_draw(&plan, &items), 30.0);
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();

    let mut faster = originals.clone();
    requirements.apply(&AniimoSetup::Best(AniimoLevels::all(4)), &mut faster);
    add_electric_variants(&mut faster, originals, &counts, &requirements, &grid);
    assert!(faster.iter().all(|item| aniimax::power::electric_level(&item.name).is_none()));
}

#[test]
fn test_electricity_counts_lightning_workers_toward_the_roster_limit() {
    use aniimax::models::{Crew, GrowerSteps, RosterAniimo};
    use aniimax::power::{add_electric_variants, Electricity, PowerPlan, GENERATOR};
    let Some(mut originals) = load_items() else { return };
    originals.retain(|item| item.name == "rock");
    let requirements = load_aniimo_requirements(Path::new("data")).unwrap();
    let crew = Crew {
        members: vec![RosterAniimo { count: 2, abilities: [("Lightning".into(), 1)].into(), ..Default::default() }],
        ..Default::default()
    };
    let steps = GrowerSteps::default();
    let mut counts = FacilityCounts::only(&[("Mine", 21, 1)]);
    counts.set_crew(crew.clone());
    let modules = ModuleLevels::default();
    for (limit, mines, watts) in [(1, 20, 600.0), (2, 21, 630.0)] {
        let grid = Electricity { watts: 650, percent: 100, max_aniimo: Some(limit) };
        let mut items = aniimax::models::crew_variants(originals.clone(), &crew, &requirements, &steps);
        add_electric_variants(&mut items, originals.clone(), &counts, &requirements, &grid);
        counts.set_power(PowerPlan { grid, grower_steps: steps.clone() });
        let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
        assert_eq!(plan.units.get("rock__electric1"), Some(&mines));
        assert_eq!(aniimax::exact::rated_power_draw(&plan, &items), watts);
        assert_eq!(plan.staffing, vec![(GENERATOR.into(), 0, limit as f64)]);
        check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    }
}

#[test]
fn test_roster_uses_electricity_when_its_faster_worker_is_already_busy() {
    use aniimax::models::{crew_variants, GrowerSteps};
    use aniimax::power::{add_electric_variants, Electricity, PowerPlan, GENERATOR};
    let Some(mut originals) = load_items() else { return };
    originals.retain(|item| item.name == "rock");
    let requirements = load_aniimo_requirements(Path::new("data")).unwrap();
    let crew = crew_of(&[(1, &[("Earth", 4)]), (1, &[("Lightning", 1)])]);
    let steps = GrowerSteps::default();
    let grid = Electricity { watts: 60, percent: 100, max_aniimo: None };
    let modules = ModuleLevels::default();
    for mine_count in [1, 3] {
        let mut counts = FacilityCounts::only(&[("Mine", mine_count, 1)]);
        counts.set_crew(crew.clone());
        let mut items = crew_variants(originals.clone(), &crew, &requirements, &steps);
        add_electric_variants(&mut items, originals.clone(), &counts, &requirements, &grid);
        counts.set_power(PowerPlan { grid: grid.clone(), grower_steps: steps.clone() });
        let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
        assert_eq!(plan.units.get("rock__by0"), Some(&1));
        assert_eq!(plan.units.get("rock__electric1").copied().unwrap_or(0), mine_count - 1);
        let staffing = if mine_count > 1 { vec![(GENERATOR.into(), 1, 1.0)] } else { vec![] };
        assert_eq!(plan.staffing, staffing);
        check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    }
}

/// Solves a level-up in both stages and checks the plan: the soonest level-up, then the most
/// coins at that pace. Returns the plan and the level-up time in seconds.
fn solve_level_up(items: &[ProductionItem], counts: &FacilityCounts, level_up: &LevelUp) -> (ExactPlan, f64) {
    let modules = ModuleLevels::default();
    let fastest = solve_exact(items, "coins", counts, &modules, Goal::LevelUp(level_up), None, None).expect("level-up plan");
    assert!(fastest.proven_optimal && fastest.objective > 0.0);
    let pace = fastest.objective;
    let plan = solve_exact(items, "coins", counts, &modules, Goal::EarnWhileLevelingUp(level_up, pace, &[]), None, None)
        .expect("earning plan");
    assert!(plan.proven_optimal);
    assert!(plan.pace.unwrap() >= pace * (1.0 - 2e-4), "pace {:?} below {pace}", plan.pace);
    check_plan(&plan, items, "coins", counts, &modules, Some(level_up)).expect("plan passes its re-check");
    // Then spare Bench and Kiln time, without giving up pace or coins.
    let stocked = solve_exact(items, "coins", counts, &modules, Goal::StockUp(level_up, pace, plan.rate_per_second, &[]), None, None)
        .expect("stocked plan");
    assert!(stocked.proven_optimal);
    assert!(stocked.rate_per_second >= plan.rate_per_second * (1.0 - 2e-3));
    check_plan(&stocked, items, "coins", counts, &modules, Some(level_up)).expect("stocked plan passes its re-check");
    // Nothing that sells for coins is left over: spare clay from a Mine kept for its Mineral Sand
    // still sells.
    for (name, spare) in net_rates(&stocked, items) {
        let sells = items.iter().any(|i| i.name == name && i.sell_currency == "coins" && i.sell_value > 0.0);
        assert!(!sells || spare < 1e-7, "{name}: {spare}/sec left unsold");
    }
    (stocked, PACE_UNIT / pace)
}

// With the items already in stock, a level-up is only coins: the time is the coins still needed
// over the best coin rate.
#[test]
fn exact_level_up_with_items_in_stock_is_only_coins() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 6, 2), ("Woodland", 3, 2), ("Mine", 2, 2)]);
    let best = solve_exact(&items, "coins", &counts, &ModuleLevels::default(), Goal::Earn { floors: &[] }, None, None).unwrap();
    let cost = [("coins", 69000.0), ("rough_lumber", 290.0), ("coarse_sifted_ore", 360.0)];
    let stock = [("coins", 9000.0), ("rough_lumber", 300.0), ("coarse_sifted_ore", 400.0)];
    let (plan, seconds) = solve_level_up(&items, &counts, &level_up(&cost, &stock));
    let expected = 60000.0 / best.rate_per_second;
    assert!((seconds - expected).abs() < 1e-4 * expected, "took {seconds}s, expected {expected}s");
    assert!((plan.rate_per_second - best.rate_per_second).abs() < 1e-6);
}

// The items come from Wood Blocks and Mineral Sand through the Woodworking Bench and Chimney
// Kiln, so the plan must run them, and has to give up some coins to make the byproducts.
#[test]
fn exact_level_up_makes_its_items_from_byproducts() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[
        ("Farmland", 6, 2),
        ("Woodland", 3, 2),
        ("Mine", 2, 2),
        ("Woodworking Bench", 1, 1),
        ("Chimney Kiln", 1, 1),
    ]);
    let cost = level_up(&[("coins", 69000.0), ("rough_lumber", 290.0), ("coarse_sifted_ore", 360.0)], &[]);
    let (plan, seconds) = solve_level_up(&items, &counts, &cost);
    assert!(plan.units.contains_key("rough_lumber") && plan.units.contains_key("coarse_sifted_ore"), "{plan:?}");
    let net = net_rates(&plan, &items);
    assert!(net["rough_lumber"] * seconds >= 290.0 * (1.0 - 2e-4));
    assert!(net["coarse_sifted_ore"] * seconds >= 360.0 * (1.0 - 2e-4));
    assert!(plan.rate_per_second * seconds >= 69000.0 * (1.0 - 2e-4));

    // Items in stock cut the time. Wood Blocks and Mineral Sand wouldn't: the Woodland and Mine
    // make plenty of both, and what sets the pace is the Bench and Kiln time to work them up.
    let stocked = level_up(
        &[("coins", 69000.0), ("rough_lumber", 290.0), ("coarse_sifted_ore", 360.0)],
        &[("rough_lumber", 145.0), ("coarse_sifted_ore", 180.0)],
    );
    let (_, sooner) = solve_level_up(&items, &counts, &stocked);
    assert!(sooner < seconds, "{sooner}s with half the items in stock, {seconds}s without");

    // Without the Bench the items can't be made at all.
    let no_bench = FacilityCounts::only(&[("Farmland", 6, 2), ("Woodland", 3, 2), ("Mine", 2, 2), ("Chimney Kiln", 1, 1)]);
    let fastest = solve_exact(&items, "coins", &no_bench, &ModuleLevels::default(), Goal::LevelUp(&cost), None, None).unwrap();
    assert!(fastest.objective < 1e-9, "pace {} without a Bench", fastest.objective);
}

// Each material recipe needs its own building, including ingredients of another recipe.
#[test]
fn exact_upgrade_chains_require_separate_recipe_buildings() {
    let Some(items) = load_items() else { return };
    let mut counts = FacilityCounts::only(&[
        ("Farmland", 6, 2), ("Woodland", 3, 2), ("Mine", 2, 2),
        ("Woodworking Bench", 1, 2), ("Chimney Kiln", 1, 2),
    ]);
    let cost = level_up(&[("coins", 680000.0), ("standard_planks", 320.0), ("sintered_ore_brick", 350.0)], &[]);
    let blocked = solve_exact(&items, "coins", &counts, &ModuleLevels::default(), Goal::LevelUp(&cost), None, None).unwrap();
    assert!(blocked.objective < 1e-9, "one building cannot run two recipes simultaneously");
    counts.set("Woodworking Bench", 2, 2); counts.set("Chimney Kiln", 2, 2);
    let (plan, _) = solve_level_up(&items, &counts, &cost);
    for name in ["rough_lumber", "standard_planks", "coarse_sifted_ore", "sintered_ore_brick"] {
        assert_eq!(plan.units.get(name), Some(&1));
    }
    let shown = to_production_plan(&plan, &items, "coins", &counts);
    for facility in ["Woodworking Bench", "Chimney Kiln"] {
        assert_eq!(shown.coin_items.iter().filter(|row| row.facility == facility).map(|row| row.facility_count).sum::<u32>(), 2);
    }
}

// Mineral Sand is plentiful here while Wood Blocks set the pace, so the Kiln turns the spare sand
// into Coarse-Sifted Ore and the ore is ready before the Rough Lumber.
#[test]
fn exact_level_up_processes_spare_byproducts() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[
        ("Woodland", 1, 1),
        ("Mine", 6, 3),
        ("Woodworking Bench", 1, 1),
        ("Chimney Kiln", 1, 1),
    ]);
    let cost = level_up(&[("coins", 1000.0), ("rough_lumber", 100.0), ("coarse_sifted_ore", 100.0)], &[]);
    let (plan, seconds) = solve_level_up(&items, &counts, &cost);
    let net = net_rates(&plan, &items);
    assert!((net["rough_lumber"] * seconds - 100.0).abs() < 0.05, "lumber {}", net["rough_lumber"] * seconds);
    assert!(net["coarse_sifted_ore"] * seconds > 150.0, "ore {}", net["coarse_sifted_ore"] * seconds);
}

/// Every item plus the Harvest Moon Festival's.
fn load_items_with_season() -> Option<Vec<ProductionItem>> {
    let mut items = load_items()?;
    let text = std::fs::read_to_string("data/harvest_moon_festival.csv").expect("season data");
    let mut season = aniimax::data::parse_season(&text).expect("season parses");
    aniimax::models::apply_watering(&mut season);
    items.extend(season);
    Some(items)
}

// Moonray Wheat is treated as unlimited, so season seeds cost nothing a plan counts and all six
// plots grow Moondew Radish or Waxing Moon Pepper (8 a batch, 74 coins each), far more per plot
// than potato.
#[test]
fn exact_season_crops_fill_every_plot() {
    let Some(items) = load_items_with_season() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 6, 2)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    let grow = items.iter().find(|i| i.name == "moondew_radish").unwrap().production_time;
    let expected = 6.0 * 8.0 * 74.0 / grow;
    assert!((plan.rate_per_second - expected).abs() < 1e-9, "got {}, expected {expected}", plan.rate_per_second);
}

// With 60 Moonray Wheat a day for seeds (4 a planting), the season crops are planted 15 times a
// day, which one plot covers (15 x 1800s), worth 8880 coins a day against a potato plot's 2700;
// the other five plots grow potato.
#[test]
fn test_exact_season_currency_budget_caps_seeds() {
    let Some(mut items) = load_items_with_season() else { return };
    for terms in items.iter_mut().filter_map(|i| i.season.as_mut()) {
        terms.currency_per_day = Some(60.0);
    }
    let counts = FacilityCounts::only(&[("Farmland", 6, 2)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    let time = |name: &str| items.iter().find(|i| i.name == name).unwrap().production_time;
    let expected = 15.0 * 8.0 * 74.0 / PACE_UNIT + 5.0 * (2.0 * 8.0 - 1.0) / time("potato");
    assert!((plan.rate_per_second - expected).abs() < 1e-9, "got {}, expected {expected}", plan.rate_per_second);

    // The re-check catches a plan spending more than the budget.
    let mut over = plan.clone();
    let crop = over.recipe_rates.keys().find(|n| n.starts_with("moondew") || n.starts_with("waxing")).unwrap().clone();
    *over.recipe_rates.get_mut(&crop).unwrap() *= 1.5;
    let err = check_plan(&over, &items, "coins", &counts, &ModuleLevels::default(), None).unwrap_err();
    assert!(err.contains("budget"), "{err}");
}

// Points as a priority: every season crop sold raw counts 1, which beats cooking 16 of them into
// something worth 8 at most, so the most points is all six plots sold raw. The coin plan that has
// to keep that many points is then the same as the best coin plan.
#[test]
fn exact_season_points_are_a_priority() {
    let Some(items) = load_items_with_season() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 6, 2), ("Simmering Pot", 1, 1), ("Tidewhisper Sandcastle", 1, 1)]);
    let modules = ModuleLevels::default();
    let points = aniimax::models::SEASON_POINTS;
    let most = solve_exact(&items, points, &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    assert!(most.proven_optimal);
    let grow = items.iter().find(|i| i.name == "moondew_radish").unwrap().production_time;
    assert!((most.rate_per_second - 6.0 * 8.0 / grow).abs() < 1e-9, "{} points a second", most.rate_per_second);
    check_plan(&most, &items, points, &counts, &modules, None).expect("points plan passes its re-check");
    let floors = vec![(points.to_string(), most.rate_per_second)];
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &floors }, None, None).unwrap();
    assert!(plan.proven_optimal);
    check_plan(&plan, &items, "coins", &counts, &modules, None).expect("coin plan passes its re-check");
    let kept = aniimax::exact::target_rate(&plan, &items, points);
    // Floors leave 0.01% of slack for the solver's tolerances.
    assert!(kept >= most.rate_per_second * (1.0 - 1.01e-4), "kept {kept} of {} points a second", most.rate_per_second);
}

/// Every item plus Magical Wonder Night's.
fn load_items_with_wonder_night() -> Option<Vec<ProductionItem>> {
    let mut items = load_items()?;
    let text = std::fs::read_to_string("data/magical_wonder_night.csv").expect("season data");
    let mut season = aniimax::data::parse_season(&text).expect("season parses");
    aniimax::models::apply_watering(&mut season);
    items.extend(season);
    Some(items)
}

#[test]
fn test_crop_variety_keeps_season_crops_and_priority_on_higher_level_plots() {
    let Some(mut items) = load_items_with_wonder_night() else { return };
    items.iter_mut().filter(|item| item.season.is_some()).for_each(|item| item.sell_value = 1.0);
    let counts = FacilityCounts::only(&[("Farmland", 6, 6), ("Sunlamp", 1, 1)]);
    let modules = ModuleLevels::default();
    let solve = |currency, goal| solve_exact(&items, currency, &counts, &modules, goal, None, None).unwrap();
    let coverage = solve("coins", Goal::CropVariety { seasonal_only: false });
    let earn = |floors| Goal::EarnWithCropVariety {
        minimum: coverage.objective as u32,
        seasonal_only: false,
        floors,
    };
    let points = aniimax::models::SEASON_POINTS;
    let most_points = solve(points, earn(&[]));
    let floors = [(points.to_owned(), most_points.objective)];
    let plan = solve("coins", earn(&floors));
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    for name in ["magic_pumpkin", "memory_lanternfruit", "ginseng", "grape", "premium_wheat"] {
        assert!(plan.recipe_rates.keys().any(|recipe| aniimax::models::base_item_name(recipe) == name));
    }
    let points_kept = aniimax::exact::target_rate(&plan, &items, points);
    let coins_only = solve("coins", earn(&[]));
    assert!(points_kept >= most_points.objective * (1.0 - 1.01e-4));
    assert!(points_kept > aniimax::exact::target_rate(&coins_only, &items, points));
}

#[test]
fn test_season_planting_respects_the_seed_budget() {
    let Some(mut items) = load_items_with_wonder_night() else { return };
    for season in items.iter_mut().filter_map(|item| item.season.as_mut()) {
        season.currency_per_day = Some(4.0); // One batch of either event crop.
    }
    let counts = FacilityCounts::only(&[("Farmland", 4, 6), ("Sunlamp", 1, 1)]);
    let coverage = solve_exact(&items, "coins", &counts, &ModuleLevels::default(),
        Goal::CropVariety { seasonal_only: true }, None, None).unwrap();
    assert_eq!(coverage.objective, 1.0);
}

#[test]
fn test_season_crop_minimums_reserve_plots_even_when_budget_slows_harvest() {
    let Some(mut items) = load_items_with_wonder_night() else { return };
    let mut counts = FacilityCounts::only(&[("Farmland", 8, 6), ("Sunlamp", 1, 1)]);
    counts.set_season_crop_minimums([("magic_pumpkin".into(), 4), ("memory_lanternfruit".into(), 4)].into());
    for season in items.iter_mut().filter_map(|item| item.season.as_mut()) {
        season.currency_per_day = Some(1800.0); // Eight plots at full speed would cost 2048.
    }
    let modules = ModuleLevels::default();
    let goal = Goal::Earn { floors: &[] };
    let plan = solve_exact(&items, "coins", &counts, &modules, goal, None, None).unwrap();
    assert_eq!(plan.units.get("magic_pumpkin"), Some(&4));
    assert_eq!(plan.units.get("memory_lanternfruit"), Some(&4));
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();

    for season in items.iter_mut().filter_map(|item| item.season.as_mut()) {
        season.currency_per_day = Some(4.0);
    }
    assert!(solve_exact(&items, "coins", &counts, &modules, goal, None, None).is_none());
}

// Magic Pumpkin and Memory Lanternfruit are Adequate, so they grow only under a Sunlamp: without
// one the plan can't touch them, and with one it grows them (8 a batch at 61 coins, seeds paid in
// Weird Jelly Beans, beating lavender, the other Adequate crop at that level).
#[test]
fn test_exact_wonder_night_crops_need_a_sunlamp() {
    let Some(items) = load_items_with_wonder_night() else { return };
    let modules = ModuleLevels::default();
    let season_crop = |plan: &ExactPlan| plan.recipe_rates.keys().any(|n| n.starts_with("magic_pumpkin") || n.starts_with("memory_lanternfruit"));
    let without = solve_and_check(&items, &FacilityCounts::only(&[("Farmland", 4, 5)]), &modules);
    assert!(!season_crop(&without), "grew a season crop with no Sunlamp: {:?}", without.recipe_rates);
    let with = solve_and_check(&items, &FacilityCounts::only(&[("Farmland", 4, 5), ("Sunlamp", 1, 1)]), &modules);
    assert!(season_crop(&with), "no season crop under the Sunlamp: {:?}", with.recipe_rates);
    assert!(with.rate_per_second > without.rate_per_second);
}

// During a season, a level-up plan keeps the soonest level-up's pace and puts what that leaves
// over into the season's points before the coin solve, which keeps them: the plan still levels up
// as soon, and makes the season's items even where they pay too little for a coin plan to bother.
// That's Magical Wonder Night at RV 15, where going for coins at the level-up's pace grew none;
// here every season item sells for 1 coin, so a coin plan never makes one.
#[test]
fn test_exact_level_up_makes_season_points_at_its_pace() {
    let Some(mut items) = load_items_with_wonder_night() else { return };
    items.iter_mut().filter(|i| i.season.is_some()).for_each(|i| i.sell_value = 1.0);
    let counts = FacilityCounts::only(&[
        ("Farmland", 8, 5),
        ("Sunlamp", 1, 1),
        ("Woodland", 3, 2),
        ("Mine", 2, 2),
        ("Woodworking Bench", 1, 1),
        ("Chimney Kiln", 1, 1),
        ("Crafting Table", 1, 4),
        ("Simmering Pot", 1, 3),
        ("Well", 2, 2),
    ]);
    let modules = ModuleLevels::default();
    let points = aniimax::models::SEASON_POINTS;
    let cost = level_up(&[("coins", 69000.0), ("rough_lumber", 290.0), ("coarse_sifted_ore", 360.0)], &[]);
    let fastest = solve_exact(&items, "coins", &counts, &modules, Goal::LevelUp(&cost), None, None).unwrap();
    assert!(fastest.proven_optimal && fastest.objective > 0.0);
    let pace = fastest.objective;

    // Coins alone at that pace, as before: no season items.
    let coins_only = solve_exact(&items, "coins", &counts, &modules, Goal::EarnWhileLevelingUp(&cost, pace, &[]), None, None).unwrap();
    assert!(aniimax::exact::target_rate(&coins_only, &items, points) < 1e-12, "{:?}", coins_only.recipe_rates);

    let most = solve_exact(&items, "coins", &counts, &modules, Goal::MostWhileLevelingUp(&cost, pace, points), None, None).unwrap();
    assert!(most.proven_optimal);
    assert!(most.pace.unwrap() >= pace * (1.0 - 2e-4), "pace {:?} below {pace}", most.pace);
    check_plan(&most, &items, "coins", &counts, &modules, Some(&cost)).expect("points plan passes its re-check");
    let most_points = aniimax::exact::target_rate(&most, &items, points);
    assert!((most.objective - most_points).abs() < 1e-9, "objective {} is not its points {most_points}", most.objective);
    assert!(most_points > 0.0, "no season points at the level-up's pace: {:?}", most.recipe_rates);

    let floors = vec![(points.to_string(), most_points)];
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::EarnWhileLevelingUp(&cost, pace, &floors), None, None).unwrap();
    assert!(plan.proven_optimal);
    assert!(plan.pace.unwrap() >= pace * (1.0 - 2e-4), "pace {:?} below {pace}", plan.pace);
    check_plan(&plan, &items, "coins", &counts, &modules, Some(&cost)).expect("plan passes its re-check");
    let kept = aniimax::exact::target_rate(&plan, &items, points);
    assert!(kept >= most_points * (1.0 - 1.01e-4), "kept {kept} of {most_points} points a second");
    assert!(plan.recipe_rates.keys().any(|n| n.starts_with("magic_pumpkin") || n.starts_with("memory_lanternfruit")), "{:?}", plan.recipe_rates);

    // Spare Bench and Kiln time still goes to the level-up, keeping the points too.
    let stocked =
        solve_exact(&items, "coins", &counts, &modules, Goal::StockUp(&cost, pace, plan.rate_per_second, &floors), None, None).unwrap();
    check_plan(&stocked, &items, "coins", &counts, &modules, Some(&cost)).expect("stocked plan passes its re-check");
    assert!(aniimax::exact::target_rate(&stocked, &items, points) >= most_points * (1.0 - 1.01e-4));
}

// A goal counts each item from its first batch, so what makes a priority is split by item with
// its wait; the rates still add up to the priority's own rate, for a byproduct and for points.
#[test]
fn exact_target_streams_add_up_to_the_rate() {
    let Some(items) = load_items_with_season() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 6, 2), ("Woodland", 4, 2), ("Jukebox Dryer", 1, 2)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    for target in ["Wood Blocks", aniimax::models::SEASON_POINTS] {
        let streams = aniimax::exact::target_streams(&plan, &items, target);
        assert!(!streams.is_empty(), "nothing makes {target}");
        let total: f64 = streams.iter().map(|(rate, _)| rate).sum();
        let rate = aniimax::exact::target_rate(&plan, &items, target);
        assert!((total - rate).abs() < 1e-12, "{target}: streams {total}, rate {rate}");
        assert!(streams.iter().all(|&(_, lead)| lead > 0.0), "{target}: a stream with no wait");
    }
}

// Three plots of Sugarcane want Scorching, and one Heat Furnace covers all three, so a plan with
// two Furnaces owned sets up just the one: the second would earn nothing and need its own Aniimo.
#[test]
fn exact_uses_the_fewest_environment_buildings() {
    let Some(items) = load_items() else { return };
    let counts = FacilityCounts::only(&[("Farmland", 3, 5), ("Heat Furnace", 2, 1)]);
    let plan = solve_and_check(&items, &counts, &ModuleLevels::default());
    assert_eq!(plan.units.get("sugarcane"), Some(&3), "units {:?}", plan.units);
    let buildings: u32 = plan.environment.iter().map(|e| e.count).sum::<u32>() + 2 * plan.pairs.iter().map(|p| p.count).sum::<u32>();
    assert_eq!(buildings, 1, "environment {:?}, pairs {:?}", plan.environment, plan.pairs);
    // What the plan reports earning leaves the tie-break out.
    let recomputed = check_plan(&plan, &items, "coins", &counts, &ModuleLevels::default(), None).unwrap();
    assert!((plan.objective - recomputed).abs() < 1e-9, "objective {} vs {recomputed}", plan.objective);
}

/// The data's items reworked for `crew` (see `aniimax::models::crew_variants`).
fn crew_items(crew: &aniimax::models::Crew) -> Option<Vec<ProductionItem>> {
    let items = load_items()?;
    let requirements = load_aniimo_requirements(Path::new("data")).unwrap();
    let steps = aniimax::data::load_grower_steps(Path::new("data")).unwrap();
    Some(aniimax::models::crew_variants(items, crew, &requirements, &steps))
}

/// A roster of `(count, [(ability, level)])`, with the game's environment buildings and no
/// personality bonuses.
fn crew_of(members: &[(u32, &[(&str, u32)])]) -> aniimax::models::Crew {
    aniimax::models::Crew {
        assumed_from: None,
        members: members
            .iter()
            .map(|(count, abilities)| aniimax::models::RosterAniimo {
                count: *count,
                abilities: abilities.iter().map(|(a, l)| (a.to_string(), *l)).collect(),
                personalities: Vec::new(),
                family: abilities.iter().any(|(a, _)| *a == "Leisure").then(|| "1017".to_string()),
            })
            .collect(),
        residents: ["Tidewhisper Sandcastle", "Dewy House", "Nimbus Bed", "Starfall Hammock", "Floral Windmill"]
            .into_iter()
            .map(String::from)
            .collect(),
        environment: [("Heat Furnace", "Fire"), ("Cooling Unit", "Ice"), ("Sunlamp", "Light")]
            .into_iter()
            .map(|(b, a)| (b.to_string(), a.to_string()))
            .collect(),
        personalities: Default::default(),
    }
}

fn solve_with_crew(counts: &FacilityCounts, crew: aniimax::models::Crew) -> (ExactPlan, Vec<ProductionItem>) {
    let items = crew_items(&crew).expect("data");
    let mut counts = counts.clone();
    counts.set_crew(crew);
    counts.set_grower_steps(aniimax::data::load_grower_steps(Path::new("data")).unwrap());
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, Some(Duration::from_secs(60)), None)
        .expect("exact plan");
    assert!(plan.proven_optimal, "not proven optimal");
    check_plan(&plan, &items, "coins", &counts, &modules, None).expect("plan passes its re-check");
    (plan, items)
}

// Four Mines, but only one level-4 Earth Aniimo to work them: it has one day to spread over the
// four, so the plan makes exactly a quarter of what four such Aniimo would.
#[test]
fn crew_one_aniimo_works_one_day() {
    if load_items().is_none() {
        return;
    }
    let counts = FacilityCounts::only(&[("Mine", 4, 3)]);
    let (one, _) = solve_with_crew(&counts, crew_of(&[(1, &[("Earth", 4)])]));
    let (four, _) = solve_with_crew(&counts, crew_of(&[(4, &[("Earth", 4)])]));
    assert!(four.rate_per_second > 0.0);
    assert!((one.rate_per_second * 4.0 - four.rate_per_second).abs() < 1e-9, "one {} vs four {}", one.rate_per_second, four.rate_per_second);
}

#[test]
fn reserve_crew_fills_open_shifts_and_prefers_equally_fast_owned_aniimo() {
    let mut crew = crew_of(&[(1, &[("Earth", 3)])]);
    crew.add_reserve_workers([("Earth", 1), ("Earth", 2), ("Fire", 4), ("Lightning", 1)], 4);
    assert_eq!(crew.assumed_from, Some(1));
    assert_eq!(crew.members.len(), 3);
    assert!(crew.can_work(0, "Earth", 1));
    assert!(crew.can_work(1, "Earth", 1));
    assert!(crew.can_work(1, "Earth", 2));
    assert!(!crew.can_work(1, "Earth", 4));
    assert!(crew.can_work(2, "Lightning", 1));
    assert_eq!(crew.members[1].level("Earth"), 3);
    assert_eq!(crew.members[1].count, 4);
    assert!(crew.members[1].personalities.is_empty());
    let counts = FacilityCounts::only(&[("Mine", 4, 1)]);
    let (plan, _) = solve_with_crew(&counts, crew);
    assert_eq!(plan.units.get("rock__by0"), Some(&1));
    assert_eq!(plan.units.get("rock__by1"), Some(&3));
}

// A Heat Furnace needs a Fire Aniimo on it all day. Without one, Sugarcane (which wants Scorching)
// can only grow uncovered; with one, it's covered and the plan says who staffs the Furnace.
// Farmland jobs need Earth, Grass and Dark, so the roster has someone for those too.
#[test]
fn crew_staffs_environment_buildings() {
    if load_items().is_none() {
        return;
    }
    let counts = FacilityCounts::only(&[("Farmland", 3, 5), ("Heat Furnace", 1, 1)]);
    let farmer: &[(&str, u32)] = &[("Earth", 1), ("Grass", 1), ("Dark", 1)];
    let (without, _) = solve_with_crew(&counts, crew_of(&[(1, farmer)]));
    assert!(without.environment.is_empty() && without.staffing.is_empty(), "no one to staff it: {:?}", without.environment);
    let crew = crew_of(&[(1, farmer), (1, &[("Fire", 1)])]);
    let (with, items) = solve_with_crew(&counts, crew.clone());
    assert_eq!(with.environment.iter().map(|e| e.count).sum::<u32>(), 1);
    assert_eq!(with.staffing.len(), 1);
    assert_eq!(with.staffing[0].1, 1, "staffed by the Fire Aniimo");
    assert!((with.staffing[0].2 - 1.0).abs() < 1e-9);
    assert!(with.rate_per_second > without.rate_per_second);
    let mut half_shifts = with.clone();
    half_shifts.staffing = vec![("Heat Furnace".into(), 1, 0.5), ("Heat Furnace".into(), 1, 0.5)];
    let mut staffed_counts = counts.clone();
    staffed_counts.set_crew(crew);
    staffed_counts.set_grower_steps(aniimax::data::load_grower_steps(Path::new("data")).unwrap());
    let error = check_plan(&half_shifts, &items, "coins", &staffed_counts, &ModuleLevels::default(), None).unwrap_err();
    assert!(error.contains("requires whole dedicated Aniimo"), "{error}");
}

// Nobody to sow or reap: no crop can be grown at all.
#[test]
fn crew_crops_need_their_jobs_done() {
    if load_items().is_none() {
        return;
    }
    let counts = FacilityCounts::only(&[("Farmland", 3, 5)]);
    let (plan, _) = solve_with_crew(&counts, crew_of(&[(2, &[("Fire", 3)])]));
    assert!(plan.recipe_rates.is_empty(), "grew {:?}", plan.recipe_rates);
}


// Watering only speeds crops up: with nobody to water them they still grow, at their unwatered
// time. Six level-2 plots of potato (2 per batch, sells for 8, seed 1) take 640s unwatered and
// 480s watered.
#[test]
fn crew_without_water_grows_unwatered() {
    if load_items().is_none() {
        return;
    }
    let counts = FacilityCounts::only(&[("Farmland", 6, 2)]);
    let farmer: &[(&str, u32)] = &[("Earth", 1), ("Grass", 1), ("Dark", 1)];
    let (dry, _) = solve_with_crew(&counts, crew_of(&[(1, farmer)]));
    let (wet, _) = solve_with_crew(&counts, crew_of(&[(1, farmer), (1, &[("Water", 1)])]));
    assert!((dry.rate_per_second - 6.0 * 15.0 / 640.0).abs() < 1e-9, "unwatered {}", dry.rate_per_second);
    assert!((wet.rate_per_second - 6.0 * 15.0 / 480.0).abs() < 1e-9, "watered {}", wet.rate_per_second);
}

// A full production shift leaves no free time for even short per-harvest work.
// This holds without electricity and with electricity enabled but no team cap.
#[test]
fn crop_jobs_share_roster_time_without_a_team_limit() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerStep, GrowerSteps};
    use aniimax::power::{Electricity, PowerPlan};
    let originals = load_items().unwrap();
    for (ability, job) in [("Water", "Watering"), ("Grass", "Collecting"), ("Earth", "Reclaiming"), ("Dark", "Reaping")] {
        let mut crop = originals.iter().find(|i| i.name == "potato").unwrap().clone();
        crop.production_time = 10.0;
        crop.facility_level = 1;
        crop.yield_amount = 1;
        crop.sell_currency = "aniimo_exp".into();
        crop.sell_value = 1.0;
        crop.cost = None;
        let mut production = originals.iter().find(|i| i.name == "fresh_water").unwrap().clone();
        production.facility_level = 1;
        production.workload = Some(10.0);
        production.yield_amount = 1;
        production.sell_value = 20.0;
        let mut requirements = AniimoRequirements::default();
        requirements.insert("fresh_water", ability, 1);
        let mut steps = GrowerSteps::default();
        steps.insert("potato", GrowerStep { step: job.into(), ability: ability.into(), min_level: 1, workload: 3.0 });
        let crew = crew_of(&[(2, &[(ability, 3), ("Water", 3)])]);
        let items = crew_variants(vec![crop, production], &crew, &requirements, &steps);
        for electricity in [false, true] {
            let mut counts = FacilityCounts::only(&[("Farmland", 1, 1), ("Well", 2, 1)]);
            counts.set_crew(crew.clone());
            counts.set_grower_steps(steps.clone());
            if electricity { counts.set_power(PowerPlan {
                grid: Electricity { watts: 600, percent: 100, max_aniimo: None }, grower_steps: steps.clone(),
            }); }
            let modules = ModuleLevels::default();
            let floors = [("aniimo_exp".to_string(), 0.1)];
            let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &floors }, None, None).unwrap();
            check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
            let crop_busy: f64 = plan.crop_staffing.iter().map(|(_, _, _, busy)| busy).sum();
            let production_busy: f64 = plan.recipe_rates.iter().filter_map(|(name, rate)| {
                let recipe = items.iter().find(|i| &i.name == name)?;
                recipe.crew.map(|_| rate * recipe.production_time)
            }).sum();
            assert!(crop_busy > 0.0, "{job} was free");
            let harvests = plan.recipe_rates.get("potato").copied().unwrap_or(0.0);
            let job_seconds = aniimax::models::Worker::new(3, false).seconds_for(3.0, 1, true);
            assert!((crop_busy - harvests * job_seconds).abs() < 1e-6, "{job} ignores ability level");
            assert!(production_busy < 2.0 - 1e-5, "{job} added to two full production shifts");
            assert!((production_busy + crop_busy - 2.0).abs() < 1e-6);
            let mut unchecked = plan.clone();
            unchecked.crop_staffing.clear();
            assert!(check_plan(&unchecked, &items, "coins", &counts, &modules, None).is_err(), "missing {job} staffing passed re-check");
        }
    }
}

// Each roster member able to work a recipe gets a copy of it, timed for that member; the recipe
// itself stays for its price, can't be made as it is, and takes the fastest member's time.
#[test]
fn crew_copies_are_timed_per_member() {
    let crew = crew_of(&[(1, &[("Earth", 1)]), (1, &[("Earth", 4)])]);
    let Some(items) = crew_items(&crew) else { return };
    let rocks: Vec<&ProductionItem> = items.iter().filter(|i| aniimax::models::base_item_name(&i.name) == "rock").collect();
    let copy = |member: usize| rocks.iter().find(|i| i.crew == Some(member)).expect("a copy per member");
    assert_eq!(copy(0).name, "rock__by0");
    assert!(copy(1).production_time < copy(0).production_time, "the level-4 Aniimo is faster");
    let original = rocks.iter().find(|i| i.crew.is_none()).expect("the recipe itself stays");
    assert_eq!(original.facility_level, u32::MAX);
    assert!((original.production_time - copy(1).production_time).abs() < 1e-9);
}

// A resident facility keeps its Aniimo all day: two Sandcastles need two Leisure Aniimo.
#[test]
fn crew_residents_take_a_whole_aniimo() {
    if load_items().is_none() {
        return;
    }
    let counts = FacilityCounts::only(&[("Tidewhisper Sandcastle", 2, 1)]);
    let sandcastles = |plan: &ExactPlan, items: &[ProductionItem]| -> u32 {
        plan.units
            .iter()
            .filter(|(name, _)| items.iter().any(|i| &i.name == *name && i.facility == "Tidewhisper Sandcastle"))
            .map(|(_, &n)| n)
            .sum()
    };
    let (one, items) = solve_with_crew(&counts, crew_of(&[(1, &[("Leisure", 2)])]));
    assert_eq!(sandcastles(&one, &items), 1);
    let (two, items) = solve_with_crew(&counts, crew_of(&[(2, &[("Leisure", 2)])]));
    assert_eq!(sandcastles(&two, &items), 2);
}

#[test]
fn leisure_work_requires_the_recipes_family_even_at_level_four() {
    use aniimax::models::{crew_variants, GrowerSteps};
    let originals = load_items().unwrap();
    let requirements = load_aniimo_requirements(Path::new("data")).unwrap();
    let mut crew = crew_of(&[(1, &[("Leisure", 4)]), (1, &[("Leisure", 4)]), (2, &[("Leisure", 4)])]);
    crew.members[0].family = Some("1035".into()); // Dewy
    crew.members[1].family = Some("1026".into()); // Nimbi
    crew.members[2].family = None;
    let steps = GrowerSteps::default();
    let items = crew_variants(originals.clone(), &crew, &requirements, &steps);
    let workers = |item: &str| items.iter().filter(|r| aniimax::models::base_item_name(&r.name) == item)
        .filter_map(|r| r.crew).collect::<Vec<_>>();
    assert_eq!(workers("aromathyst"), vec![0]);
    assert_eq!(workers("quick_aromathyst"), vec![0]);
    assert_eq!(workers("wool"), vec![1]);
    assert!(workers("petals").is_empty(), "Iris is required even in the same Nimbus Bed");
    assert!(workers("pearl").is_empty());
    let mut counts = FacilityCounts::only(&[("Nimbus Bed", 1, 3), ("Tidewhisper Sandcastle", 1, 3)]);
    counts.set_crew(crew.clone());
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!(plan.recipe_rates.keys().all(|name| name == "wool__by1" || name == "quick_wool__by1"));
    assert!(!plan.recipe_rates.is_empty());

    crew.add_reserve_workers([("Leisure", 1)], 2);
    assert_eq!(crew.members.len(), 3, "no universal Leisure reserve");
    crew.add_reserve_families(originals.iter().filter_map(|r| requirements.family(&r.name)), 2);
    assert_eq!(crew.members.len(), 10);
    assert_eq!(crew.assumed_from, Some(3));
    let assumed = crew_variants(originals, &crew, &requirements, &steps);
    for r in assumed.iter().filter(|r| r.crew.is_some()) {
        if let Some(family) = requirements.family(&r.name) {
            assert_eq!(crew.members[r.crew.unwrap()].family.as_deref(), Some(family));
        }
    }
}

fn walking_item(name: &str, facility: &str, seconds: f64, currency: &str) -> ProductionItem {
    let mut item = load_items().unwrap().into_iter().find(|r| r.name == "fresh_water").unwrap();
    item.name = name.into(); item.facility = facility.into(); item.production_time = seconds;
    item.workload = Some(seconds); item.sell_currency = currency.into(); item.sell_value = 1.0;
    item.yield_amount = 1; item.facility_level = 1; item.module_requirement = None;
    item.byproduct = None; item.environment = None; item.cost = None;
    item
}

#[test]
fn profitable_processing_uses_spare_owned_worker_time_before_selling_raw_surplus() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let mut raw = walking_item("spare_raw", "Raw Source", 1000.0, "coins");
    raw.workload = None;
    let mut processed = walking_item("spare_processed", "Spare Processor", 100.0, "coins");
    processed.raw_materials = Some(vec![raw.name.clone()]);
    processed.required_amount = Some(vec![1]);
    processed.sell_value = 30.0;
    let mut occupied = walking_item("spare_other_job", "Other Processor", 100.0, "aniimo_exp");
    occupied.raw_materials = Some(vec![]);
    occupied.required_amount = Some(vec![]);
    let mut requirements = AniimoRequirements::default();
    requirements.insert(&processed.name, "Artisanship", 1).insert(&occupied.name, "Artisanship", 1);
    for walking in [0.0, 5.0] {
        for occupied_rate in [0.005, 0.01] {
            // The same owned Aniimo has either half a day free or a full-day priority job.
            let crew = crew_of(&[(1, &[("Artisanship", 1)])]);
            let items = crew_variants(vec![raw.clone(), processed.clone(), occupied.clone()],
                &crew, &requirements, &GrowerSteps::default());
            let raw_capacity = 1.0 / items.iter().find(|item| item.name == raw.name).unwrap().production_time;
            let mut counts = FacilityCounts::only(&[("Raw Source", 1, 1), ("Spare Processor", 1, 1), ("Other Processor", 1, 1)]);
            counts.set_crew(crew); counts.set_movement_seconds(walking);
            let floors = [("aniimo_exp".into(), occupied_rate)];
            let goal = Goal::Earn { floors: &floors };
            let modules = ModuleLevels::default();
            let plan = solve_exact(&items, "coins", &counts, &modules, goal, Some(Duration::from_secs(5)), None).unwrap();
            assert!(plan.proven_optimal);
            check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
            let raw_sold = plan.sold.get(&raw.name).copied().unwrap_or(0.0);
            let processed_sold = plan.sold.get(&processed.name).copied().unwrap_or(0.0);
            if occupied_rate < 0.01 {
                assert!(raw_sold < 1e-8, "walking={walking}: spare worker must process the surplus");
                assert!((processed_sold - raw_capacity).abs() < 1e-8);
            } else {
                // Currency floors have 1e-4 relative slack; only that numerical allowance
                // can be used by another job when the main job occupies the full day.
                assert!(processed_sold <= 1.01e-6, "a full-day worker cannot also process surplus");
                assert!((raw_sold + processed_sold - raw_capacity).abs() < 1e-8);
            }
        }
    }
}

#[test]
fn idle_dedicated_posts_are_removed_together_with_idle_machines() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let first = walking_item("active_post", "Mine", 10.0, "coins");
    let second = walking_item("idle_post", "Well", 10.0, "none");
    let mut requirements = AniimoRequirements::default();
    requirements.insert(&first.name, "Fire", 1).insert(&second.name, "Fire", 1);
    let crew = crew_of(&[(2, &[("Fire", 1)])]);
    let items = crew_variants(vec![first, second], &crew, &requirements, &GrowerSteps::default());
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1), ("Well", 1, 1)]);
    counts.set_crew(crew); counts.set_movement_seconds(5.0);
    let modules = ModuleLevels::default();
    let goal = Goal::Earn { floors: &[] };
    let problem = aniimax::exact::write_lp(&items, "coins", &counts, &modules, goal);
    assert_eq!(problem.variables, 11);
    // Rate/unit pairs, sold, then dedicated/local/mobile for each workplace. The idle
    // machine and its dedicated post are feasible allocations, but perform no actual work.
    let values = [0.1, 1.0, 0.0, 1.0, 0.1, 1.0, 0.1, 0.0, 1.0, 0.0, 0.0];
    let plan = aniimax::exact::plan_from_values(&items, "coins", &counts, &modules, goal, &values, false, 0.1).unwrap();
    assert_eq!(plan.work_posts.len(), 1);
    assert!(plan.work_posts[0].0.contains("active_post"));
    assert!(!plan.units.keys().any(|name| name.contains("idle_post")));
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    let mut invalid = plan.clone();
    invalid.work_posts[0].2 = 2.0;
    assert!(check_plan(&invalid, &items, "coins", &counts, &modules, None)
        .unwrap_err().contains("dedicated workers exceed physical workplaces"));
}

#[test]
fn material_work_uses_spare_owned_artisans_before_slower_reserves() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let mut source = walking_item("artisan_wood", "Woodland", 1_000.0, "none");
    source.workload = None; source.byproduct = Some(("Wood Blocks".into(), 80));
    let mut income = walking_item("artisan_income", "Crafting Table", 100.0, "coins");
    income.raw_materials = Some(vec![]); income.required_amount = Some(vec![]);
    let mut lumber = walking_item("artisan_lumber", "Woodworking Bench", 34.0, "none");
    lumber.raw_materials = Some(vec!["wood_block".into()]); lumber.required_amount = Some(vec![8]);
    let mut planks = walking_item("artisan_planks", "Woodworking Bench", 34.0, "none");
    planks.raw_materials = Some(vec![lumber.name.clone()]); planks.required_amount = Some(vec![8]);
    let mut requirements = AniimoRequirements::default();
    requirements.insert(&income.name, "Artisanship", 4)
        .insert(&lumber.name, "Artisanship", 2).insert(&planks.name, "Artisanship", 2);
    let floors = [("coins".into(), 0.01)]; // One owned copy is fully occupied by its other job.
    let base = Goal::Earn { floors: &floors };
    let goal = Goal::MaterialWork { base: &base, minimum: None };
    let modules = ModuleLevels::default();
    for walking in [0.0, 5.0] {
        for owned in [1, 2] {
            let mut crew = crew_of(&[(owned, &[("Artisanship", 4), ("Water", 3)])]);
            crew.add_reserve_workers([("Artisanship", 2)], 4);
            let items = crew_variants(vec![source.clone(), income.clone(), lumber.clone(), planks.clone()],
                &crew, &requirements, &GrowerSteps::default());
            let mut counts = FacilityCounts::only(&[("Woodland", 1, 1), ("Crafting Table", 1, 1), ("Woodworking Bench", 2, 1)]);
            counts.set_crew(crew); counts.set_movement_seconds(walking);
            let plan = solve_exact(&items, "coins", &counts, &modules, goal, None, None).unwrap();
            check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
            for recipe in [&lumber.name, &planks.name] {
                let assigned = format!("{recipe}__by{}", if owned == 2 { 0 } else { 1 });
                assert!(plan.recipe_rates.get(&assigned).copied().unwrap_or(0.0) > 0.0,
                    "owned={owned}, walking={walking}: {recipe} allocated to {:?}", plan.recipe_rates);
            }
            assert!((plan.objective - 0.3825).abs() < 1e-6);
        }
    }
}

#[test]
fn walking_costs_shared_jobs_but_not_a_dedicated_station() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let mut requirements = AniimoRequirements::default();
    requirements.insert("walking_coins", "Earth", 1).insert("walking_exp", "Earth", 1);
    let crew = crew_of(&[(1, &[("Earth", 1)])]);
    let items = crew_variants(vec![walking_item("walking_coins", "Mine", 10.0, "coins"),
        walking_item("walking_exp", "Well", 10.0, "aniimo_exp")], &crew, &requirements, &GrowerSteps::default());
    let modules = ModuleLevels::default();
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1), ("Well", 1, 1)]);
    counts.set_crew(crew);
    let floors = [("aniimo_exp".to_string(), 0.02)];
    let goal = Goal::Earn { floors: &floors };
    let free = solve_exact(&items, "coins", &counts, &modules, goal, None, None).unwrap();
    counts.set_movement_seconds(5.0);
    let shared = solve_exact(&items, "coins", &counts, &modules, goal, None, None).unwrap();
    check_plan(&shared, &items, "coins", &counts, &modules, None).unwrap();
    assert!(shared.rate_per_second < free.rate_per_second - 0.01);
    assert!(shared.movement_staffing.iter().any(|(_, walking, _)| *walking > 0.1));
    counts.set_member_movement([(0, 0.0)].into());
    let colocated = solve_exact(&items, "coins", &counts, &modules, goal, None, None).unwrap();
    check_plan(&colocated, &items, "coins", &counts, &modules, None).unwrap();
    assert!((colocated.rate_per_second - free.rate_per_second).abs() < 1e-6);
    counts.set_member_movement([(0, 5.0)].into());
    let mut invalid = shared.clone(); invalid.work_routes.clear();
    assert!(check_plan(&invalid, &items, "coins", &counts, &modules, None).is_err());
    let dedicated = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&dedicated, &items, "coins", &counts, &modules, None).unwrap();
    assert!((dedicated.rate_per_second - 0.1).abs() < 1e-6);
    assert!(dedicated.movement_staffing.iter().all(|(_, walking, _)| *walking < 1e-8));
}

#[test]
fn two_bench_recipes_use_separate_buildings_and_require_walking() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let first = walking_item("walking_first", "Woodworking Bench", 10.0, "none");
    let mut second = walking_item("walking_second", "Woodworking Bench", 10.0, "none");
    second.raw_materials = Some(vec![first.name.clone()]); second.required_amount = Some(vec![1]);
    let mut sold = walking_item("walking_sold", "Crafting Table", 1.0, "coins");
    sold.raw_materials = Some(vec![second.name.clone()]); sold.required_amount = Some(vec![1]);
    let mut requirements = AniimoRequirements::default();
    requirements.insert(&first.name, "Artisanship", 1).insert(&second.name, "Artisanship", 1).insert(&sold.name, "Fire", 1);
    let crew = crew_of(&[(1, &[("Artisanship", 1)]), (1, &[("Fire", 1)])]);
    let items = crew_variants(vec![first, second, sold], &crew, &requirements, &GrowerSteps::default());
    let mut counts = FacilityCounts::only(&[("Woodworking Bench", 2, 1), ("Crafting Table", 1, 1)]);
    counts.set_crew(crew);
    let modules = ModuleLevels::default();
    let free = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    counts.set_movement_seconds(20.0);
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!((free.rate_per_second - 0.05).abs() < 1e-6);
    assert!(plan.rate_per_second < free.rate_per_second - 1e-6);
    assert!(plan.work_routes.iter().any(|r| r.member == 0 && r.mobile));
    assert!(plan.movement_staffing.iter().any(|(member, seconds, _)| *member == 0 && *seconds > 0.0));
}

#[test]
fn hauling_shares_the_couriers_production_time_and_is_checked() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let recipe = walking_item("courier_output", "Mine", 10.0, "coins");
    let mut requirements = AniimoRequirements::default();
    requirements.insert(&recipe.name, "Earth", 1);
    let crew = crew_of(&[(1, &[("Earth", 1), ("Hauling", 1)])]);
    let items = crew_variants(vec![recipe], &crew, &requirements, &GrowerSteps::default());
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1)]);
    counts.set_crew(crew);
    let modules = ModuleLevels::default();
    let free = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    counts.set_hauling(0.0, [("Mine|courier_output".into(), 10.0)].into());
    let delivered = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    let (_, workload) = aniimax::exact::check_plan_with_workload(&delivered, &items, "coins", &counts, &modules, None).unwrap();
    assert!((workload[0] - 0.5).abs() < 1e-6);
    assert!((delivered.rate_per_second - free.rate_per_second / 2.0).abs() < 1e-6);
    assert!((delivered.hauling_staffing[0].1 - 0.5).abs() < 1e-6);
    let mut invalid = delivered.clone(); invalid.hauling_staffing.clear();
    assert!(check_plan(&invalid, &items, "coins", &counts, &modules, None).is_err());
}

#[test]
fn delivery_work_is_assigned_to_hauling_aniimo_only() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let recipe = walking_item("courier_only", "Mine", 10.0, "coins");
    let mut requirements = AniimoRequirements::default(); requirements.insert(&recipe.name, "Earth", 1);
    let crew = crew_of(&[(1, &[("Earth", 1)]), (1, &[("Hauling", 3)])]);
    let items = crew_variants(vec![recipe], &crew, &requirements, &GrowerSteps::default());
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1)]); counts.set_crew(crew);
    counts.set_hauling(10.0, Default::default());
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!(plan.hauling_staffing.iter().all(|(member, _)| *member == 1));
    let mut invalid = plan.clone(); invalid.hauling_staffing[0].0 = 0;
    assert!(check_plan(&invalid, &items, "coins", &counts, &modules, None).is_err());
    for limit in [1, 2] {
        counts.set_power(aniimax::power::PowerPlan {
            grid: aniimax::power::Electricity { watts: 0, percent: 100, max_aniimo: Some(limit) },
            grower_steps: GrowerSteps::default(),
        });
        let limited = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
        check_plan(&limited, &items, "coins", &counts, &modules, None).unwrap();
        assert!((limited.rate_per_second - if limit == 1 { 0.0 } else { 0.1 }).abs() < 1e-6);
    }
}

#[test]
fn hauling_level_changes_delivery_capacity_under_a_shared_headcount_limit() {
    use aniimax::models::{crew_variants, AniimoRequirements, GrowerSteps};
    let recipe = walking_item("courier_levels", "Mine", 10.0, "coins");
    let mut requirements = AniimoRequirements::default(); requirements.insert(&recipe.name, "Earth", 1);
    let crew = crew_of(&[(1, &[("Earth", 1)]), (1, &[("Hauling", 1)]), (1, &[("Hauling", 3)])]);
    let items = crew_variants(vec![recipe], &crew, &requirements, &GrowerSteps::default());
    let mut counts = FacilityCounts::only(&[("Mine", 1, 1)]); counts.set_crew(crew);
    counts.set_hauling(0.0, [("Mine|courier_levels".into(), 10.0),
        ("Mine|courier_levels|1".into(), 20.0), ("Mine|courier_levels|3".into(), 10.0)].into());
    counts.set_power(aniimax::power::PowerPlan {
        grid: aniimax::power::Electricity { watts: 0, percent: 100, max_aniimo: Some(2) },
        grower_steps: GrowerSteps::default(),
    });
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!((plan.rate_per_second - 0.1).abs() < 1e-6);
    assert!(plan.hauling_staffing.iter().all(|(member, _)| *member == 2));
}

#[test]
fn crop_visits_include_walking_and_resident_leisure_workers_stay_put() {
    use aniimax::models::{crew_variants, GrowerStep, GrowerSteps, AniimoRequirements};
    let mut crop = walking_item("walking_crop", "Farmland", 10.0, "coins"); crop.workload = None;
    let mut steps = GrowerSteps::default();
    steps.insert(&crop.name, GrowerStep { step: "Watering".into(), ability: "Water".into(), min_level: 1, workload: 3.0 });
    let crew = crew_of(&[(1, &[("Water", 1)])]);
    let items = crew_variants(vec![crop], &crew, &AniimoRequirements::default(), &steps);
    let mut counts = FacilityCounts::only(&[("Farmland", 20, 1)]);
    counts.set_crew(crew); counts.set_grower_steps(steps); counts.set_movement_seconds(5.0);
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!((plan.rate_per_second - 0.125).abs() < 1e-6);
    assert!(plan.movement_staffing.iter().any(|(_, walking, _)| *walking > 0.5));

    counts = FacilityCounts::only(&[("Tidewhisper Sandcastle", 1, 1)]);
    let leisure = crew_of(&[(1, &[("Leisure", 3)])]);
    let items = crew_items(&leisure).unwrap(); counts.set_crew(leisure); counts.set_movement_seconds(300.0);
    let plan = solve_exact(&items, "coins", &counts, &modules, Goal::Earn { floors: &[] }, None, None).unwrap();
    check_plan(&plan, &items, "coins", &counts, &modules, None).unwrap();
    assert!(plan.movement_staffing.is_empty());
}
