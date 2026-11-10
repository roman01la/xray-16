//! Isolated real-host condition validation. Requires a separate headless X-Ray
//! host using the supplied private socket; never points at a production database.
use anyhow::{Context,Result,ensure};
use std::{path::Path,sync::Arc,time::{Duration,Instant}};
use zone_server::{alife_interests::AlifeInterests,catalog::Catalog,native_condition::{Checkpoint,Request,ResultState},
    persistence::{Database,Operation,Persistence},world::{World,Kind,Vec3,CharacterKey}};

async fn pump(host:&mut AlifeInterests,world:&mut World,store:&Persistence) {
    world.tick=world.tick.wrapping_add(1);
    host.refresh_npcs(world,Some(store),|_|{});
    host.publish(world);
    tokio::time::sleep(Duration::from_millis(33)).await;
}
async fn resolve(host:&mut AlifeInterests,world:&mut World,store:&Persistence,request:Request)->Result<ResultState> {
    let fence=request.fence;
    ensure!(host.queue_condition(request),"native condition lane busy");
    let deadline=Instant::now()+Duration::from_secs(15);
    while Instant::now()<deadline {
        pump(host,world,store).await;
        if let Some((received,result))=host.take_condition_result(fence.player) {
            ensure!(received==fence,"native result fence mismatch");return Ok(result);
        }
    }
    anyhow::bail!("native result timed out for sequence {}",fence.sequence)
}
async fn persist(store:&Persistence,context:&zone_server::inventory::Context,operation:Operation)->Result<serde_json::Value> {
    store.inventory_request(context.clone(),operation).map_err(anyhow::Error::msg)?
        .await.context("persistence worker stopped")?.map_err(anyhow::Error::msg)
}
async fn wait_ammo(host: &mut AlifeInterests, world: &mut World, store: &Persistence,
    diagnostic: &Path, expected: &[(&str, u16)]) -> Result<std::collections::BTreeMap<String, u16>> {
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        pump(host, world, store).await;
        let text = std::fs::read_to_string(diagnostic).unwrap_or_default();
        let owner = text.lines().find_map(|line| line.strip_prefix("#target\t")
            .and_then(|row| row.split('\t').next()));
        let mut boxes = std::collections::BTreeMap::new();
        let mut counts = std::collections::BTreeMap::new();
        for line in text.lines().filter(|line| line.starts_with("#ammo\t")) {
            let row: Vec<_> = line.split('\t').collect();
            ensure!(row.len() == 6 && Some(row[1]) == owner, "ammo has wrong native owner");
            ensure!(boxes.insert(row[3].to_owned(), row[2].parse::<u16>()?).is_none(),
                "duplicate native ammo box for probe section");
            counts.insert(row[3].to_owned(), row[4].parse::<u16>()?);
        }
        if owner.is_some() && counts.len() == expected.len() &&
            expected.iter().all(|(section, rounds)| counts.get(*section) == Some(rounds)) {
            return Ok(boxes);
        }
        ensure!(Instant::now() < deadline, "native ammo mirror timed out: {counts:?}");
    }
}

