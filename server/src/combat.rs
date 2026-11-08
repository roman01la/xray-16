//! First weapon foundation: server-owned hitscan, bounded rewind and ammunition.
//! X-Ray's native bullet manager traces trajectory segments against static and
//! dynamic geometry. This initial weapon is deliberately hitscan/no penetration;
//! raw static geometry blocks it conservatively until material ballistics exist.
use crate::{projectile::{LaunchPose, Projectiles}, world::{CharacterKey, Kind, Vec3, World}};
pub use crate::projectile::{BlastContact, Detonation, LaunchSpec};
use parry3d::{
    math::Vector,
    query::{Ray, RayCast},
    shape::Capsule,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
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
    yaw: f32,
    alive: bool,
    incarnation: u32,
    combat_locked: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue: Option<QueueRound>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armour: Option<ArmourImpact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launcher: Option<LaunchSpec>,
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
    },
}

/// The simulation selects the target and region from its rewind frame. A
/// client command cannot provide these fields or an armour inventory ID.
#[derive(Clone)]
pub struct ShotTarget {
    pub character: CharacterKey,
    pub bone: &'static str,
    pub distance: f32,
}

enum Impact {
    Miss,
    Blocked,
    Protected,
    Hit {
        target: u32,
        incarnation: u32,
        bone: &'static str,
    },
}

pub struct TracedShot {
    shooter: u32,
    shooter_life: u32,
    distance: f32,
    impact: Impact,
    launch: Option<LaunchPose>,
}

impl TracedShot {
    pub fn armour_target(&self, world: &World) -> Option<ShotTarget> {
        let Impact::Hit { target, bone, .. } = self.impact else {
            return None;
        };
        Some(ShotTarget {
            character: world.entities.get(&target)?.character_key.clone()?,
            bone,
            distance: self.distance,
        })
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
                    yaw: e.yaw,
                    alive: e.health > 0,
                    incarnation: e.incarnation,
                    combat_locked: e.combat_locked(world.tick, world.combat_lock_ticks),
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
        if !aim.yaw.is_finite() || !aim.pitch.is_finite() || aim.pitch.abs() > 1.55 {
            return Err("invalid_aim");
        }
        if world.tick.wrapping_sub(aim.tick) > REWIND_TICKS {
            return Err("invalid_tick");
        }
        let Some(current) = world.entities.get(&shooter) else {
            return Err("invalid_shooter");
        };
        if current.kind != Kind::Player || current.health == 0 {
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
        let yaw = aim.yaw.rem_euclid(std::f32::consts::TAU);
        let direction = Vector::new(
            yaw.sin() * aim.pitch.cos(),
            aim.pitch.sin(),
            yaw.cos() * aim.pitch.cos(),
        );
        let origin = Vector::new(
            origin_pose.feet.x,
            origin_pose.feet.y + origin_pose.height - 0.25,
            origin_pose.feet.z,
        );
        let wall = world
            .static_ray(origin, direction, range)
            .map_err(|_| "collision_error")?;
        Ok(PreparedShot {
            shooter,
            shooter_life: origin_pose.incarnation,
            origin,
            direction,
            wall,
            poses: frame.poses.clone(),
            launch_slot: None,
        })
    }

    pub fn prepare_owned_shot(&self, world: &World, shooter: u32, aim: Aim) -> Result<PreparedShot, &'static str> {
        let mut shot = self.prepare_shot(world, shooter, aim, MAX_OWNED_RANGE)?;
        shot.launch_slot = Some(self.projectiles.reserve()?);
        Ok(shot)
    }

    pub fn step_projectiles(&mut self, world: &mut World) -> Vec<Detonation> {
        self.projectiles.step(world)
    }

    pub fn trace_shot(&self, world: &World, shot: PreparedShot, range: f32) -> TracedShot {
        let trace = |distance, impact| TracedShot {
            shooter: shot.shooter,
            shooter_life: shot.shooter_life,
            distance,
            impact,
            launch: shot.launch_slot.map(|slot| LaunchPose {
                slot, origin: shot.origin, direction: shot.direction,
            }),
        };
        let mut hit: Option<(f32, &Pose)> = None;
        for pose in shot.poses.iter() {
            if world.persistent_ids.contains_key(&pose.id)
                || pose.id == shot.shooter
                || !pose.alive
                || world
                    .entities
                    .get(&pose.id)
                    .is_none_or(|e| e.health == 0 || e.incarnation != pose.incarnation)
            {
                continue;
            }
            let center = Vector::new(pose.feet.x, pose.feet.y + pose.height / 2., pose.feet.z);
            let capsule = Capsule::new_y(pose.height / 2. - 0.35, 0.35);
            if let Some(distance) =
                capsule.cast_local_ray(&Ray::new(shot.origin - center, shot.direction), range, true)
                && hit.as_ref().is_none_or(|(old, _)| distance < *old)
            {
                hit = Some((distance, pose));
            }
        }
        if let Some(distance) = shot.wall.filter(|&distance| {
            distance <= range && hit.as_ref().is_none_or(|(body, _)| distance <= *body)
        }) {
            return trace(distance, Impact::Blocked);
        }
        let Some((distance, target)) = hit else {
            return trace(f32::INFINITY, Impact::Miss);
        };
        if (world.is_safe(target.feet) && !target.combat_locked)
            || world.is_protected(&world.entities[&target.id])
        {
            return trace(distance, Impact::Protected);
        }
        let bone = hit_bone(target, shot.origin + shot.direction * distance);
        trace(
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
                queue: None,
                armour: None,
                launcher: None,
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
        if shot.distance > charge.range {
            return ShotResult::Miss { ammo };
        }
        let (target, incarnation) = match shot.impact {
            Impact::Miss => return ShotResult::Miss { ammo },
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
            .is_none_or(|entity| entity.health == 0 || entity.incarnation != incarnation)
        {
            return ShotResult::Miss { ammo };
        }
        let (power, wound, gear_changed) = match charge.armour {
            Some(ArmourImpact::Stale) => return ShotResult::Miss { ammo },
            Some(ArmourImpact::Hit {
                power,
                wound,
                gear_changed,
            }) => (power, wound, gear_changed),
            None => (f32::from(charge.damage) / 100.0, true, false),
        };
        if power > 0.0 {
            world.tag_pvp_hit(shot.shooter, shot.shooter_life, target);
        }
        let entity = world.entities.get_mut(&target).unwrap();
        if gear_changed {
            entity.armour_revision = entity.armour_revision.wrapping_add(1);
        }
        entity.apply_hit(power, wound);
        if entity.health == 0 {
            self.deaths.insert(target, world.tick);
        }
        ShotResult::Hit {
            target,
            health: entity.health,
            ammo,
        }
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
        w.safe_zones.push(crate::world::SafeZone {
            center: w.entities[&b].position,
            radius: 1.,
        });
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
        world.safe_zones.push(crate::world::SafeZone {
            center: shelter,
            radius: 1.0,
        });
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
        w.safe_zones.push(crate::world::SafeZone {
            center: Vec3::default(),
            radius: 1.,
        });
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
                sprint: false,
                jump: false,
                crouch: false,
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
                sprint: false,
                jump: false,
                crouch: false
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
                    queue: None,
                    armour: Some(ArmourImpact::Hit {
                        power: 1.0,
                        wound: true,
                        gear_changed: true
                    }),
                    launcher: None,
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
