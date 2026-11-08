use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use zone_server::{
    catalog::Catalog,
    equipment::Placement,
    inventory::{AttachmentSlot, Context, ItemPayload, ItemState, Move, MoveAction},
    persistence::{Database, Operation, Persistence},
};

// Synthetic values exercise rules without checking copyrighted configuration data
// into Git. The separate catalog-check tool validates the actual extracted catalog.
fn catalog() -> Arc<Catalog> {
    let definitions = [
        ("inventory_box", vec![("class", "S_INVBOX")]),
        ("treatment", vec![("class", "S_FOOD"), ("inv_weight", "0.1"),
            ("eat_portions_num", "2"), ("max_uses", "2"), ("use_condition", "true"), ("empty_weight", "0.02"), ("eat_health", "0.1"),
            ("boost_time", "5"), ("boost_bleeding_restore", "0.02")]),
        (
            "inventory",
            vec![
                ("take_dist", "2"),
                ("max_weight", "50"),
                ("slot_persistent_7", "false"),
            ],
        ),
        (
            "rifle",
            vec![
                ("class", "WP_AK74"),
                ("slot", "2"),
                ("inv_weight", "3"),
                ("ammo_class", "ammo,ammo_ap"),
                ("grenade_class", "grenade"),
                ("grenade_launcher_status", "1"),
                ("grenade_vel", "32"),
                ("ammo_mag_size", "30"),
                ("rpm", "600"),
                ("fire_distance", "200"),
                ("hit_power", "0.3,0.2"),
                ("condition_shot_dec", "0.002"),
                ("condition_queue_shot_dec", "0.003"),
                ("fire_modes", "1,2,-1"),
                ("rpm_mode_2", "1200"),
                ("misfire_start_condition", "0.6"),
                ("misfire_end_condition", "0.1"),
                ("misfire_start_prob", "0.003"),
                ("misfire_end_prob", "1"),
                ("upgrades", "group"),
                ("scope_status", "0"),
            ],
        ),
        (
            "ammo",
            vec![
                ("class", "AMMO_S"),
                ("inv_weight", "0.4"),
                ("box_size", "20"),
                ("k_dist", "1"),
                ("k_hit", "1"),
                ("k_ap", "0.35"),
                ("impair", "1"),
            ],
        ),
        (
            "ammo_ap",
            vec![
                ("class", "AMMO_S"), ("inv_weight", "0.5"), ("box_size", "15"),
                ("k_dist", "0.8"), ("k_hit", "1.5"), ("impair", "2"), ("k_ap", "0.75"),
            ],
        ),
        (
            "grenade",
            vec![("class", "S_VOG25"), ("inv_weight", "0.2"), ("box_size", "1"),
                ("fake_grenade_name", "projectile")],
        ),
        ("projectile", vec![("class", "G_FAKE"), ("force_explode_time", "10000"),
            ("hit_type_blast", "explosion"), ("blast", "3"), ("blast_r", "4")]),
        (
            "shotgun",
            vec![
                ("class", "WP_ASHTG"), ("slot", "2"), ("inv_weight", "3"),
                ("ammo_class", "ammo,ammo_ap"), ("ammo_mag_size", "3"),
                ("tri_state_reload", "true"),
            ],
        ),
        (
            "outfit",
            vec![
                ("class", "E_STLK"),
                ("slot", "6"),
                ("inv_weight", "5"),
                ("artefact_count", "2"),
                ("additional_inventory_weight", "10"),
                ("power_loss", "0.75"),
                ("sprint_allowed", "false"),
                ("bones_koeff_protection", "outfit_bones"),
                ("immunities_sect", "outfit_immunity"),
                ("explosion_protection", "0.35"),
                ("upgrades", "group"),
                ("hit_fraction_actor", "0.25"),
            ],
        ),
        (
            "sealed",
            vec![
                ("class", "E_STLK"),
                ("slot", "6"),
                ("inv_weight", "10"),
                ("artefact_count", "1"),
                ("helmet_avaliable", "false"),
            ],
        ),
        (
            "helmet",
            vec![("class", "E_HLMET"), ("slot", "11"), ("inv_weight", "1"),
                ("bones_koeff_protection", "helmet_bones"), ("immunities_sect", "helmet_immunity"),
                ("hit_fraction_actor", "0.2"), ("explosion_protection", "0.2")],
        ),
        ("outfit_bones", vec![("bip01_head", "1,-1"), ("bip01_spine2", "1,0.65")]),
        ("helmet_bones", vec![("bip01_head", "1,0.55"), ("bip01_spine2", "1,-1")]),
        ("outfit_immunity", vec![("fire_wound_immunity", "0.1"), ("explosion_immunity", "0.1")]),
        ("helmet_immunity", vec![("fire_wound_immunity", "0.2"), ("explosion_immunity", "0.25")]),
        ("artefact_absorption", vec![("explosion_immunity", "0.2")]),
        (
            "artefact",
            vec![
                ("class", "ARTEFACT"),
                ("slot", "-1"),
                ("inv_weight", "0.5"),
                ("belt", "true"),
                ("additional_inventory_weight", "4"),
                ("hit_absorbation_sect", "artefact_absorption"),
                ("inv_grid_width", "1"),
                ("inv_grid_height", "1"),
            ],
        ),
        (
            "wide_artefact",
            vec![
                ("class", "ARTEFACT"),
                ("slot", "-1"),
                ("inv_weight", "0.5"),
                ("belt", "true"),
                ("inv_grid_width", "2"),
                ("inv_grid_height", "1"),
            ],
        ),
        ("group", vec![("elements", "upgrade")]),
        ("upgrade", vec![("section", "effect")]),
        ("effect", vec![("inv_weight", "-0.5"), ("ammo_mag_size", "5"),
            ("explosion_protection", "0.15"), ("immunities_sect_add", "blast_wear_upgrade")]),
        ("blast_wear_upgrade", vec![("explosion_immunity", "0.05")]),
        ("modular_rifle", vec![
            ("class", "WP_AK74"), ("slot", "2"), ("inv_weight", "3"),
            ("ammo_class", "ammo"), ("ammo_mag_size", "30"),
            ("scope_status", "2"), ("scopes_sect", "scope_one,scope_two"),
            ("silencer_status", "2"), ("silencer_name", "silencer"),
            ("grenade_launcher_status", "2"), ("grenade_launcher_name", "launcher"),
            ("grenade_class", "grenade"),
            ("launch_speed", "0"),
        ]),
        ("scope_one", vec![("scope_name", "scope")]),
        ("scope_two", vec![("scope_name", "scope_zoom")]),
        ("scope", vec![("class", "WP_SCOPE"), ("inv_weight", "0.4")]),
        ("scope_zoom", vec![("class", "WP_SCOPE"), ("inv_weight", "0.5")]),
        ("silencer", vec![("class", "WP_SILEN"), ("inv_weight", "0.2")]),
        ("launcher", vec![("class", "WP_GLAUN"), ("inv_weight", "1.0"), ("grenade_vel", "30")]),
    ];
    let mut sections = BTreeMap::new();
    for (name, fields) in definitions {
        let mut values: BTreeMap<&str, &str> = fields.into_iter().collect();
        if values.contains_key("class") {
            values.insert("inv_name", name);
        }
        sections.insert(name, json!({"source":"fixture.ltx","values":values}));
    }
    Arc::new(Catalog::from_bytes(&serde_json::to_vec(&json!({"schema":1,"entry":"system.ltx","files":[{"path":"fixture.ltx","sha256":"0".repeat(64)}],"sections":sections})).unwrap()).unwrap())
}
fn setup() -> (Database, Arc<Catalog>, Context, String) {
    let catalog = catalog();
    let mut db = Database::open(Path::new(":memory:")).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&"a".repeat(64), Operation::Register).unwrap()["principalId"]
        .as_str()
        .unwrap()
        .to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"]
        .as_str()
        .unwrap()
        .to_owned();
    let ctx = Context {
        principal,
        life: 0,
        auth_epoch: 0,
        world: "zaton".into(),
        position: [0.0; 3],
        interaction_radius: 2.0,
        eye_height: 1.55,
        collision: None,
        expires: Instant::now() + Duration::from_secs(60),
    };
    (db, catalog, ctx, carry)
}
fn item(db: &mut Database, catalog: &Catalog, carry: &str, name: &str) -> String {
    db.provision_inventory_item(
        carry,
        name,
        &catalog.initial_state(name).unwrap(),
        "rucksack",
    )
    .unwrap()
}
fn place(
    db: &mut Database,
    ctx: &Context,
    item: &str,
    revision: u32,
    placement: Placement,
    request: &str,
) -> Value {
    db.execute(
        &"a".repeat(64),
        Operation::MoveInventory(
            Move {
                request_id: request.into(),
                life: 0,
                item: item.into(),
                revision,
                action: MoveAction::Place { placement },
            },
            ctx.clone(),
        ),
    )
    .unwrap()
}
fn list(db: &mut Database) -> Value {
    db.execute(
        &"a".repeat(64),
        Operation::ListInventory(String::new(), None),
    )
    .unwrap()
}
fn placement(view: &Value, id: &str) -> String {
    view["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == id)
        .unwrap()["place"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn cop_slot_offset_weapon_slots_and_weight_follow_original_rules() {
    let cat = catalog();
    assert_eq!(cat.base_slot("outfit").unwrap(), Some(7));
    assert_eq!(cat.base_slot("helmet").unwrap(), Some(12));
    assert!(cat.compatible_slot("rifle", 2).unwrap());
    assert!(cat.compatible_slot("rifle", 3).unwrap());
    assert!(!cat.compatible_slot("rifle", 7).unwrap());
    let mut ammo = cat.initial_state("ammo").unwrap();
    ammo.payload = ItemPayload::Ammunition { rounds: 5 };
    assert!((cat.weight("ammo", &ammo).unwrap() - 0.1).abs() < 1e-8);
    let mut rifle = cat.initial_state("rifle").unwrap();
    rifle.upgrades.push("upgrade".into());
    if let ItemPayload::Weapon { cartridges, .. } = &mut rifle.payload {
        cartridges.extend(["ammo".into(), "ammo".into()]);
    }
    assert!((cat.weight("rifle", &rifle).unwrap() - 2.54).abs() < 1e-8);
    rifle.upgrades.push("upgrade".into());
    assert!(cat.validate_state("rifle", &rifle).is_err());
}
#[test]
fn outfit_swap_moves_helmet_and_belt_to_rucksack_atomically() {
    let (mut db, cat, ctx, carry) = setup();
    let outfit = item(&mut db, &cat, &carry, "outfit");
    let sealed = item(&mut db, &cat, &carry, "sealed");
    let helmet = item(&mut db, &cat, &carry, "helmet");
    let artefact = item(&mut db, &cat, &carry, "artefact");
    for (id, p, request) in [
        (&outfit, Placement::Slot { slot: 7 }, "outfit"),
        (&helmet, Placement::Slot { slot: 12 }, "helmet"),
        (&artefact, Placement::Belt { cell: 0 }, "artefact"),
    ] {
        assert_eq!(
            place(&mut db, &ctx, id, 0, p, request)["status"],
            "committed"
        );
    }
    let first = place(
        &mut db,
        &ctx,
        &sealed,
        0,
        Placement::Slot { slot: 7 },
        "sealed",
    );
    assert_eq!(first["status"], "committed");
    let view = list(&mut db);
    assert_eq!(placement(&view, &sealed), "slot:7");
    for id in [&outfit, &helmet, &artefact] {
        assert_eq!(placement(&view, id), "rucksack");
    }
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &sealed,
            0,
            Placement::Slot { slot: 7 },
            "sealed"
        ),
        first
    );
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &helmet,
            2,
            Placement::Slot { slot: 12 },
            "blocked"
        )["reason"],
        "helmet_blocked"
    );
}
#[test]
fn belt_capacity_rejection_does_not_displace_items() {
    let (mut db, cat, ctx, carry) = setup();
    let outfit = item(&mut db, &cat, &carry, "sealed");
    let a = item(&mut db, &cat, &carry, "artefact");
    let b = item(&mut db, &cat, &carry, "artefact");
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &a,
            0,
            Placement::Belt { cell: 0 },
            "no-outfit"
        )["reason"],
        "no_artefact_slots"
    );
    place(
        &mut db,
        &ctx,
        &outfit,
        0,
        Placement::Slot { slot: 7 },
        "outfit",
    );
    place(&mut db, &ctx, &a, 0, Placement::Belt { cell: 0 }, "a");
    assert_eq!(
        place(&mut db, &ctx, &b, 0, Placement::Belt { cell: 1 }, "outside")["reason"],
        "belt_full"
    );
    let before = list(&mut db);
    assert_eq!(placement(&before, &a), "belt:0");
    assert_eq!(placement(&before, &b), "rucksack");
    place(&mut db, &ctx, &outfit, 1, Placement::Rucksack, "undress");
    assert_eq!(placement(&list(&mut db), &a), "rucksack");
}
#[test]
fn dropping_outfit_retains_artefacts_in_carried_inventory() {
    let (mut db, cat, ctx, carry) = setup();
    let outfit = item(&mut db, &cat, &carry, "outfit");
    let af = item(&mut db, &cat, &carry, "artefact");
    place(
        &mut db,
        &ctx,
        &outfit,
        0,
        Placement::Slot { slot: 7 },
        "equip",
    );
    place(&mut db, &ctx, &af, 0, Placement::Belt { cell: 0 }, "belt");
    let result = db
        .execute(
            &"a".repeat(64),
            Operation::MoveInventory(
                Move {
                    request_id: "drop".into(),
                    life: 0,
                    item: outfit,
                    revision: 1,
                    action: MoveAction::Drop,
                },
                ctx,
            ),
        )
        .unwrap();
    assert_eq!(result["status"], "committed");
    let view = list(&mut db);
    assert_eq!(view["items"].as_array().unwrap().len(), 1);
    assert_eq!(placement(&view, &af), "rucksack");
}

