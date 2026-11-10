//! Free flight from the CoP multiplayer bullet manager. The simulation traces
//! bounded chords against the same rewind frame as the firearm transaction.
use crate::collision::BulletSurface;
use crate::xray_combat_rules;
use parry3d::math::Vector;
use serde::{Deserialize, Serialize};

const MAX_CHORD_ERROR: f32 = 0.05;
const MAX_FLIGHT_SECONDS: f32 = 12.0;
const DRAG_CUTOFF_EPSILON: f32 = 0.1;
const SURFACE_EPSILON: f32 = 0.000_01;
const SURFACE_ADVANCE: f32 = 0.001;
pub(crate) const MAX_PELLETS: u8 = 16;
pub(crate) const MAX_SURFACE_CONTACTS: u8 = 32;
// Also enforced by the native A-Life bridge. Stock Gauss ammunition uses 150.
pub(crate) const MAX_PENETRATION: f32 = 1000.0;

/// Authoritative equipped round, projected from SQLite alongside the loadout.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoundProfile {
    pub revision: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<RoundKey>,
    pub range: f32,
    pub speed: f32,
    pub drag: f32,
    pub gravity: f32,
    pub pellets: u8,
    pub spread: Dispersion,
    pub surface: SurfaceProfile,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct RoundKey {
    pub(crate) weapon: [u8; 16],
    pub(crate) ammunition: [u8; 16],
    pub(crate) condition: f32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct SurfaceProfile {
    pub penetration: f32,
    pub ricochet: bool,
    pub magnetic: bool,
    pub energy_min: f32,
    pub energy_max: f32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Dispersion {
    pub first: f32,
    pub followup: f32,
    pub actor_base: f32,
    #[serde(default)]
    pub actor_aim: f32,
    pub velocity_factor: f32,
    pub acceleration_factor: f32,
    pub crouch_factor: f32,
    pub crouch_still_factor: f32,
}

impl Dispersion {
    pub(crate) fn cone(self, speed: f32, turn_speed: f32, crouched: bool, followup: bool, aimed: bool) -> f32 {
        let weapon = if followup { self.followup } else { self.first };
        let actor = if aimed { self.actor_aim } else { self.hip_dispersion(speed, turn_speed, crouched) };
        (weapon + actor).clamp(0.0, std::f32::consts::FRAC_PI_4)
    }

    fn hip_dispersion(self, speed: f32, turn_speed: f32, crouched: bool) -> f32 {
        let mut actor = self.actor_base
            * (1.0 + turn_speed * self.velocity_factor / 10.0)
            * (1.0 + speed * self.velocity_factor / 10.0);
        // A moving crouch currently uses the acceleration term.
        let moving = speed > 0.1;
        if moving || !crouched {
            actor *= 1.0 + self.acceleration_factor;
        }
        if crouched {
            actor *= 1.0 + self.crouch_factor;
            if !moving {
                actor *= 1.0 + self.crouch_still_factor;
            }
        }
        actor
    }
}

pub(crate) struct Spread(u64);

impl Spread {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn uniform(&mut self) -> f32 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut bits = self.0;
        bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        let bits = bits ^ (bits >> 31);
        ((bits >> 40) as f32 + 0.5) / 16_777_216.0
    }

    pub(crate) fn direction(&mut self, aim: Vector, cone: f32) -> Vector {
        if cone == 0.0 {
            return aim;
        }
        // CoP samples a signed, truncated normal radius using an exponential
        // proposal, then uses a half-turn for the angle around the aim axis.
        let mut sample = 0.0;
        for _ in 0..24 {
            let candidate = -self.uniform().ln();
            if self.uniform() <= (-0.5 * (candidate - 1.0).powi(2)).exp() {
                sample = candidate;
                break;
            }
        }
        let sign = if self.uniform() < 0.5 { -1.0 } else { 1.0 };
        let radius = (sign * sample * cone / (3.0 * 0.7975))
            .clamp(-cone, cone)
            .tan();
        let (sine, cosine) = (self.uniform() * std::f32::consts::PI).sin_cos();
        let axis = if aim.y.abs() < 0.999 {
            Vector::Y
        } else {
            Vector::X
        };
        let right = aim.cross(axis).normalize();
        let up = right.cross(aim);
        (aim + (up * sine + right * cosine) * radius).normalize()
    }

    fn penetrated_direction(&mut self, aim: Vector) -> Vector {
        let z = (self.uniform() * std::f32::consts::PI).cos();
        let (sine, cosine) = (self.uniform() * std::f32::consts::TAU).sin_cos();
        let xy = (1.0 - z * z).sqrt();
        let random = Vector::new(xy * cosine, xy * sine, z);
        (aim + random * (self.uniform() * 2.0_f32.to_radians().tan())).normalize()
    }
}

pub(crate) struct MaterialFlight {
    profile: SurfaceProfile,
    pub penetration: f32,
    density_entry: Option<(Vector, f32)>,
}

impl MaterialFlight {
    pub(crate) fn new(profile: SurfaceProfile) -> Self {
        Self {
            profile,
            penetration: profile.penetration,
            density_entry: None,
        }
    }

    pub(crate) fn cross(
        &mut self,
        hit: BulletSurface,
        point: Vector,
        velocity: Vector,
        drag: f32,
        spread: &mut Spread,
    ) -> Option<Vector> {
        let mut speed = velocity.length();
        let direction = velocity.try_normalize()?;
        if let Some((entry, density)) = self.density_entry {
            speed = xray_combat_rules::density_speed(speed, point.distance(entry), density);
        }
        let incidence = direction.dot(hit.normal);
        self.density_entry = (incidence < 0.0 && hit.density > 0.0).then_some((point, hit.density));
        if speed < 1.0 {
            return None;
        }
        use xray_combat_rules::SurfaceAction;
        let response = |outgoing_dot, threshold| xray_combat_rules::surface_response([
            self.penetration, hit.shoot_factor, drag, incidence, outgoing_dot, threshold,
            self.profile.energy_min, self.profile.energy_max, SURFACE_EPSILON,
        ], self.profile.magnetic, self.profile.ricochet, hit.allows_ricochet);
        let (action, mut scale, penetration) = response(0.0, 1.0);
        match action {
            SurfaceAction::Transparent => return Some(direction * speed),
            SurfaceAction::Magnetic => {
                self.penetration = penetration;
                return Some(direction * speed);
            }
            _ => {}
        }
        if self.profile.ricochet && hit.allows_ricochet {
            let reflected = (direction - 2.0 * incidence * hit.normal).normalize();
            let outgoing = spread.direction(reflected, 10.0_f32.to_radians());
            let (action, outgoing_scale, _) = response(direction.dot(outgoing), 0.5 + 0.3 * spread.uniform());
            scale = outgoing_scale;
            if action == SurfaceAction::Ricochet {
                self.profile.ricochet = false;
                return Some(outgoing * (speed * scale));
            }
        }
        (scale >= SURFACE_EPSILON).then(|| spread.penetrated_direction(direction) * (speed * scale))
    }
}

pub(crate) struct Flight {
    position: Vector,
    velocity: Vector,
    gravity: Vector,
    drag: f32,
    origin: Vector,
    launch_velocity: Vector,
    elapsed: f32,
    path_velocity: Vector,
    drag_acceleration: Vector,
    drag_left: f32,
    time_left: f32,
    distance_left: f32,
}

pub(crate) struct Segment {
    pub start: Vector,
    pub direction: Vector,
    pub range: f32,
    velocity: Vector,
    acceleration: Vector,
    duration: f32,
    launch_velocity: Vector,
    elapsed: f32,
    gravity: f32,
    drag: f32,
}

impl Segment {
    fn contact_time(&self, distance: f32) -> f32 {
        let speed = self.velocity.dot(self.direction);
        let acceleration = self.acceleration.dot(self.direction);
        let end_speed = (speed * speed + 2.0 * acceleration * distance)
            .max(0.0)
            .sqrt();
        // Solve the quadratic along the chord with the stable form of the
        // earliest root. A zero-distance contact uses the starting velocity.
        if distance > 0.0 {
            (2.0 * distance / (speed + end_speed)).clamp(0.0, self.duration)
        } else {
            0.0
        }
    }

    pub(crate) fn impact_velocity(&self, distance: f32) -> Vector {
        xray_combat_rules::trajectory(self.launch_velocity, self.gravity, self.drag,
            self.elapsed + self.contact_time(distance)).1
    }
}

impl Flight {
    pub(crate) fn new(origin: Vector, direction: Vector, round: RoundProfile) -> Self {
        let mut flight = Self {
            position: origin,
            velocity: direction * round.speed,
            gravity: -Vector::Y * round.gravity,
            drag: round.drag,
            origin,
            launch_velocity: direction * round.speed,
            elapsed: 0.0,
            path_velocity: direction * round.speed,
            drag_acceleration: Vector::ZERO,
            drag_left: 0.0,
            time_left: MAX_FLIGHT_SECONDS,
            distance_left: round.range,
        };
        flight.reset_drag();
        flight
    }

    fn reset_drag(&mut self) {
        self.origin = self.position;
        self.launch_velocity = self.velocity;
        self.path_velocity = self.velocity;
        self.elapsed = 0.0;
        // The original switches to gravity-only flight just before the initial
        // velocity term reaches zero. Near-vertical shots also skip drag.
        let drag =
            if self.velocity.x * self.velocity.x + self.velocity.z * self.velocity.z < 1.0e-7 {
                0.0
            } else {
                self.drag
            };
        self.drag_acceleration = -self.velocity * drag;
        self.drag_left = (self.drag.recip() - DRAG_CUTOFF_EPSILON).max(0.0);
    }

    pub(crate) fn resume(&mut self, segment: &Segment, distance: f32, velocity: Vector) -> f32 {
        let speed = velocity.length();
        let remaining = self.distance_left + segment.range - distance;
        let advance = SURFACE_ADVANCE.min(remaining.max(0.0));
        self.distance_left = remaining - advance;
        self.time_left +=
            segment.duration - segment.contact_time(distance) - advance / speed.max(1.0);
        self.position =
            segment.start + segment.direction * distance + velocity.normalize_or_zero() * advance;
        self.velocity = velocity;
        self.reset_drag();
        advance
    }
}

impl Iterator for Flight {
    type Item = Segment;

    fn next(&mut self) -> Option<Self::Item> {
        if self.time_left <= 0.0
            || self.distance_left <= 0.0
            || self.velocity.length_squared() < 1.0
        {
            return None;
        }
        let acceleration = if self.drag_left > 0.0 {
            self.gravity + self.drag_acceleration
        } else {
            self.gravity
        };
        // For constant acceleration the maximum midpoint error from the chord
        // is |a| * dt² / 8. Never straddle the change in acceleration.
        let phase_left = if self.drag_left > 0.0 {
            self.drag_left
        } else {
            self.time_left
        };
        let dt = (8.0 * MAX_CHORD_ERROR / acceleration.length())
            .sqrt()
            .min(self.time_left)
            .min(phase_left);
        let start = self.position;
        let velocity = self.path_velocity;
        let elapsed = self.elapsed;
        self.elapsed += dt;
        let (offset, next_velocity) = xray_combat_rules::trajectory(
            self.launch_velocity, -self.gravity.y, self.drag, self.elapsed);
        let displacement = self.origin + offset - start;
        self.path_velocity += acceleration * dt;
        let length = displacement.length();
        self.time_left -= dt;
        self.drag_left -= dt;
        self.position += displacement;
        self.velocity = next_velocity;
        if length <= f32::EPSILON {
            return None;
        }
        let distance = length.min(self.distance_left);
        self.distance_left -= distance;
        Some(Segment {
            start,
            direction: displacement / length,
            range: distance,
            velocity,
            acceleration,
            duration: dt,
            launch_velocity: self.launch_velocity,
            elapsed,
            gravity: -self.gravity.y,
            drag: self.drag,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_speed_loss_uses_entry_density_and_the_cartridges_penetration() {
        let mut spread = Spread::new(12);
        let profile = SurfaceProfile {
            penetration: 1.0,
            ..Default::default()
        };
        let mut flight = MaterialFlight::new(profile);
        let surface = BulletSurface {
            distance: 1.0,
            normal: -Vector::Z,
            shoot_factor: 0.25,
            density: 20.0,
            allows_ricochet: true,
        };
        let entered = flight
            .cross(surface, Vector::ZERO, Vector::Z * 100.0, 1.0, &mut spread)
            .unwrap();
        assert!((entered.length() - 75.0).abs() < 0.0001);
        let exited = flight
            .cross(
                BulletSurface {
                    normal: Vector::Z,
                    ..surface
                },
                Vector::Z,
                entered,
                1.0,
                &mut spread,
            )
            .unwrap();
        assert!((exited.length() - 41.25).abs() < 0.0001);
        assert!(flight.density_entry.is_none());

        let mut beam = MaterialFlight::new(SurfaceProfile {
            magnetic: true,
            ..profile
        });
        let outgoing = beam
            .cross(surface, Vector::ZERO, Vector::Z * 100.0, 0.5, &mut spread)
            .unwrap();
        assert_eq!(outgoing, Vector::Z * 100.0);
        assert_eq!(beam.penetration, 0.875);
    }

    #[test]
    fn native_surface_threshold_and_exhausted_magnetic_penetration() {
        use xray_combat_rules::SurfaceAction;
        let values = [0.0, SURFACE_EPSILON, 1.0, -1.0, 0.0, 1.0, 0.8, 0.5, SURFACE_EPSILON];
        assert_eq!(xray_combat_rules::surface_response(values, false, false, false).0, SurfaceAction::Stop);
        let mut transparent = values;
        transparent[1] = SURFACE_EPSILON * 0.5;
        assert_eq!(xray_combat_rules::surface_response(transparent, false, false, false).0, SurfaceAction::Transparent);
        let grazing = [0.0, 1.0, 1.0, -0.1, 0.9, 0.6, 0.8, 0.5, SURFACE_EPSILON];
        assert_eq!(xray_combat_rules::surface_response(grazing, false, true, true).0, SurfaceAction::Ricochet);
        assert_eq!(xray_combat_rules::surface_response(grazing, false, true, false).0, SurfaceAction::Stop);
        assert_eq!(xray_combat_rules::surface_response(grazing, false, false, true).0, SurfaceAction::Stop);
        let magnetic = [0.5, 0.25, 4.0, -1.0, 0.9, 0.6, 0.8, 0.5, SURFACE_EPSILON];
        assert_eq!(xray_combat_rules::surface_response(magnetic, true, true, true), (SurfaceAction::Magnetic, 1.0, -0.5));
        assert_eq!(xray_combat_rules::density_speed(10.0, 2.0, 8.0), 0.0);
    }

    #[test]
    fn grazing_shot_can_ricochet_once_with_authored_energy_loss() {
        let mut spread = Spread::new(19);
        let profile = SurfaceProfile {
            ricochet: true,
            energy_min: 0.8,
            energy_max: 0.5,
            ..Default::default()
        };
        let mut flight = MaterialFlight::new(profile);
        let hit = BulletSurface {
            distance: 1.0,
            normal: -Vector::X,
            shoot_factor: 1.0,
            density: 0.0,
            allows_ricochet: true,
        };
        let velocity = Vector::new(0.22, 0.0, 1.0).normalize() * 300.0;
        let reflected = flight
            .cross(hit, Vector::ZERO, velocity, 1.0, &mut spread)
            .unwrap();
        assert!(reflected.x < 0.0);
        assert!((reflected.length() - 150.0).abs() < 0.0001);
        assert!(
            flight
                .cross(hit, Vector::ZERO, velocity, 1.0, &mut spread)
                .is_none()
        );
        assert!(
            MaterialFlight::new(profile)
                .cross(
                    BulletSurface {
                        allows_ricochet: false,
                        ..hit
                    },
                    Vector::ZERO,
                    velocity,
                    1.0,
                    &mut spread
                )
                .is_none()
        );
    }

    #[test]
    fn stock_pellet_directions_vary_inside_the_configured_cone() {
        let mut sampler = Spread::new(19);
        let cone = 3.0_f32.to_radians();
        let directions: Vec<_> = (0..15)
            .map(|_| sampler.direction(Vector::Z, cone))
            .collect();
        assert!(
            directions
                .iter()
                .all(|direction| direction.dot(Vector::Z) >= cone.cos() - 1.0e-6)
        );
        assert!(directions.iter().any(|direction| direction.x < 0.0));
        assert!(directions.iter().any(|direction| direction.x > 0.0));
        assert!(directions.windows(2).all(|pair| pair[0] != pair[1]));
        assert_eq!(sampler.direction(Vector::Z, 0.0), Vector::Z);
    }

    #[test]
    fn native_impact_velocity_uses_its_own_drag_transition() {
        // Stock position transitions at 0.4 s, but velocity keeps losing
        // horizontal speed until 0.5 s. Previously Rust retained 20 m/s.
        let (position, velocity) = xray_combat_rules::trajectory(Vector::Z * 100.0, 10.0, 2.0, 0.6);
        assert!(position.distance(Vector::new(0.0, -1.8, 28.0)) < 0.0001);
        assert!(velocity.distance(Vector::new(0.0, -6.0, 0.0)) < 0.0001);
        let (position, velocity) = xray_combat_rules::trajectory(Vector::Z * 100.0, 10.0, 0.0, 2.0);
        assert!(position.distance(Vector::new(0.0, -20.0, 200.0)) < 0.0001);
        assert!(velocity.distance(Vector::new(0.0, -20.0, 100.0)) < 0.0001);
        let (position, velocity) = xray_combat_rules::trajectory(Vector::Y * 100.0, 10.0, 2.0, 0.2);
        assert!(position.distance(Vector::Y * 19.8) < 0.0001);
        assert!(velocity.distance(Vector::Y * 98.0) < 0.0001);
    }

    #[test]
    fn stock_drag_phase_ends_before_gravity_only_flight() {
        let round = RoundProfile {
            revision: 0,
            key: None,
            range: 100.0,
            speed: 100.0,
            drag: 2.0,
            gravity: 10.0,
            pellets: 1,
            spread: Dispersion::default(),
            surface: SurfaceProfile::default(),
        };
        let mut flight = Flight::new(Vector::ZERO, Vector::Z, round);
        while flight.drag_left > 0.0 {
            flight.next().unwrap();
        }
        // The first phase ends at 1 / 2 - 0.1 = 0.4 s.
        assert!(flight.position.distance(Vector::new(0.0, -0.8, 24.0)) < 0.0001);
        assert!(flight.velocity.distance(Vector::new(0.0, -4.0, 20.0)) < 0.0001);
        let fall = flight.next().unwrap();
        assert_eq!(fall.acceleration, -Vector::Y * 10.0);
        assert!(
            (fall.impact_velocity(fall.range).length() - flight.velocity.length()).abs() < 0.0001
        );
    }

    #[test]
    fn truncated_final_chord_uses_contact_speed_at_the_range_limit() {
        let round = RoundProfile {
            revision: 0,
            key: None,
            range: 0.5,
            speed: 100.0,
            drag: 2.0,
            gravity: 0.0,
            pellets: 1,
            spread: Dispersion::default(),
            surface: SurfaceProfile::default(),
        };
        let mut flight = Flight::new(Vector::ZERO, Vector::Z, round);
        let segment = flight.next().unwrap();
        assert_eq!(segment.range, 0.5);
        let expected = (100.0_f32.powi(2) - 2.0 * 200.0 * segment.range).sqrt();
        assert!((segment.impact_velocity(segment.range).length() - expected).abs() < 0.0001);
        assert!(flight.next().is_none());
    }

    #[test]
    fn quest_gauss_muzzle_speed_still_traces_a_bounded_path() {
        let round = RoundProfile {
            revision: 0,
            key: None,
            range: 2000.0,
            speed: 100_000.0,
            drag: 1.0,
            gravity: 9.81,
            pellets: 1,
            spread: Dispersion::default(),
            surface: SurfaceProfile::default(),
        };
        let mut distance = 0.0;
        let mut segments = 0;
        for segment in Flight::new(Vector::ZERO, Vector::Z, round) {
            assert!(segment.impact_velocity(segment.range).length().is_finite());
            distance += segment.range;
            segments += 1;
        }
        assert!((distance - round.range).abs() < 0.001);
        assert!((2..=16).contains(&segments));
    }
}
