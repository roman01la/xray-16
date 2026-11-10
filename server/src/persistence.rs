//! Durable foundation records, independent of gameplay mechanics.
//! A single bounded worker owns SQLite; no database work runs on simulation ticks.
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
    mpsc,
};
#[derive(Default)]
struct StoreMetrics {
    queued: AtomicUsize,
    peak: AtomicUsize,
    completed: AtomicU64,
    rejected: AtomicU64,
    last_us: AtomicU64,
    max_us: AtomicU64,
}
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::sync::{broadcast, oneshot, watch};
#[derive(Clone, Debug)]
pub struct OwnershipChange {
    pub principals: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mutation {
    pub request_id: String,
    pub expected_revision: u32,
    pub value: Value,
}
#[derive(Clone)]
pub enum Operation {
    Register,
    Resume,
    Read,
    Write(Mutation),
    ListEntities(String, Option<u64>),
    Transfer(crate::ownership::Transfer),
    TransferWithContext(crate::ownership::Transfer, crate::policy::ActionContext),
    ListInventory(String, Option<u64>),
    Corpses(String, crate::inventory::Context),
    CorpseItems(String, String, Option<u64>, crate::inventory::Context),
    WorldItems(String, crate::inventory::Context, crate::inventory::DetectorScan),
    MoveInventory(crate::inventory::Move, crate::inventory::Context),
    TimedReload(crate::inventory::Move, Option<std::sync::Arc<crate::reload_timing::ReloadTimings>>,
        Option<crate::combat::NativeWeaponRules>),
    // Internal operation; never route a client command to this variant.
    InventoryDeath(crate::inventory::Context),
    AuthorizeNativeWorld(String, crate::alife_checkpoint::Checkpoint),
    ImportNativeCorpse(crate::alife_corpse::Corpse, crate::alife_checkpoint::Checkpoint),
    ReadNativeEquipment(Vec<(u32, u32, crate::world::CharacterKey)>),
    ResolveImpact(crate::survival::Impact),
    CommitNativeCondition(crate::native_condition::Commit),
    CommitNativeReload(crate::native_weapon_action::Reply),
    CommitNativeImpact(crate::native_condition::Impact),
    ConsumeNative(crate::inventory::Move, crate::native_condition::Consumption),
    PrepareNativeConsume(crate::inventory::Move),
    ResolveFields(crate::environment::Exposure),
    FireWeapon(String, Vec<crate::survival::FireVictim>, crate::combat::FireState),
    ThrowGrenade(String, crate::hand_grenade::Force),
    ThrowBolt(String, crate::hand_grenade::Force),
    StrikeKnife(String, crate::knife::Mode, Option<Box<crate::survival::FireVictim>>, bool),
    SelectWeapon { life: u32, slot: u8 },
    SelectDetector { life: u32, active: bool },
    LoadCondition,
    PowerLabLift,
    Travel(crate::travel::Handoff),
    SaveCondition(crate::survival::Record, crate::survival::Location),
    Consume(crate::inventory::Move, crate::inventory::Context, crate::survival::Record),
    InventoryRespawn(crate::inventory::Respawn,crate::inventory::Context),
}
struct Job {
    secret: String,
    session: Option<crate::inventory::Context>,
    operation: Option<Operation>,
    reply: oneshot::Sender<Result<Value, String>>,
    enqueued: std::time::Instant,
}
#[derive(Clone)]
pub struct Persistence {
    tx: mpsc::SyncSender<Job>,
    runtime: watch::Receiver<crate::scene::RuntimeState>,
    stats: Arc<StoreMetrics>,
    updates: broadcast::Sender<OwnershipChange>,
    loot_presence: Arc<BTreeMap<String, LootPresence>>,
}
type LootPresence = watch::Sender<Option<crate::loot::Presence>>;
impl Persistence {
    pub fn start(path: &Path) -> Result<Self> {
        Self::start_with_catalog(path,None)
    }
    pub fn start_with_catalog(path: &Path, catalog: Option<Arc<crate::catalog::Catalog>>) -> Result<Self> {
        Self::start_with_rules(path,catalog,None)
    }
    pub fn start_with_rules(path:&Path,catalog:Option<Arc<crate::catalog::Catalog>>,rules:Option<Arc<crate::survival_rules::SurvivalRules>>)->Result<Self>{
        Self::start_with_loot(path, catalog, rules, None)
    }
    pub fn start_with_loot(
        path: &Path,
        catalog: Option<Arc<crate::catalog::Catalog>>,
        rules: Option<Arc<crate::survival_rules::SurvivalRules>>,
        loot: Option<crate::loot::AuthoredLoot>,
    ) -> Result<Self> {
        Self::start_for_world(path, catalog, rules, loot, None).map(|(store, _)| store)
    }
    pub fn start_for_world(
        path: &Path,
        catalog: Option<Arc<crate::catalog::Catalog>>,
        rules: Option<Arc<crate::survival_rules::SurvivalRules>>,
        loot: Option<crate::loot::AuthoredLoot>,
        world: Option<&crate::contract::Contract>,
    ) -> Result<(Self, Vec<crate::survival::SavedLogout>)> {
        Self::start_for_worlds(path, catalog, rules, loot.into_iter().collect(), &world.into_iter().collect::<Vec<_>>())
    }

