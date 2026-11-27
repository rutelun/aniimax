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
    #[serde(default)]
    arrival_weights: Vec<f64>,
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

// One bit per candidate origin on the quarter-tile grid. A bit is set if
// another rectangle blocks this footprint or a previous store already tried it.
struct PolishOrigins {
    stride: usize,
    rows: Vec<u64>,
}

fn word_masks(left: usize, right: usize) -> impl Iterator<Item = (usize, u64)> {
    (left / 64..=right / 64).map(move |word| {
        let first = left.saturating_sub(word * 64);
        let last = (right - word * 64).min(63);
        (word, (u64::MAX << first) & (u64::MAX >> (63 - last)))
    })
}

impl PolishOrigins {
    fn new(land: &Land) -> Self {
        let stride = land.width / 64 + 1;
        Self {
            stride,
            rows: vec![0; stride * (land.height + 1)],
        }
    }

    fn reset(&mut self, land: &Land, poses: &[Pose], moving: usize, w: f64, h: f64) {
        self.rows.fill(0);
        for (i, p) in poses.iter().enumerate() {
            if i == moving {
                continue;
            }
            // Strict overlap excludes edge contact, which is a legal placement.
            let left = ((4.0 * (p.x - w)).floor() as i32 + 1 - land.left).max(0);
            let right = ((4.0 * (p.x + p.w)).ceil() as i32 - 1 - land.left).min(land.width as i32);
            let top = ((4.0 * (p.y - h)).floor() as i32 + 1 - land.top).max(0);
            let bottom = ((4.0 * (p.y + p.h)).ceil() as i32 - 1 - land.top).min(land.height as i32);
            if left <= right {
                for (word, mask) in word_masks(left as usize, right as usize) {
                    for y in top..=bottom {
                        self.rows[y as usize * self.stride + word] |= mask;
                    }
                }
            }
        }
    }

    fn unvisited(
        &mut self,
        y: usize,
        left: usize,
        right: usize,
    ) -> impl Iterator<Item = usize> + '_ {
        word_masks(left, right).flat_map(move |(word, mask)| {
            let seen = &mut self.rows[y * self.stride + word];
            let mut remaining = mask & !*seen;
            *seen |= mask;
            std::iter::from_fn(move || {
                if remaining == 0 {
                    return None;
                }
                let x = word * 64 + remaining.trailing_zeros() as usize;
                remaining &= remaining - 1;
                Some(x)
            })
        })
    }
}

// Quarter-tile coordinates make overlap areas exact integers.
#[derive(Clone, Copy, Default)]
struct GridRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}
impl From<Pose> for GridRect {
    fn from(p: Pose) -> Self {
        Self {
            left: (p.x * 4.0) as i32,
            top: (p.y * 4.0) as i32,
            right: ((p.x + p.w) * 4.0) as i32,
            bottom: ((p.y + p.h) * 4.0) as i32,
        }
    }
}
impl GridRect {
    fn area(self, other: Self) -> i32 {
        (self.right.min(other.right) - self.left.max(other.left)).max(0)
            * (self.bottom.min(other.bottom) - self.top.max(other.top)).max(0)
    }
}
#[derive(Clone, Copy)]
struct BinEntry {
    id: u16,
    bin_x: i32,
    bin_y: i32,
    rect: GridRect,
}
struct Occupancy {
    left: i32,
    top: i32,
    cols: usize,
    bins: Vec<Vec<BinEntry>>,
    bounds: Vec<GridRect>,
}

