//! Authored anomaly loot. The same inventory transaction owns pickup and refill.
use crate::{
    catalog::{Catalog, Kind},
    collision::CollisionMap,
    inventory::{self, Context, ItemState},
    loot::Presence,
    survival_rules::SurvivalRules,
};
use anyhow::{Context as _, Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path};

pub(crate) const SCHEMA: &str = "
CREATE TABLE authored_artefact_worlds(
    world TEXT PRIMARY KEY REFERENCES authored_loot_worlds(world), manifest_sha256 TEXT NOT NULL
);
CREATE TABLE authored_artefact_slots(
    world TEXT NOT NULL REFERENCES authored_artefact_worlds(world),
    site INTEGER NOT NULL, slot INTEGER NOT NULL,
    container TEXT NOT NULL UNIQUE REFERENCES item_containers(id),
    way INTEGER, ready_at_ms INTEGER,
    PRIMARY KEY(world,site,slot)
);
CREATE INDEX authored_artefact_due ON authored_artefact_slots(world,ready_at_ms) WHERE ready_at_ms IS NOT NULL;
ALTER TABLE inventory_characters ADD COLUMN drawn_detector TEXT;
CREATE TABLE artefact_reveals(
    principal TEXT NOT NULL REFERENCES principals(id), item TEXT NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    life INTEGER NOT NULL, visit INTEGER NOT NULL, visible_until_ms INTEGER NOT NULL,
    PRIMARY KEY(principal,item)
);
CREATE INDEX artefact_reveals_item ON artefact_reveals(item);
CREATE INDEX artefact_reveals_expiry ON artefact_reveals(visible_until_ms);
CREATE TRIGGER drawn_detector_removed AFTER UPDATE OF place,container ON inventory_items
    WHEN OLD.place='slot:9' AND (NEW.place!='slot:9' OR NEW.container!=OLD.container) BEGIN
    UPDATE inventory_characters SET drawn_detector=NULL
        WHERE principal=(SELECT owner FROM item_containers WHERE id=OLD.container) AND drawn_detector=OLD.id;
END;
PRAGMA user_version=20;";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    spawn_sha256: String,
    item_catalog_sha256: String,
    sites: Vec<Site>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Site {
    spawn_id: u16,
    level: String,
    cap: u8,
    start: Option<String>,
    choices: Vec<Choice>,
    ways: Vec<Way>,
}

#[derive(Deserialize)]
struct Choice {
    section: String,
    weight: u32,
}

#[derive(Deserialize)]
struct Way {
    name: String,
    points: Vec<[f32; 3]>,
}

pub(crate) struct AuthoredArtefacts {
    digest: String,
    sites: Vec<Site>,
    states: std::collections::BTreeMap<String, ItemState>,
}