    pub fn start_for_worlds(
        path: &Path,
        catalog: Option<Arc<crate::catalog::Catalog>>,
        rules: Option<Arc<crate::survival_rules::SurvivalRules>>,
        loot: Vec<crate::loot::AuthoredLoot>,
        worlds: &[&crate::contract::Contract],
    ) -> Result<(Self, Vec<crate::survival::SavedLogout>)> {
        if let Some(rules)=&rules{rules.validate(catalog.as_deref().context("survival rules require item catalog")?)?;}
        let canonical;
        let path = if path == Path::new(":memory:") {
            path
        } else {
            canonical = if path.exists() {
                path.canonicalize()?
            } else {
                let parent = path
                    .parent()
                    .filter(|p| !p.as_os_str().is_empty())
                    .unwrap_or(Path::new("."));
                parent
                    .canonicalize()?
                    .join(path.file_name().context("invalid database path")?)
            };
            canonical.as_path()
        };
        let database_lock = if path == Path::new(":memory:") {
            None
        } else {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(format!("{}.lock", path.display()))?;
            file.try_lock()
                .map_err(std::io::Error::from)
                .context("database already owned by another server")?;
            Some(file)
        };
        let mut db = Database::open(path)?;
        let mut logouts = Vec::new();
        if let Some(catalog) = catalog.as_deref() {
            let tx = db.connection.transaction()?;
            for contract in worlds {
                logouts.extend(crate::survival::load_logouts(&tx, contract, catalog)?);
                ensure!(logouts.len() <= 4096, "logout body capacity exceeded");
            }
        }
        db.catalog=catalog;
        db.rules=rules;
        let mut loot_presence = BTreeMap::new();
        let mut refill = Vec::new();
        if !loot.is_empty() {
            let rules = db.rules.as_deref().context("authored loot requires survival rules")?;
            let tx = db.connection.transaction()?;
            for loot in loot {
                loot.seed(&tx, rules)?;
                let (sender, receiver) = watch::channel(None::<crate::loot::Presence>);
                ensure!(loot_presence.insert(loot.world().to_owned(), sender).is_none(), "duplicate loot world");
                refill.push((loot, receiver));
            }
            tx.commit()?;
        }
        let stats = Arc::new(StoreMetrics::default());
        let worker_stats = stats.clone();
        let (tx, rx) = mpsc::sync_channel::<Job>(32);
        let (runtime_sender, runtime) = watch::channel(db.runtime_state()?);
        let (updates, _) = broadcast::channel(128);
        let publisher = updates.clone();
        std::thread::Builder::new()
            .name("zone-persistence".into())
            .spawn(move || {
                let _database_lock = database_lock;
                let mut polled = std::time::Instant::now();
                loop {
                    if polled.elapsed() >= Duration::from_secs(1) {
                        if let Err(error)=db.expire_inventory(crate::survival_rules::unix_millis().unwrap_or(0)){tracing::error!("inventory expiry failed: {error}");}
                        for (loot, updates) in &refill {
                            let sample = updates.borrow().clone();
                            if let Some(sample) = sample.filter(|sample| sample.fresh())
                                && let Err(error) = db.replenish_loot(loot, &sample) {
                                tracing::error!("authored loot replenishment failed: {error}");
                            }
                        }
                        let state = db.runtime_state().unwrap_or_default();
                        runtime_sender.send_if_modified(|current| {
                            if *current != state {
                                *current = state;
                                true
                            } else {
                                false
                            }
                        });
                        polled = std::time::Instant::now();
                    }
                    let job = match rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(job) => job,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    let Some(operation) = job.operation else {
                        let _ = job.reply.send(Ok(json!({"flushed":true})));
                        continue;
                    };
                    worker_stats.queued.fetch_sub(1, Ordering::Relaxed);
                    // Accepted writes commit even if the HTTP caller disconnects. Retrying
                    // the same request ID returns the original durable outcome.
                    let recipient = if let Operation::Transfer(command)
                    | Operation::TransferWithContext(command, _) = &operation
                    {
                        Some(command.recipient.clone())
                    } else {
                        None
                    };
                    let result = match (job.session, operation) {
                        (None, Operation::AuthorizeNativeWorld(world, checkpoint)) => db.authorize_native_world(&world, checkpoint),
                        (None, Operation::ImportNativeCorpse(corpse, checkpoint)) => db.import_native_corpse(corpse, checkpoint),
                        (None, Operation::ReadNativeEquipment(players)) => db.read_native_equipment(players),
                        (Some(context), operation) => db.execute_session(&context, operation),
                        (None, operation) => db.execute(&job.secret, operation),
                    }.map_err(|error| {
                        tracing::warn!("persistence operation failed: {error}");
                        "persistence unavailable".to_string()
                    });
                    if result
                        .as_ref()
                        .is_ok_and(|value| value["status"] == "committed")
                        && let Some(recipient) = recipient
                    {
                        // Only committed outcomes publish hints. Replayed successes may
                        // re-publish; consumers treat hints as invalidations, not deltas.
                        match db.principal_for_secret(&job.secret) {
                            Ok(Some(sender)) => {
                                let _ = publisher.send(OwnershipChange {
                                    principals: vec![sender, recipient],
                                });
                            }
                            _ => tracing::warn!("committed ownership invalidation lookup failed"),
                        }
                    }
                    let elapsed = job.enqueued.elapsed().as_micros() as u64;
                    worker_stats.last_us.store(elapsed, Ordering::Relaxed);
                    worker_stats.max_us.fetch_max(elapsed, Ordering::Relaxed);
                    worker_stats.completed.fetch_add(1, Ordering::Relaxed);
                    let _ = job.reply.send(result);
                }
            })?;
        Ok((Self {
            tx,
            updates,
            runtime,
            stats,
            loot_presence: Arc::new(loot_presence),
        }, logouts))
    }
    pub async fn flush(&self) -> Result<(), String> {
        let (reply, done) = oneshot::channel();
        let mut job = Job {
            secret: String::new(),
            session: None,
            operation: None,
            reply,
            enqueued: std::time::Instant::now(),
        };
        let start = std::time::Instant::now();
        loop {
            match self.tx.try_send(job) {
                Ok(()) => break,
                Err(mpsc::TrySendError::Full(returned)) => {
                    if start.elapsed() > Duration::from_secs(5) {
                        return Err("persistence drain timeout".into());
                    }
                    job = returned;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(_) => return Err("persistence worker unavailable".into()),
            }
        }
        tokio::time::timeout(Duration::from_secs(10), done)
            .await
            .map_err(|_| "persistence drain timeout")?
            .map_err(|_| "persistence worker unavailable")??;
        Ok(())
    }
    pub fn metrics(&self) -> Value {
        json!({"queued":self.stats.queued.load(Ordering::Relaxed),"peakQueued":self.stats.peak.load(Ordering::Relaxed),"completed":self.stats.completed.load(Ordering::Relaxed),"rejected":self.stats.rejected.load(Ordering::Relaxed),"lastUs":self.stats.last_us.load(Ordering::Relaxed),"maxUs":self.stats.max_us.load(Ordering::Relaxed)})
    }
    pub fn observe_loot_players(&self, id: &str, world: &crate::world::World) {
        if let Some(presence) = self.loot_presence.get(id) {
            presence.send_replace(Some(crate::loot::Presence::capture(world)));
        }
    }
    pub fn runtime(&self) -> watch::Receiver<crate::scene::RuntimeState> {
        self.runtime.clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<OwnershipChange> {
        self.updates.subscribe()
    }
    pub async fn execute(&self, secret: String, operation: Operation) -> Result<Value, String> {
        if !valid_secret(&secret) || matches!(operation, Operation::AuthorizeNativeWorld(..) | Operation::ImportNativeCorpse(..) | Operation::ReadNativeEquipment(..)) {
            return Err("invalid identity credential".into());
        }
        let rx=self.enqueue(secret,None,operation)?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "persistence timeout; outcome unknown")?
            .map_err(|_| "persistence unavailable")?
    }
    /// Nonblocking simulation submission. A peer can keep one receiver in flight;
    /// the global queue is still bounded at 32 and SQLite stays on its worker.
    pub fn inventory_request(&self,context:crate::inventory::Context,operation:Operation)->Result<oneshot::Receiver<Result<Value,String>>,String>{
        validate_session_operation(&operation).map_err(|_|"invalid session operation")?;
        self.enqueue(String::new(),Some(context),operation)
    }
    pub fn native_world_request(&self, world: String, checkpoint: crate::alife_checkpoint::Checkpoint) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        self.enqueue(String::new(), None, Operation::AuthorizeNativeWorld(world, checkpoint))
    }
    pub fn native_corpse_request(&self, corpse: crate::alife_corpse::Corpse, checkpoint: crate::alife_checkpoint::Checkpoint) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        self.enqueue(String::new(), None, Operation::ImportNativeCorpse(corpse, checkpoint))
    }
    pub(crate) fn native_equipment_request(&self, players: Vec<(u32, u32, crate::world::CharacterKey)>) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        self.enqueue(String::new(), None, Operation::ReadNativeEquipment(players))
    }
    fn enqueue(&self,secret:String,session:Option<crate::inventory::Context>,operation:Operation)->Result<oneshot::Receiver<Result<Value,String>>,String>{
        validate_operation(&operation).map_err(|_| "invalid mutation")?;
        let (reply, rx) = oneshot::channel();
        let queued = self.stats.queued.fetch_add(1, Ordering::Relaxed) + 1;
        self.stats.peak.fetch_max(queued, Ordering::Relaxed);
        if self
            .tx
            .try_send(Job {
                secret,
                session,
                operation: Some(operation),
                reply,
                enqueued: std::time::Instant::now(),
            })
            .is_err()
        {
            self.stats.queued.fetch_sub(1, Ordering::Relaxed);
            self.stats.rejected.fetch_add(1, Ordering::Relaxed);
            return Err("persistence busy".into());
        }
        Ok(rx)
    }
}
fn validate_session_operation(operation:&Operation)->Result<()> {
    ensure!(matches!(operation,Operation::Corpses(..)|Operation::CorpseItems(..)|Operation::WorldItems(..)|Operation::ListInventory(..)|Operation::MoveInventory(..)|Operation::TimedReload(..)|Operation::InventoryDeath(..)|Operation::InventoryRespawn(..)|Operation::ResolveImpact(..)|Operation::CommitNativeCondition(..)|Operation::CommitNativeReload(..)|Operation::CommitNativeImpact(..)|Operation::ConsumeNative(..)|Operation::PrepareNativeConsume(..)|Operation::ResolveFields(..)|Operation::FireWeapon(..)|Operation::ThrowGrenade(..)|Operation::ThrowBolt(..)|Operation::StrikeKnife(..)|Operation::SelectWeapon{..}|Operation::SelectDetector{..}|Operation::LoadCondition|Operation::PowerLabLift|Operation::Travel(..)|Operation::SaveCondition(..)|Operation::Consume(..)),"not an inventory session operation");Ok(())
}
fn valid_secret(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
pub(crate) fn validate_request_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_'),
        "invalid request id"
    );
    Ok(())
}
fn validate_shot_target(target: &crate::combat::ShotTarget) -> Result<()> {
    ensure!(crate::ownership::valid_id(&target.character.principal)
        && (0.0..=crate::combat::MAX_OWNED_RANGE).contains(&target.distance)
        && target.speed_factor.is_finite() && target.speed_factor >= 0.0
        && target.penetration.is_none_or(|value| (0.0..=crate::ballistics::MAX_PENETRATION).contains(&value)), "invalid shot target");
    Ok(())
}

