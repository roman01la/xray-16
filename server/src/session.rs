//! Startup-only world selection. Invalid geometry/spawns fail before listening.
use crate::{
    authored_shape::{Shape, Volume},
    collision::CollisionMap,
    contract::{self, Contract},
    world::{Kind, SafeZone, Vec3, World},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Content {
    pub geometry: String,
    pub materials: String,
    pub movement: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ladders: Option<String>,
}
pub const MOVEMENT_REVISION: &str = "capsule-motor-v4";
const LADDER_MOVEMENT_REVISION: &str = "capsule-motor-v5";
const CAMPAIGN_LEVELS: [&str; 5] = [
    "zaton",
    "jupiter",
    "pripyat",
    "jupiter_underground",
    "labx8",
];
const WORLD_SUFFIX: &str = "-static-v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StockHub {
    level: String,
    collision_sha256: String,
    position: [f32; 3],
    rotation: [f32; 3],
    shapes: Vec<Shape>,
}

#[derive(Deserialize)]
struct StockHubs {
    schema: u32,
    zones: Vec<StockHub>,
}

fn stock_safe_zones(level: &str, collision_hash: &str) -> Result<Option<Vec<SafeZone>>> {
    let hubs: StockHubs = serde_json::from_str(include_str!("../config/cop-safe-zones.json"))?;
    ensure!(hubs.schema == 1, "unsupported stock safe-zone schema");
    let Some(hub) = hubs.zones.into_iter().find(|hub| hub.level == level && hub.collision_sha256 == collision_hash) else {
        return Ok(None);
    };
    ensure!((1..=16).contains(&hub.shapes.len()), "invalid stock safe-zone shape count");
    let zones = hub.shapes.into_iter().map(|shape| Volume::new(shape, hub.position, hub.rotation).map(SafeZone))
        .collect::<Result<Vec<_>>>()?;
    Ok(Some(zones))
}

pub fn campaign_level(world: &str) -> Option<&str> {
    world
        .strip_suffix(WORLD_SUFFIX)
        .filter(|level| CAMPAIGN_LEVELS.contains(level))
}

fn content_revision(world: &str, geometry: &str, materials: &str, ladders: Option<&str>) -> String {
    let mut digest = Sha256::new();
    let movement = if ladders.is_some() {
        LADDER_MOVEMENT_REVISION
    } else {
        MOVEMENT_REVISION
    };
    digest.update(format!("{world}\n{geometry}\n{materials}\n{movement}"));
    if let Some(ladders) = ladders {
        digest.update(b"\n");
        digest.update(ladders);
    }
    format!("{:x}", digest.finalize())
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
    pub fn campaign(map: CollisionMap, x: f32, z: f32, height: Option<f32>) -> Result<Self> {
        ensure!(
            CAMPAIGN_LEVELS.contains(&map.manifest.level.as_str()) && map.actor_ready(),
            "campaign map with material-aware geometry required"
        );
        let p = match height {
            Some(y) => map.spawn_feet_near(x, y, z)?,
            None => map.spawn_feet(x, z)?,
        };
        let geometry = map.manifest.sha256.clone();
        let materials = map.manifest.materials.as_ref().unwrap().sha256.clone();
        let mut contract = contract::current().clone();
        contract.world = format!("{}{WORLD_SUFFIX}", map.manifest.level);
        let ladders = map.manifest.ladders.clone();
        contract.content_revision =
            content_revision(&contract.world, &geometry, &materials, ladders.as_deref());
        Ok(Self {
            contract,
            content: Some(Content {
                geometry,
                materials,
                movement: if ladders.is_some() {
                    LADDER_MOVEMENT_REVISION
                } else {
                    MOVEMENT_REVISION
                }
                .into(),
                ladders,
            }),
            spawn: Vec3 {
                x: p.x,
                y: p.y,
                z: p.z,
            },
            collision: Some(Arc::new(map)),
        })
    }
    pub fn collision(&self) -> Option<Arc<CollisionMap>> {
        self.collision.clone()
    }
    pub fn previous_movement_contract(&self) -> Option<Contract> {
        let content = self.content.as_ref()?;
        content.ladders.as_ref()?;
        let mut previous = self.contract.clone();
        previous.content_revision =
            content_revision(&previous.world, &content.geometry, &content.materials, None);
        Some(previous)
    }
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
        self.make_world(false)
    }
    pub fn make_world(&self, native_npcs: bool) -> Result<World> {
        let mut world = if let Some(map) = &self.collision {
            World::with_collision(map.clone())?
        } else {
            World::new()
        };
        if let Some(map) = &self.collision {
            world.safe_zones = stock_safe_zones(&map.manifest.level, &map.manifest.sha256)?
                .unwrap_or_else(|| vec![SafeZone::sphere(self.spawn, 10.0)]);
            if map.manifest.level == "zaton" && !native_npcs {
                world.spawn_on_map(Kind::Npc, self.spawn.x + 10., self.spawn.z)?;
            }
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
    fn stock_safe_zones_follow_hub_boxes_and_require_matching_collision() {
        let config: StockHubs = serde_json::from_str(include_str!("../config/cop-safe-zones.json")).unwrap();
        assert_eq!(config.zones.len(), 3);
        for hub in config.zones {
            let zones = stock_safe_zones(&hub.level, &hub.collision_sha256).unwrap().unwrap();
            assert_eq!(zones.len(), hub.shapes.len());
            assert!(stock_safe_zones(&hub.level, "wrong collision").unwrap().is_none());
            if hub.level == "zaton" {
                let inside = |x, y, z| zones.iter().any(|zone| zone.contains(Vec3 { x, y, z }));
                assert!(inside(129.12, 0.0, 183.28));
                assert!(inside(107.4, -2.4, 207.8)); // Authored gangway extension.
                assert!(!inside(87.6, 0.0, 115.0)); // Development spawn lies outside the hub.
                assert!(!inside(129.12, 14.0, 183.28)); // Above the authored box.
                assert!(!inside(129.12, 0.0, 208.0)); // Beyond the hull and to the side of the gangway.
            }
        }
    }
    #[test]
    fn identity_changes_with_either_asset() {
        let zaton = "zaton-static-v1";
        let original = content_revision(zaton, "a", "b", None);
        assert_ne!(original, content_revision(zaton, "b", "a", None));
        assert_ne!(original, content_revision(zaton, "a", "c", None));
        assert_ne!(
            original,
            content_revision("jupiter-static-v1", "a", "b", None)
        );
        assert_ne!(original, content_revision(zaton, "a", "b", Some("ladders")));
        for level in CAMPAIGN_LEVELS {
            assert_eq!(
                campaign_level(&format!("{level}{WORLD_SUFFIX}")),
                Some(level)
            );
        }
        assert_eq!(campaign_level("arena-static-v1"), None);
        assert_eq!(
            SessionConfig::synthetic().contract,
            contract::current().clone()
        );
    }
}
