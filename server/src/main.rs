use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    future::IntoFuture,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use str0m::{
    Candidate, Event, Input as RtcInput, Output, Rtc,
    change::SdpOffer,
    channel::{ChannelConfig, ChannelId, Reliability},
    net::{Protocol, Receive},
};
use tokio::{
    net::UdpSocket,
    sync::{mpsc, oneshot},
    time::MissedTickBehavior,
};
use zone_server::{
    collision::CollisionMap,
    contract, control, protocol, replication,
    session::SessionConfig,
    world::{CharacterKey, Kind, SNAPSHOT_EVERY, TICK_HZ, Vec3, World, newer},
};

const CONDITION_CHECKPOINT_TICKS: u32 = TICK_HZ * 5;

#[derive(Clone)]
struct HttpState {
    survival: bool,
    session: Arc<SessionConfig>,
    commands: mpsc::Sender<Command>,
    token: Option<String>,
    persistence: Option<zone_server::persistence::Persistence>,
    origin: String,
}
enum Command {
    Offer(
        SdpOffer,
        Option<zone_server::policy::Admission>,
        oneshot::Sender<Result<Value, String>>,
    ),
    Metrics(oneshot::Sender<Value>),
    Context(
        String,
        oneshot::Sender<Option<zone_server::policy::ActionContext>>,
    ),
    Shutdown(oneshot::Sender<()>),
}
struct RuntimeFeeds {
    ownership: Option<tokio::sync::broadcast::Receiver<zone_server::persistence::OwnershipChange>>,
    scene: Option<tokio::sync::watch::Receiver<zone_server::scene::RuntimeState>>,
    inventory: InventoryRuntime,
    saved_logouts: Vec<zone_server::survival::SavedLogout>,
}
struct InventoryRuntime {
    store: Option<zone_server::persistence::Persistence>,
    catalog: Option<Arc<zone_server::catalog::Catalog>>,
    auth_epoch: u64,
    logout_ticks: u32,
    checkpoints: CheckpointPhase,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckpointPhase { Running, Draining, Final }
enum InventoryResponse {
    LoadCharacter,
    Action { sequence: Option<u32>, death: bool },
    Fire { sequence: u32, tick: u32, shot: zone_server::combat::TracedShot, queue_index: Option<u32> },
    Blast(zone_server::combat::BlastContact),
    Dose { sequence: u32, before: zone_server::survival::State },
    Checkpoint,
}
struct InventoryPending {
    response: InventoryResponse,
    reply: oneshot::Receiver<Result<Value,String>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Offer {
    version: u8,
    contract: contract::Contract,
    offer: SdpOffer,
    #[serde(default)]
    identity_secret: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Control {
    Corpses { sequence:u32, after:String },
    CorpseItems { sequence:u32, source:String, after:String, generation:Option<u64> },
    WorldItems { sequence:u32, after:String },
    InventoryList { sequence:u32, after:String, generation:Option<u64> },
    InventoryMove { sequence:u32, command:zone_server::inventory::Move },
    Attack {
        sequence: u32,
        target: u32,
    },
    Reload {
        sequence: u32,
    },
    Respawn {
        sequence: u32, request_id:String, life:u32,
    },
    Fire(FireControl),
    TriggerStart(FireControl),
    TriggerStop { sequence: u32 },
    Leave {
        sequence: u32,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FireControl {
    sequence: u32,
    item: Option<String>,
    aim: zone_server::combat::Aim,
}
// Refreshes ride on sequenced movement packets. A lost release cannot keep
// firing after the most recent matching sample has aged out.
const TRIGGER_LEASE_TICKS: u32 = 9;
struct HeldTrigger {
    sequence: u32,
    item: String,
    aim: zone_server::combat::Aim,
    sampled_at: u32,
    next: Option<NextRound>,
}
struct NextRound {
    index: u32,
    tick: u32,
    fraction: f64,
}
impl HeldTrigger {
    fn advance(&mut self, index: u32, tick: u32, round: &zone_server::combat::QueueRound) -> bool {
        let Some(index) = index.checked_add(1) else { return false; };
        if round.limit.is_some_and(|limit| index >= u32::from(limit)) {
            return false;
        }
        // Carry fractional ticks forward. A 570 RPM weapon alternates three
        // and four ticks, with no catch-up bursts after a late transaction.
        let exact = round.ticks.max(1.0) + self.next.as_ref().map_or(0.0, |next| next.fraction);
        let elapsed = (exact - 1e-9).ceil().max(1.0);
        self.next = Some(NextRound {
            index,
            tick: tick.wrapping_add(elapsed as u32),
            fraction: (exact - elapsed).min(0.0),
        });
        true
    }
}
#[derive(Default, Serialize)]
struct Metrics {
    sessions: usize,
    players: usize,
    vulnerable_logouts: usize,
    tick: u32,
    ticks: u64,
    tick_us: u64,
    max_tick_us: u64,
    replication_us: u64,
    max_replication_us: u64,
    late_ticks: u64,
    received_datagrams: u64,
    sent_datagrams: u64,
    sent_bytes: u64,
    invalid_messages: u64,
    rate_limited: u64,
    skipped_snapshots: u64,
    state_payload_bytes: u64,
    state_keyframes: u64,
    state_deltas: u64,
    state_budget_skips: u64,
    lifecycle_messages: u64,
    lifecycle_deferred: u64,
    shots: u64,
    shot_hits: u64,
    shot_rejections: u64,
    udp_drops: u64,
}
struct Transport {
    rtc: Rtc,
    state: ChannelId,
    control: ChannelId,
    deadline: Instant,
}
struct Peer {
    inventory_pending: Option<InventoryPending>,
    blast_hits: VecDeque<zone_server::combat::BlastContact>,
    inventory_life: Option<u32>,
    inventory_dead: bool,
    inventory_ready: bool,
    condition_revision: u32,
    vitals: Option<[u32; 11]>,
    armour_seen: u32,
    next_checkpoint: u32,
    disconnect_saved: bool,
    logout_until: Option<u32>,
    checkpoint_combat_until: Option<u32>,
    replication: replication::Replicator,
    state_budget: replication::ByteBudget,
    lifecycle: zone_server::lifecycle::Lifecycle,
    weapon_view: Option<zone_server::combat::WeaponView>,
    owned_fire_cooldown: Option<(u32, u32)>,
    trigger: Option<HeldTrigger>,
    transport: Option<Transport>,
    player: Option<u32>,
    principal: Option<String>,
    ownership_dirty: bool,
    born: Instant,
    last_input: Instant,
    sequence: Option<u32>,
    window: Instant,
    messages: u32,
}
impl Peer {
    fn new(now: Instant, transport: Option<Transport>) -> Self {
        Self {
            inventory_pending: None,
            blast_hits: VecDeque::new(),
            inventory_life: None,
            inventory_dead: false,
            inventory_ready: false,
            condition_revision: 0,
            vitals: None,
            armour_seen: 0,
            next_checkpoint: 0,
            disconnect_saved: false,
            logout_until: None,
            checkpoint_combat_until: None,
            replication: replication::Replicator::default(),
            state_budget: replication::ByteBudget::default(),
            lifecycle: zone_server::lifecycle::Lifecycle::default(),
            weapon_view: None,
            owned_fire_cooldown: None,
            trigger: None,
            transport,
            player: None,
            principal: None,
            ownership_dirty: false,
            born: now,
            last_input: now,
            sequence: None,
            window: now,
            messages: 0,
        }
    }

    fn connected(&self) -> bool {
        self.transport.as_ref().is_some_and(|transport| transport.rtc.is_alive())
    }

    fn disconnect(&mut self) {
        self.transport = None;
        self.trigger = None;
    }

    fn accepts(&self, input: &RtcInput<'_>) -> bool {
        self.transport.as_ref().is_some_and(|transport| transport.rtc.is_alive() && transport.rtc.accepts(input))
    }

    fn receive(&mut self, input: RtcInput<'_>) {
        if let Some(transport) = &mut self.transport && transport.rtc.handle_input(input).is_err() {
            self.disconnect();
        }
    }

    fn allow(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            self.window = now;
            self.messages = 0;
        }
        self.messages += 1;
        self.messages <= 120
    }
    fn control(&mut self, value: Value) {
        if let Some(transport) = &mut self.transport && let Some(mut ch) = transport.rtc.channel(transport.control) {
            let Ok(bytes) = control::encode_event(&value) else {
                self.disconnect();
                return;
            };
            // Control events must never be silently discarded. Disconnect a
            // stalled consumer; durable transactions will need persisted IDs.
            if ch.buffered_amount() > 16 * 1024 || !ch.write(true, &bytes).unwrap_or(false) {
                self.disconnect();
            }
        }
    }

    fn send_detonations(&mut self, world: &World, detonations: &[zone_server::combat::Detonation]) {
        if !self.inventory_ready {
            return;
        }
        let Some(actor) = self.player.and_then(|id| world.entities.get(&id)) else { return; };
        let Some(mut channel) = self.transport.as_mut().and_then(|transport| transport.rtc.channel(transport.control)) else { return; };
        if channel.buffered_amount() >= 8192 {
            return;
        }
        let effects: Vec<_> = detonations.iter()
            .filter(|event| actor.position.distance_squared(event.position) <= zone_server::world::INTEREST_RADIUS.powi(2))
            .take(8)
            .map(|event| (&event.section, event.position.x, event.position.y, event.position.z))
            .collect();
        if !effects.is_empty() && let Ok(bytes) = control::encode_event(&json!({"type":"detonations","effects":effects})) {
            // Cosmetic traffic yields to reliable inventory and combat state.
            let _ = channel.write(true, &bytes);
        }
    }

    fn welcome(&mut self, session: &SessionConfig, world: &World) {
        self.control(json!({"type":"welcome","version":protocol::VERSION,"contract":session.contract,
            "playerId":self.player,"principalId":self.principal,"tickHz":TICK_HZ,"safeZones":world.safe_zones}));
    }

    fn begin_logout(&mut self, world: &mut World, logout_ticks: u32) {
        if self.logout_until.is_some() || self.inventory_life.is_none() {
            return;
        }
        let Some(actor) = self.player.and_then(|id| world.entities.get(&id)) else { return; };
        let delay = if actor.health > 0 && !world.is_protected(actor) { logout_ticks } else { 0 };
        let id = actor.id;
        world.clear_player_input(id);
        if !self.blast_hits.is_empty()
            || self.inventory_pending.as_ref().is_some_and(|pending| matches!(pending.response, InventoryResponse::Blast(_)))
        {
            return;
        }
        self.logout_until = Some(world.tick.wrapping_add(delay));
        self.next_checkpoint = world.tick;
    }

    fn logout_waiting(&self, world: &World) -> bool {
        self.logout_until.is_some_and(|until| newer(until, world.tick))
            && self.player.and_then(|id| world.entities.get(&id)).is_some_and(|actor| actor.health > 0)
    }

    fn needs_final_state(&self, world: &World) -> bool {
        self.inventory_life.is_some() && self.player.and_then(|id| world.entities.get(&id))
            .is_some_and(|actor| if actor.health == 0 { !self.inventory_dead } else { !self.disconnect_saved })
    }

    fn inventory_busy(&self) -> bool {
        self.inventory_pending.is_some() || !self.blast_hits.is_empty()
    }

    fn take_character(&mut self, old: Self) {
        self.player = old.player;
        self.inventory_life = old.inventory_life;
        self.condition_revision = old.condition_revision;
        self.next_checkpoint = old.next_checkpoint;
        self.checkpoint_combat_until = old.checkpoint_combat_until;
        self.logout_until = old.logout_until;
        self.owned_fire_cooldown = old.owned_fire_cooldown;
    }
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "zone_server=info,str0m=warn".into()),
        )
        .init();
    str0m::crypto::from_feature_flags().install_process_default();
    let http: SocketAddr = std::env::var("ZONE_HTTP_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:8082".into())
        .parse()?;
    let udp = zone_server::network::udp_bind_address(
        &std::env::var("ZONE_UDP_ADDR").unwrap_or_else(|_| "127.0.0.1:50000".into()),
    )?;
    let public: SocketAddr = std::env::var("ZONE_PUBLIC_ADDR")
        .unwrap_or_else(|_| udp.to_string())
        .parse()?;
    let token = std::env::var("ZONE_DEV_TOKEN")
        .ok()
        .filter(|s| !s.is_empty());
    ensure!(
        http.ip().is_loopback() || token.is_some(),
        "Non-loopback signaling requires ZONE_DEV_TOKEN; production account authentication is not implemented"
    );
    ensure!(
        !public.ip().is_unspecified(),
        "ZONE_PUBLIC_ADDR must be a reachable host address, not a wildcard"
    );
    let max_players: usize = std::env::var("ZONE_MAX_PLAYERS")
        .unwrap_or_else(|_| "200".into())
        .parse()?;
    ensure!(
        (1..=4096).contains(&max_players),
        "ZONE_MAX_PLAYERS must be 1..4096"
    );
    let session = Arc::new(if let Ok(path) = std::env::var("ZONE_COLLISION_MANIFEST") {
        let map = CollisionMap::load(std::path::Path::new(&path))?;
        let x = std::env::var("ZONE_SPAWN_X")
            .unwrap_or_else(|_| "87.599976".into())
            .parse()?;
        let z = std::env::var("ZONE_SPAWN_Z")
            .unwrap_or_else(|_| "115".into())
            .parse()?;
        let height = std::env::var("ZONE_SPAWN_Y").ok().map(|value| value.parse()).transpose()?;
        SessionConfig::zaton(map, x, z, height)?
    } else {
        SessionConfig::synthetic()
    });
    let catalog=std::env::var("ZONE_ITEM_CATALOG").ok()
        .map(|path|zone_server::catalog::Catalog::load(std::path::Path::new(&path)).map(Arc::new)).transpose()?;
    if let Some(catalog)=&catalog {tracing::info!(sha256=%catalog.sha256,sections=catalog.sections_len(),"loaded original item catalog");}
    let rules=if let Some(catalog)=&catalog {
        let rules=match std::env::var("ZONE_SURVIVAL_RULES"){Ok(path)=>zone_server::survival_rules::SurvivalRules::load(std::path::Path::new(&path))?,Err(_)=>zone_server::survival_rules::SurvivalRules::default()};
        rules.validate(catalog)?;Some(Arc::new(rules))
    }else{None};
    let database = std::env::var("ZONE_DATABASE").ok();
    let loose_loot = std::env::var_os("ZONE_LOOSE_LOOT").map(std::path::PathBuf::from);
    let loot = if let Some(path) = std::env::var_os("ZONE_AUTHORED_LOOT") {
        ensure!(database.is_some(), "authored loot requires a persistence database");
        let collision = session.collision().context("authored loot requires original collision geometry")?;
        let catalog = catalog.as_deref().context("authored loot requires an original item catalog")?;
        Some(zone_server::loot::AuthoredLoot::load(
            std::path::Path::new(&path), loose_loot.as_deref(), &session.contract.world, &collision, catalog,
        )?)
    } else {
        ensure!(loose_loot.is_none(), "ZONE_LOOSE_LOOT requires ZONE_AUTHORED_LOOT");
        None
    };
    let survival_tuning = match (&catalog, &rules) {
        (Some(catalog), Some(rules)) => Some(zone_server::survival::Tuning::from_catalog(catalog, rules)?),
        _ => None,
    };
    let (persistence, saved_logouts) = if let Some(path) = database {
        let restore_world = rules.as_ref().filter(|rules| rules.logout_vulnerability_seconds != 0)
            .map(|_| &session.contract);
        let (store, logouts) = zone_server::persistence::Persistence::start_for_world(
            std::path::Path::new(&path), catalog.clone(), rules.clone(), loot, restore_world,
        )?;
        (Some(store), logouts)
    } else {
        (None, Vec::new())
    };
    let ownership_updates = persistence.as_ref().map(|p| p.subscribe());
    let runtime_updates = persistence.as_ref().map(|p| p.runtime());
    let persistence_handle = persistence.clone();
    let mut world = session.world()?;
    world.survival_tuning = survival_tuning;
    if let Some(rules) = &rules {
        world.combat_lock_ticks = rules.safe_zone_combat_lock_seconds * TICK_HZ;
    }
    let socket = UdpSocket::bind(udp).await.context("binding gameplay UDP")?;
    let (tx, rx) = mpsc::channel(32);
    let shutdown_commands = tx.clone();
    let state = Arc::new(HttpState {
        survival:catalog.is_some(),
        session: session.clone(),
        commands: tx,
        token,
        persistence,
        origin: std::env::var("ZONE_ORIGIN").unwrap_or_else(|_| format!("http://{http}")),
    });
    let app = Router::new()
        .route(
            "/",
            get(|| async { Html(include_str!("../../misc/web/multiplayer/index.html")) }),
        )
        .route(
            "/client.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/client.mjs"),
                )
            }),
        )
        .route("/network-faults.mjs",get(||async{([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/network-faults.mjs"))}))
        .route(
            "/lifecycle.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/lifecycle.mjs"),
                )
            }),
        )
        .route(
            "/protocol.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/protocol.mjs"),
                )
            }),
        )
        .route(
            "/harness.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/harness.mjs"),
                )
            }),
        )
        .route(
            "/contract.json",
            get(|State(s): State<Arc<HttpState>>| async move { Json(s.session.contract.clone()) }),
        )
        .route(
            "/contract.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/contract.mjs"),
                )
            }),
        )
        .route(
            "/engine-bridge.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/engine-bridge.mjs"),
                )
            }),
        )
        .route(
            "/bridge-probe-worker.mjs",
            get(|| async {
                (
                    [("content-type", "text/javascript")],
                    include_str!("../../misc/web/multiplayer/bridge-probe-worker.mjs"),
                )
            }),
        )
        .route(
            "/world.json",
            get(|State(s): State<Arc<HttpState>>| async move {
                Json(json!({"contract":s.session.contract,"content":s.session.content,"persistence":s.persistence.is_some(),"survival":s.survival}))
            }),
        )
        .route("/identity/register", post(register_identity))
        .route("/identity/resume", post(resume_identity))
        .route("/identity/state", get(read_identity).post(write_identity))
        .route("/identity/entities", get(list_entities))
        .route("/identity/transfer", post(transfer_entity))
        .route("/identity-test.html", get(|| async { Html(include_str!("../../misc/web/multiplayer/identity-test.html")) }))
        .route("/identity-test.mjs", get(|| async { ([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/identity-test.mjs")) }))
        .route("/identity.mjs", get(|| async { ([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/identity.mjs")) }))
        .route("/outbox.mjs", get(||async{ ([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/outbox.mjs")) }))
        .route("/outbox-test.html",get(||async{Html(include_str!("../../misc/web/multiplayer/outbox-test.html"))}))
        .route("/outbox-test.mjs",get(||async{ ([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/outbox-test.mjs")) }))
        .route("/owned-state.mjs",get(||async{ ([("content-type","text/javascript")],include_str!("../../misc/web/multiplayer/owned-state.mjs")) }))
        .route("/offer", post(offer))
        .route("/metrics", get(metrics))
        .route("/health",get(|State(s):State<Arc<HttpState>>|async move{let healthy=s.persistence.as_ref().is_none_or(|p|p.runtime().borrow().healthy);(if healthy{StatusCode::OK}else{StatusCode::SERVICE_UNAVAILABLE},Json(json!({"healthy":healthy})))}))
        .layer(axum::middleware::map_response(|mut response: axum::response::Response| async move {
            response.headers_mut().insert("cache-control", "no-store".parse().unwrap());
            response
        }))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(http).await?;
    tracing::info!(%http,%udp,%public,max_players,"Rust multiplayer foundation listening");
    let mut simulation = tokio::spawn(run(
        socket,
        public,
        rx,
        max_players,
        session,
        world,
        RuntimeFeeds {
            ownership: ownership_updates,
            scene: runtime_updates,
            inventory: InventoryRuntime{store:persistence_handle.clone(),catalog,auth_epoch:0,
                logout_ticks:rules.as_ref().map_or(0, |rules| rules.logout_vulnerability_seconds * TICK_HZ),
                checkpoints:CheckpointPhase::Running},
            saved_logouts,
        },
    ));
    let serving = axum::serve(listener, app).with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
    });
    tokio::select! {
        result = serving.into_future() => {
            result?;let (reply,done)=oneshot::channel();shutdown_commands.send(Command::Shutdown(reply)).await?;
            tokio::time::timeout(Duration::from_secs(5),done).await??;
            simulation.await.context("simulation shutdown")??;
        }
        result = &mut simulation => { result.context("simulation task failed")??; }
    }
    if let Some(store) = persistence_handle {
        store.flush().await.map_err(anyhow::Error::msg)?;
    }
    Ok(())
}
fn authorized(state: &HttpState, headers: &HeaderMap) -> bool {
    if let Some(origin) = headers.get("origin")
        && origin.to_str().ok() != Some(state.origin.as_str())
    {
        return false;
    }
    state.token.as_ref().is_none_or(|t| {
        headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(format!("Bearer {t}").as_str())
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdentityCredential {
    secret: String,
}
async fn identity_operation(
    state: &HttpState,
    headers: &HeaderMap,
    secret: String,
    mut operation: zone_server::persistence::Operation,
) -> (StatusCode, Json<Value>) {
    if !authorized(state, headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"unauthorized origin or token"})),
        );
    }
    let Some(store) = &state.persistence else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"persistence disabled"})),
        );
    };
    if let zone_server::persistence::Operation::Transfer(command) = &operation {
        let principal = match store
            .execute(secret.clone(), zone_server::persistence::Operation::Resume)
            .await
        {
            Ok(v) => v["principalId"].as_str().map(str::to_string),
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"identity unavailable"})),
                );
            }
        };
        let Some(principal) = principal else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"unauthorized identity"})),
            );
        };
        let (reply, done) = oneshot::channel();
        if state
            .commands
            .try_send(Command::Context(principal.clone(), reply))
            .is_err()
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"policy queue busy"})),
            );
        }
        let context = match tokio::time::timeout(Duration::from_secs(2), done).await {
            Ok(Ok(context)) => context,
            _ => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"policy unavailable"})),
                );
            }
        };
        operation = zone_server::persistence::Operation::TransferWithContext(
            command.clone(),
            context.unwrap_or(zone_server::policy::ActionContext {
                principal,
                world: None,
                session: None,
                expires: Instant::now(),
            }),
        );
    }
    match store.execute(secret, operation).await {
        Ok(value) => {
            let code = if value["error"] == "unauthorized identity" {
                StatusCode::UNAUTHORIZED
            } else if value.get("error").is_some() || value["status"] == "conflict" {
                StatusCode::CONFLICT
            } else {
                StatusCode::OK
            };
            (code, Json(value))
        }
        Err(error) => {
            let code = if error.starts_with("invalid") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            };
            (code, Json(json!({"error":error})))
        }
    }
}
async fn register_identity(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Json(body): Json<IdentityCredential>,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        body.secret,
        zone_server::persistence::Operation::Register,
    )
    .await
}
async fn resume_identity(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Json(body): Json<IdentityCredential>,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        body.secret,
        zone_server::persistence::Operation::Resume,
    )
    .await
}
fn identity_header(headers: &HeaderMap) -> String {
    headers
        .get("x-zone-identity")
        .and_then(|h| h.to_str().ok())
        .unwrap_or_default()
        .to_string()
}
async fn read_identity(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        identity_header(&headers),
        zone_server::persistence::Operation::Read,
    )
    .await
}
async fn write_identity(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Json(body): Json<zone_server::persistence::Mutation>,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        identity_header(&headers),
        zone_server::persistence::Operation::Write(body),
    )
    .await
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct EntityCursor {
    generation: Option<u64>,
    #[serde(default)]
    after: String,
}
async fn list_entities(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Query(cursor): Query<EntityCursor>,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        identity_header(&headers),
        zone_server::persistence::Operation::ListEntities(cursor.after, cursor.generation),
    )
    .await
}
async fn transfer_entity(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Json(body): Json<zone_server::ownership::Transfer>,
) -> impl IntoResponse {
    identity_operation(
        &state,
        &headers,
        identity_header(&headers),
        zone_server::persistence::Operation::Transfer(body),
    )
    .await
}
async fn offer(
    State(state): State<Arc<HttpState>>,
    headers: HeaderMap,
    Json(body): Json<Offer>,
) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"unauthorized origin or token"})),
        );
    }
    if body.contract != state.session.contract {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"multiplayer world or contract mismatch"})),
        );
    }
    if body.version != protocol::VERSION {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"protocol version mismatch"})),
        );
    }
    let principal = if let Some(store) = &state.persistence {
        let Some(secret) = body.identity_secret else {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"identity required"})),
            );
        };
        match store
            .execute(secret, zone_server::persistence::Operation::Resume)
            .await
        {
            Ok(value) if value.get("principalId").and_then(Value::as_str).is_some() => {
                Some(zone_server::policy::Admission {
                    principal: value["principalId"].as_str().unwrap().to_owned(),
                    auth_epoch: value["authEpoch"].as_i64().expect("database auth epoch"),
                })
            }
            Ok(_) => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error":"unauthorized identity"})),
                );
            }
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"identity service unavailable"})),
                );
            }
        }
    } else {
        if body.identity_secret.is_some() {
            return (
                StatusCode::CONFLICT,
                Json(json!({"error":"persistence disabled"})),
            );
        }
        None
    };
    let (tx, rx) = oneshot::channel();
    if state
        .commands
        .try_send(Command::Offer(body.offer, principal, tx))
        .is_err()
    {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"signaling queue full"})),
        );
    }
    match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(Ok(answer))) => (StatusCode::OK, Json(answer)),
        Ok(Ok(Err(error))) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"simulation unavailable"})),
        ),
    }
}
async fn metrics(State(state): State<Arc<HttpState>>, headers: HeaderMap) -> impl IntoResponse {
    if !authorized(&state, &headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error":"unauthorized"})));
    }
    let (tx, rx) = oneshot::channel();
    if state.commands.try_send(Command::Metrics(tx)).is_err() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"busy"})),
        );
    }
    match tokio::time::timeout(Duration::from_secs(1), rx).await {
        Ok(Ok(mut value)) => {
            if let Some(store) = &state.persistence {
                value["persistence"] = store.metrics();
            }
            (StatusCode::OK, Json(value))
        }
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"unavailable"})),
        ),
    }
}
fn create_peer(
    offer: SdpOffer,
    address: SocketAddr,
    session: &SessionConfig,
) -> Result<(Peer, Value)> {
    let now = Instant::now();
    let mut rtc = Rtc::builder()
        .set_ice_lite(true)
        .set_sctp_max_buffered_amount(64 * 1024)
        .build(now);
    rtc.add_local_candidate(Candidate::host(address, "udp")?)
        .context("candidate")?;
    let answer = rtc.sdp_api().accept_offer(offer)?;
    let mut changes = rtc.sdp_api();
    let state = changes.add_channel_with_config(ChannelConfig {
        label: "state-v3".into(),
        ordered: false,
        reliability: Reliability::MaxRetransmits { retransmits: 0 },
        negotiated: Some(0),
        protocol: "zone-v3".into(),
    });
    let control = changes.add_channel_with_config(ChannelConfig {
        label: "control-v3".into(),
        ordered: true,
        reliability: Reliability::Reliable,
        negotiated: Some(2),
        protocol: "zone-v3".into(),
    });
    ensure!(
        changes.apply().is_none(),
        "unexpected channel renegotiation"
    );
    Ok((
        Peer::new(now, Some(Transport { rtc, state, control, deadline: now })),
        json!({"version":protocol::VERSION,"contract":session.contract,"answer":answer,"tickHz":TICK_HZ,"snapshotHz":TICK_HZ/SNAPSHOT_EVERY}),
    ))
}
async fn run(
    socket: UdpSocket,
    public: SocketAddr,
    mut commands: mpsc::Receiver<Command>,
    max_players: usize,
    session: Arc<SessionConfig>,
    mut world: World,
    mut feeds: RuntimeFeeds,
) -> Result<()> {
    // This single socket represents the advertised public ICE endpoint. Hosting
    // NAT (including Fly's UDP ingress) rewrites its destination to the bound
    // interface. Restore the logical destination used by our host candidate;
    // passing the private/wildcard bind address makes ICE reject valid STUN.
    let local = public;
    let mut scenes = zone_server::scene::SceneRegistry::default();
    let mut runtime_healthy = true;
    let mut auth_epoch = 0;
    if let Some(rx) = &feeds.scene {
        let state = rx.borrow().clone();
        ensure!(state.healthy, "persistence unavailable at startup");
        scenes.reconcile(&state.scenes, &session, &mut world)?;
        auth_epoch = state.auth_epoch;
    }
    let mut peers: HashMap<u64, Peer> = HashMap::new();
    let mut routes: HashMap<SocketAddr, u64> = HashMap::new();
    let mut next_peer = 0u64;
    let mut metrics = Metrics::default();
    let mut combat = zone_server::combat::Combat::default();
    let mut inventory=feeds.inventory;
    inventory.auth_epoch=u64::try_from(auth_epoch)?;
    for saved in feeds.saved_logouts {
        let remaining = ticks_until(saved.location.logout_until_ms).min(inventory.logout_ticks);
        if remaining == 0 { continue; }
        let Some(id) = restore_saved_pose(&mut world, &session, &saved.location) else { continue; };
        let actor = world.entities.get_mut(&id).unwrap();
        actor.set_condition(saved.condition.state);
        actor.loadout = saved.loadout;
        actor.character_key = Some(CharacterKey { principal: saved.principal.clone(), life: saved.life });
        let mut peer = Peer::new(Instant::now(), None);
        peer.player = Some(id);
        peer.principal = Some(saved.principal);
        peer.inventory_life = Some(saved.life);
        peer.condition_revision = saved.condition.revision;
        peer.logout_until = Some(world.tick.wrapping_add(remaining));
        next_peer += 1;
        peers.insert(next_peer, peer);
    }
    combat.capture(&world);
    let mut buf = [0u8; 65536];
    let mut simulation = tokio::time::interval(Duration::from_secs_f64(1.0 / TICK_HZ as f64));
    simulation.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut timers = tokio::time::interval(Duration::from_millis(10));
    timers.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut last_tick = Instant::now();
    loop {
        tokio::select! {
            changed=async {match &mut feeds.scene {Some(rx)=>rx.changed().await,None=>std::future::pending().await}}=>{
                changed.context("persistence worker stopped")?;let state=feeds.scene.as_ref().unwrap().borrow().clone();
                if state.auth_epoch!=auth_epoch||!state.healthy {for peer in peers.values_mut(){if peer.principal.is_some(){peer.disconnect();}}}
                runtime_healthy=state.healthy;auth_epoch=state.auth_epoch;inventory.auth_epoch=u64::try_from(auth_epoch)?;
                if state.healthy{scenes.reconcile(&state.scenes,&session,&mut world)?;}
            },
            change=async {match &mut feeds.ownership {Some(rx)=>rx.recv().await,None=>std::future::pending().await}} => {
                match change {
                    Ok(change)=>{for peer in peers.values_mut(){if peer.principal.as_ref().is_some_and(|id|change.principals.contains(id)){peer.ownership_dirty=true;}}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{for peer in peers.values_mut(){peer.ownership_dirty=peer.principal.is_some();}},
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>feeds.ownership=None,
                }
            },
            command=commands.recv()=>match command {
                Some(Command::Offer(offer,admission,reply))=>{
                    if admission.as_ref().is_some_and(|ticket|!ticket.valid_at(auth_epoch)){let _=reply.send(Err("identity authorization changed; reconnect".into()));continue;}
                    let principal=admission.map(|ticket|ticket.principal);
                    if reply.is_closed(){continue;}
                    if !runtime_healthy{let _=reply.send(Err("persistence unavailable".into()));continue;}
                    let mut resume = None;
                    if let Some((id, old)) = principal.as_ref().and_then(|principal| {
                        peers.iter_mut().find(|(_, peer)| peer.principal.as_ref() == Some(principal))
                    }) {
                        if old.connected() { let _=reply.send(Err("identity already connected".into()));continue; }
                        old.begin_logout(&mut world, inventory.logout_ticks);
                        if old.inventory_busy() || !old.logout_waiting(&world) {
                            let _=reply.send(Err("character checkpoint in progress; reconnect".into()));continue;
                        }
                        resume = Some(*id);
                    }
                    if resume.is_none() && peers.len()>=max_players {let _=reply.send(Err("server is full".into()));continue;}
                    match create_peer(offer,public,&session) {
                        Ok((mut peer,mut answer))=>{
                            peer.principal=principal;
                            peer.ownership_dirty=peer.principal.is_some();
                            answer["principalId"]=json!(peer.principal);
                            if reply.send(Ok(answer)).is_ok() {
                                if let Some(id) = resume { peer.take_character(peers.remove(&id).unwrap()); }
                                next_peer+=1;
                                peers.insert(next_peer,peer);
                            }
                        },
                        Err(error)=>{let _=reply.send(Err(error.to_string()));}
                    }
                },
                Some(Command::Shutdown(reply)) => {
                    inventory.checkpoints = CheckpointPhase::Draining;
                    for peer in peers.values_mut() {
                        peer.disconnect();
                    }
                    let deadline = Instant::now() + Duration::from_secs(3);
                    loop {
                        for peer in peers.values_mut() {
                            inventory_poll(peer, &mut world, &session, &inventory, &mut combat, &mut metrics);
                        }
                        let pending = peers.values().any(Peer::inventory_busy);
                        if !pending && inventory.checkpoints == CheckpointPhase::Draining {
                            inventory.checkpoints = CheckpointPhase::Final;
                            for peer in peers.values_mut() {
                                peer.begin_logout(&mut world, inventory.logout_ticks);
                                peer.disconnect_saved = false;
                            }
                            continue;
                        }
                        let unfinished = pending || peers.values().any(|peer| peer.needs_final_state(&world));
                        if !unfinished { break; }
                        if Instant::now() >= deadline {
                            tracing::warn!("timed out draining final survival checkpoints");
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    let _ = reply.send(());
                    break;
                },
                Some(Command::Context(principal,reply))=>{
                    let context=if runtime_healthy{peers.iter().find(|(_,p)|p.principal.as_ref()==Some(&principal)&&p.player.is_some()&&p.connected()).map(|(id,_)|zone_server::policy::ActionContext{principal,world:Some(session.contract.world.clone()),session:Some(*id),expires:Instant::now()+Duration::from_secs(2)})}else{None};let _=reply.send(context);
                },
                Some(Command::Metrics(reply))=>{
                    metrics.sessions=peers.values().filter(|peer|peer.connected()).count();
                    metrics.players=peers.values().filter(|peer|peer.connected()&&peer.inventory_ready&&peer.player.is_some()).count();
                    metrics.vulnerable_logouts=peers.values().filter(|peer|!peer.inventory_ready||!peer.connected()).filter(|peer|peer.logout_waiting(&world)).count();
                    metrics.tick=world.tick;
                    let _=reply.send(json!({"metrics":metrics,"maxPlayers":max_players,"tickHz":TICK_HZ,"snapshotHz":TICK_HZ/SNAPSHOT_EVERY,"world":session.contract.world,"contentRevision":session.contract.content_revision,"movementErrors":world.movement_errors,"persistentEntities":scenes.len(),"persistenceHealthy":runtime_healthy,"authEpoch":auth_epoch}));
                },
                None=>break,
            },
            received=socket.recv_from(&mut buf)=>{
                let (n,source)=received?;metrics.received_datagrams+=1;
                let now=Instant::now();
                if let Ok(receive)=Receive::new(Protocol::Udp,source,local,&buf[..n]) {
                    let input=RtcInput::Receive(now,receive);
                    let id=routes.get(&source).copied().filter(|id|peers.get(id).is_some_and(|p|p.accepts(&input)))
                        .or_else(||peers.iter().find(|(_,p)|p.accepts(&input)).map(|(&id,_)|id));
                    if let Some(id)=id {
                        // Cache established address routing. Revalidate with accepts()
                        // so a spoofed address never chooses another session's state.
                        if routes.get(&source) != Some(&id) {
                        routes.retain(|_, owner| *owner != id);
                        routes.insert(source,id);
                    }
                        let peer=peers.get_mut(&id).unwrap();
                        peer.receive(input);
                        drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat,&inventory);
                    }
                }
            },
            _=timers.tick()=>{
                let now=Instant::now();
                for peer in peers.values_mut() {
                    if (!peer.inventory_ready && now.duration_since(peer.born)>Duration::from_secs(15))
                        || now.duration_since(peer.last_input)>Duration::from_secs(20)
                        || (!peer.inventory_ready && peer.logout_until.is_some_and(|until| !newer(until, world.tick)))
                    {peer.disconnect();}
                    if peer.transport.as_ref().is_some_and(|transport| transport.deadline <= now) {
                        peer.receive(RtcInput::Timeout(now));
                        drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat,&inventory);
                    }
                    if !peer.connected() {
                        peer.disconnect();
                        peer.begin_logout(&mut world, inventory.logout_ticks);
                    }
                    inventory_poll(peer,&mut world,&session,&inventory,&mut combat,&mut metrics);
                }
                peers.retain(|_,peer|{
                    let keep=peer.connected() || peer.inventory_busy()
                        || peer.logout_waiting(&world) || peer.needs_final_state(&world);
                    if !keep && let Some(id)=peer.player {world.remove(id);}
                    keep
                });
                routes.retain(|_,id|peers.get(id).is_some_and(|peer|peer.connected()));
            },
            _=simulation.tick()=>{
                let now=Instant::now();if now.duration_since(last_tick)>Duration::from_millis(50){metrics.late_ticks+=1;}last_tick=now;
                world.step();
                let mut detonations = combat.step_projectiles(&mut world);
                let mut contacts = HashMap::<u32, Vec<_>>::new();
                for detonation in &mut detonations {
                    for hit in detonation.hits.drain(..) {
                        contacts.entry(hit.target).or_default().push(hit);
                    }
                }
                combat.expire_corpses(&mut world);combat.capture(&world);metrics.ticks+=1;
                for peer in peers.values_mut() {
                    if let Some(hits) = peer.player.and_then(|id| contacts.remove(&id)) {
                        peer.blast_hits.extend(hits);
                    }
                    if !detonations.is_empty() { peer.send_detonations(&world, &detonations); }
                    poll_trigger(peer, &world, &session, &inventory, &combat, &mut metrics);
                }
                metrics.tick_us=now.elapsed().as_micros() as u64;metrics.max_tick_us=metrics.max_tick_us.max(metrics.tick_us);
                if let Some(store) = &inventory.store {
                    store.observe_loot_players(&world);
                }
                if world.tick.is_multiple_of(SNAPSHOT_EVERY) {
                    let start=Instant::now();
                    for peer in peers.values_mut() {
                        if !peer.inventory_ready { continue; }
                        if let (Some(transport), Some(id)) = (&mut peer.transport, peer.player) {
                            if let Some(actor) = world.entities.get(&id) && actor.armour_revision != peer.armour_seen
                                && transport.rtc.channel(transport.control).is_some_and(|mut channel|
                                    channel.buffered_amount() < 8192 && channel.write(true, &[0x58,0x5a,protocol::VERSION,21]).unwrap_or(false))
                            { peer.armour_seen = actor.armour_revision; }
                            if peer.ownership_dirty && transport.rtc.channel(transport.control).is_some_and(|mut channel|channel.buffered_amount()<8192&&channel.write(true,&[0x58,0x5a,protocol::VERSION,17]).unwrap_or(false)) {peer.ownership_dirty=false;}
                            if let Some(life) = peer.inventory_life
                                && let Some(tuning) = &world.survival_tuning
                                && let Some(actor) = world.entities.get(&id)
                                && let Some(state) = &actor.condition
                            {
                                let view = state.wire_view(life, tuning, actor.loadout);
                                if peer.vitals != Some(view)
                                    && (world.tick.is_multiple_of(6) || peer.vitals.is_none_or(|previous| previous[6..] != view[6..]))
                                    && let Ok(bytes) = control::encode_event(&json!({"type":"vitals","state":view}))
                                    && transport.rtc.channel(transport.control).is_some_and(|mut channel|
                                        channel.buffered_amount() < 8192 && channel.write(true, &bytes).unwrap_or(false))
                                {
                                    peer.vitals = Some(view);
                                }
                            }
                            let weapon=combat.weapon(id);
                            if inventory.catalog.is_none() && peer.weapon_view!=Some(weapon) {
                                let bytes=control::encode_event(&json!({"type":"weapon","state":weapon})).expect("bounded weapon event");
                                if transport.rtc.channel(transport.control).is_some_and(|mut c|c.buffered_amount()<8192&&c.write(true,&bytes).unwrap_or(false)){peer.weapon_view=Some(weapon);}
                            }
                            let visible=world.visible_to(id);
                            if let Some(update)=peer.lifecycle.prepare_persistent(world.tick,&visible,&world.persistent_ids) {
                                let bytes=control::encode_event(&serde_json::to_value(&update).expect("lifecycle value")).expect("bounded lifecycle event");
                                let sent=transport.rtc.channel(transport.control).is_some_and(|mut channel|
                                    channel.buffered_amount()<8192 && channel.write(true,&bytes).unwrap_or(false));
                                if sent {peer.lifecycle.commit(&update);metrics.lifecycle_messages+=1;}
                                else {metrics.lifecycle_deferred+=1;}
                            }
                            if let Some(mut channel)=transport.rtc.channel(transport.state) {
                                if channel.buffered_amount()>16*1024 {metrics.skipped_snapshots+=1;continue;}
                                let ack=world.entities.get(&id).map_or(0,|e|e.last_input());
                                let packets=peer.replication.encode(world.tick,id,ack,&visible);
                                let size=packets.iter().map(Vec::len).sum();
                                if !peer.state_budget.admit(world.tick,size) {
                                    peer.replication.discard(world.tick);
                                    metrics.state_budget_skips+=1;
                                    continue;
                                }
                                if packets[0][22]==1 {metrics.state_keyframes+=1;} else {metrics.state_deltas+=1;}
                                for bytes in packets {
                                    if !channel.write(true,&bytes).unwrap_or(false) {metrics.skipped_snapshots+=1;break;}
                                    metrics.state_payload_bytes+=bytes.len() as u64;
                                }
                            }
                            drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat,&inventory);
                        }
                    }
                    metrics.replication_us=start.elapsed().as_micros() as u64;metrics.max_replication_us=metrics.max_replication_us.max(metrics.replication_us);
                }
            }
        }
    }
    Ok(())
}
fn inventory_context(peer:&Peer,world:&World,session:&SessionConfig,runtime:&InventoryRuntime)->Result<zone_server::inventory::Context,String>{
    let catalog=runtime.catalog.as_ref().ok_or("inventory unavailable")?;
    let principal=peer.principal.clone().ok_or("persistent identity required")?;
    let (position, eye_height) = match peer.player.and_then(|id| world.entities.get(&id)) {
        Some(actor) => (actor.position, world.capsule_height(actor.id) - 0.25),
        None if peer.inventory_life.is_none() => (session.spawn, 1.55),
        None => return Err("actor unavailable".into()),
    };
    Ok(zone_server::inventory::Context{principal,life:peer.inventory_life.unwrap_or(0),auth_epoch:runtime.auth_epoch,world:session.contract.world.clone(),
        position:[f64::from(position.x),f64::from(position.y),f64::from(position.z)],
        eye_height,collision:session.collision(),
        interaction_radius:catalog.section("inventory").and_then(|s|s.number("take_dist")).map_err(|_|"invalid interaction definition")?,expires:Instant::now()+Duration::from_secs(2)})
}
fn inventory_submit(peer:&mut Peer,world:&World,session:&SessionConfig,runtime:&InventoryRuntime,sequence:Option<u32>,operation:zone_server::persistence::Operation,death:bool)->Result<(),String>{
    let context=inventory_context(peer,world,session,runtime)?;
    inventory_enqueue(peer, runtime, context, operation, InventoryResponse::Action { sequence, death })
}
fn inventory_enqueue(
    peer: &mut Peer,
    runtime: &InventoryRuntime,
    context: zone_server::inventory::Context,
    operation: zone_server::persistence::Operation,
    response: InventoryResponse,
) -> Result<(), String> {
    if peer.inventory_pending.is_some()
        || (!peer.blast_hits.is_empty() && !matches!(response, InventoryResponse::Blast(_)))
    {
        return Err("inventory busy; retry the same request ID".into());
    }
    let reply = runtime.store.as_ref().ok_or("persistence unavailable")?.inventory_request(context, operation)?;
    peer.inventory_pending = Some(InventoryPending { response, reply });
    Ok(())
}
fn shot_event(peer: &mut Peer, sequence: u32, tick: Option<u32>, result: Value) {
    peer.control(match tick {
        Some(tick) => json!({"type":"weapon_shot","sequence":sequence,"tick":tick,"result":result}),
        None => json!({"type":"action_result","sequence":sequence,"result":result}),
    });
}

