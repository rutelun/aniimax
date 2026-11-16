//! Bounded, deterministic layout refinement. Temporary overlaps are search states,
//! never results: only complete feasible incumbents are retained. This is a
//! heuristic, not an optimality certificate.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Default)]
struct Pose {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}
impl Pose {
    fn cx(self) -> f64 {
        self.x + self.w / 2.0
    }
    fn cy(self) -> f64 {
        self.y + self.h / 2.0
    }
    fn area(self, b: Self) -> f64 {
        if !self.hits(b) {
            return 0.0;
        }
        (self.x + self.w)
            .min(b.x + b.w)
            .sub(self.x.max(b.x))
            .max(0.0)
            * (self.y + self.h)
                .min(b.y + b.h)
                .sub(self.y.max(b.y))
                .max(0.0)
    }
    fn hits(self, b: Self) -> bool {
        self.x < b.x + b.w && b.x < self.x + self.w && self.y < b.y + b.h && b.y < self.y + self.h
    }
    fn climate(self) -> Self {
        Self {
            x: self.cx() - 4.5,
            y: self.cy() - 4.5,
            w: 9.0,
            h: 9.0,
        }
    }
    fn valid(self) -> bool {
        [self.x, self.y, self.w, self.h]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= 1_000_000.0 && (v * 4.0).fract() == 0.0)
            && self.w > 0.0
            && self.h > 0.0
    }
}
use std::ops::Sub;
fn minus_one() -> i32 {
    -1
}
#[derive(Clone, Deserialize)]
struct Rectangle {
    #[serde(flatten)]
    p: Pose,
    #[serde(default)]
    weight: f64,
    #[serde(default = "minus_one")]
    owner: i32,
    #[serde(default)]
    zone: u8,
    #[serde(default)]
    sensitive: bool,
    #[serde(default)]
    generator: bool,
    #[serde(default)]
    pole: bool,
    #[serde(default)]
    electric: bool,
    #[serde(default)]
    movable: bool,
}
fn iterations_default() -> usize {
    2_000_000
}
fn seed_default() -> u32 {
    1
}
fn temperature_default() -> f64 {
    1.0
}
fn penalty_default() -> f64 {
    30.0
}
fn true_default() -> bool {
    true
}
#[derive(Deserialize)]
struct Input {
    rectangles: Vec<Rectangle>,
    cells: Vec<Pose>,
    producer_count: usize,
    store_count: usize,
    #[serde(default)]
    climates: Vec<Vec<usize>>,
    #[serde(default = "iterations_default")]
    iterations: usize,
    #[serde(default = "seed_default")]
    seed: u32,
    #[serde(default = "temperature_default")]
    temperature: f64,
    #[serde(default = "penalty_default")]
    penalty: f64,
    #[serde(default = "true_default")]
    mobile_relays: bool,
    #[serde(default)]
    unequal_swaps: bool,
    #[serde(default)]
    polish_passes: u32,
    #[serde(default)]
    exchange_trials: u32,
}
#[derive(Serialize)]
struct Output {
    poses: Vec<[f64; 4]>,
    cost: f64,
    initial_cost: f64,
    iterations: usize,
}

struct Land {
    left: i32,
    top: i32,
    width: usize,
    height: usize,
    prefix: Vec<u32>,
}
impl Land {
    fn new(cells: &[Pose]) -> Result<Self, String> {
        if cells.is_empty() || cells.iter().any(|r| !r.valid()) {
            return Err("Invalid land geometry".into());
        }
        let left = cells.iter().map(|r| (r.x * 4.0) as i32).min().unwrap();
        let top = cells.iter().map(|r| (r.y * 4.0) as i32).min().unwrap();
        let right = cells
            .iter()
            .map(|r| ((r.x + r.w) * 4.0) as i32)
            .max()
            .unwrap();
        let bottom = cells
            .iter()
            .map(|r| ((r.y + r.h) * 4.0) as i32)
            .max()
            .unwrap();
        let width = (right as i64 - left as i64) as usize;
        let height = (bottom as i64 - top as i64) as usize;
        if width == 0 || height == 0 || width.checked_mul(height).unwrap_or(usize::MAX) > 1_000_000
        {
            return Err("Land grid exceeds refinement limit".into());
        }
        let mut covered = vec![false; width * height];
        for r in cells {
            let x = (r.x * 4.0) as i32 - left;
            let y = (r.y * 4.0) as i32 - top;
            for yy in y..y + (r.h * 4.0) as i32 {
                for xx in x..x + (r.w * 4.0) as i32 {
                    covered[yy as usize * width + xx as usize] = true;
                }
            }
        }
        let stride = width + 1;
        let mut prefix = vec![0; stride * (height + 1)];
        for y in 0..height {
            let mut count = 0;
            for x in 0..width {
                count += u32::from(covered[y * width + x]);
                prefix[(y + 1) * stride + x + 1] = prefix[y * stride + x + 1] + count;
            }
        }
        Ok(Self {
            left,
            top,
            width,
            height,
            prefix,
        })
    }
    #[inline]
    fn inside(&self, r: Pose) -> bool {
        let x = (r.x * 4.0) as i32 - self.left;
        let y = (r.y * 4.0) as i32 - self.top;
        let w = (r.w * 4.0) as usize;
        let h = (r.h * 4.0) as usize;
        if x < 0 || y < 0 || x as usize + w > self.width || y as usize + h > self.height {
            return false;
        }
        let x = x as usize;
        let y = y as usize;
        let s = self.width + 1;
        self.prefix[(y + h) * s + x + w] + self.prefix[y * s + x]
            - self.prefix[y * s + x + w]
            - self.prefix[(y + h) * s + x]
            == (w * h) as u32
    }
}

