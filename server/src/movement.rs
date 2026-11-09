//! Shared fixed-tick server and browser-prediction character motor.
//! Inputs are directions, never positions or elapsed time. No X-Ray local physics.
use crate::collision::CollisionMap;
pub const TICK_HZ: u32 = 30;
use anyhow::{Result, ensure};
use parry3d::math::Vector;
const DT: f32 = 1.0 / TICK_HZ as f32;
pub(crate) const SPRINT_SPEED: f32 = 6.0;
const WALKABLE_Y: f32 = 0.70710677; // 45 degrees
#[derive(Clone, Copy, Debug)]
pub struct Character {
    pub feet: Vector,
    pub vertical_speed: f32,
    pub grounded: bool,
    pub crouched: bool,
    pub jump_held: bool,
    pub climbing: bool,
}
impl Character {
    pub fn new(feet: Vector) -> Self {
        Self {
            feet,
            vertical_speed: 0.0,
            grounded: false,
            crouched: false,
            jump_held: false,
            climbing: false,
        }
    }
    pub fn step(&mut self, map: &CollisionMap, x: f32, z: f32, sprint: bool) -> Result<()> {
        self.step_command(map, x, z, sprint, false, false, false)
            .map(|_| ())
    }
    pub fn step_command(
        &mut self,
        map: &CollisionMap,
        x: f32,
        z: f32,
        sprint: bool,
        jump: bool,
        crouch: bool,
        walk: bool,
    ) -> Result<bool> {
        ensure!(
            map.actor_ready(),
            "movement requires material-aware geometry"
        );
        ensure!(
            self.feet.is_finite()
                && self.vertical_speed.is_finite()
                && x.is_finite()
                && z.is_finite(),
            "invalid movement state/input"
        );
        let mut next = *self;
        let scale = x.hypot(z).max(1.0);
        if crouch {
            next.crouched = true;
        } else if next.crouched
            && map
                .sweep_actor_clear(next.feet, Vector::Y * 0.6, 1.2)?
                .is_none()
        {
            next.crouched = false;
        }
        if !jump && !next.crouched && next.climb(map, Vector::new(x / scale, 0., z / scale))? {
            next.jump_held = false;
            *self = next;
            return Ok(false);
        }
        next.climbing = false;
        let jumped = jump && !next.jump_held && next.grounded && !next.crouched;
        if jumped {
            next.vertical_speed = 5.0;
            next.grounded = false;
        }
        next.jump_held = jump;
        let height = if next.crouched { 1.2 } else { 1.8 };
        let speed = if next.crouched || walk {
            2.0
        } else if sprint {
            SPRINT_SPEED
        } else {
            4.0
        };
        next.vertical_speed = (next.vertical_speed - 9.81 * DT).max(-40.0);
        next.grounded = false;
        let mut remaining = Vector::new(
            x / scale * speed * DT,
            next.vertical_speed * DT,
            z / scale * speed * DT,
        );
        let mut tried_step = false;
        // Bounded iterative sweep and slide; a contact never permits teleporting
        // through a surface. Residual motion is discarded after five contacts.
        for _ in 0..5 {
            if remaining.length_squared() < 1e-12 {
                break;
            }
            let Some(hit) = map.sweep_actor_height(next.feet, remaining, height)? else {
                next.feet += remaining;
                break;
            };
            ensure!(
                hit.time_of_impact.is_finite() && hit.normal1.is_finite(),
                "invalid collision response"
            );
            // Keep a 5 mm numerical margin outside the query skin so a
            // tangential follow-up sweep does not repeatedly hit the floor at t=0.
            let fraction = (hit.time_of_impact - 0.005 / remaining.length()).clamp(0., 1.);
            next.feet += remaining * fraction;
            remaining *= 1. - fraction;
            let normal = hit.normal1;
            let walkable = map.walkable_contact(&hit);
            if !tried_step
                && (self.grounded || next.grounded)
                && normal.y < WALKABLE_Y
                && next.vertical_speed <= 0.0
            {
                tried_step = true;
                let horizontal = Vector::new(remaining.x, 0., remaining.z);
                if let Some(stepped) = try_step(map, next.feet, horizontal, height)? {
                    next.feet = stepped;
                    next.grounded = true;
                    next.vertical_speed = 0.;
                    break;
                }
            }

            if walkable {
                next.grounded = true;
                if next.vertical_speed < 0. {
                    next.vertical_speed = 0.;
                }
                // A supported idle capsule must not turn gravity into downhill
                // travel. Keep the verified contact and discard residual fall.
                if x == 0. && z == 0. && remaining.y <= 0. {
                    break;
                }
            } else if normal.y < -0.1 && next.vertical_speed > 0. {
                next.vertical_speed = 0.;
            }
            let mut plane = normal;
            // Steep slopes behave as walls for horizontal input; projecting on
            // their full normal would turn horizontal speed into upward motion.
            if plane.y > 0. && !walkable {
                plane.y = 0.;
                plane = plane.normalize_or_zero();
            }
            let into = remaining.dot(plane);
            if into >= -1e-7 {
                // Adjacent floor triangles can report t=0 within the query
                // tolerance even for tangent motion. Recover clearance along
                // the support normal only through another collision-checked
                // sweep; never discard the floor hit and move through it.
                if walkable && fraction == 0.0 {
                    let recovery = normal * 0.005;
                    if map
                        .sweep_actor_height(next.feet, recovery, height)?
                        .is_none()
                    {
                        next.feet += recovery;
                        continue;
                    }
                }
                break;
            }
            remaining -= plane * into;
        }
        ensure!(next.feet.is_finite(), "non-finite movement result");
        *self = next;
        Ok(jumped)
    }