fn validate_operation(operation: &Operation) -> Result<()> {
    match operation {
        Operation::AuthorizeNativeWorld(world, checkpoint) => {
            ensure!(crate::inventory::section_valid(world) && checkpoint.lineage != 0
                && checkpoint.generation >= 0, "invalid native checkpoint");
            Ok(())
        }
        Operation::SelectWeapon { slot, .. } => {
            ensure!(matches!(slot, 0..=4 | 6), "invalid active weapon slot");
            Ok(())
        }
        Operation::Travel(handoff) => validate_request_id(&handoff.request_id),
        Operation::InventoryRespawn(command,_)=>validate_request_id(&command.request_id),
        Operation::Write(m) => validate_mutation(m),
        Operation::Transfer(m) | Operation::TransferWithContext(m, _) => {
            crate::ownership::validate(m)
        }
        Operation::MoveInventory(command, _) | Operation::TimedReload(command, ..) => command.validate(),
        Operation::Consume(command, _, _) | Operation::ConsumeNative(command, _) | Operation::PrepareNativeConsume(command) => {
            ensure!(matches!(command.action, crate::inventory::MoveAction::Consume), "expected consume action");
            command.validate()
        }
        Operation::FireWeapon(item, targets, fire) => {
            ensure!(crate::ownership::valid_id(item), "invalid weapon id");
            let limit = usize::from(fire.traced.map_or(1, |round| round.pellets));
            ensure!(limit <= usize::from(crate::ballistics::MAX_PELLETS) && targets.len() <= limit, "invalid shot volley");
            let mut seen = std::collections::HashSet::new();
            let mut contacts = 0;
            for group in targets {
                let target = &group.authority.target;
                contacts += 1 + group.additional.len();
                ensure!(contacts <= limit && seen.insert(target.character.principal.as_str()), "invalid volley targets");
                validate_shot_target(target)?;
                for pellet in &group.additional {
                    ensure!(pellet.character.principal == target.character.principal
                        && pellet.character.life == target.character.life, "pellet target differs from volley victim");
                    validate_shot_target(pellet)?;
                }
            }
            Ok(())
        }
        Operation::StrikeKnife(item, _, target, _) => {
            ensure!(crate::ownership::valid_id(item), "invalid weapon id");
            if let Some(victim) = target {
                validate_shot_target(&victim.authority.target)?;
            }
            Ok(())
        }
        Operation::ThrowGrenade(item, _) | Operation::ThrowBolt(item, _) => {
            ensure!(crate::ownership::valid_id(item), "invalid grenade id");
            Ok(())
        }
        Operation::CommitNativeImpact(proposal) => {
            ensure!(proposal.combat_until_ms>=0 && proposal.condition.equipment<=9_007_199_254_740_991
                && proposal.wear.iter().flatten().all(|value| (0.0..=1.0).contains(value)), "invalid native hit proposal");
            Ok(())
        }
        Operation::CommitNativeReload(reply) => {
            ensure!(reply.phase==crate::native_weapon_action::Phase::Complete && reply.state.is_some(), "invalid native reload result");
            Ok(())
        }
        Operation::CommitNativeCondition(proposal) => {
            ensure!(proposal.equipment <= 9_007_199_254_740_991
                && proposal.checkpoint.projection().is_some(), "invalid native condition proposal");
            Ok(())
        }
        Operation::ResolveImpact(impact) => {
            ensure!((0.0..=100.0).contains(&impact.power), "invalid impact power");
            Ok(())
        }
        Operation::ResolveFields(exposure) => {
            ensure!((1..=crate::environment::MAX_PENDING_PULSES).contains(&exposure.pulses.len())
                && exposure.pulses.iter().all(|pulse| (0.0..=10.0).contains(&pulse.power)), "invalid field pulses");
            Ok(())
        }

        Operation::WorldItems(cursor,..) | Operation::Corpses(cursor,_) => {
            ensure!(cursor.is_empty() || crate::ownership::valid_id(cursor), "invalid world item cursor");Ok(())
        }
        Operation::CorpseItems(source,cursor,generation,_) => {
            ensure!(crate::ownership::valid_id(source),"invalid corpse id");
            ensure!(generation.is_none_or(|g|g<=9007199254740991),"invalid generation");
            ensure!(cursor.is_empty() || (crate::ownership::valid_id(cursor) && generation.is_some()),"invalid corpse cursor");Ok(())
        }
        Operation::ListEntities(cursor, generation) | Operation::ListInventory(cursor, generation) => {
            ensure!(
                generation.is_none_or(|g| g <= 9007199254740991),
                "invalid generation"
            );
            ensure!(
                cursor.is_empty() || generation.is_some(),
                "cursor requires generation"
            );
            ensure!(
                cursor.is_empty() || crate::ownership::valid_id(cursor),
                "invalid cursor"
            );
            Ok(())
        }
        _ => Ok(()),
    }
}
fn validate_mutation(m: &Mutation) -> Result<()> {
    validate_request_id(&m.request_id)?;
    ensure!(
        serde_json::to_vec(&m.value)?.len() <= 4096,
        "record too large"
    );
    Ok(())
}
pub struct Database {
    connection: Connection,
    catalog: Option<Arc<crate::catalog::Catalog>>,
    rules: Option<Arc<crate::survival_rules::SurvivalRules>>,
}
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).context("opening persistence database")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(version <= 23, "unsupported persistence schema {version}");
        if version == 0 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE principals (id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE);
                CREATE TABLE records (principal TEXT PRIMARY KEY REFERENCES principals(id), revision INTEGER NOT NULL, value TEXT NOT NULL);
                CREATE TABLE outcomes (principal TEXT NOT NULL REFERENCES principals(id), request_id TEXT NOT NULL, request TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(principal,request_id));
                PRAGMA user_version=1;")?;
            tx.commit()?;
        }
        if version < 2 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE owned_entities(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES principals(id),revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=4294967295),value TEXT NOT NULL);
                CREATE INDEX owned_entities_owner_id ON owned_entities(owner,id);
                PRAGMA user_version=2;")?;
            tx.commit()?;
        }
        if version < 3 {
            let tx = connection.transaction()?;
            tx.execute_batch("CREATE TABLE ownership_versions(principal TEXT PRIMARY KEY REFERENCES principals(id), generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0 AND generation<=9007199254740991));
                INSERT INTO ownership_versions(principal) SELECT id FROM principals;
                CREATE TRIGGER ownership_principal_insert AFTER INSERT ON principals BEGIN INSERT INTO ownership_versions(principal) VALUES(NEW.id); END;
                CREATE TRIGGER ownership_entity_insert AFTER INSERT ON owned_entities BEGIN UPDATE ownership_versions SET generation=generation+1 WHERE principal=NEW.owner; END;
                CREATE TRIGGER ownership_entity_delete AFTER DELETE ON owned_entities BEGIN UPDATE ownership_versions SET generation=generation+1 WHERE principal=OLD.owner; END;
                CREATE TRIGGER ownership_entity_update AFTER UPDATE ON owned_entities WHEN OLD.owner!=NEW.owner OR OLD.revision!=NEW.revision OR OLD.value!=NEW.value BEGIN UPDATE ownership_versions SET generation=generation+1 WHERE principal IN (OLD.owner,NEW.owner); END;
                PRAGMA user_version=3;")?;
            tx.commit()?;
        }
        if version < 4 {
            let tx = connection.transaction()?;
            tx.execute_batch("ALTER TABLE principals ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN(0,1));
                CREATE TABLE runtime_meta(id INTEGER PRIMARY KEY CHECK(id=1),auth_epoch INTEGER NOT NULL); INSERT INTO runtime_meta VALUES(1,0);
                CREATE TRIGGER principal_revocation AFTER UPDATE OF revoked,credential_hash ON principals WHEN OLD.revoked!=NEW.revoked OR OLD.credential_hash!=NEW.credential_hash BEGIN UPDATE runtime_meta SET auth_epoch=auth_epoch+1 WHERE id=1; END;
                CREATE TABLE scene_entities(entity TEXT PRIMARY KEY REFERENCES owned_entities(id) ON DELETE CASCADE,world TEXT NOT NULL,model TEXT NOT NULL CHECK(model='stalker'),x REAL NOT NULL,z REAL NOT NULL,yaw REAL NOT NULL);
                PRAGMA user_version=4;")?;
            tx.commit()?;
        }
        if version < 5 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::inventory::SCHEMA)?;
            tx.commit()?;
        }
        if version < 6 {
            let tx=connection.transaction()?;tx.execute_batch(crate::inventory::LIFECYCLE_SCHEMA)?;tx.commit()?;
        }
        if version < 7 {
            let tx=connection.transaction()?;
            tx.execute_batch("CREATE INDEX inventory_world_nearby ON item_containers(kind,world,x); PRAGMA user_version=7;")?;
            tx.commit()?;
        }
        if version < 8 {
            let tx=connection.transaction()?;tx.execute_batch(crate::inventory::CONTAINER_SCHEMA)?;tx.commit()?;
        }
        if version < 9 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::loot::SCHEMA)?;
            tx.commit()?;
        }
        if version < 10 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::loot::REFILL_SCHEMA)?;
            tx.commit()?;
        }
        if version < 11 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::loot::LOOSE_SCHEMA)?;
            tx.commit()?;
        }
        if version < 12 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::survival::SCHEMA)?;
            tx.commit()?;
        }
        if version < 13 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::survival::LOCATION_SCHEMA)?;
            tx.commit()?;
        }
        if version < 14 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::travel::SCHEMA)?;
            tx.commit()?;
        }
        if version < 15 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::travel::LIFT_SCHEMA)?;
            tx.commit()?;
        }
        if version < 16 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::inventory::ACTIVE_WEAPON_SCHEMA)?;
            tx.commit()?;
        }
        if version < 17 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::inventory::GRENADE_SLOT_SCHEMA)?;
            tx.commit()?;
        }
        if version < 18 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::inventory::KNIFE_SLOT_SCHEMA)?;
            tx.commit()?;
        }
        if version < 19 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::inventory::BOLT_SLOT_SCHEMA)?;
            tx.commit()?;
        }
        if version < 20 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::artefact::SCHEMA)?;
            tx.commit()?;
        }
        if version < 21 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::alife_corpse::SCHEMA)?;
            tx.commit()?;
        }
        if version < 22 {
            let tx = connection.transaction()?;
            tx.execute_batch(crate::alife_checkpoint::SCHEMA)?;
            tx.commit()?;
        }
        if version < 23 {
            let tx=connection.transaction()?;
            tx.execute_batch(crate::native_condition::SCHEMA)?;
            tx.commit()?;
        }
        Ok(Self { connection, catalog: None, rules:None })
    }
    fn read_native_equipment(&self, players: Vec<(u32, u32, crate::world::CharacterKey)>) -> Result<Value> {
        let tx = self.connection.unchecked_transaction()?;
        let mut query = tx.prepare_cached(
            "SELECT i.place,i.section,i.state,a.generation FROM inventory_characters a
             JOIN item_containers c ON c.owner=a.principal AND c.kind='carried'
             LEFT JOIN inventory_items i ON i.container=c.id
               AND (i.place IN ('slot:7','slot:12') OR i.place GLOB 'belt:[0-4]')
             WHERE a.principal=?1 AND a.life=?2 AND a.alive=1
             ORDER BY i.place GLOB 'belt:*',i.place='slot:12',i.place",
        )?;
        let mut snapshots = Vec::with_capacity(players.len());
        for (id, incarnation, key) in players {
            let mut rows = query.query(params![key.principal, key.life])?;
            let Some(mut row) = rows.next()? else { continue };
            let generation = u64::try_from(row.get::<_, i64>(3)?)?;
            let mut equipment = Vec::new();
            loop {
                if let Some(place) = row.get::<_, Option<String>>(0)? {
                    let slot = match place.as_str() {
                        "slot:7" => 7,
                        "slot:12" => 12,
                        cell => crate::alife_interests::ARMOUR_BELT_START +
                            cell.strip_prefix("belt:").context("invalid native belt placement")?.parse::<u8>()?,
                    };
                    let section: String = row.get(1)?;
                    let state: crate::inventory::ItemState = serde_json::from_str(&row.get::<_, String>(2)?)?;
                    equipment.push((slot, section, state.condition, state.upgrades));
                }
                let Some(next) = rows.next()? else { break };
                row = next;
            }
            let weapon = crate::alife_weapon::read(&tx, &key.principal, self.catalog.as_deref(), generation)?;
            snapshots.push((id, incarnation, generation, equipment, weapon));
        }
        Ok(serde_json::to_value(snapshots)?)
    }

    fn authorize_native_world(&mut self, world: &str, checkpoint: crate::alife_checkpoint::Checkpoint) -> Result<Value> {
        let tx = self.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let accepted = checkpoint.admit(&tx, world)?;
        tx.commit()?;
        Ok(json!({ "accepted": accepted }))
    }
    fn import_native_corpse(&mut self, corpse: crate::alife_corpse::Corpse, checkpoint: crate::alife_checkpoint::Checkpoint) -> Result<Value> {
        let catalog = self.catalog.as_deref().context("native corpse requires the stock catalog")?;
        let rules = self.rules.as_deref().context("native corpse requires survival rules")?;
        let tx = self.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        ensure!(checkpoint.is_current(&tx, &corpse.world)?, "native corpse checkpoint is no longer current");
        let result = crate::alife_corpse::commit(&tx, catalog, rules, corpse)?;
        tx.commit()?;
        Ok(result)
    }
    fn replenish_loot(&mut self, loot: &crate::loot::AuthoredLoot, sample: &crate::loot::Presence) -> Result<()> {
        let rules = self.rules.as_deref().context("authored loot requires survival rules")?;
        let tx = self.connection.transaction()?;
        let count = loot.refill(&tx, rules, sample, crate::survival_rules::unix_millis()?)?;
        if sample.fresh() {
            tx.commit()?;
            if count > 0 {
                tracing::debug!(count, "replenished authored loot");
            }
        }
        Ok(())
    }
    pub fn set_catalog(&mut self,catalog:Arc<crate::catalog::Catalog>){self.catalog=Some(catalog);}
    pub fn set_survival_rules(&mut self,rules:Arc<crate::survival_rules::SurvivalRules>)->Result<()>{rules.validate(self.catalog.as_deref().context("rules require catalog")?)?;self.rules=Some(rules);Ok(())}
    pub fn expire_inventory(&mut self,now:i64)->Result<usize>{let tx=self.connection.transaction()?;let count=crate::inventory::expire(&tx,now)?;tx.commit()?;Ok(count)}
    /// Trusted import/setup only, not a client inventory API. Existing characters
    /// retain their life/death state; reconnect does not grant any equipment.
    pub fn initialize_inventory(&mut self, principal: &str) -> Result<Value> {
        let tx = self.connection.transaction()?;
        crate::inventory::initialize(&tx, principal)?;
        let carried = crate::inventory::personal_container(&tx, principal, "carried")?;
        let storage = crate::inventory::personal_container(&tx, principal, "storage")?;
        tx.commit()?;
        Ok(json!({"carried":carried,"storage":storage}))
    }
    /// Trusted original-placement importer only. No HTTP/WebRTC mint route.
    pub fn provision_world_container(&mut self, world: &str, position: [f64; 3]) -> Result<String> {
        let tx = self.connection.transaction()?;
        let id = crate::inventory::world_container(&tx, "world", world, position)?;
        tx.commit()?;
        Ok(id)
    }
    /// Trusted item importer only. Catalog compatibility must be checked by the
    /// importer before provisioning equipped items; this is not an equip action.
    pub fn provision_inventory_item(&mut self, container: &str, section: &str, state: &crate::inventory::ItemState, place: &str) -> Result<String> {
        if let Some(catalog)=&self.catalog {catalog.validate_state(section,state)?;}
        let tx = self.connection.transaction()?;
        let id = crate::inventory::provision(&tx, container, section, state, place)?;
        tx.commit()?;
        Ok(id)
    }
    pub fn runtime_state(&self) -> Result<crate::scene::RuntimeState> {
        let auth_epoch = self.connection.query_row(
            "SELECT auth_epoch FROM runtime_meta WHERE id=1",
            [],
            |r| r.get(0),
        )?;
        let mut query = self.connection.prepare(
            "SELECT entity,world,model,x,z,yaw FROM scene_entities ORDER BY entity LIMIT 1025",
        )?;
        let mut scenes = Vec::new();
        for row in query.query_map([], |r| {
            Ok(crate::scene::Descriptor {
                id: r.get(0)?,
                world: r.get(1)?,
                model: r.get(2)?,
                x: r.get(3)?,
                z: r.get(4)?,
                yaw: r.get(5)?,
            })
        })? {
            let d = row?;
            d.validate()?;
            scenes.push(d);
        }
        ensure!(scenes.len() <= 1024, "persistent scene capacity exceeded");
        Ok(crate::scene::RuntimeState {
            healthy: true,
            auth_epoch,
            scenes,
        })
    }
    fn principal_for_secret(&self, secret: &str) -> Result<Option<String>> {
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("zone-identity-v1\n{secret}"))
        );
        Ok(self
            .connection
            .query_row(
                "SELECT id FROM principals WHERE credential_hash=?1 AND revoked=0",
                [hash],
                |r| r.get(0),
            )
            .optional()?)
    }
    /// Trusted server provisioning only. No client-facing mint operation exists.
    pub fn provision_entity(&mut self, owner: &str, value: &Value) -> Result<String> {
        ensure!(crate::ownership::valid_id(owner), "invalid owner");
        let value = serde_json::to_string(value)?;
        ensure!(value.len() <= 4096, "entity too large");
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let id:String=tx.query_row("INSERT INTO owned_entities(id,owner,revision,value) VALUES(lower(hex(randomblob(16))),?1,0,?2) RETURNING id",params![owner,value],|r|r.get(0))?;
        tx.commit()?;
        Ok(id)
    }
    pub fn execute(&mut self, secret: &str, operation: Operation) -> Result<Value> {
        ensure!(valid_secret(secret), "invalid credential");
        let hash = format!(
            "{:x}",
            Sha256::digest(format!("zone-identity-v1\n{secret}"))
        );
        self.execute_authenticated(Some(&hash),None,operation)
    }
    fn execute_session(&mut self,context:&crate::inventory::Context,operation:Operation)->Result<Value>{
        validate_session_operation(&operation)?;
        self.execute_authenticated(None,Some(context),operation)
    }
    fn execute_authenticated(&mut self,hash:Option<&str>,session:Option<&crate::inventory::Context>,operation:Operation)->Result<Value>{
        validate_operation(&operation)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if matches!(operation, Operation::Register) {
            tx.execute("INSERT INTO principals(id,credential_hash) VALUES(lower(hex(randomblob(16))),?1) ON CONFLICT(credential_hash) DO NOTHING", [&hash])?;
        }
        let principal: Option<String> = if let Some(context)=session {
            if context.expires<=std::time::Instant::now(){return Ok(json!({"error":"expired session authority"}));}
            tx.query_row("SELECT p.id FROM principals p,runtime_meta m WHERE p.id=?1 AND p.revoked=0 AND m.id=1 AND m.auth_epoch=?2",params![context.principal,i64::try_from(context.auth_epoch)?],|r|r.get(0)).optional()?
        }else {tx
            .query_row(
                "SELECT id FROM principals WHERE credential_hash=?1 AND revoked=0",
                [&hash],
                |r| r.get(0),
            )
            .optional()?};
        let Some(principal) = principal else {
            if let Some(context) = session && matches!(operation, Operation::InventoryDeath(..)) {
                let revoked: Option<bool> = tx.query_row("SELECT revoked FROM principals WHERE id=?1", [&context.principal], |row| row.get(0)).optional()?;
                return Ok(json!({"error":"unauthorized identity","revoked":revoked.unwrap_or(true)}));
            }
            return Ok(json!({"error":"unauthorized identity"}));
        };
        let campaign_visit = if session.is_some() {
            crate::travel::authority(&tx, &principal)?
        } else {
            None
        };
        if let Some(context) = session && !matches!(operation, Operation::Travel(..)) {
            let current = campaign_visit.as_ref().map_or(context.visit == 0, |visit| {
                visit.world == context.world && visit.visit == context.visit
            });
            if !current {
                return Ok(json!({"error":"stale campaign visit"}));
            }
        }
        tx.execute("INSERT INTO records(principal,revision,value) VALUES(?1,0,'null') ON CONFLICT DO NOTHING", [&principal])?;
        let loadout_update = session.is_some() && matches!(operation,
            Operation::MoveInventory(..) | Operation::TimedReload(..) | Operation::InventoryDeath(..) | Operation::InventoryRespawn(..) | Operation::Consume(..) | Operation::ConsumeNative(..) | Operation::CommitNativeImpact(..) | Operation::CommitNativeReload(..) | Operation::SelectWeapon { .. } | Operation::SelectDetector { .. });
        let mut result = match operation {
            Operation::AuthorizeNativeWorld(..) | Operation::ImportNativeCorpse(..) | Operation::ReadNativeEquipment(..) => bail!("native world requires the private host"),
            Operation::Register | Operation::Resume => {
                let epoch: i64 =
                    tx.query_row("SELECT auth_epoch FROM runtime_meta WHERE id=1", [], |r| {
                        r.get(0)
                    })?;
                let mut result = json!({"principalId":principal,"authEpoch":epoch});
                if let Some(visit) = crate::travel::authority(&tx, &principal)? {
                    result["campaign"] = serde_json::to_value(visit)?;
                }
                result
            }
            Operation::Read => {
                let (revision, value): (u32, String) = tx.query_row(
                    "SELECT revision,value FROM records WHERE principal=?1",
                    [&principal],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                json!({"principalId":principal,"revision":revision,"value":serde_json::from_str::<Value>(&value)?})
            }
            Operation::ListEntities(after, generation) => {
                crate::ownership::list(&tx, &principal, &after, generation)?
            }
            Operation::Transfer(command) => {
                crate::ownership::transfer(&tx, &principal, &command, None)?
            }
            Operation::TransferWithContext(command, context) => {
                crate::ownership::transfer(&tx, &principal, &command, Some(&context))?
            }
            Operation::ListInventory(after, generation) => {
                crate::inventory::initialize_with_rules(&tx, &principal,self.catalog.as_deref(),self.rules.as_deref())?;
                crate::inventory::list(&tx, &principal, &after, generation)?
            }
            Operation::Corpses(after,context)=>{
                crate::inventory::initialize(&tx,&principal)?;
                crate::inventory::corpses(&tx,&principal,&after,session.unwrap_or(&context))?
            }
            Operation::CorpseItems(source,after,generation,context)=>{
                crate::inventory::initialize(&tx,&principal)?;
                crate::inventory::container_items(&tx,&principal,&source,&after,generation,session.unwrap_or(&context),self.rules.as_deref())?
            }
            Operation::WorldItems(after, context, detector_scan) => {
                crate::inventory::initialize(&tx, &principal)?;
                crate::inventory::world_items(&tx, &principal, &after, session.unwrap_or(&context), self.rules.as_deref(), self.catalog.as_deref(), &detector_scan)?
            }
            Operation::MoveInventory(command, context) => {
                crate::inventory::initialize_with_rules(&tx, &principal,self.catalog.as_deref(),self.rules.as_deref())?;
                crate::inventory::move_item(&tx, &principal, &command, session.unwrap_or(&context), self.catalog.as_deref(),self.rules.as_deref(),None)?
            }
            Operation::TimedReload(command, timings, native_rules) => {
                let context = session.context("timed reload requires a live session")?;
                crate::inventory::timed_reload(&tx, context, &command,
                    self.catalog.as_deref().context("timed reload requires an item catalog")?,
                    self.rules.as_deref(), timings.as_deref(), native_rules.as_ref())?
            }
            Operation::LoadCondition => {
                let context = session.context("condition requires a live session")?;
                crate::inventory::initialize_with_rules(&tx, &principal, self.catalog.as_deref(), self.rules.as_deref())?;
                crate::travel::bind(&tx, context)?;
                let (life, alive, record, location) = crate::survival::load(&tx, &principal)?;
                let (loadout, appearance) = self.catalog.as_deref().map(|catalog| crate::inventory::carried_equipment(&tx, &principal, catalog)).transpose()?.unwrap_or_default();
                let visit = campaign_visit.map_or(0, |visit| visit.visit);
                json!({"life":life,"visit":visit,"alive":alive,"condition":record,"location":location,"loadout":loadout,"appearance":appearance})
            }
            Operation::Travel(handoff) => {
                let context = session.context("travel requires a live session")?;
                crate::travel::commit(&tx, context, handoff)?
            }
            Operation::PowerLabLift => {
                let context = session.context("lift generator requires a live session")?;
                crate::travel::power_lift(&tx, context)?
            }
            Operation::SaveCondition(record, location) => {
                let context = session.context("condition requires a live session")?;
                ensure!(campaign_visit.is_none() || location.world == context.world, "checkpoint world differs from campaign visit");
                json!({"saved":crate::survival::checkpoint(&tx, &principal, context.life, &record, &location)?})
            }
            Operation::PrepareNativeConsume(command) => {
                let context=session.context("native consumption requires a live session")?;
                crate::inventory::prepare_native_consumption(&tx,context,&command,
                    self.catalog.as_deref().context("consumption requires item catalog")?)?
            }
            Operation::ConsumeNative(command, proposal) => {
                let context = session.context("native consumption requires a live session")?;
                crate::inventory::consume_native(&tx, context, &command,
                    self.catalog.as_deref(), self.rules.as_deref(), proposal)?
            }
            Operation::Consume(command, _, record) => {
                let context = session.context("consumption requires a live session")?;
                crate::inventory::move_item(&tx, &principal, &command, context, self.catalog.as_deref(),
                    self.rules.as_deref(), Some(record))?
            }
            Operation::FireWeapon(item, target, fire) => {
                let context = session.context("firing requires a live session")?;
                crate::weapon_inventory::debit_shot(&tx, context, &item,
                    self.catalog.as_deref().context("firing requires item catalog")?, target,
                    fire, self.rules.as_deref())?
            }
            Operation::ThrowGrenade(item, force) => {
                let context = session.context("throwing requires a live session")?;
                crate::hand_grenade::debit(&tx, context, &item,
                    self.catalog.as_deref().context("throwing requires item catalog")?, force)?
            }
            Operation::ThrowBolt(item, force) => {
                let context = session.context("throwing requires a live session")?;
                crate::hand_grenade::prepare_bolt(&tx, context, &item,
                    self.catalog.as_deref().context("throwing requires item catalog")?, force)?
            }
            Operation::StrikeKnife(item, mode, target, splash) => {
                let context = session.context("striking requires a live session")?;
                crate::knife::strike(&tx, context, &item,
                    self.catalog.as_deref().context("striking requires item catalog")?, (mode, splash),
                    target.map(|target| *target), self.rules.as_deref())?
            }
            Operation::SelectWeapon { life, slot } => {
                let context = session.context("weapon selection requires a live session")?;
                crate::inventory::select_weapon(&tx, context, life, slot,
                    self.catalog.as_deref().context("weapon selection requires item catalog")?)?
            }
            Operation::SelectDetector { life, active } => {
                let context = session.context("detector selection requires a live session")?;
                crate::artefact::select(&tx, context, life, active,
                    self.catalog.as_deref().context("detector selection requires item catalog")?)?
            }
            Operation::CommitNativeImpact(proposal) => {
                let context=session.context("native hit requires a live session")?;
                crate::native_condition::commit_impact(&tx,context,
                    self.catalog.as_deref().context("native hit requires item catalog")?,self.rules.as_deref(),proposal)?
            }
            Operation::CommitNativeReload(reply) => {
                let context=session.context("native reload requires a live session")?;
                crate::native_weapon_action::commit_reload(&tx,context,
                    self.catalog.as_deref().context("native reload requires item catalog")?,reply)?
            }
            Operation::CommitNativeCondition(proposal) => {
                let context = session.context("native condition requires a live session")?;
                crate::native_condition::commit(&tx, context, self.rules.as_deref(), proposal)?
            }
            Operation::ResolveImpact(impact) => {
                let context = session.context("impact requires a live session")?;
                ensure!(campaign_visit.is_none() || impact.location.world == context.world, "impact world differs from campaign visit");
                let result = crate::survival::resolve_impact(&tx,
                    self.catalog.as_deref().context("impact requires item catalog")?,
                    self.rules.as_deref(), context, impact)?;
                serde_json::to_value(result)?
            }
            Operation::ResolveFields(exposure) => {
                let context = session.context("fields require a live session")?;
                ensure!(exposure.location.world == context.world, "field world differs from campaign visit");
                let result = crate::environment::resolve(&tx,
                    self.catalog.as_deref().context("fields require item catalog")?,
                    self.rules.as_deref(), context, exposure)?;
                serde_json::to_value(result)?
            }
            Operation::InventoryDeath(context) => {
                crate::inventory::initialize(&tx, &principal)?;
                crate::inventory::die(&tx, &principal, session.unwrap_or(&context),self.rules.as_deref())?
            }
            Operation::InventoryRespawn(command,context)=>{
                crate::inventory::respawn(&tx,&principal,&command,session.unwrap_or(&context),self.catalog.as_deref().context("respawn requires catalog")?,self.rules.as_deref().context("respawn requires rules")?)?
            }
            Operation::Write(m) => {
                let request = serde_json::to_string(&m)?;
                let previous: Option<(String,String)> = tx.query_row("SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2", params![principal,m.request_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
                if let Some((original, response)) = previous {
                    if original != request {
                        return Ok(json!({"error":"request id reused with different payload"}));
                    }
                    return Ok(serde_json::from_str(&response)?);
                }
                // Keep the prototype ledger bounded without forgetting old outcomes.
                // A production compaction/expiry protocol must be explicit, never delete
                // deduplication entries then accidentally re-execute a stale request.
                let count: u32 = tx.query_row(
                    "SELECT count(*) FROM outcomes WHERE principal=?1",
                    [&principal],
                    |r| r.get(0),
                )?;
                if count >= 10000 {
                    return Ok(json!({"error":"request ledger full"}));
                }
                let revision: u32 = tx.query_row(
                    "SELECT revision FROM records WHERE principal=?1",
                    [&principal],
                    |r| r.get(0),
                )?;
                let response = if revision != m.expected_revision {
                    json!({"status":"conflict","revision":revision})
                } else {
                    let Some(next) = revision.checked_add(1) else {
                        bail!("revision exhausted");
                    };
                    tx.execute(
                        "UPDATE records SET revision=?1,value=?2 WHERE principal=?3",
                        params![next, serde_json::to_string(&m.value)?, principal],
                    )?;
                    json!({"status":"committed","revision":next})
                };
                tx.execute("INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)", params![principal,m.request_id,request,serde_json::to_string(&response)?])?;
                response
            }
        };
        if loadout_update && matches!(result["status"].as_str(), Some("committed" | "respawned" | "selected"))
            && let Some(catalog) = self.catalog.as_deref()
        {
            tx.execute("UPDATE inventory_characters SET grenade_drawn=0 WHERE principal=?1 AND grenade_drawn=1 AND NOT EXISTS (
                SELECT 1 FROM inventory_items i JOIN item_containers c ON c.id=i.container
                WHERE c.owner=?1 AND c.kind='carried' AND i.place='slot:4')", [&principal])?;
            let (loadout, appearance) = crate::inventory::carried_equipment(&tx, &principal, catalog)?;
            if loadout.active_weapon_slot == 0 && result["status"] == "committed" {
                // Moving the selected weapon out of its slot holsters it in the
                // same transaction. NULL keeps the legacy auto-selection rule.
                tx.execute("UPDATE inventory_characters SET active_weapon_slot=0
                    WHERE principal=?1 AND active_weapon_slot IN (1,2,3,6)", [&principal])?;
            }
            result["loadout"] = serde_json::to_value(loadout)?;
            result["appearance"] = serde_json::to_value(appearance)?;
        }
        tx.commit()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn secret(n: char) -> String {
        std::iter::repeat_n(n, 64).collect()
    }
    fn write(id: &str, revision: u32, n: u32) -> Operation {
        Operation::Write(Mutation {
            request_id: id.into(),
            expected_revision: revision,
            value: json!({"test":n}),
        })
    }

    #[test]
    fn native_armour_reads_equipped_items_only_for_the_current_life() {
        use crate::{inventory::{ItemPayload, ItemState}, world::CharacterKey};
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        let principal = db.execute(&secret('e'), Operation::Register).unwrap()["principalId"]
            .as_str().unwrap().to_owned();
        let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
        let state = ItemState { condition: 0.75, upgrades: vec!["outfit_upgrade".into()], payload: ItemPayload::Equipment };
        let players = |life| vec![(2, 9, CharacterKey { principal: principal.clone(), life })];
        assert_eq!(db.read_native_equipment(players(0)).unwrap(), json!([[2, 9, 0, [], null]]));
        db.provision_inventory_item(&carry, "stalker_outfit", &state, "slot:7").unwrap();
        db.provision_inventory_item(&carry, "helm_respirator", &state, "rucksack").unwrap();
        let artefact = ItemState { condition: 0.5, upgrades: vec![], payload: ItemPayload::Equipment };
        db.provision_inventory_item(&carry, "af_medusa", &artefact, "belt:1").unwrap();
        assert_eq!(db.read_native_equipment(players(0)).unwrap(),
            json!([[2, 9, 3, [[7, "stalker_outfit", 0.75, ["outfit_upgrade"]], [17, "af_medusa", 0.5, []]], null]]));
        assert_eq!(db.read_native_equipment(players(1)).unwrap(), json!([]));
        db.connection.execute("UPDATE inventory_characters SET alive=0 WHERE principal=?1", [&principal]).unwrap();
        assert_eq!(db.read_native_equipment(players(0)).unwrap(), json!([]));
    }

    fn campaign_context(principal: String, level: &str, visit: u32) -> crate::inventory::Context {
        let mut collision = crate::collision::tests::actor_fixture(0);
        collision.manifest.level = level.into();
        crate::inventory::Context {
            principal,
            life: 0,
            visit,
            auth_epoch: 0,
            world: format!("{level}-static-v1"),
            position: [1.0, 0.0, 1.0],
            interaction_radius: 2.0,
            eye_height: 1.55,
            collision: Some(Arc::new(collision)),
            expires: std::time::Instant::now() + Duration::from_secs(30),
        }
    }

    fn campaign_location(level: &str) -> crate::survival::Location {
        crate::survival::Location {
            world: format!("{level}-static-v1"),
            content_revision: "a".repeat(64),
            position: [1.0, 0.0, 1.0],
            yaw: 1.0,
            crouched: false,
            combat_until_ms: 123,
            logout_until_ms: 0,
        }
    }

    fn campaign_handoff(to: &str, request_id: &str, revision: u32) -> Operation {
        let mut state = crate::survival::State::default();
        state.apply_hit(0.2, true);
        Operation::Travel(crate::travel::Handoff {
            request_id: request_id.into(),
            route: 1012,
            before: crate::survival::Record { revision, state },
            arrival: campaign_location(to),
        })
    }

    #[test]
    fn campaign_handoff_survives_lost_reply_and_fences_prior_visits() {
        let path = std::env::temp_dir().join(format!("zone-campaign-handoff-{}.sqlite", std::process::id()));
        let key = secret('a');
        let mut db = Database::open(&path).unwrap();
        let principal = db.execute(&key, Operation::Register).unwrap()["principalId"].as_str().unwrap().to_owned();
        let source = campaign_context(principal.clone(), "zaton", 0);
        let destination = campaign_context(principal.clone(), "jupiter", 1);
        db.execute_session(&source, Operation::LoadCondition).unwrap();
        let carry = db.initialize_inventory(&principal).unwrap()["carried"].as_str().unwrap().to_owned();
        db.provision_inventory_item(&carry, "bandage", &crate::inventory::ItemState {
            condition: 0.8, upgrades: Vec::new(), payload: crate::inventory::ItemPayload::Consumable { uses: 1 },
        }, "rucksack").unwrap();
        let inventory = || Operation::ListInventory(String::new(), None);
        let original = db.execute_session(&source, inventory()).unwrap();
        let outbound = || campaign_handoff("jupiter", "outbound", 0);
        db.connection.execute_batch(
            "CREATE TRIGGER fail_receipt BEFORE INSERT ON outcomes
             BEGIN SELECT RAISE(ABORT, 'lost receipt write'); END;"
        ).unwrap();
        assert!(db.execute_session(&source, outbound()).is_err());
        let unchanged = db.execute_session(&source, Operation::LoadCondition).unwrap();
        assert_eq!(unchanged["condition"]["revision"], 0);
        assert_eq!(unchanged["location"], Value::Null);
        db.connection.execute_batch("DROP TRIGGER fail_receipt;").unwrap();
        drop(db);

        // Exit before the simulation or client can consume the committed reply.
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "persistence::tests::campaign_handoff_crash_child"])
            .env("ZONE_TEST_CAMPAIGN_CRASH_DB", &path)
            .status().unwrap();
        assert_eq!(child.code(), Some(73));

        let mut db = Database::open(&path).unwrap();
        let route = db.execute(&key, Operation::Resume).unwrap();
        assert_eq!(route["campaign"], json!({"world":"jupiter-static-v1","visit":1}));
        let replay = db.execute_session(&source, outbound()).unwrap();
        assert_eq!(replay, json!({"status":"committed","world":"jupiter-static-v1","visit":1,"life":0}));
        let arrival = db.execute_session(&destination, Operation::LoadCondition).unwrap();
        assert_eq!(arrival["condition"]["revision"], 1);
        assert_eq!(arrival["condition"]["state"]["health"], json!(0.8_f32));
        assert_eq!(arrival["condition"]["state"]["bleeding"], json!(0.2_f32));
        assert_eq!(arrival["location"], serde_json::to_value(campaign_location("jupiter")).unwrap());
        assert_eq!(db.execute_session(&destination, inventory()).unwrap(), original);

        let old = || Operation::SaveCondition(serde_json::from_value(arrival["condition"].clone()).unwrap(), campaign_location("zaton"));
        assert_eq!(db.execute_session(&source, old()).unwrap()["error"], "stale campaign visit");
        assert_eq!(db.execute_session(&source, Operation::LoadCondition).unwrap()["error"], "stale campaign visit");
        assert_eq!(db.execute_session(&destination, campaign_handoff("zaton", "inbound", 1)).unwrap()["visit"], 2);
        assert_eq!(db.execute_session(&source, inventory()).unwrap()["error"], "stale campaign visit");
        assert_eq!(db.execute_session(&source, Operation::LoadCondition).unwrap()["error"], "stale campaign visit");
        assert_eq!(db.execute_session(&source, outbound()).unwrap(), replay);
        let returned = campaign_context(principal, "zaton", 2);
        assert_eq!(db.execute_session(&returned, inventory()).unwrap(), original);
        assert_eq!(db.execute_session(&returned, Operation::InventoryDeath(returned.clone())).unwrap()["status"], "committed");
        assert_eq!(db.execute(&key, Operation::Resume).unwrap()["campaign"], json!({"world":"zaton-static-v1","visit":2}));
        drop(db);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn campaign_handoff_crash_child() {
        let Some(path) = std::env::var_os("ZONE_TEST_CAMPAIGN_CRASH_DB") else { return; };
        let mut db = Database::open(Path::new(&path)).unwrap();
        let principal = db.execute(&secret('a'), Operation::Resume).unwrap()["principalId"].as_str().unwrap().to_owned();
        let context = campaign_context(principal, "zaton", 0);
        assert_eq!(db.execute_session(&context, campaign_handoff("jupiter", "outbound", 0)).unwrap()["status"], "committed");
        std::process::exit(73);
    }
    #[test]
    fn durable_identity_cas_replay_and_isolation() {
        let path = std::env::temp_dir().join(format!(
            "zone-persistence-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut db = Database::open(&path).unwrap();
        let a = secret('a');
        let b = secret('b');
        let identity = db.execute(&a, Operation::Register).unwrap();
        assert_eq!(identity, db.execute(&a, Operation::Register).unwrap());
        assert!(
            db.execute(&b, Operation::Resume)
                .unwrap()
                .get("error")
                .is_some()
        );
        assert_ne!(identity, db.execute(&b, Operation::Register).unwrap());
        let result = db.execute(&a, write("one", 0, 1)).unwrap();
        assert_eq!(result["revision"], 1);
        assert_eq!(
            db.execute(&a, write("two", 0, 2)).unwrap()["status"],
            "conflict"
        );
        assert!(
            db.execute(&a, write("one", 1, 9))
                .unwrap()
                .get("error")
                .is_some()
        );
        drop(db);
        let mut db = Database::open(&path).unwrap();
        assert_eq!(identity, db.execute(&a, Operation::Resume).unwrap());
        assert_eq!(result, db.execute(&a, write("one", 0, 1)).unwrap());
        assert_eq!(
            db.execute(&a, Operation::Read).unwrap()["value"],
            json!({"test":1})
        );
        assert_eq!(db.execute(&b, Operation::Read).unwrap()["revision"], 0);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn rejects_bad_credentials_and_payloads() {
        let mut db = Database::open(Path::new(":memory:")).unwrap();
        assert!(db.execute("short", Operation::Register).is_err());
        assert!(db.execute(&secret('a'), write("../bad", 0, 1)).is_err());
        let mut m = Mutation {
            request_id: "ok".into(),
            expected_revision: 0,
            value: json!("x".repeat(4097)),
        };
        assert!(validate_mutation(&m).is_err());
        m.value = Value::Null;
        assert!(validate_mutation(&m).is_ok());
    }
    #[test]
    fn concurrent_cas_has_one_winner_and_crash_recovers_committed_outcome() {
        let path = std::env::temp_dir().join(format!("zone-crash-{}.sqlite", std::process::id()));
        let a = secret('c');
        let mut db = Database::open(&path).unwrap();
        db.execute(&a, Operation::Register).unwrap();
        drop(db);
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                let a = a.clone();
                std::thread::spawn(move || {
                    Database::open(&path)
                        .unwrap()
                        .execute(&a, write(&format!("race-{i}"), 0, i))
                        .unwrap()
                })
            })
            .collect();
        let outcomes: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(
            outcomes
                .iter()
                .filter(|r| r["status"] == "committed")
                .count(),
            1
        );
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "persistence::tests::crash_child", "--nocapture"])
            .env("ZONE_CRASH_TEST_DATABASE", &path)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(27));
        let mut db = Database::open(&path).unwrap();
        assert_eq!(
            db.execute(&a, Operation::Read).unwrap()["value"],
            json!({"test":42})
        );
        assert_eq!(
            db.execute(&a, write("crash-commit", 1, 42)).unwrap(),
            json!({"status":"committed","revision":2})
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn crash_child() {
        let Ok(path) = std::env::var("ZONE_CRASH_TEST_DATABASE") else {
            return;
        };
        let mut db = Database::open(Path::new(&path)).unwrap();
        db.execute(&secret('c'), write("crash-commit", 1, 42))
            .unwrap();
        db.connection
            .execute_batch("BEGIN IMMEDIATE; UPDATE records SET value='999',revision=3;")
            .unwrap();
        // No Rust destructors/SQLite close: test recovery after interrupted work.
        std::process::exit(27);
    }
}