struct Occupancy {
    left: i32,
    top: i32,
    cols: usize,
    words: usize,
    grid: Vec<u32>,
    mask: Vec<u32>,
}
impl Occupancy {
    fn new(cells: &[Pose], count: usize) -> Self {
        let left = cells
            .iter()
            .map(|c| (c.x / 4.0).floor() as i32)
            .min()
            .unwrap()
            - 2;
        let top = cells
            .iter()
            .map(|c| (c.y / 4.0).floor() as i32)
            .min()
            .unwrap()
            - 2;
        let cols = (cells
            .iter()
            .map(|c| ((c.x + c.w) / 4.0).ceil() as i32)
            .max()
            .unwrap()
            - left
            + 2) as usize;
        let rows = (cells
            .iter()
            .map(|c| ((c.y + c.h) / 4.0).ceil() as i32)
            .max()
            .unwrap()
            - top
            + 2) as usize;
        let words = (count + 31) / 32;
        Self {
            left,
            top,
            cols,
            words,
            grid: vec![0; cols * rows * words],
            mask: vec![0; words],
        }
    }
    fn index(&mut self, i: usize, r: Pose, add: bool) {
        let bit = 1u32 << (i % 32);
        let word = i / 32;
        for yy in (r.y / 4.0).floor() as i32..=((r.y + r.h - 1e-7) / 4.0).floor() as i32 {
            for xx in (r.x / 4.0).floor() as i32..=((r.x + r.w - 1e-7) / 4.0).floor() as i32 {
                let at = (((yy - self.top) as usize) * self.cols + (xx - self.left) as usize)
                    * self.words
                    + word;
                if add {
                    self.grid[at] |= bit;
                } else {
                    self.grid[at] &= !bit;
                }
            }
        }
    }
    fn nearby_area(&mut self, poses: &[Pose], i: usize, j: usize) -> f64 {
        let r = poses[i];
        self.mask.fill(0);
        for yy in (r.y / 4.0).floor() as i32..=((r.y + r.h - 1e-7) / 4.0).floor() as i32 {
            for xx in (r.x / 4.0).floor() as i32..=((r.x + r.w - 1e-7) / 4.0).floor() as i32 {
                let at = (((yy - self.top) as usize) * self.cols + (xx - self.left) as usize)
                    * self.words;
                for word in 0..self.words {
                    self.mask[word] |= self.grid[at + word];
                }
            }
        }
        let mut sum = 0.0;
        for word in 0..self.words {
            let mut bits = self.mask[word];
            while bits != 0 {
                let k = word * 32 + bits.trailing_zeros() as usize;
                bits &= bits - 1;
                if k != i && k != j {
                    sum += r.area(poses[k]);
                }
            }
        }
        sum
    }
    fn changed_area(&mut self, poses: &[Pose], i: usize, j: Option<usize>) -> f64 {
        self.nearby_area(poses, i, j.unwrap_or(usize::MAX))
            + j.map_or(0.0, |j| {
                self.nearby_area(poses, j, i) + poses[i].area(poses[j])
            })
    }
}