fn shot_result(peer: &mut Peer, metrics: &mut Metrics, sequence: u32, tick: Option<u32>, result: zone_server::combat::ShotResult) {
    use zone_server::combat::ShotResult;
    match result {
        ShotResult::Rejected { .. } => metrics.shot_rejections += 1,
        ShotResult::Hit { .. } => { metrics.shots += 1; metrics.shot_hits += 1; }
        _ => metrics.shots += 1,
    }
    shot_event(peer, sequence, tick, json!(result));
}

fn submit_owned_shot(
    peer: &mut Peer,
    world: &World,
    session: &SessionConfig,
    runtime: &InventoryRuntime,
    combat: &zone_server::combat::Combat,
    command: FireControl,
    queue_index: Option<u32>,
) -> Result<(), &'static str> {
    let FireControl { sequence, item, aim } = command;
    let item = item.ok_or("owned_weapon_required")?;
    let player = peer.player.ok_or("invalid_shooter")?;
    let tick = world.tick;
    if queue_index.unwrap_or(0) == 0
        && peer.owned_fire_cooldown.is_some_and(|(fired, interval)| tick.wrapping_sub(fired) < interval)
    {
        return Err("cooldown");
    }
    if peer.inventory_busy() {
        return Err("inventory_busy");
    }
    let shot = combat.prepare_owned_shot(world, player, aim)?;
    let shot = combat.trace_shot(world, shot, zone_server::combat::MAX_OWNED_RANGE);
    let target = shot.armour_target(world);
    let context = inventory_context(peer, world, session, runtime).map_err(|_| "inventory_unavailable")?;
    inventory_enqueue(peer, runtime, context, zone_server::persistence::Operation::FireWeapon(item, target, queue_index),
        InventoryResponse::Fire { sequence, tick, shot, queue_index }).map_err(|_| "inventory_unavailable")
}