#[test]
fn starter_grants_and_respawn_are_once_per_life_and_death_is_full_loss() {
    use zone_server::survival_rules::{StarterItem, SurvivalRules};
    let (mut db, cat, ctx, _) = setup();
    let rules = SurvivalRules {
        starter_kit: vec![
            StarterItem {
                section: "rifle".into(),
                count: 1,
                placement: Placement::Slot { slot: 3 },
            },
            StarterItem {
                section: "ammo".into(),
                count: 1,
                placement: Placement::Rucksack,
            },
        ],
        respawn_delay_seconds: 0,
        ..SurvivalRules::default()
    };
    db.set_survival_rules(Arc::new(rules)).unwrap();
    let first = list(&mut db);
    assert_eq!(first["items"].as_array().unwrap().len(), 2);
    assert_eq!(list(&mut db), first);
    let death = db
        .execute(&"a".repeat(64), Operation::InventoryDeath(ctx.clone()))
        .unwrap();
    assert_eq!(death["status"], "committed");
    assert_eq!(list(&mut db)["items"], json!([]));
    let result = db
        .execute(
            &"a".repeat(64),
            Operation::InventoryRespawn(
                zone_server::inventory::Respawn {
                    request_id: "respawn".into(),
                    life: 0,
                },
                ctx.clone(),
            ),
        )
        .unwrap();
    assert_eq!(result["status"], "respawned");
    assert_eq!(result["life"], 1);
    let second = list(&mut db);
    assert_eq!(second["items"].as_array().unwrap().len(), 2);
    assert!(second["items"].as_array().unwrap().iter().all(|item| {
        first["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|old| old["id"] != item["id"])
    }));
    assert_eq!(
        db.execute(
            &"a".repeat(64),
            Operation::InventoryRespawn(
                zone_server::inventory::Respawn {
                    request_id: "another-respawn".into(),
                    life: 0
                },
                ctx
            )
        )
        .unwrap()["status"],
        "rejected"
    );
    assert_eq!(list(&mut db), second);
    assert_eq!(cat.base_slot("rifle").unwrap(), Some(3));
}

#[test]
fn replaying_an_old_respawn_after_another_death_cannot_restore_a_life_or_kit() {
    use zone_server::{
        inventory::Respawn,
        survival_rules::{StarterItem, SurvivalRules},
    };
    let (mut db, _, mut ctx, _) = setup();
    db.set_survival_rules(Arc::new(SurvivalRules {
        starter_kit: vec![StarterItem {
            section: "rifle".into(),
            count: 1,
            placement: Placement::Slot { slot: 3 },
        }],
        respawn_delay_seconds: 0,
        ..SurvivalRules::default()
    }))
    .unwrap();
    assert_eq!(list(&mut db)["items"].as_array().unwrap().len(), 1);
    db.execute(&"a".repeat(64), Operation::InventoryDeath(ctx.clone()))
        .unwrap();
    let command = Respawn {
        request_id: "lost-respawn-reply".into(),
        life: 0,
    };
    let original = db
        .execute(
            &"a".repeat(64),
            Operation::InventoryRespawn(command.clone(), ctx.clone()),
        )
        .unwrap();
    assert_eq!(original["status"], "respawned");
    ctx.life = 1;
    db.execute(&"a".repeat(64), Operation::InventoryDeath(ctx.clone()))
        .unwrap();
    let dead = list(&mut db);
    assert_eq!(dead["life"], 1);
    assert_eq!(dead["alive"], false);
    assert_eq!(dead["items"], json!([]));
    let replay = db
        .execute(&"a".repeat(64), Operation::InventoryRespawn(command, ctx))
        .unwrap();
    assert_eq!(replay, original);
    assert_eq!(list(&mut db), dead, "an old outcome is not a new respawn");
}

#[test]
fn corpse_and_drop_expiry_never_remove_carried_or_private_items() {
    use zone_server::survival_rules::SurvivalRules;
    let (mut db, cat, ctx, carry) = setup();
    db.set_survival_rules(Arc::new(SurvivalRules {
        starter_kit: vec![],
        ..SurvivalRules::default()
    }))
    .unwrap();
    let stored_container = db.initialize_inventory(&ctx.principal).unwrap()["storage"]
        .as_str()
        .unwrap()
        .to_owned();
    item(&mut db, &cat, &stored_container, "ammo");
    let carried = item(&mut db, &cat, &carry, "rifle");
    let dropped = item(&mut db, &cat, &carry, "ammo");
    db.execute(
        &"a".repeat(64),
        Operation::MoveInventory(
            Move {
                request_id: "drop-expiry".into(),
                life: 0,
                item: dropped,
                revision: 0,
                action: MoveAction::Drop,
            },
            ctx.clone(),
        ),
    )
    .unwrap();
    assert_eq!(
        db.expire_inventory(zone_server::survival_rules::unix_millis().unwrap() + 901000)
            .unwrap(),
        1
    );
    assert_eq!(list(&mut db)["items"][0]["id"], carried);
    db.execute(&"a".repeat(64), Operation::InventoryDeath(ctx.clone()))
        .unwrap();
    assert_eq!(
        db.expire_inventory(zone_server::survival_rules::unix_millis().unwrap() + 1801000)
            .unwrap(),
        1
    );
    assert_eq!(list(&mut db)["alive"], false);
    assert_eq!(list(&mut db)["corpse"], Value::Null);
    assert_eq!(
        db.execute(
            &"a".repeat(64),
            Operation::InventoryRespawn(
                zone_server::inventory::Respawn {
                    request_id: "another-respawn".into(),
                    life: 0
                },
                ctx
            )
        )
        .unwrap()["reason"],
        "respawn_delay"
    );
    // Existing private container remains valid after both expiry passes.
    db.provision_inventory_item(
        &stored_container,
        "ammo",
        &cat.initial_state("ammo").unwrap(),
        "rucksack",
    )
    .unwrap();
}

#[test]
fn belt_cursor_replacement_conserves_items_and_replay_is_idempotent() {
    let (mut db, cat, ctx, carry) = setup();
    let outfit = item(&mut db, &cat, &carry, "outfit");
    let a = item(&mut db, &cat, &carry, "artefact");
    let b = item(&mut db, &cat, &carry, "artefact");
    let wide = item(&mut db, &cat, &carry, "wide_artefact");
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &outfit,
            0,
            Placement::Slot { slot: 7 },
            "outfit"
        )["status"],
        "committed"
    );
    assert_eq!(
        place(&mut db, &ctx, &a, 0, Placement::Belt { cell: 0 }, "a")["status"],
        "committed"
    );
    assert_eq!(
        place(&mut db, &ctx, &b, 0, Placement::Belt { cell: 1 }, "b")["status"],
        "committed"
    );
    let before = list(&mut db);
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &wide,
            0,
            Placement::Belt { cell: 1 },
            "outside"
        )["reason"],
        "belt_full"
    );
    assert_eq!(
        list(&mut db),
        before,
        "failed fit must not displace either artefact"
    );
    let result = place(
        &mut db,
        &ctx,
        &wide,
        0,
        Placement::Belt { cell: 0 },
        "replace",
    );
    assert_eq!(result["status"], "committed");
    let after = list(&mut db);
    assert_eq!(placement(&after, &wide), "belt:0");
    for id in [&a, &b] {
        assert_eq!(placement(&after, id), "rucksack");
    }
    let old = before["items"].as_array().unwrap();
    let new = after["items"].as_array().unwrap();
    assert_eq!(old.len(), new.len());
    for item in old {
        let next = new.iter().find(|n| n["id"] == item["id"]).unwrap();
        assert_eq!(next["state"], item["state"]);
        let delta = if item["id"] == outfit { 0 } else { 1 };
        assert_eq!(
            next["revision"].as_u64().unwrap(),
            item["revision"].as_u64().unwrap() + delta
        );
    }
    assert_eq!(
        place(
            &mut db,
            &ctx,
            &wide,
            0,
            Placement::Belt { cell: 0 },
            "replace"
        ),
        result
    );
    assert_eq!(list(&mut db), after);
}

