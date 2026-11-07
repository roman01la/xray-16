//! First weapon foundation: server-owned hitscan, bounded rewind and ammunition.
//! X-Ray's native bullet manager traces trajectory segments against static and
//! dynamic geometry. This initial weapon is deliberately hitscan/no penetration;
//! raw static geometry blocks it conservatively until material ballistics exist.
use crate::world::{Kind, Vec3, World};
use parry3d::{
    math::Vector,
    query::{Ray, RayCast},
    shape::Capsule,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
const REWIND_TICKS: u32 = 6;
const FIRE_INTERVAL: u32 = 6;
const RANGE: f32 = 150.;
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
    alive: bool,
}
struct Frame {
    tick: u32,
    poses: Vec<Pose>,
}
#[derive(Default)]
pub struct Combat {
    history: VecDeque<Frame>,
    weapons: BTreeMap<u32, Weapon>,
    deaths: BTreeMap<u32, u32>,
    corpses: BTreeMap<u32, u32>,
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
                    alive: e.health > 0,
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
        // The old life must not be hittable through rewind after revival.
        for frame in &mut self.history {
            frame.poses.retain(|p| p.id != player);
        }
        RespawnResult::Respawned { corpse }
    }
    pub fn fire(&mut self, world: &mut World, shooter: u32, aim: Aim) -> ShotResult {
        let reject = |reason| ShotResult::Rejected { reason };
        if !aim.yaw.is_finite() || !aim.pitch.is_finite() || aim.pitch.abs() > 1.55 {
            return reject("invalid_aim");
        }
        if world.tick.wrapping_sub(aim.tick) > REWIND_TICKS {
            return reject("invalid_tick");
        }
        let Some(current) = world.entities.get(&shooter) else {
            return reject("invalid_shooter");
        };
        if current.kind != Kind::Player || current.health == 0 {
            return reject("dead");
        }
        let Some(frame) = self.history.iter().find(|f| f.tick == aim.tick) else {
            return reject("missing_history");
        };
        let Some(origin_pose) = frame.poses.iter().find(|p| p.id == shooter && p.alive) else {
            return reject("missing_history");
        };
        if world.is_safe(current.position) || world.is_safe(origin_pose.feet) {
            return reject("safe_zone");
        }
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
        // Fail closed on geometry errors before consuming a shot.
        let wall = match world.static_ray(origin, direction, RANGE) {
            Ok(v) => v,
            Err(_) => return reject("collision_error"),
        };
        weapon.ammo -= 1;
        weapon.last_shot = Some(world.tick);
        let ammo = weapon.ammo;
        let mut hit: Option<(f32, &Pose)> = None;
        for pose in &frame.poses {
            if world.persistent_ids.contains_key(&pose.id)
                || pose.id == shooter
                || !pose.alive
                || world.entities.get(&pose.id).is_none_or(|e| e.health == 0)
            {
                continue;
            }
            let center = Vector::new(pose.feet.x, pose.feet.y + pose.height / 2., pose.feet.z);
            let capsule = Capsule::new_y(pose.height / 2. - 0.35, 0.35);
            if let Some(distance) =
                capsule.cast_local_ray(&Ray::new(origin - center, direction), RANGE, true)
                && hit.as_ref().is_none_or(|(old, _)| distance < *old)
            {
                hit = Some((distance, pose));
            }
        }
        if wall.is_some_and(|distance| hit.as_ref().is_none_or(|(body, _)| distance <= *body)) {
            return ShotResult::Blocked { ammo };
        }
        let Some((_, target)) = hit else {
            return ShotResult::Miss { ammo };
        };
        if world.is_safe(target.feet) || world.is_safe(world.entities[&target.id].position) {
            return ShotResult::Protected { ammo };
        }
        let entity = world.entities.get_mut(&target.id).unwrap();
        entity.health = entity.health.saturating_sub(35);
        if entity.health == 0 {
            self.deaths.insert(target.id, world.tick);
        }
        ShotResult::Hit {
            target: target.id,
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
