//! Animated collision forms exported by the native host for player rewind.
use parry3d::{
    bounding_volume::Aabb,
    math::Vector,
    query::{Ray, RayCast},
};
use std::sync::Arc;

unsafe extern "C" {
    fn zone_skeleton_ray(kind: u32, data: *const f32, origin: *const f32,
        direction: *const f32, range: *mut f32) -> bool;
}

pub(crate) const MAX_AGE: u32 = 5;
const ROW: usize = 96;

#[derive(Debug)]
pub(crate) struct Hitboxes {
    feet: Vector,
    bounds: Aabb,
    bones: Vec<(Arc<str>, Shape)>,
}

#[derive(Debug)]
enum Shape {
    Box {
        columns: [Vector; 3],
        offset: Vector,
        half: Vector,
    },
    Sphere {
        center: Vector,
        radius: f32,
    },
    Cylinder {
        center: Vector,
        direction: Vector,
        half_height: f32,
        radius: f32,
    },
}

impl Shape {
    fn bounds(&self) -> (Vector, f32) {
        match *self {
            Self::Box {
                columns: [x, y, z],
                offset,
                half,
            } => (
                -Vector::new(x.dot(offset), y.dot(offset), z.dot(offset)),
                half.length(),
            ),
            Self::Sphere { center, radius } => (center, radius),
            Self::Cylinder {
                center,
                half_height,
                radius,
                ..
            } => (center, half_height.hypot(radius)),
        }
    }

    fn cast(&self, ray: &Ray, range: f32) -> Option<f32> {
        let mut data = [0.0; 15];
        let kind = match *self {
            Self::Box { columns: [x, y, z], offset, half } => {
                for (i, vector) in [x, y, z, offset, half].into_iter().enumerate() {
                    data[3 * i..3 * i + 3].copy_from_slice(&vector.to_array());
                }
                1
            }
            Self::Sphere { center, radius } => {
                data[..3].copy_from_slice(&center.to_array());
                data[3] = radius;
                2
            }
            Self::Cylinder { center, direction, half_height, radius } => {
                data[..3].copy_from_slice(&center.to_array());
                data[3..6].copy_from_slice(&direction.to_array());
                data[6] = half_height * 2.0;
                data[7] = radius;
                3
            }
        };
        let origin = ray.origin.to_array();
        let direction = ray.dir.to_array();
        let mut distance = range;
        // All shape values were validated on decode. The adapter reads at most
        // 15 shape components and three components from each ray array.
        let hit = unsafe { zone_skeleton_ray(kind, data.as_ptr(), origin.as_ptr(),
            direction.as_ptr(), &mut distance) };
        (hit && distance.is_finite() && distance >= 0.0 && distance < range).then_some(distance)
    }

}

impl Hitboxes {
    pub(crate) fn decode(feet: Vector, bytes: &[u8]) -> Option<Self> {
        if !feet.is_finite()
            || feet.abs().max_element() > 100_000.0
            || !(ROW..=64 * ROW).contains(&bytes.len())
            || !bytes.len().is_multiple_of(ROW)
        {
            return None;
        }
        let mut mins = Vector::splat(f32::INFINITY);
        let mut maxs = Vector::splat(f32::NEG_INFINITY);
        let mut bones = Vec::with_capacity(bytes.len() / ROW);
        for row in bytes.chunks_exact(ROW) {
            let end = row[4..36].iter().position(|&ch| ch == 0)? + 4;
            let name = &row[4..end];
            if name.is_empty()
                || !name
                    .iter()
                    .all(|ch| ch.is_ascii_alphanumeric() || *ch == b'_')
            {
                return None;
            }
            let scalar =
                |n: usize| f32::from_le_bytes(row[36 + 4 * n..40 + 4 * n].try_into().unwrap());
            let vec = |n| Vector::new(scalar(n), scalar(n + 1), scalar(n + 2));
            let bounded = |v: Vector| v.is_finite() && v.abs().max_element() < 200_000.0;
            let positive = |v: f32| v > 0.0 && v <= 8.0;
            let unit = |v: Vector| (0.99..=1.01).contains(&v.length_squared());
            let shape = match row[0] {
                1 => {
                    let (x, y, z, offset, half) = (vec(0), vec(3), vec(6), vec(9), vec(12));
                    if ![x, y, z].into_iter().all(unit)
                        || !bounded(offset)
                        || !half.to_array().into_iter().all(positive)
                        || [x.dot(y), x.dot(z), y.dot(z)]
                            .into_iter()
                            .any(|v| v.abs() > 0.01)
                    {
                        return None;
                    }
                    Shape::Box {
                        columns: [x, y, z],
                        offset,
                        half,
                    }
                }
                2 if bounded(vec(0)) && positive(scalar(3)) => Shape::Sphere {
                    center: vec(0),
                    radius: scalar(3),
                },
                3 if bounded(vec(0))
                    && unit(vec(3))
                    && positive(scalar(6))
                    && positive(scalar(7)) =>
                {
                    Shape::Cylinder {
                        center: vec(0),
                        direction: vec(3),
                        half_height: scalar(6) * 0.5,
                        radius: scalar(7),
                    }
                }
                _ => return None,
            };
            let (center, radius) = shape.bounds();
            // Include small deviations in animated bone matrix orthonormality.
            let extent = Vector::splat(radius * 1.02 + 0.001);
            mins = mins.min(center - extent);
            maxs = maxs.max(center + extent);
            bones.push((std::str::from_utf8(name).ok()?.into(), shape));
        }
        Some(Self {
            feet,
            bounds: Aabb::new(mins, maxs),
            bones,
        })
    }

