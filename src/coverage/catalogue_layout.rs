use super::{
    baked_single_coverage, building_rect, coverage_rect, distance_to_building, facility_footprint,
    placements_overlap, Placement, Rect, ALIGN_REWARD, GRID_STEP, OVERHANG_COST,
};

/// Reuse a feasible single-building packing for mixed requests. Buildings with
/// identical footprints are interchangeable when choosing drawing coordinates.
pub(super) fn catalogue_layout(building: f64, counts: &[(String, u32)]) -> Option<Vec<Placement>> {
    let coverage = coverage_rect(building);
    let position_cost = |plot: &Placement| {
        let footprint = Rect::new(plot.x, plot.y, plot.size);
        distance_to_building(building, plot)
            + OVERHANG_COST
                * (footprint.area() - footprint.meet(&coverage).map_or(0.0, |r| r.area()))
    };
    let touches = |a: &Placement, b: &Placement| {
        a.size == b.size
            && ((a.x == b.x && (a.y - b.y).abs() == a.size)
                || (a.y == b.y && (a.x - b.x).abs() == a.size))
    };
    let score = |plots: &[Placement]| {
        plots
            .iter()
            .enumerate()
            .map(|(i, p)| {
                position_cost(p)
                    - ALIGN_REWARD * plots[..i].iter().filter(|q| touches(p, q)).count() as f64
            })
            .sum::<f64>()
    };
    let mut needed = std::collections::BTreeMap::<u64, u64>::new();
    for (facility, count) in counts {
        let size = facility_footprint(facility)?.to_bits();
        *needed.entry(size).or_default() += u64::from(*count);
    }
    let wanted = needed.values().sum::<u64>();
    let mut starts = Vec::new();
    let mut tables: Vec<_> = baked_single_coverage()
        .iter()
        .filter(|((size, _), _)| *size == building.to_bits())
        .collect();
    tables.sort_by(|a, b| a.0.cmp(b.0));
    for (_, options) in tables {
        for option in options {
            if (option.layout.len() as u64) < wanted {
                continue;
            }
            let mut chosen = Vec::new();
            for (&size, &n) in &needed {
                let mut places: Vec<_> = option
                    .layout
                    .iter()
                    .filter(|p| p.size.to_bits() == size)
                    .collect();
                if (places.len() as u64) < n {
                    break;
                }
                places.sort_by(|a, b| position_cost(a).total_cmp(&position_cost(b)));
                let labels = counts
                    .iter()
                    .filter(|(name, _)| facility_footprint(name) == Some(f64::from_bits(size)))
                    .flat_map(|(name, count)| std::iter::repeat_n(name, *count as usize));
                chosen.extend(labels.zip(places).map(|(name, p)| Placement {
                    facility: name.clone(),
                    ..p.clone()
                }));
            }
            if chosen.len() as u64 == wanted && !starts.iter().any(|(_, other)| other == &chosen) {
                starts.push((score(&chosen), chosen));
            }
        }
    }
    starts.sort_by(|(a, _), (b, _)| a.total_cmp(b));
    if starts.is_empty() {
        return None;
    }
    // On the fixed quarter grid, a single-plot move can improve contact and
    // coverage without changing the set of plots or using additional space.
    let mut positions = std::collections::BTreeMap::<u64, Vec<(f64, Placement)>>::new();
    for &size in needed.keys() {
        let size = f64::from_bits(size);
        let lo = ((coverage.x1 - size) / GRID_STEP).ceil() as i32;
        let hi = (coverage.x2 / GRID_STEP).floor() as i32;
        let mut candidates = Vec::new();
        for x in lo..=hi {
            for y in lo..=hi {
                let spot = Placement {
                    facility: String::new(),
                    x: x as f64 * GRID_STEP,
                    y: y as f64 * GRID_STEP,
                    size,
                };
                let rect = Rect::new(spot.x, spot.y, size);
                if rect.overlaps(&coverage) && !rect.overlaps(&building_rect(building)) {
                    candidates.push((position_cost(&spot), spot));
                }
            }
        }
        candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
        positions.insert(size.to_bits(), candidates);
    }
    starts
        .into_iter()
        .take(4)
        .map(|(_, mut layout)| {
            loop {
                let mut moved = false;
                for i in 0..layout.len() {
                    let old = &layout[i];
                    let mut current = position_cost(old)
                        - ALIGN_REWARD * layout.iter().filter(|p| touches(old, p)).count() as f64;
                    let mut next = (old.x, old.y);
                    for (cost, spot) in &positions[&old.size.to_bits()] {
                        // A square can meet at most four equal squares edge to edge.
                        if *cost - 4.0 * ALIGN_REWARD >= current - 1e-8 {
                            break;
                        }
                        let mut contacts = 0;
                        let mut fits = true;
                        for (j, p) in layout.iter().enumerate() {
                            if i == j {
                                continue;
                            }
                            if placements_overlap(spot, p) {
                                fits = false;
                                break;
                            }
                            if touches(spot, p) {
                                contacts += 1;
                            }
                        }
                        if fits && *cost - ALIGN_REWARD * (contacts as f64) < current - 1e-8 {
                            current = *cost - ALIGN_REWARD * contacts as f64;
                            next = (spot.x, spot.y);
                        }
                    }
                    if next != (old.x, old.y) {
                        (layout[i].x, layout[i].y) = next;
                        moved = true;
                    }
                }
                if !moved {
                    break;
                }
            }
            (score(&layout), layout)
        })
        .min_by(|(a, _), (b, _)| a.total_cmp(b))
        .map(|(_, layout)| layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_catalogue_layouts_cover_the_exact_requested_facilities() {
        for requested in [
            vec![("Farmland", 12), ("Woodland", 6)],
            vec![("Farmland", 7), ("Woodland", 3), ("Floral Windmill", 1)],
            vec![
                ("Dewy House", 3),
                ("Farmland", 4),
                ("Woodland", 3),
                ("Starfall Hammock", 1),
            ],
        ] {
            let counts: Vec<_> = requested
                .iter()
                .map(|(name, n)| (name.to_string(), *n))
                .collect();
            let plots = catalogue_layout(1.0, &counts).expect("catalogue covers these plots");
            for (name, n) in requested {
                assert_eq!(
                    plots.iter().filter(|p| p.facility == name).count(),
                    n as usize
                );
            }
            for (i, p) in plots.iter().enumerate() {
                let rect = Rect::new(p.x, p.y, p.size);
                assert_eq!(Some(p.size), facility_footprint(&p.facility));
                assert!(rect.overlaps(&coverage_rect(1.0)));
                assert!(!rect.overlaps(&building_rect(1.0)));
                assert!(plots[..i].iter().all(|q| !placements_overlap(p, q)));
            }
        }
    }
}