fn poll_trigger(
    peer: &mut Peer, world: &World, session: &SessionConfig, runtime: &InventoryRuntime,
    combat: &zone_server::combat::Combat, metrics: &mut Metrics,
) {
    let Some(held) = &peer.trigger else { return; };
    if world.tick.wrapping_sub(held.sampled_at) >= TRIGGER_LEASE_TICKS
        || peer.player.and_then(|id| world.entities.get(&id))
            .is_none_or(|actor| actor.health == 0 || world.is_safe(actor.position))
    {
        peer.trigger = None;
        return;
    }
    let Some(next) = &held.next else { return; };
    if newer(next.tick, world.tick) || peer.inventory_busy() {
        return;
    }
    let sequence = held.sequence;
    let command = FireControl { sequence, item: Some(held.item.clone()), aim: held.aim };
    if let Err(reason) = submit_owned_shot(peer, world, session, runtime, combat, command, Some(next.index))
        && reason != "invalid_tick"
    {
        peer.trigger = None;
        shot_result(peer, metrics, sequence, Some(world.tick), zone_server::combat::ShotResult::Rejected { reason });
    }
}

#[derive(Deserialize)]
struct LoadedCharacter {
    life: u32,
    alive: bool,
    condition: zone_server::survival::Record,
    location: Option<zone_server::survival::Location>,
    loadout: zone_server::survival::Loadout,
}

