//! Read-only original X-Ray CFORM v4 geometry. No client positions or gameplay
//! authority are accepted here. Actor geometry applies original material flags.
use anyhow::{Context, Result, ensure};
use parry3d::{
    math::{Pose, Vector},
    query::{Ray, RayCast, ShapeCastHit, ShapeCastOptions, cast_shapes},
    shape::{Ball, Capsule, TriMesh},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};
const MAX_BYTES: u64 = 256 * 1024 * 1024;
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Bounds {
    pub min: [f32; 3],
    pub max: [f32; 3],
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub archive: String,
    pub path: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materials: Option<MaterialAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ladders: Option<String>,
    pub format: String,
    pub level: String,
    pub coordinates: String,
    pub sha256: String,
    pub bytes: u64,
    pub vertices: u32,
    pub triangles: u32,
    pub bounds: Bounds,
    pub source: Source,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialAsset {
    pub sha256: String,
    pub bytes: u64,
}
#[derive(Debug)]
pub struct CollisionMap {
    pub manifest: Manifest,
    mesh: TriMesh,
    actor_mesh: Option<TriMesh>,
    pub actor_triangle_ids: Vec<u32>,
    /// Original packed material/shadow/sector metadata, indexed by triangle ID.
    pub triangle_metadata: Vec<u32>,
    materials: BTreeMap<u32, crate::materials::Material>,
    pub(crate) ladders: Vec<crate::ladder::Ladder>,
}

#[derive(Clone, Copy, Debug)]
pub struct BulletSurface {
    pub distance: f32,
    pub normal: Vector,
    pub shoot_factor: f32,
    pub density: f32,
    pub allows_ricochet: bool,
}

pub(crate) fn rotation_basis([x, y, z]: [f32; 3]) -> [Vector; 3] {
    let (sp, cp) = x.sin_cos();
    let (sh, ch) = y.sin_cos();
    let (sb, cb) = z.sin_cos();
    // CGameObject::net_Spawn applies Fmatrix::setXYZ to the authored rotation.
    [
        Vector::new(ch * cb - sp * sh * sb, -cp * sb, sp * ch * sb + sh * cb),
        Vector::new(sp * sh * cb + ch * sb, cp * cb, sh * sb - sp * ch * cb),
        Vector::new(-cp * sh, sp, cp * ch),
    ]
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LadderExport {
    schema: u32,
    spawn_sha256: String,
    levels: BTreeMap<String, Vec<crate::ladder::Placement>>,
}

impl CollisionMap {
    pub fn load(path: &Path) -> Result<Self> {
        ensure!(
            fs::metadata(path)?.len() <= 16_384,
            "oversized collision manifest"
        );
        let manifest: Manifest = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            manifest.sha256.len() == 64
                && manifest
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid geometry hash"
        );
        let data_path = path
            .parent()
            .unwrap_or(Path::new("."))
            .join(format!("{}.cform", manifest.sha256));
        ensure!(
            manifest.bytes <= MAX_BYTES && fs::metadata(&data_path)?.len() == manifest.bytes,
            "collision size mismatch"
        );
        let mut map = Self::from_bytes(manifest, &fs::read(data_path)?)?;
        if let Some(asset) = &map.manifest.materials {
            ensure!(
                asset.sha256.len() == 64
                    && asset
                        .sha256
                        .bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
                "invalid material hash"
            );
            let material_path = path
                .parent()
                .unwrap_or(Path::new("."))
                .join(format!("{}.gamemtl", asset.sha256));
            ensure!(
                asset.bytes <= 4 * 1024 * 1024
                    && fs::metadata(&material_path)?.len() == asset.bytes,
                "material size mismatch"
            );
            map.attach_materials(&fs::read(material_path)?)?;
        }
        Ok(map)
    }
    pub fn from_bytes(manifest: Manifest, bytes: &[u8]) -> Result<Self> {
        ensure!(
            manifest.format == "xray-collision-v1" && manifest.coordinates == "metres-y-up",
            "unsupported collision format/coordinates"
        );
        ensure!(
            !manifest.level.is_empty()
                && manifest
                    .level
                    .bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_'),
            "invalid level"
        );
        ensure!(
            bytes.len() >= 36
                && bytes.len() as u64 <= MAX_BYTES
                && bytes.len() as u64 == manifest.bytes,
            "invalid collision size"
        );
        ensure!(
            format!("{:x}", Sha256::digest(bytes)) == manifest.sha256,
            "collision hash mismatch"
        );
        let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        ensure!(word(0) == 4, "unsupported CFORM version");
        let nv = word(4) as usize;
        let nt = word(8) as usize;
        ensure!(
            nv > 0
                && nt > 0
                && nv == manifest.vertices as usize
                && nt == manifest.triangles as usize,
            "invalid geometry counts"
        );
        let end = 36u64 + nv as u64 * 12 + nt as u64 * 16;
        ensure!(end <= bytes.len() as u64, "truncated collision geometry");
        // A source may include an engine BVH cache after the geometry. It is
        // covered by the digest but never deserialized by this implementation.
        let scalar = |at| f32::from_bits(word(at));
        for axis in 0..3 {
            let lo = scalar(12 + axis * 4);
            let hi = scalar(24 + axis * 4);
            ensure!(
                lo.is_finite()
                    && hi.is_finite()
                    && lo <= hi
                    && lo == manifest.bounds.min[axis]
                    && hi == manifest.bounds.max[axis],
                "invalid bounds"
            );
        }
        let mut vertices = Vec::with_capacity(nv);
        for n in 0..nv {
            let p = Vector::new(
                scalar(36 + n * 12),
                scalar(40 + n * 12),
                scalar(44 + n * 12),
            );
            ensure!(p.is_finite(), "non-finite collision vertex");
            for axis in 0..3 {
                ensure!(
                    p[axis] >= manifest.bounds.min[axis] - 0.01
                        && p[axis] <= manifest.bounds.max[axis] + 0.01,
                    "vertex outside bounds"
                );
            }
            vertices.push(p);
        }
        let mut indices = Vec::with_capacity(nt);
        let mut metadata = Vec::with_capacity(nt);
        for n in 0..nt {
            let at = 36 + nv * 12 + n * 16;
            let triangle = [word(at), word(at + 4), word(at + 8)];
            ensure!(
                triangle.iter().all(|&i| (i as usize) < nv),
                "invalid triangle index"
            );
            indices.push(triangle);
            metadata.push(word(at + 12));
        }
        // Preserve face order: no merge/delete/cleanup flags, so query IDs
        // continue to address original material and sector metadata.
        let mesh = TriMesh::new(vertices, indices).context("build collision BVH")?;
        let ladders = crate::ladder::decode(manifest.ladders.as_deref(), &manifest.bounds)?;
        Ok(Self {
            manifest,
            mesh,
            actor_mesh: None,
            actor_triangle_ids: Vec::new(),
            triangle_metadata: metadata,
            materials: BTreeMap::new(),
            ladders,
        })
    }
    pub fn attach_ladder_export(&mut self, path: &Path) -> Result<()> {
        ensure!(
            self.manifest.ladders.is_none() && fs::metadata(path)?.len() <= 256 * 1024,
            "duplicate or oversized ladder geometry"
        );
        let mut export: LadderExport = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            export.schema == 1
                && export.spawn_sha256.len() == 64
                && export
                    .spawn_sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid ladder export provenance"
        );
        let placements = export
            .levels
            .remove(&self.manifest.level)
            .context("no ladders for map")?;
        let raw = serde_json::to_string(&placements)?;
        self.ladders = crate::ladder::decode(Some(&raw), &self.manifest.bounds)?;
        self.manifest.ladders = Some(raw);
        Ok(())
    }
    pub fn attach_materials(&mut self, bytes: &[u8]) -> Result<()> {
        let asset = self
            .manifest
            .materials
            .as_ref()
            .context("missing material asset identity")?;
        ensure!(
            bytes.len() as u64 == asset.bytes
                && format!("{:x}", Sha256::digest(bytes)) == asset.sha256,
            "material hash mismatch"
        );
        let materials = crate::materials::parse(bytes)?;
        let mut faces = Vec::new();
        let mut ids = Vec::new();
        for (i, metadata) in self.triangle_metadata.iter().enumerate() {
            let id = metadata & 0x3fff;
            let material = materials
                .get(&id)
                .with_context(|| format!("unknown CFORM material ID {id}"))?;
            let f = material.flags;
            ensure!(
                f & crate::materials::DYNAMIC == 0,
                "dynamic material on static geometry"
            );
            if crate::materials::blocks_actor(f) {
                faces.push(self.mesh.indices()[i]);
                ids.push(i as u32);
            }
        }
        ensure!(!faces.is_empty(), "no actor collision geometry");
        let mesh = TriMesh::new(self.mesh.vertices().to_vec(), faces)
            .context("build actor collision BVH")?;
        self.actor_mesh = Some(mesh);
        self.actor_triangle_ids = ids;
        self.materials = materials;
        Ok(())
    }
    /// Conservative static spawn: lower a complete capsule from above the map.
    /// Returns the topmost walkable support, never a point hidden inside a roof.
    pub fn spawn_feet(&self, x: f32, z: f32) -> Result<Vector> {
        ensure!(
            x.is_finite()
                && z.is_finite()
                && x >= self.manifest.bounds.min[0]
                && x <= self.manifest.bounds.max[0]
                && z >= self.manifest.bounds.min[2]
                && z <= self.manifest.bounds.max[2],
            "spawn outside map bounds"
        );
        let mut feet = Vector::new(x, self.manifest.bounds.max[1] + 2., z);
        let bottom = self.manifest.bounds.min[1] - 2.;
        // Bound work even for a malformed or exceptionally tall map.
        for _ in 0..32 {
            if feet.y <= bottom {
                break;
            }
            let delta = Vector::new(0., -(feet.y - bottom).min(100.), 0.);
            if let Some(hit) = self.sweep_actor(feet, delta)? {
                ensure!(hit.normal1.y >= 0.70710677, "spawn surface is too steep");
                return Ok(feet + delta * hit.time_of_impact + Vector::Y * 0.005);
            }
            feet += delta;
        }
        anyhow::bail!("no actor support at spawn")
    }
    /// Resolve an authored spawn on a specific floor instead of the roof above it.
    pub fn spawn_feet_near(&self, x: f32, y: f32, z: f32) -> Result<Vector> {
        let start = Vector::new(x, y, z);
        let bounds = &self.manifest.bounds;
        ensure!(
            start
                .to_array()
                .into_iter()
                .zip(bounds.min.into_iter().zip(bounds.max))
                .all(|(value, (min, max))| (min..=max).contains(&value)),
            "spawn outside map bounds"
        );
        let down = -Vector::Y * 1.5;
        let hit = self
            .sweep_actor(start, down)?
            .context("no actor support near spawn height")?;
        ensure!(
            hit.time_of_impact > 0.0 && self.walkable_contact(&hit),
            "spawn anchor lacks clear walkable support"
        );
        Ok(start + down * hit.time_of_impact + Vector::Y * 0.005)
    }
    pub fn actor_ready(&self) -> bool {
        self.actor_mesh.is_some()
    }
    pub fn sweep_actor(&self, feet: Vector, displacement: Vector) -> Result<Option<ShapeCastHit>> {
        self.sweep_actor_height(feet, displacement, 1.8)
    }
    pub fn sweep_actor_height(
        &self,
        feet: Vector,
        displacement: Vector,
        height: f32,
    ) -> Result<Option<ShapeCastHit>> {
        ensure!((1.2..=1.8).contains(&height), "invalid actor height");
        self.sweep(
            self.actor_mesh
                .as_ref()
                .context("actor materials not loaded")?,
            feet,
            displacement,
            0.005,
            height,
        )
    }
    pub fn sweep_actor_clear(
        &self,
        feet: Vector,
        displacement: Vector,
        height: f32,
    ) -> Result<Option<ShapeCastHit>> {
        ensure!((1.2..=1.8).contains(&height), "invalid actor height");
        self.sweep(
            self.actor_mesh
                .as_ref()
                .context("actor materials not loaded")?,
            feet,
            displacement,
            0.0,
            height,
        )
    }
    pub fn walkable_contact(&self, hit: &ShapeCastHit) -> bool {
        if hit.normal1.y <= 0.0 {
            return false;
        }
        let Some(mesh) = &self.actor_mesh else {
            return false;
        };
        let Some(indices) = mesh.indices().get(hit.subshape1 as usize) else {
            return false;
        };
        let v = mesh.vertices();
        let normal = (v[indices[1] as usize] - v[indices[0] as usize])
            .cross(v[indices[2] as usize] - v[indices[0] as usize])
            .normalize_or_zero();
        normal.y.abs() >= 0.70710677
    }
    /// Double-sided ray query in original world coordinates; direction must be unit length.
    pub fn ray(&self, origin: Vector, direction: Vector, distance: f32) -> Result<Option<f32>> {
        let ray = checked_ray(origin, direction, distance)?;
        Ok(self.mesh.cast_local_ray(&ray, distance, true))
    }

    pub fn bullet_surface(&self, origin: Vector, direction: Vector, distance: f32) -> Result<Option<BulletSurface>> {
        let ray = checked_ray(origin, direction, distance)?;
        let Some(hit) = self.mesh.cast_local_ray_and_get_normal(&ray, distance, true) else { return Ok(None); };
        let material = self.triangle_metadata[hit.subshape as usize] & 0x3fff;
        let material = self.materials.get(&material);
        // The ray intersection normal may face the ray. CoP uses the authored
        // winding to distinguish entering a material from leaving it.
        let normal = self.mesh.triangle(hit.subshape).scaled_normal().normalize_or_zero();
        Ok(Some(BulletSurface {
            distance: hit.time_of_impact,
            normal,
            shoot_factor: material.map_or(1.0, |material| material.shoot_factor),
            density: material.map_or(0.0, |material| material.density),
            allows_ricochet: material.is_some_and(|material| material.flags & crate::materials::NO_RICOCHET == 0),
        }))
    }

    pub(crate) fn sweep_projectile(&self, origin: Vector, displacement: Vector, radius: f32) -> Result<Option<ShapeCastHit>> {
        ensure!(origin.is_finite() && displacement.is_finite(), "invalid projectile sweep");
        Ok(cast_shapes(
            &Pose::IDENTITY, Vector::ZERO, self.actor_mesh.as_ref().unwrap_or(&self.mesh),
            &Pose::translation(origin.x, origin.y, origin.z), displacement, &Ball::new(radius),
            ShapeCastOptions { max_time_of_impact: 1.0, target_distance: 0.002,
                stop_at_penetration: false, ..Default::default() },
        )?)
    }
    /// CoP explosion cover uses OPT_CULL and the original single-player
    /// material factor for every intersected static surface.
    pub fn blast_transmission(
        &self,
        origin: Vector,
        direction: Vector,
        distance: f32,
    ) -> Result<f32> {
        let ray = checked_ray(origin, direction, distance)?;
        let mut transmission = 1.0;
        for id in self
            .mesh
            .bvh()
            .leaves(|node| node.cast_ray(&ray, distance) <= distance)
        {
            let triangle = self.mesh.triangle(id);
            if triangle.scaled_normal().dot(direction) >= 0.0
                || triangle.cast_local_ray(&ray, distance, true).is_none()
            {
                continue;
            }
            let material = self.triangle_metadata[id as usize] & 0x3fff;
            transmission *= 1.0
                - self
                    .materials
                    .get(&material)
                    .map_or(1.0, |m| m.shoot_factor);
            if transmission == 0.0 {
                break;
            }
        }
        Ok(transmission)
    }
    /// Continuous standing-capsule sweep, using feet coordinates. This query is
    /// a controller primitive, not yet step/slide/gravity or collision response.
    pub fn sweep_capsule(
        &self,
        feet: Vector,
        displacement: Vector,
    ) -> Result<Option<ShapeCastHit>> {
        self.sweep(&self.mesh, feet, displacement, 0.0, 1.8)
    }
    fn sweep(
        &self,
        mesh: &TriMesh,
        feet: Vector,
        displacement: Vector,
        skin: f32,
        height: f32,
    ) -> Result<Option<ShapeCastHit>> {
        ensure!(
            feet.is_finite()
                && displacement.is_finite()
                && displacement.length_squared() > 0.0
                && displacement.length() <= 100.0,
            "invalid capsule sweep"
        );
        let capsule = Capsule::new_y(height * 0.5 - 0.35, 0.35);
        cast_shapes(
            &Pose::IDENTITY,
            Vector::ZERO,
            mesh,
            &Pose::translation(feet.x, feet.y + height * 0.5, feet.z),
            displacement,
            &capsule,
            ShapeCastOptions {
                max_time_of_impact: 1.0,
                target_distance: skin,
                stop_at_penetration: false,
                ..Default::default()
            },
        )
        .map_err(|_| anyhow::anyhow!("unsupported capsule query"))
    }
}
fn checked_ray(origin: Vector, direction: Vector, distance: f32) -> Result<Ray> {
    ensure!(
        origin.is_finite()
            && direction.is_finite()
            && distance.is_finite()
            && distance > 0.0
            && (direction.length_squared() - 1.0).abs() < 0.001,
        "invalid ray"
    );
    Ok(Ray::new(origin, direction))
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    fn fixture() -> (Manifest, Vec<u8>) {
        // Two floors (ground + bridge) and a thin vertical wall at x=2.
        let vertices = [
            [-5., 0., -5.],
            [5., 0., -5.],
            [0., 0., 5.],
            [-5., 3., -5.],
            [5., 3., -5.],
            [0., 3., 5.],
            [2., 0., -5.],
            [2., 5., -5.],
            [2., 0., 5.],
        ];
        let mut b = Vec::new();
        for v in [4u32, 9, 3] {
            b.extend(v.to_le_bytes());
        }
        for v in [-5f32, 0., -5., 5., 5., 5.] {
            b.extend(v.to_le_bytes());
        }
        for p in vertices {
            for v in p {
                b.extend(f32::to_le_bytes(v));
            }
        }
        for t in [[0u32, 2, 1, 7], [3, 5, 4, 9], [6, 8, 7, 11]] {
            for v in t {
                b.extend(v.to_le_bytes());
            }
        }
        let m = Manifest {
            materials: None,
            ladders: None,
            format: "xray-collision-v1".into(),
            level: "test".into(),
            coordinates: "metres-y-up".into(),
            sha256: format!("{:x}", Sha256::digest(&b)),
            bytes: b.len() as u64,
            vertices: 9,
            triangles: 3,
            bounds: Bounds {
                min: [-5., 0., -5.],
                max: [5., 5., 5.],
            },
            source: Source {
                archive: "fixture".into(),
                path: "fixture".into(),
            },
        };
        (m, b)
    }
    pub(crate) fn actor_fixture(wall_flags: u32) -> CollisionMap {
        cover_fixture([(7, 0, 1.0), (9, 0, 1.0), (11, wall_flags, 1.0)])
    }
    pub(crate) fn cover_fixture(factors: [(u32, u32, f32); 3]) -> CollisionMap {
        let (mut m, b) = fixture();
        let materials = crate::materials::fixture_with_factors(&factors);
        m.materials = Some(MaterialAsset {
            sha256: format!("{:x}", Sha256::digest(&materials)),
            bytes: materials.len() as u64,
        });
        let mut map = CollisionMap::from_bytes(m, &b).unwrap();
        map.attach_materials(&materials).unwrap();
        map
    }
    #[test]
    fn blast_transmission_combines_front_faces_without_changing_solid_rays() {
        let map = cover_fixture([(7, 0, 0.25), (9, 0, 0.5), (11, 0, 1.0)]);
        let origin = Vector::new(0.0, 4.0, 0.0);
        assert_eq!(
            map.blast_transmission(origin, -Vector::Y, 5.0).unwrap(),
            0.375
        );
        assert_eq!(
            map.blast_transmission(origin, -Vector::Y, 2.0).unwrap(),
            0.5
        );
        assert_eq!(
            map.blast_transmission(Vector::new(0.0, -1.0, 0.0), Vector::Y, 5.0)
                .unwrap(),
            1.0
        );
        assert_eq!(map.ray(origin, -Vector::Y, 5.0).unwrap(), Some(1.0));
        assert_eq!(
            map.blast_transmission(Vector::Y, Vector::X, 3.0).unwrap(),
            0.0
        );
    }
    #[test]
    fn material_filtering_preserves_actor_obstacles() {
        let pass = actor_fixture(crate::materials::PASSABLE);
        assert_eq!(pass.actor_triangle_ids, vec![0, 1]);
        assert!(
            pass.sweep_actor(Vector::new(0., 0.1, 0.), Vector::new(4., 0., 0.))
                .unwrap()
                .is_none()
        );
        let obstacle = actor_fixture(crate::materials::PASSABLE | crate::materials::ACTOR_OBSTACLE);
        assert!(
            obstacle
                .sweep_actor(Vector::new(0., 0.1, 0.), Vector::new(4., 0., 0.))
                .unwrap()
                .is_some()
        );
        let (m, b) = fixture();
        assert!(
            CollisionMap::from_bytes(m, &b)
                .unwrap()
                .sweep_actor(Vector::ZERO, Vector::X)
                .is_err()
        );
    }
    #[test]
    fn motor_lands_slides_and_cannot_cross_wall() {
        let map = actor_fixture(0);
        let mut c = crate::movement::Character::new(Vector::new(0., 1., -1.));
        for _ in 0..30 {
            c.step(&map, 0., 0., false).unwrap();
        }
        assert!(c.grounded, "{c:?}");
        assert!((c.feet.y - 0.010).abs() < 0.002, "{c:?}");
        for _ in 0..20 {
            c.step(&map, 1., 0.2, false).unwrap();
        }
        assert!(c.feet.x < 1.651 && c.feet.x > 1.5, "{c:?}");
        assert!(c.feet.z > -0.9, "{c:?}");
        let old = c.feet;
        assert!(c.step(&map, f32::NAN, 0., false).is_err());
        assert_eq!(old, c.feet);
    }
    #[test]
    fn neutral_input_does_not_slide_down_walkable_slopes() {
        let (mut m, mut b) = fixture();
        b[16..20].copy_from_slice(&(-1f32).to_le_bytes());
        m.bounds.min[1] = -1.;
        b[40..44].copy_from_slice(&(-1f32).to_le_bytes());
        b[52..56].copy_from_slice(&1f32.to_le_bytes());
        m.sha256 = format!("{:x}", Sha256::digest(&b));
        let materials = crate::materials::fixture(&[(7, 0), (9, 0), (11, 0)]);
        m.materials = Some(MaterialAsset {
            sha256: format!("{:x}", Sha256::digest(&materials)),
            bytes: materials.len() as u64,
        });
        let mut map = CollisionMap::from_bytes(m, &b).unwrap();
        map.attach_materials(&materials).unwrap();
        let mut c = crate::movement::Character::new(Vector::new(0., 0.1, -1.));
        for _ in 0..30 {
            c.step(&map, 0., 0., false).unwrap();
        }
        assert!(c.grounded);
        let old = c.feet;
        for _ in 0..300 {
            c.step(&map, 0., 0., false).unwrap();
        }
        assert!(
            (c.feet.x - old.x).abs() < 1e-5 && (c.feet.z - old.z).abs() < 1e-5,
            "idle drift: {:?}",
            c.feet - old
        );
    }
    #[test]
    fn motor_normalizes_input_and_keeps_fixed_time() {
        let map = actor_fixture(0);
        let mut a = crate::movement::Character::new(Vector::new(0., 0.01, 0.));
        let mut b = a;
        a.step(&map, -1., -1., false).unwrap();
        b.step(&map, -100., -100., false).unwrap();
        assert!((a.feet - b.feet).length() < 1e-6);
        assert!((a.feet.x * a.feet.x + a.feet.z * a.feet.z).sqrt() <= 4. / 30. + 1e-6);
    }
    pub(crate) fn step_fixture(height: f32, ceiling: bool) -> CollisionMap {
        let mut vertices = Vec::<[f32; 3]>::new();
        let mut indices = Vec::<[u32; 3]>::new();
        let mut quad = |p: [[f32; 3]; 4]| {
            let start = vertices.len() as u32;
            vertices.extend(p);
            indices.extend([[start, start + 2, start + 1], [start, start + 3, start + 2]]);
        };
        quad([[-5., 0., -5.], [5., 0., -5.], [5., 0., 5.], [-5., 0., 5.]]);
        quad([
            [1., 0., -5.],
            [1., height, -5.],
            [1., height, 5.],
            [1., 0., 5.],
        ]);
        quad([
            [1., height, -5.],
            [5., height, -5.],
            [5., height, 5.],
            [1., height, 5.],
        ]);
        if ceiling {
            quad([
                [-5., 1.9, -5.],
                [5., 1.9, -5.],
                [5., 1.9, 5.],
                [-5., 1.9, 5.],
            ]);
        }
        let (mut m, _) = fixture();
        m.vertices = vertices.len() as u32;
        m.triangles = indices.len() as u32;
        m.bounds = Bounds {
            min: [-5., 0., -5.],
            max: [5., 5., 5.],
        };
        let mut bytes = Vec::new();
        for v in [4, m.vertices, m.triangles] {
            bytes.extend(v.to_le_bytes());
        }
        for v in [-5f32, 0., -5., 5., 5., 5.] {
            bytes.extend(v.to_le_bytes());
        }
        for p in vertices {
            for v in p {
                bytes.extend(v.to_le_bytes());
            }
        }
        for tri in indices {
            for i in tri {
                bytes.extend(i.to_le_bytes());
            }
            bytes.extend(7u32.to_le_bytes());
        }
        m.bytes = bytes.len() as u64;
        m.sha256 = format!("{:x}", Sha256::digest(&bytes));
        let material = crate::materials::fixture(&[(7, 0)]);
        m.materials = Some(MaterialAsset {
            sha256: format!("{:x}", Sha256::digest(&material)),
            bytes: material.len() as u64,
        });
        let mut map = CollisionMap::from_bytes(m, &bytes).unwrap();
        map.attach_materials(&material).unwrap();
        map
    }
    #[test]
    fn motor_steps_only_with_headroom_and_bounded_height() {
        for (height, ceiling, should_pass) in
            [(0.2, false, true), (0.2, true, false), (0.8, false, false)]
        {
            let map = step_fixture(height, ceiling);
            let mut c = crate::movement::Character::new(Vector::new(0., 0.01, 0.));
            for _ in 0..20 {
                c.step(&map, 1., 0., false).unwrap();
            }
            if should_pass {
                assert!(c.feet.x > 1.5 && c.feet.y > 0.2, "{c:?}");
            } else {
                assert!(c.feet.x < 1., "height {height} ceiling {ceiling}: {c:?}");
            }
        }
    }
    #[test]
    fn validated_spawn_uses_capsule_and_fails_outside_map() {
        let map = actor_fixture(0);
        let p = map.spawn_feet(0., 0.).unwrap();
        assert!((p.y - 3.010).abs() < 0.002, "{p:?}");
        let lower_floor = map.spawn_feet_near(0., 0.5, 0.).unwrap();
        assert!((lower_floor.y - 0.010).abs() < 0.002, "{lower_floor:?}");
        assert!(map.spawn_feet_near(0., f32::NAN, 0.).is_err());
        assert!(map.spawn_feet(100., 0.).is_err());
        assert!(map.spawn_feet(f32::NAN, 0.).is_err());
    }
    #[test]
    fn walk_overrides_sprint_without_changing_the_capsule_height() {
        let map = step_fixture(0.8, false);
        let mut c = crate::movement::Character::new(Vector::new(0., 0.01, 0.));
        for _ in 0..10 {
            c.step_command(&map, -1., 0., true, false, false, true).unwrap();
        }
        assert!((c.feet.x + 2.0 / 3.0).abs() < 0.03, "{c:?}");
        assert!(!c.crouched);
    }
    #[test]
    fn jump_requires_ground_and_new_press() {
        let map = step_fixture(0.8, false);
        let mut c = crate::movement::Character::new(Vector::new(0., 0.01, 0.));
        for _ in 0..3 {
            c.step(&map, 0., 0., false).unwrap();
        }
        assert!(c.grounded);
        let mut peak = 0f32;
        for _ in 0..90 {
            c.step_command(&map, 0., 0., false, true, false, false).unwrap();
            peak = peak.max(c.feet.y);
        }
        assert!(peak > 1. && peak < 1.5, "peak {peak}");
        assert!(c.grounded && c.feet.y < 0.02, "{c:?}");
        c.step_command(&map, 0., 0., false, false, false, false).unwrap();
        c.step_command(&map, 0., 0., false, true, false, false).unwrap();
        assert!(c.vertical_speed > 0. && !c.grounded);
    }
    #[test]
    fn crouch_passes_low_ceiling_but_cannot_stand_inside_it() {
        let map = step_fixture(0.2, true);
        let mut c = crate::movement::Character::new(Vector::new(0., 0.01, 0.));
        for _ in 0..30 {
            c.step_command(&map, 1., 0., true, false, true, false).unwrap();
        }
        assert!(c.feet.x > 1.5 && c.feet.x <= 2.01 && c.crouched, "{c:?}");
        for _ in 0..3 {
            c.step_command(&map, 0., 0., false, false, false, false).unwrap();
        }
        assert!(c.crouched, "stood through ceiling: {c:?}");
        for _ in 0..30 {
            c.step_command(&map, -1., 0., false, false, false, false).unwrap();
        }
        assert!(!c.crouched, "failed to stand when clear: {c:?}");
    }
    #[test]
    fn floors_are_selected_from_query_height_not_map_top() {
        let (m, b) = fixture();
        let map = CollisionMap::from_bytes(m, &b).unwrap();
        assert_eq!(
            map.ray(Vector::new(0., 2., 0.), -Vector::Y, 10.).unwrap(),
            Some(2.)
        );
        assert_eq!(
            map.ray(Vector::new(0., 4., 0.), -Vector::Y, 10.).unwrap(),
            Some(1.)
        );
        assert_eq!(map.triangle_metadata, vec![7, 9, 11]);
        assert!(map.ray(Vector::ZERO, Vector::ZERO, 1.).is_err());
    }
    #[test]
    fn capsule_cannot_tunnel_through_thin_wall() {
        let (m, b) = fixture();
        let map = CollisionMap::from_bytes(m, &b).unwrap();
        let hit = map
            .sweep_capsule(Vector::new(0., 0.1, 0.), Vector::new(4., 0., 0.))
            .unwrap()
            .unwrap();
        assert!((hit.time_of_impact - 0.4125).abs() < 0.002, "{hit:?}");
        assert!(
            map.sweep_capsule(Vector::new(0., 0.1, 0.), Vector::new(-1., 0., 0.))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn rejects_corruption_before_building_bvh() {
        let (m, mut b) = fixture();
        b[40] ^= 1;
        assert!(CollisionMap::from_bytes(m, &b).is_err());
        for (offset, value) in [(36, f32::NAN.to_bits()), (144, 99), (4, u32::MAX), (0, 5)] {
            let (mut m, mut b) = fixture();
            b[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            m.sha256 = format!("{:x}", Sha256::digest(&b));
            assert!(CollisionMap::from_bytes(m, &b).is_err());
        }
        let (mut m, mut b) = fixture();
        b.truncate(b.len() - 1);
        m.bytes = b.len() as u64;
        m.sha256 = format!("{:x}", Sha256::digest(&b));
        assert!(CollisionMap::from_bytes(m, &b).is_err());
    }
}
