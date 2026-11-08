//! Startup-only world selection. Invalid geometry/spawns fail before listening.
use crate::{
    collision::CollisionMap,
    contract::{self, Contract},
    world::{Kind, SafeZone, Vec3, World},
};
use anyhow::{Result, ensure};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub geometry: String,
    pub materials: String,
    pub movement: String,
}
pub const MOVEMENT_REVISION: &str = "capsule-motor-v4";
pub fn content_revision(geometry: &str, materials: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!(
            "zaton-static-v1\n{geometry}\n{materials}\n{MOVEMENT_REVISION}"
        ))
    )
}
pub struct SessionConfig {
    pub contract: Contract,
    pub content: Option<Content>,
    pub spawn: Vec3,
    collision: Option<Arc<CollisionMap>>,
}
impl SessionConfig {
    pub fn synthetic() -> Self {
        Self {
            contract: contract::current().clone(),
            content: None,
            spawn: Vec3::default(),
            collision: None,
        }
    }
    pub fn zaton(map: CollisionMap, x: f32, z: f32, height: Option<f32>) -> Result<Self> {
        ensure!(
            map.manifest.level == "zaton" && map.actor_ready(),
            "Zaton material-aware geometry required"
        );
        let p = match height {
            Some(y) => map.spawn_feet_near(x, y, z)?,
            None => map.spawn_feet(x, z)?,
        };
        let geometry = map.manifest.sha256.clone();
        let materials = map.manifest.materials.as_ref().unwrap().sha256.clone();
        let mut contract = contract::current().clone();
        contract.world = "zaton-static-v1".into();
        contract.content_revision = content_revision(&geometry, &materials);
        Ok(Self {
            contract,
            content: Some(Content {
                geometry,
                materials,
                movement: MOVEMENT_REVISION.into(),
            }),
            spawn: Vec3 {
                x: p.x,
                y: p.y,
                z: p.z,
            },
            collision: Some(Arc::new(map)),
        })
    }
    pub fn collision(&self) -> Option<Arc<CollisionMap>> {self.collision.clone()}
    pub fn scene_position(&self, x: f32, z: f32) -> Result<Vec3> {
        if let Some(map) = &self.collision {
            let p = map.spawn_feet(x, z)?;
            Ok(Vec3 {
                x: p.x,
                y: p.y,
                z: p.z,
            })
        } else {
            Ok(Vec3 { x, y: 0., z })
        }
    }
    pub fn world(&self) -> Result<World> {
        let mut world = if let Some(map) = &self.collision {
            World::with_collision(map.clone())?
        } else {
            World::new()
        };
        if self.collision.is_some() {
            world.safe_zones = vec![SafeZone {
                center: self.spawn,
                radius: 10.,
            }];
            world.spawn_on_map(Kind::Npc, self.spawn.x + 10., self.spawn.z)?;
        } else {
            world.spawn(
                Kind::Npc,
                Vec3 {
                    x: 30.,
                    y: 0.,
                    z: 0.,
                },
            );
        }
        Ok(world)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_changes_with_either_asset() {
        assert_ne!(content_revision("a", "b"), content_revision("b", "a"));
        assert_ne!(content_revision("a", "b"), content_revision("a", "c"));
        assert_eq!(
            SessionConfig::synthetic().contract,
            contract::current().clone()
        );
    }
}