impl AuthoredArtefacts {
    pub(crate) fn load(
        path: &Path,
        spawn: &str,
        map: &CollisionMap,
        catalog: &Catalog,
    ) -> Result<Self> {
        ensure!(
            fs::metadata(path)?.len() <= 1024 * 1024,
            "oversized artefact manifest"
        );
        let bytes = fs::read(path)?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        ensure!(
            manifest.schema == 1
                && manifest.spawn_sha256 == spawn
                && manifest.item_catalog_sha256 == catalog.sha256
                && manifest.sites.len() <= 128,
            "artefact manifest or source revision mismatch"
        );
        let mut sites: Vec<_> = manifest
            .sites
            .into_iter()
            .filter(|s| s.level == map.manifest.level)
            .collect();
        let mut ids = BTreeSet::new();
        let mut states = std::collections::BTreeMap::new();
        let mut unreachable = 0;
        let take_distance = catalog.section("inventory")?.number("take_dist")? as f32;
        for site in &mut sites {
            ensure!(
                ids.insert(site.spawn_id)
                    && (1..=8).contains(&site.cap)
                    && (1..=32).contains(&site.choices.len())
                    && (1..=32).contains(&site.ways.len()),
                "invalid artefact site {}",
                site.spawn_id
            );
            let mut sections = BTreeSet::new();
            for choice in &site.choices {
                ensure!(
                    choice.weight <= 1000 && sections.insert(choice.section.as_str()),
                    "invalid artefact weight"
                );
            }
            ensure!(
                site.choices.iter().any(|c| c.weight > 0),
                "empty artefact pool"
            );
            for section in sections.into_iter().chain(site.start.as_deref()) {
                let (config, kind) = catalog.item(section)?;
                ensure!(
                    kind == Kind::Artefact
                        && !config.boolean("quest_item", false)?
                        && (1..=3).contains(&config.integer("af_rank")?),
                    "invalid authored artefact {section}"
                );
                let state = catalog.initial_state(section)?;
                catalog.validate_state(section, &state)?;
                states.insert(section.to_owned(), state);
            }
            let mut names = BTreeSet::new();
            let bounds = &map.manifest.bounds;
            for way in &mut site.ways {
                ensure!(
                    inventory::section_valid(&way.name)
                        && names.insert(&way.name)
                        && (1..=128).contains(&way.points.len())
                        && way.points.iter().flatten().all(|v| v.is_finite())
                        && way.points.iter().all(|p| p
                            .iter()
                            .enumerate()
                            .all(|(axis, v)| (bounds.min[axis]..=bounds.max[axis]).contains(v))),
                    "invalid artefact path {}",
                    way.name
                );
                let mut reachable = Vec::with_capacity(way.points.len());
                for &point in &way.points {
                    if reachable_point(map, point, take_distance)? {
                        reachable.push(point);
                    } else {
                        unreachable += 1;
                    }
                }
                way.points = reachable;
            }
            site.ways.retain(|way| !way.points.is_empty());
            ensure!(
                !site.ways.is_empty(),
                "artefact site {} has no reachable patrol points",
                site.spawn_id
            );
        }
        tracing::info!(level=%map.manifest.level, sites=sites.len(), unreachable, "validated artefact patrol points");
        Ok(Self {
            digest: format!("{:x}", Sha256::digest(bytes)),
            sites,
            states,
        })
    }

