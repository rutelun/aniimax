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
                    || self.poses[i].w != self.poses[other].w
                    || self.poses[i].h != self.poses[other].h
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
                let proposed = self.poses[i];
                let proposed_other = j.map(|k| self.poses[k]);
                self.poses[i] = old;
                if let Some(j) = j {
                    self.poses[j] = other.unwrap();
                }
                let old_overlap = grid.changed_area(&self.poses, i, j);
                self.poses[i] = proposed;
                if let Some(j) = j {
                    self.poses[j] = proposed_other.unwrap();
                }
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
        self.output(initial, self.total_cost(), iterations)
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
