use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use zone_server::{
    ballistics::{RoundProfile, SurfaceProfile},
    catalog::Catalog,
    combat::FireState,
    equipment::Placement,
    inventory::{AttachmentSlot, Context, ItemPayload, ItemState, Move, MoveAction},
    persistence::{Database, Operation, Persistence},
};

// Synthetic values exercise rules without checking copyrighted configuration data
// into Git. The separate catalog-check tool validates the actual extracted catalog.
fn catalog() -> Arc<Catalog> {
    fixture_catalog(false)
}
fn fixture_catalog(ballistics: bool) -> Arc<Catalog> {
    let definitions = [
        ("wpn_knife",vec![("class","WP_KNIFE"),("slot","0"),("inv_weight","0.3"),
            ("hit_type","wound"),("hit_type_2","wound"),("hit_power","0.4"),("hit_power_2","0.6"),
            ("splash1_dist","1"),("splash2_dist","1"),("splash2_radius","1"),
            ("splash1_direction","0,0,1"),("splash2_direction","0,0,1"),("splash2_hits_count","3"),
            ("splash1_pervictim_hcount","1"),("splash_hit_divide_factor","0.75")]),
        ("hand_f1", vec![("class", "G_F1_S"), ("slot", "3"), ("inv_weight", "0.6"),
            ("force_min", "10"), ("force_const", "25"), ("force_max", "30"), ("force_grow_speed", "20"),
            ("destroy_time", "2500"), ("blast", "3"), ("blast_r", "5"), ("hit_type_blast", "explosion")]),
        ("hand_smoke", vec![("class", "G_RGD5_S"), ("slot", "3"), ("inv_weight", "0.4"),
            ("force_min", "10"), ("force_const", "25"), ("force_max", "30"), ("force_grow_speed", "15"),
            ("destroy_time", "2500"), ("blast", "0"), ("blast_r", "0"), ("hit_type_blast", "strike")]),
        ("actor", vec![("condition_sect", "actor_condition")]),
        ("actor_condition", vec![("health_hit_part", "1"), ("power_hit_part", "0.1")]),
        ("actor_immunities_gd_master", vec![("radiation_immunity", "1"), ("chemical_burn_immunity", "1"),
            ("burn_immunity", "1"), ("telepatic_immunity", "1")]),
        ("inventory_box", vec![("class", "S_INVBOX")]),
        ("treatment", vec![("class", "S_FOOD"), ("inv_weight", "0.1"),
            ("eat_portions_num", "2"), ("max_uses", "2"), ("use_condition", "true"), ("empty_weight", "0.02"), ("eat_health", "0.1"), ("eat_power", "0"), ("eat_satiety", "0"), ("eat_radiation", "0"), ("wounds_heal_perc", "0"),
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
                ("radiation_protection", "0.003"),
                ("chemical_burn_protection", "0.2"),
                ("bleeding_restore_speed", "0.001"),
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
                ("hit_fraction_actor", "0.2"), ("explosion_protection", "0.2"),
                ("radiation_protection", "0.001")],
        ),
        ("outfit_bones", vec![("bip01_head", "1,-1"), ("bip01_spine2", "1,0.65")]),
        ("helmet_bones", vec![("bip01_head", "1,0.55"), ("bip01_spine2", "1,-1")]),
        ("outfit_immunity", vec![("fire_wound_immunity", "0.1"), ("explosion_immunity", "0.1"), ("chemical_burn_immunity", "0.1")]),
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
                ("health_restore_speed", "0.002"),
                ("radiation_restore_speed", "0.006"),
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
    if ballistics {
        sections.insert("mp_bullet_manager", json!({"source":"fixture.ltx","values":{"gravity_const":"9.81"}}));
        sections.insert("bullet_manager", json!({"source":"fixture.ltx","values":{"air_resistance_k":"1"}}));
        sections.get_mut("rifle").unwrap()["values"]["bullet_speed"] = json!("600");
        sections.get_mut("ammo_ap").unwrap()["values"]["k_air_resistance"] = json!("1.5");
        let mut buck = sections["ammo"].clone();
        buck["values"]["inv_name"] = json!("buck");
        buck["values"]["buck_shot"] = json!("15");
        buck["values"]["k_hit"] = json!("0.3");
        buck["values"]["k_disp"] = json!("15");
        sections.insert("buck", buck);
        let shotgun = &mut sections.get_mut("shotgun").unwrap()["values"];
        shotgun["ammo_class"] = json!("ammo,ammo_ap,buck");
        shotgun["bullet_speed"] = json!("240");
        shotgun["fire_distance"] = json!("100");
        shotgun["fire_dispersion_base"] = json!("0.2");
        shotgun["fire_dispersion_condition_factor"] = json!("1.5");
        shotgun["condition_shot_dec"] = json!("0.0045");
        shotgun["rpm"] = json!("600");
        shotgun["hit_power"] = json!("0.52");
    }
    Arc::new(Catalog::from_bytes(&serde_json::to_vec(&json!({"schema":1,"entry":"system.ltx","files":[{"path":"fixture.ltx","sha256":"0".repeat(64)}],"sections":sections})).unwrap()).unwrap())
}

#[tokio::test]
async fn buckshot_debits_once_and_rolls_back_every_victim_on_failure() {
    use zone_server::{combat::ShotTarget, survival::{FireVictim, Location, Record, ShotVictim, State}, world::CharacterKey};
    let root = std::env::temp_dir().join(format!("zone-buckshot-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = fixture_catalog(true);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let [(shooter, carry), (victim_a, carry_a), (victim_b, carry_b)] = ['a', 'b', 'c'].map(|key| {
        let principal = db.execute(&key.to_string().repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let carried = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
        (principal, carried)
    });
    let mut loaded = catalog.initial_state("shotgun").unwrap();
    let ItemPayload::Weapon { cartridges, .. } = &mut loaded.payload else { unreachable!() };
    cartridges.extend(["ammo".into(), "buck".into()]);
    let gun = db.provision_inventory_item(&carry, "shotgun", &loaded, "slot:3").unwrap();
    let carried_to_corpse = item(&mut db, &catalog, &carry_a, "ammo");
    let outfit = db.provision_inventory_item(&carry_b, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal: shooter, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], eye_height: 1.55, interaction_radius: 2.0, collision: None,
        expires: Instant::now() + Duration::from_secs(30) };
    let at = |position| Location { world: context.world.clone(), content_revision: "fixture".into(), position,
        yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 };
    let group = |principal: &str, x, health, count: usize| {
        let target = ShotTarget { character: CharacterKey { principal: principal.into(), life: 0 },
            bone: "bip01_spine2".into(), distance: 8.0, speed_factor: 1.0, penetration: None };
        let mut state = State::default();
        state.health = health;
        let authority = ShotVictim {
            target: target.clone(), context: Context { principal: principal.into(), position: [x, 0.0, 8.0], ..context.clone() },
            before: Record { revision: 0, state },
            location: at([x as f32, 0.0, 8.0]), shooter_location: at([0.0; 3]), combat_lock_ms: 60_000,
        };
        FireVictim { authority, native: None, additional: vec![target; count - 1] }
    };
    let joined = store.inventory_request(context.clone(), Operation::LoadCondition).unwrap().await.unwrap().unwrap();
    let profile: RoundProfile = serde_json::from_value(joined["loadout"]["ballistics"].clone()).unwrap();
    assert_eq!(profile.pellets, 15);
    assert!(profile.spread.first > 3.0_f32.to_radians());
    let fire = || store.inventory_request(context.clone(), Operation::FireWeapon(gun.clone(),
        vec![group(&victim_a, -0.4, 0.2, 3), group(&victim_b, 0.4, 1.0, 2)],
        FireState { traced: Some(profile), ..Default::default() })).unwrap();

    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch(&format!("CREATE TRIGGER reject_second_victim BEFORE UPDATE OF condition ON inventory_characters
        WHEN OLD.principal='{victim_b}' BEGIN SELECT RAISE(ABORT,'second victim failed'); END;")).unwrap();
    let item_revision = |id: &str| sql.query_row("SELECT revision FROM inventory_items WHERE id=?1", [id], |row| row.get::<_, u32>(0)).unwrap();
    let char_state = |id: &str| sql.query_row("SELECT alive,condition_revision,corpse FROM inventory_characters WHERE principal=?1", [id],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, u32>(1)?, row.get::<_, Option<String>>(2)?))).unwrap();
    assert!(fire().await.unwrap().is_err());
    assert_eq!(item_revision(&gun), 0);
    assert_eq!(item_revision(&outfit), 0);
    assert_eq!(char_state(&victim_a), (true, 0, None));
    assert_eq!(char_state(&victim_b), (true, 0, None));
    sql.execute_batch("DROP TRIGGER reject_second_victim").unwrap();

    let outcome = fire().await.unwrap().unwrap();
    assert_eq!(outcome["shot"]["ammo"], 1);
    assert_eq!(outcome["ballistics"]["pellets"], 1);
    assert_eq!(outcome["volley"][0]["applied_pellets"], 2);
    assert_eq!(outcome["volley"][1]["applied_pellets"], 2);
    assert_eq!(item_revision(&gun), 1);
    assert_eq!(item_revision(&outfit), 2);
    assert_eq!(char_state(&victim_b), (true, 1, None));
    let (alive, revision, corpse) = char_state(&victim_a);
    assert_eq!((alive, revision), (false, 1));
    let corpse_item_container: String = sql.query_row("SELECT container FROM inventory_items WHERE id=?1", [&carried_to_corpse], |row| row.get(0)).unwrap();
    assert_eq!(corpse, Some(corpse_item_container));
    let raw: String = sql.query_row("SELECT state FROM inventory_items WHERE id=?1", [&gun], |row| row.get(0)).unwrap();
    let weapon: ItemState = serde_json::from_str(&raw).unwrap();
    assert!((weapon.condition - 0.9955).abs() < 0.000_001);
    assert!(matches!(weapon.payload, ItemPayload::Weapon { cartridges, .. } if cartridges == ["ammo"]));
    drop(sql);
    store.flush().await.unwrap();
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn native_buckshot_commits_full_state_and_ammo_atomically() {
    use zone_server::{combat::ShotTarget, survival::{FireVictim, Location, Record, ShotVictim, State}, world::CharacterKey};
    let root = std::env::temp_dir().join(format!("zone-native-buckshot-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = fixture_catalog(true);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let [(shooter, carry), (victim_a, carry_a), (victim_b, carry_b)] = ['a', 'b', 'c'].map(|key| {
        let principal = db.execute(&key.to_string().repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let carried = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
        (principal, carried)
    });
    let mut loaded = catalog.initial_state("shotgun").unwrap();
    let ItemPayload::Weapon { cartridges, .. } = &mut loaded.payload else { unreachable!() };
    cartridges.extend(["ammo".into(), "buck".into()]);
    let gun = db.provision_inventory_item(&carry, "shotgun", &loaded, "slot:3").unwrap();
    let knife=db.provision_inventory_item(&carry,"wpn_knife",&catalog.initial_state("wpn_knife").unwrap(),"slot:1").unwrap();
    let carried_to_corpse = item(&mut db, &catalog, &carry_a, "ammo");
    let outfit = db.provision_inventory_item(&carry_b, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal: shooter, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], eye_height: 1.55, interaction_radius: 2.0, collision: None,
        expires: Instant::now() + Duration::from_secs(30) };
    let at = |position| Location { world: context.world.clone(), content_revision: "fixture".into(), position,
        yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 };
    let checkpoint = |health:f32| {
        let mut bytes=b"ZCS1".to_vec(); let mut values=[0.0f32;52];
        values[0]=health;values[1]=0.63;values[5]=1.0;values[18]=1.0;values[19]=50.0;values[20]=60.0;
        for value in values {bytes.extend_from_slice(&value.to_le_bytes());}
        for value in [0u32,16,0,0] {bytes.extend_from_slice(&value.to_le_bytes());}
        zone_server::native_condition::Checkpoint::parse(bytes).unwrap()
    };
    let native_state = |health| {
        let mut raw=serde_json::to_value(State::default()).unwrap();
        raw["health"]=json!(health);raw["power"]=json!(0.63);
        raw["native_checkpoint"]=serde_json::to_value(checkpoint(health)).unwrap();
        serde_json::from_value::<State>(raw).unwrap()
    };
    let seed=rusqlite::Connection::open(&path).unwrap();
    for (id,health) in [(&victim_a,0.2),(&victim_b,1.0)] {
        seed.execute("UPDATE inventory_characters SET condition=?1 WHERE principal=?2",
            rusqlite::params![serde_json::to_string(&native_state(health)).unwrap(),id]).unwrap();
    }
    let joined = store.inventory_request(context.clone(), Operation::LoadCondition).unwrap().await.unwrap().unwrap();
    let profile: RoundProfile = serde_json::from_value(joined["loadout"]["ballistics"].clone()).unwrap();
    let group = |principal: &str, x, health, count: usize| {
        let target = ShotTarget { character: CharacterKey { principal: principal.into(), life: 0 },
            bone: "bip01_spine2".into(), distance: 8.0, speed_factor: 1.0, penetration: None };
        let state = native_state(health);
        let authority = ShotVictim {
            target: target.clone(), context: Context { principal: principal.into(), position: [x, 0.0, 8.0], ..context.clone() },
            before: Record { revision: 0, state },
            location: at([x as f32, 0.0, 8.0]), shooter_location: at([0.0; 3]), combat_lock_ms: 60_000,
        };
        let equipment=seed.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",[principal],|r|r.get::<_,i64>(0)).unwrap() as u64;
        FireVictim { authority, native: Some(zone_server::native_condition::Shot {
            attack:zone_server::native_condition::Attack::Firearm(profile),equipment,result:zone_server::native_condition::ResultState {
                checkpoint:checkpoint(if principal==victim_a {0.0} else {0.44}),
                wear:Some([if principal==victim_b {Some(0.37)} else {None},None]) }}),
            additional: vec![target; count - 1] }
    };
    let joined = store.inventory_request(context.clone(), Operation::LoadCondition).unwrap().await.unwrap().unwrap();
    let profile: RoundProfile = serde_json::from_value(joined["loadout"]["ballistics"].clone()).unwrap();
    assert_eq!(profile.pellets, 15);
    assert!(profile.spread.first > 3.0_f32.to_radians());
    let fire = || store.inventory_request(context.clone(), Operation::FireWeapon(gun.clone(),
        vec![group(&victim_a, -0.4, 0.2, 3), group(&victim_b, 0.4, 1.0, 2)],
        FireState { traced: Some(profile), ..Default::default() })).unwrap();

    let sql = rusqlite::Connection::open(&path).unwrap();
    sql.execute_batch(&format!("CREATE TRIGGER reject_second_victim BEFORE UPDATE OF condition ON inventory_characters
        WHEN OLD.principal='{victim_b}' BEGIN SELECT RAISE(ABORT,'second victim failed'); END;")).unwrap();
    let item_revision = |id: &str| sql.query_row("SELECT revision FROM inventory_items WHERE id=?1", [id], |row| row.get::<_, u32>(0)).unwrap();
    let char_state = |id: &str| sql.query_row("SELECT alive,condition_revision,corpse FROM inventory_characters WHERE principal=?1", [id],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, u32>(1)?, row.get::<_, Option<String>>(2)?))).unwrap();
    assert!(fire().await.unwrap().is_err());
    assert_eq!(item_revision(&gun), 0);
    assert_eq!(item_revision(&outfit), 0);
    assert_eq!(char_state(&victim_a), (true, 0, None));
    assert_eq!(char_state(&victim_b), (true, 0, None));
    sql.execute_batch("DROP TRIGGER reject_second_victim").unwrap();

    let mut stale_round=group(&victim_b,0.4,1.0,2);
    stale_round.native.as_mut().unwrap().attack=zone_server::native_condition::Attack::Firearm(RoundProfile{revision:profile.revision+1,..profile});
    let rejected=store.inventory_request(context.clone(),Operation::FireWeapon(gun.clone(),vec![stale_round],
        FireState{traced:Some(profile),..Default::default()})).unwrap().await.unwrap().unwrap();
    assert_eq!(rejected["reason"],"stale_native_ballistics");
    for mode in 0..3 {
        let mut victim=group(&victim_b,0.4,1.0,2);
        match mode {
            0=>victim.native.as_mut().unwrap().equipment+=1,
            1=>victim.authority.before.revision+=1,
            _=>victim.native=None,
        }
        assert!(store.inventory_request(context.clone(),Operation::FireWeapon(gun.clone(),vec![victim],
            FireState{traced:Some(profile),..Default::default()})).unwrap().await.unwrap().is_err());
        assert_eq!(item_revision(&gun),0);
        assert_eq!(item_revision(&outfit),0);
        assert_eq!(char_state(&victim_b),(true,0,None));
    }

    let outcome = fire().await.unwrap().unwrap();
    assert_eq!(outcome["shot"]["ammo"], 1);
    assert_eq!(outcome["ballistics"]["pellets"], 1);
    assert_eq!(outcome["volley"][0]["applied_pellets"], 3);
    assert_eq!(outcome["volley"][1]["applied_pellets"], 2);
    assert_eq!(item_revision(&gun), 1);
    assert_eq!(item_revision(&outfit), 1);
    let state:State=serde_json::from_value(outcome["volley"][1]["native_state"].clone()).unwrap();
    assert_eq!(state.native_checkpoint(),Some(&checkpoint(0.44)));
    assert_eq!(state.health,0.44);assert_eq!(state.power,0.63);
    assert_eq!(char_state(&victim_b), (true, 1, None));
    let (alive, revision, corpse) = char_state(&victim_a);
    assert_eq!((alive, revision), (false, 1));
    let corpse_item_container: String = sql.query_row("SELECT container FROM inventory_items WHERE id=?1", [&carried_to_corpse], |row| row.get(0)).unwrap();
    assert_eq!(corpse, Some(corpse_item_container));
    let raw: String = sql.query_row("SELECT state FROM inventory_items WHERE id=?1", [&gun], |row| row.get(0)).unwrap();
    let weapon: ItemState = serde_json::from_str(&raw).unwrap();
    assert!((weapon.condition - 0.9955).abs() < 0.000_001);
    assert!(matches!(weapon.payload, ItemPayload::Weapon { cartridges, .. } if cartridges == ["ammo"]));
    // The same native condition path handles melee without synthesizing
    // health or wounds in Rust. Mode and splash selection bind the proposal.
    store.inventory_request(context.clone(),Operation::SelectWeapon{life:0,slot:1}).unwrap().await.unwrap().unwrap();
    let melee=|| {
        let mut victim=group(&victim_b,0.4,0.44,1);
        victim.authority.before.revision=1;
        victim.authority.target.distance=0.8;
        let native=victim.native.as_mut().unwrap();
        native.attack=zone_server::native_condition::Attack::Knife{mode:zone_server::knife::Mode::Stab,splash:true};
        native.result.checkpoint=checkpoint(0.31);
        native.result.wear=Some([Some(0.29),None]);
        victim
    };
    assert!(store.inventory_request(context.clone(),Operation::StrikeKnife(knife.clone(),zone_server::knife::Mode::Slash,
        Some(Box::new(melee())),true)).unwrap().await.unwrap().is_err());
    assert_eq!(char_state(&victim_b),(true,1,None));assert_eq!(item_revision(&outfit),1);
    sql.execute_batch("CREATE TRIGGER reject_melee BEFORE UPDATE OF condition ON inventory_characters
        BEGIN SELECT RAISE(ABORT,'native melee failure'); END;").unwrap();
    assert!(store.inventory_request(context.clone(),Operation::StrikeKnife(knife.clone(),zone_server::knife::Mode::Stab,
        Some(Box::new(melee())),true)).unwrap().await.unwrap().is_err());
    assert_eq!(char_state(&victim_b),(true,1,None));assert_eq!(item_revision(&outfit),1);
    sql.execute_batch("DROP TRIGGER reject_melee").unwrap();
    let hit=store.inventory_request(context.clone(),Operation::StrikeKnife(knife,zone_server::knife::Mode::Stab,
        Some(Box::new(melee())),true)).unwrap().await.unwrap().unwrap();
    let state:State=serde_json::from_value(hit["volley"][0]["native_state"].clone()).unwrap();
    assert_eq!(state.native_checkpoint(),Some(&checkpoint(0.31)));
    assert_eq!(char_state(&victim_b),(true,2,None));assert_eq!(item_revision(&outfit),2);
    assert_eq!(item_revision(&gun),1);
    drop(sql);
    drop(seed);
    store.flush().await.unwrap();
    drop(store);
    std::fs::remove_dir_all(root).unwrap();
}
fn setup() -> (Database, Arc<Catalog>, Context, String) {
    setup_at(Path::new(":memory:"))
}
fn setup_at(path: &Path) -> (Database, Arc<Catalog>, Context, String) {
    let catalog = catalog();
    let mut db = Database::open(path).unwrap();
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
        visit: 0, auth_epoch: 0,
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
fn corpse_and_drop_expiry_preserve_carried_and_private_items_across_restart() {
    use zone_server::survival_rules::{SurvivalRules, unix_millis};
    let root = std::env::temp_dir().join(format!("zone-inventory-expiry-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let (mut db, cat, ctx, carry) = setup_at(&path);
    let rules = Arc::new(SurvivalRules {
        starter_kit: vec![],
        respawn_delay_seconds: 3600,
        ..SurvivalRules::default()
    });
    db.set_survival_rules(rules.clone()).unwrap();
    let stored_container = db.initialize_inventory(&ctx.principal).unwrap()["storage"]
        .as_str()
        .unwrap()
        .to_owned();
    let stored = item(&mut db, &cat, &stored_container, "ammo");
    let carried = item(&mut db, &cat, &carry, "rifle");
    let dropped = item(&mut db, &cat, &carry, "ammo");
    let other_secret = "b".repeat(64);
    let other = db.execute(&other_secret, Operation::Register).unwrap()["principalId"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_carry = db.initialize_inventory(&other).unwrap()["carried"]
        .as_str()
        .unwrap()
        .to_owned();
    let other_item = item(&mut db, &cat, &other_carry, "rifle");
    let before_drop = unix_millis().unwrap();
    let drop_result = db.execute(
        &"a".repeat(64),
        Operation::MoveInventory(
            Move {
                request_id: "drop-expiry".into(),
                life: 0,
                item: dropped.clone(),
                revision: 0,
                action: MoveAction::Drop,
            },
            ctx.clone(),
        ),
    )
    .unwrap();
    assert_eq!(drop_result["status"], "committed");
    assert_eq!(list(&mut db)["items"][0]["id"], carried);
    let death = db
        .execute(&"a".repeat(64), Operation::InventoryDeath(ctx.clone()))
        .unwrap();
    assert_eq!(death["status"], "committed");
    let after_death = unix_millis().unwrap();
    drop(db);

    let mut db = Database::open(&path).unwrap();
    db.set_catalog(cat);
    db.set_survival_rules(rules.clone()).unwrap();
    assert_eq!(db.expire_inventory(before_drop).unwrap(), 0);
    assert_eq!(list(&mut db)["corpse"], death["corpse"]);
    assert_eq!(
        db.expire_inventory(after_death + i64::from(rules.dropped_item_lifetime_seconds) * 1000)
            .unwrap(),
        1
    );
    assert_eq!(list(&mut db)["corpse"], death["corpse"]);
    assert_eq!(
        db.expire_inventory(after_death + i64::from(rules.corpse_lifetime_seconds) * 1000)
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
    let other_inventory = db
        .execute(&other_secret, Operation::ListInventory(String::new(), None))
        .unwrap();
    assert_eq!(other_inventory["items"][0]["id"], other_item);
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    let stored_after: String = sql
        .query_row(
            "SELECT container FROM inventory_items WHERE id=?1",
            [&stored],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_after, stored_container);
    let expired_items: i64 = sql
        .query_row(
            "SELECT COUNT(*) FROM inventory_items WHERE id IN (?1,?2)",
            [&dropped, &carried],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(expired_items, 0);
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
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
        principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(), position: [0.0; 3],
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
    let fire = |queue| store.inventory_request(context.clone(), Operation::FireWeapon(rifle.clone(), Vec::new(), FireState { queue_index: queue, ..Default::default() })).unwrap();
    assert_eq!(fire(Some(1)).await.unwrap().unwrap()["reason"], "queue_complete");
    let charged = fire(Some(0)).await.unwrap().unwrap();
    assert_eq!(charged["shot"]["launcher"], json!({"section":"projectile","speed":30.0,"timed":false,"fuse_ticks":300,"blast_power":3.0,"blast_radius":4.0}));
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
    let catalog = fixture_catalog(true);
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
        visit: 0, auth_epoch: 0,
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
    assert!(db.execute(&secret, Operation::FireWeapon(rifle.clone(), Vec::new(), Default::default())).is_err());
    let other = db.execute(&"b".repeat(64), Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    drop(db);

    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let shoot = |item: &str, context: Context| {
        store.inventory_request(context, Operation::FireWeapon(item.into(), Vec::new(), Default::default())).unwrap()
    };
    let mut wrong_context = context.clone();
    wrong_context.life = 1;
    assert_eq!(shoot(&rifle, wrong_context).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    let mut wrong_context = context.clone();
    wrong_context.principal = other;
    assert_eq!(shoot(&rifle, wrong_context).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    assert_eq!(shoot(&stowed, context.clone()).await.unwrap().unwrap()["reason"], "weapon_not_equipped");
    let select = |slot| store.inventory_request(context.clone(), Operation::SelectWeapon { life: 0, slot }).unwrap();
    let holstered = select(0).await.unwrap().unwrap();
    assert_eq!(holstered["status"], "selected");
    assert_eq!(holstered["loadout"]["active_weapon_slot"], 0);
    assert_eq!(shoot(&rifle, context.clone()).await.unwrap().unwrap()["reason"], "weapon_not_drawn");
    let drawn = select(3).await.unwrap().unwrap();
    assert_eq!(drawn["loadout"]["active_weapon_slot"], 3);
    let profile: RoundProfile = serde_json::from_value(drawn["loadout"]["ballistics"].clone()).unwrap();
    let surface = SurfaceProfile { penetration: 0.75, ricochet: true, magnetic: false, energy_min: 0.8, energy_max: 0.5 };
    assert_eq!(profile, RoundProfile { revision: 0, key: profile.key, range: 160.0, speed: 600.0, drag: 1.5, gravity: 9.81, pellets: 1, spread: Default::default(), surface });
    let fire = |traced| store.inventory_request(context.clone(), Operation::FireWeapon(
        rifle.clone(), Vec::new(), FireState { traced: Some(traced), ..Default::default() },
    )).unwrap();
    let stale = fire(RoundProfile { revision: 1, ..profile }).await.unwrap().unwrap();
    assert_eq!(stale["reason"], "stale_ballistics");
    let result = fire(profile).await.unwrap().unwrap();
    let next: RoundProfile = serde_json::from_value(result["ballistics"].clone()).unwrap();
    assert!(next.key.is_some() && next.key != profile.key);
    assert_eq!(next, RoundProfile { revision: 1, key: next.key, range: 200.0, drag: 1.0, surface: SurfaceProfile { penetration: 0.35, ..surface }, ..profile });
    assert_eq!(result["shot"], json!({
        "ammo": 1,
        "range": 160.0,
        "damage": 45,
        "interval": 3,
        "mass_spent": 0.5 / 15.0,
        "native_damage": {
            "kind": "Bullet",
            "power": [f64::from(0.45_f32), 0.0, 0.0],
            "penetration": 0.75,
            "impulse": 0.0,
        },
    }));
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
        principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
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
        store.inventory_request(ctx.clone(), Operation::FireWeapon(weapon.clone(), Vec::new(), FireState { queue_index: Some(index), ..Default::default() })).unwrap()
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
        principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
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
        store.inventory_request(context.clone(), Operation::FireWeapon(rifle.clone(), Vec::new(), Default::default())).unwrap()
    };
    let store = Persistence::start_with_catalog(&path, Some(catalog.clone())).unwrap();
    assert_eq!(fire(&store).await.unwrap().unwrap()["reason"], "misfire");
    store.flush().await.unwrap();
    drop(store);

    // Dropping the last sender wakes the persistence worker asynchronously.
    // The restart should wait until that worker releases its database lock.
    let deadline = Instant::now() + Duration::from_secs(2);
    let store = loop {
        match Persistence::start_with_catalog(&path, Some(catalog.clone())) {
            Err(error) if Instant::now() < deadline && error.downcast_ref::<std::io::Error>()
                .is_some_and(|cause| cause.kind() == std::io::ErrorKind::WouldBlock) =>
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            result => break result.unwrap(),
        }
    };
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
    let discovery = db.execute(&a, Operation::WorldItems(String::new(), context.clone(),Default::default())).unwrap();
    assert_eq!(discovery["storage"]["id"], own_store);
    assert_eq!(discovery["storage"]["position"], json!([0.0,0.0,0.0]));
    assert!(discovery["items"].as_array().unwrap().is_empty());
    let other_discovery = db.execute(&b, Operation::WorldItems(String::new(), foreign.clone(),Default::default())).unwrap();
    assert_eq!(other_discovery["storage"]["id"], other_store);
    let mut far = context.clone();
    far.position[0] = 33.0;
    assert!(db.execute(&a, Operation::WorldItems(String::new(), far,Default::default())).unwrap().get("storage").is_none());

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
    use zone_server::survival::{Impact, ImpactKind, Location, Record};
    Operation::ResolveImpact(Impact {
        kind: ImpactKind::Blast { bone: String::new() }, power, before: Record { revision, state },
        native_armour: None,
        location: Location { world: "zaton".into(), content_revision: "fixture".into(),
            position: [0.0; 3], yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 },
        combat_lock_ms: 60_000,
    })
}

#[tokio::test]
async fn blast_absorption_and_armour_wear_are_life_scoped_and_atomic() {
    use zone_server::{combat::ArmourImpact, survival::{ImpactOutcome, State}};

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
    let context = Context { principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
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
    let result: ImpactOutcome = serde_json::from_value(impact(0).await.unwrap().unwrap()).unwrap();
    assert!(matches!(result, ImpactOutcome::Applied { revision: 1, alive: true,
        impact: ArmourImpact::Hit { power, wound: true, gear_changed: true, .. }, power_loss: 0.0 } if (power - 0.2).abs() < 1e-6));
    assert_eq!(impact(0).await.unwrap().unwrap()["status"], "stale");
    let (revision, state) = condition();
    assert_eq!(revision, 1);
    assert!((state.health - 0.8).abs() < 1e-6 && (state.bleeding - 0.2).abs() < 1e-6);
    let Operation::ResolveImpact(stale) = blast_command(0.9, 0, State::default()) else { unreachable!() };
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

#[tokio::test]
async fn native_armour_wear_and_vitals_share_a_generation_checked_transaction() {
    use zone_server::survival::{NativeArmourImpact, State};
    let root = std::env::temp_dir().join(format!("zone-native-armour-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&"a".repeat(64), Operation::Register).unwrap()["principalId"]
        .as_str().unwrap().to_owned();
    let carried = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
    let mut gear = |section, slot, condition| {
        let mut state = catalog.initial_state(section).unwrap();
        state.condition = condition;
        db.provision_inventory_item(&carried, section, &state, slot).unwrap()
    };
    let outfit = gear("outfit", "slot:7", 0.8);
    let helmet = gear("helmet", "slot:12", 0.5);
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    let store = Persistence::start_with_catalog(&path, Some(catalog.clone())).unwrap();
    let context = Context { principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
        position: [0.0; 3], eye_height: 1.55, interaction_radius: 2.0, collision: None,
        expires: Instant::now() + Duration::from_secs(30) };
    let read = |id: &str| -> f32 {
        sql.query_row("SELECT state FROM inventory_items WHERE id=?1", [id],
            |row| Ok(serde_json::from_str::<ItemState>(&row.get::<_, String>(0)?).unwrap().condition)).unwrap()
    };
    let proposal = NativeArmourImpact { generation: 2, power: 0.14, health: 0.23, power_loss: 0.17, outfit: Some(0.7), helmet: Some(0.4), wound: true };
    let resolve = |revision, state, sample| {
        let Operation::ResolveImpact(mut impact) = blast_command(0.9, revision, state) else { unreachable!() };
        impact.native_armour = Some(sample);
        store.inventory_request(context.clone(), Operation::ResolveImpact(impact)).unwrap()
    };
    sql.execute_batch("CREATE TRIGGER reject_native_helmet BEFORE UPDATE OF state ON inventory_items
        WHEN OLD.section='helmet' BEGIN SELECT RAISE(ABORT,'fixture rejected native wear'); END;").unwrap();
    assert!(resolve(0, State::default(), proposal).await.unwrap().is_err());
    assert_eq!((read(&outfit), read(&helmet)), (0.8, 0.5));
    sql.execute_batch("DROP TRIGGER reject_native_helmet").unwrap();
    let result = resolve(0, State::default(), proposal).await.unwrap().unwrap();
    assert_eq!(result["revision"], 1);
    assert_eq!((read(&outfit), read(&helmet)), (0.7, 0.4));
    let state = sql.query_row("SELECT condition FROM inventory_characters WHERE principal=?1", [&context.principal],
        |row| Ok(serde_json::from_str::<State>(&row.get::<_, String>(0)?).unwrap())).unwrap();
    assert!((state.health - 0.77).abs() < 1e-6);
    assert!((state.power - 0.83).abs() < 1e-6);
    let stale = NativeArmourImpact { power: 0.0, outfit: Some(0.0), helmet: Some(0.0), ..proposal };
    let fallback = resolve(1, state, stale).await.unwrap().unwrap();
    assert_eq!(fallback["revision"], 2);
    assert!(read(&outfit) > 0.0 && read(&helmet) > 0.0);
    let state = sql.query_row("SELECT condition FROM inventory_characters WHERE principal=?1", [&context.principal],
        |row| Ok(serde_json::from_str::<State>(&row.get::<_, String>(0)?).unwrap())).unwrap();
    let generation: i64 = sql.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",
        [&context.principal], |row| row.get(0)).unwrap();
    let mut bytes = b"ZCS1".to_vec();
    let mut values = [0.0f32; 23+8+12+9];
    values[0]=0.61; values[1]=0.73; values[5]=1.0;
    values[18]=1.0; values[19]=50.0; values[20]=60.0;
    for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
    for value in [0u32,16,0,0] { bytes.extend_from_slice(&value.to_le_bytes()); }
    let checkpoint = zone_server::native_condition::Checkpoint::parse(bytes).unwrap();
    let Operation::ResolveImpact(impact) = blast_command(0.0, 2, state) else { unreachable!() };
    let proposal = zone_server::native_condition::Commit { before: impact.before,
        location: impact.location, equipment: generation.try_into().unwrap(), checkpoint: checkpoint.clone() };
    let mut stale = proposal.clone(); stale.equipment += 1;
    let result = store.inventory_request(context.clone(), Operation::CommitNativeCondition(stale)).unwrap().await.unwrap().unwrap();
    assert_eq!(result["status"], "stale");
    let result = store.inventory_request(context.clone(), Operation::CommitNativeCondition(proposal.clone())).unwrap().await.unwrap().unwrap();
    assert_eq!(result["status"], "committed"); assert_eq!(result["revision"], 3);
    let retry = store.inventory_request(context.clone(), Operation::CommitNativeCondition(proposal)).unwrap().await.unwrap().unwrap();
    assert_eq!(retry,result);
    let (revision, raw): (u32,String) = sql.query_row("SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1",
        [&context.principal], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
    let restored: State = serde_json::from_str(&raw).unwrap();
    assert_eq!(revision,3);
    assert_eq!((restored.health,restored.power),(0.61,0.73));
    assert_eq!(restored.native_checkpoint(),Some(&checkpoint));
    // A legacy request must not mutate native-owned condition or equipped gear.
    let wear_before=(read(&outfit),read(&helmet));
    assert!(store.inventory_request(context.clone(),blast_command(0.9,3,restored.clone()))
        .unwrap().await.unwrap().is_err());
    let Operation::ResolveImpact(field_input)=blast_command(0.0,3,restored.clone()) else {unreachable!()};
    let fields=zone_server::environment::Exposure {
        before:field_input.before,location:field_input.location,
        pulses:vec![zone_server::environment::Pulse{kind:zone_server::environment::Kind::Heat,power:0.9}].into(),
    };
    assert!(store.inventory_request(context.clone(),Operation::ResolveFields(fields))
        .unwrap().await.unwrap().is_err());
    let unchanged:(u32,String)=sql.query_row(
        "SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1",
        [&context.principal],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(unchanged,(revision,raw));
    assert_eq!((read(&outfit),read(&helmet)),wear_before);
    // Full native hit checkpoints and wear share the same transaction/death path.
    let outfit_before=read(&outfit); let helmet_before=read(&helmet);
    let generation:i64=sql.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",
        [&context.principal],|r|r.get(0)).unwrap();
    let mut hit_bytes=checkpoint.bytes().to_vec(); hit_bytes[4..8].copy_from_slice(&0.42f32.to_le_bytes());
    let hit_checkpoint=zone_server::native_condition::Checkpoint::parse(hit_bytes).unwrap();
    let Operation::ResolveImpact(input)=blast_command(0.0,3,restored.clone()) else {unreachable!()};
    let native_hit=zone_server::native_condition::Impact {
        condition:zone_server::native_condition::Commit { before:input.before,location:input.location,
            equipment:generation as u64,checkpoint:hit_checkpoint.clone() },
        wear:[Some(outfit_before*0.5),Some(helmet_before*0.5)],combat_until_ms:12345,
    };
    let mut wrong=native_hit.clone(); wrong.wear[1]=None;
    let denied=store.inventory_request(context.clone(),Operation::CommitNativeImpact(wrong)).unwrap().await.unwrap().unwrap();
    assert_eq!(denied["status"],"stale"); assert_eq!(read(&outfit),outfit_before);
    sql.execute_batch("CREATE TRIGGER fail_native_hit BEFORE UPDATE OF condition_revision ON inventory_characters BEGIN SELECT RAISE(ABORT,'injected native hit failure'); END").unwrap();
    assert!(store.inventory_request(context.clone(),Operation::CommitNativeImpact(native_hit.clone())).unwrap().await.unwrap().is_err());
    assert_eq!((read(&outfit),read(&helmet)),(outfit_before,helmet_before));
    sql.execute_batch("DROP TRIGGER fail_native_hit").unwrap();
    let committed=store.inventory_request(context.clone(),Operation::CommitNativeImpact(native_hit.clone())).unwrap().await.unwrap().unwrap();
    assert_eq!(committed["status"],"committed"); assert_eq!(committed["revision"],4); assert_eq!(committed["alive"],true);
    let state:State=serde_json::from_value(committed["state"].clone()).unwrap();
    assert_eq!(state.health,0.42); assert_eq!(state.native_checkpoint(),Some(&hit_checkpoint));
    assert_eq!((read(&outfit),read(&helmet)),(outfit_before*0.5,helmet_before*0.5));
    assert_eq!(store.inventory_request(context.clone(),Operation::CommitNativeImpact(native_hit.clone())).unwrap().await.unwrap().unwrap(),committed);
    let mut changed=native_hit.clone(); changed.wear[0]=Some(0.0);
    assert_eq!(store.inventory_request(context.clone(),Operation::CommitNativeImpact(changed)).unwrap().await.unwrap().unwrap()["status"],"stale");
    let mut lethal=native_hit;
    lethal.condition.before=zone_server::survival::Record{revision:4,state};
    lethal.condition.equipment=sql.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",[&context.principal],|r|r.get::<_,i64>(0)).unwrap() as u64;
    let mut dead_bytes=hit_checkpoint.bytes().to_vec(); dead_bytes[4..8].copy_from_slice(&0.0f32.to_le_bytes());
    lethal.condition.checkpoint=zone_server::native_condition::Checkpoint::parse(dead_bytes).unwrap();
    let death=store.inventory_request(context.clone(),Operation::CommitNativeImpact(lethal.clone())).unwrap().await.unwrap().unwrap();
    assert_eq!(death["alive"],false); assert_eq!(death["revision"],5);
    let corpse:String=sql.query_row("SELECT corpse FROM inventory_characters WHERE principal=?1",[&context.principal],|r|r.get(0)).unwrap();
    let item_container:String=sql.query_row("SELECT container FROM inventory_items WHERE id=?1",[&outfit],|r|r.get(0)).unwrap();
    assert_eq!(item_container,corpse);
    assert_eq!(store.inventory_request(context.clone(),Operation::CommitNativeImpact(lethal.clone())).unwrap().await.unwrap().unwrap(),death);
    store.flush().await.unwrap(); drop(store);
    let store=Persistence::start_with_catalog(&path,Some(catalog)).unwrap();
    assert_eq!(store.inventory_request(context.clone(),Operation::CommitNativeImpact(lethal)).unwrap().await.unwrap().unwrap(),death);
    assert_eq!(sql.query_row("SELECT count(*) FROM native_condition_receipts",[],|r|r.get::<_,u32>(0)).unwrap(),1);
    assert_eq!(sql.query_row("SELECT count(*) FROM item_containers WHERE kind='corpse'",[],|r|r.get::<_,u32>(0)).unwrap(),1);
    store.flush().await.unwrap();
    drop(store);
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
            let context = Context { principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(),
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
async fn hand_throw_consumes_the_drawn_item_and_replaces_it_atomically() {
    use zone_server::hand_grenade::Force;
    let root = std::env::temp_dir().join(format!("zone-hand-grenade-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&"a".repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    let containers = db.initialize_inventory(&principal).unwrap();
    let carry = containers["carried"].as_str().unwrap();
    let first = db.provision_inventory_item(carry, "hand_f1", &catalog.initial_state("hand_f1").unwrap(), "slot:4").unwrap();
    let smoke = db.provision_inventory_item(carry, "hand_smoke", &catalog.initial_state("hand_smoke").unwrap(), "rucksack").unwrap();
    let spare = db.provision_inventory_item(carry, "hand_f1", &catalog.initial_state("hand_f1").unwrap(), "rucksack").unwrap();
    let _rifle = db.provision_inventory_item(carry, "rifle", &catalog.initial_state("rifle").unwrap(), "slot:3").unwrap();
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(), position: [0.; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None, expires: Instant::now() + Duration::from_secs(30) };
    let throw = |id: &str, force| store.inventory_request(context.clone(), Operation::ThrowGrenade(id.into(), force)).unwrap();
    let slot = || -> Option<String> {
        use rusqlite::OptionalExtension;
        sql.query_row("SELECT id FROM inventory_items WHERE container=?1 AND place='slot:4'", [carry], |row| row.get(0)).optional().unwrap()
    };
    assert_eq!(throw(&first, Force::Quick).await.unwrap().unwrap()["reason"], "grenade_not_drawn");
    let drawn = store.inventory_request(context.clone(), Operation::SelectWeapon { life: 0, slot: 4 }).unwrap().await.unwrap().unwrap();
    assert_eq!(drawn["appearance"]["weapon"], "hand_f1");
    assert_eq!(throw(&smoke, Force::Quick).await.unwrap().unwrap()["reason"], "grenade_not_equipped");
    sql.execute_batch("CREATE TRIGGER reject_replacement BEFORE UPDATE OF place ON inventory_items
        WHEN NEW.place='slot:4' BEGIN SELECT RAISE(ABORT,'fixture rejected replacement'); END;").unwrap();
    assert!(throw(&first, Force::Quick).await.unwrap().is_err());
    assert_eq!(slot().as_deref(), Some(first.as_str()));
    sql.execute_batch("DROP TRIGGER reject_replacement").unwrap();
    let quick = throw(&first, Force::Quick).await.unwrap().unwrap();
    assert_eq!(quick["shot"]["launcher"]["speed"], 25.0);
    assert_eq!(quick["shot"]["launcher"]["fuse_ticks"], 75);
    assert_eq!(slot().as_deref(), Some(spare.as_str()));
    assert_eq!(throw(&first, Force::Quick).await.unwrap().unwrap()["reason"], "grenade_not_equipped");
    let charged = throw(&spare, Force::Held(12)).await.unwrap().unwrap();
    assert_eq!(charged["shot"]["launcher"]["speed"], 18.0);
    assert_eq!(slot().as_deref(), Some(smoke.as_str()));
    let last = throw(&smoke, Force::Held(400)).await.unwrap().unwrap();
    assert_eq!(last["shot"]["launcher"]["speed"], 30.0);
    assert_eq!(last["shot"]["launcher"]["blast_power"], 0.0);
    assert_eq!(last["loadout"]["active_weapon_slot"], 3);
    assert_eq!(slot(), None);
    store.flush().await.unwrap();
    drop(store);
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn field_wear_damage_and_full_loss_commit_together() {
    use zone_server::{environment::{Exposure, Kind, Outcome, Pulse}, survival::{Location, Record, State}};
    let root = std::env::temp_dir().join(format!("zone-field-exposure-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&"a".repeat(64), Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    let containers = db.initialize_inventory(&principal).unwrap();
    let carry = containers["carried"].as_str().unwrap();
    let outfit = db.provision_inventory_item(carry, "outfit", &catalog.initial_state("outfit").unwrap(), "slot:7").unwrap();
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    let store = Persistence::start_with_catalog(&path, Some(catalog)).unwrap();
    let context = Context { principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(), position: [0.; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None, expires: Instant::now() + Duration::from_secs(30) };
    let location = Location { world: context.world.clone(), content_revision: "fixture".into(), position: [0.; 3],
        yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 };
    let resolve = |revision, state, power| {
        let pulse = Pulse { kind: Kind::Acid, power };
        store.inventory_request(context.clone(), Operation::ResolveFields(Exposure {
            pulses: Arc::from([pulse]), before: Record { revision, state }, location: location.clone(),
        })).unwrap()
    };
    let outfit_state = || -> (u32, ItemState, String) {
        sql.query_row("SELECT i.revision,i.state,c.kind FROM inventory_items i JOIN item_containers c ON i.container=c.id WHERE i.id=?1",
            [&outfit], |r| Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap(), r.get(2)?))).unwrap()
    };
    let state = || -> (u32, State) {
        sql.query_row("SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1", [&context.principal],
            |r| Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap()))).unwrap()
    };
    let first: Outcome = serde_json::from_value(resolve(0, State::default(), 0.22).await.unwrap().unwrap()).unwrap();
    assert!(first.commit.alive && first.armour.is_some());
    let (revision, survived) = state();
    assert_eq!(revision, 1);
    assert!((survived.health - 0.8).abs() < 1e-6 && (survived.power - 0.98).abs() < 1e-6);
    assert_eq!(survived.bleeding, 0.0);
    let before = outfit_state();
    assert_eq!(before.0, 1);
    assert!((before.1.condition - 0.978).abs() < 1e-6);
    assert!(resolve(0, survived.clone(), 2.0).await.unwrap().unwrap().is_null());
    sql.execute_batch("CREATE TRIGGER reject_field_corpse BEFORE UPDATE OF container ON inventory_items BEGIN SELECT RAISE(ABORT,'fixture rejected corpse transfer'); END;").unwrap();
    assert!(resolve(revision, survived.clone(), 2.0).await.unwrap().is_err());
    assert_eq!(outfit_state(), before);
    assert_eq!(state().0, revision);
    assert_eq!(state().1.health, survived.health);
    sql.execute_batch("DROP TRIGGER reject_field_corpse").unwrap();
    let final_hit: Outcome = serde_json::from_value(resolve(revision, survived, 2.0).await.unwrap().unwrap()).unwrap();
    assert!(!final_hit.commit.alive);
    assert_eq!(state().1.health, 0.0);
    let (revision, worn, kind) = outfit_state();
    assert_eq!((revision, kind.as_str()), (3, "corpse"));
    assert!((worn.condition - 0.778).abs() < 1e-6);
    store.flush().await.unwrap();
    drop(store);
    drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn owned_shots_commit_ammunition_and_condition_of_the_correct_armour_together() {
    use zone_server::{combat::{ArmourImpact, ChargedShot, ShotTarget}, survival::{Location, Record, ShotVictim, State}, world::CharacterKey};
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
    let context = Context { principal: shooter, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(), position: [0.; 3],
        interaction_radius: 2.0, eye_height: 1.55, collision: None, expires: Instant::now() + Duration::from_secs(30) };
    let condition = || -> (u32, State) {
        sql.query_row("SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1", [&victim], |row| {
            Ok((row.get(0)?, serde_json::from_str(&row.get::<_, String>(1)?).unwrap()))
        }).unwrap()
    };
    let shoot = |bone: &str, distance, life| {
        let target = ShotTarget { character: CharacterKey { principal: victim.clone(), life }, bone: bone.into(), distance, speed_factor: 1.0, penetration: None };
        let (revision, state) = condition();
        let shooter_location = Location { world: context.world.clone(), content_revision: "fixture".into(), position: [0.; 3],
            yaw: 0.0, crouched: false, combat_until_ms: 0, logout_until_ms: 0 };
        let victim = ShotVictim { target, before: Record { revision, state },
            context: Context { principal: victim.clone(), life, position: [0., 0., 8.], ..context.clone() },
            location: Location { position: [0., 0., 8.], ..shooter_location.clone() }, shooter_location,
            combat_lock_ms: 60_000,
        };
        store.inventory_request(context.clone(), Operation::FireWeapon(gun.clone(), vec![zone_server::survival::FireVictim { authority: victim, native: None, additional: Vec::new() }], Default::default())).unwrap()
    };
    let read = |id: &str| -> (u32, ItemState) {
        sql.query_row("SELECT revision,state FROM inventory_items WHERE id=?1", [id], |r| {
            Ok((r.get(0)?, serde_json::from_str(&r.get::<_, String>(1)?).unwrap()))
        }).unwrap()
    };
    assert!(shoot("bip01_spine2", 8.0, 0).await.unwrap().is_err());
    assert_eq!(read(&gun), (0, rifle));
    assert_eq!(read(&outfit).0, 0);
    assert_eq!(condition().0, 0);
    sql.execute_batch("DROP TRIGGER reject_shot_debit").unwrap();
    let hit = |value: Value, rounds, expected_power, expected_wound| {
        let radiation = &value["shot"]["armour"]["Hit"]["field_armour"];
        let generation: i64 = sql.query_row(
            "SELECT generation FROM inventory_characters WHERE principal=?1", [&victim], |row| row.get(0),
        ).unwrap();
        assert_eq!(radiation["generation"], generation);
        let outfit_rating = f64::from(read(&outfit).1.condition) * 0.0003;
        let helmet_rating = f64::from(read(&helmet).1.condition) * 0.0001;
        assert!(((radiation["outfit"]["protection"][0].as_f64().unwrap() * radiation["outfit"]["condition"].as_f64().unwrap()) - outfit_rating).abs() < 1e-8);
        assert!(((radiation["helmet"]["protection"][0].as_f64().unwrap() * radiation["helmet"]["condition"].as_f64().unwrap()) - helmet_rating).abs() < 1e-8);
        let charged: ChargedShot = serde_json::from_value(value["shot"].clone()).unwrap();
        assert_eq!(charged.ammo, rounds);
        let commit = charged.target_commit.unwrap();
        assert!(commit.alive);
        assert_eq!(commit.revision, condition().0);
        let Some(ArmourImpact::Hit {power, wound, gear_changed, ..}) = charged.armour else { panic!("expected armoured impact"); };
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
    assert_eq!(condition().0, 2);
    assert_eq!(read(&outfit).0, 1);
    hit(shoot("bip01_spine2", 8.0, 0).await.unwrap().unwrap(), 1, 0.1125, true);
    assert!((read(&outfit).1.condition - 0.925).abs() < 1e-6);
    let (revision, mut state) = condition();
    assert_eq!(revision, 3);
    assert!((state.health - 0.7525).abs() < 1e-6 && (state.bleeding - 0.1125).abs() < 1e-6);
    let wounds = serde_json::to_value(&state).unwrap();
    assert!(wounds["wounds"]["bip01_head"].is_null());
    assert!((wounds["wounds"]["bip01_spine2"][6].as_f64().unwrap() - 0.1125).abs() < 1e-6);
    let deadline = |id: &str| sql.query_row::<i64, _, _>(
        "SELECT json_extract(location,'$.combat_until_ms') FROM inventory_characters WHERE principal=?1", [id], |r| r.get(0),
    ).unwrap();
    assert!(deadline(&victim) > 0);
    assert_eq!(deadline(&context.principal), deadline(&victim));
    let previous_deadline = deadline(&context.principal);
    state.health = 0.01;
    sql.execute("UPDATE inventory_characters SET condition=?1 WHERE principal=?2", rusqlite::params![serde_json::to_string(&state).unwrap(),victim]).unwrap();
    sql.execute_batch("CREATE TRIGGER reject_shot_death BEFORE UPDATE OF container ON inventory_items BEGIN SELECT RAISE(ABORT,'fixture rejected corpse transfer'); END;").unwrap();
    assert!(shoot("bip01_spine2", 8.0, 0).await.unwrap().is_err());
    assert_eq!(read(&gun).0, 4);
    assert_eq!(read(&outfit).0, 2);
    assert_eq!(condition().0, 3);
    assert_eq!(condition().1.health, 0.01);
    assert_eq!(deadline(&context.principal), previous_deadline);
    sql.execute_batch("DROP TRIGGER reject_shot_death").unwrap();
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
        principal, life: 0, visit: 0, auth_epoch: 0, world: "zaton".into(), position: [0.0; 3],
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
    let restoration = &loadout["restoration"];
    for (stat, expected) in [("health", 0.001), ("bleeding", 0.001), ("radiation", 0.003)] {
        assert!((restoration[stat].as_f64().unwrap() - expected).abs() < 1e-8);
    }
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
    assert_eq!(loaded["loadout"], *loadout);
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

#[tokio::test]
async fn native_consumption_commits_checkpoint_and_portion_once() {
    use zone_server::{native_condition::{Checkpoint, Consumption}, survival::{Record, State}, survival_rules::SurvivalRules};
    let root = std::env::temp_dir().join(format!("zone-native-consume-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("zone.sqlite");
    let catalog = catalog();
    let secret = "b".repeat(64);
    let mut db = Database::open(&path).unwrap();
    db.set_catalog(catalog.clone());
    let principal = db.execute(&secret, Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
    let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
    let dose = item(&mut db, &catalog, &carry, "treatment");
    drop(db);
    let sql = rusqlite::Connection::open(&path).unwrap();
    let generation: i64 = sql.query_row("SELECT generation FROM inventory_characters WHERE principal=?1", [&principal], |r| r.get(0)).unwrap();
    let context = Context { principal, life:0, visit:0, auth_epoch:0, world:"zaton".into(), position:[0.0;3],
        interaction_radius:2.0, eye_height:1.55, collision:None, expires:Instant::now()+Duration::from_secs(30) };
    let rules = Arc::new(SurvivalRules { starter_kit:vec![], ..SurvivalRules::default() });
    let store = Persistence::start_with_rules(&path, Some(catalog), Some(rules)).unwrap();
    let mut bytes = b"ZCS1".to_vec();
    let mut values = [0.0f32;23+8+12+9];
    values[0]=0.812345; values[1]=0.67; values[5]=1.0; values[18]=1.0; values[19]=50.0; values[20]=60.0;
    for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
    for value in [0u32,16,0,0] { bytes.extend_from_slice(&value.to_le_bytes()); }
    let checkpoint = Checkpoint::parse(bytes).unwrap();
    let proposal = Consumption { before:Record{revision:0,state:State::default()}, equipment:generation as u64,
        section:"treatment".into(),checkpoint:checkpoint.clone() };
    let command = |id:&str| Move { request_id:id.into(),life:0,item:dose.clone(),revision:0,action:MoveAction::Consume };
    let read = || sql.query_row("SELECT condition_revision,(SELECT state FROM inventory_items WHERE id=?2) FROM inventory_characters WHERE principal=?1",
        rusqlite::params![context.principal,dose], |r| Ok((r.get::<_,u32>(0)?,r.get::<_,String>(1)?))).unwrap();
    let original = read();
    let prepared=store.inventory_request(context.clone(),Operation::PrepareNativeConsume(command("native-dose"))).unwrap().await.unwrap().unwrap();
    assert_eq!(prepared["status"],"prepared"); assert_eq!(prepared["section"],"treatment");
    assert_eq!(prepared["generation"],generation); assert_eq!(read(),original);
    let mut stale_command=command("prepare-stale"); stale_command.revision=99;
    assert_eq!(store.inventory_request(context.clone(),Operation::PrepareNativeConsume(stale_command)).unwrap().await.unwrap().unwrap()["status"],"conflict");
    let mut other=context.clone(); other.principal="f".repeat(32);
    assert_ne!(store.inventory_request(other,Operation::PrepareNativeConsume(command("not-owned"))).unwrap().await.unwrap().unwrap()["status"],"prepared");
    for (id, bad) in [
        ("wrong-generation", Consumption { equipment:proposal.equipment+1,..proposal.clone() }),
        ("wrong-section", Consumption { section:"bandage".into(),..proposal.clone() }),
        ("wrong-condition", Consumption { before:Record{revision:1,state:State::default()},..proposal.clone() }),
    ] {
        let response = store.inventory_request(context.clone(),Operation::ConsumeNative(command(id),bad)).unwrap().await.unwrap().unwrap();
        assert_ne!(response["status"],"committed"); assert_eq!(read(),original);
    }
    let operation = || Operation::ConsumeNative(command("native-dose"),proposal.clone());
    sql.execute_batch("CREATE TRIGGER fail_native_portion BEFORE UPDATE ON inventory_items BEGIN SELECT RAISE(ABORT,'injected portion failure'); END").unwrap();
    assert!(store.inventory_request(context.clone(), operation()).unwrap().await.unwrap().is_err());
    assert_eq!(read(), original); // condition update rolls back with failed item debit
    sql.execute_batch("DROP TRIGGER fail_native_portion").unwrap();
    let result = store.inventory_request(context.clone(),operation()).unwrap().await.unwrap().unwrap();
    assert_eq!(result["status"],"committed"); assert_eq!(result["remaining"],1);
    let replay=store.inventory_request(context.clone(),Operation::PrepareNativeConsume(command("native-dose"))).unwrap().await.unwrap().unwrap();
    assert_eq!(replay["status"],"committed"); assert_eq!(replay["condition"],result["condition"]);

    let treated:Record = serde_json::from_value(result["condition"].clone()).unwrap();
    assert_eq!(treated.revision,1); assert_eq!(treated.state.health,0.812345);
    assert_eq!(treated.state.native_checkpoint(),Some(&checkpoint));
    assert_eq!(store.inventory_request(context.clone(),operation()).unwrap().await.unwrap().unwrap(),result);
    assert_eq!(read().0,1);
    let remaining:ItemState=serde_json::from_str(&read().1).unwrap();
    assert!(matches!(remaining.payload,ItemPayload::Consumable{uses:1}));
    store.flush().await.unwrap(); drop(store); drop(sql);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn native_reload_commits_box_graph_atomically_and_replays_after_restart() {
    use zone_server::native_weapon_action::{Reply,Phase,Fence,WeaponResult,AmmoResult};
    let root=std::env::temp_dir().join(format!("zone-native-reload-{}",std::process::id()));
    std::fs::create_dir(&root).unwrap();let path=root.join("zone.sqlite");
    let(mut db,catalog,ctx,carry)=setup_at(&path);
    let initial=catalog.initial_state("rifle").unwrap();
    let ItemPayload::Weapon{selected_ammunition,fire_mode,launcher_mode,..}=&initial.payload else{unreachable!()};
    let gun=db.provision_inventory_item(&carry,"rifle",&initial,"slot:3").unwrap();
    let ammo=item(&mut db,&catalog,&carry,"ammo");
    let view=list(&mut db);let generation=view["generation"].as_u64().unwrap();
    let reply=Reply{fence:Fence{epoch:1,boot:2,player:3,life:0,sequence:1,generation,
        item:u128::from_str_radix(&gun,16).unwrap(),revision:0},phase:Phase::Complete,state:Some(WeaponResult{
        condition:initial.condition,mode:*fire_mode,jammed:false,launcher:*launcher_mode,selected:selected_ammunition.clone(),
        cartridges:vec!["ammo".into();10],grenades:vec![],reserve:vec![
            AmmoResult{item:u128::from_str_radix(&ammo,16).unwrap(),revision:0,native:10,rounds:8,section:"ammo".into()},
            AmmoResult{item:0,revision:0,native:11,rounds:2,section:"ammo".into()}]})};
    drop(db);let store=Persistence::start_with_catalog(&path,Some(catalog.clone())).unwrap();
    let sql=rusqlite::Connection::open(&path).unwrap();
    let mut minted=reply.clone();minted.state.as_mut().unwrap().cartridges.push("ammo".into());
    assert!(store.inventory_request(ctx.clone(),Operation::CommitNativeReload(minted)).unwrap().await.unwrap().is_err());
    assert_eq!(sql.query_row("SELECT revision FROM inventory_items WHERE id=?1",[&gun],|r|r.get::<_,u32>(0)).unwrap(),0);
    let mut missing=reply.clone();missing.state.as_mut().unwrap().reserve.remove(0);
    assert!(store.inventory_request(ctx.clone(),Operation::CommitNativeReload(missing)).unwrap().await.unwrap().is_err());
    let mut stale=reply.clone();stale.fence.generation+=1;
    assert_eq!(store.inventory_request(ctx.clone(),Operation::CommitNativeReload(stale)).unwrap().await.unwrap().unwrap()["status"],"stale");
    // Fail the final weapon update after ammo changes: the entire transaction,
    // including the newly allocated box, must roll back.
    sql.execute_batch("CREATE TRIGGER reject_native_reload BEFORE UPDATE ON inventory_items WHEN NEW.place='slot:3' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(store.inventory_request(ctx.clone(),Operation::CommitNativeReload(reply.clone())).unwrap().await.unwrap().is_err());
    assert_eq!(sql.query_row("SELECT count(*) FROM inventory_items WHERE container=?1",[&carry],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(sql.query_row("SELECT revision FROM inventory_items WHERE id=?1",[&ammo],|r|r.get::<_,u32>(0)).unwrap(),0);
    sql.execute_batch("DROP TRIGGER reject_native_reload;").unwrap();
    let committed=store.inventory_request(ctx.clone(),Operation::CommitNativeReload(reply.clone())).unwrap().await.unwrap().unwrap();
    assert_eq!(committed["status"],"committed");assert_eq!(committed["created"].as_array().unwrap().len(),1);
    let count:i64=sql.query_row("SELECT count(*) FROM inventory_items WHERE container=?1",[&carry],|r|r.get(0)).unwrap();assert_eq!(count,3);
    let raw:String=sql.query_row("SELECT state FROM inventory_items WHERE id=?1",[&gun],|r|r.get(0)).unwrap();
    let state:ItemState=serde_json::from_str(&raw).unwrap();assert!(matches!(state.payload,ItemPayload::Weapon{cartridges,..} if cartridges.len()==10));
    let repeated=store.inventory_request(ctx.clone(),Operation::CommitNativeReload(reply.clone())).unwrap().await.unwrap().unwrap();assert_eq!(repeated,committed);
    let mut changed=reply.clone();changed.state.as_mut().unwrap().reserve[0].rounds=7;
    assert!(store.inventory_request(ctx.clone(),Operation::CommitNativeReload(changed)).unwrap().await.unwrap().is_err());
    store.flush().await.unwrap();drop(store);
    let store=Persistence::start_with_catalog(&path,Some(catalog)).unwrap();
    assert_eq!(store.inventory_request(ctx,Operation::CommitNativeReload(reply)).unwrap().await.unwrap().unwrap(),committed);
    store.flush().await.unwrap();drop(store);drop(sql);std::fs::remove_dir_all(root).unwrap();
}