    pub(crate) fn seed(
        &self,
        tx: &Transaction<'_>,
        world: &str,
        rules: &SurvivalRules,
    ) -> Result<()> {
        let previous: Option<String> = tx
            .query_row(
                "SELECT manifest_sha256 FROM authored_artefact_worlds WHERE world=?1",
                [world],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(previous) = previous {
            ensure!(
                previous == self.digest,
                "authored artefact manifest differs from the saved world"
            );
            return Ok(());
        }
        tx.execute(
            "INSERT INTO authored_artefact_worlds VALUES(?1,?2)",
            params![world, self.digest],
        )?;
        let ready = crate::loot::deadline(crate::survival_rules::unix_millis()?, rules);
        for site in &self.sites {
            for slot in 0..site.cap {
                let container = inventory::world_container(
                    tx,
                    "world",
                    world,
                    site.ways[0].points[0].map(f64::from),
                )?;
                tx.execute("INSERT INTO authored_artefact_slots(world,site,slot,container,ready_at_ms) VALUES(?1,?2,?3,?4,?5)",
                    params![world, site.spawn_id, slot, container, ready])?;
                if slot == 0
                    && let Some(section) = &site.start
                {
                    self.fill(tx, world, site, &container, section)?;
                }
            }
        }
        tracing::info!(
            world,
            sites = self.sites.len(),
            "seeded authored artefact sites"
        );
        Ok(())
    }

    fn fill(
        &self,
        tx: &Transaction<'_>,
        world: &str,
        site: &Site,
        container: &str,
        section: &str,
    ) -> Result<()> {
        let mut query = tx.prepare_cached("SELECT way FROM authored_artefact_slots WHERE world=?1 AND site=?2 AND way IS NOT NULL")?;
        let occupied = query
            .query_map(params![world, site.spawn_id], |r| r.get::<_, u16>(0))?
            .collect::<rusqlite::Result<BTreeSet<_>>>()?;
        let mut ways: Vec<_> = (0..site.ways.len())
            .filter(|index| !occupied.contains(&(*index as u16)))
            .collect();
        if ways.is_empty() {
            ways.extend(0..site.ways.len());
        }
        let way = ways[draw(tx, ways.len())?];
        let points = &site.ways[way].points;
        let [x, y, z] = points[draw(tx, points.len())?];
        tx.execute(
            "UPDATE item_containers SET x=?2,y=?3,z=?4 WHERE id=?1",
            params![container, x, y, z],
        )?;
        inventory::provision(tx, container, section, &self.states[section], "rucksack")?;
        tx.execute(
            "UPDATE authored_artefact_slots SET way=?2,ready_at_ms=NULL WHERE container=?1",
            params![container, way as u16],
        )?;
        Ok(())
    }

    pub(crate) fn refill(
        &self,
        tx: &Transaction<'_>,
        world: &str,
        rules: &SurvivalRules,
        presence: &Presence,
        now: i64,
    ) -> Result<usize> {
        let mut query = tx.prepare_cached(
            "SELECT site,container FROM authored_artefact_slots
            WHERE world=?1 AND ready_at_ms<=?2 ORDER BY ready_at_ms,site,slot",
        )?;
        let candidates = query
            .query_map(params![world, now], |r| {
                Ok((r.get::<_, u16>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut checked = BTreeSet::new();
        let mut attempts = 0;
        let mut filled = 0;
        for (id, container) in candidates {
            if attempts == 8 || !presence.fresh() {
                break;
            }
            if !checked.insert(id) {
                continue;
            }
            let site = self
                .sites
                .iter()
                .find(|s| s.spawn_id == id)
                .context("missing authored artefact site")?;
            if presence.near_positions(
                site.ways.iter().flat_map(|way| way.points.iter().copied()),
                rules.loot_player_exclusion_meters,
            ) {
                continue;
            }
            attempts += 1;
            // A missed attempt waits for a new interval, just like a new stock spawn cycle.
            if draw(tx, 100)? >= 17 {
                tx.execute(
                    "UPDATE authored_artefact_slots SET ready_at_ms=?2 WHERE container=?1",
                    params![container, crate::loot::deadline(now, rules)],
                )?;
                continue;
            }
            let mut roll = draw(tx, site.choices.iter().map(|c| c.weight as usize).sum())?;
            for choice in &site.choices {
                if roll < choice.weight as usize {
                    self.fill(tx, world, site, &container, &choice.section)?;
                    filled += 1;
                    break;
                }
                roll -= choice.weight as usize;
            }
        }
        Ok(filled)
    }
}

fn reachable_point(map: &CollisionMap, [x, y, z]: [f32; 3], take_distance: f32) -> Result<bool> {
    use parry3d::math::Vector;
    let point = Vector::new(x, y, z);
    let exposed = point + Vector::Y * 0.05;
    for (dx, dz) in [(0.4, 0.), (-0.4, 0.), (0., 0.4), (0., -0.4), (0., 0.)] {
        for dy in [0.1, 0.6, 1.2, -0.5, -1.0] {
            let Ok(feet) = map.spawn_feet_near(x + dx, y + dy, z + dz) else {
                continue;
            };
            if feet.distance(point) > take_distance - 0.05 {
                continue;
            }
            for height in [1.55, 0.95] {
                let origin = feet + Vector::Y * height;
                let delta = exposed - origin;
                let distance = delta.length();
                if distance <= 0.02
                    || map
                        .ray(origin, delta / distance, distance - 0.01)?
                        .is_none()
                {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

fn draw(tx: &Transaction<'_>, count: usize) -> Result<usize> {
    let roll: u32 = tx.query_row(
        "SELECT (random() & 9223372036854775807) % ?1",
        [u32::try_from(count)?],
        |row| row.get(0),
    )?;
    Ok(roll as usize)
}

pub(crate) fn picked_up(tx: &Transaction<'_>, source: &str, item: &str, ready: i64) -> Result<()> {
    let changed = tx.execute(
        "UPDATE authored_artefact_slots SET way=NULL,ready_at_ms=?2 WHERE container=?1",
        params![source, ready],
    )?;
    if changed > 0 {
        // Clear old private visibility before this instance can be dropped again.
        tx.execute("DELETE FROM artefact_reveals WHERE item=?1", [item])?;
    }
    Ok(())
}

const DETECTOR_SLOT: &str = "slot:9";
const REVEAL_MS: i64 = 5000;

struct Detector<'a> {
    config: &'a crate::catalog::Section,
    tier: u8,
    rank: i32,
    radius: f64,
    visible_radius: f64,
}

impl<'a> Detector<'a> {
    fn load(catalog: &'a Catalog, section: &str, state: &str) -> Result<Option<Self>> {
        let (config, kind) = catalog.item(section)?;
        let (tier, rank) = match (kind, config.text("class")?) {
            (Kind::Equipment, "DET_SIMP") => (1, 1),
            (Kind::Equipment, "DET_ADVA") => (2, 2),
            (Kind::Equipment, "DET_ELIT") => (3, 3),
            (Kind::Equipment, "DET_SCIE") => (4, 3),
            _ => return Ok(None),
        };
        let state: ItemState = serde_json::from_str(state)?;
        if config.boolean("use_condition", false)? && state.condition <= 0.01 {
            return Ok(None);
        }
        let radius = config.number("af_radius")?;
        let visible_radius = config.number("af_vis_radius")?;
        ensure!(
            radius <= 64.0 && visible_radius > 0.0 && visible_radius <= radius,
            "invalid detector range"
        );
        Ok(Some(Self {
            config,
            tier,
            rank,
            radius,
            visible_radius,
        }))
    }

    fn artefact_index(&self, section: &str) -> Option<&str> {
        self.config.values.iter().find_map(|(key, value)| {
            (value == section)
                .then(|| key.strip_prefix("af_class_"))
                .flatten()
        })
    }
}

fn compatible_primary(catalog: &Catalog, section: &str) -> Result<bool> {
    // X-Ray stores zero-based base slots. A pistol can also occupy slot 3.
    Ok(matches!(
        catalog.item(section)?.0.list("slot").first(),
        Some(&("0" | "1" | "5"))
    ))
}

fn slot_item(
    tx: &Transaction<'_>,
    principal: &str,
    slot: &str,
) -> Result<Option<(String, String, String)>> {
    Ok(tx.query_row("SELECT i.id,i.section,i.state FROM inventory_items i
        JOIN item_containers c ON c.id=i.container WHERE c.owner=?1 AND c.kind='carried' AND i.place=?2",
        params![principal, slot], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?)
}

pub(crate) fn select(
    tx: &Transaction<'_>,
    context: &Context,
    life: u32,
    active: bool,
    catalog: &Catalog,
) -> Result<serde_json::Value> {
    use serde_json::json;
    if life != context.life || !inventory::alive_context(tx, &context.principal, context)? {
        return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"}));
    }
    let principal = &context.principal;
    let mut id = None;
    if active {
        let Some((item, section, state)) = slot_item(tx, principal, DETECTOR_SLOT)? else {
            return Ok(json!({"status":"rejected","reason":"detector_unavailable"}));
        };
        if Detector::load(catalog, &section, &state)?.is_none() {
            return Ok(json!({"status":"rejected","reason":"detector_unavailable"}));
        }
        let current = inventory::active_weapon_slot(tx, principal)?;
        if current != 0
            && let Some((_, section, _)) = slot_item(tx, principal, &format!("slot:{current}"))?
            && !compatible_primary(catalog, &section)?
        {
            let mut replacement = None;
            for slot in [2, 3, 1, 6] {
                if let Some((_, section, _)) = slot_item(tx, principal, &format!("slot:{slot}"))?
                    && compatible_primary(catalog, &section)?
                {
                    replacement = Some(slot);
                    break;
                }
            }
            let Some(slot) = replacement else {
                return Ok(json!({"status":"rejected","reason":"detector_primary_incompatible"}));
            };
            inventory::select_weapon(tx, context, life, slot, catalog)?;
        }
        id = Some(item);
    }
    tx.execute(
        "UPDATE inventory_characters SET drawn_detector=?2 WHERE principal=?1",
        params![principal, id],
    )?;
    Ok(json!({"status":"selected","detector":active}))
}

pub(crate) fn scan(
    tx: &Transaction<'_>,
    context: &Context,
    catalog: &Catalog,
    now: i64,
    scan: &inventory::DetectorScan,
) -> Result<Option<serde_json::Value>> {
    use serde_json::json;
    let principal = &context.principal;
    let equipped: Option<(String, String)> = tx
        .query_row(
            "SELECT i.section,i.state FROM inventory_characters a
        JOIN inventory_items i ON i.id=a.drawn_detector AND i.place='slot:9'
        JOIN item_containers c ON c.id=i.container AND c.owner=a.principal AND c.kind='carried'
        WHERE a.principal=?1",
            [principal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((section, state)) = equipped else {
        return Ok(None);
    };
    let Some(detector) = Detector::load(catalog, &section, &state)? else {
        return Ok(None);
    };
    if scan.hands_busy {
        return Ok(Some(json!({"tier":detector.tier,"working":false})));
    }
    let slot = inventory::active_weapon_slot(tx, principal)?;
    if slot != 0
        && let Some((_, primary, _)) = slot_item(tx, principal, &format!("slot:{slot}"))?
        && !compatible_primary(catalog, &primary)?
    {
        return Ok(Some(json!({"tier":detector.tier,"working":false})));
    }
    let [x, y, z] = context.position;
    let mut query = tx.prepare_cached(
        "SELECT i.id,i.section,c.x,c.y,c.z FROM authored_artefact_slots s
        JOIN item_containers c ON c.id=s.container JOIN inventory_items i ON i.container=s.container
        WHERE s.world=?1 AND c.x BETWEEN ?2-?5 AND ?2+?5 AND c.y BETWEEN ?3-?5 AND ?3+?5
        AND c.z BETWEEN ?4-?5 AND ?4+?5 ORDER BY i.id",
    )?;
    let rows = query.query_map(params![context.world, x, y, z, detector.radius], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            [r.get::<_, f64>(2)?, r.get(3)?, r.get(4)?],
        ))
    })?;
    let mut detected = Vec::new();
    for row in rows {
        let (item, section, position) = row?;
        let Some(index) = detector.artefact_index(&section) else {
            continue;
        };
        let distance = (position[0] - x).hypot((position[1] - y).hypot(position[2] - z));
        if distance > detector.radius
            || catalog.item(&section)?.0.integer("af_rank")? > detector.rank
        {
            continue;
        }
        if distance < detector.visible_radius {
            tx.execute("INSERT INTO artefact_reveals VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(principal,item) DO UPDATE SET life=excluded.life,visit=excluded.visit,visible_until_ms=excluded.visible_until_ms
                WHERE life!=excluded.life OR visit!=excluded.visit OR visible_until_ms<=excluded.visible_until_ms-500",
                params![principal,item,context.life,context.visit,now.saturating_add(REVEAL_MS)])?;
        }
        detected.push((distance, position, index, section));
    }
    let mut hint = json!({"tier":detector.tier,"working":true});
    if detector.tier >= 3 {
        const MAX_POINTS: usize = 32;
        detected.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
        let mut points: Vec<_> = detected.iter().take(MAX_POINTS).map(|(_, p, _, _)| *p).collect();
        if detector.tier == 4 {
            let mut labels: Vec<_> = detected.iter().take(MAX_POINTS)
                .map(|(_, _, _, section)| section.as_str()).collect();
            if let Some(radar_zones) = &scan.radar_zones && points.len() < MAX_POINTS {
                // The native list stops at the first missing zone_class_N.
                let allowed: BTreeSet<_> = (1..).map_while(|i| detector.config.values
                    .get(&format!("zone_class_{i}")).map(String::as_str)).collect();
                for (section, position) in radar_zones.nearest(
                    context.position, detector.radius as f32, &allowed, MAX_POINTS - points.len(),
                ) {
                    points.push(position.map(f64::from));
                    labels.push(section);
                }
            }
            hint["labels"] = json!(labels);
        }
        hint["points"] = json!(points);
    } else if let Some((distance, position, index, _)) =
        detected.iter().min_by(|a, b| a.0.total_cmp(&b.0))
    {
        let frequency = detector.config.list(&format!("af_freq_{index}"));
        let [min, max] = frequency.as_slice() else {
            anyhow::bail!("invalid detector sound period")
        };
        let min: f64 = min.parse()?;
        let max: f64 = max.parse()?;
        let ratio = distance / detector.radius;
        hint["period"] = json!(min + (max - min) * ratio * ratio);
        hint["pitch"] = json!(0.9 + 0.5 * (1.0 - ratio));
        if detector.tier == 2 {
            hint["bearing"] = json!((position[0] - x).atan2(position[2] - z));
        }
    }
    Ok(Some(hint))
}

pub(crate) fn can_pick_up(
    tx: &Transaction<'_>,
    context: &Context,
    source: &str,
    item: &str,
    now: i64,
) -> Result<bool> {
    Ok(tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM authored_artefact_slots WHERE container=?1)
        OR EXISTS(SELECT 1 FROM artefact_reveals WHERE principal=?2 AND item=?3 AND life=?4 AND visit=?5 AND visible_until_ms>?6)",
        params![source, context.principal, item, context.life, context.visit, now], |r| r.get(0))?)
}
