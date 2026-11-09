//! Trusted authored CoP stash positions and server-side replenishment.
use crate::{catalog::Catalog, collision::CollisionMap, inventory, survival_rules::SurvivalRules};
use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::Path,
    time::{Duration, Instant},
};

const MAX_REFILL_ATTEMPTS: usize = 8;
const PRESENCE_MAX_AGE: Duration = Duration::from_millis(250);

#[derive(Clone)]
pub(crate) struct Presence {
    captured: Instant,
    players: Vec<crate::world::Vec3>,
}

impl Presence {
    pub(crate) fn capture(world: &crate::world::World) -> Self {
        Self {
            captured: Instant::now(),
            players: world
                .entities
                .values()
                .filter(|actor| actor.kind == crate::world::Kind::Player && actor.health > 0)
                .map(|actor| actor.position)
                .collect(),
        }
    }

    pub(crate) fn fresh(&self) -> bool {
        self.captured.elapsed() <= PRESENCE_MAX_AGE
    }

    pub(crate) fn near_positions(&self, positions: impl Iterator<Item = [f32; 3]> + Clone, radius: f64) -> bool {
        // Horizontal proximity covers the floors above and below a stash.
        // Allow for normal sprint movement between the sample and the commit.
        let margin = f64::from(crate::movement::SPRINT_SPEED) * PRESENCE_MAX_AGE.as_secs_f64();
        let radius_squared = (radius + margin).powi(2);
        self.players.iter().any(|player| {
            !player.x.is_finite()
                || !player.z.is_finite()
                || positions.clone().any(|[x, _, z]| {
                    let dx = f64::from(player.x) - f64::from(x);
                    let dz = f64::from(player.z) - f64::from(z);
                    dx * dx + dz * dz <= radius_squared
                })
        })
    }
}

pub(crate) const SCHEMA: &str = "
CREATE TABLE authored_loot_worlds(
    world TEXT PRIMARY KEY, manifest_sha256 TEXT NOT NULL
);
CREATE TABLE authored_loot_slots(
    world TEXT NOT NULL REFERENCES authored_loot_worlds(world),
    spawn_id INTEGER NOT NULL, stash TEXT NOT NULL,
    container TEXT NOT NULL UNIQUE REFERENCES item_containers(id),
    section TEXT NOT NULL, chance REAL NOT NULL CHECK(chance BETWEEN 0 AND 1),
    PRIMARY KEY(world,spawn_id)
);
CREATE INDEX authored_loot_stash_slots ON authored_loot_slots(world,stash);
PRAGMA user_version=9;";

pub(crate) const REFILL_SCHEMA: &str = "
ALTER TABLE authored_loot_slots ADD COLUMN ready_at_ms INTEGER CHECK(ready_at_ms >= 0);
CREATE INDEX authored_loot_due_slots ON authored_loot_slots(world,ready_at_ms) WHERE ready_at_ms IS NOT NULL;
PRAGMA user_version=10;";

pub(crate) const LOOSE_SCHEMA: &str = "
CREATE TABLE authored_loose_slots(
    world TEXT NOT NULL REFERENCES authored_loot_worlds(world),
    spawn_id INTEGER NOT NULL, placement_sha256 TEXT NOT NULL,
    container TEXT NOT NULL UNIQUE REFERENCES item_containers(id),
    PRIMARY KEY(world,spawn_id)
);
PRAGMA user_version=11;";

pub(crate) fn deadline(now: i64, rules: &SurvivalRules) -> i64 {
    now.saturating_add(i64::from(rules.loot_respawn_seconds) * 1000)
}