fn magazine(db: &mut Database, ctx: &Context, item: &str, revision: u32, action: MoveAction, request: &str) -> Value {
    db.execute(&"a".repeat(64), Operation::MoveInventory(Move {
        request_id: request.into(), life: ctx.life, item: item.into(), revision, action,
    }, ctx.clone())).unwrap()
}

fn carried_item(view: &Value, id: &str) -> Value {
    view["items"].as_array().unwrap().iter().find(|item| item["id"] == id).cloned().unwrap_or(Value::Null)
}

fn loose_rounds(view: &Value, section: &str) -> u64 {
    view["items"].as_array().unwrap().iter()
        .filter(|item| item["section"] == section)
        .filter_map(|item| item["state"]["payload"]["rounds"].as_u64()).sum()
}

#[test]
fn attachments_preserve_instance_and_condition_and_unload_a_detached_launcher() {
    let (mut db, catalog, ctx, carry) = setup();
    let rifle = db.provision_inventory_item(
        &carry, "modular_rifle", &catalog.initial_state("modular_rifle").unwrap(), "slot:3",
    ).unwrap();
    let mut worn = catalog.initial_state("scope_zoom").unwrap();
    worn.condition = 0.625;
    let scope = db.provision_inventory_item(&carry, "scope_zoom", &worn, "rucksack").unwrap();
    let alternate = item(&mut db, &catalog, &carry, "scope");
    let silencer = item(&mut db, &catalog, &carry, "silencer");
    let launcher = item(&mut db, &catalog, &carry, "launcher");
    let attach = |addon: &str, addon_revision| MoveAction::Attach { addon: addon.into(), addon_revision };
    let detach = |slot| MoveAction::Detach { slot };
    let launcher_on = MoveAction::LauncherMode { active: true };
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, launcher_on.clone(), "no-launcher")["reason"], "no_launcher");
    let scope_result = magazine(&mut db, &ctx, &rifle, 0, attach(&scope, 0), "attach-scope");
    assert_eq!(scope_result["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, attach(&scope, 0), "attach-scope"), scope_result);
    let view = list(&mut db);
    assert!(carried_item(&view, &scope).is_null());
    let payload = &carried_item(&view, &rifle)["state"]["payload"];
    assert_eq!(payload["attachments"], json!(["scope_zoom"]));
    assert!(payload["attachment_items"].is_null());
    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, attach(&alternate, 0), "scope-occupied")["reason"], "addon_slot_occupied");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, attach(&silencer, 0), "attach-silencer")["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 2, attach(&launcher, 0), "attach-launcher")["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 3, detach(AttachmentSlot::Scope), "detach-scope")["status"], "committed");
    let restored = carried_item(&list(&mut db), &scope);
    assert_eq!(restored["state"], serde_json::to_value(worn).unwrap());
    assert_eq!(restored["revision"], 2);
    assert_eq!(magazine(&mut db, &ctx, &rifle, 4, attach(&scope, 0), "stale-addon")["reason"], "addon_revision_changed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 4, launcher_on.clone(), "select-attached")["status"], "committed");
    assert_eq!(carried_item(&list(&mut db), &rifle)["state"]["payload"]["launcher_mode"], true);

    // A weapon imported with a loaded underbarrel retains its ordinary
    // cartridge and returns its grenade when the launcher leaves the weapon.
    let mut imported = catalog.initial_state("modular_rifle").unwrap();
    let ItemPayload::Weapon { attachments, cartridges, launcher_cartridges, launcher_mode, .. } = &mut imported.payload else { unreachable!() };
    attachments.push("launcher".into());
    cartridges.push("ammo".into());
    launcher_cartridges.push("grenade".into());
    *launcher_mode = true;
    let spare = db.provision_inventory_item(&carry, "modular_rifle", &imported, "rucksack").unwrap();
    assert_eq!(magazine(&mut db, &ctx, &spare, 0, launcher_on, "select-rucksack")["reason"], "weapon_not_equipped");
    assert_eq!(magazine(&mut db, &ctx, &spare, 0, detach(AttachmentSlot::Launcher), "detach-loaded")["status"], "committed");
    let view = list(&mut db);
    let state = &carried_item(&view, &spare)["state"]["payload"];
    assert_eq!(state["attachments"], json!([]));
    assert_eq!(state["cartridges"], json!(["ammo"]));
    assert_eq!(state["launcher_cartridges"], json!([]));
    assert_eq!(state["launcher_mode"], false);
    assert_eq!(loose_rounds(&view, "grenade"), 1);
}

