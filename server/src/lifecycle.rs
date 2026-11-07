//! Reliable AOI metadata, following Zone's enter/leave separation. Transform
//! membership remains owned by complete state frames across channel reordering.
use crate::world::SnapshotEntity;
use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub id: u32,
    pub kind: u8,
    pub model: &'static str,
    #[serde(rename = "persistentId", skip_serializing_if = "Option::is_none")]
    pub persistent_id: Option<String>,
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
    known: BTreeMap<u32, (u8, Option<String>)>,
    revision: u32,
}
impl Lifecycle {
    pub fn prepare(&self, tick: u32, entities: &[SnapshotEntity]) -> Option<Update> {
        self.prepare_persistent(tick, entities, &BTreeMap::new())
    }
    pub fn prepare_persistent(
        &self,
        tick: u32,
        entities: &[SnapshotEntity],
        persistent: &BTreeMap<u32, String>,
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
            .filter(|e| self.known.get(&e.id) != Some(&(e.kind, persistent.get(&e.id).cloned())))
            .take(16 - remove.len())
            .map(|e| Entry {
                id: e.id,
                kind: e.kind,
                model: "stalker",
                persistent_id: persistent.get(&e.id).cloned(),
            })
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
            self.known.insert(e.id, (e.kind, e.persistent_id.clone()));
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
}
