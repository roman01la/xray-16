use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use zone_server::{
    inventory::{Context, ItemPayload, ItemState, Move, MoveAction},
    persistence::{Database, Operation, Persistence},
};

fn secret(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}
fn register(db: &mut Database, c: char) -> String {
    db.execute(&secret(c), Operation::Register).unwrap()["principalId"]
        .as_str()
        .unwrap()
        .into()
}
fn context(principal: &str) -> Context {
    Context {
        principal: principal.into(),
        life: 0,
        visit: 0, auth_epoch: 0,
        world: "zaton".into(),
        position: [0.0, 0.0, 0.0],
        interaction_radius: 2.0,
        eye_height: 1.55,
        collision: None,
        expires: Instant::now() + Duration::from_secs(30),
    }
}
fn weapon() -> ItemState {
    ItemState {
        condition: 0.43,
        upgrades: vec!["up_firsta_ak74".into()],
        payload: ItemPayload::Weapon {
            cartridges: vec!["ammo_5.45x39_fmj".into(), "ammo_5.45x39_ap".into()],
            launcher_cartridges: vec!["ammo_vog-25".into()],
            selected_ammunition: "ammo_5.45x39_ap".into(),
            attachments: vec!["wpn_addon_scope".into()],
            attachment_items: vec![],
            fire_mode: 2,
            launcher_mode: false,
            jammed: true,
        },
    }
}
fn pickup(id: &str, revision: u32, source: &str, request: &str, ctx: &Context) -> Operation {
    Operation::MoveInventory(
        Move {
            request_id: request.into(),
            life: ctx.life,
            item: id.into(),
            revision,
            action: MoveAction::Pickup {
                source: source.into(),
            },
        },
        ctx.clone(),
    )
}
fn drop_item(id: &str, revision: u32, request: &str, ctx: &Context) -> Operation {
    Operation::MoveInventory(
        Move {
            request_id: request.into(),
            life: ctx.life,
            item: id.into(),
            revision,
            action: MoveAction::Drop,
        },
        ctx.clone(),
    )
}
fn list(db: &mut Database, c: char) -> Value {
    db.execute(&secret(c), Operation::ListInventory(String::new(), None))
        .unwrap()
}
struct FileDb(PathBuf);
impl FileDb {
    fn new() -> Self {
        static NEXT_DB: AtomicU64 = AtomicU64::new(0);
        Self(std::env::temp_dir().join(format!(
                "zone-inventory-{}-{}-{}.sqlite",
                std::process::id(),
                NEXT_DB.fetch_add(1, Ordering::Relaxed),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )))
    }
    fn connection(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(&self.0).unwrap()
    }
}
impl Drop for FileDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm", ".lock"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0.display()));
        }
    }
}