    pub(crate) fn cast(
        &self,
        ray: &Ray,
        range: f32,
        rewind_feet: Vector,
    ) -> Option<(f32, Arc<str>)> {
        if !ray.origin.is_finite() || !ray.dir.is_finite() || !rewind_feet.is_finite()
            || !range.is_finite() || range <= 0.0
            || !(0.99..=1.01).contains(&ray.dir.length_squared())
        {
            return None;
        }
        // Pose samples may be staggered across ticks. Use the accepted movement
        // position in the rewind frame while retaining the engine's bone pose.
        let ray = Ray::new(ray.origin + (self.feet - rewind_feet), ray.dir);
        self.bounds.cast_local_ray(&ray, range, true)?;
        let mut nearest = None;
        let mut limit = range;
        for (bone, shape) in &self.bones {
            if let Some(distance) = shape.cast(&ray, limit).filter(|&d| d < limit) {
                nearest = Some((distance, bone));
                limit = distance;
            }
        }
        nearest.map(|(distance, bone)| (distance, bone.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_shapes_preserve_rotations_caps_culling_and_range() {
        let ray = Ray::new(Vector::ZERO, Vector::Z);
        let rotated_box = Shape::Box {
            columns: [Vector::Z, Vector::Y, -Vector::X],
            offset: Vector::X * 5.0,
            half: Vector::new(0.25, 0.5, 1.0),
        };
        assert!((rotated_box.cast(&ray, 10.0).unwrap() - 4.75).abs() < 0.0001);
        assert!(rotated_box.cast(&ray, 4.75).is_none());
        assert!(rotated_box.cast(&Ray::new(Vector::Z * 5.0, Vector::Z), 10.0).is_none());
        let cylinder = Shape::Cylinder {
            center: Vector::Z * 5.0, direction: Vector::X, half_height: 1.0, radius: 0.5,
        };
        assert!((cylinder.cast(&ray, 10.0).unwrap() - 4.5).abs() < 0.0001);
        assert!((cylinder.cast(&Ray::new(Vector::new(-3.0, 0.0, 5.0), Vector::X), 10.0)
            .unwrap() - 2.0).abs() < 0.0001);
        assert!(cylinder.cast(&Ray::new(Vector::Z * 5.0, Vector::X), 10.0).is_none());
        assert!(cylinder.cast(&Ray::new(Vector::Y, Vector::Z), 10.0).is_none());
        let sphere = Shape::Sphere { center: Vector::Z * 5.0, radius: 1.0 };
        assert!((sphere.cast(&Ray::new(Vector::X, Vector::Z), 10.0).unwrap() - 5.0).abs() < 0.0001);
        assert!(sphere.cast(&Ray::new(Vector::Z * 5.0, Vector::Z), 10.0).is_none());
        assert!(sphere.cast(&ray, 4.0).is_none());
    }

    #[test]
    fn uses_the_native_bone_and_contact_instead_of_body_height() {
        let mut packet = [0; 2 * ROW];
        for (row, bone, center, radius) in [
            (0, "bip01_head", [0.55, 1.1, 7.0], 0.12f32),
            (ROW, "bip01_spine2", [0.0, 1.1, 7.0], 0.17),
        ] {
            packet[row] = 2;
            packet[row + 4..row + 4 + bone.len()].copy_from_slice(bone.as_bytes());
            for (i, value) in center.into_iter().chain([radius]).enumerate() {
                packet[row + 36 + 4 * i..row + 40 + 4 * i].copy_from_slice(&value.to_le_bytes());
            }
        }
        let shapes = Hitboxes::decode(Vector::ZERO, &packet).unwrap();
        let ray = Ray::new(Vector::new(0.55, 1.1, 0.0), Vector::Z);
        assert_eq!(
            &*shapes.cast(&ray, 10.0, Vector::ZERO).unwrap().1,
            "bip01_head"
        );
        assert!(shapes.cast(&ray, 5.0, Vector::ZERO).is_none());
        let ray = Ray::new(Vector::new(0.3, 1.1, 0.0), Vector::Z);
        assert!(shapes.cast(&ray, 10.0, Vector::ZERO).is_none());
        assert_eq!(
            &*shapes.cast(&ray, 10.0, Vector::X * -0.25).unwrap().1,
            "bip01_head"
        );
    }
}