fn join_character(peer: &mut Peer, world: &mut World, session: &SessionConfig, mut saved: LoadedCharacter) {
    let id = saved.location.as_ref().filter(|_| saved.alive)
        .and_then(|place| restore_saved_pose(world, session, place))
        .unwrap_or_else(|| world.spawn(Kind::Player, session.spawn));
    if !saved.alive { saved.condition.state.health = 0.0; }
    let actor = world.entities.get_mut(&id).unwrap();
    actor.set_condition(saved.condition.state);
    actor.loadout = saved.loadout;
    actor.character_key = peer.principal.clone().map(|principal| CharacterKey { principal, life: saved.life });
    peer.player = Some(id);
    peer.inventory_life = Some(saved.life);
    peer.inventory_dead = !saved.alive;
    peer.condition_revision = saved.condition.revision;
    peer.next_checkpoint = world.tick.wrapping_add(CONDITION_CHECKPOINT_TICKS + id % TICK_HZ);
    peer.welcome(session, world);
}

fn apply_loadout(peer: &Peer, world: &mut World, result: &mut Value) {
    if let Some(loadout) = result.as_object_mut().and_then(|fields| fields.remove("loadout"))
        && let Ok(loadout) = serde_json::from_value::<zone_server::survival::Loadout>(loadout)
        && let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id))
    {
        actor.loadout = loadout;
    }
}

