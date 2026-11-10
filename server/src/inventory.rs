//! Durable inventory transactions. No client minting and no replacement UI.
//! Catalog compatibility/effects must be validated before adding equip/use commands.
use anyhow::{Context as _, Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Instant;
use crate::survival_rules::{StorageStation, SurvivalRules};

pub(crate) const SCHEMA: &str = "
CREATE TABLE item_containers(
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('carried','storage','world','corpse')),
 owner TEXT REFERENCES principals(id), world TEXT, x REAL, y REAL, z REAL,
 CHECK((kind IN('carried','storage') AND owner IS NOT NULL AND world IS NULL)
    OR (kind IN('world','corpse') AND owner IS NULL AND world IS NOT NULL AND x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL)));
CREATE UNIQUE INDEX personal_item_containers ON item_containers(owner,kind) WHERE owner IS NOT NULL;
CREATE TABLE inventory_characters(
 principal TEXT PRIMARY KEY REFERENCES principals(id), life INTEGER NOT NULL DEFAULT 0 CHECK(life BETWEEN 0 AND 4294967295),
 alive INTEGER NOT NULL DEFAULT 1 CHECK(alive IN(0,1)), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 9007199254740991),
 corpse TEXT REFERENCES item_containers(id));
CREATE TABLE inventory_items(
 id TEXT PRIMARY KEY, container TEXT NOT NULL REFERENCES item_containers(id),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 4294967295),
 section TEXT NOT NULL, state TEXT NOT NULL, place TEXT NOT NULL DEFAULT 'rucksack');
CREATE INDEX inventory_container_items ON inventory_items(container,id);
CREATE UNIQUE INDEX inventory_equipped_place ON inventory_items(container,place) WHERE place!='rucksack';
CREATE TRIGGER inventory_insert AFTER INSERT ON inventory_items BEGIN
 UPDATE inventory_characters SET generation=generation+1 WHERE principal=(SELECT owner FROM item_containers WHERE id=NEW.container); END;
CREATE TRIGGER inventory_delete AFTER DELETE ON inventory_items BEGIN
 UPDATE inventory_characters SET generation=generation+1 WHERE principal=(SELECT owner FROM item_containers WHERE id=OLD.container); END;
CREATE TRIGGER inventory_update AFTER UPDATE ON inventory_items BEGIN
 UPDATE inventory_characters SET generation=generation+1 WHERE principal IN(SELECT owner FROM item_containers WHERE id IN(OLD.container,NEW.container)); END;
PRAGMA user_version=5;";

pub(crate) const LIFECYCLE_SCHEMA:&str="
ALTER TABLE inventory_characters ADD COLUMN dead_at_ms INTEGER;
ALTER TABLE item_containers ADD COLUMN expires_at_ms INTEGER;
CREATE INDEX inventory_expiry ON item_containers(expires_at_ms) WHERE expires_at_ms IS NOT NULL;
CREATE TABLE inventory_grants(principal TEXT NOT NULL REFERENCES inventory_characters(principal),life INTEGER NOT NULL,PRIMARY KEY(principal,life));
PRAGMA user_version=6;";

pub(crate) const CONTAINER_SCHEMA:&str="
ALTER TABLE item_containers ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK(generation BETWEEN 0 AND 9007199254740991);
CREATE TRIGGER container_item_insert AFTER INSERT ON inventory_items BEGIN UPDATE item_containers SET generation=generation+1 WHERE id=NEW.container; END;
CREATE TRIGGER container_item_delete AFTER DELETE ON inventory_items BEGIN UPDATE item_containers SET generation=generation+1 WHERE id=OLD.container; END;
CREATE TRIGGER container_item_update AFTER UPDATE ON inventory_items BEGIN UPDATE item_containers SET generation=generation+1 WHERE id IN(OLD.container,NEW.container); END;
PRAGMA user_version=8;";

pub(crate) const ACTIVE_WEAPON_SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN active_weapon_slot INTEGER
    CHECK(active_weapon_slot IN (0,2,3));
PRAGMA user_version=16;";

pub(crate) const GRENADE_SLOT_SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN grenade_drawn INTEGER NOT NULL DEFAULT 0
    CHECK(grenade_drawn IN (0,1));
PRAGMA user_version=17;";

pub(crate) const KNIFE_SLOT_SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN selected_weapon_slot INTEGER
    CHECK(selected_weapon_slot IN (0,1,2,3));
UPDATE inventory_characters SET selected_weapon_slot=active_weapon_slot;
ALTER TABLE inventory_characters DROP COLUMN active_weapon_slot;
ALTER TABLE inventory_characters RENAME COLUMN selected_weapon_slot TO active_weapon_slot;
PRAGMA user_version=18;";

pub(crate) const BOLT_SLOT_SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN selected_weapon_slot INTEGER
    CHECK(selected_weapon_slot IN (0,1,2,3,6));
UPDATE inventory_characters SET selected_weapon_slot=active_weapon_slot;
ALTER TABLE inventory_characters DROP COLUMN active_weapon_slot;
ALTER TABLE inventory_characters RENAME COLUMN selected_weapon_slot TO active_weapon_slot;
PRAGMA user_version=19;";

/// Per-instance state, never supplied by a browser action. Section names refer to
/// original configuration sections; no new fixed magazine/ammunition model.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemState {
    pub condition: f32,
    pub upgrades: Vec<String>,
    pub payload: ItemPayload,
}
/// The original loose item held by a weapon. Its revision advances when it
/// moves into or out of that weapon, just as with other inventory transfers.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AttachedItem {
    pub id: String,
    pub revision: u32,
    pub section: String,
    pub condition: f32,
    pub upgrades: Vec<String>,
}
impl AttachedItem {
    pub(crate) fn state(&self) -> ItemState {
        ItemState {
            condition: self.condition,
            upgrades: self.upgrades.clone(),
            payload: ItemPayload::Equipment,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ItemPayload {
    Equipment,
    Ammunition {
        rounds: u32,
    },
    Consumable {
        uses: u32,
    },
    Weapon {
        // Preserve cartridge order/types and the separate launcher magazine.
        cartridges: Vec<String>,
        launcher_cartridges: Vec<String>,
        selected_ammunition: String,
        attachments: Vec<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachment_items: Vec<AttachedItem>,
        // Zero selects the authored default. An explicit selector is one based.
        fire_mode: u8,
        launcher_mode: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        jammed: bool,
    },
}
pub(crate) fn section_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-.".contains(&c))
}
impl ItemState {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.condition.is_finite() && (0.0..=1.0).contains(&self.condition),
            "invalid condition"
        );
        ensure!(
            self.upgrades.iter().all(|s| section_valid(s)),
            "invalid upgrade"
        );
        match &self.payload {
            ItemPayload::Ammunition { rounds } => ensure!(*rounds > 0, "empty ammunition item"),
            ItemPayload::Consumable { uses } => ensure!(*uses > 0, "empty consumable item"),
            ItemPayload::Weapon {
                cartridges,
                launcher_cartridges,
                selected_ammunition,
                attachments,
                attachment_items,
                ..
            } => {
                ensure!(
                    section_valid(selected_ammunition),
                    "invalid ammunition section"
                );
                ensure!(
                    cartridges
                        .iter()
                        .chain(launcher_cartridges)
                        .chain(attachments)
                        .all(|s| section_valid(s)),
                    "invalid weapon section"
                );
                let mut ids = std::collections::BTreeSet::new();
                let mut sections = std::collections::BTreeSet::new();
                for addon in attachment_items {
                    ensure!(crate::ownership::valid_id(&addon.id)
                        && ids.insert(&addon.id) && sections.insert(&addon.section)
                        && attachments.contains(&addon.section),
                        "invalid attached item");
                    addon.state().validate()?;
                }
            }
            ItemPayload::Equipment => {}
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= 8192,
            "item state too large"
        );
        Ok(())
    }
}

