//! Underbarrel projectile flight against the server's map and live actors.
use crate::{combat::ArmourImpact, world::{TICK_HZ, Vec3, World}};
use parry3d::{
    math::Vector,
    query::{Ray, RayCast},
    shape::Capsule,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const GRAVITY: f32 = 2.0 * 9.81;
const STEP: f32 = 1.0 / TICK_HZ as f32;
const ACTOR_RADIUS: f32 = 0.35;
const MAX_PROJECTILES: usize = 512;
const CONTACT_SKIN: f32 = 0.02;

#[derive(Debug, Deserialize, Serialize)]
pub struct LaunchSpec {
    pub section: String,
    pub speed: f32,
    pub fuse_ticks: u32,
    pub blast_power: f32,
    pub blast_radius: f32,
}

pub struct Detonation {
    pub section: String,
    pub position: Vec3,
    pub hits: Vec<BlastContact>,
}

#[derive(Clone)]
pub struct BlastContact {
    _slot: Arc<()>,
    pub target: u32,
    pub power: f32,
    target_life: u32,
    target_incarnation: u32,
    shooter: u32,
    shooter_life: u32,
}

impl BlastContact {
    fn is_same_life(&self, world: &World) -> bool {
        world.entities.get(&self.target).is_some_and(|entity| {
            entity.incarnation == self.target_incarnation
                && entity.character_key.as_ref().is_some_and(|key| key.life == self.target_life)
        })
    }

    pub fn is_current(&self, world: &World) -> bool {
        self.is_same_life(world) && world.entities[&self.target].health > 0
    }

    pub fn is_pvp(&self) -> bool {
        self.target != self.shooter
    }

    pub fn apply(self, world: &mut World, impact: ArmourImpact, fatal: bool) -> bool {
        let ArmourImpact::Hit { power, wound, gear_changed } = impact else { return false; };
        if !self.is_same_life(world) {
            return false;
        }
        if self.is_pvp() && power > 0.0 {
            world.tag_pvp_hit(self.shooter, self.shooter_life, self.target);
        }
        let entity = world.entities.get_mut(&self.target).expect("current blast target");
        if gear_changed {
            entity.armour_revision = entity.armour_revision.wrapping_add(1);
        }
        if fatal {
            entity.health = 0;
            entity.loadout = crate::survival::Loadout::default();
            if let Some(state) = &mut entity.condition {
                state.health = 0.0;
            }
        } else if entity.health > 0 {
            // Keep condition progress that occurred while SQLite was busy.
            entity.apply_hit(power, wound);
        }
        true
    }
}

pub(crate) struct LaunchPose {
    pub slot: Arc<()>,
    pub origin: Vector,
    pub direction: Vector,
}

#[derive(Default)]
pub(crate) struct Projectiles {
    slots: Arc<()>,
    active: Vec<Projectile>,
}

struct Projectile {
    _slot: Arc<()>,
    shooter: u32,
    shooter_life: u32,
    position: Vector,
    velocity: Vector,
    spec: LaunchSpec,
    ticks_left: u32,
}

impl Projectiles {
    pub fn reserve(&self) -> Result<Arc<()>, &'static str> {
        // Include shots waiting on the inventory worker, so accepting a debit
        // never requires dropping a committed grenade when the budget is full.
        if Arc::strong_count(&self.slots) > MAX_PROJECTILES {
            return Err("projectile_capacity");
        }
        Ok(self.slots.clone())
    }

    pub fn launch(&mut self, shooter: u32, shooter_life: u32, pose: LaunchPose, spec: LaunchSpec) {
        self.active.push(Projectile {
            _slot: pose.slot,
            shooter,
            shooter_life,
            position: pose.origin,
            velocity: pose.direction * spec.speed,
            ticks_left: spec.fuse_ticks,
            spec,
        });
    }

    pub fn step(&mut self, world: &mut World) -> Vec<Detonation> {
        let mut detonations = Vec::new();
        self.active.retain_mut(|projectile| match projectile.advance(world) {
            Ok(Some(center)) => {
                let hits = projectile.blast(world, center);
                detonations.push(Detonation {
                    section: projectile.spec.section.clone(),
                    position: Vec3 { x: center.x, y: center.y, z: center.z },
                    hits,
                });
                false
            }
            Ok(None) => true,
            Err(error) => {
                tracing::warn!(%error, "launcher collision query failed");
                false
            }
        });
        detonations
    }
}