#[test]
fn pickup_drop_reloot_preserve_state_and_replay_after_restart() {
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let b = register(&mut db, 'b');
    let ca = context(&a);
    let cb = context(&b);
    let source = db
        .provision_world_container("zaton", [0.0, 0.0, 1.0])
        .unwrap();
    let item = db
        .provision_inventory_item(&source, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    let command = pickup(&item, 0, &source, "pick", &ca);
    let result = db.execute(&secret('a'), command.clone()).unwrap();
    assert_eq!(result["status"], "committed");
    assert_eq!(
        db.execute(&secret('b'), pickup(&item, 0, &source, "race", &cb))
            .unwrap()["status"],
        "rejected"
    );
    assert_eq!(list(&mut db, 'b')["items"], json!([]));
    assert_eq!(
        list(&mut db, 'a')["items"][0]["state"],
        serde_json::to_value(weapon()).unwrap()
    );
    assert_eq!(
        db.execute(&secret('a'), drop_item(&item, 0, "old", &ca))
            .unwrap()["status"],
        "conflict"
    );
    let dropped = db
        .execute(&secret('a'), drop_item(&item, 1, "drop", &ca))
        .unwrap();
    let source2 = dropped["container"].as_str().unwrap();
    assert_eq!(
        db.execute(&secret('b'), pickup(&item, 2, source2, "reloot", &cb))
            .unwrap()["status"],
        "committed"
    );
    drop(db);
    let mut db = Database::open(&file.0).unwrap();
    assert_eq!(db.execute(&secret('a'), command).unwrap(), result);
    assert_eq!(list(&mut db, 'a')["items"], json!([]));
    let b_items = list(&mut db, 'b');
    assert_eq!(b_items["items"][0]["revision"], 3);
    assert_eq!(
        b_items["items"][0]["state"],
        serde_json::to_value(weapon()).unwrap()
    );
    assert!(
        db.execute(&secret('a'), drop_item(&item, 3, "pick", &ca))
            .unwrap()
            .get("error")
            .is_some()
    );
}

#[test]
fn pickup_requires_live_identity_life_world_and_three_dimensional_reach() {
    let mut db = Database::open(Path::new(":memory:")).unwrap();
    let a = register(&mut db, 'a');
    let b = register(&mut db, 'b');
    let source = db
        .provision_world_container("zaton", [0.0, 5.0, 0.0])
        .unwrap();
    let item = db
        .provision_inventory_item(&source, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    let mut ca = context(&a);
    assert_eq!(
        db.execute(&secret('a'), pickup(&item, 0, &source, "height", &ca))
            .unwrap()["status"],
        "rejected"
    );
    ca.position[1] = 5.0;
    for (i, mut bad) in [
        context(&b),
        ca.clone(),
        ca.clone(),
        ca.clone(),
        ca.clone(),
        ca.clone(),
    ]
    .into_iter()
    .enumerate()
    {
        match i {
            1 => bad.expires = Instant::now(),
            2 => bad.auth_epoch = 1,
            3 => bad.position[0] = f64::NAN,
            4 => bad.world = "jupiter".into(),
            5 => bad.life = 1,
            _ => {}
        }
        let result = db
            .execute(
                &secret('a'),
                pickup(&item, 0, &source, &format!("bad{i}"), &bad),
            )
            .unwrap();
        assert_ne!(result["status"], "committed");
    }
    assert_eq!(
        db.execute(&secret('a'), pickup(&item, 0, &source, "valid", &ca))
            .unwrap()["status"],
        "committed"
    );
}

#[test]
fn death_moves_every_carried_placement_once_and_preserves_private_storage() {
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let b = register(&mut db, 'b');
    let ca = context(&a);
    let cb = context(&b);
    let containers = db.initialize_inventory(&a).unwrap();
    let carried = containers["carried"].as_str().unwrap();
    let storage = containers["storage"].as_str().unwrap();
    let equipment = ItemState {
        condition: 1.0,
        upgrades: vec![],
        payload: ItemPayload::Equipment,
    };
    let mut items = vec![];
    for (section, place) in [
        ("wpn_ak74", "slot:2"),
        ("device_pda", "slot:7"),
        ("bolt", "slot:5"),
        ("af_medusa", "belt:0"),
        ("stalker_outfit", "slot:6"),
        ("detector_simple", "rucksack"),
    ] {
        items.push(
            db.provision_inventory_item(carried, section, &equipment, place)
                .unwrap(),
        );
    }
    let stored = db
        .provision_inventory_item(storage, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    let death = db
        .execute(&secret('a'), Operation::InventoryDeath(ca.clone()))
        .unwrap();
    let corpse = death["corpse"].as_str().unwrap();
    assert_eq!(death["status"], "committed");
    assert_eq!(list(&mut db, 'a')["items"], json!([]));
    assert_eq!(list(&mut db, 'a')["alive"], false);
    let sql = file.connection();
    let count: i64 = sql
        .query_row(
            "SELECT count(*) FROM inventory_items WHERE container=?1",
            [corpse],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 6);
    let location: String = sql
        .query_row(
            "SELECT container FROM inventory_items WHERE id=?1",
            [stored],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(location, storage);
    assert_eq!(
        db.execute(&secret('a'), pickup(&items[0], 1, corpse, "dead", &ca))
            .unwrap()["reason"],
        "stale_or_dead_life"
    );
    assert_eq!(
        db.execute(
            &secret('b'),
            pickup(&items[0], 1, corpse, "loot-corpse", &cb)
        )
        .unwrap()["status"],
        "committed"
    );
    drop(sql);
    drop(db);
    let mut db = Database::open(&file.0).unwrap();
    db.initialize_inventory(&a).unwrap();
    assert_eq!(
        db.execute(&secret('a'), Operation::InventoryDeath(ca))
            .unwrap(),
        death
    );
    assert_eq!(list(&mut db, 'a')["alive"], false);
    assert_eq!(list(&mut db, 'b')["items"].as_array().unwrap().len(), 1);
}

#[test]
fn failed_death_rolls_back_every_item_and_corpse() {
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let containers = db.initialize_inventory(&a).unwrap();
    let carried = containers["carried"].as_str().unwrap();
    let id = db
        .provision_inventory_item(carried, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    db.provision_inventory_item(carried, "wpn_ak74", &weapon(), "slot:2")
        .unwrap();
    let sql = file.connection();
    sql.execute(
        "UPDATE inventory_items SET revision=4294967295 WHERE id=?1",
        [id],
    )
    .unwrap();
    assert!(
        db.execute(&secret('a'), Operation::InventoryDeath(context(&a)))
            .is_err()
    );
    let view = list(&mut db, 'a');
    assert_eq!(view["alive"], true);
    assert_eq!(view["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        sql.query_row(
            "SELECT count(*) FROM item_containers WHERE kind='corpse'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn two_clients_racing_through_persistence_worker_have_one_winner() {
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let b = register(&mut db, 'b');
    let source = db.provision_world_container("zaton", [0.0; 3]).unwrap();
    let item = db
        .provision_inventory_item(&source, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    drop(db);
    let store = Persistence::start(&file.0).unwrap();
    let (ra, rb) = tokio::join!(
        store.execute(
            secret('a'),
            pickup(&item, 0, &source, "race-a", &context(&a))
        ),
        store.execute(
            secret('b'),
            pickup(&item, 0, &source, "race-b", &context(&b))
        )
    );
    let results = [ra.unwrap(), rb.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|v| v["status"] == "committed")
            .count(),
        1
    );
    assert_eq!(
        results.iter().filter(|v| v["status"] == "rejected").count(),
        1
    );
    store.flush().await.unwrap();
    let sql = file.connection();
    assert_eq!(
        sql.query_row("SELECT count(*) FROM inventory_items", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(sql);
    drop(store);
    // Let the bounded worker release its exclusive database lock before cleanup.
    tokio::time::sleep(Duration::from_millis(120)).await;
}

#[tokio::test]
async fn native_corpse_inventory_is_owned_once_across_retries_and_restart() {
    use std::sync::Arc;
    use zone_server::{alife_checkpoint::Checkpoint, alife_corpse, catalog::Catalog, survival_rules::SurvivalRules};

    fn name(packet: &mut Vec<u8>, value: &str) {
        packet.push(value.len() as u8);
        packet.extend(value.as_bytes());
    }
    let mut packet = b"ZAL1".to_vec();
    for value in [15u64, 9, 1] {
        packet.extend(value.to_le_bytes());
    }
    packet.extend([0; 12]);
    packet.push(2);
    name(&mut packet, "rifle");
    packet.extend(0.57f32.to_le_bytes());
    packet.extend([0, 3]);
    name(&mut packet, "ammo_b");
    packet.push(2);
    name(&mut packet, "ammo_a");
    packet.extend(2u16.to_le_bytes());
    name(&mut packet, "ammo_b");
    packet.extend(1u16.to_le_bytes());
    packet.extend([0, 0, 0, 2]);
    name(&mut packet, "story_food");
    packet.extend(1.0f32.to_le_bytes());
    packet.extend([0, 2, 1]);
    assert!(alife_corpse::decode(&packet, 14, "zaton").is_none());
    assert!(alife_corpse::decode(&packet[..packet.len() - 1], 15, "zaton").is_none());
    let corpse = alife_corpse::decode(&packet, 15, "zaton").unwrap();

    let sections = [
        ("inventory", json!({"take_dist":"2","max_weight":"50"})),
        ("rifle", json!({"class":"WP_AK74","inv_name":"rifle","inv_weight":"2",
            "ammo_class":"ammo_a,ammo_b","ammo_mag_size":"30","slot":"2"})),
        ("ammo_a", json!({"class":"AMMO_S","inv_name":"a","inv_weight":"1","box_size":"30"})),
        ("ammo_b", json!({"class":"AMMO_S","inv_name":"b","inv_weight":"1","box_size":"30"})),
        ("story_food", json!({"class":"S_FOOD","inv_name":"story","inv_weight":"1",
            "eat_portions_num":"1","quest_item":"true"})),
    ].into_iter().map(|(name, values)| (name.to_owned(), json!({"source":"system.ltx","values":values})))
        .collect::<serde_json::Map<_, _>>();
    let catalog = Arc::new(Catalog::from_bytes(&serde_json::to_vec(&json!({
        "schema":1,"entry":"system.ltx","files":[{"path":"system.ltx","sha256":"0".repeat(64)}],
        "sections":sections,
    })).unwrap()).unwrap());
    let mut rules = SurvivalRules::default();
    rules.starter_kit.clear();
    rules.private_storage = None;
    let rules = Arc::new(rules);
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let b = register(&mut db, 'b');
    db.initialize_inventory(&a).unwrap();
    db.initialize_inventory(&b).unwrap();
    drop(db);

    let start = || Persistence::start_with_rules(&file.0, Some(catalog.clone()), Some(rules.clone()));
    let store = start().unwrap();
    let checkpoint = Checkpoint { lineage: 12, generation: 3 };
    let admitted = store.native_world_request("zaton".into(), checkpoint).unwrap().await.unwrap().unwrap();
    assert_eq!(admitted["accepted"], true);
    let result = store.native_corpse_request(corpse.clone(), checkpoint).unwrap().await.unwrap().unwrap();
    let source = result["corpse"].as_str().unwrap();
    assert_eq!(result["items"], 1);
    let (ca, cb) = (context(&a), context(&b));
    let view = store.inventory_request(ca.clone(), Operation::CorpseItems(source.into(), String::new(), None, ca.clone()))
        .unwrap().await.unwrap().unwrap();
    let item = view["items"][0]["id"].as_str().unwrap();
    assert_eq!(view["items"][0]["state"]["payload"]["cartridges"], json!(["ammo_a","ammo_a","ammo_b"]));
    assert_eq!(view["items"][0]["state"]["payload"]["jammed"], true);
    let (ra, rb) = tokio::join!(
        store.execute(secret('a'), pickup(item, 0, source, "native-race-a", &ca)),
        store.execute(secret('b'), pickup(item, 0, source, "native-race-b", &cb)),
    );
    let results = [ra.unwrap(), rb.unwrap()];
    assert_eq!(results.iter().filter(|v| v["status"] == "committed").count(), 1);
    store.flush().await.unwrap();
    drop(store);

    let restarted = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if let Ok(store) = start() {
                break store;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap();
    let stale = Checkpoint { generation: 2, ..checkpoint };
    let rejected = restarted.native_world_request("zaton".into(), stale).unwrap().await.unwrap().unwrap();
    assert_eq!(rejected["accepted"], false);
    assert!(restarted.native_corpse_request(corpse.clone(), stale).unwrap().await.unwrap().is_err());
    let replay = restarted.native_corpse_request(corpse, checkpoint).unwrap().await.unwrap().unwrap();
    assert_eq!(replay["replayed"], true);
    let sql = file.connection();
    assert_eq!(sql.query_row("SELECT count(*) FROM item_containers WHERE kind='corpse'", [], |r| r.get::<_, u32>(0)).unwrap(), 1);
    let (section, owner, revision): (String, String, u32) = sql.query_row(
        "SELECT i.section,c.owner,i.revision FROM inventory_items i JOIN item_containers c ON c.id=i.container WHERE i.id=?1",
        [item], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).unwrap();
    assert_eq!((section.as_str(), revision), ("rifle", 1));
    assert!(owner == a || owner == b);
}

#[test]
fn paginated_private_inventory_detects_intervening_mutation() {
    let mut db = Database::open(Path::new(":memory:")).unwrap();
    let a = register(&mut db, 'a');
    register(&mut db, 'b');
    let containers = db.initialize_inventory(&a).unwrap();
    let carried = containers["carried"].as_str().unwrap();
    for _ in 0..101 {
        db.provision_inventory_item(carried, "wpn_ak74", &weapon(), "rucksack")
            .unwrap();
    }
    let first = list(&mut db, 'a');
    let first_count = first["items"].as_array().unwrap().len();
    assert!((1..=100).contains(&first_count));
    assert_eq!(list(&mut db, 'b')["items"], json!([]));
    let next = Operation::ListInventory(
        first["nextCursor"].as_str().unwrap().into(),
        first["generation"].as_u64(),
    );
    let second = db.execute(&secret('a'), next.clone()).unwrap();
    assert!(!second["items"].as_array().unwrap().is_empty());
    assert!(serde_json::to_vec(&first).unwrap().len() < 16 * 1024);
    let item = first["items"][0]["id"].as_str().unwrap();
    db.execute(&secret('a'), drop_item(item, 0, "drop", &context(&a)))
        .unwrap();
    assert_eq!(
        db.execute(&secret('a'), next).unwrap()["status"],
        "conflict"
    );
    assert!(
        db.execute(&secret('a'), Operation::ListInventory(item.into(), None))
            .is_err()
    );
}

#[test]
fn invalid_import_state_is_rejected() {
    let mut db = Database::open(Path::new(":memory:")).unwrap();
    let source = db.provision_world_container("zaton", [0.0; 3]).unwrap();
    let mut state = weapon();
    state.condition = f32::NAN;
    assert!(
        db.provision_inventory_item(&source, "wpn_ak74", &state, "rucksack")
            .is_err()
    );
    assert!(
        db.provision_inventory_item(&source, "wpn_ak74", &weapon(), "slot:2")
            .is_err()
    );
    state.condition = 1.0;
    state.payload = ItemPayload::Ammunition { rounds: 0 };
    assert!(state.validate().is_err());
    assert!(
        db.provision_world_container("zaton", [0.0, 0.0, f64::INFINITY])
            .is_err()
    );
}

#[test]
fn v4_migration_preserves_existing_identity_ownership_and_replay() {
    let file = FileDb::new();
    let mut db = Database::open(&file.0).unwrap();
    let a = register(&mut db, 'a');
    let entity = db.provision_entity(&a, &json!({"existing":true})).unwrap();
    let mutation = zone_server::persistence::Mutation {
        request_id: "before-inventory".into(),
        expected_revision: 0,
        value: json!(42),
    };
    let outcome = db
        .execute(&secret('a'), Operation::Write(mutation.clone()))
        .unwrap();
    drop(db);
    // Reconstruct the exact pre-inventory schema; no v5 tables in a v4 fixture.
    let sql = file.connection();
    sql.execute_batch("DROP TABLE alife_world_fences; DROP TABLE alife_corpse_deaths; DROP TABLE artefact_reveals; DROP TABLE authored_artefact_slots; DROP TABLE authored_artefact_worlds;
        DROP TABLE authored_loose_slots; DROP TABLE authored_loot_slots; DROP TABLE authored_loot_worlds;
        DROP TABLE inventory_grants; DROP TABLE inventory_items; DROP TABLE inventory_characters; DROP TABLE item_containers;
        ALTER TABLE runtime_meta DROP COLUMN lab_lift_powered; PRAGMA user_version=4;").unwrap();
    drop(sql);
    let mut db = Database::open(&file.0).unwrap();
    assert_eq!(register(&mut db, 'a'), a);
    assert_eq!(
        db.execute(&secret('a'), Operation::Write(mutation))
            .unwrap(),
        outcome
    );
    assert_eq!(
        db.execute(&secret('a'), Operation::ListEntities(String::new(), None))
            .unwrap()["entities"][0]["id"],
        entity
    );
    assert_eq!(list(&mut db, 'a')["items"], json!([]));
    let sql = file.connection();
    assert_eq!(
        sql.pragma_query_value(None, "user_version", |r| r.get::<_, u32>(0))
            .unwrap(),
        22
    );
    assert!(
        sql.prepare("PRAGMA foreign_key_check")
            .unwrap()
            .query([])
            .unwrap()
            .next()
            .unwrap()
            .is_none()
    );
}

#[test]
fn death_cannot_be_bypassed_by_replaying_or_reordering_old_actions() {
    let mut db = Database::open(Path::new(":memory:")).unwrap();
    let a = register(&mut db, 'a');
    let ca = context(&a);
    let source = db.provision_world_container("zaton", [0.0; 3]).unwrap();
    let item = db
        .provision_inventory_item(&source, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    let command = pickup(&item, 0, &source, "pick", &ca);
    let success = db.execute(&secret('a'), command.clone()).unwrap();
    db.execute(&secret('a'), Operation::InventoryDeath(ca.clone()))
        .unwrap();
    assert_eq!(db.execute(&secret('a'), command).unwrap(), success);
    assert_eq!(
        db.execute(&secret('a'), drop_item(&item, 1, "delayed-drop", &ca))
            .unwrap()["reason"],
        "stale_or_dead_life"
    );
    assert_eq!(list(&mut db, 'a')["items"], json!([]));
    // A forged source must not expose another player's private storage.
    let b = register(&mut db, 'b');
    let cb = context(&b);
    let containers = db.initialize_inventory(&a).unwrap();
    let storage = containers["storage"].as_str().unwrap();
    let stored = db
        .provision_inventory_item(storage, "wpn_ak74", &weapon(), "rucksack")
        .unwrap();
    assert_eq!(
        db.execute(&secret('b'), pickup(&stored, 0, storage, "steal", &cb))
            .unwrap()["reason"],
        "unavailable"
    );
}

#[tokio::test]
async fn session_worker_authority_is_scoped_fresh_and_revocation_checked_at_commit() {
    let file = FileDb::new();
    let store = Persistence::start(&file.0).unwrap();
    let principal = store
        .execute(secret('a'), Operation::Register)
        .await
        .unwrap()["principalId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ctx = context(&principal);
    let result = store
        .inventory_request(ctx.clone(), Operation::ListInventory(String::new(), None))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["alive"], true);
    assert!(
        store
            .inventory_request(ctx.clone(), Operation::Register)
            .is_err()
    );
    assert!(
        store
            .inventory_request(ctx.clone(), Operation::Read)
            .is_err()
    );
    let mut expired = ctx.clone();
    expired.expires = Instant::now();
    let result = store
        .inventory_request(expired, Operation::ListInventory(String::new(), None))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert!(result.get("error").is_some());
    let sql = file.connection();
    sql.execute("UPDATE principals SET revoked=1 WHERE id=?1", [principal])
        .unwrap();
    let result = store
        .inventory_request(ctx, Operation::ListInventory(String::new(), None))
        .unwrap()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result["error"], "unauthorized identity");
    drop(sql);
    drop(store);
    tokio::time::sleep(Duration::from_millis(120)).await;
}

#[test]
fn world_discovery_is_bounded_public_and_uses_current_server_authority() {
    let file=FileDb::new();let mut db=Database::open(&file.0).unwrap();
    let a=register(&mut db,'a');let b=register(&mut db,'b');let ca=context(&a);
    list(&mut db,'a');list(&mut db,'b');
    let near=db.provision_world_container("zaton",[1.0,0.0,0.0]).unwrap();
    let mut expected=Vec::new();
    for _ in 0..40 {expected.push(db.provision_inventory_item(&near,"wpn_ak74",&weapon(),"rucksack").unwrap());}
    let far=db.provision_world_container("zaton",[33.0,0.0,0.0]).unwrap();
    let other=db.provision_world_container("jupiter",[0.0,0.0,0.0]).unwrap();
    let expired=db.provision_world_container("zaton",[0.0,0.0,0.0]).unwrap();
    for container in [&far,&other,&expired] {db.provision_inventory_item(container,"wpn_ak74",&weapon(),"rucksack").unwrap();}
    file.connection().execute("UPDATE item_containers SET expires_at_ms=1 WHERE id=?1",[&expired]).unwrap();
    // Another player's carried gear and corpse contents must not be exposed as
    // public loose loot by discovery, even when physically close.
    let personal=db.provision_world_container("zaton",[0.0,0.0,0.0]).unwrap();
    let private=db.provision_inventory_item(&personal,"wpn_ak74",&weapon(),"rucksack").unwrap();
    assert_eq!(db.execute(&secret('b'),pickup(&private,0,&personal,"private",&context(&b))).unwrap()["status"],"committed");
    let first=db.execute(&secret('a'),Operation::WorldItems(String::new(),ca.clone(),Default::default())).unwrap();
    assert!(first["items"].as_array().unwrap().len()<=32);
    assert!(first["nextCursor"].is_string());
    let mut found=Vec::new();let mut page=first;
    loop {
        let event=json!({"type":"action_result","sequence":1,"result":page});
        assert!(zone_server::control::encode_event(&event).unwrap().len()<=16384);
        for item in page["items"].as_array().unwrap() {
            found.push(item["id"].as_str().unwrap().to_owned());
            assert_eq!(item["source"],near);assert_eq!(item["position"],json!([1.0,0.0,0.0]));
            assert_eq!(item["state"],serde_json::to_value(weapon()).unwrap());
        }
        let Some(cursor)=page["nextCursor"].as_str() else {break;};
        page=db.execute(&secret('a'),Operation::WorldItems(cursor.into(),ca.clone(),Default::default())).unwrap();
    }
    expected.sort();assert_eq!(found,expected);
    db.execute(&secret('b'),Operation::InventoryDeath(context(&b))).unwrap();
    let page=db.execute(&secret('a'),Operation::WorldItems(String::new(),ca.clone(),Default::default())).unwrap();
    assert!(!page.to_string().contains(&private));
    // Visibility radius is not pickup permission.
    let mut distant=ca.clone();distant.position=[20.0,0.0,0.0];
    assert!(!db.execute(&secret('a'),Operation::WorldItems(String::new(),distant.clone(),Default::default())).unwrap()["items"].as_array().unwrap().is_empty());
    assert_eq!(db.execute(&secret('a'),pickup(&expected[0],0,&near,"out-of-reach",&distant)).unwrap()["status"],"rejected");
    for invalid in [Context{life:1,..ca.clone()},Context{principal:b.clone(),..ca.clone()},Context{auth_epoch:1,..ca.clone()},Context{expires:Instant::now()-Duration::from_secs(1),..ca.clone()}] {
        assert!(db.execute(&secret('a'),Operation::WorldItems(String::new(),invalid,Default::default())).unwrap()["error"].is_string());
    }
    db.execute(&secret('a'),Operation::InventoryDeath(ca.clone())).unwrap();
    assert!(db.execute(&secret('a'),Operation::WorldItems(String::new(),ca,Default::default())).unwrap()["error"].is_string());
}

#[test]
fn corpse_search_rechecks_access_and_conflicts_when_contents_change_between_pages() {
    let file=FileDb::new();let mut db=Database::open(&file.0).unwrap();
    let a=register(&mut db,'a');let b=register(&mut db,'b');let ca=context(&a);let cb=context(&b);
    list(&mut db,'a');list(&mut db,'b');
    let carry:String=file.connection().query_row("SELECT id FROM item_containers WHERE owner=?1 AND kind='carried'",[&b],|r|r.get(0)).unwrap();
    for _ in 0..40 {db.provision_inventory_item(&carry,"wpn_ak74",&weapon(),"rucksack").unwrap();}
    let death=db.execute(&secret('b'),Operation::InventoryDeath(cb)).unwrap();let corpse=death["corpse"].as_str().unwrap().to_owned();
    let discovered=db.execute(&secret('a'),Operation::Corpses(String::new(),ca.clone())).unwrap();
    assert_eq!(discovered["containers"],json!([{"id":corpse,"position":[0.0,0.0,0.0]}]));
    assert!(!discovered.to_string().contains("wpn_ak74"));
    let first=db.execute(&secret('a'),Operation::CorpseItems(corpse.clone(),String::new(),None,ca.clone())).unwrap();
    let generation=first["generation"].as_u64().unwrap();let cursor=first["nextCursor"].as_str().unwrap().to_owned();
    assert!(!first["items"].as_array().unwrap().is_empty());
    assert!(zone_server::control::encode_event(&json!({"type":"action_result","sequence":1,"result":first})).unwrap().len()<16384);
    let taken=&first["items"][0];assert_eq!(db.execute(&secret('a'),pickup(taken["id"].as_str().unwrap(),taken["revision"].as_u64().unwrap() as u32,&corpse,"corpse-take",&ca)).unwrap()["status"],"committed");
    assert_eq!(db.execute(&secret('a'),Operation::CorpseItems(corpse.clone(),cursor,Some(generation),ca.clone())).unwrap()["status"],"conflict");
    let mut far=ca.clone();far.position=[20.0,0.0,0.0];
    assert_eq!(db.execute(&secret('a'),Operation::Corpses(String::new(),far.clone())).unwrap()["containers"].as_array().unwrap().len(),1);
    assert!(db.execute(&secret('a'),Operation::CorpseItems(corpse.clone(),String::new(),None,far)).unwrap()["error"].is_string());
    assert!(db.execute(&secret('a'),Operation::CorpseItems(carry,String::new(),None,ca.clone())).unwrap()["error"].is_string());
    file.connection().execute("UPDATE item_containers SET expires_at_ms=1 WHERE id=?1",[&corpse]).unwrap();
    assert_eq!(db.execute(&secret('a'),Operation::Corpses(String::new(),ca.clone())).unwrap()["containers"],json!([]));
    let expired_item=&first["items"][1];
    let denied=db.execute(&secret('a'),pickup(expired_item["id"].as_str().unwrap(),expired_item["revision"].as_u64().unwrap() as u32,&corpse,"expired-corpse-pickup",&ca)).unwrap();
    assert_eq!(denied["status"],"rejected");
    assert_eq!(denied["reason"],"unavailable");
    assert!(db.execute(&secret('a'),Operation::CorpseItems(corpse,String::new(),None,ca)).unwrap()["error"].is_string());
}
