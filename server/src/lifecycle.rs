//! Reliable AOI metadata, following Zone's enter/leave separation. Transform
//! membership remains owned by complete state frames across channel reordering.
use crate::world::{Entity, SnapshotEntity};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Appearance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outfit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helmet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weapon: Option<String>,
    #[serde(rename = "weaponAddons", skip_serializing_if = "Option::is_none")]
    pub weapon_addons: Option<u8>,
}
impl Appearance {
    pub fn is_empty(&self) -> bool {
        self.outfit.is_none() && self.helmet.is_none() && self.weapon.is_none()
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub id: u32,
    pub kind: u8,
    pub model: String,
    #[serde(rename = "persistentId", skip_serializing_if = "Option::is_none")]
    pub persistent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub appearance: Option<Appearance>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Update {
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub revision: u32,
    pub tick: u32,
    pub upsert: Vec<Entry>,
    pub remove: Vec<u32>,
}
#[derive(Default)]
pub struct Lifecycle {
    known: BTreeMap<u32, Entry>,
    revision: u32,
}
impl Lifecycle {
    pub fn prepare(&self, tick: u32, entities: &[SnapshotEntity]) -> Option<Update> {
        self.prepare_persistent(tick, entities, &BTreeMap::new(), &BTreeMap::new())
    }
    pub fn prepare_persistent(
        &self,
        tick: u32,
        entities: &[SnapshotEntity],
        persistent: &BTreeMap<u32, String>,
        actors: &BTreeMap<u32, Entity>,
    ) -> Option<Update> {
        debug_assert!(entities.windows(2).all(|a| a[0].id < a[1].id));
        // Removals first prevent a full registry overflowing during AOI churn.
        let remove: Vec<_> = self
            .known
            .keys()
            .filter(|id| entities.binary_search_by_key(*id, |e| e.id).is_err())
            .take(16)
            .copied()
            .collect();
        let upsert: Vec<_> = entities
            .iter()
            .filter_map(|e| {
                let persistent_id = persistent.get(&e.id);
                let actor = actors.get(&e.id);
                let model = actor.and_then(|actor| actor.native.as_ref()).map(|npc| &npc.model);
                let appearance = actor
                    .filter(|actor| actor.health > 0 && !actor.appearance.is_empty())
                    .map(|actor| &actor.appearance);
                if self.known.get(&e.id).is_some_and(|known| {
                    known.kind == e.kind
                        && known.model == model.map_or("stalker", |name| name.as_ref())
                        && known.persistent_id.as_ref() == persistent_id
                        && known.appearance.as_ref() == appearance
                }) {
                    return None;
                }
                Some(Entry {
                    id: e.id,
                    kind: e.kind,
                    model: model.map_or("stalker", |name| name.as_ref()).to_owned(),
                    persistent_id: persistent_id.cloned(),
                    appearance: appearance.cloned(),
                })
            })
            .take(16 - remove.len())
            .collect();
        if remove.is_empty() && upsert.is_empty() {
            return None;
        }
        Some(Update {
            message_type: "lifecycle",
            revision: self.revision.wrapping_add(1),
            tick,
            upsert,
            remove,
        })
    }
    /// Commit only after the reliable channel accepted the complete message.
    pub fn commit(&mut self, update: &Update) {
        for id in &update.remove {
            self.known.remove(id);
        }
        for e in &update.upsert {
            self.known.insert(e.id, e.clone());
        }
        self.revision = update.revision;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{Kind, Vec3, World};
    #[test]
    fn batches_retry_without_advance_and_remove_before_enter() {
        let mut w = World::new();
        for _ in 0..200 {
            w.spawn(Kind::Player, Vec3::default());
        }
        let visible = w.visible_to(1);
        let mut l = Lifecycle::default();
        let first = l.prepare(2, &visible).unwrap();
        assert_eq!(first.upsert.len(), 16);
        assert_eq!(l.prepare(4, &visible).unwrap().revision, first.revision);
        for _ in 0..13 {
            let update = l.prepare(6, &visible).unwrap();
            assert!(serde_json::to_vec(&update).unwrap().len() < 2048);
            l.commit(&update);
        }
        assert!(l.prepare(8, &visible).is_none());
        assert_eq!(l.known.len(), 200);
        for _ in 0..13 {
            let update = l.prepare(10, &visible[199..]).unwrap();
            assert!(update.upsert.is_empty());
            l.commit(&update);
        }
        assert_eq!(l.known.len(), 1);
        assert!(l.known.contains_key(&200));
    }

    #[test]
    fn equipment_changes_are_deltas_and_death_clears_the_public_view() {
        let mut world = World::new();
        let observer = world.spawn(Kind::Player, Vec3::default());
        let actor = world.spawn(Kind::Player, Vec3::default());
        let mut lifecycle = Lifecycle::default();
        world.entities.get_mut(&actor).unwrap().appearance.weapon = Some("wpn_pm".into());
        let prepare = |lifecycle: &Lifecycle, world: &World, tick| {
            lifecycle.prepare_persistent(
                tick,
                &world.visible_to(observer),
                &world.persistent_ids,
                &world.entities,
            )
        };

        let initial = prepare(&lifecycle, &world, 1).unwrap();
        assert_eq!(
            initial.upsert[1]
                .appearance
                .as_ref()
                .unwrap()
                .weapon
                .as_deref(),
            Some("wpn_pm")
        );
        lifecycle.commit(&initial);
        assert!(prepare(&lifecycle, &world, 2).is_none());

        world.entities.get_mut(&actor).unwrap().appearance.weapon_addons = Some(4);
        let mounted = prepare(&lifecycle, &world, 3).unwrap();
        assert_eq!(mounted.upsert.len(), 1);
        assert_eq!(mounted.upsert[0].id, actor);
        let public = serde_json::to_value(mounted.upsert[0].appearance.as_ref().unwrap()).unwrap();
        assert_eq!(public, serde_json::json!({"weapon":"wpn_pm","weaponAddons":4}));
        lifecycle.commit(&mounted);

        world.entities.get_mut(&actor).unwrap().health = 0;
        let dead = prepare(&lifecycle, &world, 4).unwrap();
        assert!(dead.remove.is_empty());
        assert_eq!(dead.upsert.len(), 1);
        assert_eq!(dead.upsert[0].id, actor);
        assert!(dead.upsert[0].appearance.is_none());
        lifecycle.commit(&dead);
        assert!(prepare(&lifecycle, &world, 5).is_none());
    }
}