fn ticks_until(deadline_ms: i64) -> u32 {
    let now = zone_server::survival_rules::unix_millis().unwrap_or(0);
    let left = deadline_ms.saturating_sub(now).max(0) as u64;
    u32::try_from(left.saturating_mul(u64::from(TICK_HZ)).div_ceil(1000)).unwrap_or(u32::MAX)
}

fn checkpoint_location(peer: &Peer, world: &World, session: &SessionConfig, actor: &zone_server::world::Entity) -> Option<zone_server::survival::Location> {
    let now = zone_server::survival_rules::unix_millis().ok()?;
    let deadline = |ticks: u32| if ticks == 0 { 0 } else { now + i64::from((ticks * 1000).div_ceil(TICK_HZ)) };
    let logout_left = peer.logout_until.filter(|until| newer(*until, world.tick))
        .map_or(0, |until| until.wrapping_sub(world.tick));
    Some(zone_server::survival::Location {
        world: session.contract.world.clone(), content_revision: session.contract.content_revision.clone(),
        position: [actor.position.x, actor.position.y, actor.position.z], yaw: actor.yaw,
        crouched: world.capsule_height(actor.id) < 1.8,
        combat_until_ms: deadline(actor.combat_ticks_left(world.tick, world.combat_lock_ticks)),
        logout_until_ms: deadline(logout_left),
    })
}