#[test]
fn attaching_from_a_corpse_requires_current_access_and_survives_another_death() {
    let (mut db, catalog, ctx, carry) = setup();
    let rifle = db.provision_inventory_item(
        &carry, "modular_rifle", &catalog.initial_state("modular_rifle").unwrap(), "slot:3",
    ).unwrap();
    let other_secret = "b".repeat(64);
    let other = db.execute(&other_secret, Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    let other_carry = db.initialize_inventory(&other).unwrap()["carried"].as_str().unwrap().to_owned();
    let addon = item(&mut db, &catalog, &other_carry, "scope");
    let attach = |addon_revision| MoveAction::Attach { addon: addon.clone(), addon_revision };
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, attach(0), "foreign-addon")["reason"], "addon_unavailable");
    let corpse_context = Context { principal: other, position: [10.0, 0.0, 0.0], ..ctx.clone() };
    let death = db.execute(&other_secret, Operation::InventoryDeath(corpse_context.clone())).unwrap();
    let corpse = death["corpse"].as_str().unwrap();
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, attach(1), "far-addon")["reason"], "addon_unavailable");
    let near = Context { position: corpse_context.position, ..ctx.clone() };
    assert_eq!(magazine(&mut db, &near, &rifle, 0, attach(1), "loot-addon")["status"], "committed");
    let corpse_view = db.execute(&"a".repeat(64), Operation::CorpseItems(corpse.into(), String::new(), None, near.clone())).unwrap();
    assert_eq!(corpse_view["items"], json!([]));
    let death = db.execute(&"a".repeat(64), Operation::InventoryDeath(near.clone())).unwrap();
    assert_eq!(death["status"], "committed");
    let third_secret = "c".repeat(64);
    let third = db.execute(&third_secret, Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    db.initialize_inventory(&third).unwrap();
    let third_ctx = Context { principal: third, ..near };
    let source = death["corpse"].as_str().unwrap();
    let act = |revision, request_id: &str, action| Operation::MoveInventory(Move {
        request_id: request_id.into(), life: 0, item: rifle.clone(), revision, action,
    }, third_ctx.clone());
    assert_eq!(db.execute(&third_secret, act(2, "take-rifle", MoveAction::Pickup { source: source.into() })).unwrap()["status"], "committed");
    assert_eq!(db.execute(&third_secret, act(3, "detach-looted", MoveAction::Detach { slot: AttachmentSlot::Scope })).unwrap()["status"], "committed");
    let view = db.execute(&third_secret, Operation::ListInventory(String::new(), None)).unwrap();
    assert_eq!(carried_item(&view, &addon)["revision"], 3);
    assert_eq!(carried_item(&view, &addon)["section"], "scope");
}

#[test]
fn magazine_reload_switch_and_unload_conserve_exact_owned_rounds() {
    let (mut db, catalog, ctx, carry) = setup();
    let mut state = catalog.initial_state("rifle").unwrap();
    state.condition = 0.65;
    state.upgrades.push("upgrade".into());
    let rifle = db.provision_inventory_item(&carry, "rifle", &state, "slot:3").unwrap();
    let first = item(&mut db, &catalog, &carry, "ammo");
    let second = item(&mut db, &catalog, &carry, "ammo");
    item(&mut db, &catalog, &carry, "ammo_ap");

    let result = magazine(&mut db, &ctx, &rifle, 0, MoveAction::Reload, "load");
    assert_eq!(result["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, MoveAction::Reload, "load"), result);
    let view = list(&mut db);
    assert!(carried_item(&view, &first).is_null());
    let box_after = carried_item(&view, &second);
    assert_eq!(box_after["state"]["payload"]["rounds"], 5);
    assert_eq!(box_after["revision"], 1);
    let loaded = carried_item(&view, &rifle);
    assert_eq!(loaded["state"]["payload"]["cartridges"], json!(vec!["ammo"; 35]));
    assert_eq!(loaded["state"]["upgrades"], json!(["upgrade"]));
    assert_eq!(loaded["revision"], 1);
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, MoveAction::Unload, "stale")["status"], "conflict");

    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, MoveAction::NextAmmo, "switch")["status"], "committed");
    let switched = list(&mut db);
    assert_eq!(loose_rounds(&switched, "ammo"), 40);
    let weapon = carried_item(&switched, &rifle);
    assert_eq!(weapon["state"]["payload"]["selected_ammunition"], "ammo_ap");
    assert_eq!(weapon["state"]["payload"]["cartridges"], json!(vec!["ammo_ap"; 15]));
    assert_eq!(weapon["state"]["condition"], loaded["state"]["condition"]);

    assert_eq!(magazine(&mut db, &ctx, &rifle, 2, MoveAction::Unload, "unload")["status"], "committed");
    let unloaded = list(&mut db);
    assert_eq!(loose_rounds(&unloaded, "ammo"), 40);
    assert_eq!(loose_rounds(&unloaded, "ammo_ap"), 15);
    assert_eq!(carried_item(&unloaded, &rifle)["state"]["payload"]["cartridges"], json!([]));
}

#[test]
fn shotgun_inserts_one_cartridge_and_launcher_keeps_the_rifle_magazine() {
    let (mut db, catalog, ctx, carry) = setup();
    let shotgun = db.provision_inventory_item(&carry, "shotgun", &catalog.initial_state("shotgun").unwrap(), "slot:2").unwrap();
    item(&mut db, &catalog, &carry, "ammo");
    item(&mut db, &catalog, &carry, "ammo_ap");
    assert_eq!(magazine(&mut db, &ctx, &shotgun, 0, MoveAction::Reload, "insert")["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &shotgun, 1, MoveAction::NextAmmo, "insert-ap")["status"], "committed");
    let mixed = list(&mut db);
    assert_eq!(carried_item(&mixed, &shotgun)["state"]["payload"]["cartridges"], json!(["ammo","ammo_ap"]));
    assert_eq!(loose_rounds(&mixed, "ammo"), 19);
    assert_eq!(loose_rounds(&mixed, "ammo_ap"), 14);
    assert_eq!(magazine(&mut db, &ctx, &shotgun, 2, MoveAction::Unload, "unload-mixed")["status"], "committed");
    let returned = list(&mut db);
    assert_eq!(loose_rounds(&returned, "ammo"), 20);
    assert_eq!(loose_rounds(&returned, "ammo_ap"), 15);

    let mut state = catalog.initial_state("rifle").unwrap();
    if let ItemPayload::Weapon { cartridges, fire_mode, .. } = &mut state.payload {
        cartridges.push("ammo".into());
        *fire_mode = 2;
    }
    let rifle = db.provision_inventory_item(&carry, "rifle", &state, "slot:3").unwrap();
    item(&mut db, &catalog, &carry, "grenade");
    let select = |active| MoveAction::LauncherMode { active };
    let selected = magazine(&mut db, &ctx, &rifle, 0, select(true), "select-launcher");
    assert_eq!(selected["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, select(true), "select-launcher"), selected);
    assert_eq!(magazine(&mut db, &ctx, &rifle, 0, select(false), "stale-selector")["status"], "conflict");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, select(true), "select-same")["reason"], "launcher_mode_unchanged");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, MoveAction::FireMode { next: true }, "selector-in-launcher")["reason"], "no_fire_selector");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 1, MoveAction::Reload, "load-launcher")["status"], "committed");
    let view = list(&mut db);
    let payload = &carried_item(&view, &rifle)["state"]["payload"];
    assert_eq!(payload["cartridges"], json!(["ammo"]));
    assert_eq!(payload["launcher_cartridges"], json!(["grenade"]));
    assert_eq!(payload["launcher_mode"], true);
    assert_eq!(payload["fire_mode"], 2);
    assert_eq!(loose_rounds(&view, "grenade"), 0);
    assert_eq!(magazine(&mut db, &ctx, &rifle, 2, select(false), "select-rifle")["status"], "committed");
    let rifle_mode = list(&mut db);
    let payload = &carried_item(&rifle_mode, &rifle)["state"]["payload"];
    assert_eq!(payload["launcher_mode"], false);
    assert_eq!(payload["launcher_cartridges"], json!(["grenade"]));
    assert_eq!(payload["fire_mode"], 2);
    assert_eq!(magazine(&mut db, &ctx, &rifle, 3, select(true), "reselect-launcher")["status"], "committed");
    assert_eq!(magazine(&mut db, &ctx, &rifle, 4, MoveAction::Unload, "unload-launcher")["status"], "committed");
    let view = list(&mut db);
    assert_eq!(carried_item(&view, &rifle)["state"]["payload"]["cartridges"], json!(["ammo"]));
    assert_eq!(loose_rounds(&view, "grenade"), 1);
}

