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
use std::{path::Path, time::Duration};
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
}
struct Job {
    secret: String,
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
}
impl Persistence {
    pub fn start(path: &Path) -> Result<Self> {
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
                    let result = db.execute(&job.secret, operation).map_err(|error| {
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
        Ok(Self {
            tx,
            updates,
            runtime,
            stats,
        })
    }
    pub async fn flush(&self) -> Result<(), String> {
        let (reply, done) = oneshot::channel();
        let mut job = Job {
            secret: String::new(),
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
    pub fn runtime(&self) -> watch::Receiver<crate::scene::RuntimeState> {
        self.runtime.clone()
    }
    pub fn subscribe(&self) -> broadcast::Receiver<OwnershipChange> {
        self.updates.subscribe()
    }
    pub async fn execute(&self, secret: String, operation: Operation) -> Result<Value, String> {
        if !valid_secret(&secret) {
            return Err("invalid identity credential".into());
        }
        validate_operation(&operation).map_err(|_| "invalid mutation")?;
        let (reply, rx) = oneshot::channel();
        let queued = self.stats.queued.fetch_add(1, Ordering::Relaxed) + 1;
        self.stats.peak.fetch_max(queued, Ordering::Relaxed);
        if self
            .tx
            .try_send(Job {
                secret,
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
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "persistence timeout; outcome unknown")?
            .map_err(|_| "persistence unavailable")?
    }
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
fn validate_operation(operation: &Operation) -> Result<()> {
    match operation {
        Operation::Write(m) => validate_mutation(m),
        Operation::Transfer(m) | Operation::TransferWithContext(m, _) => {
            crate::ownership::validate(m)
        }
        Operation::ListEntities(cursor, generation) => {
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
}
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).context("opening persistence database")?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        ensure!(version <= 4, "unsupported persistence schema {version}");
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
        Ok(Self { connection })
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
        validate_operation(&operation)?;
        let tx = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if matches!(operation, Operation::Register) {
            tx.execute("INSERT INTO principals(id,credential_hash) VALUES(lower(hex(randomblob(16))),?1) ON CONFLICT(credential_hash) DO NOTHING", [&hash])?;
        }
        let principal: Option<String> = tx
            .query_row(
                "SELECT id FROM principals WHERE credential_hash=?1 AND revoked=0",
                [&hash],
                |r| r.get(0),
            )
            .optional()?;
        let Some(principal) = principal else {
            return Ok(json!({"error":"unauthorized identity"}));
        };
        tx.execute("INSERT INTO records(principal,revision,value) VALUES(?1,0,'null') ON CONFLICT DO NOTHING", [&principal])?;
        let result = match operation {
            Operation::Register | Operation::Resume => {
                let epoch: i64 =
                    tx.query_row("SELECT auth_epoch FROM runtime_meta WHERE id=1", [], |r| {
                        r.get(0)
                    })?;
                json!({"principalId":principal,"authEpoch":epoch})
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
