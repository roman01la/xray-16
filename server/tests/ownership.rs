use serde_json::{Value, json};
use zone_server::{
    ownership::Transfer,
    persistence::{Database, Operation},
};
fn secret(c: char) -> String {
    std::iter::repeat_n(c, 64).collect()
}
fn principal(db: &mut Database, c: char) -> String {
    db.execute(&secret(c), Operation::Register).unwrap()["principalId"]
        .as_str()
        .unwrap()
        .into()
}
fn transfer(request: &str, entity: &str, revision: u32, recipient: &str) -> Operation {
    Operation::Transfer(Transfer {
        request_id: request.into(),
        entity_id: entity.into(),
        expected_revision: revision,
        recipient: recipient.into(),
    })
}
fn list(db: &mut Database, c: char) -> Value {
    db.execute(&secret(c), Operation::ListEntities(String::new(), None))
        .unwrap()
}
fn path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "zone-ownership-{label}-{}-{}.sqlite",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}
#[test]
fn authorization_replay_and_aba_revision_guard() {
    let mut db = Database::open(std::path::Path::new(":memory:")).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    let entity = db.provision_entity(&a, &json!({"fixture":true})).unwrap();
    assert_eq!(list(&mut db, 'b')["entities"], json!([]));
    let theft = transfer("theft", &entity, 0, &b);
    assert_eq!(
        db.execute(&secret('b'), theft.clone()).unwrap()["reason"],
        "not_owned"
    );
    let command = transfer("transfer", &entity, 0, &b);
    let result = db.execute(&secret('a'), command.clone()).unwrap();
    assert_eq!(result["status"], "committed");
    let reused_record = zone_server::persistence::Mutation {
        request_id: "transfer".into(),
        expected_revision: 0,
        value: Value::Null,
    };
    assert!(
        db.execute(&secret('a'), Operation::Write(reused_record))
            .unwrap()
            .get("error")
            .is_some()
    );

    assert_eq!(list(&mut db, 'a')["entities"], json!([]));
    assert_eq!(list(&mut db, 'b')["entities"][0]["revision"], 1);
    assert_eq!(
        db.execute(&secret('b'), theft).unwrap()["reason"],
        "not_owned"
    ); // durable rejection, even after ownership changed
    assert!(
        db.execute(&secret('a'), transfer("transfer", &entity, 1, &a))
            .unwrap()
            .get("error")
            .is_some()
    );
    assert_eq!(
        db.execute(&secret('b'), transfer("return", &entity, 1, &a))
            .unwrap()["status"],
        "committed"
    );
    assert_eq!(db.execute(&secret('a'), command).unwrap(), result); // old success cannot transfer again
    assert_eq!(list(&mut db, 'a')["entities"][0]["revision"], 2);
    assert_eq!(
        db.execute(&secret('a'), transfer("stale", &entity, 0, &b))
            .unwrap()["status"],
        "conflict"
    );
    assert_eq!(
        db.execute(&secret('a'), transfer("self", &entity, 2, &a))
            .unwrap()["reason"],
        "same_owner"
    );
    assert_eq!(
        db.execute(
            &secret('a'),
            transfer("unknown", &entity, 2, &"f".repeat(32))
        )
        .unwrap()["reason"],
        "recipient_unavailable"
    );
    assert_eq!(list(&mut db, 'a')["entities"][0]["revision"], 2);
}
#[test]
fn competing_transfers_have_one_owner_and_durable_winner() {
    let path = path("race");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    let c = principal(&mut db, 'c');
    let id = db.provision_entity(&a, &Value::Null).unwrap();
    drop(db);
    let threads: Vec<_> = [b.clone(), c.clone()]
        .into_iter()
        .enumerate()
        .map(|(i, to)| {
            let path = path.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                Database::open(&path)
                    .unwrap()
                    .execute(&secret('a'), transfer(&format!("race-{i}"), &id, 0, &to))
                    .unwrap()
            })
        })
        .collect();
    let responses: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(
        responses
            .iter()
            .filter(|r| r["status"] == "committed")
            .count(),
        1
    );
    let mut db = Database::open(&path).unwrap();
    assert_eq!(list(&mut db, 'a')["entities"].as_array().unwrap().len(), 0);
    assert_eq!(
        list(&mut db, 'b')["entities"].as_array().unwrap().len()
            + list(&mut db, 'c')["entities"].as_array().unwrap().len(),
        1
    );
    for (i, to) in [b, c].iter().enumerate() {
        assert_eq!(
            db.execute(&secret('a'), transfer(&format!("race-{i}"), &id, 0, to))
                .unwrap(),
            responses[i]
        );
    }
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn v1_migration_preserves_identity_records_and_outcomes_and_lists_are_bounded() {
    let path = path("migration");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let mutation = zone_server::persistence::Mutation {
        request_id: "old".into(),
        expected_revision: 0,
        value: json!(17),
    };
    let result = db
        .execute(&secret('a'), Operation::Write(mutation.clone()))
        .unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE native_condition_receipts; DROP TABLE alife_world_fences; DROP TABLE alife_corpse_deaths; DROP TABLE artefact_reveals; DROP TABLE authored_artefact_slots; DROP TABLE authored_artefact_worlds; DROP TABLE authored_loose_slots; DROP TABLE authored_loot_slots; DROP TABLE authored_loot_worlds; DROP TABLE inventory_grants; DROP TABLE inventory_items; DROP TABLE inventory_characters; DROP TABLE item_containers; DROP TABLE scene_entities; DROP TRIGGER principal_revocation; DROP TABLE runtime_meta; ALTER TABLE principals DROP COLUMN revoked; DROP TRIGGER ownership_principal_insert; DROP TABLE ownership_versions; DROP TABLE owned_entities; PRAGMA user_version=1;")
        .unwrap();
    drop(conn);
    let mut db = Database::open(&path).unwrap();
    assert_eq!(principal(&mut db, 'a'), a);
    assert_eq!(
        db.execute(&secret('a'), Operation::Write(mutation))
            .unwrap(),
        result
    );
    for _ in 0..103 {
        db.provision_entity(&a, &Value::Null).unwrap();
    }
    let first = list(&mut db, 'a');
    assert_eq!(first["entities"].as_array().unwrap().len(), 100);
    let second = db
        .execute(
            &secret('a'),
            Operation::ListEntities(
                first["nextCursor"].as_str().unwrap().into(),
                first["generation"].as_u64(),
            ),
        )
        .unwrap();
    assert_eq!(second["entities"].as_array().unwrap().len(), 3);
    assert!(second["nextCursor"].is_null());
    assert!(
        db.execute(
            &secret('a'),
            Operation::ListEntities("invalid".into(), None)
        )
        .is_err()
    );
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.pragma_update(None, "user_version", 99).unwrap();
    drop(conn);
    assert!(Database::open(&path).is_err());
    std::fs::remove_file(path).unwrap();
}
#[test]
fn transfer_crash_recovery_keeps_owner_and_replay_atomic() {
    let path = path("crash");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    let id = db.provision_entity(&a, &Value::Null).unwrap();
    drop(db);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "transfer_crash_child", "--nocapture"])
        .env("ZONE_OWNERSHIP_CRASH_DB", &path)
        .env("ZONE_OWNERSHIP_ENTITY", &id)
        .env("ZONE_OWNERSHIP_RECIPIENT", &b)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(27));
    let mut db = Database::open(&path).unwrap();
    assert_eq!(list(&mut db, 'a')["entities"], json!([]));
    assert_eq!(list(&mut db, 'b')["entities"][0]["revision"], 1);
    assert_eq!(
        db.execute(&secret('a'), transfer("crash", &id, 0, &b))
            .unwrap()["status"],
        "committed"
    );
    drop(db);
    std::fs::remove_file(path).unwrap();
}
#[test]
fn transfer_crash_child() {
    let Ok(path) = std::env::var("ZONE_OWNERSHIP_CRASH_DB") else {
        return;
    };
    let id = std::env::var("ZONE_OWNERSHIP_ENTITY").unwrap();
    let b = std::env::var("ZONE_OWNERSHIP_RECIPIENT").unwrap();
    let mut db = Database::open(std::path::Path::new(&path)).unwrap();
    assert_eq!(
        db.execute(&secret('a'), transfer("crash", &id, 0, &b))
            .unwrap()["status"],
        "committed"
    );
    drop(db);
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "BEGIN IMMEDIATE; UPDATE owned_entities SET revision=99; DELETE FROM outcomes;",
    )
    .unwrap();
    std::process::exit(27);
}