impl Occupancy {
    fn new(cells: &[Pose], count: usize) -> Self {
        let left = cells
            .iter()
            .map(|c| GridRect::from(*c).left >> 4)
            .min()
            .unwrap();
        let top = cells
            .iter()
            .map(|c| GridRect::from(*c).top >> 4)
            .min()
            .unwrap();
        let cols = (cells
            .iter()
            .map(|c| (GridRect::from(*c).right - 1) >> 4)
            .max()
            .unwrap()
            - left
            + 1) as usize;
        let rows = (cells
            .iter()
            .map(|c| (GridRect::from(*c).bottom - 1) >> 4)
            .max()
            .unwrap()
            - top
            + 1) as usize;
        Self {
            left,
            top,
            cols,
            bins: vec![Vec::new(); cols * rows],
            bounds: vec![GridRect::default(); count],
        }
    }
    fn index(&mut self, i: usize, r: Pose, add: bool) {
        let r = GridRect::from(r);
        let id = i as u16;
        let bx0 = r.left >> 4;
        let by0 = r.top >> 4;
        let bx1 = (r.right - 1) >> 4;
        let by1 = (r.bottom - 1) >> 4;
        if add {
            self.bounds[i] = r;
            let entry = BinEntry {
                id,
                bin_x: bx0,
                bin_y: by0,
                rect: r,
            };
            for y in by0..=by1 {
                let row = (y - self.top) as usize * self.cols;
                for x in bx0..=bx1 {
                    self.bins[row + (x - self.left) as usize].push(entry);
                }
            }
        } else {
            for y in by0..=by1 {
                let row = (y - self.top) as usize * self.cols;
                for x in bx0..=bx1 {
                    let bin = &mut self.bins[row + (x - self.left) as usize];
                    let pos = bin
                        .iter()
                        .position(|e| e.id == id)
                        .expect("indexed rectangle");
                    bin.swap_remove(pos);
                }
            }
        }
    }
    #[inline]
    fn nearby(&self, r: GridRect, mut visit: impl FnMut(usize, GridRect)) {
        // Count a shared rectangle in the top-left four-tile bin that both
        // rectangles touch. This avoids building a bitset for every query.
        let first_x = r.left >> 4;
        let first_y = r.top >> 4;
        let last_x = (r.right - 1) >> 4;
        let last_y = (r.bottom - 1) >> 4;
        for y in first_y..=last_y {
            let row = (y - self.top) as usize * self.cols;
            for x in first_x..=last_x {
                let bin = &self.bins[row + (x - self.left) as usize];
                for e in bin {
                    if (x == first_x || x == e.bin_x) && (y == first_y || y == e.bin_y) {
                        visit(e.id as usize, e.rect);
                    }
                }
            }
        }
    }
    #[inline]
    fn nearby_area(&self, poses: &[Pose], i: usize, j: usize) -> f64 {
        let r = GridRect::from(poses[i]);
        let mut sum = 0;
        self.nearby(r, |k, b| {
            if k != i && k != j {
                sum += r.area(b);
            }
        });
        f64::from(sum) / 16.0
    }
    fn update_overlaps(&self, totals: &mut [i32], i: usize, r: Pose, sign: i32) {
        let r = GridRect::from(r);
        self.nearby(r, |k, b| {
            if k != i {
                let change = sign * r.area(b);
                totals[k] += change;
                totals[i] += change;
            }
        });
    }
    #[inline]
    fn changed_area(&mut self, poses: &[Pose], i: usize, j: Option<usize>) -> f64 {
        self.nearby_area(poses, i, j.unwrap_or(usize::MAX))
            + j.map_or(0.0, |j| {
                self.nearby_area(poses, j, i) + poses[i].area(poses[j])
            })
    }
}

const FLAG_ELECTRIC: u8 = 1;
const FLAG_SENSITIVE: u8 = 2;
const FLAG_HAS_OWNER: u8 = 4;