#[tokio::main]
async fn main()->Result<()> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::WARN).with_ansi(false).init();
    let args:Vec<_>=std::env::args().collect();
    ensure!(args.len()==5,"usage: native_condition_probe SOCKET NEW_DATABASE CATALOG COLLISION");
    ensure!(!Path::new(&args[2]).exists(),"probe requires a new isolated database");
    let catalog=Arc::new(Catalog::load(Path::new(&args[3]))?);
    let mut db=Database::open(Path::new(&args[2]))?;db.set_catalog(catalog.clone());
    let principal=db.execute(&"a".repeat(64),Operation::Register)?["principalId"].as_str().context("principal")?.to_owned();
    let carried = db.initialize_inventory(&principal)?["carried"].as_str().context("carried container")?.to_owned();
    let action_probe = std::env::var("ZONE_PROBE_WEAPON_ACTION").as_deref() == Ok("1");
    let reload_probe = std::env::var("ZONE_PROBE_NATIVE_RELOAD").as_deref() == Ok("1");
    let reserve_probe = action_probe || reload_probe || std::env::var("ZONE_PROBE_RESERVE_AMMO").as_deref() == Ok("1");
    let mut seeded_ammo = Vec::new();
    if reserve_probe {
        db.provision_inventory_item(&carried, "wpn_ak74", &catalog.initial_state("wpn_ak74")?, "slot:3")?;
        for (section, rounds) in [("ammo_5.45x39_fmj", 23), ("ammo_5.45x39_ap", 17)] {
            let mut state = catalog.initial_state(section)?;
            state.payload = zone_server::inventory::ItemPayload::Ammunition { rounds };
            let id = db.provision_inventory_item(&carried, section, &state, "rucksack")?;
            seeded_ammo.push((id, state));
        }
    }
    drop(db);
    let store=Persistence::start_with_catalog(Path::new(&args[2]),Some(catalog))?;
    let mut world=World::new();world.safe_zones.clear();world.native_player_movement=true;
    let player=world.spawn(Kind::Player,Vec3{x:-121.0,y:3.2626,z:306.0});
    world.entities.get_mut(&player).unwrap().character_key=Some(CharacterKey{principal:principal.clone(),life:0});
    let incarnation=world.entities[&player].incarnation();
    let mut host=AlifeInterests::new(Path::new(&args[1]),"zaton-static-v1")?;
    if reserve_probe {
        let diagnostic = Path::new(&args[2]).parent().context("probe directory")?
            .join("game/_appdata_/zone-alife-probe.tsv");
        if action_probe {
            use zone_server::native_weapon_action::{Fence,ReloadCoordinator,ReloadStage};
            wait_ammo(&mut host,&mut world,&store,&diagnostic,&[("ammo_5.45x39_fmj",23),("ammo_5.45x39_ap",17)]).await?;
            let sql=rusqlite::Connection::open(&args[2])?;
            let (item,revision):(String,u32)=sql.query_row("SELECT id,revision FROM inventory_items WHERE container=?1 AND place='slot:3'",[&carried],|r|Ok((r.get(0)?,r.get(1)?)))?;
            let generation:i64=sql.query_row("SELECT generation FROM inventory_characters WHERE principal=?1",[&principal],|r|r.get(0))?;
            let(epoch,boot)=host.condition_host().context("native admission")?;
            let mut action=ReloadCoordinator::new(Fence{epoch,boot,player,life:incarnation,sequence:1,
                generation:generation.try_into()?,item:u128::from_str_radix(&item,16)?,revision}).context("action fence")?;
            let context=zone_server::inventory::Context{principal:principal.clone(),life:0,visit:0,auth_epoch:0,
                world:"zaton".into(),position:[-121.0,3.2626,306.0],interaction_radius:2.0,eye_height:1.55,collision:None,
                expires:Instant::now()+Duration::from_secs(180)};
            let deadline=Instant::now()+Duration::from_secs(160);
            let mut committed=false;
            while action.stage()!=&ReloadStage::Finished {
                pump(&mut host,&mut world,&store).await;
                if let Some(request)=action.request(){host.send_weapon_action(request);}
                host.drain_weapon_actions(|reply|{action.receive(reply);});
                if let Some(reply)=action.proposal().cloned(){
                    let result=store.inventory_request(context.clone(),Operation::CommitNativeReload(reply.clone()))
                        .map_err(anyhow::Error::msg)?.await?.map_err(anyhow::Error::msg)?;
                    ensure!(result["status"]=="committed","native reload commit failed: {result}");
                    let repeated=store.inventory_request(context.clone(),Operation::CommitNativeReload(reply))
                        .map_err(anyhow::Error::msg)?.await?.map_err(anyhow::Error::msg)?;
                    ensure!(result==repeated,"native result retry changed durable receipt");
                    action.persisted(true);committed=true;
                }
                ensure!(Instant::now()<deadline,"native action handshake timeout at {:?}",action.stage());
            }
            ensure!(committed,"native reload rejected");
            let raw:String=sql.query_row("SELECT state FROM inventory_items WHERE id=?1",[&item],|r|r.get(0))?;
            let state:zone_server::inventory::ItemState=serde_json::from_str(&raw)?;
            ensure!(matches!(state.payload,zone_server::inventory::ItemPayload::Weapon{cartridges,..} if cartridges.len()==23),"native magazine not persisted");
            println!("{}",serde_json::json!({"nativeWeaponHandshake":true,"committedRounds":23,"durableRetry":true,"nativeCommitAcknowledged":true}));
            store.flush().await.map_err(anyhow::Error::msg)?;return Ok(());
        }
        if reload_probe {
            let deadline = Instant::now() + Duration::from_secs(180);
            let mut stable_since = None;
            loop {
                pump(&mut host, &mut world, &store).await;
                let text = std::fs::read_to_string(&diagnostic).unwrap_or_default();
                let loaded = text.lines().filter(|line| line.starts_with("#weapon\t")).any(|line| {
                    let row: Vec<_> = line.split('\t').collect();
                    row.len() == 7 && row[3] == "wpn_ak74" && row[4] == "23" && row[5] == "idle" && row[6] == "0"
                });
                let mut rounds = std::collections::BTreeMap::new();
                for line in text.lines().filter(|line| line.starts_with("#ammo\t")) {
                    let row: Vec<_> = line.split('\t').collect();
                    ensure!(row.len() == 6, "malformed ammo diagnostic");
                    ensure!(rounds.insert(row[3], row[4].parse::<u16>()?).is_none(), "duplicated ammo mirror");
                }
                let complete = loaded && rounds.get("ammo_5.45x39_fmj").copied().unwrap_or(0) == 0 &&
                    rounds.get("ammo_5.45x39_ap") == Some(&17);
                if complete {
                    let started = stable_since.get_or_insert_with(Instant::now);
                    if started.elapsed() >= Duration::from_secs(5) { break; }
                } else {
                    ensure!(stable_since.is_none(), "native reload result changed under repeated snapshots");
                }
                ensure!(Instant::now() < deadline, "stock native reload did not complete: {rounds:?}");
            }
            let sql = rusqlite::Connection::open(&args[2])?;
            let raw: String = sql.query_row("SELECT state FROM inventory_items WHERE id=?1", [&seeded_ammo[0].0], |row| row.get(0))?;
            let persisted: zone_server::inventory::ItemState = serde_json::from_str(&raw)?;
            ensure!(matches!(persisted.payload, zone_server::inventory::ItemPayload::Ammunition { rounds: 23 }),
                "private native probe unexpectedly changed persisted ammunition");
            println!("{}", serde_json::json!({"nativeReloadAction":true,"loadedRounds":23,
                "unusedApRounds":17,"unchangedSnapshotsDidNotRefillSeconds":5,"persistedAmmoUnchanged":true}));
            store.flush().await.map_err(anyhow::Error::msg)?;
            return Ok(());
        }
        let initial = wait_ammo(&mut host, &mut world, &store, &diagnostic,
            &[("ammo_5.45x39_fmj", 23), ("ammo_5.45x39_ap", 17)]).await?;
        let sql = rusqlite::Connection::open(&args[2])?;
        sql.busy_timeout(Duration::from_secs(5))?;
        seeded_ammo[0].1.payload = zone_server::inventory::ItemPayload::Ammunition { rounds: 6 };
        ensure!(sql.execute("UPDATE inventory_items SET revision=revision+1,state=?1 WHERE id=?2",
            rusqlite::params![serde_json::to_string(&seeded_ammo[0].1)?, seeded_ammo[0].0])? == 1,
            "probe ammo update missing");
        let updated = wait_ammo(&mut host, &mut world, &store, &diagnostic,
            &[("ammo_5.45x39_fmj", 6), ("ammo_5.45x39_ap", 17)]).await?;
        ensure!(updated == initial, "count update recreated native boxes");
        ensure!(sql.execute("DELETE FROM inventory_items WHERE id=?1", [&seeded_ammo[1].0])? == 1,
            "probe ammo delete missing");
        let remaining = wait_ammo(&mut host, &mut world, &store, &diagnostic,
            &[("ammo_5.45x39_fmj", 6)]).await?;
        ensure!(remaining.get("ammo_5.45x39_fmj") == initial.get("ammo_5.45x39_fmj"),
            "unrelated box changed identity");
        sql.execute("UPDATE inventory_characters SET active_weapon_slot=0 WHERE principal=?1", [&principal])?;
        wait_ammo(&mut host, &mut world, &store, &diagnostic, &[]).await?;
        println!("{}", serde_json::json!({"nativeReserveAmmo":true,"createdBoxes":2,
            "revisionUpdateKeptIdentity":true,"removedBox":true,"holsterClearedMirrors":true}));
        store.flush().await.map_err(anyhow::Error::msg)?;
        return Ok(());
    }
    let deadline=Instant::now()+Duration::from_secs(180);
    let baseline:Checkpoint=loop {
        pump(&mut host,&mut world,&store).await;
        if let Some(state)=host.condition_baseline(player,incarnation,0) {break state.clone();}
        ensure!(Instant::now()<deadline,"native actor baseline timed out");
    };
    println!("native baseline received: {} bytes",baseline.bytes().len());
    let request=host.prepare_condition(player,incarnation,0,0,12.25,0.0,Some(&baseline)).context("batch request")?;
    let batch=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    let mut sequential=baseline.clone();
    for index in 0..13 {
        let seconds=if index==12 {0.25} else {1.0};
        let request=host.prepare_condition(player,incarnation,0,0,seconds,0.0,Some(&sequential)).context("step request")?;
        sequential=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    }
    ensure!(batch==sequential,"real native batch differs from sequential steps");
    let input=baseline.with_policy(false,0.0).context("unprotected checkpoint")?;
    use zone_server::environment::{Kind as FieldKind,Pulse};
    let pulses=[Pulse{kind:FieldKind::Radiation,power:0.05},Pulse{kind:FieldKind::Psy,power:0.03},
        Pulse{kind:FieldKind::Radiation,power:0.02}];
    let request=host.prepare_condition_fields(player,incarnation,0,0,0.0,&input,&pulses).context("field batch")?;
    let fields=resolve(&mut host,&mut world,&store,request).await?;
    ensure!(fields.wear==Some([None,None]),"empty native equipment returned unexpected wear");
    let mut individual=input.clone();
    for pulse in pulses {
        let kind=match pulse.kind {FieldKind::Radiation=>3,FieldKind::Psy=>4,_=>unreachable!()};
        let request=host.prepare_condition_hit(player,incarnation,0,0,0.0,&individual,
            zone_server::native_condition::Hit{kind,power:pulse.power,penetration:0.0,aimed:false,bone:""}).context("field hit")?;
        individual=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    }
    ensure!(fields.checkpoint==individual,"real native fields differ from ordered individual hits");
    ensure!(fields.checkpoint.projection().context("field projection")?.radiation>
        input.projection().context("initial projection")?.radiation,"native radiation hit had no effect");
    let request=host.prepare_condition_hit(player,incarnation,0,0,0.0,&input,
        zone_server::native_condition::Hit{kind:6,power:0.1,penetration:0.3,aimed:false,bone:"bip01_spine"}).context("bullet hit")?;
    let first=resolve(&mut host,&mut world,&store,request.clone()).await?;
    let replay=resolve(&mut host,&mut world,&store,request).await?;
    ensure!(first==replay,"native hit replay changed checkpoint or wear");
    ensure!(first.checkpoint.projection().context("hit projection")?.health<
        input.projection().context("initial projection")?.health,"native bullet hit had no effect");
    // Exercise the stock consumable handler and persisted timed medicine state.
    let request=host.prepare_condition_consume(player,incarnation,0,0,0.0,&first.checkpoint,"medkit")
        .context("native medkit request")?;
    let medicine=resolve(&mut host,&mut world,&store,request.clone()).await?;
    let medicine_replay=resolve(&mut host,&mut world,&store,request).await?;
    ensure!(medicine==medicine_replay,"native medicine replay changed state");
    ensure!(medicine.checkpoint!=first.checkpoint,"native medkit had no effect");
    let request=host.prepare_condition(player,incarnation,0,0,12.25,0.0,Some(&medicine.checkpoint))
        .context("medicine batch")?;
    let medicine_batch=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    let mut medicine_steps=medicine.checkpoint.clone();
    for index in 0..13 {
        let seconds=if index==12 {0.25} else {1.0};
        let request=host.prepare_condition(player,incarnation,0,0,seconds,0.0,Some(&medicine_steps))
            .context("medicine sequential step")?;
        medicine_steps=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    }
    ensure!(medicine_batch==medicine_steps,"timed medicine batch differs from individual native updates");
    let request=host.prepare_condition(player,incarnation,0,0,0.0,0.0,Some(&baseline)).context("restore request")?;
    let restored=resolve(&mut host,&mut world,&store,request).await?.checkpoint;
    ensure!(restored==baseline,"native proposal mutated mirror baseline");
    // Cross the real persistence-worker boundary using engine-produced bytes.
    use zone_server::{inventory::Context as InventoryContext, survival::{Record,Location},
        native_condition::{Commit,Impact}};
    let context=InventoryContext{principal:principal.clone(),life:0,visit:0,auth_epoch:0,
        world:"zaton-static-v1".into(),position:[-121.0,3.2626,306.0],eye_height:1.55,
        interaction_radius:2.0,collision:Some(Arc::new(zone_server::collision::CollisionMap::load(Path::new(&args[4]))?)),expires:Instant::now()+Duration::from_secs(30)};
    let loaded=persist(&store,&context,Operation::LoadCondition).await?;
    let before:Record=serde_json::from_value(loaded["condition"].clone()).context("initial durable condition")?;
    let location=Location{world:context.world.clone(),content_revision:"native-probe".into(),
        position:[-121.0,3.2626,306.0],yaw:0.0,crouched:false,combat_until_ms:0,logout_until_ms:0};
    let baseline_commit=Commit{before,equipment:0,checkpoint:baseline.clone(),location:location.clone()};
    let installed=persist(&store,&context,Operation::CommitNativeCondition(baseline_commit)).await?;
    ensure!(installed["status"]=="committed","baseline persistence rejected: {installed}");
    let loaded=persist(&store,&context,Operation::LoadCondition).await?;
    let before:Record=serde_json::from_value(loaded["condition"].clone())?;
    ensure!(before.state.native_checkpoint()==Some(&baseline),"durable baseline changed native bytes");
    let hit=Impact{condition:Commit{before,equipment:0,checkpoint:first.checkpoint.clone(),location},
        wear:first.wear.context("native hit wear")?,combat_until_ms:0};
    let committed=persist(&store,&context,Operation::CommitNativeImpact(hit.clone())).await?;
    ensure!(committed["status"]=="committed","native hit persistence rejected: {committed}");
    let retried=persist(&store,&context,Operation::CommitNativeImpact(hit)).await?;
    ensure!(committed==retried,"durable native hit replay changed result");
    store.flush().await.map_err(anyhow::Error::msg)?;
    // Open a separate connection: verify stored bytes, not the worker response.
    let sql=rusqlite::Connection::open(&args[2])?;
    let (revision,raw):(u32,String)=sql.query_row(
        "SELECT condition_revision,condition FROM inventory_characters WHERE principal=?1",
        [&principal],|r|Ok((r.get(0)?,r.get(1)?)))?;
    let saved:zone_server::survival::State=serde_json::from_str(&raw)?;
    ensure!(Some(revision as u64)==committed["revision"].as_u64(),"replay advanced durable revision");
    ensure!(saved.native_checkpoint()==Some(&first.checkpoint),"SQLite lost native hit state");
    // Move the isolated principal into an authored Zaton radiation volume by
    // spawning a new mirror (not teleporting an already-controlled native body).
    // This exercises actual CustomZone -> Actor::Hit -> sequenced delivery.
    world.remove(player);
    let hazard=world.spawn(Kind::Player,Vec3{x:-68.04141,y:0.741196,z:-168.10297});
    let actor=world.entities.get_mut(&hazard).unwrap();
    actor.character_key=Some(CharacterKey{principal:principal.clone(),life:0});
    actor.set_condition(saved.clone());
    let hazard_incarnation=actor.incarnation();
    let backpressure = std::env::var("ZONE_PROBE_HIT_BACKPRESSURE").as_deref() == Ok("1");
    let mut recovered_hits = 0u32;
    if backpressure {
        let host_log = Path::new(&args[2]).parent().context("probe directory")?.join("host.log");
        let deadline = Instant::now() + Duration::from_secs(600);
        loop {
            // Keep snapshots/condition transport alive, deliberately withholding
            // the hit receiver and its cumulative acknowledgement.
            pump(&mut host, &mut world, &store).await;
            if world.tick % 15 == 0 && std::fs::read_to_string(&host_log).unwrap_or_default()
                .contains("Zone hit delivery simulation blocked") { break; }
            ensure!(Instant::now() < deadline, "native queue never reached the backpressure gate");
        }
        let diagnostic = Path::new(&args[2]).parent().context("probe directory")?
            .join("game/_appdata_/zone-alife-probe.tsv");
        let frozen = std::fs::read(&diagnostic).context("native simulation diagnostic")?;
        ensure!(!frozen.is_empty(), "empty native simulation diagnostic");
        let hold_until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < hold_until {
            pump(&mut host, &mut world, &store).await;
            ensure!(std::fs::read(&diagnostic)? == frozen,
                "native simulation diagnostic advanced while delivery was blocked");
        }
        eprintln!("backpressure probe: simulation diagnostic frozen for five seconds; checking condition RPC while blocked");
        let request = host.prepare_condition(hazard, hazard_incarnation, 0, 0, 0.0, 0.0, Some(&input))
            .context("blocked-host condition request")?;
        let paused = resolve(&mut host, &mut world, &store, request).await?;
        ensure!(paused.checkpoint == input, "blocked-host condition restore changed state");
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            pump(&mut host, &mut world, &store).await;
            host.drain_impacts(&world, |_| { recovered_hits += 1; Ok(()) });
            if recovered_hits >= 512 && std::fs::read_to_string(&host_log).unwrap_or_default()
                .contains("Zone hit delivery simulation resumed") { break; }
            ensure!(Instant::now() < deadline, "native queue failed to drain/resume: {recovered_hits} hits");
        }
        eprintln!("backpressure probe: recovered {recovered_hits} hits and resumed");
    }
    let mut radiation=Vec::new();
    let mut native_hits=0u32;
    let deadline=Instant::now()+Duration::from_secs(25);
    while Instant::now()<deadline && radiation.len()<5 {
        pump(&mut host,&mut world,&store).await;
        host.drain_impacts(&world,|hit| {
            native_hits+=1;
            if let zone_server::alife_interests::NativeImpact::Field(id,pulse)=hit
                && id==hazard && pulse.kind==FieldKind::Radiation {radiation.push(pulse);}
            Ok(())
        });
    }
    let position=world.entities[&hazard].position;
    eprintln!("zone probe: player={hazard} incarnation={hazard_incarnation} position={},{},{} nativeHits={native_hits} radiationHits={}",
        position.x,position.y,position.z,radiation.len());
    ensure!(!radiation.is_empty(),"native authored radiation volume produced no hits");
    let request=host.prepare_condition_fields(hazard,hazard_incarnation,0,0,0.0,&input,&radiation)
        .context("actual native zone hit request")?;
    let zone_result=resolve(&mut host,&mut world,&store,request).await?;
    ensure!(zone_result.checkpoint.projection().context("zone projection")?.radiation>
        input.projection().context("zone input")?.radiation,"actual native zone hits did not increase radiation");
    println!("{}",serde_json::json!({"nativeActor":true,"batchEqualsSequential":true,"mirrorRestored":true,
        "hitBackpressureTested":backpressure,"blockedSimulationHoldSeconds":if backpressure {5} else {0},"recoveredHits":recovered_hits,"nativeRadiationHits":radiation.len(),"nativeRadiationApplied":true,"nativeMedicineReplay":true,"nativeMedicineBatchEqualsSequential":true,"durableNativeHit":true,"durableReplay":true,"orderedFieldsEqual":true,"nativeBulletDamaged":true,"exactHitReplay":true,"gameSeconds":12.25,"steps":13,"checkpointBytes":baseline.bytes().len()}));
    store.flush().await.map_err(anyhow::Error::msg)?;
    Ok(())
}