fn restore_saved_pose(world: &mut World, session: &SessionConfig, place: &zone_server::survival::Location) -> Option<u32> {
    if place.world != session.contract.world || place.content_revision != session.contract.content_revision
        || !place.yaw.is_finite() || !place.position.iter().all(|value| value.is_finite())
        || session.collision().is_some_and(|map| {
            let bounds = &map.manifest.bounds;
            (0..3).any(|axis| !(bounds.min[axis]..=bounds.max[axis]).contains(&place.position[axis]))
        })
    { return None; }
    let [x, y, z] = place.position;
    Some(world.restore_player(Vec3 { x, y, z }, place.yaw, place.crouched, ticks_until(place.combat_until_ms)))
}

fn inventory_poll(peer:&mut Peer,world:&mut World,session:&SessionConfig,runtime:&InventoryRuntime,combat:&mut zone_server::combat::Combat,metrics:&mut Metrics){
    if runtime.catalog.is_none() || runtime.store.is_none() || peer.principal.is_none()
        || (!peer.inventory_ready && peer.inventory_life.is_none()) { return; }
    if let Some(pending)=&mut peer.inventory_pending {
        match pending.reply.try_recv(){
            Err(oneshot::error::TryRecvError::Empty)=>return,
            Err(oneshot::error::TryRecvError::Closed)=>{
                peer.inventory_pending = None;
                peer.disconnect();
                return;
            }
            Ok(result)=>{
                let pending=peer.inventory_pending.take().unwrap();
                match pending.response {
                    InventoryResponse::LoadCharacter => {
                        if !peer.connected() { return; }
                        let saved = result.ok().and_then(|value| serde_json::from_value::<LoadedCharacter>(value).ok());
                        let Some(saved) = saved else { peer.disconnect(); return; };
                        join_character(peer, world, session, saved);
                    }
                    InventoryResponse::Fire { sequence, tick, shot, queue_index } => {
                        let mut value = result.unwrap_or_else(|error| json!({"error":error}));
                        let charge = value.as_object_mut().and_then(|object| object.remove("shot"));
                        let followup_tick = queue_index.is_some_and(|index| index > 0).then_some(tick);
                        if let Some(Ok(charge)) = charge.map(serde_json::from_value::<zone_server::combat::ChargedShot>) {
                            if let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id)) {
                                actor.loadout.mass = (actor.loadout.mass - charge.mass_spent).max(0.0);
                            }
                            peer.owned_fire_cooldown = Some((tick, charge.interval));
                            if let Some(held) = peer.trigger.as_mut().filter(|held| held.sequence == sequence) {
                                let continues = charge.ammo > 0 && queue_index.zip(charge.queue.as_ref())
                                    .is_some_and(|(index, round)| held.advance(index, tick, round));
                                if !continues {
                                    peer.trigger = None;
                                }
                            }
                            let result = combat.resolve_owned_shot(world, shot, charge);
                            shot_result(peer, metrics, sequence, followup_tick, result);
                            peer.control(json!({"type":"inventory_dirty"}));
                        } else {
                            metrics.shot_rejections += 1;
                            if value.get("status").is_none() && value.get("error").is_none() {
                                value = json!({"status":"rejected","reason":"inventory_unavailable"});
                            }
                            let jammed = value["reason"] == "misfire";
                            if peer.trigger.as_ref().is_some_and(|held| held.sequence == sequence) {
                                peer.trigger = None;
                            }
                            shot_event(peer, sequence, followup_tick, value);
                            if jammed {
                                peer.control(json!({"type":"inventory_dirty"}));
                            }
                        }
                    }
                    InventoryResponse::Blast(hit) => {
                        use zone_server::survival::BlastOutcome;
                        match result {
                            // The worker rejected this before mutating anything.
                            Ok(value) if value["error"] == "expired session authority" => peer.blast_hits.push_front(hit),
                            Ok(value) => {
                                match serde_json::from_value::<BlastOutcome>(value) {
                                    Ok(BlastOutcome::Applied { revision, alive, impact }) => {
                                        if peer.condition_revision.checked_add(1) == Some(revision) && hit.apply(world, impact, !alive) {
                                            peer.condition_revision = revision;
                                            peer.next_checkpoint = world.tick;
                                            peer.disconnect_saved = false;
                                            if !alive {
                                                peer.inventory_dead = true;
                                                peer.trigger = None;
                                                peer.control(json!({"type":"inventory_dirty"}));
                                            }
                                        }
                                    }
                                    Ok(BlastOutcome::Stale) => {}
                                    Err(error) => tracing::debug!(%error, "blast protection authority changed"),
                                }
                            }
                            Err(error) => tracing::warn!(%error, "blast protection transaction failed"),
                        }
                    }
                    InventoryResponse::Checkpoint => {
                        if !matches!(result, Ok(ref value) if value["saved"] == true) {
                            tracing::debug!("survival checkpoint did not commit");
                        }
                    }
                    InventoryResponse::Dose { sequence, before } => {
                        let mut value = result.unwrap_or_else(|error| json!({"error":error}));
                        apply_loadout(peer, world, &mut value);
                        let condition = value.as_object_mut().and_then(|object| object.remove("condition"));
                        if let Some(Ok(record)) = condition.map(serde_json::from_value::<zone_server::survival::Record>)
                            && value["life"].as_u64() == peer.inventory_life.map(u64::from)
                            && record.revision > peer.condition_revision
                        {
                            peer.condition_revision = record.revision;
                            if let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id))
                                && actor.health > 0 && let Some(live) = &actor.condition
                            {
                                actor.set_condition(record.state.merge_dose(&before, live));
                            }
                        }
                        if value["status"] == "committed" {
                            peer.control(json!({"type":"inventory_dirty"}));
                        }
                        peer.control(json!({"type":"action_result","sequence":sequence,"result":value}));
                    }
                    InventoryResponse::Action { sequence, death } => match result {
                    Ok(mut value)=>{
                        apply_loadout(peer, world, &mut value);
                        if death && value["revoked"] == true {
                            peer.inventory_dead = true;
                            peer.disconnect();
                            return;
                        }
                        if value["status"] == "respawned"
                            && let Some(life) = value["life"].as_u64().and_then(|n| u32::try_from(n).ok())
                            && peer.inventory_life.is_some_and(|old| life > old)
                        {
                            let Some(player)=peer.player else{peer.disconnect();return;};
                            if !matches!(combat.respawn_authorized(world,player,session.spawn),zone_server::combat::RespawnResult::Respawned{..}){peer.disconnect();return;}
                            peer.inventory_life = Some(life);
                            if let Some(key) = world.entities.get_mut(&player).and_then(|actor| actor.character_key.as_mut()) {
                                key.life = life;
                            }
                            peer.inventory_dead=false;
                            peer.owned_fire_cooldown = None;
                            peer.trigger = None;
                            peer.condition_revision = 0;
                            if let Some(store) = &runtime.store {
                                store.observe_loot_players(world);
                            }
                        }
                        if value["alive"]==false || death&&value["status"]=="committed" {
                            peer.inventory_dead=true;
                            if let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id)) {
                                actor.health = 0;
                                if let Some(state) = &mut actor.condition { state.health = 0.0; }
                            }
                        }
                        if let Some(sequence)=sequence{peer.control(json!({"type":"action_result","sequence":sequence,"result":value}));}
                        if value["status"]=="committed"||sequence.is_none(){peer.control(json!({"type":"inventory_dirty"}));}
                    }
                    Err(error)=>{
                        if let Some(sequence)=sequence{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":error}}));}
                        else {peer.disconnect();return;}
                    }
                    },
                }
            }
        }
    }
    if peer.inventory_life.is_none() {
        if peer.connected() && let Ok(context) = inventory_context(peer, world, session, runtime) {
            let _ = inventory_enqueue(peer, runtime, context, zone_server::persistence::Operation::LoadCondition, InventoryResponse::LoadCharacter);
        }
        return;
    }
    let Some(actor) = peer.player.and_then(|id| world.entities.get(&id)) else { return; };
    while peer.blast_hits.front().is_some_and(|hit| !hit.is_current(world)) {
        peer.blast_hits.pop_front();
    }
    if let Some(hit) = peer.blast_hits.front().cloned() {
        if let (Ok(context), Some(location), Some(state)) = (
            inventory_context(peer, world, session, runtime), checkpoint_location(peer, world, session, actor), &actor.condition,
        ) {
            let blast = zone_server::survival::Blast {
                power: hit.power,
                before: zone_server::survival::Record { revision: peer.condition_revision, state: state.clone() },
                location,
                combat_lock_ms: if hit.is_pvp() { (world.combat_lock_ticks * 1000).div_ceil(TICK_HZ) } else { 0 },
            };
            let operation = zone_server::persistence::Operation::ResolveBlast(blast);
            if inventory_enqueue(peer, runtime, context, operation, InventoryResponse::Blast(hit)).is_ok() {
                peer.blast_hits.pop_front();
            }
        }
        return;
    }
    if actor.health == 0 {
        if !peer.inventory_dead && let Ok(context) = inventory_context(peer,world,session,runtime) {
            let _ = inventory_submit(peer, world, session, runtime, None, zone_server::persistence::Operation::InventoryDeath(context), true);
        }
        return;
    }
    if !peer.connected() && peer.logout_until.is_none() && runtime.checkpoints == CheckpointPhase::Running {
        return;
    }
    if runtime.checkpoints == CheckpointPhase::Draining { return; }
    let final_save = runtime.checkpoints == CheckpointPhase::Final || (!peer.connected() && !peer.logout_waiting(world));
    let combat_left = actor.combat_ticks_left(world.tick, world.combat_lock_ticks);
    let combat_deadline = (combat_left != 0).then(|| world.tick.wrapping_add(combat_left));
    let due = !newer(peer.next_checkpoint, world.tick) || combat_deadline != peer.checkpoint_combat_until;
    if (if final_save { !peer.disconnect_saved } else { due })
        && let Some(state) = &actor.condition
        && let Ok(context) = inventory_context(peer, world, session, runtime)
        && let Some(location) = checkpoint_location(peer, world, session, actor)
    {
        let record = zone_server::survival::Record { revision: peer.condition_revision, state: state.clone() };
        if inventory_enqueue(peer, runtime, context, zone_server::persistence::Operation::SaveCondition(record, location), InventoryResponse::Checkpoint).is_ok() {
            peer.next_checkpoint = world.tick.wrapping_add(CONDITION_CHECKPOINT_TICKS);
            peer.checkpoint_combat_until = combat_deadline;
            peer.disconnect_saved = final_save;
        }
    }
}
fn drain(
    peer: &mut Peer,
    socket: &UdpSocket,
    world: &mut World,
    metrics: &mut Metrics,
    session: &SessionConfig,
    combat: &mut zone_server::combat::Combat,
    inventory: &InventoryRuntime,
) {
    // Bound work per peer so malicious or busy peers cannot monopolize a turn.
    for _ in 0..256 {
        let Some(transport) = &mut peer.transport else { return; };
        let (state_channel, control_channel) = (transport.state, transport.control);
        match transport.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                transport.deadline = t;
                return;
            }
            Ok(Output::Transmit(t)) => {
                match socket.try_send_to(&t.contents, t.destination) {
                    Ok(n) => {
                        metrics.sent_datagrams += 1;
                        metrics.sent_bytes += n as u64;
                    }
                    Err(_) => metrics.udp_drops += 1, // UDP loss is handled by the selected channel semantics.
                }
            }
            Ok(Output::Event(Event::ChannelOpen(id, _))) => {
                if id != state_channel && id != control_channel {
                    peer.disconnect();
                    continue;
                }
                if peer.player.is_none() && inventory.catalog.is_none() {
                    peer.player = Some(world.spawn(Kind::Player, session.spawn));
                    if let Some(store) = &inventory.store {
                        store.observe_loot_players(world);
                    }
                }
                if id == control_channel {
                    peer.inventory_ready=true;
                    if peer.logout_until.take().is_some() {
                        peer.next_checkpoint = world.tick;
                    }
                    if peer.player.is_some() {
                        peer.welcome(session, world);
                    }
                }
            }
            Ok(Output::Event(Event::ChannelData(data))) => {
                let now = Instant::now();
                if !peer.allow(now) {
                    metrics.rate_limited += 1;
                    continue;
                }
                let Some(player) = peer.player else { continue };
                if !peer.inventory_ready { continue; }
                if data.id == state_channel && data.binary {
                    if let Some((input, sample)) = protocol::decode_player_input(&data.data) {
                        // A valid state message remains a heartbeat after death.
                        peer.last_input = now;
                        if inventory.catalog.is_some() && (peer.inventory_life.is_none() || peer.inventory_dead){continue;}
                        if world.input(player, input)
                            && let Some(sample) = sample
                            && let Some(held) = peer.trigger.as_mut().filter(|held| held.sequence == sample.sequence)
                        {
                            held.aim = sample.aim;
                            held.sampled_at = world.tick;
                        }
                    } else if let Some(feedback) = replication::decode_feedback(&data.data) {
                        if let Some(tick) = feedback {
                            peer.replication.acknowledge(tick);
                        } else {
                            peer.replication.resync();
                        }
                    } else {
                        metrics.invalid_messages += 1;
                    }
                } else if data.id == control_channel && data.binary && data.data.len() <= control::MAX_COMMAND {
                    match control::decode_command(&data.data).and_then(|value| {
                        serde_json::from_value::<Control>(value).map_err(|_| "invalid command")
                    }) {
                        Ok(command) => {
                            let sequence = match command {
                                Control::Corpses {sequence,..} | Control::CorpseItems {sequence,..} | Control::WorldItems {sequence,..} | Control::InventoryList {sequence,..} | Control::InventoryMove {sequence,..} => sequence,
                                Control::Attack { sequence, .. }
                                | Control::Fire(FireControl { sequence, .. })
                                | Control::TriggerStart(FireControl { sequence, .. })
                                | Control::TriggerStop { sequence }
                                | Control::Reload { sequence }
                                | Control::Respawn { sequence, .. }
                                | Control::Leave { sequence } => sequence,
                            };
                            if peer.sequence.is_some_and(|last| !newer(sequence, last)) {
                                continue;
                            }
                            peer.sequence = Some(sequence);
                            peer.last_input = now;
                            if inventory.catalog.is_some() && peer.inventory_life.is_none()
                                && !matches!(command,Control::Leave{..}) {
                                peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":"inventory loading"}}));continue;
                            }
                            match command {
                                Control::InventoryList{sequence,after,generation}=>{
                                    let operation=zone_server::persistence::Operation::ListInventory(after,generation);
                                    if let Err(reason)=inventory_submit(peer,world,session,inventory,Some(sequence),operation,false){peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::Corpses{sequence,after}=>{
                                    let operation=inventory_context(peer,world,session,inventory).map(|context|zone_server::persistence::Operation::Corpses(after,context));
                                    let result=operation.and_then(|op|inventory_submit(peer,world,session,inventory,Some(sequence),op,false));
                                    if let Err(reason)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::CorpseItems{sequence,source,after,generation}=>{
                                    let operation=inventory_context(peer,world,session,inventory).map(|context|zone_server::persistence::Operation::CorpseItems(source,after,generation,context));
                                    let result=operation.and_then(|op|inventory_submit(peer,world,session,inventory,Some(sequence),op,false));
                                    if let Err(reason)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::WorldItems{sequence,after}=>{
                                    let operation=inventory_context(peer,world,session,inventory).map(|context|zone_server::persistence::Operation::WorldItems(after,context));
                                    let result=operation.and_then(|op|inventory_submit(peer,world,session,inventory,Some(sequence),op,false));
                                    if let Err(reason)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::InventoryMove{sequence,command}=>{
                                    if peer.trigger.as_ref().is_some_and(|held| held.item == command.item) {
                                        peer.trigger = None;
                                    }
                                    let result = (|| {
                                        let actor = world.entities.get(&player).ok_or("actor unavailable")?;
                                        let context = inventory_context(peer, world, session, inventory)?;
                                        if matches!(command.action, zone_server::inventory::MoveAction::Consume) {
                                            let before = actor.condition.clone().ok_or("condition unavailable")?;
                                            let record = zone_server::survival::Record { revision: peer.condition_revision, state: before.clone() };
                                            let operation = zone_server::persistence::Operation::Consume(command, context.clone(), record);
                                            inventory_enqueue(peer, inventory, context, operation, InventoryResponse::Dose { sequence, before })
                                        } else {
                                            if actor.health == 0 { return Err("dead actor".into()); }
                                            let operation = zone_server::persistence::Operation::MoveInventory(command, context.clone());
                                            inventory_enqueue(peer, inventory, context, operation, InventoryResponse::Action { sequence: Some(sequence), death: false })
                                        }
                                    })();
                                    if let Err(reason)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::Attack { sequence, target } => {
                                    let result = if session.content.is_some() {
                                        json!("unsupported_action")
                                    } else {
                                        json!(world.attack(player, target))
                                    };
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Fire(command) => {
                                    let sequence = command.sequence;
                                    if inventory.catalog.is_some() {
                                        let result = if peer.trigger.is_some() { Err("trigger_held") }
                                            else { submit_owned_shot(peer, world, session, inventory, combat, command, None) };
                                        if let Err(reason) = result {
                                            shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason });
                                        }
                                    } else {
                                        let result = combat.fire(world, player, command.aim);
                                        shot_result(peer, metrics, sequence, None, result);
                                    }
                                }
                                Control::TriggerStart(command) => {
                                    let sequence = command.sequence;
                                    let item = command.item.clone().expect("decoded trigger weapon ID");
                                    let aim = command.aim;
                                    let result = if inventory.catalog.is_none() {
                                        Err("owned_weapon_required")
                                    } else if peer.trigger.is_some() {
                                        Err("trigger_held")
                                    } else {
                                        submit_owned_shot(peer, world, session, inventory, combat, command, Some(0))
                                    };
                                    match result {
                                        Ok(()) => peer.trigger = Some(HeldTrigger {
                                            sequence, item, aim, sampled_at: world.tick, next: None,
                                        }),
                                        Err(reason) => shot_result(peer, metrics, sequence, None,
                                            zone_server::combat::ShotResult::Rejected { reason }),
                                    }
                                }
                                Control::TriggerStop { sequence } => {
                                    peer.trigger = None;
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":{"status":"released"}}));
                                }
                                Control::Reload { sequence } => {
                                    let result = if inventory.catalog.is_some() {
                                        json!({"status":"rejected","reason":"owned_weapon_required"})
                                    } else {
                                        json!(combat.reload(world, player))
                                    };
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Respawn { sequence,request_id,life } => {
                                    if inventory.catalog.is_some(){
                                        let result=inventory_context(peer,world,session,inventory).and_then(|context|inventory_submit(peer,world,session,inventory,Some(sequence),zone_server::persistence::Operation::InventoryRespawn(zone_server::inventory::Respawn{request_id,life},context),false));
                                        if let Err(error)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":error}}));}
                                        continue;
                                    }
                                    let result = combat.respawn(world, player, session.spawn);
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Leave { .. } => peer.disconnect(),
                            }
                        }
                        Err(_) => metrics.invalid_messages += 1,
                    }
                } else {
                    metrics.invalid_messages += 1;
                }
            }
            Ok(Output::Event(Event::ChannelClose(_))) => peer.disconnect(),
            Ok(Output::Event(_)) => {}
            Err(error) => {
                tracing::debug!(%error,"RTC peer error");
                peer.disconnect();
                return;
            }
        }
    }
    if let Some(transport) = &mut peer.transport { transport.deadline = Instant::now(); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entering_safety_and_disconnecting_cannot_bypass_a_pending_blast() {
        use zone_server::combat::{Aim, ArmourImpact, ChargedShot, Combat, LaunchSpec, ShotResult, MAX_OWNED_RANGE};
        use zone_server::world::{SafeZone, Vec3};

        let mut world = World::new();
        world.safe_zones.clear();
        world.combat_lock_ticks = 60;
        let shooter = world.spawn(Kind::Player, Vec3::default());
        let point = Vec3 { x: 0.0, y: 0.0, z: 3.0 };
        let target = world.spawn(Kind::Player, point);
        world.entities.get_mut(&target).unwrap().character_key =
            Some(CharacterKey { principal: "a".repeat(32), life: 0 });
        let mut combat = Combat::default();
        combat.capture(&world);
        let prepared = combat.prepare_owned_shot(&world, shooter, Aim { tick: 0, yaw: 0.0, pitch: 0.0 }).unwrap();
        let trace = combat.trace_shot(&world, prepared, MAX_OWNED_RANGE);
        let charge = ChargedShot { ammo: 0, range: 0.0, damage: 0, interval: 1, mass_spent: 0.1,
            queue: None, armour: None, launcher: Some(LaunchSpec { section: "wpn_fake_missile2".into(),
                speed: 32.0, fuse_ticks: 300, blast_power: 0.4, blast_radius: 4.0 }) };
        assert_eq!(combat.resolve_owned_shot(&mut world, trace, charge), ShotResult::Launched { ammo: 0 });
        let contact = (0..3).find_map(|_| combat.step_projectiles(&mut world).pop()).unwrap().hits.pop().unwrap();
        world.safe_zones.push(SafeZone { center: point, radius: 1.0 });
        assert!(world.is_protected(&world.entities[&target]));

        let mut peer = Peer::new(Instant::now(), None);
        peer.player = Some(target);
        peer.inventory_life = Some(0);
        peer.blast_hits.push_back(contact);
        peer.begin_logout(&mut world, 60);
        assert!(peer.inventory_busy());
        assert_eq!(peer.logout_until, None);
        let hit = peer.blast_hits.pop_front().unwrap();
        assert!(hit.apply(&mut world, ArmourImpact::Hit { power: 0.2, wound: true, gear_changed: true }, false));
        peer.begin_logout(&mut world, 60);
        assert!(peer.logout_waiting(&world));
        assert_eq!(world.entities[&target].health, 80);
        assert_eq!(world.entities[&target].armour_revision, 1);
    }

    #[test]
    fn held_cadence_carries_fractional_ticks_and_respects_burst_limit() {
        let mut held = HeldTrigger {
            sequence: 1, item: "a".repeat(32), sampled_at: 0,
            aim: zone_server::combat::Aim { tick: 0, yaw: 0.0, pitch: 0.0 }, next: None,
        };
        let automatic = zone_server::combat::QueueRound { limit: None, ticks: 1800.0 / 570.0 };
        let start = u32::MAX - 1;
        let mut tick = start;
        for index in 0..19 {
            assert!(held.advance(index, tick, &automatic));
            let next = held.next.as_ref().unwrap();
            assert!((3..=4).contains(&next.tick.wrapping_sub(tick)));
            tick = next.tick;
        }
        assert_eq!(tick.wrapping_sub(start), 60);
        let burst = zone_server::combat::QueueRound { limit: Some(2), ticks: 1.5 };
        assert!(!held.advance(1, tick, &burst));
    }
    #[test]
    fn signaling_requires_expected_origin_and_configured_token() {
        let (commands, _) = mpsc::channel(1);
        let mut state = HttpState {
            survival:false,
            session: Arc::new(SessionConfig::synthetic()),
            commands,
            token: None,
            persistence: None,
            origin: "http://127.0.0.1:8082".into(),
        };
        let mut headers = HeaderMap::new();
        assert!(authorized(&state, &headers)); // Local CLI callers have no Origin.
        headers.insert("origin", "https://unrelated.example".parse().unwrap());
        assert!(!authorized(&state, &headers));
        headers.insert("origin", "http://127.0.0.1:8082".parse().unwrap());
        assert!(authorized(&state, &headers));
        state.token = Some("test-token".into());
        assert!(!authorized(&state, &headers));
        headers.insert("authorization", "Bearer wrong-token".parse().unwrap());
        assert!(!authorized(&state, &headers));
        headers.insert("authorization", "Bearer test-token".parse().unwrap());
        assert!(authorized(&state, &headers));
    }
    #[test]
    fn control_commands_cannot_supply_identity_damage_or_position() {
        for data in [
            r#"{"type":"attack","sequence":1,"target":2,"attacker":3}"#,
            r#"{"type":"attack","sequence":1,"target":2,"damage":1000}"#,
            r#"{"type":"teleport","sequence":1,"x":100}"#,
            r#"{"type":"fire","sequence":1,"aim":{"tick":1,"yaw":0,"pitch":0,"target":2}}"#,
            r#"{"type":"fire","sequence":1,"aim":{"tick":1,"yaw":0,"pitch":0},"damage":1000}"#,
            r#"{"type":"attack","sequence":-1,"target":2}"#,
        ] {
            assert!(serde_json::from_str::<Control>(data).is_err());
        }
    }
}
