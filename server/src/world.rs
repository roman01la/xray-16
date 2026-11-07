//! Transport-independent, server-owned simulation. No client-supplied positions,
//! damage amounts, elapsed time, or safe-zone flags enter this API.
use crate::{collision::CollisionMap, movement::Character};
use parry3d::math::Vector;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

pub const TICK_HZ: u32 = 30;
pub const SNAPSHOT_EVERY: u32 = 2;
pub const INPUT_TIMEOUT_TICKS: u32 = 8;
pub const INTEREST_RADIUS: f32 = 100.0;
/// Bound per-peer state and keyframes even if a larger server crowds one cell.
pub const MAX_VISIBLE_ENTITIES: usize = 512;
const CELL_SIZE: f32 = 64.0;
const WORLD_EXTENT: f32 = 2000.0;

#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}
impl Vec3 {
    pub fn distance_squared(self, other: Self) -> f32 {
        (self.x - other.x).powi(2) + (self.y - other.y).powi(2) + (self.z - other.z).powi(2)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Player = 1,
    Npc = 2,
}
#[derive(Clone, Copy, Debug)]
pub struct Input {
    pub sequence: u32,
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
    pub sprint: bool,
    pub jump: bool,
    pub crouch: bool,
}
pub fn newer(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) > 0
}
#[derive(Clone, Debug)]
pub struct Entity {
    pub id: u32,
    pub kind: Kind,
    pub position: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    pub health: u16,
    input: Option<Input>,
    input_tick: u32,
    last_attack: Option<u32>,
}
impl Entity {
    pub fn last_input(&self) -> u32 {
        self.input.map_or(0, |i| i.sequence)
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct SafeZone {
    pub center: Vec3,
    pub radius: f32,
}
impl SafeZone {
    pub fn contains(&self, p: Vec3) -> bool {
        self.center.distance_squared(p) <= self.radius * self.radius
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DamageResult {
    Applied { health: u16 },
    SafeZone,
    OutOfRange,
    Cooldown,
    InvalidTarget,
    Dead,
}
#[derive(Clone, Copy, Debug)]
pub struct SnapshotEntity {
    pub id: u32,
    pub position: Vec3,
    pub velocity: Vec3,
    pub yaw: f32,
    pub health: u16,
    pub kind: u8,
    pub flags: u8,
}
#[derive(Default)]
pub struct World {
    pub tick: u32,
    next_id: u32,
    pub entities: BTreeMap<u32, Entity>,
    pub persistent_ids: BTreeMap<u32, String>,
    pub safe_zones: Vec<SafeZone>,
    grid: HashMap<(i32, i32), Vec<u32>>,
    collision: Option<Arc<CollisionMap>>,
    characters: HashMap<u32, Character>,
    pub movement_errors: u64,
}
impl World {
    pub fn new() -> Self {
        Self {
            safe_zones: vec![SafeZone {
                center: Vec3::default(),
                radius: 10.0,
            }],
            ..Self::default()
        }
    }
    /// Geometry-backed simulation, enabled by the pinned map session contract.
    pub fn with_collision(map: Arc<CollisionMap>) -> anyhow::Result<Self> {
        anyhow::ensure!(map.actor_ready(), "material-aware collision is required");
        Ok(Self {
            collision: Some(map),
            ..Self::default()
        })
    }
    pub fn spawn_on_map(&mut self, kind: Kind, x: f32, z: f32) -> anyhow::Result<u32> {
        let p = self
            .collision
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("no map loaded"))?
            .spawn_feet(x, z)?;
        Ok(self.spawn(
            kind,
            Vec3 {
                x: p.x,
                y: p.y,
                z: p.z,
            },
        ))
    }
    pub fn spawn(&mut self, kind: Kind, position: Vec3) -> u32 {
        self.next_id = self
            .next_id
            .checked_add(1)
            .expect("entity id space exhausted");
        let id = self.next_id;
        self.entities.insert(
            id,
            Entity {
                id,
                kind,
                position,
                velocity: Vec3::default(),
                yaw: 0.0,
                health: 100,
                input: None,
                input_tick: self.tick,
                last_attack: None,
            },
        );
        if kind == Kind::Player && self.collision.is_some() {
            self.characters.insert(
                id,
                Character::new(Vector::new(position.x, position.y, position.z)),
            );
        }
        self.grid.entry(cell(position)).or_default().push(id);
        id
    }
    pub fn remove(&mut self, id: u32) {
        self.persistent_ids.remove(&id);
        self.entities.remove(&id);
        self.characters.remove(&id);
    }
    /// Server-selected respawn. Keep session identity and the input sequence
    /// watermark; a dead presentation body gets a new, never-reused entity ID.
    pub fn respawn(&mut self, id: u32, spawn: Vec3) -> anyhow::Result<u32> {
        let dead = self
            .entities
            .get(&id)
            .ok_or_else(|| anyhow::anyhow!("missing player"))?
            .clone();
        anyhow::ensure!(
            dead.kind == Kind::Player && dead.health == 0,
            "player is alive"
        );
        let position = if let Some(map) = &self.collision {
            let p = map.spawn_feet(spawn.x, spawn.z)?;
            Vec3 {
                x: p.x,
                y: p.y,
                z: p.z,
            }
        } else {
            spawn
        };
        let corpse = self.spawn(Kind::Player, dead.position);
        self.characters.remove(&corpse);
        let body = self.entities.get_mut(&corpse).unwrap();
        body.health = 0;
        body.yaw = dead.yaw;
        let player = self.entities.get_mut(&id).unwrap();
        player.position = position;
        player.velocity = Vec3::default();
        player.yaw = 0.;
        player.health = 100;
        player.input = dead.input.map(|old| Input {
            sequence: old.sequence,
            x: 0.,
            z: 0.,
            yaw: 0.,
            sprint: false,
            jump: false,
            crouch: false,
        });
        player.input_tick = self.tick;
        player.last_attack = None;
        if self.collision.is_some() {
            self.characters.insert(
                id,
                Character::new(Vector::new(position.x, position.y, position.z)),
            );
        }
        Ok(corpse)
    }
    pub fn input(&mut self, id: u32, mut input: Input) -> bool {
        if !input.x.is_finite() || !input.z.is_finite() || !input.yaw.is_finite() {
            return false;
        }
        let Some(e) = self.entities.get_mut(&id) else {
            return false;
        };
        if e.kind != Kind::Player
            || e.health == 0
            || e.input
                .is_some_and(|old| !newer(input.sequence, old.sequence))
        {
            return false;
        }
        let length = input.x.hypot(input.z).max(1.0);
        input.x /= length;
        input.z /= length;
        input.yaw = input.yaw.rem_euclid(std::f32::consts::TAU);
        e.input = Some(input);
        e.input_tick = self.tick;
        true
    }
    pub fn step(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        self.grid.clear();
        for e in self.entities.values_mut() {
            e.velocity = Vec3::default();
            if let (Some(map), Some(character)) = (&self.collision, self.characters.get_mut(&e.id))
            {
                let input = e.input.filter(|_| {
                    e.health > 0 && self.tick.wrapping_sub(e.input_tick) <= INPUT_TIMEOUT_TICKS
                });
                let (x, z, sprint, jump, crouch) =
                    input.map_or((0., 0., false, false, false), |i| {
                        e.yaw = i.yaw;
                        (i.x, i.z, i.sprint, i.jump, i.crouch)
                    });
                if character
                    .step_command(map, x, z, sprint, jump, crouch)
                    .is_ok()
                {
                    let p = character.feet;
                    e.velocity = Vec3 {
                        x: (p.x - e.position.x) * TICK_HZ as f32,
                        y: character.vertical_speed,
                        z: (p.z - e.position.z) * TICK_HZ as f32,
                    };
                    e.position = Vec3 {
                        x: p.x,
                        y: p.y,
                        z: p.z,
                    };
                } else {
                    self.movement_errors += 1;
                }
                self.grid.entry(cell(e.position)).or_default().push(e.id);
                continue;
            }
            if e.health > 0
                && self.tick.wrapping_sub(e.input_tick) <= INPUT_TIMEOUT_TICKS
                && let Some(i) = e.input
            {
                let speed = if i.sprint { 6.0 } else { 4.0 };
                e.velocity = Vec3 {
                    x: i.x * speed,
                    y: 0.0,
                    z: i.z * speed,
                };
                e.yaw = i.yaw;
                e.position.x = (e.position.x + e.velocity.x / TICK_HZ as f32)
                    .clamp(-WORLD_EXTENT, WORLD_EXTENT);
                e.position.z = (e.position.z + e.velocity.z / TICK_HZ as f32)
                    .clamp(-WORLD_EXTENT, WORLD_EXTENT);
            }
            self.grid.entry(cell(e.position)).or_default().push(e.id);
        }
    }
    pub fn capsule_height(&self, id: u32) -> f32 {
        if self.characters.get(&id).is_some_and(|c| c.crouched) {
            1.2
        } else {
            1.8
        }
    }
    pub fn static_ray(
        &self,
        origin: Vector,
        direction: Vector,
        distance: f32,
    ) -> anyhow::Result<Option<f32>> {
        self.collision
            .as_ref()
            .map_or(Ok(None), |map| map.ray(origin, direction, distance))
    }
    pub fn is_safe(&self, p: Vec3) -> bool {
        self.safe_zones.iter().any(|z| z.contains(p))
    }
    /// Test-world melee action. Real STALKER hitboxes, weapons, line-of-sight,
    /// lag compensation and NPC AI are deliberately separate integration work.
    pub fn attack(&mut self, attacker: u32, target: u32) -> DamageResult {
        if self.persistent_ids.contains_key(&target) {
            return DamageResult::InvalidTarget;
        }
        let (Some(a), Some(b)) = (self.entities.get(&attacker), self.entities.get(&target)) else {
            return DamageResult::InvalidTarget;
        };
        if attacker == target {
            return DamageResult::InvalidTarget;
        }
        if a.health == 0 || b.health == 0 {
            return DamageResult::Dead;
        }
        if self.is_safe(a.position) || self.is_safe(b.position) {
            return DamageResult::SafeZone;
        }
        if a.position.distance_squared(b.position) > 3.0 * 3.0 {
            return DamageResult::OutOfRange;
        }
        if a.last_attack
            .is_some_and(|t| self.tick.wrapping_sub(t) < 15)
        {
            return DamageResult::Cooldown;
        }
        self.entities.get_mut(&attacker).unwrap().last_attack = Some(self.tick);
        let victim = self.entities.get_mut(&target).unwrap();
        victim.health = victim.health.saturating_sub(25);
        DamageResult::Applied {
            health: victim.health,
        }
    }
    pub fn visible_to(&self, observer: u32) -> Vec<SnapshotEntity> {
        let Some(eye) = self.entities.get(&observer) else {
            return vec![];
        };
        let (cx, cz) = cell(eye.position);
        let reach = (INTEREST_RADIUS / CELL_SIZE).ceil() as i32;
        let mut output = Vec::new();
        for x in cx - reach..=cx + reach {
            for z in cz - reach..=cz + reach {
                if let Some(ids) = self.grid.get(&(x, z)) {
                    for id in ids {
                        let Some(e) = self.entities.get(id) else {
                            continue;
                        };
                        if eye.position.distance_squared(e.position)
                            > INTEREST_RADIUS * INTEREST_RADIUS
                        {
                            continue;
                        }
                        output.push(SnapshotEntity {
                            id: e.id,
                            position: e.position,
                            velocity: e.velocity,
                            yaw: e.yaw,
                            health: e.health,
                            kind: e.kind as u8,
                            flags: u8::from(self.is_safe(e.position))
                                | self.characters.get(&e.id).map_or(0, |c| {
                                    u8::from(c.grounded) * 2
                                        + u8::from(c.crouched) * 4
                                        + u8::from(c.jump_held) * 8
                                }),
                        });
                    }
                }
            }
        }
        if output.len() > MAX_VISIBLE_ENTITIES {
            output.sort_unstable_by(|a, b| {
                (a.id != observer)
                    .cmp(&(b.id != observer))
                    .then_with(|| {
                        eye.position
                            .distance_squared(a.position)
                            .total_cmp(&eye.position.distance_squared(b.position))
                    })
                    .then(a.id.cmp(&b.id))
            });
            output.truncate(MAX_VISIBLE_ENTITIES);
        }
        output.sort_unstable_by_key(|e| e.id);
        output
    }
}
fn cell(p: Vec3) -> (i32, i32) {
    (
        (p.x / CELL_SIZE).floor() as i32,
        (p.z / CELL_SIZE).floor() as i32,
    )
}
