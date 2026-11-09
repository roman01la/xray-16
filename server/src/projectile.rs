//! Grenade flight against the server's map and live actors.
use crate::{alife_attacks::{NativeAttack, NativeDamage, NativeHitKind}, alife_npcs::rotate_yaw, combat::ArmourImpact, survival::ImpactKind, world::{TICK_HZ, Vec3, World}};
use parry3d::{
    math::{Pose, Vector},
    query::{Ray, RayCast, ShapeCastOptions, cast_shapes},
    shape::{Ball, Capsule, Cuboid},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const GRAVITY: f32 = 2.0 * 9.81;
const STEP: f32 = 1.0 / TICK_HZ as f32;
const ACTOR_RADIUS: f32 = 0.35;
const MAX_PROJECTILES: usize = 512;
const MAX_BOLTS: usize = 256;
const CONTACT_SKIN: f32 = 0.02;
const HAND_RADIUS: f32 = 0.06;
// Bounding sphere from the stock dev_bolt.ogf.
pub(crate) const BOLT_RADIUS: f32 = 0.058167327;
const MAX_VISIBLE_GRENADES: usize = 8;

#[derive(Debug, Deserialize, Serialize)]
pub struct LaunchSpec {
    pub section: String,
    pub speed: f32,
    pub timed: bool,
    pub fuse_ticks: u32,
    pub blast_power: f32,
    pub blast_radius: f32,
}

pub struct Detonation {
    pub section: String,
    pub position: Vec3,
    pub hits: Vec<DamageContact>,
    pub native_hits: Vec<NativeAttack>,
}

#[derive(Clone)]
pub struct DamageContact {
    _slot: Arc<()>,
    pub target: u32,
    pub power: f32,
    target_life: u32,
    target_incarnation: u32,
    source: DamageSource,
}

#[derive(Clone)]
enum DamageSource {
    Grenade { shooter: u32, shooter_life: u32 },
    Native(ImpactKind),
}

impl DamageContact {
    pub(crate) fn native(slot: Arc<()>, target: u32, target_life: u32, target_incarnation: u32, power: f32, kind: ImpactKind) -> Self {
        Self { _slot: slot, target, power, target_life, target_incarnation, source: DamageSource::Native(kind) }
    }

    pub fn kind(&self) -> ImpactKind {
        match &self.source {
            DamageSource::Grenade { .. } => ImpactKind::Blast,
            DamageSource::Native(kind) => kind.clone(),
        }
    }
    fn is_same_life(&self, world: &World) -> bool {
        world.entities.get(&self.target).is_some_and(|entity| {
            entity.incarnation == self.target_incarnation
                && entity.character_key.as_ref().is_some_and(|key| key.life == self.target_life)
        })
    }

    pub fn is_current(&self, world: &World) -> bool {
        self.is_same_life(world) && {
            let target = &world.entities[&self.target];
            target.health > 0 && !target.travelling
        }
    }

    pub fn is_pvp(&self) -> bool {
        matches!(self.source, DamageSource::Grenade { shooter, .. } if self.target != shooter)
    }

    pub fn apply(self, world: &mut World, impact: ArmourImpact, power_loss: f32, fatal: bool) -> bool {
        let ArmourImpact::Hit { power, wound, gear_changed, field_armour } = impact else { return false; };
        if !self.is_same_life(world) {
            return false;
        }
        if let DamageSource::Grenade { shooter, shooter_life } = self.source
            && self.target != shooter && power > 0.0 {
            world.tag_pvp_hit(shooter, shooter_life, self.target);
        }
        let entity = world.entities.get_mut(&self.target).expect("current blast target");
        if gear_changed {
            entity.armour_revision = entity.armour_revision.wrapping_add(1);
        }
        if let Some(armour) = field_armour {
            entity.loadout.fields.armour.take_newer(armour);
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
            if let Some(condition) = &mut entity.condition {
                condition.power = (condition.power - power_loss).max(0.0);
            }
        }
        true
    }
}

pub(crate) struct LaunchPose {
    pub slot: Arc<()>,
    pub origin: Vector,
    pub direction: Vector,
    pub inherited_velocity: Vector,
}

#[derive(Default)]
pub(crate) struct Projectiles {
    slots: Arc<()>,
    bolt_slots: Arc<()>,
    active: Vec<Projectile>,
    next_id: u32,
}

struct Projectile {
    _slot: Arc<()>,
    id: u32,
    shooter: u32,
    shooter_life: u32,
    position: Vector,
    velocity: Vector,
    spec: LaunchSpec,
    ticks_left: u32,
    resting: bool,
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

    pub fn reserve_bolt(&self) -> Result<Arc<()>, &'static str> {
        if Arc::strong_count(&self.bolt_slots) > MAX_BOLTS {
            return Err("bolt_capacity");
        }
        Ok(self.bolt_slots.clone())
    }

    pub fn launch(&mut self, shooter: u32, shooter_life: u32, pose: LaunchPose, spec: LaunchSpec) {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.active.push(Projectile {
            _slot: pose.slot,
            id: self.next_id,
            shooter,
            shooter_life,
            position: pose.origin,
            velocity: pose.direction * spec.speed + pose.inherited_velocity,
            ticks_left: spec.fuse_ticks,
            spec,
            resting: false,
        });
    }

    pub fn view(&self, observer: Vec3) -> Vec<(u32, &str, f32, f32, f32)> {
        let observer = Vector::new(observer.x, observer.y, observer.z);
        let radius_squared = crate::world::INTEREST_RADIUS.powi(2);
        let mut nearby: Vec<_> = self.active.iter().filter_map(|grenade| {
            let distance = grenade.position.distance_squared(observer);
            (distance <= radius_squared).then_some((distance, grenade))
        }).collect();
        if nearby.len() > MAX_VISIBLE_GRENADES {
            // Keep the existing hand grenade coverage in a crowded feed.
            let priority = |projectile: &Projectile| {
                if projectile.spec.section == "bolt" { 2 }
                else if projectile.spec.timed { 0 }
                else { 1 }
            };
            nearby.select_nth_unstable_by(MAX_VISIBLE_GRENADES, |a, b|
                priority(a.1).cmp(&priority(b.1)).then(a.0.total_cmp(&b.0)));
            nearby.truncate(MAX_VISIBLE_GRENADES);
        }
        nearby.into_iter().map(|(_, grenade)| {
            let p = grenade.position;
            (grenade.id, grenade.spec.section.as_str(), p.x, p.y, p.z)
        }).collect()
    }

    pub fn step(&mut self, world: &mut World) -> Vec<Detonation> {
        let mut detonations = Vec::new();
        if self.active.is_empty() {
            return detonations;
        }
        // The spatial grid indexes entity origins. A native model can extend
        // into a neighboring cell even when its origin lies outside the sweep.
        let body_reach = world.entities.values()
            .filter_map(|entity| entity.native.as_ref())
            .fold(ACTOR_RADIUS, |reach, npc| {
                let [x, _, z] = npc.bounds.center;
                let [half_x, _, half_z] = npc.bounds.half;
                reach.max((x.abs() + half_x).hypot(z.abs() + half_z))
            });
        self.active.retain_mut(|projectile| match projectile.advance(world, body_reach) {
            Ok(Some(center)) => {
                if projectile.spec.section == "bolt" { return false; }
                let (hits, native_hits) = projectile.blast(world, center, body_reach);
                detonations.push(Detonation {
                    section: projectile.spec.section.clone(),
                    position: Vec3 { x: center.x, y: center.y, z: center.z },
                    hits, native_hits,
                });
                false
            }
            Ok(None) => true,
            Err(error) => {
                tracing::warn!(%error, "grenade collision query failed");
                false
            }
        });
        detonations
    }

    pub fn bolts(&self) -> impl Iterator<Item = (u32, Vector)> + '_ {
        self.active.iter().filter(|p| p.spec.section == "bolt").map(|p| (p.id, p.position))
    }
}