struct Search {
    input: Input,
    poses: Vec<Pose>,
    land: Land,
    source_owner: Vec<Option<usize>>,
    movable: Vec<usize>,
    relays: Vec<usize>,
    electric: Vec<usize>,
    radius: Vec<f64>,
    reached: Vec<bool>,
    queue: Vec<usize>,
    rng: u32,
}
impl Search {
    #[inline]
    fn random(&mut self) -> f64 {
        self.rng = self.rng.wrapping_mul(1664525).wrapping_add(1013904223);
        self.rng as f64 / 4294967296.0
    }
    #[inline]
    fn cost(&self, i: usize) -> f64 {
        let weight = self.input.rectangles[i].weight;
        if weight == 0.0 {
            return 0.0;
        }
        let r = self.poses[i];
        let mut nearest = f64::INFINITY;
        for s in &self.poses
            [self.input.producer_count..self.input.producer_count + self.input.store_count]
        {
            let dx = r.cx() - s.cx();
            let dy = r.cy() - s.cy();
            nearest = nearest.min(dx * dx + dy * dy);
        }
        weight * nearest.sqrt()
    }
    fn total_cost(&self) -> f64 {
        if self.input.store_count == 0 {
            return 0.0;
        }
        (0..self.input.producer_count).map(|i| self.cost(i)).sum()
    }
    #[inline]
    fn covers(&self, a: usize, b: usize) -> bool {
        let x = self.poses[a];
        let y = self.poses[b];
        (x.cx() - y.cx()).abs() <= self.radius[a] + y.w / 2.0 - 0.25 + 1e-7
            && (x.cy() - y.cy()).abs() <= self.radius[a] + y.h / 2.0 - 0.25 + 1e-7
    }
    fn network_valid(&mut self) -> bool {
        if self.relays.is_empty() {
            return self.electric.is_empty();
        }
        self.reached.fill(false);
        self.reached[0] = true;
        self.queue[0] = 0;
        let mut tail = 1;
        let mut head = 0;
        while head < tail {
            for j in 0..self.relays.len() {
                if !self.reached[j]
                    && (self.covers(self.relays[self.queue[head]], self.relays[j])
                        || self.covers(self.relays[j], self.relays[self.queue[head]]))
                {
                    self.reached[j] = true;
                    self.queue[tail] = j;
                    tail += 1;
                }
            }
            head += 1;
        }
        tail == self.relays.len()
            && self
                .electric
                .iter()
                .all(|&i| self.relays.iter().any(|&r| self.covers(r, i)))
    }
    fn valid_position(&self, i: usize) -> bool {
        let r = self.poses[i];
        let meta = &self.input.rectangles[i];
        if !self.land.inside(r) {
            return false;
        }
        if meta.electric && !self.relays.iter().any(|&a| self.covers(a, i)) {
            return false;
        }
        if meta.owner >= 0 {
            let src = &self.input.climates[meta.owner as usize];
            let a = r.hits(self.poses[src[0]].climate());
            let b = src.len() > 1 && r.hits(self.poses[src[1]].climate());
            let good = if src.len() == 1 {
                a
            } else {
                match meta.zone {
                    0 => a && !b,
                    1 => a && b,
                    _ => !a && b,
                }
            };
            if !good {
                return false;
            }
        }
        if meta.owner >= 0 || meta.sensitive {
            for (k, group) in self.input.climates.iter().enumerate() {
                if k as i32 != meta.owner && group.iter().any(|&s| r.hits(self.poses[s].climate()))
                {
                    return false;
                }
            }
        }
        true
    }
    fn valid_source(&self, i: usize) -> bool {
        let Some(ci) = self.source_owner[i] else {
            return true;
        };
        for &s in &self.input.climates[ci] {
            for (k, group) in self.input.climates.iter().enumerate() {
                if k != ci
                    && group
                        .iter()
                        .any(|&b| self.poses[s].climate().hits(self.poses[b].climate()))
                {
                    return false;
                }
            }
        }
        for k in 0..self.input.producer_count {
            let m = &self.input.rectangles[k];
            if (m.owner >= 0 || m.sensitive) && !self.valid_position(k) {
                return false;
            }
        }
        true
    }
    fn run(&mut self) -> Output {
        let initial = self.total_cost();
        let mut current = initial;
        let mut best = initial;
        let mut overlaps = 0.0;
        let mut best_poses = self.poses.clone();
        let iterations = self.input.iterations;
        if self.input.store_count == 0 || self.movable.is_empty() {
            return self.output(initial, initial, 0);
        }
        let mut grid = Occupancy::new(&self.input.cells, self.poses.len());
        for (i, &r) in self.poses.iter().enumerate() {
            grid.index(i, r, true);
        }
        let mut cost_cache: Vec<f64> = (0..self.poses.len()).map(|i| self.cost(i)).collect();
        let producer_count = self.input.producer_count;
        let store_end = producer_count + self.input.store_count;
        let snap = |v: f64| (v + 0.5).floor();
        for step in 0..iterations {
            let i = if self.input.mobile_relays && !self.relays.is_empty() && self.random() < 0.03 {
                let k = (self.random() * self.relays.len() as f64) as usize;
                self.relays[k]
            } else {
                let k = (self.random() * self.movable.len() as f64) as usize;
                self.movable[k]
            };
            let mut j = None;
            if self.random() < 0.12 {
                let k = (self.random() * self.movable.len() as f64) as usize;
                let other = self.movable[k];
                if i == other
                    || self.radius[i] > 0.0
                    || self.source_owner[i].is_some()
                    || self.source_owner[other].is_some()
                    || (!self.input.unequal_swaps
                        && (self.poses[i].w != self.poses[other].w
                            || self.poses[i].h != self.poses[other].h))
                {
                    continue;
                }
                j = Some(other);
            }
            let paired =
                self.source_owner[i].map_or(false, |ci| self.input.climates[ci].len() == 2);
            if paired {
                j = Some(self.input.climates[self.source_owner[i].unwrap()][1]);
            }
            let old = self.poses[i];
            let other = j.map(|k| self.poses[k]);
            let store_move = (i >= producer_count && i < store_end)
                || j.map_or(false, |j| j >= producer_count && j < store_end);
            if let Some(j) = j.filter(|_| !paired) {
                let p = self.poses[j];
                self.poses[i].x = p.x;
                self.poses[i].y = p.y;
                self.poses[j].x = old.x;
                self.poses[j].y = old.y;
                if self.input.unequal_swaps {
                    self.poses[i].x = 0.25 * snap(4.0 * (p.cx() - old.w / 2.0));
                    self.poses[i].y = 0.25 * snap(4.0 * (p.cy() - old.h / 2.0));
                    self.poses[j].x = 0.25 * snap(4.0 * (old.cx() - p.w / 2.0));
                    self.poses[j].y = 0.25 * snap(4.0 * (old.cy() - p.h / 2.0));
                }
            } else {
                let ordinary = j.is_none()
                    && self.source_owner[i].is_none()
                    && self.input.rectangles[i].owner < 0
                    && i < producer_count;
                if ordinary && old.w != old.h && self.random() < 0.12 {
                    self.poses[i].w = old.h;
                    self.poses[i].h = old.w;
                } else if ordinary && self.random() < 0.08 {
                    if self.input.rectangles[i].weight == 0.0 {
                        let ci = (self.random() * self.input.cells.len() as f64) as usize;
                        let c = self.input.cells[ci];
                        self.poses[i].x = 0.25 * snap((c.x + self.random() * (c.w - old.w)) * 4.0);
                        self.poses[i].y = 0.25 * snap((c.y + self.random() * (c.h - old.h)) * 4.0);
                    } else {
                        let s = producer_count
                            + (self.random() * self.input.store_count as f64) as usize;
                        let p = self.poses[s];
                        self.poses[i].x = 0.25
                            * snap(
                                (p.cx() - old.w / 2.0 + (self.random() * 2.0 - 1.0) * 8.0) * 4.0,
                            );
                        self.poses[i].y = 0.25
                            * snap(
                                (p.cy() - old.h / 2.0 + (self.random() * 2.0 - 1.0) * 8.0) * 4.0,
                            );
                    }
                } else {
                    let scale = if self.random() < 0.8 { 1.0 } else { 4.0 };
                    self.poses[i].x += 0.25 * snap((self.random() * 2.0 - 1.0) * scale * 4.0);
                    self.poses[i].y += 0.25 * snap((self.random() * 2.0 - 1.0) * scale * 4.0);
                }
                if paired {
                    let j = j.unwrap();
                    self.poses[j].x += self.poses[i].x - old.x;
                    self.poses[j].y += self.poses[i].y - old.y;
                }
            }
            let mut accepted = false;
            if self.valid_source(i)
                && self.valid_position(i)
                && j.map_or(true, |j| self.valid_position(j))
                && (self.radius[i] == 0.0 || self.network_valid())
            {
                // Most proposals fail coverage or land constraints. Defer the
                // collision and distance work until those cheap checks pass.
                // Quarter-grid overlap areas are exact multiples of 1/16.
                // A feasible current state has no old collisions to rescan.
                let old_overlap = if overlaps == 0.0 {
                    0.0
                } else {
                    let proposed = self.poses[i];
                    let proposed_other = j.map(|k| self.poses[k]);
                    self.poses[i] = old;
                    if let Some(j) = j {
                        self.poses[j] = other.unwrap();
                    }
                    let area = grid.changed_area(&self.poses, i, j);
                    self.poses[i] = proposed;
                    if let Some(j) = j {
                        self.poses[j] = proposed_other.unwrap();
                    }
                    area
                };
                let old_cost = if store_move {
                    current
                } else {
                    cost_cache[i] + j.map_or(0.0, |k| cost_cache[k])
                };
                let new_overlap = grid.changed_area(&self.poses, i, j);
                let next_cost = if store_move {
                    self.total_cost()
                } else {
                    self.cost(i) + j.map_or(0.0, |j| self.cost(j))
                };
                let dc = next_cost - old_cost;
                let da = new_overlap - old_overlap;
                let phase = step as f64 / iterations as f64;
                let temp = (self.input.temperature * (1.0 - phase).powi(3)).max(0.005);
                let delta = dc + self.input.penalty * da;
                let accept = if delta <= 0.0 {
                    true
                } else {
                    let roll = self.random();
                    let scaled = delta / temp;
                    // RNG has 32 bits: probabilities below 2^-32 cannot beat
                    // a positive draw. Preserve the zero draw and RNG stream.
                    if scaled > 22.18070977791825 && roll > 0.0 {
                        false
                    } else {
                        roll < (-scaled).exp()
                    }
                };
                if accept {
                    if store_move {
                        for k in 0..self.poses.len() {
                            cost_cache[k] = self.cost(k);
                        }
                    } else {
                        cost_cache[i] = self.cost(i);
                        if let Some(j) = j {
                            cost_cache[j] = self.cost(j);
                        }
                    }
                    grid.index(i, old, false);
                    if let Some(j) = j {
                        grid.index(j, other.unwrap(), false);
                    }
                    grid.index(i, self.poses[i], true);
                    if let Some(j) = j {
                        grid.index(j, self.poses[j], true);
                    }
                    current += dc;
                    overlaps += da;
                    accepted = true;
                    if overlaps < 1e-8 && current < best - 1e-8 {
                        best = current;
                        best_poses.copy_from_slice(&self.poses);
                    }
                }
            }
            if !accepted {
                self.poses[i] = old;
                if let Some(j) = j {
                    self.poses[j] = other.unwrap();
                }
            }
        }
        self.poses = best_poses;
        self.exchange();
        self.polish();
        self.output(initial, self.total_cost(), iterations)
    }
    fn exchange(&mut self) {
        let mut budget = self.input.exchange_trials;
        if budget == 0 {
            return;
        }
        let mut grid = Occupancy::new(&self.input.cells, self.poses.len());
        for (i, &r) in self.poses.iter().enumerate() {
            grid.index(i, r, true);
        }
        let mut order: Vec<_> = self
            .movable
            .iter()
            .copied()
            .filter(|&i| {
                i < self.input.producer_count
                    && self.source_owner[i].is_none()
                    && self.radius[i] == 0.0
                    && self.input.rectangles[i].weight > 0.0
            })
            .collect();
        order.sort_by(|&a, &b| self.cost(b).total_cmp(&self.cost(a)));
        let movable: Vec<_> = (0..self.poses.len())
            .map(|i| {
                i < self.input.producer_count
                    && self.input.rectangles[i].movable
                    && self.source_owner[i].is_none()
                    && self.radius[i] == 0.0
            })
            .collect();
        for i in order {
            if budget == 0 {
                break;
            }
            let old = self.poses[i];
            let current = self.cost(i);
            let mut proposals = vec![];
            for s in self.input.producer_count..self.input.producer_count + self.input.store_count {
                let store = self.poses[s];
                for side in 0..4 {
                    for offset in -24..=24 {
                        let tangent = offset as f64 / 4.0;
                        let mut r = if side < 2 {
                            Pose {
                                x: if side == 0 {
                                    store.x - old.w
                                } else {
                                    store.x + store.w
                                },
                                y: store.cy() - old.h / 2.0 + tangent,
                                ..old
                            }
                        } else {
                            Pose {
                                x: store.cx() - old.w / 2.0 + tangent,
                                y: if side == 2 {
                                    store.y - old.h
                                } else {
                                    store.y + store.h
                                },
                                ..old
                            }
                        };
                        r.x = (r.x * 4.0 + 0.5).floor() / 4.0;
                        r.y = (r.y * 4.0 + 0.5).floor() / 4.0;
                        self.poses[i] = r;
                        let cost = self.cost(i);
                        if cost >= current - 1e-8 || !self.valid_position(i) {
                            continue;
                        }
                        let blockers: Vec<_> = self
                            .poses
                            .iter()
                            .enumerate()
                            .filter_map(|(k, &p)| (k != i && r.hits(p)).then_some(k))
                            .collect();
                        if blockers.len() <= 4
                            && !blockers.is_empty()
                            && blockers.iter().all(|&k| movable[k])
                        {
                            proposals.push((cost, r, blockers));
                        }
                    }
                }
            }
            self.poses[i] = old;
            proposals.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.2.len().cmp(&b.2.len())));
            let mut seen: Vec<Vec<usize>> = vec![];
            let mut trials = 0;
            for (cost, r, mut blockers) in proposals {
                if budget == 0 || trials >= 3 {
                    break;
                }
                if seen.contains(&blockers) {
                    continue;
                }
                seen.push(blockers.clone());
                trials += 1;
                budget -= 1;
                let allowance =
                    current - cost + blockers.iter().map(|&k| self.cost(k)).sum::<f64>();
                blockers.sort_by(|&a, &b| {
                    self.input.rectangles[b]
                        .weight
                        .total_cmp(&self.input.rectangles[a].weight)
                });
                let saved: Vec<_> = blockers.iter().map(|&k| self.poses[k]).collect();
                grid.index(i, old, false);
                for (&k, &p) in blockers.iter().zip(&saved) {
                    grid.index(k, p, false);
                }
                self.poses[i] = r;
                grid.index(i, r, true);
                let mut spent = 0.0;
                let mut placed = 0;
                for (&j, &shape) in blockers.iter().zip(&saved) {
                    let mut best_cost = allowance - spent;
                    let mut best = None;
                    for y in self.land.top
                        ..=self.land.top + self.land.height as i32 - (shape.h * 4.0) as i32
                    {
                        for x in self.land.left
                            ..=self.land.left + self.land.width as i32 - (shape.w * 4.0) as i32
                        {
                            self.poses[j] = Pose {
                                x: x as f64 / 4.0,
                                y: y as f64 / 4.0,
                                ..shape
                            };
                            let cost = self.cost(j);
                            if cost < best_cost - 1e-8
                                && self.valid_position(j)
                                && grid.nearby_area(&self.poses, j, usize::MAX) < 1e-8
                            {
                                best_cost = cost;
                                best = Some(self.poses[j]);
                                if cost == 0.0 {
                                    break;
                                }
                            }
                        }
                        if best_cost == 0.0 {
                            break;
                        }
                    }
                    if let Some(p) = best {
                        self.poses[j] = p;
                        grid.index(j, p, true);
                        spent += best_cost;
                        placed += 1;
                    } else {
                        break;
                    }
                }
                if placed == blockers.len() {
                    break;
                }
                grid.index(i, r, false);
                self.poses[i] = old;
                grid.index(i, old, true);
                for (n, (&k, &p)) in blockers.iter().zip(&saved).enumerate() {
                    if n < placed {
                        grid.index(k, self.poses[k], false);
                    }
                    self.poses[k] = p;
                    grid.index(k, p, true);
                }
            }
        }
    }
    fn polish(&mut self) {
        if self.input.polish_passes == 0 {
            return;
        }
        let mut grid = Occupancy::new(&self.input.cells, self.poses.len());
        for (i, &r) in self.poses.iter().enumerate() {
            grid.index(i, r, true);
        }
        let mut order: Vec<_> = self
            .movable
            .iter()
            .copied()
            .filter(|&i| {
                i < self.input.producer_count
                    && self.source_owner[i].is_none()
                    && self.radius[i] == 0.0
                    && self.input.rectangles[i].weight > 0.0
            })
            .collect();
        order.sort_by(|&a, &b| self.cost(b).total_cmp(&self.cost(a)));
        for _ in 0..self.input.polish_passes {
            let mut changed = false;
            for &i in &order {
                let old = self.poses[i];
                let mut best = old;
                let mut best_cost = self.cost(i);
                for orientation in 0..if old.w == old.h { 1 } else { 2 } {
                    let (w, h) = if orientation == 0 {
                        (old.w, old.h)
                    } else {
                        (old.h, old.w)
                    };
                    for s in self.input.producer_count
                        ..self.input.producer_count + self.input.store_count
                    {
                        let store = self.poses[s];
                        let radius = best_cost / self.input.rectangles[i].weight;
                        let left = ((store.cx() - radius - w / 2.0) * 4.0)
                            .ceil()
                            .max(self.land.left as f64) as i32;
                        let right = ((store.cx() + radius - w / 2.0) * 4.0)
                            .floor()
                            .min((self.land.left + self.land.width as i32) as f64 - w * 4.0)
                            as i32;
                        let top = ((store.cy() - radius - h / 2.0) * 4.0)
                            .ceil()
                            .max(self.land.top as f64) as i32;
                        let bottom = ((store.cy() + radius - h / 2.0) * 4.0)
                            .floor()
                            .min((self.land.top + self.land.height as i32) as f64 - h * 4.0)
                            as i32;
                        for y in top..=bottom {
                            for x in left..=right {
                                self.poses[i] = Pose {
                                    x: x as f64 / 4.0,
                                    y: y as f64 / 4.0,
                                    w,
                                    h,
                                };
                                let cost = self.cost(i);
                                if cost < best_cost - 1e-8
                                    && self.valid_position(i)
                                    && grid.nearby_area(&self.poses, i, usize::MAX) < 1e-8
                                {
                                    best = self.poses[i];
                                    best_cost = cost;
                                }
                            }
                        }
                    }
                }
                self.poses[i] = best;
                if best.x != old.x || best.y != old.y || best.w != old.w || best.h != old.h {
                    grid.index(i, old, false);
                    grid.index(i, best, true);
                    changed = true;
                }
            }
            for i in self.input.producer_count..self.input.producer_count + self.input.store_count {
                let old = self.poses[i];
                let mut best = old;
                let mut best_cost = self.total_cost();
                for dy in -4..=4 {
                    for dx in -4..=4 {
                        self.poses[i] = Pose {
                            x: old.x + dx as f64 / 4.0,
                            y: old.y + dy as f64 / 4.0,
                            ..old
                        };
                        if !self.land.inside(self.poses[i])
                            || grid.nearby_area(&self.poses, i, usize::MAX) > 1e-8
                        {
                            continue;
                        }
                        let cost = self.total_cost();
                        if cost < best_cost - 1e-8 {
                            best = self.poses[i];
                            best_cost = cost;
                        }
                    }
                }
                self.poses[i] = best;
                if best.x != old.x || best.y != old.y {
                    grid.index(i, old, false);
                    grid.index(i, best, true);
                    changed = true;
                }
            }
            // Unequal footprints can exchange several edge/center alignments.
            // Keep both destinations feasible and compare their combined cost.
            for a in 0..order.len() {
                for b in a + 1..order.len() {
                    let i = order[a];
                    let j = order[b];
                    let old = self.poses[i];
                    let other = self.poses[j];
                    if old.w == other.w
                        && old.h == other.h
                        && self.input.rectangles[i].weight == self.input.rectangles[j].weight
                    {
                        continue;
                    }
                    let mut best = (old, other);
                    let mut best_cost = self.cost(i) + self.cost(j);
                    let xs: &[f64] = if old.w == other.w {
                        &[0.0]
                    } else {
                        &[0.0, 0.5, 1.0]
                    };
                    let ys: &[f64] = if old.h == other.h {
                        &[0.0]
                    } else {
                        &[0.0, 0.5, 1.0]
                    };
                    for &ax in xs {
                        for &ay in ys {
                            for &bx in xs {
                                for &by in ys {
                                    let snap = |v: f64| (v * 4.0 + 0.5).floor() / 4.0;
                                    self.poses[i] = Pose {
                                        x: snap(other.x + (other.w - old.w) * ax),
                                        y: snap(other.y + (other.h - old.h) * ay),
                                        ..old
                                    };
                                    self.poses[j] = Pose {
                                        x: snap(old.x + (old.w - other.w) * bx),
                                        y: snap(old.y + (old.h - other.h) * by),
                                        ..other
                                    };
                                    let cost = self.cost(i) + self.cost(j);
                                    if cost < best_cost - 1e-8
                                        && self.valid_position(i)
                                        && self.valid_position(j)
                                        && grid.changed_area(&self.poses, i, Some(j)) < 1e-8
                                    {
                                        best = (self.poses[i], self.poses[j]);
                                        best_cost = cost;
                                    }
                                }
                            }
                        }
                    }
                    self.poses[i] = best.0;
                    self.poses[j] = best.1;
                    if best.0.x != old.x
                        || best.0.y != old.y
                        || best.1.x != other.x
                        || best.1.y != other.y
                    {
                        grid.index(i, old, false);
                        grid.index(j, other, false);
                        grid.index(i, best.0, true);
                        grid.index(j, best.1, true);
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
    }
    fn output(&self, initial_cost: f64, cost: f64, iterations: usize) -> Output {
        Output {
            poses: self.poses.iter().map(|p| [p.x, p.y, p.w, p.h]).collect(),
            cost,
            initial_cost,
            iterations,
        }
    }
}

/// JSON boundary used by the WASM worker. Unsupported or malformed inputs fail
/// explicitly, so the caller can retain its already validated layout.
pub fn refine_json(json: &str) -> Result<String, String> {
    let input: Input = serde_json::from_str(json).map_err(|e| e.to_string())?;
    if input.polish_passes > 16 {
        return Err("Too many polishing passes".into());
    }
    if input.exchange_trials > 128 {
        return Err("Too many exchange trials".into());
    }
    let n = input.rectangles.len();
    if n > 1024
        || input
            .producer_count
            .checked_add(input.store_count)
            .map_or(true, |v| v > n)
        || input.iterations > 64_000_000
        || !input.temperature.is_finite()
        || input.temperature < 0.0
        || !input.penalty.is_finite()
        || input.penalty <= 0.0
    {
        return Err("Invalid search parameters".into());
    }
    if input.rectangles.iter().any(|r| {
        !r.p.valid()
            || !r.weight.is_finite()
            || r.weight < 0.0
            || r.owner < -1
            || r.owner >= input.climates.len() as i32
            || r.zone > 2
    }) {
        return Err("Invalid rectangle metadata".into());
    }
    if input
        .climates
        .iter()
        .any(|g| g.is_empty() || g.len() > 2 || g.iter().any(|&i| i >= input.producer_count))
    {
        return Err("Invalid climate group".into());
    }
    let mut climate_sources = vec![false; n];
    for group in &input.climates {
        for &i in group {
            if climate_sources[i] {
                return Err("Duplicate climate source".into());
            }
            climate_sources[i] = true;
        }
    }
    if n == 0 {
        return serde_json::to_string(&Output {
            poses: vec![],
            cost: 0.0,
            initial_cost: 0.0,
            iterations: 0,
        })
        .map_err(|e| e.to_string());
    }
    let land = Land::new(&input.cells)?;
    let poses: Vec<_> = input.rectangles.iter().map(|r| r.p).collect();
    if poses.iter().any(|&r| !land.inside(r))
        || poses
            .iter()
            .enumerate()
            .any(|(i, a)| poses[i + 1..].iter().any(|&b| a.hits(b)))
    {
        return Err("Initial layout is not feasible".into());
    }
    let mut source_owner = vec![None; n];
    let mut movable = vec![];
    for (ci, group) in input.climates.iter().enumerate() {
        if source_owner[group[0]].is_some() {
            return Err("Duplicate climate source".into());
        }
        source_owner[group[0]] = Some(ci);
    }
    for i in 0..input.producer_count {
        if source_owner[i].is_some() || (!climate_sources[i] && input.rectangles[i].movable) {
            movable.push(i);
        }
    }
    movable.extend(input.producer_count..input.producer_count + input.store_count);
    let relays: Vec<_> = input
        .rectangles
        .iter()
        .enumerate()
        .filter_map(|(i, r)| (r.generator || r.pole).then_some(i))
        .collect();
    if !relays.is_empty() && !input.rectangles[relays[0]].generator {
        return Err("Power network needs a generator root".into());
    }
    let electric = input
        .rectangles
        .iter()
        .enumerate()
        .filter_map(|(i, r)| r.electric.then_some(i))
        .collect();
    let radius = input
        .rectangles
        .iter()
        .map(|r| {
            if r.generator {
                5.5
            } else if r.pole {
                3.5
            } else {
                0.0
            }
        })
        .collect();
    let relay_count = relays.len();
    let rng = input.seed;
    let mut search = Search {
        input,
        poses,
        land,
        source_owner,
        movable,
        relays,
        electric,
        radius,
        reached: vec![false; relay_count],
        queue: vec![0; relay_count],
        rng,
    };
    if !search.network_valid()
        || (0..n).any(|i| !search.valid_position(i) || !search.valid_source(i))
    {
        return Err("Initial coverage is not feasible".into());
    }
    let output = search.run();
    serde_json::to_string(&output).map_err(|e| e.to_string())
}
