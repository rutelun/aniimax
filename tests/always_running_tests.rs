use aniimax::data::load_all_data;
use aniimax::exact::{solve_exact, Goal};
use aniimax::models::{FacilityCounts,ModuleLevels,ProductionItem};
use std::{path::Path,time::Duration};
fn item(name:&str, facility:&str, seconds:f64, currency:&str)->ProductionItem {
 let mut r=load_all_data(Path::new("data")).unwrap().into_iter().find(|r|r.name=="fresh_water").unwrap();
 r.name=name.into();r.facility=facility.into();r.production_time=seconds;r.workload=Some(seconds);
 r.sell_currency=currency.into();r.sell_value=1.;r.yield_amount=1;r.facility_level=1;r.module_requirement=None;
 r.raw_materials=None;r.required_amount=None;r.byproduct=None;r.environment=None;r.cost=None;r.crew=None;r
}
fn competing(supply:f64)->(Vec<ProductionItem>,FacilityCounts){
 let water=item("water","Source",1./supply,"none");
 let mut fast=item("fast","Fast",1.,"coins");let mut slow=item("slow","Slow",2.,"tokens");
 for r in [&mut fast,&mut slow]{r.raw_materials=Some(vec!["water".into()]);r.required_amount=Some(vec![1]);}
 let mut counts=FacilityCounts::only(&[("Source",1,1),("Fast",1,1),("Slow",1,1)]);counts.set_always_running(true);
 (vec![water,fast,slow],counts)
}
#[test] fn shared_water_follows_attempt_frequency_not_coin_priority(){
 let (items,counts)=competing(1.);let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-2./3.).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-1./3.).abs()<1e-6);
}
#[test] fn more_upstream_supply_runs_both_recipes_at_full_speed(){
 let (items,counts)=competing(2.);let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-1.).abs()<1e-6);
 assert!((p.recipe_rates["slow"]-0.5).abs()<1e-6,"{:?}",p.recipe_rates);
}
#[test] fn competing_jobs_share_the_available_worker_time() {
 let (mut items,mut counts)=competing(10.);
 items[1].crew=Some(0);items[2].crew=Some(0);
 let crew=aniimax::models::Crew{assumed_from:None,members:vec![aniimax::models::RosterAniimo{count:1,..Default::default()}],residents:Default::default(),environment:Default::default(),personalities:Default::default()};
 counts.set_crew(crew);
 let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-0.5).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-0.25).abs()<1e-6);
}
#[test] fn lower_upstream_production_reduces_both_consumers_together(){
 let (items,counts)=competing(0.5);let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-1./3.).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-1./6.).abs()<1e-6);
}

#[test] fn another_missing_ingredient_limits_only_its_consumer() {
 let (mut items,_)=competing(1.);
 let other=item("other","Other",10.,"none");
 items[2].raw_materials.as_mut().unwrap().push("other".into());
 items[2].required_amount.as_mut().unwrap().push(1);
 items.push(other);
 let mut counts=FacilityCounts::only(&[("Source",1,1),("Other",1,1),("Fast",1,1),("Slow",1,1)]);
 counts.set_always_running(true);
 let floors=vec![("tokens".into(),0.05)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["slow"]-0.1).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["fast"]-0.9).abs()<1e-6,"{:?}",p.recipe_rates);
}

#[test] fn legacy_relaxation_remains_an_upper_bound_not_the_executable_plan() {
 let (items,mut counts)=competing(1.);
 counts.set_always_running(false);
 let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-0.9).abs()<2e-5,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-0.1).abs()<2e-5,"{:?}",p.recipe_rates);
}

#[test] fn multiple_buildings_increase_their_share_of_attempts() {
 let (items,_)=competing(1.);
 let mut counts=FacilityCounts::only(&[("Source",1,1),("Fast",2,1),("Slow",1,1)]);
 counts.set_always_running(true);
 let floors=vec![("tokens".into(),0.1)];
 let p=solve_exact(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-0.8).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-0.2).abs()<1e-6);
}

#[test]
fn shared_facility_capacity_preserves_two_concurrent_recipes() {
    let (mut items, _) = competing(1.0);
    items[1].facility = "Workshop".into();
    items[2].facility = "Workshop".into();
    let mut counts = FacilityCounts::only(&[("Source",1,1),("Workshop",2,1)]);
    counts.set_always_running(true);
    let floors = vec![("tokens".into(),0.1)];
    let modules = ModuleLevels::default();
    let plan = solve_exact(&items,"coins",&counts,&modules,Goal::Earn{floors:&floors},
        Some(Duration::from_secs(10)),None).unwrap();
    assert!((plan.recipe_rates["fast"] - 2.0/3.0).abs() < 1e-6);
    assert!((plan.recipe_rates["slow"] - 1.0/3.0).abs() < 1e-6);
    aniimax::exact::check_plan(&plan,&items,"coins",&counts,&modules,None).unwrap();
}

#[test] fn dispatch_retains_whole_sites_and_shared_resource_competition() {
 use aniimax::models::{Crew,RosterAniimo,DispatchAssignment};
 let (mut items,mut counts)=competing(1.);
 items[1].crew=Some(0);items[2].crew=Some(1);
 counts.set_crew(Crew{members:vec![RosterAniimo{count:1,..Default::default()};2],
   assumed_from:None,residents:Default::default(),environment:Default::default(),personalities:Default::default()});
 counts.set_dispatch([
   ("Fast|fast|Production".into(),vec![DispatchAssignment{member:0,share:1.,travel_seconds:0.}]),
   ("Slow|slow|Production".into(),vec![DispatchAssignment{member:1,share:1.,travel_seconds:0.}]),
 ].into_iter().collect(),&items);
 let floors=vec![("tokens".into(),0.1)];
 let modules=ModuleLevels::default();
 let p=solve_exact(&items,"coins",&counts,&modules,Goal::Earn{floors:&floors},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["fast"]-2./3.).abs()<1e-6,"{:?}",p.recipe_rates);
 assert!((p.recipe_rates["slow"]-1./3.).abs()<1e-6);
 assert_eq!(p.continuous_sites["Fast|fast"],1);
 aniimax::exact::check_plan(&p,&items,"coins",&counts,&modules,None).unwrap();
}

#[test] fn a_separate_busy_courier_limits_upstream_production() {
 use aniimax::models::{Crew,RosterAniimo};
 let mut source=item("cargo","Source",1.,"coins");source.crew=Some(0);
 let mut counts=FacilityCounts::only(&[("Source",1,1)]);
 counts.set_always_running(true);
 counts.set_crew(Crew{members:vec![RosterAniimo{count:1,..Default::default()},
   RosterAniimo{count:1,abilities:[("Hauling".into(),3)].into_iter().collect(),..Default::default()}],
   assumed_from:None,residents:Default::default(),environment:Default::default(),personalities:Default::default()});
 counts.set_hauling(2.,Default::default());
 let modules=ModuleLevels::default();
 let p=solve_exact(&[source.clone()],"coins",&counts,&modules,Goal::Earn{floors:&[]},Some(Duration::from_secs(10)),None).unwrap();
 assert!((p.recipe_rates["cargo"]-0.5).abs()<1e-6,"{:?}",p.recipe_rates);
 aniimax::exact::check_plan(&p,&[source],"coins",&counts,&modules,None).unwrap();
}