impl Projectile {
    fn advance(&mut self, world: &World) -> anyhow::Result<Option<Vector>> {
        let gravity = Vector::new(0.0, -GRAVITY, 0.0);
        let travel = self.velocity * STEP + gravity * (0.5 * STEP * STEP);
        self.velocity += gravity * STEP;
        self.ticks_left -= 1;
        let length = travel.length();
        if length > f32::EPSILON {
            let direction = travel / length;
            let mut contact = world.static_ray(self.position, direction, length)?;
            for entity in world.entities_near(self.position, length + ACTOR_RADIUS) {
                if entity.id == self.shooter || entity.health == 0
                    || world.persistent_ids.contains_key(&entity.id)
                {
                    continue;
                }
                let half = world.capsule_height(entity.id) * 0.5;
                let center = Vector::new(entity.position.x, entity.position.y + half, entity.position.z);
                let capsule = Capsule::new_y(half - ACTOR_RADIUS, ACTOR_RADIUS);
                if let Some(distance) = capsule.cast_local_ray(
                    &Ray::new(self.position - center, direction), contact.unwrap_or(length), true,
                ) {
                    contact = Some(distance);
                }
            }
            if let Some(distance) = contact {
                // Sample blast cover from the incoming side of a surface.
                return Ok(Some(self.position + direction * (distance - CONTACT_SKIN).max(0.0)));
            }
        }
        self.position += travel;
        Ok((self.ticks_left == 0).then_some(self.position))
    }

