//! Server-owned firearm traces, bounded rewind and ammunition.
use crate::{alife_attacks::{NativeAttack, NativeDamage}, alife_npcs::{NativeBounds, NativeTarget, rotate_yaw}, projectile::{LaunchPose, Projectiles}, world::{CharacterKey, Kind, Vec3, World}};
use crate::ballistics::{Flight, MAX_SURFACE_CONTACTS, MaterialFlight, RoundProfile, Spread};
pub use crate::projectile::{DamageContact, Detonation, LaunchSpec};
use parry3d::{
    math::Vector,
    query::{PointQuery, Ray, RayCast},
    shape::{Capsule, Cuboid},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque, hash_map::RandomState},
    hash::BuildHasher,
    sync::Arc,
};
const REWIND_TICKS: u32 = 6;
const FIRE_INTERVAL: u32 = 6;
const RANGE: f32 = 150.;
/// Upper bound for validated weapon/ammunition range in the catalog.
pub const MAX_OWNED_RANGE: f32 = 4096.;
const RELOAD_TICKS: u32 = 90;
#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Aim {
    pub tick: u32,
    pub yaw: f32,
    pub pitch: f32,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShotResult {
    Rejected { reason: &'static str },
    Miss { ammo: u16 },
    Blocked { ammo: u16 },
    Protected { ammo: u16 },
    Launched { ammo: u16 },
    Hit { target: u32, health: u16, ammo: u16 },
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponView {
    pub ammo: u16,
    pub reserve: u16,
    pub reload_ready_tick: Option<u32>,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ReloadResult {
    Rejected { reason: &'static str },
    Started { ready_tick: u32 },
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RespawnResult {
    Rejected { reason: &'static str },
    Respawned { corpse: u32 },
}
#[derive(Clone)]
struct Pose {
    id: u32,
    feet: Vec3,
    height: f32,
    speed: f32,
    yaw: f32,
    alive: bool,
    incarnation: u32,
    combat_locked: bool,
    raised_aim: Option<crate::survival::AimProfile>,
    native: Option<(NativeTarget, NativeBounds)>,
}
struct Frame {
    tick: u32,
    poses: Arc<[Pose]>,
}
/// Owns the rewind frame while SQLite commits the shot's ammunition debit.
pub struct PreparedShot {
    shooter: u32,
    shooter_life: u32,
    origin: Vector,
    direction: Vector,
    speed: f32,
    crouched: bool,
    aimed: bool,
    wall: Option<f32>,
    poses: Arc<[Pose]>,
    launch_slot: Option<Arc<()>>,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct ChargedShot {
    pub ammo: u16,
    pub range: f32,
    pub damage: u16,
    pub interval: u32,
    pub mass_spent: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub power_loss: f32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<QueueRound>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armour: Option<ArmourImpact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_commit: Option<crate::survival::ImpactCommit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher: Option<LaunchSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_damage: Option<NativeDamage>,
}

fn is_zero(value: &f32) -> bool { *value == 0.0 }

#[derive(Clone, Copy, Default)]
pub struct FireState {
    pub queue_index: Option<u32>,
    pub traced: Option<RoundProfile>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct QueueRound {
    pub limit: Option<u8>,
    pub ticks: f64,
}

#[derive(Debug, Deserialize, Serialize)]
pub enum ArmourImpact {
    Stale,
    Hit {
        power: f32,
        wound: bool,
        gear_changed: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        field_armour: Option<crate::environment::Armour>,
    },
}

/// The simulation selects the target and region from its rewind frame. A
/// client command cannot provide these fields or an armour inventory ID.
#[derive(Clone)]
pub struct ShotTarget {
    pub character: CharacterKey,
    pub bone: &'static str,
    pub distance: f32,
    pub speed_factor: f32,
    pub penetration: Option<f32>,
}

enum Impact {
    Miss,
    Blocked,
    Protected,
    Native { id: u32, target: NativeTarget, direction: Vector, offset: Vector },
    Hit {
        target: u32,
        incarnation: u32,
        bone: &'static str,
    },
}

struct TraceContact {
    distance: f32,
    speed_factor: f32,
    penetration: Option<f32>,
    impact: Impact,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct VolleyImpact {
    pub applied_pellets: u8,
    pub damaged: bool,
    pub health: f32,
    pub bleeding: f32,
    pub field_armour: Option<crate::environment::Armour>,
    pub commit: crate::survival::ImpactCommit,
}

pub struct TracedShot {
    shooter: u32,
    shooter_life: u32,
    origin: Vector,
    contact: TraceContact,
    pellets: Vec<TraceContact>,
    launch: Option<LaunchPose>,
    pub knife_splash: bool,
    pub ballistics: Option<RoundProfile>,
}

impl TracedShot {
    pub fn firing_origin(&self) -> (u32, Vec3) {
        let [x, y, z] = self.origin.to_array();
        (self.shooter, Vec3 { x, y, z })
    }

    pub fn target(&self) -> Option<u32> {
        self.targets().next()
    }

    fn contacts(&self) -> impl Iterator<Item = &TraceContact> {
        std::iter::once(&self.contact).chain(&self.pellets)
    }

    pub fn targets(&self) -> impl Iterator<Item = u32> {
        self.contacts().filter_map(|contact| match contact.impact {
            Impact::Hit { target, .. } => Some(target),
            _ => None,
        })
    }

    pub fn native_attacks<'a>(&'a self, world: &'a World, charge: &'a ChargedShot) -> impl Iterator<Item = NativeAttack> + 'a {
        self.contacts().filter_map(move |contact| self.native_attack(world, charge, contact))
    }

    fn native_attack(&self, world: &World, charge: &ChargedShot, contact: &TraceContact) -> Option<NativeAttack> {
        let Impact::Native { id, target, direction, offset } = contact.impact else { return None; };
        if charge.launcher.is_some() || contact.distance > charge.range { return None; }
        let entity = world.entities.get(&id)?;
        if entity.health == 0 || entity.native.as_ref()?.target != target || world.is_protected(entity) { return None; }
        let mut damage = charge.native_damage?;
        damage.power = damage.power.map(|power| power * contact.speed_factor);
        damage.impulse *= contact.speed_factor;
        if let Some(penetration) = contact.penetration { damage.penetration = penetration; }
        Some(NativeAttack { target_id: id, target, shooter: self.shooter, life: self.shooter_life,
            damage, direction: direction.to_array(), offset: offset.to_array() })
    }

    pub fn armour_target(&self, world: &World) -> Option<ShotTarget> {
        self.armour_targets(world).next().map(|(_, target)| target)
    }

    pub fn armour_targets<'a>(&'a self, world: &'a World) -> impl Iterator<Item = (u32, ShotTarget)> + 'a {
        self.contacts().filter_map(|contact| {
            let Impact::Hit { target, incarnation, bone } = contact.impact else { return None; };
            let actor = world.entities.get(&target)?;
            if actor.incarnation != incarnation || actor.health == 0 || actor.travelling { return None; }
            Some((target, ShotTarget { character: actor.character_key.clone()?, bone,
                distance: contact.distance, speed_factor: contact.speed_factor, penetration: contact.penetration }))
        })
    }

    pub fn volley_miss(&self, ammo: u16) -> ShotResult {
        if self.contacts().any(|contact| matches!(contact.impact, Impact::Protected)) { return ShotResult::Protected { ammo }; }
        if self.contacts().any(|contact| matches!(contact.impact, Impact::Blocked)) { return ShotResult::Blocked { ammo }; }
        ShotResult::Miss { ammo }
    }
}

// The rewind motor currently exposes a capsule, not the animated bone mesh.
// Map its contact into the corresponding CoP protection-table region. Posture
// comes from the rewound height and left/right from the rewound facing.
fn hit_bone(pose: &Pose, contact: Vector) -> &'static str {
    let height = (contact.y - pose.feet.y) / pose.height;
    let lateral =
        (contact.x - pose.feet.x) * pose.yaw.cos() - (contact.z - pose.feet.z) * pose.yaw.sin();
    if height >= 0.83 {
        return "bip01_head";
    }
    if height >= 0.76 {
        return "bip01_neck";
    }
    if height >= 0.50 && lateral.abs() >= 0.23 {
        return if lateral < 0.0 {
            "bip01_l_upperarm"
        } else {
            "bip01_r_upperarm"
        };
    }
    if height >= 0.68 {
        return "bip01_spine2";
    }
    if height >= 0.59 {
        return "bip01_spine1";
    }
    if height >= 0.50 {
        return "bip01_spine";
    }
    if height >= 0.42 {
        return "bip01_pelvis";
    }
    match (height, lateral < 0.0) {
        (h, true) if h >= 0.24 => "bip01_l_thigh",
        (h, false) if h >= 0.24 => "bip01_r_thigh",
        (h, true) if h >= 0.09 => "bip01_l_calf",
        (h, false) if h >= 0.09 => "bip01_r_calf",
        (_, true) => "bip01_l_foot",
        (_, false) => "bip01_r_foot",
    }
}
#[derive(Default)]
pub struct Combat {
    history: VecDeque<Frame>,
    weapons: BTreeMap<u32, Weapon>,
    deaths: BTreeMap<u32, u32>,
    corpses: BTreeMap<u32, u32>,
    projectiles: Projectiles,
}
struct Weapon {
    ammo: u16,
    last_shot: Option<u32>,
    reserve: u16,
    reload_started: Option<u32>,
}
impl Default for Weapon {
    fn default() -> Self {
        Self {
            ammo: 30,
            last_shot: None,
            reserve: 90,
            reload_started: None,
        }
    }
}
impl Combat {
    pub fn capture(&mut self, world: &World) {
        if self.history.back().is_some_and(|f| f.tick == world.tick) {
            return;
        }
        self.deaths
            .retain(|id, _| world.entities.get(id).is_some_and(|e| e.health == 0));
        for e in world
            .entities
            .values()
            .filter(|e| e.kind == Kind::Player && e.health == 0)
        {
            self.deaths.entry(e.id).or_insert(world.tick);
        }
        self.history.push_back(Frame {
            tick: world.tick,
            poses: world
                .entities
                .values()
                .map(|e| Pose {
                    id: e.id,
                    feet: e.position,
                    height: world.capsule_height(e.id),
                    speed: Vector::new(e.velocity.x, e.velocity.y, e.velocity.z).length(),
                    yaw: e.yaw,
                    alive: e.health > 0 && !e.travelling,
                    incarnation: e.incarnation,
                    combat_locked: e.combat_locked(world.tick, world.combat_lock_ticks),
                    raised_aim: world.raised_aim(e.id),
                    native: e.native.as_ref().map(|npc| (npc.target, npc.bounds)),
                })
                .collect(),
        });
        while self.history.len() > REWIND_TICKS as usize + 1 {
            self.history.pop_front();
        }
        self.weapons.retain(|id, _| world.entities.contains_key(id));
        for (id, weapon) in &mut self.weapons {
            if world.entities[id].health == 0 {
                weapon.reload_started = None;
            }
            if weapon
                .reload_started
                .is_some_and(|t| world.tick.wrapping_sub(t) >= RELOAD_TICKS)
            {
                let rounds = (30 - weapon.ammo).min(weapon.reserve);
                weapon.ammo += rounds;
                weapon.reserve -= rounds;
                weapon.reload_started = None;
            }
        }
    }
    pub fn weapon(&self, id: u32) -> WeaponView {
        let fallback = Weapon::default();
        let w = self.weapons.get(&id).unwrap_or(&fallback);
        WeaponView {
            ammo: w.ammo,
            reserve: w.reserve,
            reload_ready_tick: w.reload_started.map(|t| t.wrapping_add(RELOAD_TICKS)),
        }
    }
    pub fn reload(&mut self, world: &World, player: u32) -> ReloadResult {
        if !world
            .entities
            .get(&player)
            .is_some_and(|e| e.kind == Kind::Player && e.health > 0)
        {
            return ReloadResult::Rejected { reason: "dead" };
        }
        let w = self.weapons.entry(player).or_default();
        let reason = if w.reload_started.is_some() {
            Some("reloading")
        } else if w.ammo == 30 {
            Some("full")
        } else if w.reserve == 0 {
            Some("empty_reserve")
        } else {
            None
        };
        if let Some(reason) = reason {
            return ReloadResult::Rejected { reason };
        }
        w.reload_started = Some(world.tick);
        ReloadResult::Started {
            ready_tick: world.tick.wrapping_add(RELOAD_TICKS),
        }
    }
    pub fn expire_corpses(&mut self, world: &mut World) {
        self.corpses.retain(|id, at| {
            if world.tick.wrapping_sub(*at) >= 900 {
                world.remove(*id);
                false
            } else {
                world.entities.contains_key(id)
            }
        });
    }
    pub fn respawn(&mut self, world: &mut World, player: u32, spawn: Vec3) -> RespawnResult {
        if !world
            .entities
            .get(&player)
            .is_some_and(|e| e.kind == Kind::Player && e.health == 0)
        {
            return RespawnResult::Rejected { reason: "alive" };
        }
        if self
            .deaths
            .get(&player)
            .is_none_or(|t| world.tick.wrapping_sub(*t) < 90)
        {
            return RespawnResult::Rejected {
                reason: "respawn_delay",
            };
        }
        self.respawn_authorized(world, player, spawn)
    }
    /// Survival mode calls this only after durable death/delay/kit grant commits.
    /// It also works after restart, when the fixture's in-memory death timer is gone.
    pub fn respawn_authorized(
        &mut self,
        world: &mut World,
        player: u32,
        spawn: Vec3,
    ) -> RespawnResult {
        let corpse = match world.respawn(player, spawn) {
            Ok(id) => id,
            Err(_) => {
                return RespawnResult::Rejected {
                    reason: "invalid_spawn",
                };
            }
        };
        self.corpses.insert(corpse, world.tick);
        self.deaths.remove(&player);
        self.weapons.remove(&player);
        RespawnResult::Respawned { corpse }
    }
    pub fn fire(&mut self, world: &mut World, shooter: u32, aim: Aim) -> ShotResult {
        let reject = |reason| ShotResult::Rejected { reason };
        let shot = match self.prepare_shot(world, shooter, aim, RANGE) {
            Ok(shot) => shot,
            Err(reason) => return reject(reason),
        };
        let weapon = self.weapons.entry(shooter).or_default();
        if weapon.reload_started.is_some() {
            return reject("reloading");
        }
        if weapon
            .last_shot
            .is_some_and(|t| world.tick.wrapping_sub(t) < FIRE_INTERVAL)
        {
            return reject("cooldown");
        }
        if weapon.ammo == 0 {
            return reject("empty");
        }
        weapon.ammo -= 1;
        weapon.last_shot = Some(world.tick);
        let ammo = weapon.ammo;
        self.resolve_shot(world, shot, RANGE, 35, ammo)
    }

    pub fn prepare_shot(
        &self,
        world: &World,
        shooter: u32,
        aim: Aim,
        range: f32,
    ) -> Result<PreparedShot, &'static str> {
        let mut shot = self.rewind_aim(world, shooter, aim)?;
        shot.wall = world.static_ray(shot.origin, shot.direction, range).map_err(|_| "collision_error")?;
        Ok(shot)
    }

    fn rewind_aim(&self, world: &World, shooter: u32, aim: Aim) -> Result<PreparedShot, &'static str> {
        if !aim.yaw.is_finite() || !aim.pitch.is_finite() || aim.pitch.abs() > 1.55 {
            return Err("invalid_aim");
        }
        if world.tick.wrapping_sub(aim.tick) > REWIND_TICKS {
            return Err("invalid_tick");
        }
        let Some(current) = world.entities.get(&shooter) else {
            return Err("invalid_shooter");
        };
        if current.kind != Kind::Player || current.health == 0 || current.travelling {
            return Err("dead");
        }
        let Some(frame) = self.history.iter().find(|f| f.tick == aim.tick) else {
            return Err("missing_history");
        };
        let Some(origin_pose) = frame
            .poses
            .iter()
            .find(|p| p.id == shooter && p.alive && p.incarnation == current.incarnation)
        else {
            return Err("missing_history");
        };
        if world.is_safe(current.position) || world.is_safe(origin_pose.feet) {
            return Err("safe_zone");
        }
        let direction = crate::world::look_direction(aim.yaw.rem_euclid(std::f32::consts::TAU), aim.pitch);
        let origin = Vector::new(
            origin_pose.feet.x,
            origin_pose.feet.y + origin_pose.height - 0.25,
            origin_pose.feet.z,
        );
        Ok(PreparedShot {
            shooter,
            shooter_life: origin_pose.incarnation,
            origin,
            direction,
            speed: origin_pose.speed,
            crouched: origin_pose.height < 1.8,
            aimed: origin_pose.raised_aim.is_some() && origin_pose.raised_aim == current.loadout.aim,
            wall: None,
            poses: frame.poses.clone(),
            launch_slot: None,
        })
    }

    pub fn prepare_owned_shot(&self, world: &World, shooter: u32, aim: Aim) -> Result<PreparedShot, &'static str> {
        let mut shot = self.prepare_shot(world, shooter, aim, MAX_OWNED_RANGE)?;
        shot.launch_slot = Some(self.projectiles.reserve()?);
        Ok(shot)
    }

    pub fn trace_owned_round(&self, world: &World, shooter: u32, aim: Aim, followup: bool) -> Result<TracedShot, &'static str> {
        let round = world.entities.get(&shooter).and_then(|actor| actor.loadout.ballistics.map(|profile| (actor, profile)));
        let Some((actor, profile)) = round else {
            let shot = self.prepare_owned_shot(world, shooter, aim)?;
            return Ok(self.trace_shot(world, shot, MAX_OWNED_RANGE));
        };
        let mut shot = self.rewind_aim(world, shooter, aim)?;
        let origin = shot.origin;
        let direction = shot.direction;
        let turn_speed = actor.shot_turn_speed(world.tick, direction);
        let cone = profile.spread.cone(shot.speed, turn_speed, shot.crouched, followup, shot.aimed);
        tracing::trace!(shooter, tick=world.tick, shot.aimed, turn_speed, cone, "traced firearm dispersion");
        let mut spread = Spread::new(RandomState::new().hash_one((shooter, world.tick, profile.revision)));
        let contact = self.trace_flight(world, &mut shot, origin, spread.direction(direction, cone), profile, &mut spread)?;
        let mut pellets = Vec::with_capacity(usize::from(profile.pellets - 1));
        for _ in 1..profile.pellets {
            pellets.push(self.trace_flight(world, &mut shot, origin, spread.direction(direction, cone), profile, &mut spread)?);
        }
        shot.origin = origin;
        let mut result = Self::traced(shot, (f32::INFINITY, Impact::Miss));
        result.contact = contact;
        result.pellets = pellets;
        result.ballistics = Some(profile);
        Ok(result)
    }

    fn trace_flight(&self, world: &World, shot: &mut PreparedShot, origin: Vector, direction: Vector, profile: RoundProfile, spread: &mut Spread)
        -> Result<TraceContact, &'static str>
    {
        let mut travelled = 0.0;
        let mut contacts = 0;
        let mut flight = Flight::new(origin, direction, profile);
        let mut material = MaterialFlight::new(profile.surface);
        while let Some(segment) = flight.next() {
            shot.origin = segment.start;
            shot.direction = segment.direction;
            let surface = world.bullet_surface(segment.start, segment.direction, segment.range).map_err(|_| "collision_error")?;
            shot.wall = surface.map(|hit| hit.distance);
            let (distance, mut impact) = self.trace(shot, world, segment.range);
            if !matches!(impact, Impact::Miss) {
                let velocity = segment.impact_velocity(distance);
                if matches!(impact, Impact::Blocked) && contacts < MAX_SURFACE_CONTACTS
                    && let Some(surface) = surface
                    && let Some(outgoing) = material.cross(surface, segment.start + segment.direction * distance,
                        velocity, profile.drag, spread).filter(|velocity| velocity.length_squared() >= 1.0)
                {
                    travelled += distance + flight.resume(&segment, distance, outgoing);
                    contacts += 1;
                    continue;
                }
                if let Impact::Native { direction, .. } = &mut impact {
                    *direction = velocity.try_normalize().unwrap_or(segment.direction);
                }
                return Ok(TraceContact { distance: (travelled + distance).min(profile.range),
                    speed_factor: velocity.length() / profile.speed,
                    penetration: profile.surface.magnetic.then_some(material.penetration), impact });
            }
            if world.bullet_outside_level(segment.start + segment.direction * segment.range) { break; }
            travelled += segment.range;
        }
        Ok(TraceContact { distance: f32::INFINITY, speed_factor: 1.0, penetration: None, impact: Impact::Miss })
    }

    pub fn prepare_hand_throw(&self, world: &World, shooter: u32, aim: Aim, bolt: bool) -> Result<TracedShot, &'static str> {
        let shot = self.rewind_aim(world, shooter, aim)?;
        let velocity = world.entities[&shooter].velocity;
        let slot = if bolt { self.projectiles.reserve_bolt()? } else { self.projectiles.reserve()? };
        Ok(TracedShot {
            shooter, shooter_life: shot.shooter_life, origin: shot.origin,
            contact: TraceContact { distance: f32::INFINITY, speed_factor: 1.0, penetration: None, impact: Impact::Miss },
            pellets: Vec::new(),
            launch: Some(LaunchPose { slot, origin: shot.origin,
                direction: shot.direction, inherited_velocity: Vector::new(velocity.x, velocity.y, velocity.z) }),
            knife_splash: false,
            ballistics: None,
        })
    }

    pub fn validate_attack_aim(&self, world: &World, shooter: u32, aim: Aim) -> Result<(), &'static str> {
        self.rewind_aim(world, shooter, aim).map(|_| ())
    }

    pub fn trace_knife(
        &self, world: &World, shooter: u32, aim: Aim, profile: &crate::knife::Profile,
    ) -> Result<TracedShot, &'static str> {
        let mut shot = self.prepare_shot(world, shooter, aim, profile.range())?;
        let direct = self.trace(&shot, world, profile.reach);
        if matches!(direct.1, Impact::Hit { .. } | Impact::Native { .. } | Impact::Protected) {
            return Ok(Self::traced(shot, direct));
        }

        // CoP's two stock attack hit types are both wound. Its splash path
        // therefore selects the nearest victim for either attack.
        let right = Vector::new(shot.direction.z, 0.0, -shot.direction.x).normalize();
        let up = shot.direction.cross(right);
        let [x, y, z] = profile.direction;
        let center = shot.origin + (right * x + up * y + shot.direction * z) * profile.reach;
        let mut candidate = None;
        for pose in shot.poses.iter().filter(|pose| Self::targetable(world, shooter, pose)) {
            let origin = Vector::new(pose.feet.x, pose.feet.y, pose.feet.z);
            let (aim, body_center) = if let Some((_, bounds)) = pose.native {
                let body_center = bounds.world_center(origin, pose.yaw);
                let local = rotate_yaw(center - body_center, -pose.yaw);
                let nearest = Cuboid::new(Vector::from_array(bounds.half)).project_local_point(local, true).point;
                if local.distance_squared(nearest) > profile.radius.powi(2) { continue; }
                (body_center + rotate_yaw(nearest, pose.yaw), body_center)
            } else {
                let axis = Vector::new(pose.feet.x, center.y.clamp(pose.feet.y + 0.35, pose.feet.y + pose.height - 0.35), pose.feet.z);
                if axis.distance_squared(center) > (profile.radius + 0.35).powi(2) { continue; }
                (axis, origin + Vector::Y * pose.height * 0.5)
            };
            let distance = body_center.distance_squared(center);
            if candidate.is_none_or(|(closest, _, _)| distance < closest) {
                candidate = Some((distance, aim, pose.id));
            }
        }
        if let Some((_, axis, id)) = candidate
            && let Some(direction) = (axis - shot.origin).try_normalize()
        {
            shot.direction = direction;
            shot.wall = world.static_ray(shot.origin, direction, profile.range()).map_err(|_| "collision_error")?;
            let contact = self.trace(&shot, world, profile.range());
            let splash = matches!(contact.1, Impact::Hit { target, .. } | Impact::Native { id: target, .. } if target == id);
            let mut result = Self::traced(shot, contact);
            result.knife_splash = splash;
            return Ok(result);
        }
        let fallback = self.trace(&shot, world, profile.range());
        Ok(Self::traced(shot, fallback))
    }

    pub fn step_projectiles(&mut self, world: &mut World) -> Vec<Detonation> {
        let mut effects = self.projectiles.step(world);
        world.step_electras(self.projectiles.bolts(), &mut effects);
        effects
    }

    pub fn grenade_view(&self, observer: Vec3) -> Vec<(u32, &str, f32, f32, f32)> {
        self.projectiles.view(observer)
    }

    pub fn trace_shot(&self, world: &World, shot: PreparedShot, range: f32) -> TracedShot {
        let contact = self.trace(&shot, world, range);
        Self::traced(shot, contact)
    }

    fn traced(shot: PreparedShot, (distance, impact): (f32, Impact)) -> TracedShot {
        TracedShot {
            shooter: shot.shooter,
            shooter_life: shot.shooter_life,
            origin: shot.origin,
            contact: TraceContact { distance, speed_factor: 1.0, penetration: None, impact },
            pellets: Vec::new(),
            launch: shot.launch_slot.map(|slot| LaunchPose {
                slot, origin: shot.origin, direction: shot.direction,
                inherited_velocity: Vector::ZERO,
            }),
            knife_splash: false,
            ballistics: None,
        }
    }

    fn targetable(world: &World, shooter: u32, pose: &Pose) -> bool {
        pose.id != shooter && pose.alive && !world.persistent_ids.contains_key(&pose.id)
            && world.entities.get(&pose.id).is_some_and(|e| e.health > 0 && !e.travelling && e.incarnation == pose.incarnation)
    }

    fn trace(&self, shot: &PreparedShot, world: &World, range: f32) -> (f32, Impact) {
        let mut hit: Option<(f32, &Pose)> = None;
        let limit = range.min(shot.wall.unwrap_or(range));
        for pose in shot.poses.iter().filter(|pose| pose.alive && pose.id != shot.shooter) {
            let origin = Vector::new(pose.feet.x, pose.feet.y, pose.feet.z);
            let (center, radius_squared) = match pose.native {
                Some((_, bounds)) => (bounds.world_center(origin, pose.yaw), Vector::from_array(bounds.half).length_squared()),
                None => (origin + Vector::Y * pose.height * 0.5, (pose.height * 0.5).powi(2)),
            };
            let to_center = center - shot.origin;
            let distance = hit.map_or(limit, |(nearest, _)| nearest);
            let closest = shot.direction * to_center.dot(shot.direction).clamp(0.0, distance);
            if to_center.distance_squared(closest) > radius_squared + 0.0001
                || !Self::targetable(world, shot.shooter, pose)
            {
                continue;
            }
            let contact = if let Some((_, bounds)) = pose.native {
                Cuboid::new(Vector::from_array(bounds.half)).cast_local_ray(&Ray::new(
                    rotate_yaw(-to_center, -pose.yaw), rotate_yaw(shot.direction, -pose.yaw)), distance, true)
            } else {
                Capsule::new_y(pose.height / 2. - 0.35, 0.35)
                    .cast_local_ray(&Ray::new(-to_center, shot.direction), distance, true)
            };
            if let Some(distance) = contact && hit.as_ref().is_none_or(|(old, _)| distance < *old)
            {
                hit = Some((distance, pose));
            }
        }
        if let Some(distance) = shot.wall.filter(|&distance| {
            distance <= range && hit.as_ref().is_none_or(|(body, _)| distance <= *body)
        }) {
            return (distance, Impact::Blocked);
        }
        let Some((distance, target)) = hit else {
            return (f32::INFINITY, Impact::Miss);
        };
        if (world.is_safe(target.feet) && !target.combat_locked)
            || world.is_protected(&world.entities[&target.id])
        {
            return (distance, Impact::Protected);
        }
        let contact = shot.origin + shot.direction * distance;
        if let Some((native, _)) = target.native {
            let origin = Vector::new(target.feet.x, target.feet.y, target.feet.z);
            return (distance, Impact::Native { id: target.id, target: native, direction: shot.direction,
                offset: rotate_yaw(contact - origin, -target.yaw) });
        }
        let bone = hit_bone(target, contact);
        (
            distance,
            Impact::Hit {
                target: target.id,
                incarnation: target.incarnation,
                bone,
            },
        )
    }

    pub fn resolve_shot(
        &mut self,
        world: &mut World,
        shot: PreparedShot,
        range: f32,
        damage: u16,
        ammo: u16,
    ) -> ShotResult {
        let trace = self.trace_shot(world, shot, range);
        self.resolve_owned_shot(
            world,
            trace,
            ChargedShot {
                range,
                damage,
                ammo,
                interval: 0,
                mass_spent: 0.0,
                power_loss: 0.0,
                queue: None,
                armour: None,
                target_commit: None,
                launcher: None,
                native_damage: None,
            },
        )
    }

    pub fn resolve_owned_shot(
        &mut self,
        world: &mut World,
        shot: TracedShot,
        charge: ChargedShot,
    ) -> ShotResult {
        let ammo = charge.ammo;
        if let Some(spec) = charge.launcher {
            let launch = shot.launch.expect("owned launch reserves a projectile slot before debit");
            self.projectiles.launch(shot.shooter, shot.shooter_life, launch, spec);
            return ShotResult::Launched { ammo };
        }
        if shot.contact.distance > charge.range {
            return ShotResult::Miss { ammo };
        }
        let (target, incarnation) = match shot.contact.impact {
            Impact::Miss | Impact::Native { .. } => return ShotResult::Miss { ammo },
            Impact::Blocked => return ShotResult::Blocked { ammo },
            Impact::Protected => return ShotResult::Protected { ammo },
            Impact::Hit {
                target,
                incarnation,
                ..
            } => (target, incarnation),
        };
        if world
            .entities
            .get(&target)
            .is_none_or(|entity| (entity.health == 0 && charge.target_commit.is_none()) || entity.travelling || entity.incarnation != incarnation)
        {
            return ShotResult::Miss { ammo };
        }
        let (power, wound, gear_changed, field_armour) = match charge.armour {
            Some(ArmourImpact::Stale) => return ShotResult::Miss { ammo },
            Some(ArmourImpact::Hit {
                power,
                wound,
                gear_changed,
                field_armour,
            }) => (power, wound, gear_changed, field_armour),
            None => (f32::from(charge.damage) * shot.contact.speed_factor / 100.0, true, false, None),
        };
        if power > 0.0 {
            world.tag_pvp_hit(shot.shooter, shot.shooter_life, target);
        }
        let entity = world.entities.get_mut(&target).unwrap();
        if gear_changed {
            entity.armour_revision = entity.armour_revision.wrapping_add(1);
        }
        if let Some(armour) = field_armour {
            entity.loadout.fields.armour.take_newer(armour);
        }
        entity.apply_hit(power, wound);
        if let Some(condition) = &mut entity.condition {
            condition.power = (condition.power - charge.power_loss).max(0.0);
        }
        if charge.target_commit.is_some_and(|commit| !commit.alive) {
            if let Some(condition) = &mut entity.condition { condition.health = 0.0; }
            entity.health = 0;
            entity.loadout = crate::survival::Loadout::default();
            entity.appearance = crate::lifecycle::Appearance::default();
        }
        if entity.health == 0 {
            self.deaths.insert(target, world.tick);
        }
        ShotResult::Hit {
            target,
            health: entity.health,
            ammo,
        }
    }

    pub fn apply_volley(&mut self, world: &mut World, shot: &TracedShot, target: u32, life: u32,
        impact: VolleyImpact, ammo: u16) -> Option<ShotResult>
    {
        if world.entities.get(&target).is_none_or(|actor| actor.travelling
            || actor.character_key.as_ref().is_none_or(|key| key.life != life)) {
            return None;
        }
        if impact.damaged {
            world.tag_pvp_hit(shot.shooter, shot.shooter_life, target);
        }
        let actor = world.entities.get_mut(&target).unwrap();
        if let Some(armour) = impact.field_armour {
            actor.armour_revision = actor.armour_revision.wrapping_add(1);
            actor.loadout.fields.armour.take_newer(armour);
        }
        let condition = actor.condition.as_mut()?;
        condition.health = impact.health;
        condition.bleeding = impact.bleeding;
        actor.health = condition.health_points();
        if !impact.commit.alive {
            actor.loadout = crate::survival::Loadout::default();
            actor.appearance = crate::lifecycle::Appearance::default();
        }
        if actor.health == 0 { self.deaths.insert(target, world.tick); }
        Some(ShotResult::Hit { target, health: actor.health, ammo })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (World, Combat, u32, u32) {
        let mut w = World::new();
        w.safe_zones.clear();
        let a = w.spawn(Kind::Player, Vec3::default());
        let b = w.spawn(
            Kind::Player,
            Vec3 {
                x: 0.,
                y: 0.,
                z: 10.,
            },
        );
        let mut c = Combat::default();
        c.capture(&w);
        (w, c, a, b)
    }
    fn aim(tick: u32) -> Aim {
        Aim {
            tick,
            yaw: 0.,
            pitch: 0.,
        }
    }
    #[test]
    fn raised_sight_dispersion_requires_a_continuous_aim_with_the_same_weapon() {
        use crate::{ballistics::Dispersion, survival::AimProfile, world::{Input, INPUT_TIMEOUT_TICKS}};
        let (mut world, mut combat, shooter, _) = setup();
        let input = Input {
            sequence: 1, x: 1., z: 0., yaw: 0., pitch: 0., sprint: true, jump: true,
            crouch: false, walk: false, aiming: true,
        };
        assert!(world.input(shooter, input));
        assert!(!world.is_aiming(shooter));
        let profile = AimProfile { weapon: [1; 16], raise_ticks: 8, launcher: false };
        world.entities.get_mut(&shooter).unwrap().loadout.aim = Some(profile);
        assert!(world.input(shooter, Input { sequence: 2, ..input }));
        assert!(world.is_aiming(shooter));
        for _ in 0..7 {
            world.step();
            combat.capture(&world);
        }
        let early = combat.rewind_aim(&world, shooter, aim(world.tick)).unwrap();
        assert!(!early.aimed);
        assert_eq!(early.speed, 2.);
        world.step();
        combat.capture(&world);
        let aimed_tick = world.tick;
        let raised = combat.rewind_aim(&world, shooter, aim(aimed_tick)).unwrap();
        assert!(raised.aimed);
        let spread = Dispersion {
            first: 0.002, actor_base: 0.01, actor_aim: 0.0002, ..Default::default()
        };
        assert!((spread.cone(early.speed, 0., false, false, early.aimed) - 0.012).abs() < 1e-6);
        assert!((spread.cone(raised.speed, 0., false, false, raised.aimed) - 0.0022).abs() < 1e-6);

        assert!(world.input(shooter, Input { sequence: 3, aiming: false, ..input }));
        assert!(!world.is_aiming(shooter));
        assert!(combat.rewind_aim(&world, shooter, aim(aimed_tick)).unwrap().aimed);
        world.entities.get_mut(&shooter).unwrap().loadout.aim =
            Some(AimProfile { weapon: [2; 16], ..profile });
        assert!(!combat.rewind_aim(&world, shooter, aim(aimed_tick)).unwrap().aimed);

        assert!(world.input(shooter, Input { sequence: 4, ..input }));
        world.entities.get_mut(&shooter).unwrap().cancel_aim();
        assert!(!world.is_aiming(shooter));
        assert!(world.input(shooter, Input { sequence: 5, ..input }));
        for _ in 0..=INPUT_TIMEOUT_TICKS {
            world.step();
        }
        assert!(!world.is_aiming(shooter));
        assert!(world.input(shooter, Input { sequence: 6, ..input }));
        assert!(world.raised_aim(shooter).is_none());
    }

    #[test]
    fn turn_dispersion_uses_camera_chord_with_packet_reordering_and_stale_input() {
        use crate::{ballistics::Dispersion, world::{Input, INPUT_TIMEOUT_TICKS, TICK_HZ, look_direction}};
        let (mut world, _, shooter, _) = setup();
        let first = Input {
            sequence: 1, x: 0., z: 0., yaw: std::f32::consts::TAU - 0.02, pitch: 0.,
            sprint: false, jump: false, crouch: false, walk: false, aiming: false,
        };
        let next = Input { sequence: 2, yaw: 0.02, pitch: 0.1, ..first };
        let direction = look_direction(next.yaw, next.pitch);
        let measure = |world: &World| world.entities[&shooter].shot_turn_speed(world.tick, direction);
        assert!(world.input(shooter, first));
        world.step();

        let expected = (2.0 - 2.0 * 0.04f32.cos() * 0.1f32.cos()).sqrt() * TICK_HZ as f32;
        assert!((measure(&world) - expected).abs() < 1e-4);
        assert!(world.input(shooter, next));
        assert!((measure(&world) - expected).abs() < 1e-4);
        assert!(!world.input(shooter, first));
        assert!(world.input(shooter, Input { sequence: 3, ..next }));
        assert!((measure(&world) - expected).abs() < 1e-4);

        let spread = Dispersion { first: 0.002, actor_base: 0.01, actor_aim: 0.0002,
            velocity_factor: 0.5, ..Default::default() };
        let cone = spread.cone(2.0, measure(&world), false, false, false);
        assert!((cone - (0.002 + 0.01 * (1.0 + expected * 0.05) * 1.1)).abs() < 1e-6);
        assert_eq!(spread.cone(2.0, measure(&world), false, false, true),
            spread.cone(2.0, 0.0, false, false, true));
        world.step();
        assert!(world.input(shooter, Input { sequence: 4, ..next }));
        assert_eq!(measure(&world), 0.0);
        let snapped = look_direction(next.yaw, 0.25);
        for _ in 0..=INPUT_TIMEOUT_TICKS { world.step(); }
        assert_eq!(world.entities[&shooter].shot_turn_speed(world.tick, snapped), 0.0);
    }

    #[test]
    fn owned_round_drops_and_loses_speed_over_distance() {
        let (mut world, mut combat, shooter, target) = setup();
        world.entities.get_mut(&target).unwrap().position.z = 100.0;
        world.entities.get_mut(&shooter).unwrap().loadout.ballistics = Some(RoundProfile {
            revision: 7, range: 120.0, speed: 220.0, drag: 0.8, gravity: 9.81,
            pellets: 1, spread: Default::default(), surface: Default::default(),
        });
        world.tick = 1;
        combat.capture(&world);
        let flat = combat.prepare_shot(&world, shooter, aim(1), 120.0).unwrap();
        assert_eq!(combat.trace_shot(&world, flat, 120.0).target(), Some(target));
        assert!(matches!(combat.trace_owned_round(&world, shooter, aim(1), false).unwrap().contact.impact, Impact::Miss));
        let elevated = combat.trace_owned_round(&world, shooter, Aim { pitch: 0.016, ..aim(1) }, false).unwrap();
        assert_eq!(elevated.target(), Some(target));
        assert_eq!(elevated.ballistics.unwrap().revision, 7);
        assert!((0.50..0.55).contains(&elevated.contact.speed_factor));
    }

    #[test]
    fn owned_round_uses_the_hit_triangles_material_and_remaining_range() {
        let factors = |cover| [(7, 0, 1.0), (9, 0, 1.0), (11, crate::materials::NO_RICOCHET, cover)];
        let trace = |cover, penetration, range| {
            let map = Arc::new(crate::collision::tests::cover_fixture(factors(cover)));
            let mut world = World::with_collision(map).unwrap();
            let shooter = world.spawn(Kind::Player, Vec3::default());
            let target = world.spawn(Kind::Player, Vec3 { x: 4.0, y: 0.0, z: 0.0 });
            world.entities.get_mut(&shooter).unwrap().loadout.ballistics = Some(RoundProfile {
                revision: 0, range, speed: 300.0, drag: 0.0, gravity: 0.0, pellets: 1, spread: Default::default(),
                surface: crate::ballistics::SurfaceProfile { penetration, ..Default::default() },
            });
            let mut combat = Combat::default();
            combat.capture(&world);
            let result = combat.trace_owned_round(&world, shooter,
                Aim { yaw: std::f32::consts::FRAC_PI_2, ..aim(0) }, false).unwrap();
            (result, target)
        };
        let (stopped, _) = trace(0.3, 0.15, 10.0);
        assert!(matches!(stopped.contact.impact, Impact::Blocked));
        let (through, target) = trace(0.3, 0.75, 10.0);
        assert_eq!(through.target(), Some(target));
        assert!((through.contact.speed_factor - 0.6).abs() < 0.0001);
        let (short, _) = trace(0.3, 0.75, 3.0);
        assert!(matches!(short.contact.impact, Impact::Miss));
        let (clear, target) = trace(0.0, 0.0, 10.0);
        assert_eq!(clear.target(), Some(target));
        assert!((clear.contact.speed_factor - 1.0).abs() < 0.0001);
    }
    #[test]
    fn authoritative_hit_cooldown_death_and_no_client_target() {
        let (mut w, mut c, a, b) = setup();
        assert_eq!(
            c.fire(&mut w, a, aim(0)),
            ShotResult::Hit {
                target: b,
                health: 65,
                ammo: 29
            }
        );
        assert_eq!(
            c.fire(&mut w, a, aim(0)),
            ShotResult::Rejected { reason: "cooldown" }
        );
        for expected in [30, 0] {
            for _ in 0..6 {
                w.step();
                c.capture(&w);
            }
            let tick = w.tick;
            assert!(
                matches!(c.fire(&mut w,a,aim(tick)),ShotResult::Hit{health,..} if health==expected)
            );
        }
        let tick = w.tick;
        assert_eq!(
            c.fire(&mut w, b, aim(tick)),
            ShotResult::Rejected { reason: "dead" }
        );
        assert!(
            serde_json::from_str::<Aim>(r#"{"tick":0,"yaw":0,"pitch":0,"origin":[0,0,0]}"#)
                .is_err()
        );
    }
    #[test]
    fn bounded_rewind_uses_historical_target_and_current_safe_policy() {
        let (mut w, mut c, a, b) = setup();
        w.entities.get_mut(&b).unwrap().position.x = 20.;
        w.step();
        c.capture(&w);
        assert!(matches!(c.fire(&mut w,a,aim(0)),ShotResult::Hit{target,..} if target==b));
        let (mut w, mut c, a, b) = setup();
        w.entities.get_mut(&b).unwrap().position.x = 20.;
        w.safe_zones.push(crate::world::SafeZone::sphere(w.entities[&b].position, 1.));
        w.step();
        c.capture(&w);
        assert_eq!(
            c.fire(&mut w, a, aim(0)),
            ShotResult::Protected { ammo: 29 }
        );
        assert_eq!(w.entities[&b].health, 100);
        for _ in 0..7 {
            w.step();
            c.capture(&w);
        }
        assert_eq!(
            c.fire(&mut w, a, aim(0)),
            ShotResult::Rejected {
                reason: "invalid_tick"
            }
        );
    }
    #[test]
    fn rewound_native_bounds_use_the_models_offset_and_yaw() {
        let (mut world, mut combat, shooter, player) = setup();
        world.remove(player);
        let npc = world.spawn(Kind::Npc, Vec3 { x: 0.7, y: 0.0, z: 10.0 });
        let native = NativeTarget { host: 8, id: 9, spawn: 1 };
        let entity = world.entities.get_mut(&npc).unwrap();
        entity.yaw = std::f32::consts::FRAC_PI_2;
        entity.native = Some(crate::alife_npcs::NativeNpc {
            target: native,
            model: "dog".into(),
            bounds: NativeBounds { center: [0.0, 0.4, 0.7], half: [0.6, 0.2, 0.2] },
            motion: None,
        });
        world.tick = 1;
        combat.capture(&world);
        world.entities.get_mut(&npc).unwrap().position.x = 20.0;
        let shot = combat.prepare_shot(
            &world,
            shooter,
            Aim { tick: 1, yaw: 0.0, pitch: (-1.15_f32 / 10.0).atan() },
            RANGE,
        ).unwrap();
        let (distance, impact) = combat.trace(&shot, &world, RANGE);
        assert!((9.0..10.0).contains(&distance));
        assert!(matches!(impact, Impact::Native { id, target, offset, .. }
            if id == npc && target == native && (offset.z - 0.7).abs() < 1e-5));
    }
    #[test]
    fn nearest_body_blocks_far_target_and_invalid_aim_does_not_spend_ammo() {
        let (mut w, mut c, a, b) = setup();
        let far = w.spawn(
            Kind::Npc,
            Vec3 {
                x: 0.,
                y: 0.,
                z: 20.,
            },
        );
        w.step();
        c.capture(&w);
        assert_eq!(
            c.fire(
                &mut w,
                a,
                Aim {
                    tick: 1,
                    yaw: f32::NAN,
                    pitch: 0.
                }
            ),
            ShotResult::Rejected {
                reason: "invalid_aim"
            }
        );
        assert_eq!(
            c.fire(&mut w, a, aim(1)),
            ShotResult::Hit {
                target: b,
                health: 65,
                ammo: 29
            }
        );
        assert_eq!(w.entities[&far].health, 100);
    }
    #[test]
    fn crossing_safe_zone_boundary_keeps_combatants_vulnerable_until_lock_expires() {
        let (mut world, mut combat, shooter, target) = setup();
        world.combat_lock_ticks = 12;
        let shelter = Vec3 {
            z: 12.0,
            ..Vec3::default()
        };
        world.safe_zones.push(crate::world::SafeZone::sphere(shelter, 1.0));
        assert!(matches!(
            combat.fire(&mut world, shooter, aim(0)),
            ShotResult::Hit { health: 65, .. }
        ));
        assert!(world.entities[&shooter].combat_locked(0, world.combat_lock_ticks));
        world.entities.get_mut(&target).unwrap().position = shelter;
        for _ in 0..FIRE_INTERVAL {
            world.step();
            combat.capture(&world);
        }
        assert!(!world.is_protected(&world.entities[&target]));
        assert_eq!(
            world
                .visible_to(target)
                .iter()
                .find(|e| e.id == target)
                .unwrap()
                .flags
                & 1,
            0
        );
        assert_eq!(
            combat
                .prepare_shot(&world, target, aim(world.tick), RANGE)
                .err(),
            Some("safe_zone")
        );
        let tick = world.tick;
        assert!(matches!(
            combat.fire(&mut world, shooter, aim(tick)),
            ShotResult::Hit { health: 30, .. }
        ));
        for _ in 0..world.combat_lock_ticks {
            world.step();
            combat.capture(&world);
        }
        assert!(world.is_protected(&world.entities[&target]));
        let tick = world.tick;
        assert_eq!(
            combat.fire(&mut world, shooter, aim(tick - 1)),
            ShotResult::Protected { ammo: 27 }
        );
    }
    #[test]
    fn thin_static_wall_blocks_shot_and_safe_shooter_cannot_fire() {
        let map = crate::collision::tests::actor_fixture(0);
        let mut w = World::with_collision(std::sync::Arc::new(map)).unwrap();
        let a = w.spawn(Kind::Player, Vec3::default());
        let b = w.spawn(
            Kind::Player,
            Vec3 {
                x: 4.,
                y: 0.,
                z: 0.,
            },
        );
        let mut c = Combat::default();
        c.capture(&w);
        assert_eq!(
            c.fire(
                &mut w,
                a,
                Aim {
                    tick: 0,
                    yaw: std::f32::consts::FRAC_PI_2,
                    pitch: 0.
                }
            ),
            ShotResult::Blocked { ammo: 29 }
        );
        assert_eq!(w.entities[&b].health, 100);
        w.safe_zones.push(crate::world::SafeZone::sphere(Vec3::default(), 1.));
        assert_eq!(
            c.fire(&mut w, a, aim(0)),
            ShotResult::Rejected {
                reason: "safe_zone"
            }
        );
    }
    #[test]
    fn reload_is_timed_finite_and_cannot_be_restarted_or_fire_early() {
        let (mut w, mut c, a, b) = setup();
        w.remove(b);
        assert_eq!(c.reload(&w, a), ReloadResult::Rejected { reason: "full" });
        assert_eq!(c.fire(&mut w, a, aim(0)), ShotResult::Miss { ammo: 29 });
        assert_eq!(c.reload(&w, a), ReloadResult::Started { ready_tick: 90 });
        assert_eq!(
            c.reload(&w, a),
            ReloadResult::Rejected {
                reason: "reloading"
            }
        );
        for _ in 0..89 {
            w.step();
            c.capture(&w);
        }
        assert_eq!(c.weapon(a).ammo, 29);
        assert_eq!(
            c.fire(&mut w, a, aim(89)),
            ShotResult::Rejected {
                reason: "reloading"
            }
        );
        w.step();
        c.capture(&w);
        assert_eq!(
            c.weapon(a),
            WeaponView {
                ammo: 30,
                reserve: 89,
                reload_ready_tick: None
            }
        );
        c.weapons.get_mut(&a).unwrap().ammo = 0;
        c.weapons.get_mut(&a).unwrap().reserve = 2;
        c.reload(&w, a);
        for _ in 0..90 {
            w.step();
            c.capture(&w);
        }
        assert_eq!(c.weapon(a).ammo, 2);
        assert_eq!(c.weapon(a).reserve, 0);
        assert_eq!(
            c.reload(&w, a),
            ReloadResult::Rejected {
                reason: "empty_reserve"
            }
        );
    }
    #[test]
    fn respawn_keeps_input_watermark_clears_old_life_and_expires_corpse() {
        let (mut w, mut c, a, b) = setup();
        w.input(
            b,
            crate::world::Input {
                sequence: 50,
                x: 0.,
                z: 0.,
                yaw: 0.,
                pitch: 0.0,
                sprint: false,
                jump: false,
                crouch: false,
                walk: false,
                aiming: false,
            },
        );
        w.entities.get_mut(&b).unwrap().health = 0;
        w.step();
        c.capture(&w);
        assert_eq!(
            c.respawn(&mut w, b, Vec3::default()),
            RespawnResult::Rejected {
                reason: "respawn_delay"
            }
        );
        for _ in 0..90 {
            w.step();
            c.capture(&w);
        }
        let old_tick = w.tick;
        let RespawnResult::Respawned { corpse } = c.respawn(
            &mut w,
            b,
            Vec3 {
                x: 20.,
                y: 0.,
                z: 0.,
            },
        ) else {
            panic!("respawn failed")
        };
        assert_eq!(w.entities[&b].health, 100);
        assert_eq!(w.entities[&corpse].health, 0);
        assert_eq!(w.entities[&b].last_input(), 50);
        assert_eq!(w.entities[&b].position.x, 20.);
        assert!(!w.input(
            b,
            crate::world::Input {
                sequence: 49,
                x: 1.,
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
        assert_eq!(
            c.fire(&mut w, a, aim(old_tick)),
            ShotResult::Miss { ammo: 29 }
        );
        assert_eq!(
            c.respawn(&mut w, b, Vec3::default()),
            RespawnResult::Rejected { reason: "alive" }
        );
        for _ in 0..899 {
            w.step();
            c.expire_corpses(&mut w);
        }
        assert!(w.entities.contains_key(&corpse));
        w.step();
        c.expire_corpses(&mut w);
        assert!(!w.entities.contains_key(&corpse));
    }
    #[test]
    fn committed_shot_cannot_damage_a_target_reborn_while_persistence_was_pending() {
        let (mut world, mut combat, shooter, target) = setup();
        let shot = combat
            .prepare_shot(&world, shooter, aim(0), MAX_OWNED_RANGE)
            .unwrap();
        let shot = combat.trace_shot(&world, shot, MAX_OWNED_RANGE);
        let position = world.entities[&target].position;
        world.entities.get_mut(&target).unwrap().health = 0;
        combat.respawn_authorized(&mut world, target, position);
        assert_eq!(
            combat.resolve_owned_shot(
                &mut world,
                shot,
                ChargedShot {
                    range: 200.0,
                    damage: 100,
                    ammo: 9,
                    interval: 6,
                    mass_spent: 0.01,
                    power_loss: 0.0,
                    queue: None,
                    armour: Some(ArmourImpact::Hit {
                        power: 1.0,
                        wound: true,
                        gear_changed: true,
                        field_armour: None,
                    }),
                    target_commit: None,
                    launcher: None,
                    native_damage: None,
                }
            ),
            ShotResult::Miss { ammo: 9 }
        );
        assert_eq!(world.entities[&target].health, 100);
        assert_eq!(world.entities[&target].armour_revision, 0);
    }
    #[test]
    fn missed_shots_consume_finite_ammunition_and_tick_wrap_is_bounded() {
        let (mut w, mut c, a, b) = setup();
        w.remove(b);
        w.tick = u32::MAX - 3;
        c.history.clear();
        c.capture(&w);
        for n in 0..30 {
            let tick = w.tick;
            assert_eq!(
                c.fire(&mut w, a, aim(tick)),
                ShotResult::Miss { ammo: 29 - n }
            );
            for _ in 0..6 {
                w.step();
                c.capture(&w);
            }
        }
        let tick = w.tick;
        assert_eq!(
            c.fire(&mut w, a, aim(tick)),
            ShotResult::Rejected { reason: "empty" }
        );
        assert_eq!(
            c.fire(&mut w, a, aim(tick.wrapping_add(1))),
            ShotResult::Rejected {
                reason: "invalid_tick"
            }
        );
    }
}
