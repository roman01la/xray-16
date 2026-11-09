//! Original ALife shapes in the shared character motor's world coordinates.
use crate::{collision::rotation_basis, world::Vec3};
use anyhow::{Result, ensure};
use parry3d::math::Vector;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Shape {
    Sphere {
        center: [f32; 3],
        radius: f32,
    },
    Box {
        center: [f32; 3],
        axes: [[f32; 3]; 3],
    },
}

impl Shape {
    pub(crate) fn bounds(&self) -> (Vector, Vector) {
        let (center, half) = match self {
            Self::Sphere { center, radius } => (*center, Vector::splat(*radius)),
            Self::Box { center, axes } => (*center, box_half_extent(*axes)),
        };
        let center = Vector::from_array(center);
        (center - half, center + half)
    }
}

fn box_half_extent(axes: [[f32; 3]; 3]) -> Vector {
    axes.map(Vector::from_array)
        .map(Vector::abs)
        .into_iter()
        .sum::<Vector>()
        * 0.5
}

#[derive(Clone, Copy, Debug)]
enum Contact {
    Sphere(f32),
    Box([(Vector, f32); 3]),
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Volume {
    pub center: Vector,
    pub radius: f32,
    contact: Contact,
}

impl Serialize for Volume {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut view = serializer.serialize_struct(
            "SafeZone",
            if matches!(self.contact, Contact::Box(_)) {
                3
            } else {
                2
            },
        )?;
        let [x, y, z] = self.center.to_array();
        view.serialize_field("center", &Vec3 { x, y, z })?;
        view.serialize_field("radius", &self.radius)?;
        if let Contact::Box(planes) = self.contact {
            view.serialize_field(
                "planes",
                &planes.map(|(axis, extent)| [axis.x, axis.y, axis.z, extent]),
            )?;
        }
        view.end()
    }
}

impl Volume {
    pub(crate) fn sphere(center: Vector, radius: f32) -> Self {
        Self {
            center,
            radius,
            contact: Contact::Sphere(radius),
        }
    }

    pub(crate) fn new(shape: Shape, position: [f32; 3], rotation: [f32; 3]) -> Result<Self> {
        let basis = rotation_basis(rotation);
        let rotate = |v: [f32; 3]| basis[0] * v[0] + basis[1] * v[1] + basis[2] * v[2];
        let (local_center, radius, contact) = match shape {
            Shape::Sphere { center, radius } => (center, radius, Contact::Sphere(radius)),
            Shape::Box { center, axes } => {
                let world = axes.map(rotate);
                let lengths = world.map(|axis| axis.length());
                ensure!(
                    lengths
                        .iter()
                        .all(|length| (0.001..=1000.0).contains(length)),
                    "invalid authored box dimensions"
                );
                let planes = std::array::from_fn(|i| (world[i] / lengths[i], lengths[i] * 0.5));
                ensure!(
                    (0..3).all(|i| (i + 1..3).all(|j| planes[i].0.dot(planes[j].0).abs() < 0.001)),
                    "nonorthogonal authored box"
                );
                // CCF_Shape builds the bounding sphere from the local AABB.
                (center, box_half_extent(axes).length(), Contact::Box(planes))
            }
        };
        let center = Vector::from_array(position) + rotate(local_center);
        ensure!(
            center.is_finite() && (0.001..=1000.0).contains(&radius),
            "invalid authored volume"
        );
        Ok(Self {
            center,
            radius,
            contact,
        })
    }

    pub(crate) fn overlaps(&self, min: [f32; 3], max: [f32; 3]) -> bool {
        let half_extent = match &self.contact {
            Contact::Sphere(radius) => Vector::splat(*radius),
            Contact::Box(planes) => planes
                .iter()
                .map(|(axis, extent)| axis.abs() * *extent)
                .sum(),
        };
        (0..3).all(|i| {
            self.center[i] - half_extent[i] <= max[i] && self.center[i] + half_extent[i] >= min[i]
        })
    }

    pub(crate) fn contains(&self, point: Vector) -> bool {
        let offset = point - self.center;
        match &self.contact {
            Contact::Sphere(radius) => offset.length_squared() <= radius * radius,
            Contact::Box(planes) => planes
                .iter()
                .all(|(axis, extent)| offset.dot(*axis).abs() <= *extent),
        }
    }

    pub(crate) fn touches(&self, feet: Vector, height: f32) -> bool {
        let offset = feet - self.center;
        const CAPSULE_RADIUS: f32 = 0.35;
        match &self.contact {
            Contact::Sphere(radius) => {
                let nearest = (-offset.y).clamp(CAPSULE_RADIUS, height - CAPSULE_RADIUS);
                (offset + Vector::Y * nearest).length_squared() <= (radius + CAPSULE_RADIUS).powi(2)
            }
            Contact::Box(planes) => {
                let half_height = height * 0.5;
                let middle = offset + Vector::Y * half_height;
                planes.iter().all(|(axis, half_extent)| {
                    middle.dot(*axis).abs()
                        <= half_extent
                            + CAPSULE_RADIUS
                            + axis.y.abs() * (half_height - CAPSULE_RADIUS)
                })
            }
        }
    }
}
