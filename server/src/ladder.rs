//! Stock CoP ladder geometry shared by the server and WASM predictor.
use crate::collision::{Bounds, rotation_basis};
use anyhow::{Result, ensure};
use parry3d::math::Vector;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_LADDER_BYTES: usize = 24 * 1024;
const ACTOR_RADIUS: f32 = 0.35;
const MIN_SHELL_HALF_WIDTH: f32 = 0.2;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Placement {
    spawn_id: u16,
    position: [f32; 3],
    rotation: [f32; 3],
    half_extents: [f32; 3],
    material: String,
}

#[derive(Debug)]
pub(crate) struct Ladder {
    center: Vector,
    pub axis: Vector,
    side: Vector,
    normal: Vector,
    half_height: f32,
    half_span: f32,
    half_width: f32,
}

pub(crate) fn decode(raw: Option<&str>, bounds: &Bounds) -> Result<Vec<Ladder>> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    ensure!(raw.len() <= MAX_LADDER_BYTES, "oversized ladder geometry");
    let placements: Vec<Placement> = serde_json::from_str(raw)?;
    ensure!(
        (1..=128).contains(&placements.len()),
        "invalid ladder count"
    );
    let mut ids = BTreeSet::new();
    let mut ladders = Vec::with_capacity(placements.len());
    for placement in placements {
        ensure!(ids.insert(placement.spawn_id), "duplicate ladder spawn ID");
        ladders.extend(Ladder::new(placement, bounds)?);
    }
    Ok(ladders)
}

impl Ladder {
    fn new(placement: Placement, bounds: &Bounds) -> Result<Option<Self>> {
        let half = placement.half_extents;
        ensure!(
            half.iter().all(|v| (0.0..=64.0).contains(v))
                && placement.rotation.iter().all(|v| v.is_finite())
                && (0..3).all(|i| (bounds.min[i]..=bounds.max[i]).contains(&placement.position[i]))
                && matches!(
                    placement.material.as_str(),
                    "materials\\fake_ladders" | "materials\\fake_ladders_woods"
                ),
            "invalid authored ladder placement"
        );
        let basis = rotation_basis(placement.rotation);
        let mut dims = [0, 1, 2];
        dims.sort_by(|&a, &b| half[a].total_cmp(&half[b]));
        let [width, span, height] = dims;
        let axis = basis[height] * basis[height].y.signum();
        ensure!(
            half[height] >= 0.35 && half[span] >= 0.1,
            "invalid authored ladder dimensions"
        );
        // Stock Jupiter also uses the factory for shallow climbable ramps.
        // Leave them to ordinary collision until ramp transitions are supported.
        if axis.y < 0.85 {
            return Ok(None);
        }
        let normal = basis[width];
        let mut center = Vector::from_array(placement.position);
        // CClimableObject extends thin shells inward and keeps their front face.
        if half[width] < MIN_SHELL_HALF_WIDTH {
            center -= normal * MIN_SHELL_HALF_WIDTH;
        }
        Ok(Some(Self {
            center,
            axis,
            side: basis[span],
            normal,
            half_height: half[height],
            half_span: half[span],
            half_width: half[width].max(MIN_SHELL_HALF_WIDTH),
        }))
    }

    /// Match the front face, lateral span and endpoints of the stock climbable box.
    pub fn contact(&self, feet: Vector) -> Option<f32> {
        let offset = feet - self.center;
        let along = offset.dot(self.axis);
        if along < -self.half_height - 0.2
            || along > self.half_height + ACTOR_RADIUS
            || offset.dot(self.side).abs() > self.half_span
        {
            return None;
        }
        let front = offset.dot(self.normal) - self.half_width;
        (ACTOR_RADIUS * 0.5..=ACTOR_RADIUS + 0.05)
            .contains(&front)
            .then_some(along)
    }

    pub fn speed(&self, direction: Vector, along: f32, attached: bool) -> Option<f32> {
        let toward = -direction.dot(self.normal);
        if (!attached && toward < 0.2)
            || (toward > 0.0 && along >= self.half_height + 0.15)
            || (toward < 0.0 && along <= -self.half_height)
            || direction.dot(self.side).abs() > toward.abs() + 0.15
        {
            return None;
        }
        // CoP's actor climb_coef is 0.7. Forward climbs and reverse descends.
        Some(toward * 4.0 * 0.7)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{collision::tests::actor_fixture, movement::Character};

    #[test]
    fn attaches_to_front_and_respects_a_solid_ceiling_while_climbing() {
        let mut map = actor_fixture(0);
        map.ladders = decode(Some(r#"[{"spawnId":1,"position":[0,1.5,0],"rotation":[0,0,0],"halfExtents":[0,1.5,0.6],"material":"materials\\fake_ladders"}]"#), &map.manifest.bounds).unwrap();
        let mut actor = Character::new(Vector::new(0.35, 0.01, 0.));
        let mut behind = Character::new(Vector::new(-0.35, 0.01, 0.));
        behind.step(&map, 1., 0., false).unwrap();
        assert!(!behind.climbing);
        for _ in 0..45 {
            actor.step(&map, -1., 0., false).unwrap();
        }
        assert!(actor.climbing && actor.feet.y > 1.0 && actor.feet.y <= 1.21);
        let stopped = actor.feet;
        actor.step(&map, 0., 0., false).unwrap();
        assert_eq!(actor.feet, stopped);
        for _ in 0..30 {
            actor.step(&map, 1., 0., false).unwrap();
        }
        assert!(actor.grounded && !actor.climbing && actor.feet.y < 0.02);
    }
}
