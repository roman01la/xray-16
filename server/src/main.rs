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
    collections::HashMap,
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
    contract, protocol, replication,
    session::SessionConfig,
    world::{Kind, SNAPSHOT_EVERY, TICK_HZ, World, newer},
};

#[derive(Clone)]
struct HttpState {
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
    Attack {
        sequence: u32,
        target: u32,
    },
    Reload {
        sequence: u32,
    },
    Respawn {
        sequence: u32,
    },
    Fire {
        sequence: u32,
        aim: zone_server::combat::Aim,
    },
    Leave {
        sequence: u32,
    },
}
#[derive(Default, Serialize)]
struct Metrics {
    sessions: usize,
    players: usize,
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
struct Peer {
    replication: replication::Replicator,
    state_budget: replication::ByteBudget,
    lifecycle: zone_server::lifecycle::Lifecycle,
    weapon_view: Option<zone_server::combat::WeaponView>,
    rtc: Rtc,
    state: ChannelId,
    control: ChannelId,
    player: Option<u32>,
    principal: Option<String>,
    ownership_dirty: bool,
    born: Instant,
    last_input: Instant,
    deadline: Instant,
    sequence: Option<u32>,
    window: Instant,
    messages: u32,
}
impl Peer {
    fn allow(&mut self, now: Instant) -> bool {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            self.window = now;
            self.messages = 0;
        }
        self.messages += 1;
        self.messages <= 120
    }
    fn control(&mut self, value: Value) {
        if let Some(mut ch) = self.rtc.channel(self.control) {
            let bytes = serde_json::to_vec(&value).unwrap();
            // Control events must never be silently discarded. Disconnect a
            // stalled consumer; durable transactions will need persisted IDs.
            if ch.buffered_amount() > 16 * 1024 || !ch.write(false, &bytes).unwrap_or(false) {
                self.rtc.disconnect();
            }
        }
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
        SessionConfig::zaton(map, x, z)?
    } else {
        SessionConfig::synthetic()
    });
    let persistence = std::env::var("ZONE_DATABASE")
        .ok()
        .map(|path| zone_server::persistence::Persistence::start(std::path::Path::new(&path)))
        .transpose()?;
    let ownership_updates = persistence.as_ref().map(|p| p.subscribe());
    let runtime_updates = persistence.as_ref().map(|p| p.runtime());
    let persistence_handle = persistence.clone();
    let world = session.world()?;
    let socket = UdpSocket::bind(udp).await.context("binding gameplay UDP")?;
    let (tx, rx) = mpsc::channel(32);
    let shutdown_commands = tx.clone();
    let state = Arc::new(HttpState {
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
                Json(json!({"contract":s.session.contract,"content":s.session.content,"persistence":s.persistence.is_some()}))
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
        label: "state-v2".into(),
        ordered: false,
        reliability: Reliability::MaxRetransmits { retransmits: 0 },
        negotiated: Some(0),
        protocol: "zone-v2".into(),
    });
    let control = changes.add_channel_with_config(ChannelConfig {
        label: "control-v2".into(),
        ordered: true,
        reliability: Reliability::Reliable,
        negotiated: Some(2),
        protocol: "zone-v2".into(),
    });
    ensure!(
        changes.apply().is_none(),
        "unexpected channel renegotiation"
    );
    Ok((
        Peer {
            replication: replication::Replicator::default(),
            state_budget: replication::ByteBudget::default(),
            lifecycle: zone_server::lifecycle::Lifecycle::default(),
            weapon_view: None,
            rtc,
            state,
            control,
            player: None,
            principal: None,
            ownership_dirty: false,
            born: now,
            last_input: now,
            deadline: now,
            sequence: None,
            window: now,
            messages: 0,
        },
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
                if state.auth_epoch!=auth_epoch||!state.healthy {for peer in peers.values_mut(){if peer.principal.is_some(){peer.rtc.disconnect();}}}
                runtime_healthy=state.healthy;auth_epoch=state.auth_epoch;
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
                    if principal.as_ref().is_some_and(|id|peers.values().any(|p|p.principal.as_ref()==Some(id)&&p.rtc.is_alive())) { let _=reply.send(Err("identity already connected".into()));continue; }
                    if peers.len()>=max_players {let _=reply.send(Err("server is full".into()));continue;}
                    match create_peer(offer,public,&session) {
                        Ok((mut peer,mut answer))=>{peer.principal=principal;peer.ownership_dirty=peer.principal.is_some();answer["principalId"]=json!(peer.principal);if reply.send(Ok(answer)).is_ok(){next_peer+=1;peers.insert(next_peer,peer);}},
                        Err(error)=>{let _=reply.send(Err(error.to_string()));}
                    }
                },
                Some(Command::Shutdown(reply))=>{for peer in peers.values_mut(){peer.rtc.disconnect();drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat);}let _=reply.send(());break;},
                Some(Command::Context(principal,reply))=>{
                    let context=if runtime_healthy{peers.iter().find(|(_,p)|p.principal.as_ref()==Some(&principal)&&p.player.is_some()&&p.rtc.is_alive()).map(|(id,_)|zone_server::policy::ActionContext{principal,world:Some(session.contract.world.clone()),session:Some(*id),expires:Instant::now()+Duration::from_secs(2)})}else{None};let _=reply.send(context);
                },
                Some(Command::Metrics(reply))=>{
                    metrics.sessions=peers.len();metrics.players=peers.values().filter(|p|p.player.is_some()).count();metrics.tick=world.tick;
                    let _=reply.send(json!({"metrics":metrics,"maxPlayers":max_players,"tickHz":TICK_HZ,"snapshotHz":TICK_HZ/SNAPSHOT_EVERY,"world":session.contract.world,"contentRevision":session.contract.content_revision,"movementErrors":world.movement_errors,"persistentEntities":scenes.len(),"persistenceHealthy":runtime_healthy,"authEpoch":auth_epoch}));
                },
                None=>break,
            },
            received=socket.recv_from(&mut buf)=>{
                let (n,source)=received?;metrics.received_datagrams+=1;
                let now=Instant::now();
                if let Ok(receive)=Receive::new(Protocol::Udp,source,local,&buf[..n]) {
                    let input=RtcInput::Receive(now,receive);
                    let id=routes.get(&source).copied().filter(|id|peers.get(id).is_some_and(|p|p.rtc.accepts(&input)))
                        .or_else(||peers.iter().find(|(_,p)|p.rtc.accepts(&input)).map(|(&id,_)|id));
                    if let Some(id)=id {
                        // Cache established address routing. Revalidate with accepts()
                        // so a spoofed address never chooses another session's state.
                        if routes.get(&source) != Some(&id) {
                        routes.retain(|_, owner| *owner != id);
                        routes.insert(source,id);
                    }
                        let peer=peers.get_mut(&id).unwrap();
                        if peer.rtc.handle_input(input).is_err(){peer.rtc.disconnect();}
                        drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat);
                    }
                }
            },
            _=timers.tick()=>{
                let now=Instant::now();
                for peer in peers.values_mut() {
                    if (peer.player.is_none() && now.duration_since(peer.born)>Duration::from_secs(15)) || now.duration_since(peer.last_input)>Duration::from_secs(20) {peer.rtc.disconnect();}
                    if peer.deadline<=now {
                        if peer.rtc.handle_input(RtcInput::Timeout(now)).is_err(){peer.rtc.disconnect();}
                        drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat);
                    }
                }
                peers.retain(|_,peer|{let alive=peer.rtc.is_alive();if !alive && let Some(id)=peer.player {world.remove(id);}alive});
                routes.retain(|_,id|peers.contains_key(id));
            },
            _=simulation.tick()=>{
                let now=Instant::now();if now.duration_since(last_tick)>Duration::from_millis(50){metrics.late_ticks+=1;}last_tick=now;
                world.step();combat.expire_corpses(&mut world);combat.capture(&world);metrics.ticks+=1;metrics.tick_us=now.elapsed().as_micros() as u64;metrics.max_tick_us=metrics.max_tick_us.max(metrics.tick_us);
                if world.tick.is_multiple_of(SNAPSHOT_EVERY) {
                    let start=Instant::now();
                    for peer in peers.values_mut() {
                        if let Some(id)=peer.player {
                            if peer.ownership_dirty && peer.rtc.channel(peer.control).is_some_and(|mut channel|channel.buffered_amount()<8192&&channel.write(false,b"{\"type\":\"ownership_dirty\"}").unwrap_or(false)) {peer.ownership_dirty=false;}
                            let weapon=combat.weapon(id);
                            if peer.weapon_view!=Some(weapon) {
                                let bytes=serde_json::to_vec(&json!({"type":"weapon","state":weapon})).unwrap();
                                if peer.rtc.channel(peer.control).is_some_and(|mut c|c.buffered_amount()<8192&&c.write(false,&bytes).unwrap_or(false)){peer.weapon_view=Some(weapon);}
                            }
                            let visible=world.visible_to(id);
                            if let Some(update)=peer.lifecycle.prepare_persistent(world.tick,&visible,&world.persistent_ids) {
                                let bytes=serde_json::to_vec(&update).expect("lifecycle serialization");
                                let sent=peer.rtc.channel(peer.control).is_some_and(|mut channel|
                                    channel.buffered_amount()<8192 && channel.write(false,&bytes).unwrap_or(false));
                                if sent {peer.lifecycle.commit(&update);metrics.lifecycle_messages+=1;}
                                else {metrics.lifecycle_deferred+=1;}
                            }
                            if let Some(mut channel)=peer.rtc.channel(peer.state) {
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
                            drain(peer,&socket,&mut world,&mut metrics,&session,&mut combat);
                        }
                    }
                    metrics.replication_us=start.elapsed().as_micros() as u64;metrics.max_replication_us=metrics.max_replication_us.max(metrics.replication_us);
                }
            }
        }
    }
    Ok(())
}
fn drain(
    peer: &mut Peer,
    socket: &UdpSocket,
    world: &mut World,
    metrics: &mut Metrics,
    session: &SessionConfig,
    combat: &mut zone_server::combat::Combat,
) {
    // Bound work per peer so malicious or busy peers cannot monopolize a turn.
    for _ in 0..256 {
        match peer.rtc.poll_output() {
            Ok(Output::Timeout(t)) => {
                peer.deadline = t;
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
                if id != peer.state && id != peer.control {
                    peer.rtc.disconnect();
                    continue;
                }
                if peer.player.is_none() {
                    peer.player = Some(world.spawn(Kind::Player, session.spawn));
                }
                if id == peer.control {
                    peer.control(json!({"type":"welcome","version":protocol::VERSION,"contract":session.contract,"playerId":peer.player,"principalId":peer.principal,"tickHz":TICK_HZ,"safeZones":world.safe_zones}));
                }
            }
            Ok(Output::Event(Event::ChannelData(data))) => {
                let now = Instant::now();
                if !peer.allow(now) {
                    metrics.rate_limited += 1;
                    continue;
                }
                let Some(player) = peer.player else { continue };
                if data.id == peer.state && data.binary {
                    if let Some(input) = protocol::decode_input(&data.data) {
                        // A valid state message remains a heartbeat after death.
                        peer.last_input = now;
                        world.input(player, input);
                    } else if let Some(feedback) = replication::decode_feedback(&data.data) {
                        if let Some(tick) = feedback {
                            peer.replication.acknowledge(tick);
                        } else {
                            peer.replication.resync();
                        }
                    } else {
                        metrics.invalid_messages += 1;
                    }
                } else if data.id == peer.control && !data.binary && data.data.len() <= 1024 {
                    match serde_json::from_slice::<Control>(&data.data) {
                        Ok(command) => {
                            let sequence = match command {
                                Control::Attack { sequence, .. }
                                | Control::Fire { sequence, .. }
                                | Control::Reload { sequence }
                                | Control::Respawn { sequence }
                                | Control::Leave { sequence } => sequence,
                            };
                            if peer.sequence.is_some_and(|last| !newer(sequence, last)) {
                                continue;
                            }
                            peer.sequence = Some(sequence);
                            peer.last_input = now;
                            match command {
                                Control::Attack { sequence, target } => {
                                    let result = if session.content.is_some() {
                                        json!("unsupported_action")
                                    } else {
                                        json!(world.attack(player, target))
                                    };
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Fire { sequence, aim } => {
                                    let result = combat.fire(world, player, aim);
                                    if matches!(
                                        result,
                                        zone_server::combat::ShotResult::Rejected { .. }
                                    ) {
                                        metrics.shot_rejections += 1;
                                    } else {
                                        metrics.shots += 1;
                                    }
                                    if matches!(result, zone_server::combat::ShotResult::Hit { .. })
                                    {
                                        metrics.shot_hits += 1;
                                    }
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Reload { sequence } => {
                                    let result = combat.reload(world, player);
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Respawn { sequence } => {
                                    let result = combat.respawn(world, player, session.spawn);
                                    peer.control(json!({"type":"action_result","sequence":sequence,"result":result}));
                                }
                                Control::Leave { .. } => peer.rtc.disconnect(),
                            }
                        }
                        Err(_) => metrics.invalid_messages += 1,
                    }
                } else {
                    metrics.invalid_messages += 1;
                }
            }
            Ok(Output::Event(Event::ChannelClose(_))) => peer.rtc.disconnect(),
            Ok(Output::Event(_)) => {}
            Err(error) => {
                tracing::debug!(%error,"RTC peer error");
                peer.rtc.disconnect();
                return;
            }
        }
    }
    peer.deadline = Instant::now();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signaling_requires_expected_origin_and_configured_token() {
        let (commands, _) = mpsc::channel(1);
        let mut state = HttpState {
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