    fn blast(&self, world: &mut World, center: Vector) -> Vec<BlastContact> {
        let radius = self.spec.blast_radius;
        let radius_squared = radius * radius;
        let damage: Vec<_> = world.entities_near(center, radius).filter_map(|entity| {
            if entity.health == 0 || world.is_protected(entity)
                || world.persistent_ids.contains_key(&entity.id)
            {
                return None;
            }
            let height = world.capsule_height(entity.id);
            let feet = Vector::new(entity.position.x, entity.position.y, entity.position.z);
            if center.distance_squared(feet + Vector::Y * height * 0.5) > radius_squared {
                return None;
            }
            // CoP wave falloff and material attenuation at capsule samples.
            let exposure = [0.25, 0.5, 0.85].into_iter().map(|fraction| {
                let ray = feet + Vector::Y * (height * fraction) - center;
                let distance = ray.length();
                let transmission = if distance > CONTACT_SKIN {
                    world.blast_transmission(center, ray / distance, distance)
                } else {
                    1.0
                };
                transmission * radius_squared / (radius_squared + 2.0 * distance * distance)
            }).sum::<f32>() / 3.0;
            let power = self.spec.blast_power * exposure;
            (power > 0.001).then_some((entity.id, power))
        }).collect();
        let mut hits = Vec::new();
        for (id, power) in damage {
            let entity = &world.entities[&id];
            if let Some(key) = &entity.character_key {
                // Keep the projectile's capacity slot until its final
                // persistent target finishes, including under worker backlog.
                hits.push(BlastContact {
                    _slot: self._slot.clone(), target: id, power, target_life: key.life,
                    target_incarnation: entity.incarnation, shooter: self.shooter,
                    shooter_life: self.shooter_life,
                });
                continue;
            }
            if id != self.shooter {
                world.tag_pvp_hit(self.shooter, self.shooter_life, id);
            }
            world.entities.get_mut(&id).expect("blast target remains live").apply_hit(power, false);
        }
        hits
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{Kind, SafeZone};

    fn fire(projectiles: &mut Projectiles, shooter: u32, direction: Vector, fuse_ticks: u32) {
        projectiles.launch(shooter, 0, LaunchPose {
            slot: projectiles.reserve().unwrap(),
            origin: Vector::new(0.0, 1.55, 0.0),
            direction,
        }, LaunchSpec { section: "wpn_fake_missile2".into(), speed: 32.0, fuse_ticks, blast_power: 0.4, blast_radius: 4.0 });
    }

    #[test]
    fn grenade_falls_and_expires_after_the_authored_fuse() {
        let mut shots = Projectiles::default();
        let mut world = World::new();
        fire(&mut shots, 1, Vector::Z, 3);
        shots.step(&mut world);
        assert!((shots.active[0].position.z - 32.0 * STEP).abs() < 1e-6);
        assert!((shots.active[0].position.y - (1.55 - 0.5 * GRAVITY * STEP * STEP)).abs() < 1e-6);
        assert!(shots.step(&mut world).is_empty());
        assert_eq!(shots.active.len(), 1);
        let events = shots.step(&mut world);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].section, "wpn_fake_missile2");
        assert!((events[0].position.z - 96.0 * STEP).abs() < 1e-5);
        assert!(shots.active.is_empty());
        assert!(shots.step(&mut world).is_empty());
    }

    #[test]
    fn wall_contact_respects_cover_and_safe_zone_combat_lock() {
        let mut world = World::with_collision(Arc::new(crate::collision::tests::actor_fixture(0))).unwrap();
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let exposed = world.spawn(Kind::Player, Vec3 { x: 1.2, y: 0.0, z: 1.4 });
        let covered = world.spawn(Kind::Player, Vec3 { x: 2.8, y: 0.0, z: 0.0 });
        let safe = world.spawn(Kind::Player, Vec3 { x: 1.2, y: 0.0, z: -1.4 });
        world.safe_zones.push(SafeZone { center: world.entities[&safe].position, radius: 0.5 });
        world.combat_lock_ticks = 60;
        let mut shots = Projectiles::default();
        fire(&mut shots, shooter, Vector::X, 300);
        shots.step(&mut world);
        assert_eq!(world.entities[&exposed].health, 100);
        shots.step(&mut world);
        assert!(shots.active.is_empty());
        assert!(world.entities[&exposed].health < 100);
        assert_eq!(world.entities[&exposed].combat_ticks_left(world.tick, 60), 60);
        assert_eq!(world.entities[&shooter].combat_ticks_left(world.tick, 60), 60);
        assert_eq!(world.entities[&covered].health, 100);
        assert_eq!(world.entities[&safe].health, 100);

        world.tag_pvp_hit(shooter, 0, safe);
        fire(&mut shots, shooter, Vector::X, 300);
        shots.step(&mut world);
        shots.step(&mut world);
        assert!(world.entities[&safe].health < 100);
    }

    #[test]
    fn a_partially_transmitting_wall_reduces_blast_damage() {
        let health_behind_wall = |shoot_factor| {
            let map = crate::collision::tests::cover_fixture([
                (7, 0, 1.0), (9, 0, 1.0), (11, 0, shoot_factor),
            ]);
            let mut world = World::with_collision(Arc::new(map)).unwrap();
            let shooter = world.spawn(Kind::Player, Vec3::default());
            let target = world.spawn(Kind::Player, Vec3 { x: 2.8, y: 0.0, z: 0.0 });
            let mut shots = Projectiles::default();
            fire(&mut shots, shooter, Vector::X, 300);
            shots.step(&mut world);
            shots.step(&mut world);
            world.entities[&target].health
        };
        let full = health_behind_wall(0.0);
        let partial = health_behind_wall(0.3);
        assert!(full < partial && partial < 100);
        assert_eq!(health_behind_wall(1.0), 100);
    }

    #[test]
    fn actor_contact_detonates_without_waiting_for_a_wall_or_the_fuse() {
        let mut world = World::new();
        world.safe_zones.clear();
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let target = world.spawn(Kind::Player, Vec3 { x: 0.0, y: 0.0, z: 3.0 });
        let mut shots = Projectiles::default();
        fire(&mut shots, shooter, Vector::Z, 300);
        for _ in 0..3 {
            shots.step(&mut world);
        }
        assert!(shots.active.is_empty());
        assert!(world.entities[&target].health < 100);
    }

    #[test]
    fn a_delayed_armoured_blast_does_not_damage_a_new_life() {
        let mut world = World::new();
        world.safe_zones.clear();
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let target = world.spawn(Kind::Player, Vec3 { x: 0.0, y: 0.0, z: 3.0 });
        world.entities.get_mut(&target).unwrap().character_key =
            Some(crate::world::CharacterKey { principal: "a".repeat(32), life: 0 });
        let mut shots = Projectiles::default();
        fire(&mut shots, shooter, Vector::Z, 300);
        let contact = (0..3).find_map(|_| shots.step(&mut world).pop()).unwrap().hits.pop().unwrap();
        assert_eq!(contact.target, target);
        assert!(contact.is_current(&world));
        assert_eq!(world.entities[&target].health, 100);
        world.entities.get_mut(&target).unwrap().character_key.as_mut().unwrap().life = 1;
        assert!(!contact.apply(&mut world, ArmourImpact::Hit { power: 0.4, wound: true, gear_changed: true }, true));
        assert_eq!(world.entities[&target].health, 100);
        assert_eq!(world.entities[&target].armour_revision, 0);
    }

    #[test]
    fn pending_launches_reserve_the_same_budget_as_flying_projectiles() {
        let mut shots = Projectiles::default();
        let mut pending: Vec<_> = (0..MAX_PROJECTILES).map(|_| shots.reserve().unwrap()).collect();
        assert_eq!(shots.reserve().unwrap_err(), "projectile_capacity");
        shots.launch(1, 0, LaunchPose {
            slot: pending.pop().unwrap(),
            origin: Vector::ZERO,
            direction: Vector::Z,
        }, LaunchSpec { section: "wpn_fake_missile2".into(), speed: 32.0, fuse_ticks: 1, blast_power: 0.4, blast_radius: 4.0 });
        assert_eq!(shots.reserve().unwrap_err(), "projectile_capacity");
        shots.step(&mut World::new());
        assert!(shots.reserve().is_ok());
    }
}
