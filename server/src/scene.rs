//! Trusted persistent presentation descriptors; never decoded from owned JSON.
use crate::{
    session::SessionConfig,
    world::{Kind, World},
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub id: String,
    pub world: String,
    pub model: String,
    pub x: f32,
    pub z: f32,
    pub yaw: f32,
}
impl Descriptor {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            crate::ownership::valid_id(&self.id) && self.model == "stalker",
            "invalid scene identity/model"
        );
        ensure!(
            self.world == "synthetic-flat-v1" || crate::session::campaign_level(&self.world).is_some(),
            "unsupported scene world"
        );
        ensure!(
            [self.x, self.z, self.yaw].iter().all(|v| v.is_finite())
                && self.x.abs() <= 2000.
                && self.z.abs() <= 2000.
                && self.yaw.abs() <= std::f32::consts::TAU,
            "invalid scene transform"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Default, Serialize)]
pub struct RuntimeState {
    pub healthy: bool,
    pub auth_epoch: i64,
    pub scenes: Vec<Descriptor>,
}
#[derive(Default)]
pub struct SceneRegistry {
    entries: BTreeMap<String, (u32, Descriptor)>,
}
impl SceneRegistry {
    pub fn reconcile(
        &mut self,
        descriptors: &[Descriptor],
        session: &SessionConfig,
        world: &mut World,
    ) -> Result<()> {
        ensure!(descriptors.len() <= 1024, "scene capacity exceeded");
        let mut desired = BTreeMap::new();
        for d in descriptors {
            d.validate()?;
            if d.world != session.contract.world {
                continue;
            }
            ensure!(
                !desired.contains_key(&d.id),
                "duplicate persistent descriptor"
            );
            let position = session.scene_position(d.x, d.z)?;
            desired.insert(d.id.clone(), (d.clone(), position));
        }
        self.entries.retain(|id, (network, _)| {
            if desired.contains_key(id) {
                true
            } else {
                world.remove(*network);
                false
            }
        });
        for (id, (descriptor, position)) in desired {
            let network = if let Some((network, old)) = self.entries.get_mut(&id) {
                *old = descriptor.clone();
                *network
            } else {
                let network = world.spawn(Kind::Npc, position);
                self.entries
                    .insert(id.clone(), (network, descriptor.clone()));
                network
            };
            let entity = world
                .entities
                .get_mut(&network)
                .expect("persistent registry entity");
            entity.position = position;
            entity.yaw = descriptor.yaw;
            world.persistent_ids.insert(network, id);
        }
        Ok(())
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stable_mapping_updates_removes_and_rebuilds_without_ownership_visibility() {
        let session = SessionConfig::synthetic();
        let mut world = session.world().unwrap();
        let mut registry = SceneRegistry::default();
        let mut d = Descriptor {
            id: "a".repeat(32),
            world: session.contract.world.clone(),
            model: "stalker".into(),
            x: 4.,
            z: 3.,
            yaw: 0.,
        };
        registry
            .reconcile(&[d.clone()], &session, &mut world)
            .unwrap();
        let id = *world.persistent_ids.keys().next().unwrap();
        d.x = 8.;
        registry
            .reconcile(&[d.clone()], &session, &mut world)
            .unwrap();
        assert_eq!(world.persistent_ids.len(), 1);
        assert_eq!(world.entities[&id].position.x, 8.);
        registry.reconcile(&[], &session, &mut world).unwrap();
        assert!(!world.entities.contains_key(&id));
        assert!(world.persistent_ids.is_empty());
        registry
            .reconcile(&[d.clone()], &session, &mut world)
            .unwrap();
        assert_ne!(*world.persistent_ids.keys().next().unwrap(), id);
        let mut restarted = session.world().unwrap();
        let mut fresh = SceneRegistry::default();
        fresh.reconcile(&[d], &session, &mut restarted).unwrap();
        assert_eq!(
            restarted.persistent_ids.values().next().unwrap(),
            &"a".repeat(32)
        );
    }
}