impl Projectile {
    fn advance(&mut self, world: &World, body_reach: f32) -> anyhow::Result<Option<Vector>> {
        if self.spec.timed {
            self.ticks_left -= 1;
            if !self.resting { self.bounce(world, body_reach)?; }
            return Ok((self.ticks_left == 0).then_some(self.position));
        }
        let gravity = Vector::new(0.0, -GRAVITY, 0.0);
        let travel = self.velocity * STEP + gravity * (0.5 * STEP * STEP);
        self.velocity += gravity * STEP;
        self.ticks_left -= 1;
        let length = travel.length();
        if length > f32::EPSILON {
            let direction = travel / length;
            let mut contact = world.static_ray(self.position, direction, length)?;
            for entity in world.entities_near(self.position, length + body_reach) {
                if entity.id == self.shooter || entity.health == 0 || entity.travelling
                    || world.persistent_ids.contains_key(&entity.id)
                {
                    continue;
                }
                let origin = Vector::new(entity.position.x, entity.position.y, entity.position.z);
                let limit = contact.unwrap_or(length);
                let hit = if let Some(npc) = &entity.native {
                    let center = npc.bounds.world_center(origin, entity.yaw);
                    let ray = Ray::new(
                        rotate_yaw(self.position - center, -entity.yaw),
                        rotate_yaw(direction, -entity.yaw),
                    );
                    Cuboid::new(Vector::from_array(npc.bounds.half)).cast_local_ray(&ray, limit, true)
                } else {
                    let half = world.capsule_height(entity.id) * 0.5;
                    let center = origin + Vector::Y * half;
                    Capsule::new_y(half - ACTOR_RADIUS, ACTOR_RADIUS)
                        .cast_local_ray(&Ray::new(self.position - center, direction), limit, true)
                };
                if let Some(distance) = hit {
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

    fn bounce(&mut self, world: &World, body_reach: f32) -> anyhow::Result<()> {
        let radius = if self.spec.section == "bolt" { BOLT_RADIUS } else { HAND_RADIUS };
        let gravity = Vector::new(0.0, -GRAVITY, 0.0);
        let mut remaining = STEP;
        let mut travel = (self.velocity + gravity * (0.5 * STEP)) * STEP;
        self.velocity += gravity * STEP;
        for _ in 0..3 {
            let length = travel.length();
            if length <= f32::EPSILON { break; }
            let direction = travel / length;
            let mut contact = world.sweep_projectile(self.position, travel, radius)?
                .map(|hit| (hit.time_of_impact, hit.normal1));
            for entity in world.entities_near(self.position, length + body_reach + radius) {
                if entity.id == self.shooter || entity.health == 0 || entity.travelling
                    || world.persistent_ids.contains_key(&entity.id) { continue; }
                let origin = Vector::new(entity.position.x, entity.position.y, entity.position.z);
                let limit = contact.map_or(1.0, |(time, _)| time);
                let hit = if let Some(npc) = &entity.native {
                    let center = npc.bounds.world_center(origin, entity.yaw);
                    let local = rotate_yaw(self.position - center, -entity.yaw);
                    cast_shapes(
                        &Pose::IDENTITY,
                        Vector::ZERO,
                        &Cuboid::new(Vector::from_array(npc.bounds.half)),
                        &Pose::translation(local.x, local.y, local.z),
                        rotate_yaw(travel, -entity.yaw),
                        &Ball::new(radius),
                        ShapeCastOptions {
                            max_time_of_impact: limit,
                            stop_at_penetration: false,
                            ..Default::default()
                        },
                    )?.map(|hit| (hit.time_of_impact, rotate_yaw(hit.normal1, entity.yaw)))
                } else {
                    let half = world.capsule_height(entity.id) * 0.5;
                    let center = origin + Vector::Y * half;
                    Capsule::new_y(half - ACTOR_RADIUS, ACTOR_RADIUS + radius)
                        .cast_local_ray_and_get_normal(
                            &Ray::new(self.position - center, direction), limit * length, false,
                        ).map(|hit| (hit.time_of_impact / length, hit.normal))
                };
                if let Some(hit) = hit {
                    contact = Some(hit);
                }
            }
            let Some((time, normal)) = contact else { self.position += travel; break; };
            let normal = if normal.dot(direction) > 0.0 { -normal } else { normal };
            self.position += travel * time + normal * CONTACT_SKIN;
            let normal_speed = self.velocity.dot(normal).min(0.0);
            let tangent = self.velocity - normal * normal_speed;
            self.velocity = tangent * 0.65 - normal * (normal_speed * 0.3);
            if normal.y > 0.6 && self.velocity.length_squared() < 0.5 {
                self.resting = true;
                break;
            }
            remaining *= 1.0 - time;
            travel = self.velocity * remaining;
        }
        Ok(())
    }

    fn blast(&self, world: &mut World, center: Vector, body_reach: f32) -> (Vec<DamageContact>, Vec<NativeAttack>) {
        if self.spec.blast_power == 0.0 { return (Vec::new(), Vec::new()); }
        let radius = self.spec.blast_radius;
        let radius_squared = radius * radius;
        let damage: Vec<_> = world.entities_near(center, radius + body_reach).filter_map(|entity| {
            if entity.health == 0 || entity.travelling || world.is_protected(entity)
                || world.persistent_ids.contains_key(&entity.id)
            {
                return None;
            }
            let feet = Vector::new(entity.position.x, entity.position.y, entity.position.z);
            let (body, height) = if let Some(npc) = &entity.native {
                (npc.bounds.world_center(feet, entity.yaw), npc.bounds.half[1] * 2.0)
            } else {
                let height = world.capsule_height(entity.id);
                (feet + Vector::Y * height * 0.5, height)
            };
            if center.distance_squared(body) > radius_squared {
                return None;
            }
            // CoP wave falloff and material attenuation at capsule samples.
            let exposure = [0.25, 0.5, 0.85].into_iter().map(|fraction| {
                let ray = body + Vector::Y * (height * (fraction - 0.5)) - center;
                let distance = ray.length();
                let transmission = if distance > CONTACT_SKIN {
                    world.blast_transmission(center, ray / distance, distance)
                } else {
                    1.0
                };
                transmission * radius_squared / (radius_squared + 2.0 * distance * distance)
            }).sum::<f32>() / 3.0;
            let power = self.spec.blast_power * exposure;
            (power > 0.001).then_some((entity.id, power, body - center, body - feet))
        }).collect();
        let mut hits = Vec::new();
        let mut native_hits = Vec::new();
        for (id, power, direction, offset) in damage {
            let entity = &world.entities[&id];
            if let Some(npc) = &entity.native {
                native_hits.push(NativeAttack { target_id: id, target: npc.target, shooter: self.shooter, life: self.shooter_life,
                    damage: NativeDamage { kind: NativeHitKind::Explosion, power: [power, 0.0, 0.0], penetration: 0.0, impulse: 0.0 },
                    direction: direction.try_normalize().unwrap_or(Vector::Y).to_array(), offset: rotate_yaw(offset, -entity.yaw).to_array() });
                continue;
            }
            if let Some(key) = &entity.character_key {
                // Keep the projectile's capacity slot until its final
                // persistent target finishes, including under worker backlog.
                hits.push(DamageContact {
                    _slot: self._slot.clone(), target: id, power, target_life: key.life,
                    target_incarnation: entity.incarnation,
                    source: DamageSource::Grenade { shooter: self.shooter, shooter_life: self.shooter_life },
                });
                continue;
            }
            if id != self.shooter {
                world.tag_pvp_hit(self.shooter, self.shooter_life, id);
            }
            world.entities.get_mut(&id).expect("blast target remains live").apply_hit(power, false);
        }
        (hits, native_hits)
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
            inherited_velocity: Vector::ZERO,
        }, LaunchSpec { section: "wpn_fake_missile2".into(), speed: 32.0, timed: false, fuse_ticks, blast_power: 0.4, blast_radius: 4.0 });
    }

    #[test]
    fn grenade_falls_and_expires_after_the_authored_fuse() {
        let mut shots = Projectiles::default();
        let mut world = World::new();
        fire(&mut shots, 1, Vector::Z, 3);
        shots.step(&mut world);
        assert!((shots.active[0].position.z - 32.0 * STEP).abs() < 1e-6);
        assert!((shots.active[0].position.y - (1.55 - 0.5 * GRAVITY * STEP * STEP)).abs() < 1e-6);
        let flight = shots.view(Vec3::default());
        assert_eq!(flight.len(), 1);
        assert_eq!(flight[0].1, "wpn_fake_missile2");
        assert_eq!(flight[0].4, shots.active[0].position.z);
        assert!(shots.step(&mut world).is_empty());
        assert_eq!(shots.active.len(), 1);
        let events = shots.step(&mut world);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].section, "wpn_fake_missile2");
        assert!((events[0].position.z - 96.0 * STEP).abs() < 1e-5);
        assert!(shots.view(Vec3::default()).is_empty());
        assert!(shots.active.is_empty());
        assert!(shots.step(&mut world).is_empty());
    }