    fn climb(&mut self, map: &CollisionMap, direction: Vector) -> Result<bool> {
        let mut contacts = map.ladders.iter().filter_map(|ladder| {
            let along = ladder.contact(self.feet)?;
            Some((ladder.axis, ladder.speed(direction, along, self.climbing)?))
        });
        let Some((axis, speed)) = contacts.next() else {
            return Ok(false);
        };
        if contacts.next().is_some() {
            return Ok(false);
        }
        let mut delta = axis * speed * DT;
        if speed != 0.0
            && let Some(hit) = map.sweep_actor_clear(self.feet, delta, 1.8)?
        {
            if !self.climbing || speed < 0.0 && map.walkable_contact(&hit) {
                return Ok(false);
            }
            delta *= (hit.time_of_impact - 0.005 / delta.length()).clamp(0., 1.);
        }
        self.feet += delta;
        self.vertical_speed = delta.y / DT;
        self.grounded = false;
        self.climbing = true;
        Ok(true)
    }
}

// An auto-step is accepted only if all three capsule paths are clear and a
// walkable landing is found. Never pop upward through a low ceiling or over a gap.
fn try_step(
    map: &CollisionMap,
    feet: Vector,
    horizontal: Vector,
    height: f32,
) -> Result<Option<Vector>> {
    if horizontal.length_squared() < 1e-10 {
        return Ok(None);
    }
    let up = Vector::Y * 0.35;
    if map.sweep_actor_clear(feet, up, height)?.is_some() {
        return Ok(None);
    }
    let raised = feet + up;
    if map
        .sweep_actor_height(raised, horizontal, height)?
        .is_some()
    {
        return Ok(None);
    }
    let end = raised + horizontal;
    let down = -Vector::Y * 0.4;
    if let Some(hit) = map.sweep_actor_height(end, down, height)?
        && map.walkable_contact(&hit)
    {
        let landing = end + down * hit.time_of_impact + Vector::Y * 0.005;
        if landing.y <= feet.y + 0.35 && landing.y >= feet.y - 0.05 {
            return Ok(Some(landing));
        }
    }
    Ok(None)
}