#[test]
fn pagination_conflicts_when_ownership_changes_and_replay_does_not_bump_generation() {
    let mut db = Database::open(std::path::Path::new(":memory:")).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    for _ in 0..103 {
        db.provision_entity(&a, &Value::Null).unwrap();
    }
    let first = list(&mut db, 'a');
    assert_eq!(first["generation"], 103);
    let id = first["entities"][0]["id"].as_str().unwrap();
    let command = transfer("generation-test", id, 0, &b);
    let result = db.execute(&secret('a'), command.clone()).unwrap();
    assert_eq!(result["status"], "committed");
    let cursor = first["nextCursor"].as_str().unwrap().to_string();
    assert!(
        db.execute(&secret('a'), Operation::ListEntities(cursor.clone(), None))
            .is_err()
    );
    let stale = db
        .execute(&secret('a'), Operation::ListEntities(cursor, Some(103)))
        .unwrap();
    assert_eq!(stale, json!({"status":"conflict","generation":104}));
    assert!(stale.get("entities").is_none());
    assert_eq!(list(&mut db, 'b')["generation"], 1);
    assert_eq!(db.execute(&secret('a'), command).unwrap(), result);
    assert_eq!(list(&mut db, 'a')["generation"], 104);
    assert_eq!(list(&mut db, 'b')["generation"], 1);
}
#[test]
fn v2_migration_preserves_existing_entities_then_versions_every_mutation() {
    let path = path("v2");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let id = db.provision_entity(&a, &json!("before")).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE native_condition_receipts; DROP TABLE alife_world_fences; DROP TABLE alife_corpse_deaths; DROP TABLE artefact_reveals; DROP TABLE authored_artefact_slots; DROP TABLE authored_artefact_worlds; DROP TABLE authored_loose_slots; DROP TABLE authored_loot_slots; DROP TABLE authored_loot_worlds; DROP TABLE inventory_grants; DROP TABLE inventory_items; DROP TABLE inventory_characters; DROP TABLE item_containers; DROP TABLE scene_entities; DROP TRIGGER principal_revocation; DROP TABLE runtime_meta; ALTER TABLE principals DROP COLUMN revoked; DROP TRIGGER ownership_principal_insert; DROP TRIGGER ownership_entity_insert; DROP TRIGGER ownership_entity_update; DROP TRIGGER ownership_entity_delete; DROP TABLE ownership_versions; PRAGMA user_version=2;").unwrap();
    drop(conn);
    let mut db = Database::open(&path).unwrap();
    let before = list(&mut db, 'a');
    assert_eq!(before["generation"], 0);
    assert_eq!(before["entities"][0]["id"], id);
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE owned_entities SET value='42' WHERE id=?1", [&id])
        .unwrap();
    drop(conn);
    let mut db = Database::open(&path).unwrap();
    assert_eq!(list(&mut db, 'a')["generation"], 1);
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("DELETE FROM owned_entities WHERE id=?1", [id])
        .unwrap();
    drop(conn);
    let mut db = Database::open(&path).unwrap();
    let after = list(&mut db, 'a');
    assert_eq!(after["generation"], 2);
    assert_eq!(after["entities"], json!([]));
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn scene_policy_denial_can_retry_and_committed_outcome_survives_context_expiry() {
    use zone_server::policy::ActionContext;
    let path = path("policy");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    let id = db.provision_entity(&a, &Value::Null).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute(
        "INSERT INTO scene_entities VALUES(?1,'synthetic-flat-v1','stalker',3,4,0)",
        [&id],
    )
    .unwrap();
    let command = Transfer {
        request_id: "scene-transfer".into(),
        entity_id: id.clone(),
        expected_revision: 0,
        recipient: b.clone(),
    };
    let denied = db
        .execute(&secret('a'), Operation::Transfer(command.clone()))
        .unwrap();
    assert_eq!(denied["error"], "live scene authorization required");
    assert_eq!(list(&mut db, 'a')["entities"][0]["id"], id);
    let mut context = ActionContext {
        principal: a,
        world: Some("synthetic-flat-v1".into()),
        session: Some(1),
        expires: std::time::Instant::now() + std::time::Duration::from_secs(2),
    };
    let result = db
        .execute(
            &secret('a'),
            Operation::TransferWithContext(command.clone(), context.clone()),
        )
        .unwrap();
    assert_eq!(result["status"], "committed");
    context.expires = std::time::Instant::now() - std::time::Duration::from_secs(1);
    assert_eq!(
        db.execute(
            &secret('a'),
            Operation::TransferWithContext(command, context)
        )
        .unwrap(),
        result
    );
    assert_eq!(db.runtime_state().unwrap().scenes[0].id, id);
    conn.execute("UPDATE principals SET revoked=1 WHERE id=?1", [b])
        .unwrap();
    assert_eq!(db.runtime_state().unwrap().auth_epoch, 1);
    assert_eq!(
        db.execute(&secret('b'), Operation::Resume).unwrap()["error"],
        "unauthorized identity"
    );
    assert_eq!(
        db.execute(&secret('b'), Operation::Register).unwrap()["error"],
        "unauthorized identity"
    );
    drop(conn);
    drop(db);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn revoked_recipient_cannot_receive_new_ownership() {
    let path = path("revoked-recipient");
    let mut db = Database::open(&path).unwrap();
    let a = principal(&mut db, 'a');
    let b = principal(&mut db, 'b');
    let id = db.provision_entity(&a, &Value::Null).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE principals SET revoked=1 WHERE id=?1", [&b])
        .unwrap();
    assert_eq!(
        db.execute(&secret('a'), transfer("revoked", &id, 0, &b))
            .unwrap()["reason"],
        "recipient_unavailable"
    );
    assert_eq!(list(&mut db, 'a')["entities"][0]["id"], id);
    drop(conn);
    drop(db);
    std::fs::remove_file(path).unwrap();
}
