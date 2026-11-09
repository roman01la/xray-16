//! Transport-independent, server-owned simulation. No client-supplied positions,
//! damage amounts, elapsed time, or safe-zone flags enter this API.
use crate::{authored_shape::Volume, collision::CollisionMap, movement::Character, survival::{Activity, AimProfile, Loadout}};
use parry3d::math::Vector;
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
};

pub use crate::movement::TICK_HZ;
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
    pub pitch: f32,
    pub sprint: bool,
    pub jump: bool,
    pub crouch: bool,
    pub walk: bool,
    pub aiming: bool,
}
pub(crate) fn look_direction(yaw: f32, pitch: f32) -> Vector {
    let (sin_yaw, cos_yaw) = yaw.sin_cos();
    let (sin_pitch, cos_pitch) = pitch.sin_cos();
    Vector::new(sin_yaw * cos_pitch, sin_pitch, cos_yaw * cos_pitch)
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
    pub condition: Option<crate::survival::State>,
    pub loadout: Loadout,
    pub appearance: crate::lifecycle::Appearance,
    pub native: Option<crate::alife_npcs::NativeNpc>,
    pub character_key: Option<CharacterKey>,
    pub armour_revision: u32,
    pub travelling: bool,
    pub(crate) incarnation: u32,
    input: Option<Input>,
    input_tick: u32,
    look: Vector,
    turn_speed: f32,
    aim: Option<(AimProfile, u32)>,
    last_attack: Option<u32>,
    last_pvp_hit: Option<u32>,
}
#[derive(Clone, Debug)]
pub struct CharacterKey {
    pub principal: String,
    pub life: u32,
}
impl Entity {
    pub fn set_condition(&mut self, condition: crate::survival::State) {
        self.health = condition.health_points();
        self.condition = Some(condition);
    }
    pub fn damage(&mut self, points: u16, fire_wound: bool) {
        self.apply_hit(f32::from(points) / 100.0, fire_wound);
    }
    pub(crate) fn apply_hit(&mut self, power: f32, fire_wound: bool) {
        if let Some(condition) = &mut self.condition {
            condition.apply_hit(power, fire_wound);
            self.health = condition.health_points();
        } else {
            self.health = self.health.saturating_sub((power * 100.0).round() as u16);
        }
    }
    pub fn cancel_aim(&mut self) {
        self.aim = None;
    }
    fn active_aim(&self, tick: u32) -> Option<(AimProfile, u32)> {
        self.aim.filter(|(profile, _)| {
            self.health > 0 && !self.travelling && self.loadout.aim == Some(*profile)
                && tick.wrapping_sub(self.input_tick) <= INPUT_TIMEOUT_TICKS
        })
    }
    pub(crate) fn shot_turn_speed(&self, tick: u32, direction: Vector) -> f32 {
        let age = tick.wrapping_sub(self.input_tick);
        if self.input.is_none() || age > INPUT_TIMEOUT_TICKS {
            return 0.0;
        }
        let sampled = if age <= 1 { self.turn_speed } else { 0.0 };
        // The reliable shot can arrive before the corresponding state sample.
        // Ignore the difference introduced by the state packet's quantized pitch.
        let change = (direction - self.look).length();
        let pending = if change > 0.0001 {
            change * TICK_HZ as f32 / age.max(1) as f32
        } else {
            0.0
        };
        sampled.max(pending)
    }
    pub fn last_input(&self) -> u32 {
        self.input.map_or(0, |i| i.sequence)
    }
    pub fn moving_input(&self, tick: u32) -> bool {
        self.input.is_some_and(|input| {
            (input.x != 0.0 || input.z != 0.0)
                && tick.wrapping_sub(self.input_tick) <= INPUT_TIMEOUT_TICKS
        })
    }
    pub(crate) fn combat_locked(&self, tick: u32, duration: u32) -> bool {
        self.combat_ticks_left(tick, duration) != 0
    }
    pub fn combat_ticks_left(&self, tick: u32, duration: u32) -> u32 {
        self.last_pvp_hit.map_or(0, |hit| duration.saturating_sub(tick.wrapping_sub(hit)))
    }
    fn protected(&self, zones: &[SafeZone], tick: u32, duration: u32) -> bool {
        !self.combat_locked(tick, duration) && zones.iter().any(|zone| zone.contains(self.position))
    }
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(transparent)]
pub struct SafeZone(pub(crate) Volume);
impl SafeZone {
    pub fn sphere(center: Vec3, radius: f32) -> Self {
        Self(Volume::sphere(Vector::new(center.x, center.y, center.z), radius))
    }