/// Pickup calls this inside the same transaction that moved the item.
pub(crate) fn record_pickup(
    tx: &Transaction<'_>,
    source: &str,
    rules: &SurvivalRules,
    now: i64,
) -> Result<()> {
    tx.execute(
        "UPDATE authored_loot_slots SET ready_at_ms=?2 WHERE container=?1 AND chance>0",
        params![source, deadline(now, rules)],
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    item_catalog_sha256: String,
    stashes: Vec<Stash>,
    spawn: SpawnSource,
    ground: Vec<GroundCandidate>,
}

#[derive(Deserialize)]
struct SpawnSource {
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GroundCandidate {
    spawn_id: u16,
    level: String,
    section: String,
    name: String,
    classification: String,
    position: [f32; 3],
    reasons: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LooseManifest {
    schema: u32,
    level: String,
    spawn_sha256: String,
    item_catalog_sha256: String,
    authored_loot_sha256: String,
    placements: Vec<LoosePlacement>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LoosePlacement {
    spawn_id: u16,
    section: String,
    name: String,
    position: [f32; 3],
    state: inventory::ItemState,
}

#[derive(Deserialize)]
struct Stash {
    id: String,
    marker: Option<Marker>,
    classification: String,
    reasons: Vec<String>,
    conditions: std::collections::BTreeMap<String, String>,
    placements: Vec<Position>,
}

#[derive(Deserialize)]
struct Marker {
    level: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Position {
    spawn_id: u16,
    level: String,
    section: String,
    position: [f32; 3],
    chance: f64,
}

struct Slot {
    position: Position,
    state: inventory::ItemState,
}

pub struct AuthoredLoot {
    world: String,
    digest: String,
    stashes: Vec<(String, Vec<Slot>)>,
    loose: Vec<LoosePlacement>,
    spawn_digest: String,
    artefacts: Option<crate::artefact::AuthoredArtefacts>,
}

impl AuthoredLoot {
    pub(crate) fn world(&self) -> &str {
        &self.world
    }

    pub fn load(
        path: &Path,
        loose_path: Option<&Path>,
        world: &str,
        collision: &CollisionMap,
        catalog: &Catalog,
    ) -> Result<Self> {
        ensure!(
            crate::session::campaign_level(world) == Some(collision.manifest.level.as_str()),
            "authored loot requires matching real-map authority"
        );
        ensure!(
            fs::metadata(path)?.len() <= 4 * 1024 * 1024,
            "oversized authored loot manifest"
        );
        let bytes = fs::read(path)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        ensure!(
            manifest.schema == 1 && manifest.item_catalog_sha256 == catalog.sha256,
            "authored loot manifest or catalog revision mismatch"
        );
        ensure!((1..=1024).contains(&manifest.stashes.len()), "invalid campaign stash count");
        let mut stashes = Vec::new();
        let mut stash_ids = BTreeSet::new();
        let mut spawn_ids = BTreeSet::new();
        let bounds = &collision.manifest.bounds;
        for stash in manifest.stashes {
            if stash.classification != "shared-stash"
                || stash
                    .marker
                    .as_ref()
                    .is_none_or(|marker| marker.level != collision.manifest.level)
            {
                continue;
            }
            ensure!(
                stash.reasons.is_empty() && stash.conditions.is_empty(),
                "conditional stash marked shared: {}",
                stash.id
            );
            ensure!(
                inventory::section_valid(&stash.id)
                    && stash_ids.insert(stash.id.clone())
                    && !stash.placements.is_empty()
                    && stash.placements.len() <= 128,
                "invalid authored stash {}",
                stash.id
            );
            let mut slots = Vec::new();
            for position in stash.placements {
                ensure!(
                    position.level == collision.manifest.level
                        && spawn_ids.insert(position.spawn_id)
                        && position.chance.is_finite()
                        && (0.0..=1.0).contains(&position.chance)
                        && position.position.iter().enumerate().all(|(axis, value)| {
                            value.is_finite()
                                && (bounds.min[axis]..=bounds.max[axis]).contains(value)
                        }),
                    "invalid authored loot position {}",
                    position.spawn_id
                );
                let (section, _) = catalog.item(&position.section)?;
                ensure!(
                    !section.boolean("quest_item", false)?,
                    "quest item in shared stash: {}",
                    position.section
                );
                let state = catalog
                    .initial_state(&position.section)
                    .with_context(|| format!("initial state for {}", position.section))?;
                catalog.validate_state(&position.section, &state)?;
                slots.push(Slot { position, state });
            }
            stashes.push((stash.id, slots));
        }
        // Underground maps have no treasure-manager stashes. They can still
        // have reviewed one-time loose placements in the same export.
        ensure!(spawn_ids.len() <= 8192, "too many authored map placements");
        let loose = match loose_path {
            Some(path) => {
                ensure!(
                    fs::metadata(path)?.len() <= 4 * 1024 * 1024,
                    "oversized loose loot manifest"
                );
                let loose: LooseManifest = serde_json::from_slice(&fs::read(path)?)?;
                ensure!(
                    loose.schema == 1
                        && loose.level == collision.manifest.level
                        && loose.spawn_sha256 == manifest.spawn.sha256
                        && loose.item_catalog_sha256 == catalog.sha256
                        && loose.authored_loot_sha256 == digest
                        && !loose.placements.is_empty()
                        && loose.placements.len() <= 8192,
                    "loose loot manifest or source revision mismatch"
                );
                let ground: std::collections::BTreeMap<_, _> =
                    manifest.ground.iter().map(|p| (p.spawn_id, p)).collect();
                ensure!(
                    ground.len() == manifest.ground.len(),
                    "duplicate ground placement"
                );
                for p in &loose.placements {
                    let source = ground.get(&p.spawn_id).context("unknown loose placement")?;
                    ensure!(
                        spawn_ids.insert(p.spawn_id)
                            && source.classification == "review-one-time"
                            && source.reasons.is_empty()
                            && source.section == p.section
                            && source.name == p.name
                            && source.level == loose.level
                            && source.position == p.position
                            && p.position
                                .iter()
                                .enumerate()
                                .all(|(axis, value)| value.is_finite()
                                    && (bounds.min[axis]..=bounds.max[axis]).contains(value)),
                        "invalid or conditional loose loot placement {}",
                        p.spawn_id
                    );
                    let (section, _) = catalog.item(&p.section)?;
                    ensure!(
                        !section.boolean("quest_item", false)?,
                        "quest item in loose loot"
                    );
                    catalog.validate_state(&p.section, &p.state)?;
                }
                loose.placements
            }
            None => Vec::new(),
        };
        Ok(Self {
            world: world.to_owned(),
            digest,
            stashes,
            loose,
            spawn_digest: manifest.spawn.sha256,
            artefacts: None,
        })
    }

    pub fn with_artefacts(mut self, path: &Path, collision: &CollisionMap, catalog: &Catalog) -> Result<Self> {
        self.artefacts = Some(crate::artefact::AuthoredArtefacts::load(path, &self.spawn_digest, collision, catalog)?);
        Ok(self)
    }

    pub(crate) fn seed(&self, tx: &Transaction<'_>, rules: &SurvivalRules) -> Result<()> {
        self.seed_stashes(tx, rules)?;
        self.seed_loose(tx)?;
        if let Some(artefacts) = &self.artefacts {
            artefacts.seed(tx, &self.world, rules)?;
        }
        Ok(())
    }

    fn seed_loose(&self, tx: &Transaction<'_>) -> Result<()> {
        let mut added = 0;
        for placement in &self.loose {
            let digest = format!("{:x}", Sha256::digest(serde_json::to_vec(placement)?));
            let previous: Option<String> = tx.query_row(
                "SELECT placement_sha256 FROM authored_loose_slots WHERE world=?1 AND spawn_id=?2",
                params![self.world, placement.spawn_id], |row| row.get(0),
            ).optional()?;
            if let Some(previous) = previous {
                ensure!(
                    previous == digest,
                    "loose placement {} differs from the saved world",
                    placement.spawn_id
                );
                continue;
            }
            let container = inventory::world_container(
                tx,
                "world",
                &self.world,
                placement.position.map(f64::from),
            )?;
            inventory::provision(
                tx,
                &container,
                &placement.section,
                &placement.state,
                "rucksack",
            )?;
            tx.execute(
                "INSERT INTO authored_loose_slots(world,spawn_id,placement_sha256,container) VALUES(?1,?2,?3,?4)",
                params![self.world, placement.spawn_id, digest, container],
            )?;
            added += 1;
        }
        if added > 0 {
            tracing::info!(world=%self.world, added, "seeded one-time loose loot");
        }
        Ok(())
    }

    fn seed_stashes(&self, tx: &Transaction<'_>, rules: &SurvivalRules) -> Result<()> {
        let imported: Option<String> = tx
            .query_row(
                "SELECT manifest_sha256 FROM authored_loot_worlds WHERE world=?1",
                [&self.world],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(imported) = imported {
            ensure!(
                imported == self.digest,
                "authored loot manifest differs from the saved world"
            );
            return Ok(());
        }

        tx.execute(
            "INSERT INTO authored_loot_worlds(world,manifest_sha256) VALUES(?1,?2)",
            params![self.world, self.digest],
        )?;
        let ready_at = deadline(crate::survival_rules::unix_millis()?, rules);
        let mut populated = 0;
        for (stash, slots) in &self.stashes {
            let mut rolled = Vec::new();
            for slot in slots {
                let position = &slot.position;
                let container = inventory::world_container(
                    tx,
                    "world",
                    &self.world,
                    position.position.map(f64::from),
                )?;
                tx.execute(
                    "INSERT INTO authored_loot_slots(world,spawn_id,stash,container,section,chance,ready_at_ms)
                     VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        self.world,
                        position.spawn_id,
                        stash,
                        container,
                        position.section,
                        position.chance,
                        (position.chance > 0.0).then_some(ready_at)
                    ],
                )?;
                // Roll each authored position independently, as CoP does. If
                // more positions win than the cap, choose among winners at random.
                let (draw, priority): (f64, i64) = tx.query_row(
                    "SELECT (random() & 4294967295) / 4294967296.0, random()",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if draw < position.chance {
                    rolled.push((priority, slot, container));
                }
            }
            rolled.sort_unstable_by_key(|entry| entry.0);
            for (_, slot, container) in rolled
                .into_iter()
                .take(rules.loot_max_items_per_spawn as usize)
            {
                inventory::provision(
                    tx,
                    &container,
                    &slot.position.section,
                    &slot.state,
                    "rucksack",
                )?;
                tx.execute(
                    "UPDATE authored_loot_slots SET ready_at_ms=NULL WHERE container=?1",
                    [&container],
                )?;
                populated += 1;
            }
        }
        tracing::info!(world=%self.world, stashes=self.stashes.len(), populated, "seeded authored loot");
        Ok(())
    }

    pub(crate) fn refill(
        &self,
        tx: &Transaction<'_>,
        rules: &SurvivalRules,
        presence: &Presence,
        now: i64,
    ) -> Result<usize> {
        if !presence.fresh() {
            return Ok(0);
        }

        // Schema v9 did not store cooldowns. Existing depleted slots receive
        // one full interval the first time they are observed on v10.
        tx.execute(
            "UPDATE authored_loot_slots AS slot SET ready_at_ms=?2
             WHERE world=?1 AND ready_at_ms IS NULL AND chance>0
                 AND NOT EXISTS(SELECT 1 FROM inventory_items WHERE container=slot.container)",
            params![self.world, deadline(now, rules)],
        )?;
        let mut query = tx.prepare_cached(
            "WITH filled AS (
                SELECT s.stash, COUNT(*) AS item_count
                FROM authored_loot_slots s JOIN inventory_items i ON i.container=s.container
                WHERE s.world=?1 GROUP BY s.stash
             )
             SELECT s.stash,s.spawn_id,s.container,s.chance
             FROM authored_loot_slots s LEFT JOIN filled f ON f.stash=s.stash
             WHERE s.world=?1 AND s.ready_at_ms<=?2
                AND COALESCE(f.item_count,0) < ?3
                AND NOT EXISTS(SELECT 1 FROM inventory_items WHERE container=s.container)
             ORDER BY s.ready_at_ms,s.spawn_id",
        )?;
        let candidates = query
            .query_map(
                params![self.world, now, rules.loot_max_items_per_spawn],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, u16>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, f64>(3)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut attempted = BTreeSet::new();
        let mut blocked = BTreeSet::new();
        let mut filled = 0;
        for (stash, spawn_id, container, chance) in candidates {
            if attempted.len() == MAX_REFILL_ATTEMPTS || !presence.fresh() {
                break;
            }
            if attempted.contains(&stash) || blocked.contains(&stash) {
                continue;
            }
            let (_, slots) = self
                .stashes
                .iter()
                .find(|(id, _)| *id == stash)
                .context("missing authored stash definition")?;
            if presence.near_positions(slots.iter().map(|slot| slot.position.position), rules.loot_player_exclusion_meters) {
                blocked.insert(stash);
                continue;
            }
            let slot = slots
                .iter()
                .find(|slot| slot.position.spawn_id == spawn_id)
                .context("missing authored slot definition")?;
            attempted.insert(stash);
            let draw: f64 =
                tx.query_row("SELECT (random() & 4294967295) / 4294967296.0", [], |row| {
                    row.get(0)
                })?;
            let next = if draw < chance {
                inventory::provision(
                    tx,
                    &container,
                    &slot.position.section,
                    &slot.state,
                    "rucksack",
                )?;
                filled += 1;
                None
            } else {
                Some(deadline(now, rules))
            };
            tx.execute(
                "UPDATE authored_loot_slots SET ready_at_ms=?2 WHERE container=?1",
                params![container, next],
            )?;
        }
        if let Some(artefacts) = &self.artefacts {
            filled += artefacts.refill(tx, &self.world, rules, presence, now)?;
        }
        Ok(filled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        inventory::{Context, Move, MoveAction},
        world::{Kind, Vec3, World},
    };
    use rusqlite::Connection;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE principals(id TEXT PRIMARY KEY);
             CREATE TABLE outcomes(principal TEXT,request_id TEXT,request TEXT,response TEXT,PRIMARY KEY(principal,request_id));
             CREATE TABLE runtime_meta(id INTEGER PRIMARY KEY,auth_epoch INTEGER NOT NULL);
             INSERT INTO runtime_meta VALUES(1,0);",
        ).unwrap();
        for schema in [
            inventory::SCHEMA,
            inventory::LIFECYCLE_SCHEMA,
            inventory::CONTAINER_SCHEMA,
            SCHEMA,
            REFILL_SCHEMA,
            LOOSE_SCHEMA,
            crate::artefact::SCHEMA,
        ] {
            connection.execute_batch(schema).unwrap();
        }
        connection
    }

    fn fixture(stash_count: u16, slots_per_stash: u16) -> AuthoredLoot {
        let stashes = (0..stash_count)
            .map(|stash| {
                let slots = (0..slots_per_stash)
                    .map(|slot| Slot {
                        position: Position {
                            spawn_id: stash * slots_per_stash + slot,
                            level: "test".into(),
                            section: "bandage".into(),
                            position: [f32::from(stash) * 20.0, 0.0, f32::from(slot)],
                            chance: 1.0,
                        },
                        state: inventory::ItemState {
                            condition: 1.0,
                            upgrades: Vec::new(),
                            payload: inventory::ItemPayload::Consumable { uses: 1 },
                        },
                    })
                    .collect();
                (format!("stash_{stash}"), slots)
            })
            .collect();
        AuthoredLoot {
            world: "synthetic-flat-v1".into(),
            digest: "test".into(),
            stashes,
            loose: Vec::new(),
            spawn_digest: "test".into(),
            artefacts: None,
        }
    }

    #[test]
    fn pickup_starts_cooldown_once_and_refill_requires_fresh_clear_proximity() {
        let mut db = database();
        let tx = db.transaction().unwrap();
        let loot = fixture(1, 1);
        let rules = SurvivalRules::default();
        loot.seed(&tx, &rules).unwrap();
        let (item, source): (String, String) = tx
            .query_row("SELECT id,container FROM inventory_items", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let principal = "a".repeat(32);
        tx.execute("INSERT INTO principals(id) VALUES(?1)", [&principal])
            .unwrap();
        inventory::initialize(&tx, &principal).unwrap();
        let context = Context {
            principal: principal.clone(),
            life: 0,
            visit: 0, auth_epoch: 0,
            world: loot.world.clone(),
            position: [0.0; 3],
            interaction_radius: 2.0,
            eye_height: 1.55,
            collision: None,
            expires: Instant::now() + Duration::from_secs(2),
        };
        let command = Move {
            request_id: "pickup-stash".into(),
            life: 0,
            item: item.clone(),
            revision: 0,
            action: MoveAction::Pickup {
                source: source.clone(),
            },
        };
        let result =
            inventory::move_item(&tx, &principal, &command, &context, None, Some(&rules), None).unwrap();
        assert_eq!(result["status"], "committed");
        let due: i64 = tx
            .query_row("SELECT ready_at_ms FROM authored_loot_slots", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(due > crate::survival_rules::unix_millis().unwrap());
        assert_eq!(
            inventory::move_item(&tx, &principal, &command, &context, None, Some(&rules), None).unwrap(),
            result
        );
        assert_eq!(
            tx.query_row("SELECT ready_at_ms FROM authored_loot_slots", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            due
        );

        let mut world = World::new();
        let clear = Presence::capture(&world);
        assert_eq!(loot.refill(&tx, &rules, &clear, due - 1).unwrap(), 0);
        let mut stale = Presence::capture(&world);
        stale.captured -= PRESENCE_MAX_AGE + Duration::from_millis(1);
        assert_eq!(loot.refill(&tx, &rules, &stale, due).unwrap(), 0);
        world.spawn(Kind::Npc, Vec3::default());
        let player = world.spawn(
            Kind::Player,
            Vec3 {
                x: 3.0,
                y: 200.0,
                z: 0.0,
            },
        );
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), due)
                .unwrap(),
            0
        );
        world.remove(player);
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), due)
                .unwrap(),
            1
        );
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), due)
                .unwrap(),
            0
        );
        let fresh_item: String = tx
            .query_row(
                "SELECT id FROM inventory_items WHERE container=?1",
                [source],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(fresh_item, item);
        assert_eq!(
            tx.query_row(
                "SELECT revision FROM inventory_items WHERE id=?1",
                [item],
                |r| r.get::<_, u32>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn refill_is_bounded_and_respects_stash_capacity() {
        let mut db = database();
        let tx = db.transaction().unwrap();
        let loot = fixture(10, 2);
        let rules = SurvivalRules {
            loot_max_items_per_spawn: 1,
            ..SurvivalRules::default()
        };
        loot.seed(&tx, &rules).unwrap();
        tx.execute("UPDATE authored_loot_slots SET ready_at_ms=1", [])
            .unwrap();
        let world = World::new();
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), 1)
                .unwrap(),
            0
        );
        tx.execute("DELETE FROM inventory_items", []).unwrap();
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), 1)
                .unwrap(),
            8
        );
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), 2)
                .unwrap(),
            2
        );
        assert_eq!(
            loot.refill(&tx, &rules, &Presence::capture(&world), 3)
                .unwrap(),
            0
        );
    }
}