/// Minted from simulation state, never deserialized from a client packet.
#[derive(Clone, Debug)]
pub struct Context {
    pub principal: String,
    pub life: u32,
    pub visit: u32,
    pub auth_epoch: u64,
    pub world: String,
    pub position: [f64; 3],
    pub interaction_radius: f64,
    pub eye_height: f32,
    pub collision: Option<std::sync::Arc<crate::collision::CollisionMap>>,
    pub expires: Instant,
}

#[derive(Clone, Default)]
pub struct DetectorScan {
    pub radar_zones: Option<std::sync::Arc<crate::environment::RadarZones>>,
    pub hands_busy: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Move {
    pub request_id: String,
    pub life: u32,
    pub item: String,
    pub revision: u32,
    pub action: MoveAction,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Respawn {pub request_id:String,pub life:u32}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum MoveAction {
    Pickup {
        source: String,
    },
    Drop,
    Consume,
    Store { destination: String },
    Reload,
    Unload,
    NextAmmo,
    FireMode { next: bool },
    LauncherMode { active: bool },
    Attach { addon: String, #[serde(rename = "addonRevision")] addon_revision: u32 },
    Detach { slot: AttachmentSlot },
    Place {
        placement: crate::equipment::Placement,
    },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentSlot {
    Scope,
    Silencer,
    Launcher,
}
impl AttachmentSlot {
    pub(crate) fn for_class(class: &str) -> Option<Self> {
        match class {
            "WP_SCOPE" => Some(Self::Scope),
            "WP_SILEN" => Some(Self::Silencer),
            "WP_GLAUN" => Some(Self::Launcher),
            _ => None,
        }
    }
}
impl Move {
    pub fn validate(&self) -> Result<()> {
        crate::persistence::validate_request_id(&self.request_id)?;
        ensure!(crate::ownership::valid_id(&self.item), "invalid item id");
        if let MoveAction::Pickup { source } | MoveAction::Store { destination: source } = &self.action {
            ensure!(crate::ownership::valid_id(source), "invalid source id");
        }
        if let MoveAction::Attach { addon, .. } = &self.action {
            ensure!(crate::ownership::valid_id(addon) && *addon != self.item, "invalid attachment id");
        }
        Ok(())
    }
}

/// Server-only setup. It never resets an existing dead character on reconnect.
pub(crate) fn initialize(tx: &Transaction<'_>, principal: &str) -> Result<()> {
    tx.execute(
        "INSERT INTO inventory_characters(principal) VALUES(?1) ON CONFLICT DO NOTHING",
        [principal],
    )?;
    for kind in ["carried", "storage"] {
        tx.execute("INSERT INTO item_containers(id,kind,owner) VALUES(lower(hex(randomblob(16))),?1,?2) ON CONFLICT DO NOTHING", params![kind, principal])?;
    }
    Ok(())
}
pub(crate) fn initialize_with_rules(
    tx: &Transaction<'_>,
    principal: &str,
    catalog: Option<&crate::catalog::Catalog>,
    rules: Option<&crate::survival_rules::SurvivalRules>,
) -> Result<()> {
    initialize(tx, principal)?;
    if let (Some(catalog), Some(rules)) = (catalog, rules) {
        let (life, alive): (u32, bool) = tx.query_row(
            "SELECT life,alive FROM inventory_characters WHERE principal=?1",
            [principal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if alive {
            grant_starter(tx, principal, life, catalog, rules)?;
        }
    }
    Ok(())
}
fn grant_starter(
    tx: &Transaction<'_>,
    principal: &str,
    life: u32,
    catalog: &crate::catalog::Catalog,
    rules: &crate::survival_rules::SurvivalRules,
) -> Result<()> {
    let granted = tx.execute(
        "INSERT INTO inventory_grants(principal,life) VALUES(?1,?2) ON CONFLICT DO NOTHING",
        params![principal, life],
    )?;
    if granted == 0 {
        return Ok(());
    }
    let carry = personal_container(tx, principal, "carried")?;
    for item in &rules.starter_kit {
        let state = catalog.initial_state(&item.section)?;
        catalog.validate_state(&item.section, &state)?;
        for _ in 0..item.count {
            let id = provision(tx, &carry, &item.section, &state, "rucksack")?;
            if item.placement != crate::equipment::Placement::Rucksack {
                ensure!(
                    crate::equipment::place(tx, &carry, &id, &item.placement, catalog)?.is_none(),
                    "invalid starter equipment placement"
                );
            }
        }
    }
    Ok(())
}
pub(crate) fn personal_container(
    tx: &Transaction<'_>,
    principal: &str,
    kind: &str,
) -> Result<String> {
    Ok(tx.query_row(
        "SELECT id FROM item_containers WHERE owner=?1 AND kind=?2",
        params![principal, kind],
        |r| r.get(0),
    )?)
}
pub(crate) fn world_container(
    tx: &Transaction<'_>,
    kind: &str,
    world: &str,
    position: [f64; 3],
) -> Result<String> {
    ensure!(
        matches!(kind, "world" | "corpse")
            && section_valid(world)
            && position.iter().all(|v| v.is_finite()),
        "invalid world container"
    );
    Ok(tx.query_row("INSERT INTO item_containers(id,kind,world,x,y,z) VALUES(lower(hex(randomblob(16))),?1,?2,?3,?4,?5) RETURNING id", params![kind,world,position[0],position[1],position[2]], |r| r.get(0))?)
}
pub(crate) fn provision(
    tx: &Transaction<'_>,
    container: &str,
    section: &str,
    state: &ItemState,
    place: &str,
) -> Result<String> {
    ensure!(section_valid(section), "invalid item section");
    state.validate()?;
    // Placement is trusted import state, not an equip endpoint. Catalog-dependent
    // slot/belt compatibility is deliberately not approximated here.
    ensure!(
        place == "rucksack"
            || place
                .strip_prefix("slot:")
                .or_else(|| place.strip_prefix("belt:"))
                .is_some_and(|s| s.parse::<u8>().is_ok()),
        "invalid placement"
    );
    let kind: String = tx.query_row(
        "SELECT kind FROM item_containers WHERE id=?1",
        [container],
        |r| r.get(0),
    )?;
    ensure!(
        kind == "carried" || place == "rucksack",
        "only carried items can be equipped"
    );
    Ok(tx.query_row("INSERT INTO inventory_items(id,container,section,state,place) VALUES(lower(hex(randomblob(16))),?1,?2,?3,?4) RETURNING id", params![container,section,serde_json::to_string(state)?,place], |r| r.get(0))?)
}
fn presented_state(raw: &str) -> Result<ItemState> {
    let mut state: ItemState = serde_json::from_str(raw)?;
    // Clients render the attached sections. The inactive item records belong
    // to persistence and are never independently actionable while attached.
    if let ItemPayload::Weapon { attachment_items, .. } = &mut state.payload {
        attachment_items.clear();
    }
    Ok(state)
}
pub(crate) fn list(
    tx: &Transaction<'_>,
    principal: &str,
    after: &str,
    expected: Option<u64>,
) -> Result<Value> {
    let (life, alive, generation, corpse): (u32, bool, i64, Option<String>) = tx.query_row(
        "SELECT life,alive,generation,corpse FROM inventory_characters WHERE principal=?1",
        [principal],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let generation = u64::try_from(generation)?;
    if expected.is_some_and(|g| g != generation) {
        return Ok(json!({"status":"conflict","generation":generation}));
    }
    let mut query = tx.prepare("SELECT i.id,i.revision,i.section,i.state,i.place FROM inventory_items i JOIN item_containers c ON c.id=i.container WHERE c.owner=?1 AND c.kind='carried' AND i.id>?2 ORDER BY i.id LIMIT 101")?;
    let mut items = Vec::new();
    let mut bytes = 0usize;
    let mut more = false;
    for row in query.query_map(params![principal, after], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })? {
        let (id, revision, section, state, place) = row?;
        let item = json!({"id":id,"revision":revision,"section":section,"state":presented_state(&state)?,"place":place});
        let size = serde_json::to_vec(&item)?.len();
        if items.len() == 100 || bytes + size > 12000 {
            more = true;
            break;
        }
        bytes += size;
        items.push(item);
    }
    let cursor = if more {
        items.last().map(|v| v["id"].clone())
    } else {
        None
    };
    Ok(
        json!({"life":life,"alive":alive,"generation":generation,"corpse":corpse,"items":items,"nextCursor":cursor}),
    )
}

/// Public loose items only. Corpse/private contents require a separate close-range
/// search. Each page uses fresh server position; pickups always revalidate range.
/// Traversal is eventually consistent under concurrent moves, not an ownership
/// snapshot. A subsequent scan discovers any insertion before the cursor.
pub(crate) fn world_items(
    tx: &Transaction<'_>,
    principal: &str,
    after: &str,
    context: &Context,
    rules: Option<&SurvivalRules>,
    catalog: Option<&crate::catalog::Catalog>,
    detector_scan: &DetectorScan,
) -> Result<Value> {
    if !authorized(tx, principal, context)? {
        return Ok(json!({"error":"invalid discovery authority"}));
    }
    let (life,alive):(u32,bool)=tx.query_row("SELECT life,alive FROM inventory_characters WHERE principal=?1",[principal],|r|Ok((r.get(0)?,r.get(1)?)))?;
    if !alive || life!=context.life {return Ok(json!({"error":"stale or dead discovery life"}));}
    const RADIUS:f64=32.0;
    let [x,y,z]=context.position;
    let now=crate::survival_rules::unix_millis()?;
    let detector = match catalog {
        Some(catalog) if after.is_empty() => crate::artefact::scan(tx, context, catalog, now, detector_scan)?,
        _ => None,
    };
    let mut query=tx.prepare_cached("SELECT i.id,i.revision,i.section,i.state,c.id,c.x,c.y,c.z
        FROM item_containers c JOIN inventory_items i ON i.container=c.id
        WHERE c.kind='world' AND c.world=?1 AND i.id>?2 AND (c.expires_at_ms IS NULL OR c.expires_at_ms>?3)
        AND c.x BETWEEN ?4-32 AND ?4+32 AND c.y BETWEEN ?5-32 AND ?5+32 AND c.z BETWEEN ?6-32 AND ?6+32
        AND (c.x-?4)*(c.x-?4)+(c.y-?5)*(c.y-?5)+(c.z-?6)*(c.z-?6)<=?7
        AND (NOT EXISTS(SELECT 1 FROM authored_artefact_slots s WHERE s.container=c.id)
            OR EXISTS(SELECT 1 FROM artefact_reveals r WHERE r.principal=?8 AND r.item=i.id
                AND r.life=?9 AND r.visit=?10 AND r.visible_until_ms>?3)) ORDER BY i.id LIMIT 33")?;
    let mut items=Vec::new();let mut bytes=0;let mut more=false;
    for row in query.query_map(params![context.world,after,now,x,y,z,RADIUS*RADIUS,principal,life,context.visit],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,[r.get::<_,f64>(5)?,r.get::<_,f64>(6)?,r.get::<_,f64>(7)?])))? {
        let (id,revision,section,state,source,position)=row?;
        let item=json!({"id":id,"revision":revision,"section":section,"state":presented_state(&state)?,"source":source,"position":position});
        let size=serde_json::to_vec(&item)?.len();
        if items.len()==32 || bytes+size>12000 {more=true;break;}
        bytes+=size;items.push(item);
    }
    let cursor=if more {items.last().map(|v|v["id"].clone())}else{None};
    let mut page = json!({"life":life,"items":items,"nextCursor":cursor});
    if let Some(detector) = detector { page["detector"] = detector; }
    if after.is_empty() && let Some(station) = storage_station(context, rules)
        && distance_squared(station.position, context.position) <= RADIUS * RADIUS
    {
        page["storage"] = json!({
            "id": personal_container(tx, principal, "storage")?,
            "position": station.position,
            "rotation": station.rotation
        });
    }
    Ok(page)
}

pub(crate) fn alive_context(tx:&Transaction<'_>,principal:&str,context:&Context)->Result<bool>{
    if !authorized(tx,principal,context)? {return Ok(false);}
    Ok(tx.query_row("SELECT alive AND life=?2 FROM inventory_characters WHERE principal=?1",params![principal,context.life],|r|r.get::<_,bool>(0))?)
}
pub(crate) fn corpses(tx:&Transaction<'_>,principal:&str,after:&str,context:&Context)->Result<Value>{
    if !alive_context(tx,principal,context)? {return Ok(json!({"error":"live corpse discovery authority required"}));}
    let [x,y,z]=context.position;let now=crate::survival_rules::unix_millis()?;
    let mut query=tx.prepare("SELECT id,x,y,z FROM item_containers WHERE kind='corpse' AND world=?1 AND id>?2 AND (expires_at_ms IS NULL OR expires_at_ms>?3) AND x BETWEEN ?4-32 AND ?4+32 AND y BETWEEN ?5-32 AND ?5+32 AND z BETWEEN ?6-32 AND ?6+32 AND (x-?4)*(x-?4)+(y-?5)*(y-?5)+(z-?6)*(z-?6)<=1024 ORDER BY id LIMIT 33")?;
    let mut containers=Vec::new();let mut more=false;
    for row in query.query_map(params![context.world,after,now,x,y,z],|r|Ok((r.get::<_,String>(0)?,[r.get::<_,f64>(1)?,r.get::<_,f64>(2)?,r.get::<_,f64>(3)?])))? {
        if containers.len()==32 {more=true;break;}
        let (id,position)=row?;containers.push(json!({"id":id,"position":position}));
    }
    let cursor=if more {containers.last().map(|c|c["id"].clone())}else{None};
    Ok(json!({"life":context.life,"containers":containers,"nextCursor":cursor}))
}
pub(crate) fn container_items(
    tx: &Transaction<'_>,
    principal: &str,
    source: &str,
    after: &str,
    expected: Option<u64>,
    context: &Context,
    rules: Option<&SurvivalRules>,
) -> Result<Value> {
    if !alive_context(tx, principal, context)? {
        return Ok(json!({"error":"live container search authority required"}));
    }
    // Check access on every page before exposing contents or their generation.
    let generation: Option<i64> = if source == personal_container(tx, principal, "storage")? {
        if !storage_near(context, rules)? {
            return Ok(json!({"error":"storage unavailable"}));
        }
        Some(tx.query_row("SELECT generation FROM item_containers WHERE id=?1", [source], |r| r.get(0))?)
    } else {
        if !nearby(tx, source, context)? {
            return Ok(json!({"error":"corpse unavailable"}));
        }
        tx.query_row("SELECT generation FROM item_containers WHERE id=?1 AND kind='corpse'", [source], |r| r.get(0)).optional()?
    };
    let Some(generation) = generation else {
        return Ok(json!({"error":"corpse unavailable"}));
    };
    let generation=u64::try_from(generation)?;
    if expected.is_some_and(|g|g!=generation){return Ok(json!({"status":"conflict","generation":generation}));}
    let mut query=tx.prepare("SELECT id,revision,section,state FROM inventory_items WHERE container=?1 AND id>?2 ORDER BY id LIMIT 33")?;
    let mut items=Vec::new();let mut bytes=0;let mut more=false;
    for row in query.query_map(params![source,after],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u32>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?)))? {
        let (id,revision,section,state)=row?;
        let item=json!({"id":id,"revision":revision,"section":section,"state":presented_state(&state)?,"place":"rucksack"});
        let size=serde_json::to_vec(&item)?.len();
        if items.len()==32 || bytes+size>12000 {more=true;break;}
        bytes+=size;items.push(item);
    }
    let cursor=if more {items.last().map(|i|i["id"].clone())}else{None};
    Ok(json!({"source":source,"life":context.life,"generation":generation,"items":items,"nextCursor":cursor}))
}

fn authorized(tx: &Transaction<'_>, principal: &str, context: &Context) -> Result<bool> {
    let epoch: i64 = tx.query_row("SELECT auth_epoch FROM runtime_meta WHERE id=1", [], |r| {
        r.get(0)
    })?;
    Ok(context.principal == principal
        && context.expires > Instant::now()
        && context.auth_epoch == u64::try_from(epoch)?
        && section_valid(&context.world)
        && context.position.iter().all(|v| v.is_finite())
        && context.interaction_radius.is_finite()
        && context.interaction_radius > 0.0
        && context.eye_height.is_finite() && (0.1..=2.0).contains(&context.eye_height)
        && crate::session::campaign_level(&context.world).is_none_or(|level|
            context.collision.as_ref().is_some_and(|map| map.manifest.level == level)))
}
fn nearby(tx: &Transaction<'_>, container: &str, context: &Context) -> Result<bool> {
    let location: Option<(String, f64, f64, f64)> = tx
        .query_row(
            "SELECT world,x,y,z FROM item_containers WHERE id=?1 AND kind IN('world','corpse') AND (expires_at_ms IS NULL OR expires_at_ms>?2)",
            params![container, crate::survival_rules::unix_millis()?],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((world,x,y,z))=location else {return Ok(false)};
    if world != context.world {
        return Ok(false);
    }
    interaction_near(context, [x, y, z], 0.05)
}

fn storage_station<'a>(context: &Context, rules: Option<&'a SurvivalRules>) -> Option<&'a StorageStation> {
    rules?.private_storage.as_ref().filter(|station| station.world == context.world)
}

fn storage_near(context: &Context, rules: Option<&SurvivalRules>) -> Result<bool> {
    match storage_station(context, rules) {
        Some(station) => interaction_near(context, station.position, 0.55),
        None => Ok(false),
    }
}

fn distance_squared(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.into_iter().zip(b).map(|(a, b)| (a - b).powi(2)).sum()
}

pub(crate) fn interaction_near(context: &Context, position: [f64; 3], target_height: f32) -> Result<bool> {
    if distance_squared(position, context.position) > context.interaction_radius.powi(2) {
        return Ok(false);
    }
    if let Some(map)=&context.collision {
        let [x,y,z] = position;
        use parry3d::math::Vector;
        let origin=Vector::new(context.position[0] as f32,context.position[1] as f32+context.eye_height,context.position[2] as f32);
        // Target the exposed part of the object above the floor or shelf.
        let target=Vector::new(x as f32,y as f32+target_height,z as f32);
        let delta=target-origin;let distance=delta.length();
        if !distance.is_finite(){return Ok(false);}
        if distance>0.02 && map.ray(origin,delta/distance,distance-0.01)?.is_some(){return Ok(false);}
    }
    Ok(true)
}
fn move_replay(tx: &Transaction<'_>, principal: &str, command: &Move, request: &str) -> Result<Option<Value>> {
    let prior: Option<(String, String)> = tx.query_row(
        "SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2",
        params![principal, command.request_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    prior.map(|(original, response)| Ok(if original == request {
        serde_json::from_str(&response)?
    } else {
        json!({"error":"request id reused with different payload"})
    })).transpose()
}

pub(crate) fn timed_reload(
    tx: &Transaction<'_>, context: &Context, command: &Move,
    catalog: &crate::catalog::Catalog, rules: Option<&SurvivalRules>,
    timings: Option<&crate::reload_timing::ReloadTimings>,
    native_rules: Option<&crate::combat::NativeWeaponRules>,
) -> Result<Value> {
    use crate::reload_timing::{ReloadCue, ReloadMotion, ReloadPlan};
    command.validate()?;
    ensure!(matches!(command.action, MoveAction::Reload | MoveAction::NextAmmo), "expected reload action");
    let principal = &context.principal;
    let request = format!("inventory-move-v1\n{}", serde_json::to_string(command)?);
    if let Some(response) = move_replay(tx, principal, command, &request)? {
        return Ok(response);
    }
    if !authorized(tx, principal, context)? {
        return Ok(json!({"error":"live inventory authorization required"}));
    }
    let carry = personal_container(tx, principal, "carried")?;
    let slot = active_weapon_slot(tx, principal)?;
    let drawn: Option<(String, String)> = tx.query_row(
        "SELECT section,state FROM inventory_items WHERE id=?1 AND container=?2 AND place=?3",
        params![command.item, carry, format!("slot:{slot}")],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((weapon, raw)) = drawn.filter(|_| matches!(slot, 2 | 3)) else {
        return Ok(json!({"status":"rejected","reason":"weapon_not_drawn"}));
    };
    let before: ItemState = serde_json::from_str(&raw)?;
    let reload = native_rules.filter(|native| native.matches_config(&command.item, &weapon, &before))
        .map(|native| &native.reload);
    let transfer = || move_item_with_reload(tx, principal, command, context, Some(catalog), rules, None, reload);
    let Some(timings) = timings else {
        return transfer();
    };

    // Run the same move validation and ammo selection as the eventual commit.
    // Neither the proposed magazine nor its request outcome leaves this savepoint.
    tx.execute_batch("SAVEPOINT reload_preview")?;
    let preview = (|| -> Result<_> {
        let result = transfer()?;
        let after = if result["status"] == "committed" {
            let raw: String = tx.query_row("SELECT state FROM inventory_items WHERE id=?1",
                [&command.item], |row| row.get(0))?;
            Some(serde_json::from_str::<ItemState>(&raw)?)
        } else { None };
        Ok((result, after))
    })();
    tx.execute_batch("ROLLBACK TO reload_preview; RELEASE reload_preview")?;
    let (result, after) = preview?;
    let Some(after) = after else { return Ok(result); };
    let ItemPayload::Weapon { cartridges, launcher_mode, jammed, .. } = &before.payload else {
        anyhow::bail!("reload preview accepted a nonweapon");
    };
    let section = catalog.section(&weapon)?;
    let outfit: Option<String> = tx.query_row(
        "SELECT section FROM inventory_items WHERE container=?1 AND place='slot:7'",
        [&carry], |row| row.get(0),
    ).optional()?;
    let actor = outfit.as_deref().and_then(|outfit| catalog.section(outfit).ok())
        .and_then(|section| section.values.get("player_hud_section"))
        .map_or("actor_hud", String::as_str);
    use crate::reload_timing::ReloadSound;
    let cue = |phase, sound| {
        let (alias, milliseconds) = timings.motion(&weapon, actor, phase)?;
        Ok::<_, anyhow::Error>(ReloadCue { alias: alias.to_owned(), milliseconds, sound })
    };
    let plan = if *launcher_mode {
        ReloadPlan { open: None, apply: cue(ReloadMotion::Launcher, ReloadSound::Launcher)?, close: None }
    } else if reload.map_or_else(|| section.boolean("tri_state_reload", false), |rules| Ok(rules.incremental))? {
        ReloadPlan { open: Some(cue(ReloadMotion::Open, ReloadSound::Open)?),
            apply: cue(ReloadMotion::Insert, ReloadSound::Insert)?,
            close: Some(cue(ReloadMotion::Close, ReloadSound::Close)?) }
    } else {
        let (motion, sound) = if section.text("class")? == "WP_BM16" {
            let ItemPayload::Weapon { cartridges: new, .. } = &after.payload else { unreachable!() };
            let replaced = cartridges.last().zip(new.last()).is_some_and(|(old, new)| old != new);
            (ReloadMotion::BreakAction { two: replaced || cartridges.is_empty() && new.len() >= 2 },
                if cartridges.len() == 1 { ReloadSound::OneShell } else { ReloadSound::Magazine })
        } else {
            let empty = cartridges.is_empty();
            let sound = if *jammed { ReloadSound::Misfire } else if empty { ReloadSound::Empty } else { ReloadSound::Magazine };
            (ReloadMotion::Magazine { empty, jammed: *jammed,
                launcher_attached: catalog.launcher_available(&weapon, &before)? }, sound)
        };
        ReloadPlan { open: None, apply: cue(motion, sound)?, close: None }
    };
    Ok(json!({"plan":plan,"slot":slot}))
}

pub(crate) fn move_item(
    tx: &Transaction<'_>,
    principal: &str,
    command: &Move,
    context: &Context,
    catalog: Option<&crate::catalog::Catalog>,
    rules: Option<&crate::survival_rules::SurvivalRules>,
    treatment: Option<crate::survival::Record>,
) -> Result<Value> {
    move_item_with_reload(tx, principal, command, context, catalog, rules, treatment.map(Treatment::Legacy), None)
}

enum Treatment {
    Legacy(crate::survival::Record),
    Native(crate::native_condition::Consumption),
}

pub(crate) fn prepare_native_consumption(tx:&Transaction<'_>,context:&Context,command:&Move,
    catalog:&crate::catalog::Catalog)->Result<Value> {
    command.validate()?;
    ensure!(matches!(command.action,MoveAction::Consume),"expected consumption");
    let request=format!("inventory-move-v1\n{}",serde_json::to_string(command)?);
    if let Some(value)=move_replay(tx,&context.principal,command,&request)? {return Ok(value);}
    if !authorized(tx,&context.principal,context)? || command.life!=context.life {
        return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"}));
    }
    let row:Option<(String,u32,String,i64)>=tx.query_row("SELECT i.section,i.revision,i.state,a.generation
        FROM inventory_items i JOIN item_containers c ON c.id=i.container
        JOIN inventory_characters a ON a.principal=c.owner
        WHERE i.id=?1 AND c.owner=?2 AND c.kind='carried' AND a.life=?3 AND a.alive=1",
        params![command.item,context.principal,command.life],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((section,revision,raw,generation))=row else {return Ok(json!({"status":"rejected","reason":"unavailable"}));};
    if revision!=command.revision {return Ok(json!({"status":"conflict","revision":revision}));}
    let (definition,kind)=catalog.item(&section)?;
    if kind!=crate::catalog::Kind::Consumable {
        return Ok(json!({"status":"rejected","reason":"not_consumable"}));
    }
    if section.is_empty() || section.len()>128 || !section.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'_')
        || ["eat_health","eat_power","eat_satiety","eat_radiation","wounds_heal_perc"].iter().any(|key|!definition.values.contains_key(*key))
        || (definition.values.keys().any(|key|key.starts_with("boost_")&&key!="boost_time") && !definition.values.contains_key("boost_time")) {
        return Ok(json!({"status":"rejected","reason":"unsupported_consumable"}));
    }
    catalog.validate_state(&section,&serde_json::from_str::<ItemState>(&raw)?)?;
    Ok(json!({"status":"prepared","section":section,"generation":generation}))
}

pub(crate) fn consume_native(
    tx: &Transaction<'_>, context: &Context, command: &Move,
    catalog: Option<&crate::catalog::Catalog>, rules: Option<&SurvivalRules>,
    proposal: crate::native_condition::Consumption,
) -> Result<Value> {
    ensure!(matches!(command.action, MoveAction::Consume), "expected consume action");
    move_item_with_reload(tx, &context.principal, command, context, catalog, rules,
        Some(Treatment::Native(proposal)), None)
}

fn move_item_with_reload(
    tx: &Transaction<'_>,
    principal: &str,
    command: &Move,
    context: &Context,
    catalog: Option<&crate::catalog::Catalog>,
    rules: Option<&crate::survival_rules::SurvivalRules>,
    treatment: Option<Treatment>,
    reload: Option<&crate::alife_weapon::ReloadRules>,
) -> Result<Value> {
    command.validate()?;
    let request = format!("inventory-move-v1\n{}", serde_json::to_string(command)?);
    if let Some(response) = move_replay(tx, principal, command, &request)? {
        return Ok(response);
    }
    // Expired authority is transient; a retry with fresh simulation context may
    // proceed. Committed outcomes above remain recoverable after movement/death.
    if !authorized(tx, principal, context)? {
        return Ok(json!({"error":"live inventory authorization required"}));
    }
    let count: u32 = tx.query_row(
        "SELECT count(*) FROM outcomes WHERE principal=?1",
        [principal],
        |r| r.get(0),
    )?;
    if count >= 10000 {
        return Ok(json!({"error":"request ledger full"}));
    }
    let (life, alive): (u32, bool) = tx.query_row(
        "SELECT life,alive FROM inventory_characters WHERE principal=?1",
        [principal],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let item: Option<(String, u32, String, String)> = tx
        .query_row(
            "SELECT container,revision,section,place FROM inventory_items WHERE id=?1",
            [&command.item],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let carry = personal_container(tx, principal, "carried")?;
    let mut response = json!({"status":"rejected","reason":"unavailable"});
    if !alive || life != command.life || life != context.life {
        response = json!({"status":"rejected","reason":"stale_or_dead_life"});
    } else if let Some((source, revision, section, old_place)) = item {
        let allowed = match &command.action {
            MoveAction::Pickup { source: expected } => {
                source == *expected && if source == personal_container(tx, principal, "storage")? {
                    storage_near(context, rules)?
                } else {
                    nearby(tx, &source, context)? && crate::artefact::can_pick_up(
                        tx, context, &source, &command.item, crate::survival_rules::unix_millis()?,
                    )?
                }
            }
            MoveAction::Store { destination } => {
                source == carry
                    && *destination == personal_container(tx, principal, "storage")?
                    && storage_near(context, rules)?
            }
            MoveAction::Drop | MoveAction::Consume | MoveAction::Reload | MoveAction::Unload | MoveAction::NextAmmo | MoveAction::FireMode { .. } | MoveAction::LauncherMode { .. } | MoveAction::Attach { .. } | MoveAction::Detach { .. } | MoveAction::Place { .. } => source == carry,
        };
        // Check visibility/ownership before revealing revision information.
        if allowed {
            response = if revision != command.revision {
                json!({"status":"conflict","revision":revision})
            } else if let Some(next) = revision.checked_add(1) {
                if matches!(command.action, MoveAction::Consume) {
                    response = consume_item(tx, principal, command, catalog, rules, treatment)?;
                    tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
                        params![principal, command.request_id, request, serde_json::to_string(&response)?])?;
                    return Ok(response);
                }
                if let MoveAction::Place { placement } = &command.action {
                    let Some(catalog) = catalog else {
                        return Ok(json!({"error":"item catalog unavailable"}));
                    };
                    response = match crate::equipment::place(
                        tx,
                        &carry,
                        &command.item,
                        placement,
                        catalog,
                    )? {
                        None => {
                            json!({"status":"committed","item":command.item,"revision":next,"container":carry,"place":placement.key()})
                        }
                        Some(reason) => json!({"status":"rejected","reason":reason}),
                    };
                    tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",params![principal,command.request_id,request,serde_json::to_string(&response)?])?;
                    return Ok(response);
                }
                if matches!(command.action, MoveAction::Reload | MoveAction::Unload | MoveAction::NextAmmo | MoveAction::FireMode { .. } | MoveAction::LauncherMode { .. } | MoveAction::Attach { .. } | MoveAction::Detach { .. }) {
                    let Some(catalog) = catalog else {
                        return Ok(json!({"error":"item catalog unavailable"}));
                    };
                    let can_take_addon = |source: &str| {
                        if source == personal_container(tx, principal, "storage")? {
                            storage_near(context, rules)
                        } else {
                            nearby(tx, source, context)
                        }
                    };
                    response = match crate::weapon_inventory::change_weapon(tx, &carry, command, catalog, next, can_take_addon, reload)? {
                        None => json!({"status":"committed","item":command.item,"revision":next,"container":carry}),
                        Some(reason) => json!({"status":"rejected","reason":reason}),
                    };
                    tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
                        params![principal,command.request_id,request,serde_json::to_string(&response)?])?;
                    return Ok(response);
                }
                let destination = match &command.action {
                    MoveAction::Pickup { .. } => Some(carry.clone()),
                    MoveAction::Store { destination } => {
                        let catalog = catalog.context("storage requires item catalog")?;
                        let station = storage_station(context, rules).context("storage requires station")?;
                        let count: u32 = tx.query_row(
                            "SELECT count(*) FROM inventory_items WHERE container=?1",
                            [destination], |r| r.get(0),
                        )?;
                        if catalog.item(&section)?.0.boolean("quest_item", false)? {
                            response = json!({"status":"rejected","reason":"quest_item"});
                            None
                        } else if count >= station.max_items {
                            response = json!({"status":"rejected","reason":"storage_full"});
                            None
                        } else {
                            crate::equipment::removing(tx, &carry, &old_place)?;
                            Some(destination.clone())
                        }
                    }
                    MoveAction::Drop => {
                        crate::equipment::removing(tx, &carry, &old_place)?;
                        let container =
                            world_container(tx, "world", &context.world, context.position)?;
                        if let Some(rules) = rules {
                            set_expiry(tx, &container, rules.dropped_item_lifetime_seconds)?;
                        }
                        Some(container)
                    }
                    MoveAction::Place { .. } | MoveAction::Consume | MoveAction::Reload | MoveAction::Unload | MoveAction::NextAmmo | MoveAction::FireMode { .. } | MoveAction::LauncherMode { .. } | MoveAction::Attach { .. } | MoveAction::Detach { .. } => unreachable!(),
                };
                if let Some(destination) = destination {
                    let changed = tx.execute("UPDATE inventory_items SET container=?1,revision=?2,place='rucksack' WHERE id=?3 AND container=?4 AND revision=?5", params![destination,next,command.item,source,revision])?;
                    ensure!(changed == 1, "inventory transaction lost ownership");
                    if matches!(command.action, MoveAction::Pickup { .. }) && let Some(rules) = rules {
                        let now = crate::survival_rules::unix_millis()?;
                        crate::loot::record_pickup(tx, &source, rules, now)?;
                        crate::artefact::picked_up(tx, &source, &command.item, crate::loot::deadline(now, rules))?;
                    }
                    response = json!({"status":"committed","item":command.item,"revision":next,"container":destination});
                }
                response
            } else {
                json!({"status":"rejected","reason":"revision_exhausted"})
            };
        }
    }
    tx.execute(
        "INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
        params![
            principal,
            command.request_id,
            request,
            serde_json::to_string(&response)?
        ],
    )?;
    Ok(response)
}

fn consume_item(
    tx: &Transaction<'_>,
    principal: &str,
    command: &Move,
    catalog: Option<&crate::catalog::Catalog>,
    rules: Option<&SurvivalRules>,
    treatment: Option<Treatment>,
) -> Result<Value> {
    let Some(treatment) = treatment else { return Ok(json!({"error":"live treatment state required"})); };
    let (mut record, native) = match treatment {
        Treatment::Legacy(record) => (record, None),
        Treatment::Native(proposal) => (proposal.before.clone(), Some(proposal)),
    };
    let catalog = catalog.context("consumption requires the item catalog")?;
    let rules = rules.context("consumption requires survival rules")?;
    let reject = |reason| Ok(json!({"status":"rejected","reason":reason}));
    if record.state.health <= 0.0 { return reject("stale_or_dead_life"); }
    let (section, raw): (String, String) = tx.query_row(
        "SELECT section,state FROM inventory_items WHERE id=?1", [&command.item],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let (definition, kind) = catalog.item(&section)?;
    let mut item: ItemState = serde_json::from_str(&raw)?;
    if kind != crate::catalog::Kind::Consumable {
        return reject("not_consumable");
    }
    catalog.validate_state(&section, &item)?;
    let wound_heal = if let Some(proposal) = native {
        let generation: i64 = tx.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",
            [principal], |row| row.get(0))?;
        if proposal.section != section || u64::try_from(generation).ok() != Some(proposal.equipment) {
            return reject("stale_native_consumption");
        }
        record.state.install_native_checkpoint(proposal.checkpoint)?;
        // Hydration is custom server policy; native code owns every stock effect.
        let hydration = rules.hydration_sources.get(&section).copied().unwrap_or(0.0);
        record.state.thirst = (record.state.thirst + hydration).clamp(0.0, 1.0);
        0.0 // Full native wounds already live in the checkpoint; no second heal.
    } else {
        if record.state.native_checkpoint().is_some() {
            return reject("native_consumption_required");
        }
        let Some(dose) = crate::survival::Dose::from_catalog(&section, definition, rules)? else {
            return reject("unsupported_consumable");
        };
        let wound_heal = dose.immediate_wound_heal();
        if !record.state.dose(dose) { return reject("medicine_in_progress"); }
        wound_heal
    };

    let previous = record.revision;
    record.revision = previous.checked_add(1).context("condition revision exhausted")?;
    if tx.execute("UPDATE inventory_characters SET condition=?1,condition_revision=?2
        WHERE principal=?3 AND alive=1 AND life=?4 AND condition_revision=?5",
        params![serde_json::to_string(&record.state)?, record.revision, principal, command.life, previous])? != 1 {
        return Ok(json!({"error":"condition revision changed"}));
    }
    let ItemPayload::Consumable { uses } = &mut item.payload else { unreachable!() };
    // CoP reserves 255 for unlimited portions.
    if *uses != 255 {
        *uses -= 1;
    }
    let remaining = *uses;
    if remaining == 0 {
        tx.execute("DELETE FROM inventory_items WHERE id=?1", [&command.item])?;
    } else {
        tx.execute("UPDATE inventory_items SET revision=revision+1,state=?1 WHERE id=?2",
            params![serde_json::to_string(&item)?, command.item])?;
    }
    Ok(json!({"status":"committed","item":command.item,"revision":command.revision+1,
        "remaining":remaining,"life":command.life,"condition":record,
        "condition_wound_heal":wound_heal}))
}

pub(crate) fn active_weapon_slot(tx: &Transaction<'_>, principal: &str) -> Result<u8> {
    // NULL is the existing primary-then-pistol default. Zero is an explicit holster.
    Ok(tx.prepare_cached("SELECT CAST(substr(i.place,6) AS INTEGER) FROM inventory_items i
        JOIN item_containers c ON c.id=i.container JOIN inventory_characters a ON a.principal=c.owner
        WHERE a.principal=?1 AND a.alive=1 AND c.kind='carried' AND (
            (a.grenade_drawn=1 AND i.place='slot:4') OR
            (i.place IN('slot:1','slot:2','slot:3','slot:6') AND (i.place='slot:'||a.active_weapon_slot
                OR a.active_weapon_slot IS NULL AND i.place IN('slot:2','slot:3'))))
        ORDER BY i.place='slot:4' DESC, i.place DESC LIMIT 1")?.query_row([principal], |row| row.get(0)).optional()?.unwrap_or(0))
}

pub(crate) fn select_weapon(tx: &Transaction<'_>, context: &Context, life: u32, slot: u8, catalog: &crate::catalog::Catalog) -> Result<Value> {
    if life != context.life { return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"})); }
    if slot == 4 {
        let alive: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM inventory_characters WHERE principal=?1 AND life=?2 AND alive=1)",
            params![context.principal, life], |row| row.get(0))?;
        if !alive { return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"})); }
        let carry = personal_container(tx, &context.principal, "carried")?;
        let equipped: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM inventory_items WHERE container=?1 AND place='slot:4')",
            [&carry], |row| row.get(0))?;
        if !equipped && !crate::hand_grenade::slot_next(tx, catalog, &carry, "")? {
            return Ok(json!({"status":"rejected","reason":"weapon_slot_unavailable"}));
        }
        tx.execute("UPDATE inventory_characters SET grenade_drawn=1 WHERE principal=?1", [&context.principal])?;
        return Ok(json!({"status":"selected","slot":slot}));
    }
    let changed = tx.execute("UPDATE inventory_characters SET active_weapon_slot=?1,grenade_drawn=0
        WHERE principal=?2 AND life=?3 AND alive=1 AND (?1=0 OR EXISTS(
            SELECT 1 FROM inventory_items i JOIN item_containers c ON c.id=i.container
            WHERE c.owner=?2 AND c.kind='carried' AND i.place='slot:'||?1))",
        params![slot, context.principal, life])?;
    Ok(if changed == 1 { json!({"status":"selected","slot":slot}) }
        else { json!({"status":"rejected","reason":"weapon_slot_unavailable"}) })
}

fn allows_sprint(catalog: &crate::catalog::Catalog, section: &str, state: &ItemState) -> Result<bool> {
    Ok(match catalog.effective_text(section, state, "sprint_allowed")?.as_deref() {
        None | Some("true" | "on" | "1" | "yes") => true,
        Some("false" | "off" | "0" | "no") => false,
        _ => anyhow::bail!("invalid item sprint setting"),
    })
}

/// Recompute after a carried-item transaction. Movement ticks use this snapshot.
pub(crate) fn carried_equipment(tx: &Transaction<'_>, principal: &str, catalog: &crate::catalog::Catalog) -> Result<(crate::survival::Loadout, crate::lifecycle::Appearance)> {
    use crate::catalog::Kind;
    let carry = personal_container(tx, principal, "carried")?;
    let mut query = tx.prepare_cached("SELECT section,state,place,revision,id FROM inventory_items WHERE container=?1")?;
    let mut rows = query.query([carry])?;
    let mut result = crate::survival::Loadout { active_weapon_slot: active_weapon_slot(tx, principal)?, ..Default::default() };
    let mut appearance = crate::lifecycle::Appearance::default();
    let active_place = match result.active_weapon_slot { 1 => Some("slot:1"), 2 => Some("slot:2"), 3 => Some("slot:3"), 4 => Some("slot:4"), 6 => Some("slot:6"), _ => None };
    while let Some(row) = rows.next()? {
        let section: String = row.get(0)?;
        let state: ItemState = serde_json::from_str(&row.get::<_, String>(1)?)?;
        let place: String = row.get(2)?;
        let (definition, kind) = catalog.item(&section)?;
        result.mass += catalog.weight(&section, &state)?;
        result.fields.armour.add(catalog, &section, &state, &place)?;
        if Some(place.as_str()) == active_place {
            result.active_item_blocks_sprint = !allows_sprint(catalog, &section, &state)?;
            if kind == Kind::Weapon || matches!(place.as_str(), "slot:1" | "slot:4" | "slot:6") { appearance.weapon = Some(section.clone()); }
            if kind == Kind::Weapon || matches!(place.as_str(), "slot:1" | "slot:4") {
                let id: String = row.get(4)?;
                result.active_item = Some(u128::from_str_radix(&id, 16)?.to_le_bytes());
            }
            if kind == Kind::Weapon {
                result.ballistics = crate::weapon_inventory::round_profile(catalog, &section, &state, row.get(3)?)?;
                if let ItemPayload::Weapon { attachments, .. } = &state.payload {
                    let (mask, _) = catalog.equipped_addons(&section, &state, attachments)?;
                    appearance.weapon_addons = (mask != 0).then_some(mask);
                }
                if definition.boolean("zoom_enabled", false)?
                    && let ItemPayload::Weapon { launcher_mode, .. } = &state.payload
                {
                    let seconds = catalog.effective_number(&section, &state, "zoom_rotate_time", 0.25)?;
                    let raise_ticks = (seconds * f64::from(crate::world::TICK_HZ)).ceil() as u16;
                    result.aim = Some(crate::survival::AimProfile {
                        weapon: result.active_item.context("missing active weapon identity")?,
                        raise_ticks,
                        launcher: *launcher_mode,
                    });
                }
            }
        }
        if kind == Kind::Outfit && place == "slot:7" {
            appearance.outfit = Some(section.clone());
            result.capacity_bonus += catalog.effective_number(&section, &state, "additional_inventory_weight", 0.0)?;
            result.power_loss = catalog.effective_number(&section, &state, "power_loss", 1.0)?;
            result.outfit_allows_sprint = allows_sprint(catalog, &section, &state)?;
            result.restoration.add(catalog, &section, &state, 1.0)?;
        } else if kind == Kind::Helmet && place == "slot:12" {
            appearance.helmet = Some(section.clone());
        } else if kind == Kind::Artefact && place.starts_with("belt:") {
            result.capacity_bonus += catalog.effective_number(&section, &state, "additional_inventory_weight", 0.0)?
                * f64::from(state.condition);
            result.restoration.add(catalog, &section, &state, state.condition)?;
            result.fields.add_artefact(catalog, definition)?;
        }
    }
    result.fields.armour.stamp(tx, principal)?;
    ensure!(result.mass.is_finite() && result.capacity_bonus.is_finite() && result.power_loss >= 0.0
        && result.power_loss.is_finite(), "invalid carried load");
    Ok((result, appearance))
}

/// Only the authoritative simulation may request death. Life number is the
/// idempotency key, independent of client request IDs and their bounded ledger.
pub(crate) fn die(
    tx: &Transaction<'_>,
    principal: &str,
    context: &Context,
    rules: Option<&crate::survival_rules::SurvivalRules>,
) -> Result<Value> {
    if !authorized(tx, principal, context)? {
        return Ok(json!({"error":"live inventory authorization required"}));
    }
    let (life, alive, corpse): (u32, bool, Option<String>) = tx.query_row(
        "SELECT life,alive,corpse FROM inventory_characters WHERE principal=?1",
        [principal],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if life != context.life {
        return Ok(json!({"status":"rejected","reason":"stale_life"}));
    }
    if !alive {
        return Ok(json!({"status":"committed","life":life,"corpse":corpse}));
    }
    let carry = personal_container(tx, principal, "carried")?;
    let corpse = world_container(tx, "corpse", &context.world, context.position)?;
    if let Some(rules) = rules {
        set_expiry(tx, &corpse, rules.corpse_lifetime_seconds)?;
    }
    // One UPDATE moves rucksack, every slot and belt together. State is untouched.
    // Revision overflow aborts/rolls back the entire transaction, including corpse.
    tx.execute("UPDATE inventory_items SET container=?1,place='rucksack',revision=revision+1 WHERE container=?2", params![corpse,carry])?;
    tx.execute("UPDATE inventory_characters SET alive=0,corpse=?1,generation=generation+1,dead_at_ms=?3,location=NULL,active_weapon_slot=0,grenade_drawn=0 WHERE principal=?2", params![corpse,principal,crate::survival_rules::unix_millis()?])?;
    Ok(json!({"status":"committed","life":life,"corpse":corpse}))
}

pub(crate) fn set_expiry(tx: &Transaction<'_>, container: &str, seconds: u32) -> Result<()> {
    tx.execute(
        "UPDATE item_containers SET expires_at_ms=?1 WHERE id=?2",
        params![
            crate::survival_rules::unix_millis()? + i64::from(seconds) * 1000,
            container
        ],
    )?;
    Ok(())
}
pub(crate) fn respawn(
    tx: &Transaction<'_>,
    principal: &str,
    command:&Respawn,
    context: &Context,
    catalog: &crate::catalog::Catalog,
    rules: &crate::survival_rules::SurvivalRules,
) -> Result<Value> {
    crate::persistence::validate_request_id(&command.request_id)?;
    let request=format!("inventory-respawn-v1\n{}",serde_json::to_string(command)?);
    let prior:Option<(String,String)>=tx.query_row("SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2",params![principal,command.request_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    if let Some((original,response))=prior{return Ok(if original==request{serde_json::from_str(&response)?}else{json!({"error":"request id reused with different payload"})});}
    if !authorized(tx, principal, context)? {
        return Ok(json!({"error":"live inventory authorization required"}));
    }
    let count:u32=tx.query_row("SELECT count(*) FROM outcomes WHERE principal=?1",[principal],|r|r.get(0))?;
    if count>=10000{return Ok(json!({"error":"request ledger full"}));}
    let response=respawn_once(tx,principal,command,context,catalog,rules)?;
    tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",params![principal,command.request_id,request,serde_json::to_string(&response)?])?;
    Ok(response)
}
fn respawn_once(tx:&Transaction<'_>,principal:&str,command:&Respawn,context:&Context,catalog:&crate::catalog::Catalog,rules:&crate::survival_rules::SurvivalRules)->Result<Value>{
    let (life, alive, dead_at): (u32, bool, Option<i64>) = tx.query_row(
        "SELECT life,alive,dead_at_ms FROM inventory_characters WHERE principal=?1",
        [principal],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if alive || life != context.life || life!=command.life {
        return Ok(json!({"status":"rejected","reason":"alive_or_stale_life"}));
    }
    let ready = dead_at.context("dead character missing death time")?
        + i64::from(rules.respawn_delay_seconds) * 1000;
    if crate::survival_rules::unix_millis()? < ready {
        return Ok(json!({"status":"rejected","reason":"respawn_delay","readyAt":ready}));
    }
    let next = life.checked_add(1).context("life counter exhausted")?;
    tx.execute("UPDATE inventory_characters SET life=?1,alive=1,corpse=NULL,dead_at_ms=NULL,condition='{}',condition_revision=0,location=NULL,generation=generation+1,active_weapon_slot=NULL,grenade_drawn=0 WHERE principal=?2",params![next,principal])?;
    grant_starter(tx, principal, next, catalog, rules)?;
    Ok(json!({"status":"respawned","life":next,"alive":true}))
}
pub(crate) fn expire(tx: &Transaction<'_>, now: i64) -> Result<usize> {
    tx.execute("DELETE FROM artefact_reveals WHERE visible_until_ms<=?1", [now])?;
    let mut query=tx.prepare("SELECT id FROM item_containers WHERE expires_at_ms<=?1 AND kind IN('world','corpse') ORDER BY expires_at_ms LIMIT 100")?;
    let containers: Vec<String> = query
        .query_map([now], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in &containers {
        tx.execute(
            "UPDATE inventory_characters SET corpse=NULL,generation=generation+1 WHERE corpse=?1",
            [id],
        )?;
        tx.execute("DELETE FROM inventory_items WHERE container=?1", [id])?;
        tx.execute("DELETE FROM item_containers WHERE id=?1", [id])?;
    }
    Ok(containers.len())
}

#[cfg(test)]
mod visibility_tests {
    use super::*;
    use crate::persistence::{Database,Operation};
    use std::{path::Path,sync::Arc,time::Duration};
    #[test]
    fn pickup_checks_shared_static_geometry_before_transfer_and_fails_closed_without_it() {
        let mut db=Database::open(Path::new(":memory:")).unwrap();
        let secret="a".repeat(64);
        let principal=db.execute(&secret,Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let mut collision = crate::collision::tests::actor_fixture(0);
        collision.manifest.level = "jupiter".into();
        let mut context=Context{principal,life:0,visit:0,auth_epoch:0,world:"jupiter-static-v1".into(),position:[1.5,0.0,0.0],interaction_radius:2.0,eye_height:1.55,collision:Some(Arc::new(collision)),expires:Instant::now()+Duration::from_secs(30)};
        let container=db.provision_world_container(&context.world,[2.5,0.0,0.0]).unwrap();
        let item=db.provision_inventory_item(&container,"bandage",&ItemState{condition:1.0,upgrades:vec![],payload:ItemPayload::Consumable{uses:1}},"rucksack").unwrap();
        let command=|request:&str|Move{request_id:request.into(),life:0,item:item.clone(),revision:0,action:MoveAction::Pickup{source:container.clone()}};
        for (n,height) in [1.55,0.95].into_iter().enumerate(){
            context.eye_height=height;
            let result=db.execute(&secret,Operation::MoveInventory(command(&format!("wall-{n}")),context.clone())).unwrap();
            assert_eq!(result["status"],"rejected");assert_eq!(result["reason"],"unavailable");
        }
        // No geometry for a real-map session must not silently become a flat test.
        let mut missing=context.clone();missing.collision=None;
        let denied=db.execute(&secret,Operation::MoveInventory(command("missing-map"),missing)).unwrap();
        assert_ne!(denied["status"],"committed");
        let mut wrong = context.clone();
        wrong.world = "pripyat-static-v1".into();
        let denied = db.execute(&secret, Operation::MoveInventory(command("wrong-map"), wrong)).unwrap();
        assert_ne!(denied["status"], "committed");
        assert!(db.execute(&secret,Operation::ListInventory(String::new(),None)).unwrap()["items"].as_array().unwrap().is_empty());
        // On the same side of the wall, the floor endpoint remains reachable.
        context.position=[2.4,0.0,0.0];
        let result=db.execute(&secret,Operation::MoveInventory(command("reachable"),context.clone())).unwrap();
        assert_eq!(result["status"],"committed");assert_eq!(result["revision"],1);
        let items=db.execute(&secret,Operation::ListInventory(String::new(),None)).unwrap();
        assert_eq!(items["items"].as_array().unwrap().len(),1);assert_eq!(items["items"][0]["id"],item);
    }
}