    pub fn contains(&self, p: Vec3) -> bool {
        self.0.contains(Vector::new(p.x, p.y, p.z))
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
    pub native_motion: Option<crate::alife_npcs::NpcMotion>,
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
    pub survival_tuning: Option<crate::survival::Tuning>,
    pub environment_fields: Option<crate::environment::Fields>,
    pub environment_hits: Vec<(u32, Vec<crate::environment::Pulse>)>,
    pub combat_lock_ticks: u32,
}
impl World {
    pub fn new() -> Self {
        Self {
            safe_zones: vec![SafeZone::sphere(Vec3::default(), 10.0)],
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
                condition: None,
                loadout: Loadout::default(),
                appearance: Default::default(),
                native: None,
                character_key: None,
                armour_revision: 0,
                travelling: false,
                incarnation: 0,
                input: None,
                look: Vector::Z,
                turn_speed: 0.0,
                aim: None,
                input_tick: self.tick,
                last_attack: None,
                last_pvp_hit: None,
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
    pub fn restore_player(&mut self, position: Vec3, yaw: f32, crouched: bool, combat_ticks: u32) -> u32 {
        let id = self.spawn(Kind::Player, position);
        let actor = self.entities.get_mut(&id).unwrap();
        actor.yaw = yaw;
        let remaining = combat_ticks.min(self.combat_lock_ticks);
        actor.last_pvp_hit = (remaining != 0)
            .then(|| self.tick.wrapping_sub(self.combat_lock_ticks - remaining));
        if let Some(character) = self.characters.get_mut(&id) {
            character.crouched = crouched;
        }
        id
    }
    pub fn clear_player_input(&mut self, id: u32) {
        if let Some(actor) = self.entities.get_mut(&id) {
            actor.input = None;
            actor.cancel_aim();
        }
        if let Some(character) = self.characters.get_mut(&id) {
            character.jump_held = false;
            character.climbing = false;
        }
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
        // The session validates this spawn against the static map at startup.
        // Reuse its resolved floor for respawn as well as first join.
        anyhow::ensure!(spawn.x.is_finite() && spawn.y.is_finite() && spawn.z.is_finite(), "invalid respawn position");
        let position = spawn;
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
        if player.condition.is_some() {
            player.set_condition(crate::survival::State::default());
        }
        player.incarnation = player.incarnation.wrapping_add(1);
        player.input = dead.input.map(|old| Input {
            sequence: old.sequence,
            x: 0.,
            z: 0.,
            yaw: 0.,
            pitch: 0.0,
            sprint: false,
            jump: false,
            crouch: false,
            walk: false,
            aiming: false,
        });
        player.input_tick = self.tick;
        player.look = Vector::Z;
        player.turn_speed = 0.0;
        player.cancel_aim();
        player.last_attack = None;
        player.last_pvp_hit = None;
        if self.collision.is_some() {
            self.characters.insert(
                id,
                Character::new(Vector::new(position.x, position.y, position.z)),
            );
        }
        Ok(corpse)
    }
    pub fn input(&mut self, id: u32, mut input: Input) -> bool {
        if !input.x.is_finite() || !input.z.is_finite() || !input.yaw.is_finite()
            || !input.pitch.is_finite() || input.pitch.abs() > 1.55
        {
            return false;
        }
        let Some(e) = self.entities.get_mut(&id) else {
            return false;
        };
        if e.kind != Kind::Player
            || e.health == 0
            || e.travelling
            || e.input
                .is_some_and(|old| !newer(input.sequence, old.sequence))
        {
            return false;
        }
        let length = input.x.hypot(input.z).max(1.0);
        input.x /= length;
        input.z /= length;
        input.yaw = input.yaw.rem_euclid(std::f32::consts::TAU);
        let climbing = self.characters.get(&id).is_some_and(|motor| motor.climbing);
        e.aim = e.loadout.aim.filter(|_| input.aiming && !climbing).map(|profile| {
            let since = e.active_aim(self.tick).map_or(self.tick, |(_, since)| since);
            (profile, since)
        });
        let look = if e.input.is_some_and(|previous| previous.yaw == input.yaw && previous.pitch == input.pitch) {
            e.look
        } else {
            look_direction(input.yaw, input.pitch)
        };
        let elapsed = self.tick.wrapping_sub(e.input_tick);
        e.turn_speed = if e.input.is_none() || elapsed > INPUT_TIMEOUT_TICKS {
            0.0
        } else {
            let speed = (look - e.look).length() * TICK_HZ as f32 / elapsed.max(1) as f32;
            if elapsed == 0 { e.turn_speed.max(speed) } else { speed }
        };
        e.look = look;
        e.input = Some(input);
        e.input_tick = self.tick;
        true
    }
    pub fn look_since(&self, id: u32, since: u32) -> Option<(f32, f32)> {
        let actor = self.entities.get(&id)?;
        let input = actor.input.filter(|_| newer(actor.input_tick, since)
            && self.tick.wrapping_sub(actor.input_tick) <= INPUT_TIMEOUT_TICKS)?;
        Some((input.yaw, input.pitch))
    }
    pub fn step(&mut self) {
        self.environment_hits.clear();
        let mut field_pulses = Vec::new();
        self.tick = self.tick.wrapping_add(1);
        self.grid.clear();
        for e in self.entities.values_mut() {
            if e.native.is_some() {
                self.grid.entry(cell(e.position)).or_default().push(e.id);
                continue;
            }
            e.velocity = Vec3::default();
            if e.travelling {
                self.grid.entry(cell(e.position)).or_default().push(e.id);
                continue;
            }
            let motion = e.condition.as_ref().zip(self.survival_tuning.as_ref())
                .map(|(state, tuning)| state.motion(tuning, e.loadout));
            let combat_locked = e.combat_locked(self.tick, self.combat_lock_ticks);
            let character = self.characters.get_mut(&e.id);
            let old_crouch = character.as_ref().is_some_and(|motor| motor.crouched);
            let input = e.input.filter(|_| {
                e.health > 0 && self.tick.wrapping_sub(e.input_tick) <= INPUT_TIMEOUT_TICKS
            });
            let aiming = e.active_aim(self.tick).is_some();
            let (mut x, mut z, mut sprint, mut jump, crouch, walk) =
                input.map_or((0., 0., false, false, old_crouch, false), |i| {
                    e.yaw = i.yaw;
                    let walk = i.walk || (aiming && !i.crouch);
                    (i.x, i.z, i.sprint && !walk && !aiming, i.jump && !aiming, i.crouch, walk)
                });
            let mut limping = false;
            if let Some(motion) = motion {
                sprint &= motion.sprint;
                limping = motion.limp_scale < 1.0;
                if !motion.walk && (x != 0.0 || z != 0.0) {
                    x = 0.0;
                    z = 0.0;
                    jump = false;
                } else {
                    x *= motion.limp_scale;
                    z *= motion.limp_scale;
                }
            }
            let mut jumped = false;
            let mut crouched = crouch;
            let mut climbing = false;
            if let (Some(map), Some(character)) = (&self.collision, character) {
                if e.health == 0 { character.climbing = false; }
                match character.step_command(map, x, z, sprint, jump, crouch, walk) {
                    Ok(started_jump) => {
                        jumped = started_jump;
                        crouched = character.crouched;
                        climbing = character.climbing;
                        let p = character.feet;
                        e.velocity = Vec3 {
                            x: (p.x - e.position.x) * TICK_HZ as f32,
                            y: character.vertical_speed,
                            z: (p.z - e.position.z) * TICK_HZ as f32,
                        };
                        e.position = Vec3 { x: p.x, y: p.y, z: p.z };
                    }
                    Err(_) => self.movement_errors += 1,
                }
            } else if input.is_some() {
                let speed = if walk { 2.0 } else if sprint { 6.0 } else { 4.0 };
                e.velocity = Vec3 { x: x * speed, y: 0.0, z: z * speed };
                e.position.x = (e.position.x + e.velocity.x / TICK_HZ as f32)
                    .clamp(-WORLD_EXTENT, WORLD_EXTENT);
                e.position.z = (e.position.z + e.velocity.z / TICK_HZ as f32)
                    .clamp(-WORLD_EXTENT, WORLD_EXTENT);
            }
            if climbing {
                e.cancel_aim();
            }
            if let (Some(condition), Some(tuning)) = (&mut e.condition, &self.survival_tuning) {
                let activity = if climbing && e.velocity.y.abs() > 0.01 {
                    Activity::Walking
                } else if e.velocity.x.hypot(e.velocity.z) <= 0.01 {
                    Activity::Standing
                } else if limping || walk {
                    Activity::Walking
                } else if sprint && !crouched {
                    Activity::Sprinting
                } else {
                    Activity::Running
                };
                let protected = !combat_locked && self.safe_zones.iter().any(|zone| zone.contains(e.position));
                // Stagger the original 100 ms pulses across the 30 Hz ticks.
                if !protected && e.health > 0 && self.tick.wrapping_add(e.id).is_multiple_of(TICK_HZ / 10)
                    && let Some(fields) = &self.environment_fields
                {
                    let feet = Vector::new(e.position.x, e.position.y, e.position.z);
                    field_pulses.extend(fields.sample(feet, if crouched { 1.2 } else { 1.8 }));
                    if !field_pulses.is_empty() {
                        let mut protection = e.loadout.fields;
                        let mut exposed = condition.clone();
                        fields.factors.apply_all(&mut exposed, &mut protection, &field_pulses);
                        let durable = e.character_key.is_some() && (exposed.health == 0.0
                            || field_pulses.iter().any(|hit| e.loadout.fields.armour.needs_wear(hit.kind)));
                        if durable {
                            self.environment_hits.push((e.id, std::mem::take(&mut field_pulses)));
                        } else {
                            *condition = exposed;
                            field_pulses.clear();
                        }
                    }
                }
                condition.step(tuning, e.loadout, 1.0 / TICK_HZ as f32, activity, jumped, protected);
                e.health = condition.health_points();
            }
            self.grid.entry(cell(e.position)).or_default().push(e.id);
        }
    }

    pub fn apply_field_overflow(&mut self, id: u32, pulses: &[crate::environment::Pulse]) {
        if let (Some(fields), Some(actor)) = (&self.environment_fields, self.entities.get_mut(&id))
            && let Some(condition) = &mut actor.condition
        {
            let mut protection = actor.loadout.fields;
            fields.factors.apply_all(condition, &mut protection, pulses);
            actor.health = condition.health_points();
        }
    }
    pub(crate) fn step_electras(&mut self, bolts: impl Iterator<Item = (u32, Vector)>, effects: &mut Vec<crate::combat::Detonation>) {
        let Some(mut fields) = self.environment_fields.take() else { return; };
        let mut hits = Vec::new();
        fields.step_electras(self, bolts, effects, &mut hits);
        self.environment_fields = Some(fields);
        for (id, hit) in hits {
            if self.entities.get(&id).is_some_and(|actor| actor.character_key.is_some()) {
                self.environment_hits.push((id, vec![hit]));
            } else {
                self.apply_field_overflow(id, &[hit]);
            }
        }
    }
    pub fn capsule_height(&self, id: u32) -> f32 {
        if self.characters.get(&id).is_some_and(|c| c.crouched) {
            1.2
        } else {
            1.8
        }
    }
    pub fn is_climbing(&self, id: u32) -> bool {
        self.characters.get(&id).is_some_and(|character| character.climbing)
    }
    pub fn is_aiming(&self, id: u32) -> bool {
        self.entities.get(&id).and_then(|actor| actor.active_aim(self.tick)).is_some()
    }
    pub(crate) fn raised_aim(&self, id: u32) -> Option<AimProfile> {
        let (profile, since) = self.entities.get(&id)?.active_aim(self.tick)?;
        (self.tick.wrapping_sub(since) >= u32::from(profile.raise_ticks)).then_some(profile)
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
    pub(crate) fn bullet_surface(&self, origin: Vector, direction: Vector, distance: f32)
        -> anyhow::Result<Option<crate::collision::BulletSurface>>
    {
        self.collision.as_ref().map_or(Ok(None), |map| map.bullet_surface(origin, direction, distance))
    }
    pub(crate) fn bullet_outside_level(&self, point: Vector) -> bool {
        self.collision.as_ref().is_some_and(|map| {
            let [x, y, z] = map.manifest.bounds.min;
            let [max_x, _, max_z] = map.manifest.bounds.max;
            point.x < x || point.y < y || point.z < z || point.x > max_x || point.z > max_z
        })
    }
    pub(crate) fn sweep_projectile(&self, origin: Vector, displacement: Vector, radius: f32)
        -> anyhow::Result<Option<parry3d::query::ShapeCastHit>>
    {
        self.collision.as_ref().map_or(Ok(None), |map| map.sweep_projectile(origin, displacement, radius))
    }
    pub(crate) fn native_corpse_anchor(&self, mut position: [f64; 3]) -> [f64; 3] {
        // The native ragdoll root can settle below the floor. Use nearby
        // walkable support so the ordinary loot sight ray reaches the corpse.
        let [x, y, z] = position.map(|axis| axis as f32);
        if let Some(map) = &self.collision
            && let Ok(floor) = map.spawn_feet_near(x, y + 0.75, z)
            && floor.y > y
        {
            position[1] = f64::from(floor.y);
        }
        position
    }
    pub(crate) fn blast_transmission(&self, origin: Vector, direction: Vector, distance: f32) -> f32 {
        self.collision.as_ref().map_or(1.0, |map| {
            map.blast_transmission(origin, direction, distance).unwrap_or(0.0)
        })
    }
    pub(crate) fn entities_near(&self, center: Vector, radius: f32) -> impl Iterator<Item = &Entity> {
        let min = cell(Vec3 { x: center.x - radius, y: center.y, z: center.z - radius });
        let max = cell(Vec3 { x: center.x + radius, y: center.y, z: center.z + radius });
        (min.0..=max.0)
            .flat_map(move |x| (min.1..=max.1).map(move |z| (x, z)))
            .filter_map(|cell| self.grid.get(&cell))
            .flatten()
            .filter_map(|id| self.entities.get(id))
    }
    pub fn is_safe(&self, p: Vec3) -> bool {
        self.safe_zones.iter().any(|z| z.contains(p))
    }
    pub fn is_protected(&self, actor: &Entity) -> bool {
        actor.protected(&self.safe_zones, self.tick, self.combat_lock_ticks)
    }
    pub(crate) fn tag_pvp_hit(&mut self, shooter: u32, shooter_life: u32, victim: u32) {
        if self.combat_lock_ticks == 0 || self.entities[&victim].kind != Kind::Player {
            return;
        }
        self.entities.get_mut(&victim).unwrap().last_pvp_hit = Some(self.tick);
        if let Some(actor) = self.entities.get_mut(&shooter)
            && actor.incarnation == shooter_life && actor.health > 0
        {
            actor.last_pvp_hit = Some(self.tick);
        }
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
        if attacker == target || b.native.is_some() {
            return DamageResult::InvalidTarget;
        }
        if a.health == 0 || b.health == 0 || a.travelling || b.travelling {
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
        victim.damage(25, false);
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
                            native_motion: e.native.as_ref().and_then(|npc| npc.motion),
                            flags: u8::from(self.is_protected(e))
                                | self.characters.get(&e.id).map_or(0, |c| {
                                    u8::from(c.grounded) * 2
                                        + u8::from(c.crouched) * 4
                                        + u8::from(c.jump_held) * 8
                                        + u8::from(c.climbing) * 16
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_corpse_anchor_raises_a_sunken_root_to_nearby_floor() {
        let world = World::with_collision(Arc::new(crate::collision::tests::actor_fixture(0))).unwrap();
        let below = [0.0, -0.3, -1.0];
        let anchor = world.native_corpse_anchor(below);
        assert!(anchor[1] > 0.0 && anchor[1] < 0.02, "{anchor:?}");
        assert_eq!(world.native_corpse_anchor([0.0, 0.1, -1.0]), [0.0, 0.1, -1.0]);
        assert_eq!(world.native_corpse_anchor([0.0, -1.0, -1.0]), [0.0, -1.0, -1.0]);
    }

    #[test]
    fn world_applies_collision_and_stops_stale_input() {
        let map = Arc::new(crate::collision::tests::step_fixture(0.8, false));
        let mut world = World::with_collision(map).unwrap();
        let id = world.spawn_on_map(Kind::Player, 0., 0.).unwrap();
        for sequence in 1..31 {
            assert!(world.input(
                id,
                Input {
                    sequence,
                    x: 1.,
                    z: 0.,
                    yaw: 0.,
                    pitch: 0.0,
                    sprint: true,
                    jump: false,
                    crouch: false,
                    walk: false,
                    aiming: false,
                }
            ));
            world.step();
        }
        assert!(world.entities[&id].position.x < 0.66);
        assert_eq!(world.movement_errors, 0);
        assert!(world.input(
            id,
            Input {
                sequence: 31,
                x: -1.,
                z: 0.,
                yaw: 0.,
                pitch: 0.0,
                sprint: false,
                jump: false,
                crouch: false,
                walk: false,
                aiming: false,
            }
        ));
        for _ in 0..INPUT_TIMEOUT_TICKS + 2 {
            world.step();
        }
        let x = world.entities[&id].position.x;
        for _ in 0..10 {
            world.step();
        }
        assert!((world.entities[&id].position.x - x).abs() < 0.001);
        assert!(world.visible_to(id)[0].position.y > 0.);
        world.remove(id);
        assert!(world.entities.is_empty());
        world.step();
    }
}