    #[test]
    fn timed_grenade_bounces_off_wall_and_detonates_once_on_fuse() {
        let mut world = World::with_collision(Arc::new(crate::collision::tests::actor_fixture(0))).unwrap();
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let mut shots = Projectiles::default();
        shots.launch(shooter, 0, LaunchPose {
            slot: shots.reserve().unwrap(), origin: Vector::new(0.0, 1.55, 0.0),
            direction: Vector::X, inherited_velocity: Vector::ZERO,
        }, LaunchSpec { section: "grenade_gd-05".into(), speed: 25.0, timed: true,
            fuse_ticks: 75, blast_power: 0.0, blast_radius: 0.0 });
        for _ in 0..6 { assert!(shots.step(&mut world).is_empty()); }
        assert!(shots.active[0].position.x < 2.0 && shots.active[0].velocity.x <= 0.0);
        for _ in 6..74 { assert!(shots.step(&mut world).is_empty()); }
        let events = shots.step(&mut world);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].section, "grenade_gd-05");
        assert!(events[0].hits.is_empty());
        assert_eq!(world.entities[&shooter].health, 100);
        assert!(shots.step(&mut world).is_empty());
    }

    #[test]
    fn nearby_flight_keeps_the_closest_eight_hand_grenades() {
        let mut shots = Projectiles::default();
        for x in [105.0, 60.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0, 8.0] {
            shots.launch(1, 0, LaunchPose {
                slot: shots.reserve().unwrap(), origin: Vector::new(x, 0.0, 0.0),
                direction: Vector::Z, inherited_velocity: Vector::ZERO,
            }, LaunchSpec { section: "grenade_f1".into(), speed: 25.0, timed: true,
                fuse_ticks: 75, blast_power: 2.0, blast_radius: 6.0 });
        }
        fire(&mut shots, 1, Vector::Z, 75);
        let mut positions: Vec<_> = shots.view(Vec3::default()).into_iter()
            .map(|(_, section, x, _, _)| {
                assert_eq!(section, "grenade_f1");
                x as u8
            }).collect();
        positions.sort_unstable();
        assert_eq!(positions, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert!(shots.view(Vec3 { x: -101.0, ..Vec3::default() }).is_empty());
    }

    #[test]
    fn wall_contact_respects_cover_and_safe_zone_combat_lock() {
        let mut world = World::with_collision(Arc::new(crate::collision::tests::actor_fixture(0))).unwrap();
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let exposed = world.spawn(Kind::Player, Vec3 { x: 1.2, y: 0.0, z: 1.4 });
        let covered = world.spawn(Kind::Player, Vec3 { x: 2.8, y: 0.0, z: 0.0 });
        let safe = world.spawn(Kind::Player, Vec3 { x: 1.2, y: 0.0, z: -1.4 });
        world.safe_zones.push(SafeZone::sphere(world.entities[&safe].position, 0.5 ));
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
    fn grenade_flight_uses_low_native_bounds_across_a_grid_boundary() {
        use crate::alife_npcs::{NativeBounds, NativeNpc, NativeTarget};

        let mut world = World::new();
        let npc = world.spawn(Kind::Npc, Vec3 { x: 64.4, y: 0.0, z: 0.0 });
        let entity = world.entities.get_mut(&npc).unwrap();
        entity.yaw = std::f32::consts::FRAC_PI_2;
        entity.native = Some(NativeNpc {
            target: NativeTarget { host: 1, id: 2, spawn: 1 },
            model: "dog".into(),
            bounds: NativeBounds { center: [0.0, 0.4, 0.8], half: [0.6, 0.25, 0.25] },
            motion: None,
        });
        let launch = |height, timed| {
            let mut shots = Projectiles::default();
            shots.launch(0, 0, LaunchPose {
                slot: shots.reserve().unwrap(),
                origin: Vector::new(63.25, height, 0.0),
                direction: Vector::X,
                inherited_velocity: Vector::ZERO,
            }, LaunchSpec { section: "test_grenade".into(), speed: 10.0, timed,
                fuse_ticks: 75, blast_power: 0.4, blast_radius: 4.0 });
            shots
        };
        for timed in [false, true] {
            let mut above = launch(1.55, timed);
            assert!(above.step(&mut world).is_empty());
            assert!(above.active[0].position.x > 63.5);
            assert!(above.active[0].velocity.x > 0.0);
        }
        let mut timed = launch(0.4, true);
        assert!(timed.step(&mut world).is_empty());
        assert!(timed.active[0].velocity.x < 0.0);
        let mut contact = launch(0.4, false);
        let blasts = contact.step(&mut world);
        assert_eq!(blasts.len(), 1);
        assert_eq!(blasts[0].native_hits[0].target_id, npc);
        assert!(contact.active.is_empty());
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
        assert!(!contact.apply(&mut world, ArmourImpact::Hit { power: 0.4, wound: true, gear_changed: true, field_armour: None }, 0.0, true));
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
            inherited_velocity: Vector::ZERO,
        }, LaunchSpec { section: "wpn_fake_missile2".into(), speed: 32.0, timed: false, fuse_ticks: 1, blast_power: 0.4, blast_radius: 4.0 });
        assert_eq!(shots.reserve().unwrap_err(), "projectile_capacity");
        shots.step(&mut World::new());
        assert!(shots.reserve().is_ok());
    }
}