struct Search {
    input: Input,
    poses: Vec<Pose>,
    land: Land,
    source_owner: Vec<Option<usize>>,
    movable: Vec<usize>,
    relays: Vec<usize>,
    relay_index: Vec<i32>,
    relay_cx: Vec<f64>,
    relay_cy: Vec<f64>,
    relay_rad: Vec<f64>,
    electric: Vec<usize>,
    radius: Vec<f64>,
    weights: Vec<f64>,
    has_shares: Vec<bool>,
    flat_shares: Vec<f64>,
    store_cx: Vec<f64>,
    store_cy: Vec<f64>,
    meta_flags: Vec<u8>,
    meta_owner: Vec<i32>,
    meta_zone: Vec<u8>,
    climate_boxes: Vec<(i32, Pose)>,
    climate_ranges: Vec<(usize, usize)>,
    sensitive_producers: Vec<usize>,
    reached: Vec<bool>,
    queue: Vec<usize>,
    rng: u32,
}
impl Search {
    #[inline]
    fn sync_rect(&mut self, i: usize) {
        let p = self.poses[i];
        let pc = self.input.producer_count;
        if i >= pc && i < pc + self.input.store_count {
            let s = i - pc;
            self.store_cx[s] = p.cx();
            self.store_cy[s] = p.cy();
        }
        let ri = self.relay_index[i];
        if ri >= 0 {
            let idx = ri as usize;
            self.relay_cx[idx] = p.cx();
            self.relay_cy[idx] = p.cy();
        }
    }
    fn sync_climate_group(&mut self, ci: usize) {
        let (start, _) = self.climate_ranges[ci];
        for (offset, &s) in self.input.climates[ci].iter().enumerate() {
            self.climate_boxes[start + offset].1 = self.poses[s].climate();
        }
    }
    #[inline]
    fn random(&mut self) -> f64 {
        self.rng = self.rng.wrapping_mul(1664525).wrapping_add(1013904223);
        self.rng as f64 / 4294967296.0
    }
    #[inline]
    fn cost(&self, i: usize) -> f64 {
        let weight = self.weights[i];
        if weight == 0.0 {
            return 0.0;
        }
        let r = self.poses[i];
        let rcx = r.cx();
        let rcy = r.cy();
        let sc = self.input.store_count;
        let mut nearest = f64::INFINITY;
        if !self.has_shares[i] {
            for s in 0..sc {
                let dx = rcx - self.store_cx[s];
                let dy = rcy - self.store_cy[s];
                let squared = dx * dx + dy * dy;
                if squared < nearest {
                    nearest = squared;
                }
            }
            return weight * nearest.sqrt();
        }
        let base = i * sc;
        let mut arrival = 0.0;
        for s in 0..sc {
            let dx = rcx - self.store_cx[s];
            let dy = rcy - self.store_cy[s];
            let squared = dx * dx + dy * dy;
            if squared < nearest {
                nearest = squared;
            }
            arrival += self.flat_shares[base + s] * squared.sqrt();
        }
        weight * (nearest.sqrt() + arrival) * 0.5
    }
    fn total_cost(&self) -> f64 {
        if self.input.store_count == 0 {
            return 0.0;
        }
        (0..self.input.producer_count).map(|i| self.cost(i)).sum()
    }
    fn total_cost_into(&self, out: &mut [f64]) -> f64 {
        let mut sum = 0.0;
        for i in 0..self.input.producer_count {
            let c = self.cost(i);
            out[i] = c;
            sum += c;
        }
        sum
    }
    #[inline]
    fn relay_covers(&self, ri: usize, target: Pose) -> bool {
        let rcx = self.relay_cx[ri];
        let rcy = self.relay_cy[ri];
        let rad = self.relay_rad[ri];
        (rcx - target.cx()).abs() <= rad + target.w * 0.5 - 0.25 + 1e-7
            && (rcy - target.cy()).abs() <= rad + target.h * 0.5 - 0.25 + 1e-7
    }
    fn network_valid(&mut self) -> bool {
        let rc = self.relays.len();
        if rc == 0 {
            return self.electric.is_empty();
        }
        self.reached.fill(false);
        self.reached[0] = true;
        self.queue[0] = 0;
        let mut tail = 1;
        let mut head = 0;
        while head < tail {
            let cur = self.queue[head];
            let cur_pose = self.poses[self.relays[cur]];
            for j in 0..rc {
                if !self.reached[j]
                    && (self.relay_covers(cur, self.poses[self.relays[j]])
                        || self.relay_covers(j, cur_pose))
                {
                    self.reached[j] = true;
                    self.queue[tail] = j;
                    tail += 1;
                }
            }
            head += 1;
        }
        if tail != rc {
            return false;
        }
        for &ei in &self.electric {
            let p = self.poses[ei];
            let mut covered = false;
            for ri in 0..rc {
                if self.relay_covers(ri, p) {
                    covered = true;
                    break;
                }
            }
            if !covered {
                return false;
            }
        }
        true
    }
    #[inline]
    fn valid_position(&self, i: usize) -> bool {
        let r = self.poses[i];
        if !self.land.inside(r) {
            return false;
        }
        let flags = self.meta_flags[i];
        if flags == 0 {
            return true;
        }
        if (flags & FLAG_ELECTRIC) != 0 {
            let mut covered = false;
            for ri in 0..self.relays.len() {
                if self.relay_covers(ri, r) {
                    covered = true;
                    break;
                }
            }
            if !covered {
                return false;
            }
        }
        if (flags & FLAG_HAS_OWNER) != 0 {
            let owner = self.meta_owner[i] as usize;
            let (start, len) = self.climate_ranges[owner];
            let a = r.hits(self.climate_boxes[start].1);
            let good = if len == 1 {
                a
            } else {
                let b = r.hits(self.climate_boxes[start + 1].1);
                match self.meta_zone[i] {
                    0 => a && !b,
                    1 => a && b,
                    _ => !a && b,
                }
            };
            if !good {
                return false;
            }
        }
        if (flags & (FLAG_HAS_OWNER | FLAG_SENSITIVE)) != 0 {
            let owner = self.meta_owner[i];
            for &(ci, cbox) in &self.climate_boxes {
                if ci != owner && r.hits(cbox) {
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
        let (start, len) = self.climate_ranges[ci];
        let ci_i32 = ci as i32;
        for idx in start..start + len {
            let box_a = self.climate_boxes[idx].1;
            for &(other_ci, box_b) in &self.climate_boxes {
                if other_ci != ci_i32 && box_a.hits(box_b) {
                    return false;
                }
            }
        }
        for &k in &self.sensitive_producers {
            if !self.valid_position(k) {
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
        // Each entry sums all intersections involving that rectangle in sixteenths
        // of a tile. Single and paired proposals read their old overlap in O(1).
        let mut collision_totals = vec![0; self.poses.len()];
        let mut cost_cache: Vec<f64> = (0..self.poses.len()).map(|i| self.cost(i)).collect();
        let mut scratch_costs = vec![0.0; self.poses.len()];
        let producer_count = self.input.producer_count;
        let store_end = producer_count + self.input.store_count;
        let inv_iters = 1.0 / (iterations.max(1) as f64);
        let movable_f = self.movable.len() as f64;
        let relays_f = self.relays.len() as f64;
        let snap = |v: f64| (v + 0.5).floor();
        for step in 0..iterations {
            let i = if self.input.mobile_relays && !self.relays.is_empty() && self.random() < 0.03 {
                let k = (self.random() * relays_f) as usize;
                self.relays[k]
            } else {
                let k = (self.random() * movable_f) as usize;
                self.movable[k]
            };
            let mut j = None;
            if self.random() < 0.12 {
                let k = (self.random() * movable_f) as usize;
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
                    && self.meta_owner[i] < 0
                    && i < producer_count;
                if ordinary && old.w != old.h && self.random() < 0.12 {
                    self.poses[i].w = old.h;
                    self.poses[i].h = old.w;
                } else if ordinary && self.random() < 0.08 {
                    if self.weights[i] == 0.0 {
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
            if store_move || self.relay_index[i] >= 0 {
                self.sync_rect(i);
                if let Some(j) = j {
                    self.sync_rect(j);
                }
            }
            if let Some(ci) = self.source_owner[i] {
                self.sync_climate_group(ci);
            }
            let mut accepted = false;
            if self.valid_source(i)
                && self.valid_position(i)
                && j.map_or(true, |j| self.valid_position(j))
                && (self.radius[i] == 0.0 || self.network_valid())
            {
                let mut old_area = collision_totals[i];
                if let Some(j) = j {
                    old_area += collision_totals[j] - grid.bounds[i].area(grid.bounds[j]);
                }
                let old_overlap = f64::from(old_area) / 16.0;
                let old_cost = if store_move {
                    current
                } else {
                    cost_cache[i] + j.map_or(0.0, |k| cost_cache[k])
                };
                let new_overlap = grid.changed_area(&self.poses, i, j);
                let mut next_i = 0.0;
                let mut next_j = 0.0;
                let next_cost = if store_move {
                    self.total_cost_into(&mut scratch_costs)
                } else {
                    next_i = self.cost(i);
                    next_j = j.map_or(0.0, |j| self.cost(j));
                    next_i + next_j
                };
                let dc = next_cost - old_cost;
                let da = new_overlap - old_overlap;
                let delta = dc + self.input.penalty * da;
                let accept = if delta <= 0.0 {
                    true
                } else {
                    let roll = self.random();
                    let phase = step as f64 * inv_iters;
                    let one_minus = 1.0 - phase;
                    let temp = (self.input.temperature * one_minus * one_minus * one_minus).max(0.005);
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
                        std::mem::swap(&mut cost_cache, &mut scratch_costs);
                    } else {
                        cost_cache[i] = next_i;
                        if let Some(j) = j {
                            cost_cache[j] = next_j;
                        }
                    }
                    if old_overlap > 0.0 {
                        grid.update_overlaps(&mut collision_totals, i, old, -1);
                    }
                    grid.index(i, old, false);
                    if let Some(j) = j {
                        if old_overlap > 0.0 {
                            grid.update_overlaps(&mut collision_totals, j, other.unwrap(), -1);
                        }
                        grid.index(j, other.unwrap(), false);
                    }
                    if new_overlap > 0.0 {
                        grid.update_overlaps(&mut collision_totals, i, self.poses[i], 1);
                    }
                    grid.index(i, self.poses[i], true);
                    if let Some(j) = j {
                        if new_overlap > 0.0 {
                            grid.update_overlaps(&mut collision_totals, j, self.poses[j], 1);
                        }
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
                if store_move || self.relay_index[i] >= 0 {
                    self.sync_rect(i);
                    if let Some(j) = j {
                        self.sync_rect(j);
                    }
                }
                if let Some(ci) = self.source_owner[i] {
                    self.sync_climate_group(ci);
                }
            }
        }
        self.poses = best_poses;
        for s in producer_count..store_end {
            self.sync_rect(s);
        }
        for ri in 0..self.relays.len() {
            let r = self.relays[ri];
            self.sync_rect(r);
        }
        for ci in 0..self.input.climates.len() {
            self.sync_climate_group(ci);
        }
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
        let mut origins = PolishOrigins::new(&self.land);
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
                    origins.reset(&self.land, &self.poses, i, w, h);
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
                        if left > right {
                            continue;
                        }
                        let first = (left - self.land.left) as usize;
                        let last = (right - self.land.left) as usize;
                        for y in top..=bottom {
                            for col in origins.unvisited((y - self.land.top) as usize, first, last)
                            {
                                let x = self.land.left + col as i32;
                                self.poses[i] = Pose {
                                    x: x as f64 / 4.0,
                                    y: y as f64 / 4.0,
                                    w,
                                    h,
                                };
                                let cost = self.cost(i);
                                if cost < best_cost - 1e-8 && self.valid_position(i) {
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
                        self.sync_rect(i);
                        let cost = self.total_cost();
                        if cost < best_cost - 1e-8 {
                            best = self.poses[i];
                            best_cost = cost;
                        }
                    }
                }
                self.poses[i] = best;
                self.sync_rect(i);
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
    let mut input: Input = serde_json::from_str(json).map_err(|e| e.to_string())?;
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
    // Normalize missing and non-positive arrival shares once at the input boundary.
    for rectangle in &mut input.rectangles {
        if !rectangle.arrival_weights.is_empty() && input.store_count > 0 {
            rectangle.arrival_weights.resize(input.store_count, 0.0);
            for share in &mut rectangle.arrival_weights {
                if !share.is_finite() || *share <= 0.0 {
                    *share = 0.0;
                }
            }
        }
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
    let radius: Vec<f64> = input
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
    let mut relay_index = vec![-1i32; n];
    let mut relay_cx = Vec::with_capacity(relay_count);
    let mut relay_cy = Vec::with_capacity(relay_count);
    let mut relay_rad = Vec::with_capacity(relay_count);
    for (ri, &r) in relays.iter().enumerate() {
        relay_index[r] = ri as i32;
        relay_cx.push(poses[r].cx());
        relay_cy.push(poses[r].cy());
        relay_rad.push(radius[r]);
    }
    let sc = input.store_count;
    let pc = input.producer_count;
    let store_cx: Vec<f64> = (pc..pc + sc).map(|s| poses[s].cx()).collect();
    let store_cy: Vec<f64> = (pc..pc + sc).map(|s| poses[s].cy()).collect();
    let weights: Vec<f64> = input.rectangles.iter().map(|r| r.weight).collect();
    let has_shares: Vec<bool> = input
        .rectangles
        .iter()
        .map(|r| !r.arrival_weights.is_empty())
        .collect();
    let mut flat_shares = vec![0.0; n * sc];
    for (i, r) in input.rectangles.iter().enumerate() {
        if !r.arrival_weights.is_empty() {
            flat_shares[i * sc..(i + 1) * sc].copy_from_slice(&r.arrival_weights[..sc]);
        }
    }
    let meta_flags: Vec<u8> = input
        .rectangles
        .iter()
        .map(|r| {
            (if r.electric { FLAG_ELECTRIC } else { 0 })
                | (if r.sensitive { FLAG_SENSITIVE } else { 0 })
                | (if r.owner >= 0 { FLAG_HAS_OWNER } else { 0 })
        })
        .collect();
    let meta_owner: Vec<i32> = input.rectangles.iter().map(|r| r.owner).collect();
    let meta_zone: Vec<u8> = input.rectangles.iter().map(|r| r.zone).collect();
    let mut climate_boxes = Vec::new();
    let mut climate_ranges = Vec::with_capacity(input.climates.len());
    for (ci, group) in input.climates.iter().enumerate() {
        let start = climate_boxes.len();
        for &s in group {
            climate_boxes.push((ci as i32, poses[s].climate()));
        }
        climate_ranges.push((start, group.len()));
    }
    let sensitive_producers: Vec<usize> = (0..pc)
        .filter(|&k| (meta_flags[k] & (FLAG_HAS_OWNER | FLAG_SENSITIVE)) != 0)
        .collect();
    let rng = input.seed;
    let mut search = Search {
        input,
        poses,
        land,
        source_owner,
        movable,
        relays,
        relay_index,
        relay_cx,
        relay_cy,
        relay_rad,
        electric,
        radius,
        weights,
        has_shares,
        flat_shares,
        store_cx,
        store_cy,
        meta_flags,
        meta_owner,
        meta_zone,
        climate_boxes,
        climate_ranges,
        sensitive_producers,
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

#[cfg(test)]
mod polish_tests {
    use super::*;

    #[test]
    fn cached_intersections_match_pairwise_areas_after_a_swap() {
        let cell = Pose {
            x: -8.0,
            y: -8.0,
            w: 20.0,
            h: 20.0,
        };
        let mut poses = vec![
            Pose {
                x: -4.25,
                y: -2.5,
                w: 6.0,
                h: 7.5,
            },
            Pose {
                x: -3.25,
                y: -3.0,
                w: 4.0,
                h: 4.0,
            },
            Pose {
                x: 0.75,
                y: 0.0,
                w: 3.5,
                h: 6.0,
            },
            Pose {
                x: 4.25,
                y: 1.0,
                w: 1.5,
                h: 2.0,
            },
        ];
        let mut grid = Occupancy::new(&[cell], poses.len());
        let mut totals = vec![0; poses.len()];
        for (i, &r) in poses.iter().enumerate() {
            grid.update_overlaps(&mut totals, i, r, 1);
            grid.index(i, r, true);
        }
        let check = |grid: &Occupancy, poses: &[Pose], totals: &[i32]| {
            for (i, &r) in poses.iter().enumerate() {
                let expected: f64 = poses
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| *k != i)
                    .map(|(_, &b)| r.area(b))
                    .sum();
                assert_eq!(grid.nearby_area(poses, i, usize::MAX), expected);
                assert_eq!(f64::from(totals[i]), expected * 16.0);
            }
        };
        check(&grid, &poses, &totals);
        for i in [0, 3] {
            grid.update_overlaps(&mut totals, i, poses[i], -1);
            grid.index(i, poses[i], false);
        }
        let (x, y) = (poses[0].x, poses[0].y);
        (poses[0].x, poses[0].y) = (poses[3].x, poses[3].y);
        (poses[3].x, poses[3].y) = (x, y);
        for i in [0, 3] {
            grid.update_overlaps(&mut totals, i, poses[i], 1);
            grid.index(i, poses[i], true);
        }
        check(&grid, &poses, &totals);
    }

    #[test]
    fn overlapping_store_searches_visit_each_free_origin_once_in_the_original_order() {
        let cell = Pose {
            x: -4.0,
            y: -1.0,
            w: 40.0,
            h: 3.0,
        };
        let land = Land::new(&[cell]).unwrap();
        let moving = Pose {
            x: 2.0,
            y: 0.0,
            w: 1.5,
            h: 0.5,
        };
        let blocker = Pose {
            x: 12.0,
            y: 0.0,
            w: 0.5,
            h: 1.0,
        };
        let poses = [moving, blocker];
        let mut origins = PolishOrigins::new(&land);
        for (w, h) in [(moving.w, moving.h), (moving.h, moving.w)] {
            origins.reset(&land, &poses, 0, w, h);
            for row in 0..=land.height {
                let mut expected = Vec::new();
                let mut actual = Vec::new();
                for (left, right) in [(40, 140), (0, 100), (110, 160)] {
                    actual.extend(origins.unvisited(row, left, right));
                    for col in left..=right {
                        let p = Pose {
                            x: (land.left + col as i32) as f64 / 4.0,
                            y: (land.top + row as i32) as f64 / 4.0,
                            w,
                            h,
                        };
                        if !p.hits(blocker) && !expected.contains(&col) {
                            expected.push(col);
                        }
                    }
                }
                assert_eq!(actual, expected);
            }
        }
    }
}