#[tokio::test]
async fn launcher_debit_uses_stock_round_definition_without_spending_rifle_ammunition_or_wear() {
    let root = std::env::temp_dir().join(format!("zone-equipment-launcher-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let secret = "a".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
    let context = Context {
        principal, life: 0, auth_epoch: 0, world: "zaton".into(), position: [0.0; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None,
        expires: Instant::now() + Duration::from_secs(10),
    };
    let mut initial = catalog.initial_state("modular_rifle").unwrap();
    initial.condition = 0.5;
    let ItemPayload::Weapon { cartridges, launcher_cartridges, launcher_mode, attachments, jammed, .. } = &mut initial.payload else { unreachable!() };
    cartridges.push("ammo".into());
    launcher_cartridges.push("grenade".into());
    attachments.push("launcher".into());
    *launcher_mode = true;
    *jammed = true;
    let rifle = db.provision_inventory_item(&carry, "modular_rifle", &initial, "slot:3").unwrap();
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let fire = |queue| store.inventory_request(context.clone(), Operation::FireWeapon(rifle.clone(), None, queue)).unwrap();
    assert_eq!(fire(Some(1)).await.unwrap().unwrap()["reason"], "queue_complete");
    let charged = fire(Some(0)).await.unwrap().unwrap();
    assert_eq!(charged["shot"]["launcher"], json!({"section":"projectile","speed":30.0,"fuse_ticks":300,"blast_power":3.0,"blast_radius":4.0}));
    assert_eq!(charged["shot"]["ammo"], 0);
    assert_eq!(charged["shot"]["mass_spent"], 0.2);
    assert_eq!(fire(None).await.unwrap().unwrap()["reason"], "empty");
    store.flush().await.unwrap();
    drop(store);

    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (revision, raw): (u32, String) = conn.query_row(
        "SELECT revision,state FROM inventory_items WHERE id=?1", [&rifle],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    let ItemPayload::Weapon { launcher_cartridges, .. } = &mut initial.payload else { unreachable!() };
    launcher_cartridges.clear();
    assert_eq!(revision, 1);
    assert_eq!(serde_json::from_str::<ItemState>(&raw).unwrap(), initial);
    drop(conn);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owned_fire_charges_last_cartridge_and_wear_only_in_live_equipped_inventory() {
    let root = std::env::temp_dir().join(format!("zone-equipment-fire-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let secret = "a".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"]
        .as_str().unwrap().to_owned();
    let context = Context {
        principal,
        life: 0,
        auth_epoch: 0,
        world: "zaton".into(),
        position: [0.0; 3],
        interaction_radius: 2.0,
        eye_height: 1.55,
        collision: None,
        expires: Instant::now() + Duration::from_secs(10),
    };
    let mut state = catalog.initial_state("rifle").unwrap();
    state.upgrades.push("upgrade".into());
    if let ItemPayload::Weapon { cartridges, .. } = &mut state.payload {
        cartridges.extend(["ammo".into(), "ammo_ap".into()]);
    }
    let rifle = db.provision_inventory_item(&carry, "rifle", &state, "slot:3").unwrap();
    let stowed = db.provision_inventory_item(&carry, "rifle", &state, "rucksack").unwrap();
    assert!(db.execute(&secret, Operation::FireWeapon(rifle.clone(), None, None)).is_err());
    let other = db.execute(&"b".repeat(64), Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let shoot = |item: &str, context: Context| {
        store.inventory_request(context, Operation::FireWeapon(item.into(), None, None)).unwrap()
    };
    let mut wrong_context = context.clone();
    wrong_context.life = 1;
    assert_eq!(shoot(&rifle, wrong_context).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    let mut wrong_context = context.clone();
    wrong_context.principal = other;
    assert_eq!(shoot(&rifle, wrong_context).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    assert_eq!(shoot(&stowed, context.clone()).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    let result = shoot(&rifle, context).await.unwrap().unwrap();
    assert_eq!(result["shot"], json!({"ammo":1,"range":160.0,"damage":45,"interval":3,"mass_spent":0.5/15.0}));
    store.flush().await.unwrap();
    drop(store);
    let conn = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let read = |id: &str| -> (u32, ItemState) {
        let (revision, raw): (u32, String) = conn.query_row(
            "SELECT revision,state FROM inventory_items WHERE id=?1", [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        (revision, serde_json::from_str(&raw).unwrap())
    };
    let (revision, fired) = read(&rifle);
    assert_eq!(revision, 1);
    assert!((fired.condition - 0.996).abs() < 1e-6);
    assert_eq!(fired.upgrades, state.upgrades);
    assert!(matches!(fired.payload, ItemPayload::Weapon { cartridges, .. } if cartridges == ["ammo"]));
    assert_eq!(read(&stowed), (0, state));
    drop(conn);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn tri_state_reload_clears_jam_only_when_a_shell_is_inserted() {
    let (mut db, catalog, ctx, carry) = setup();
    let mut state = catalog.initial_state("shotgun").unwrap();
    let ItemPayload::Weapon { cartridges, jammed, .. } = &mut state.payload else {
        unreachable!()
    };
    cartridges.push("ammo".into());
    *jammed = true;
    let shotgun = db.provision_inventory_item(&carry, "shotgun", &state, "slot:2").unwrap();
    let denied = magazine(&mut db, &ctx, &shotgun, 0, MoveAction::Reload, "no-shells");
    assert_eq!(denied["reason"], "no_compatible_ammunition");
    assert_eq!(carried_item(&list(&mut db), &shotgun)["state"]["payload"]["jammed"], true);
    item(&mut db, &catalog, &carry, "ammo");
    assert_eq!(magazine(&mut db, &ctx, &shotgun, 0, MoveAction::Reload, "insert-shell")["status"], "committed");
    let view = list(&mut db);
    let state = &carried_item(&view, &shotgun)["state"]["payload"];
    assert!(!state["jammed"].as_bool().unwrap_or_default());
    assert_eq!(state["cartridges"], json!(["ammo", "ammo"]));
    assert_eq!(loose_rounds(&view, "ammo"), 19);
}

#[tokio::test]
async fn equipped_selector_wraps_and_held_rounds_use_cop_cadence_and_wear() {
    let root = std::env::temp_dir().join(format!("zone-equipment-modes-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let secret = "a".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"]
        .as_str().unwrap().to_owned();
    let ctx = Context {
        principal, life: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], interaction_radius: 2.0, eye_height: 1.55,
        collision: None, expires: Instant::now() + Duration::from_secs(30),
    };
    let mut rifle = catalog.initial_state("rifle").unwrap();
    let ItemPayload::Weapon { cartridges, .. } = &mut rifle.payload else { unreachable!() };
    cartridges.extend(std::iter::repeat_n("ammo".into(), 5));
    let weapon = db.provision_inventory_item(&carry, "rifle", &rifle, "slot:3").unwrap();
    let stowed = db.provision_inventory_item(&carry, "rifle", &rifle, "rucksack").unwrap();
    assert_eq!(magazine(&mut db, &ctx, &stowed, 0, MoveAction::FireMode { next: true }, "stowed-mode")["reason"], "weapon_not_equipped");
    assert_eq!(magazine(&mut db, &ctx, &weapon, 0, MoveAction::FireMode { next: true }, "single-mode")["status"], "committed");
    assert_eq!(carried_item(&list(&mut db), &weapon)["state"]["payload"]["fire_mode"], 1);
    assert_eq!(magazine(&mut db, &ctx, &weapon, 1, MoveAction::FireMode { next: false }, "auto-mode")["status"], "committed");
    assert_eq!(carried_item(&list(&mut db), &weapon)["state"]["payload"]["fire_mode"], 3);
    assert_eq!(magazine(&mut db, &ctx, &weapon, 2, MoveAction::FireMode { next: false }, "burst-mode")["status"], "committed");
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let fire = |index| {
        store.inventory_request(ctx.clone(), Operation::FireWeapon(weapon.clone(), None, Some(index))).unwrap()
    };
    let first = fire(0).await.unwrap().unwrap();
    assert_eq!(first["shot"]["queue"], json!({"limit":2,"ticks":1.5}));
    assert_eq!(first["shot"]["ammo"], 4);
    assert_eq!(fire(1).await.unwrap().unwrap()["shot"]["ammo"], 3);
    assert_eq!(fire(2).await.unwrap().unwrap()["reason"], "queue_complete");
    let view = store.inventory_request(ctx, Operation::ListInventory(String::new(), None)).unwrap().await.unwrap().unwrap();
    let item = carried_item(&view, &weapon);
    assert_eq!(item["revision"], 5);
    assert_eq!(item["state"]["payload"]["fire_mode"], 2);
    assert!((item["state"]["condition"].as_f64().unwrap() - 0.995).abs() < 1e-6);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owned_misfire_preserves_cartridge_and_wear_and_requires_reload_after_restart() {
    let root = std::env::temp_dir().join(format!("zone-equipment-jam-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let secret = "a".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"]
        .as_str().unwrap().to_owned();
    let context = Context {
        principal, life: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], interaction_radius: 2.0, eye_height: 1.55,
        collision: None, expires: Instant::now() + Duration::from_secs(30),
    };
    let mut state = catalog.initial_state("rifle").unwrap();
    state.condition = 0.05;
    let ItemPayload::Weapon { cartridges, .. } = &mut state.payload else { unreachable!() };
    cartridges.push("ammo".into());
    let rifle = db.provision_inventory_item(&carry, "rifle", &state, "slot:3").unwrap();
    drop(db);
    // A row written before jam state existed must still load and fire.
    let mut legacy = serde_json::to_value(&state).unwrap();
    legacy["payload"].as_object_mut().unwrap().remove("jammed");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE inventory_items SET state=?1 WHERE id=?2", [legacy.to_string(), rifle.clone()]).unwrap();
    drop(conn);
    let fire = |store: &Persistence| {
        store.inventory_request(context.clone(), Operation::FireWeapon(rifle.clone(), None, None)).unwrap()
    };
    let store = Persistence::start_with_catalog(&path, Some(catalog.clone())).unwrap();
    assert_eq!(fire(&store).await.unwrap().unwrap()["reason"], "misfire");
    store.flush().await.unwrap();
    drop(store);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    assert_eq!(fire(&store).await.unwrap().unwrap()["reason"], "jammed");
    let query = || Operation::ListInventory(String::new(), None);
    let view = store.inventory_request(context.clone(), query()).unwrap().await.unwrap().unwrap();
    let item = carried_item(&view, &rifle);
    assert_eq!(item["revision"], 1);
    let mut jammed_state = state.clone();
    let ItemPayload::Weapon { jammed, .. } = &mut jammed_state.payload else { unreachable!() };
    *jammed = true;
    assert_eq!(item["state"], serde_json::to_value(&jammed_state).unwrap());

    let command = Move {
        request_id: "4".repeat(32), life: 0, item: rifle.clone(), revision: 1,
        action: MoveAction::Reload,
    };
    let reload = || Operation::MoveInventory(command.clone(), context.clone());
    let first = store.inventory_request(context.clone(), reload()).unwrap().await.unwrap().unwrap();
    assert_eq!(first["status"], "committed");
    assert_eq!(store.inventory_request(context.clone(), reload()).unwrap().await.unwrap().unwrap(), first);
    let view = store.inventory_request(context, query()).unwrap().await.unwrap().unwrap();
    let item = carried_item(&view, &rifle);
    assert_eq!(item["revision"], 2);
    assert_eq!(item["state"], serde_json::to_value(state).unwrap());
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn private_storage_checks_owner_reach_revision_and_life_then_survives_death() {
    use zone_server::survival_rules::{StorageStation, SurvivalRules};
    let (mut db, catalog, context, carried) = setup();
    let a = "a".repeat(64);
    let b = "b".repeat(64);
    let other = db.execute(&b, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let mut foreign = context.clone();
    foreign.principal = other.clone();
    let mut distant = context.clone();
    distant.position[0] = 3.0;
    db.set_survival_rules(Arc::new(SurvivalRules {
        starter_kit: vec![],
        respawn_delay_seconds: 0,
        private_storage: Some(StorageStation {
            world: context.world.clone(),
            position: [0.0; 3],
            rotation: [0.0; 3],
            max_items: 1,
        }),
        ..SurvivalRules::default()
    })).unwrap();
    let own_store = db.initialize_inventory(&context.principal).unwrap()["storage"]
        .as_str().unwrap().to_owned();
    let other_store = db.initialize_inventory(&other).unwrap()["storage"]
        .as_str().unwrap().to_owned();
    let rifle = item(&mut db, &catalog, &carried, "rifle");
    let ammo = item(&mut db, &catalog, &carried, "ammo");
    let discovery = db.execute(&a, Operation::WorldItems(String::new(), context.clone())).unwrap();
    assert_eq!(discovery["storage"]["id"], own_store);
    assert_eq!(discovery["storage"]["position"], json!([0.0,0.0,0.0]));
    assert!(discovery["items"].as_array().unwrap().is_empty());
    let other_discovery = db.execute(&b, Operation::WorldItems(String::new(), foreign.clone())).unwrap();
    assert_eq!(other_discovery["storage"]["id"], other_store);
    let mut far = context.clone();
    far.position[0] = 33.0;
    assert!(db.execute(&a, Operation::WorldItems(String::new(), far)).unwrap().get("storage").is_none());

    let deposit = |id: &str, destination: &str, request: &str, context: &Context| Operation::MoveInventory(
        Move {request_id: request.into(), life: context.life, item: id.into(), revision: 0,
            action: MoveAction::Store {destination: destination.into()}}, context.clone()
    );
    let read = |source: &str, context: &Context| Operation::CorpseItems(
        source.into(), String::new(), None, context.clone()
    );
    assert_eq!(db.execute(&a, deposit(&rifle, &own_store, "far", &distant)).unwrap()["status"], "rejected");
    assert_eq!(db.execute(&a, deposit(&rifle, &other_store, "foreign", &context)).unwrap()["status"], "rejected");
    let committed = db.execute(&a, deposit(&rifle, &own_store, "store", &context)).unwrap();
    assert_eq!(committed["status"], "committed");
    assert_eq!(db.execute(&a, deposit(&rifle, &own_store, "store", &distant)).unwrap(), committed);
    assert_eq!(db.execute(&a, deposit(&ammo, &own_store, "full", &context)).unwrap()["reason"], "storage_full");
    assert!(db.execute(&a, read(&own_store, &distant)).unwrap().get("error").is_some());
    assert!(db.execute(&b, read(&own_store, &foreign)).unwrap().get("error").is_some());
    let before = db.execute(&a, read(&own_store, &context)).unwrap();
    assert_eq!(before["items"][0]["id"], rifle);
    assert_eq!(before["items"][0]["revision"], 1);
    assert_eq!(before["items"][0]["state"], json!(catalog.initial_state("rifle").unwrap()));

    let withdraw = |request: &str, revision: u32, context: &Context| Operation::MoveInventory(
        Move {request_id: request.into(), life: context.life, item: rifle.clone(), revision,
            action: MoveAction::Pickup {source: own_store.clone()}}, context.clone()
    );
    assert_eq!(db.execute(&b, withdraw("steal",1,&foreign)).unwrap()["status"], "rejected");
    assert_eq!(db.execute(&a, withdraw("far-take",1,&distant)).unwrap()["status"], "rejected");
    let death = db.execute(&a, Operation::InventoryDeath(context.clone())).unwrap();
    assert_eq!(death["status"], "committed");
    assert!(db.execute(&a, read(&own_store, &context)).unwrap().get("error").is_some());
    assert_eq!(db.execute(&a, withdraw("dead-take",1,&context)).unwrap()["reason"], "stale_or_dead_life");
    assert_eq!(db.execute(&a, Operation::InventoryRespawn(
        zone_server::inventory::Respawn {request_id:"spawn".into(),life:0}, context.clone()
    )).unwrap()["status"], "respawned");
    let mut respawned = context;
    respawned.life = 1;
    assert_eq!(db.execute(&a, read(&own_store,&respawned)).unwrap()["items"], before["items"]);
    assert_eq!(db.execute(&a, withdraw("stale",0,&respawned)).unwrap()["status"], "conflict");
    assert_eq!(db.execute(&a, withdraw("take",1,&respawned)).unwrap()["status"], "committed");
    assert_eq!(carried_item(&list(&mut db), &rifle)["revision"], 2);
    assert_eq!(db.execute(&a, read(&own_store,&respawned)).unwrap()["items"], json!([]));
    assert!(carried_item(&list(&mut db), &ammo).is_null());
}

fn blast_command(power: f32, revision: u32, state: zone_server::survival::State) -> Operation {
    use zone_server::survival::{Blast, Location, Record};
    Operation::ResolveBlast(Blast {
        power, before: Record { revision, state },
        location: Location { world: "zaton".into(), content_revision: "fixture".into(),
            position: [0.0; 3], yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 },
        combat_lock_ms: 60_000,
    })
}

#[tokio::test]
async fn blast_absorption_and_armour_wear_are_life_scoped_and_atomic() {
    use zone_server::{combat::ArmourImpact, survival::{BlastOutcome, State}};

    let root = std::env::temp_dir().join(format!("zone-blast-armour-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let secret = "a".repeat(64);
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
    let mut gear = |section, place, condition, upgrades: Vec<String>| {
        let mut state = catalog.initial_state(section).unwrap();
        state.condition = condition;
        state.upgrades = upgrades;
        db.provision_inventory_item(&carry, section, &state, place).unwrap()
    };
    let outfit = gear("outfit", "slot:7", 0.8, vec!["upgrade".into()]);
    let helmet = gear("helmet", "slot:12", 0.5, vec![]);
    let belt = gear("artefact", "belt:0", 0.25, vec![]);
    let spare = gear("artefact", "rucksack", 1.0, vec![]);
    assert!(db.execute(&secret, blast_command(0.9, 0, State::default())).is_err());
    drop(db);

    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_helmet_wear BEFORE UPDATE OF state ON inventory_items WHEN OLD.section='helmet' BEGIN SELECT RAISE(ABORT,'fixture rejected helmet wear'); END;").unwrap();
    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal, life: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], eye_height: 1.55, interaction_radius: 2.0, collision: None,
        expires: Instant::now() + Duration::from_secs(30) };
    let impact = |life| store.inventory_request(Context { life, ..context.clone() }, blast_command(0.9, 0, State::default())).unwrap();
    let condition = || -> (u32, State) {
        sql.query_row("SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1", [&context.principal], |row| {
            Ok((row.get(0)?, serde_json::from_str(&row.get::<_, String>(1)?).unwrap()))
        }).unwrap()
    };
    let read = |id: &str| -> (u32, ItemState) {
        sql.query_row("SELECT revision,state FROM inventory_items WHERE id=?1", [id], |row| {
            Ok((row.get(0)?, serde_json::from_str(&row.get::<_, String>(1)?).unwrap()))
        }).unwrap()
    };
    assert!(impact(0).await.unwrap().is_err());
    assert_eq!(read(&outfit).0, 0);
    assert_eq!(read(&helmet).0, 0);
    assert_eq!(condition().0, 0);
    assert_eq!(condition().1.health, 1.0);
    sql.execute_batch("DROP TRIGGER reject_helmet_wear").unwrap();
    assert_eq!(impact(1).await.unwrap().unwrap()["status"], "stale");
    let result: BlastOutcome = serde_json::from_value(impact(0).await.unwrap().unwrap()).unwrap();
    assert!(matches!(result, BlastOutcome::Applied { revision: 1, alive: true,
        impact: ArmourImpact::Hit { power, wound: true, gear_changed: true } } if (power - 0.2).abs() < 1e-6));
    assert_eq!(impact(0).await.unwrap().unwrap()["status"], "stale");
    let (revision, state) = condition();
    assert_eq!(revision, 1);
    assert!((state.health - 0.8).abs() < 1e-6 && (state.bleeding - 0.2).abs() < 1e-6);
    let Operation::ResolveBlast(stale) = blast_command(0.9, 0, State::default()) else { unreachable!() };
    let checkpoint = store.inventory_request(context.clone(), Operation::SaveCondition(stale.before, stale.location)).unwrap();
    assert_eq!(checkpoint.await.unwrap().unwrap()["saved"], false);
    sql.execute_batch("CREATE TRIGGER reject_corpse_transfer BEFORE UPDATE OF container ON inventory_items BEGIN SELECT RAISE(ABORT,'fixture rejected corpse transfer'); END;").unwrap();
    let lethal = store.inventory_request(context.clone(), blast_command(3.0, revision, state)).unwrap();
    assert!(lethal.await.unwrap().is_err());
    assert_eq!(condition().0, 1);
    assert_eq!(sql.query_row("SELECT count(*) FROM item_containers WHERE kind='corpse'", [], |row| row.get::<_, u32>(0)).unwrap(), 0);
    store.flush().await.unwrap();
    drop(store);
    let (revision, worn) = read(&outfit);
    assert_eq!(revision, 1);
    assert!((worn.condition - 0.695).abs() < 1e-6);
    assert_eq!(worn.upgrades, ["upgrade"]);
    assert_eq!(read(&helmet).0, 1);
    assert!((read(&helmet).1.condition - 0.425).abs() < 1e-6);
    assert_eq!(read(&belt).0, 0);
    assert_eq!(read(&belt).1.condition, 0.25);
    assert_eq!(read(&spare).0, 0);
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn blast_commit_survives_exit_before_the_simulation_receives_it() {
    use zone_server::survival::{Location, State};
    const CHILD_DB: &str = "ZONE_TEST_BLAST_CRASH_DB";
    if let Some(path) = std::env::var_os(CHILD_DB) {
        let path = std::path::PathBuf::from(path);
        let mut db = Database::open(&path).unwrap();
        let players = ["a", "b"].map(|key| db.execute(&key.repeat(64), Operation::Resume)
            .unwrap()["principalId"].as_str().unwrap().to_owned());
        drop(db);
        let store = Persistence::start_with_catalog(&path, Some(catalog())).unwrap();
        let [first, second] = players;
        let request = |principal, power| {
            let context = Context { principal, life: 0, auth_epoch: 0, world: "zaton".into(),
                position: [0.0; 3], eye_height: 1.55, interaction_radius: 2.0, collision: None,
                expires: Instant::now() + Duration::from_secs(30) };
            store.inventory_request(context, blast_command(power, 0, State::default())).unwrap()
        };
        let _survived = request(first, 0.6);
        let _lethal = request(second, 2.0);
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(store.flush()).unwrap();
        // The worker has committed both transactions. Exit without consuming
        // their replies or running a simulation checkpoint or destructor.
        std::process::exit(37);
    }

    let root = std::env::temp_dir().join(format!("zone-blast-crash-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let fixtures = ["a", "b"].map(|key| {
        let principal = db.execute(&key.repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
        let outfit = db.provision_inventory_item(&carry, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
        (principal, outfit)
    });
    drop(db);
    let exit = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "blast_commit_survives_exit_before_the_simulation_receives_it"])
        .env(CHILD_DB, &path).status().unwrap();
    assert_eq!(exit.code(), Some(37));
    let sql = rusqlite::Connection::open(&path).unwrap();
    for (index, (principal, outfit)) in fixtures.iter().enumerate() {
        let (alive, revision, raw, location, corpse): (bool, u32, String, Option<String>, Option<String>) = sql.query_row(
            "SELECT alive,condition_revision,condition,location,corpse FROM inventory_characters WHERE principal=?1",
            [principal], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
        let state: State = serde_json::from_str(&raw).unwrap();
        let (gear_revision, raw, kind, container): (u32, String, String, String) = sql.query_row(
            "SELECT i.revision,i.state,c.kind,c.id FROM inventory_items i JOIN item_containers c ON c.id=i.container WHERE i.id=?1",
            [outfit], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).unwrap();
        let gear: ItemState = serde_json::from_str(&raw).unwrap();
        assert_eq!(revision, 1);
        if index == 0 {
            assert!(alive && (state.health - 0.75).abs() < 1e-6 && (state.bleeding - 0.25).abs() < 1e-6);
            let saved: Location = serde_json::from_str(&location.unwrap()).unwrap();
            assert!(saved.combat_until_ms > 0);
            assert!(corpse.is_none() && kind == "carried" && gear_revision == 1 && (gear.condition - 0.94).abs() < 1e-6);
        } else {
            assert!(!alive && state.health == 0.0 && location.is_none());
            assert_eq!(corpse, Some(container));
            assert!(kind == "corpse" && gear_revision == 2 && (gear.condition - 0.8).abs() < 1e-6);
        }
    }
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owned_shots_commit_ammunition_and_condition_of_the_correct_armour_together() {
    use zone_server::{combat::{ArmourImpact, ChargedShot, ShotTarget}, world::CharacterKey};
    let root = std::env::temp_dir().join(format!("zone-armoured-shot-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let mut player = |key: &str| {
        let id = db.execute(&key.repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let carry = db.initialize_inventory(&id).unwrap()["carried"].as_str().unwrap().to_owned();
        (id, carry)
    };
    let (shooter, shooter_carry) = player("a");
    let (victim, victim_carry) = player("b");
    let mut rifle = catalog.initial_state("rifle").unwrap();
    let ItemPayload::Weapon { cartridges, .. } = &mut rifle.payload else { unreachable!() };
    cartridges.extend(["ammo", "ammo_ap", "ammo", "ammo", "ammo"].map(str::to_owned));
    let gun = db.provision_inventory_item(&shooter_carry, "rifle", &rifle, "slot:3").unwrap();
    let outfit = db.provision_inventory_item(&victim_carry, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
    let helmet = db.provision_inventory_item(&victim_carry, "helmet", &catalog.initial_state("helmet").unwrap(), "slot:12").unwrap();
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_shot_debit BEFORE UPDATE OF state ON inventory_items WHEN OLD.section='rifle' BEGIN SELECT RAISE(ABORT,'fixture rejected debit'); END;").unwrap();
    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal: shooter, life: 0, auth_epoch: 0, world: "zaton".into(), position: [0.; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None, expires: Instant::now() + Duration::from_secs(30) };
    let shoot = |bone, distance, life| {
        let target = ShotTarget { character: CharacterKey { principal: victim.clone(), life }, bone, distance };
        store.inventory_request(context.clone(), Operation::FireWeapon(gun.clone(), Some(target), None)).unwrap()
    };
    let read = |id: &str| -> (u32, ItemState) {
        sql.query_row("SELECT revision,state FROM inventory_items WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap()))
        }).unwrap()
    };
    assert!(shoot("bip01_spine2", 8.0, 0).await.unwrap().is_err());
    assert_eq!(read(&gun), (0, rifle));
    assert_eq!(read(&outfit).0, 0);
    sql.execute_batch("DROP TRIGGER reject_shot_debit").unwrap();
    let hit = |value: Value, rounds, expected_power, expected_wound| {
        let charged: ChargedShot = serde_json::from_value(value["shot"].clone()).unwrap();
        assert_eq!(charged.ammo, rounds);
        let Some(ArmourImpact::Hit {power, wound, gear_changed}) = charged.armour else { panic!("expected armoured impact"); };
        assert!((power - expected_power as f32).abs() < 1e-6);
        assert_eq!(wound, expected_wound);
        assert!(gear_changed);
    };
    hit(shoot("bip01_spine2", 8.0, 0).await.unwrap().unwrap(), 4, 0.075_f64, false);
    assert!((read(&outfit).1.condition - 0.97).abs() < 1e-6);
    assert_eq!(read(&helmet).0, 0);
    hit(shoot("bip01_head", 8.0, 0).await.unwrap().unwrap(), 3, 0.06, false);
    assert_eq!(read(&outfit).0, 1);
    assert!((read(&helmet).1.condition - 0.94).abs() < 1e-6);
    let far = shoot("bip01_spine2", 250.0, 0).await.unwrap().unwrap();
    assert!(far["shot"].get("armour").is_none());
    assert_eq!(read(&outfit).0, 1);
    hit(shoot("bip01_spine2", 8.0, 0).await.unwrap().unwrap(), 1, 0.1125, true);
    assert!((read(&outfit).1.condition - 0.925).abs() < 1e-6);
    let stale = shoot("bip01_spine2", 8.0, 1).await.unwrap().unwrap();
    assert_eq!(stale["shot"]["armour"], "Stale");
    assert_eq!(read(&outfit).0, 2);
    assert_eq!(read(&helmet).0, 1);
    drop(store);
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn consumption_spends_one_portion_with_effect_and_replays_across_restart() {
    use zone_server::{contract, survival::{Location, Record, State}, survival_rules::{SurvivalRules, unix_millis}};
    let root = std::env::temp_dir().join(format!("zone-equipment-consume-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let rules = Arc::new(SurvivalRules { starter_kit: vec![], ..SurvivalRules::default() });
    let secret = "a".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"]
        .as_str().unwrap().to_owned();
    let dose = item(&mut db, &catalog, &carry, "treatment");
    db.provision_inventory_item(&carry, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
    let artefact = ItemState { condition: 0.5, ..catalog.initial_state("artefact").unwrap() };
    db.provision_inventory_item(&carry, "artefact", &artefact, "belt:0").unwrap();
    let context = Context {
        principal, life: 0, auth_epoch: 0, world: "zaton".into(), position: [0.0; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None,
        expires: Instant::now() + Duration::from_secs(30),
    };
    let command = Move {
        request_id: "dose".into(), life: 0, item: dose.clone(), revision: 0,
        action: MoveAction::Consume,
    };
    let mut wounded = State::default();
    wounded.damage(50, true);
    let before = Record { revision: 0, state: wounded };
    let operation = || Operation::Consume(command.clone(), context.clone(), before.clone());
    assert!(db.execute(&secret, operation()).is_err());
    drop(db);
    let store = Persistence::start_with_rules(&path, Some(catalog.clone()), Some(rules.clone())).unwrap();
    let outcome = store.inventory_request(context.clone(), operation()).unwrap().await.unwrap().unwrap();
    assert_eq!(outcome["status"], "committed");
    assert_eq!(outcome["remaining"], 1);
    let loadout = &outcome["loadout"];
    assert!((loadout["mass"].as_f64().unwrap() - 5.56).abs() < 1e-8);
    assert_eq!(loadout["capacity_bonus"], 12.0);
    assert_eq!(loadout["power_loss"], 0.75);
    assert_eq!(loadout["outfit_allows_sprint"], false);
    let treated: Record = serde_json::from_value(outcome["condition"].clone()).unwrap();
    assert_eq!(treated.revision, 1);
    assert!((treated.state.health - 0.6).abs() < 1e-6);
    let contract = contract::current();
    let deadline = unix_millis().unwrap() + 60_000;
    let location = Location {
        world: contract.world.clone(), content_revision: contract.content_revision.clone(),
        position: [12.0, 0.0, 7.0], yaw: 2.0, crouched: true,
        combat_until_ms: deadline, logout_until_ms: deadline,
    };
    assert_eq!(store.inventory_request(context.clone(), Operation::SaveCondition(treated, location.clone())).unwrap().await.unwrap().unwrap()["saved"], true);
    let stale_location = Location { position: [0.0; 3], combat_until_ms: 0, logout_until_ms: 0, ..location.clone() };
    assert_eq!(store.inventory_request(context.clone(), Operation::SaveCondition(before.clone(), stale_location)).unwrap().await.unwrap().unwrap()["saved"], false);
    store.flush().await.unwrap();
    drop(store);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let (store, logouts) = Persistence::start_for_world(&path, Some(catalog), Some(rules), None, Some(contract)).unwrap();
    assert_eq!(logouts.len(), 1);
    assert_eq!(logouts[0].principal, context.principal);
    assert_eq!(logouts[0].location.logout_until_ms, deadline);
    assert_eq!(logouts[0].location.position, location.position);
    assert!((logouts[0].loadout.mass - 5.56).abs() < 1e-8);
    let loaded = store.inventory_request(context.clone(), Operation::LoadCondition).unwrap().await.unwrap().unwrap();
    assert_eq!(loaded["condition"], outcome["condition"]);
    assert_eq!(loaded["location"], serde_json::to_value(location).unwrap());
    assert_eq!(store.inventory_request(context.clone(), operation()).unwrap().await.unwrap().unwrap(), outcome);
    let view = store.execute(secret, Operation::ListInventory(String::new(), None)).await.unwrap();
    let remaining = carried_item(&view, &dose);
    assert_eq!(remaining["revision"], 1);
    assert_eq!(remaining["state"]["payload"]["uses"], 1);
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
