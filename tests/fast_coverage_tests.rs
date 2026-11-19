use aniimax::coverage::tidy_layout;

#[test]
fn each_omitted_pair_has_a_selected_layout_covering_the_same_eligible_plots() {
    use aniimax::coverage::{pair_options_over_offsets, PairOption, PairSizes};
    use aniimax::data::load_all_data;
    use aniimax::exact::{write_lp, Goal};
    use aniimax::models::{FacilityCounts,ModuleLevels};

    let mut items = load_all_data(std::path::Path::new("data")).unwrap();
    // One Warm tree, one Cool crop, and two Freeze crops can be planted.
    // The Cool recipe requires level 2 and only one farm meets that bar.
    items.retain(|r| matches!((r.facility.as_str(),r.environment.as_deref()),
        ("Woodland",Some("Warm")) | ("Farmland",Some("Cool"|"Freeze"))));
    for item in &mut items {
        item.facility_level = if item.environment.as_deref()==Some("Cool") { 2 } else { 1 };
        item.module_requirement = None;
    }
    let mut counts = FacilityCounts::only(&[("Woodland",1,1),("Heat Furnace",1,1),("Cooling Unit",1,1)]);
    counts.set_tiers("Farmland",vec![(1,1),(1,2)]);
    let model = write_lp(&items,"coins",&counts,&ModuleLevels::default(),Goal::Earn{floors:&[]});
    let keys: std::collections::HashSet<_> = model.variable_keys.into_iter().collect();
    let types = ["Woodland","Farmland"];
    let layouts = pair_options_over_offsets(PairSizes::of("Heat Furnace","Cooling Unit"),&types);
    let selected: Vec<_> = layouts.iter().filter(|o| {
        keys.contains(&format!("pair:{:?}:{:?}:{types:?}:{o:?}#0",("Heat Furnace","Cooling Unit"),("Warm","Freeze")))
    }).collect();
    assert!(!selected.is_empty() && selected.len()*10<layouts.len());
    let coverage = |o: &PairOption| [o.counts[0][0].min(1), o.counts[1][1].min(1), o.counts[2][1].min(2)];
    for original in &layouts {
        let wanted = coverage(original);
        assert!(selected.iter().any(|choice| coverage(choice).iter().zip(wanted).all(|(have,need)| *have>=need)));
    }
}

#[test]
fn fast_tidy_grids_preserve_counts_and_physical_placements() {
    for building in [2.0,3.0] {
        for counts in [vec![("Farmland".to_string(),8)],vec![("Woodland".to_string(),4)],
            vec![("Farmland".to_string(),6),("Woodland".to_string(),2)]] {
            let placements=tidy_layout(building,&counts).expect("valid compact grid");
            for (facility,count) in &counts {
                assert_eq!(placements.iter().filter(|p|&p.facility==facility).count(),*count as usize);
            }
            for (i,p) in placements.iter().enumerate() {
                assert!(p.x.is_finite() && p.y.is_finite());
                assert!(!(p.x<building && p.x+p.size>0.0 && p.y<building && p.y+p.size>0.0),"plot overlaps its environment building");
                for q in &placements[i+1..] {
                    assert!(!(p.x<q.x+q.size-1e-6 && p.x+p.size>q.x+1e-6 && p.y<q.y+q.size-1e-6 && p.y+p.size>q.y+1e-6),"plots overlap");
                }
            }
        }
    }
}
