use aniimax::coverage::tidy_layout;

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
