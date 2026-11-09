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
    collections::{HashMap, HashSet, VecDeque},
    future::IntoFuture,
    net::SocketAddr,
    path::{Path, PathBuf},
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
    alife_attacks::Receipt as NativeReceipt,
    collision::CollisionMap,
    contract, control, protocol, replication,
    knife,
    session::SessionConfig,
    world::{CharacterKey, Kind, SNAPSHOT_EVERY, TICK_HZ, Vec3, World, newer},
};

const CONDITION_CHECKPOINT_TICKS: u32 = TICK_HZ * 5;

#[derive(Clone)]
struct HttpState {
    survival: bool,
    sessions: Vec<Arc<SessionConfig>>,
    commands: mpsc::Sender<Command>,
    token: Option<String>,
    persistence: Option<zone_server::persistence::Persistence>,
    origin: String,
    travel: Option<Arc<zone_server::travel::Routes>>,
}
enum Command {
    Offer(
        usize,
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
struct Region {
    session: Arc<SessionConfig>,
    world: World,
    combat: zone_server::combat::Combat,
    scenes: zone_server::scene::SceneRegistry,
    alife_interests: Option<zone_server::alife_interests::AlifeInterests>,
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
    reload_timings: Option<Arc<zone_server::reload_timing::ReloadTimings>>,
    auth_epoch: u64,
    logout_ticks: u32,
    checkpoints: CheckpointPhase,
    travel: Option<Arc<zone_server::travel::Routes>>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckpointPhase { Running, Draining, Final }
enum InventoryResponse {
    LoadCharacter,
    Action { sequence: Option<u32>, death: bool },
    ReloadPrepare,
    ReloadApply,
    Fire { sequence: u32, tick: u32, shot: zone_server::combat::TracedShot, queue_index: Option<u32>, victims: Vec<FireReservation>, firearm: Option<(u32, String)> },
    Impact(zone_server::combat::DamageContact),
    Fields(Arc<[zone_server::environment::Pulse]>),
    Dose { sequence: u32, before: zone_server::survival::State },
    Travel { sequence: Option<u32> },
    Checkpoint,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum ReloadPhase { Prepare, Open, Apply, FinishInsert, Close }

struct OwnedReload {
    sequence: u32,
    command: zone_server::inventory::Move,
    root: String,
    first_commit: Option<Value>,
    plan: Option<zone_server::reload_timing::ReloadPlan>,
    slot: u8,
    phase: ReloadPhase,
    until: Instant,
    interrupted: bool,
}
struct InventoryPending {
    response: InventoryResponse,
    reply: oneshot::Receiver<Result<Value,String>>,
}
struct QueuedFire {
    enqueued: Instant,
    sequence: u32,
    item: String,
    shot: zone_server::combat::TracedShot,
    queue_index: Option<u32>,
    special: Option<SpecialAttack>,
}
struct FireReservation { peer: u64, actor: u32, life: u32 }
enum SpecialAttack { Throw(Throwable, zone_server::hand_grenade::Force), Knife(knife::Mode) }
enum Throwable { Grenade, Bolt }
type FireUpdate = (u64, Option<zone_server::survival::ImpactCommit>);
struct ObservedShot {
    shooter: u32,
    position: Vec3,
    section: String,
    sound: u8,
}
#[derive(Default)]
struct FireEffects {
    hits: Vec<FireUpdate>,
    shots: Vec<(usize, ObservedShot)>,
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
    UseTravel { sequence: u32 },
    SelectWeapon { sequence: u32, life: u32, slot: u8 },
    SelectDetector { sequence: u32, life: u32, active: bool },
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
    Grenade(GrenadeControl),
    Knife(KnifeControl),
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
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrenadeControl {
    sequence: u32,
    item: String,
    aim: zone_server::combat::Aim,
    phase: GrenadePhase,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KnifeControl {
    sequence: u32,
    item: String,
    aim: zone_server::combat::Aim,
    mode: knife::Mode,
}
struct KnifeSwing {
    command: KnifeControl,
    contact_tick: u32,
    profile: knife::Profile,
    latest_aim: Option<zone_server::combat::Aim>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum GrenadePhase { Prime, Release, Cancel }

struct PrimedGrenade {
    item: String,
    ready: u32,
}
struct PendingGrenadeThrow {
    command: FireControl,
    force: zone_server::hand_grenade::Force,
    accepted: u32,
    release: u32,
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
    region: usize,
    transferred: bool,
    next_travel: Option<u32>,
    travel_use: Option<u32>,
    inventory_pending: Option<InventoryPending>,
    reload: Option<OwnedReload>,
    queued_fire: Option<QueuedFire>,
    incoming_fire: bool,
    impact_hits: VecDeque<zone_server::combat::DamageContact>,
    field_hits: Vec<zone_server::environment::Pulse>,
    inventory_life: Option<u32>,
    campaign_visit: u32,
    inventory_dead: bool,
    inventory_ready: bool,
    condition_revision: u32,
    vitals: Option<[u32; 14]>,
    armour_seen: u32,
    next_checkpoint: u32,
    disconnect_saved: bool,
    logout_until: Option<u32>,
    checkpoint_combat_until: Option<u32>,
    replication: replication::Replicator,
    state_budget: replication::ByteBudget,
    lifecycle: zone_server::lifecycle::Lifecycle,
    weapon_view: Option<zone_server::combat::WeaponView>,
    grenades_visible: bool,
    owned_fire_cooldown: Option<(u32, u32)>,
    trigger: Option<HeldTrigger>,
    primed_grenade: Option<PrimedGrenade>,
    grenade_throw: Option<PendingGrenadeThrow>,
    knife_swing: Option<KnifeSwing>,
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
            region: 0,
            transferred: false,
            next_travel: None,
            travel_use: None,
            inventory_pending: None,
            reload: None,
            queued_fire: None,
            incoming_fire: false,
            impact_hits: VecDeque::new(),
            field_hits: Vec::new(),
            inventory_life: None,
            campaign_visit: 0,
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
            grenades_visible: false,
            owned_fire_cooldown: None,
            trigger: None,
            primed_grenade: None,
            grenade_throw: None,
            knife_swing: None,
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
        self.primed_grenade = None;
        self.grenade_throw = None;
        self.knife_swing = None;
        self.reload = None;
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

    fn send_grenades(&mut self, world: &World, combat: &zone_server::combat::Combat) {
        if !self.inventory_ready { return; }
        let Some(actor) = self.player.and_then(|id| world.entities.get(&id)) else { return; };
        let Some(transport) = self.transport.as_mut() else { return; };
        let Some(mut channel) = transport.rtc.channel(transport.state) else { return; };
        if channel.buffered_amount() >= 4096 { return; }
        let entries = combat.grenade_view(actor.position);
        if entries.is_empty() && !self.grenades_visible { return; }
        if let Ok(bytes) = control::encode_event(&json!({"type":"grenades","tick":world.tick,"entries":entries}))
            && channel.write(true, &bytes).unwrap_or(false)
        {
            self.grenades_visible = !entries.is_empty();
        }
    }

    fn send_gunshots(&mut self, world: &World, shots: &[(usize, ObservedShot)]) {
        if !self.inventory_ready { return; }
        let Some(actor) = self.player.and_then(|id| world.entities.get(&id)) else { return; };
        let Some(transport) = self.transport.as_mut() else { return; };
        let Some(mut channel) = transport.rtc.channel(transport.state) else { return; };
        if channel.buffered_amount() >= 4096 { return; }
        let effects: Vec<_> = shots.iter().filter_map(|(region, shot)| {
            (*region == self.region && (shot.shooter != actor.id || shot.section == "wpn_knife")
                && actor.position.distance_squared(shot.position) <= zone_server::world::INTEREST_RADIUS.powi(2))
                .then_some((shot.shooter, &shot.section, shot.sound, shot.position.x, shot.position.y, shot.position.z))
        }).take(8).collect();
        if !effects.is_empty() && let Ok(bytes) = control::encode_event(&json!({"type":"gunshots","effects":effects})) {
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
        if self.queued_fire.is_some() || self.incoming_fire || !self.impact_hits.is_empty() || !self.field_hits.is_empty()
            || self.inventory_pending.as_ref().is_some_and(|pending| matches!(pending.response,
                InventoryResponse::Impact(_) | InventoryResponse::Fields(_) | InventoryResponse::Travel { .. } | InventoryResponse::Fire { .. }))
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
        self.inventory_pending.is_some() || self.reload.is_some() || self.queued_fire.is_some() || self.knife_swing.is_some()
            || self.grenade_throw.is_some()
            || self.incoming_fire || !self.impact_hits.is_empty() || !self.field_hits.is_empty()
    }

    fn can_queue_shot(&self) -> bool {
        self.queued_fire.is_none() && self.knife_swing.is_none() && self.grenade_throw.is_none()
            && !self.inventory_pending.as_ref().is_some_and(|pending|
            matches!(pending.response, InventoryResponse::Fire { .. }))
    }

    fn can_resume_body(&self) -> bool {
        self.queued_fire.is_none() && !self.incoming_fire && self.impact_hits.is_empty()
            && self.inventory_pending.as_ref().is_none_or(|pending|
                matches!(pending.response, InventoryResponse::Checkpoint | InventoryResponse::Fields(_)))
    }

    fn take_character(&mut self, old: Self) {
        self.player = old.player;
        self.inventory_life = old.inventory_life;
        self.campaign_visit = old.campaign_visit;
        self.condition_revision = old.condition_revision;
        self.next_checkpoint = old.next_checkpoint;
        self.checkpoint_combat_until = old.checkpoint_combat_until;
        self.logout_until = old.logout_until;
        self.owned_fire_cooldown = old.owned_fire_cooldown;
        self.inventory_pending = old.inventory_pending;
        self.field_hits = old.field_hits;
    }
}
struct RegionSpec {
    session: SessionConfig,
    loose_loot: Option<PathBuf>,
    environment_fields: Option<PathBuf>,
    alife_socket: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CampaignConfig {
    regions: Vec<RegionConfig>,
    travel: Option<TravelConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TravelConfig {
    export: PathBuf,
    approvals: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegionConfig {
    collision: PathBuf,
    spawn: [f32; 3],
    ladders: Option<PathBuf>,
    loose_loot: Option<PathBuf>,
    #[serde(alias = "radiationFields")]
    environment_fields: Option<PathBuf>,
    alife_socket: Option<PathBuf>,
}

fn configured_regions() -> Result<(Vec<RegionSpec>, Option<TravelConfig>)> {
    if let Some(path) = std::env::var_os("ZONE_CAMPAIGN_CONFIG") {
        for name in ["ZONE_COLLISION_MANIFEST", "ZONE_SPAWN_X", "ZONE_SPAWN_Y", "ZONE_SPAWN_Z",
            "ZONE_LOOSE_LOOT", "ZONE_RADIATION_FIELDS", "ZONE_ENVIRONMENT_FIELDS", "ZONE_LADDERS",
            "ZONE_ALIFE_INTEREST_SOCKET"] {
            ensure!(std::env::var_os(name).is_none(), "{name} conflicts with ZONE_CAMPAIGN_CONFIG");
        }
        let path = PathBuf::from(path);
        ensure!(std::fs::metadata(&path)?.len() <= 64 * 1024, "oversized campaign config");
        let config: CampaignConfig = serde_json::from_slice(&std::fs::read(&path)?)?;
        ensure!((2..=5).contains(&config.regions.len()), "campaign requires two to five maps");
        let base = path.parent().unwrap_or_else(|| Path::new("."));
        let mut specs: Vec<RegionSpec> = Vec::with_capacity(config.regions.len());
        for region in config.regions {
            let mut map = CollisionMap::load(&base.join(region.collision))?;
            if let Some(path) = region.ladders { map.attach_ladder_export(&base.join(path))?; }
            let [x, y, z] = region.spawn;
            let session = SessionConfig::campaign(map, x, z, Some(y))?;
            ensure!(
                specs.iter().all(|other| other.session.contract.world != session.contract.world),
                "duplicate campaign map"
            );
            specs.push(RegionSpec {
                session,
                loose_loot: region.loose_loot.map(|path| base.join(path)),
                environment_fields: region.environment_fields.map(|path| base.join(path)),
                alife_socket: region.alife_socket,
            });
        }
        let travel = config.travel.map(|travel| TravelConfig {
            export: base.join(travel.export), approvals: base.join(travel.approvals),
        });
        return Ok((specs, travel));
    }
    let session = if let Ok(path) = std::env::var("ZONE_COLLISION_MANIFEST") {
        let mut map = CollisionMap::load(std::path::Path::new(&path))?;
        if let Some(path) = std::env::var_os("ZONE_LADDERS") {
            map.attach_ladder_export(Path::new(&path))?;
        }
        let anchor = |axis, zaton_default: &str| -> Result<f32> {
            let value = match std::env::var(axis) {
                Ok(value) => value,
                Err(std::env::VarError::NotPresent) if map.manifest.level == "zaton" => zaton_default.into(),
                Err(error) => return Err(error).with_context(|| format!("{axis} is required for this map")),
            };
            value.parse().with_context(|| format!("invalid {axis}"))
        };
        let x = anchor("ZONE_SPAWN_X", "87.599976")?;
        let z = anchor("ZONE_SPAWN_Z", "115")?;
        let height = std::env::var("ZONE_SPAWN_Y").ok().map(|value| value.parse()).transpose()?;
        SessionConfig::campaign(map, x, z, height)?
    } else {
        ensure!(std::env::var_os("ZONE_LADDERS").is_none(), "ladders require a collision map");
        SessionConfig::synthetic()
    };
    let fields = std::env::var_os("ZONE_ENVIRONMENT_FIELDS");
    let radiation = std::env::var_os("ZONE_RADIATION_FIELDS");
    ensure!(fields.is_none() || radiation.is_none(), "select one continuous field manifest");
    Ok((vec![RegionSpec {
        session,
        loose_loot: std::env::var_os("ZONE_LOOSE_LOOT").map(PathBuf::from),
        environment_fields: fields.or(radiation).map(PathBuf::from),
        alife_socket: std::env::var_os("ZONE_ALIFE_INTEREST_SOCKET").map(PathBuf::from),
    }], None))
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
    let (specs, travel_config) = configured_regions()?;
    let catalog=std::env::var("ZONE_ITEM_CATALOG").ok()
        .map(|path|zone_server::catalog::Catalog::load(std::path::Path::new(&path)).map(Arc::new)).transpose()?;
    let reload_timings = std::env::var_os("ZONE_RELOAD_TIMINGS").map(|path| {
        zone_server::reload_timing::ReloadTimings::load(Path::new(&path),
            catalog.as_deref().context("ZONE_RELOAD_TIMINGS requires ZONE_ITEM_CATALOG")?).map(Arc::new)
    }).transpose()?;
    if let Some(catalog)=&catalog {tracing::info!(sha256=%catalog.sha256,sections=catalog.sections_len(),"loaded original item catalog");}
    let rules=if let Some(catalog)=&catalog {
        let rules=match std::env::var("ZONE_SURVIVAL_RULES"){Ok(path)=>zone_server::survival_rules::SurvivalRules::load(std::path::Path::new(&path))?,Err(_)=>zone_server::survival_rules::SurvivalRules::default()};
        rules.validate(catalog)?;Some(Arc::new(rules))
    }else{None};
    let database = std::env::var("ZONE_DATABASE").ok();
    if specs.iter().any(|spec| spec.alife_socket.is_some()) {
        ensure!(catalog.is_some() && database.is_some(), "A-Life host integration requires persistent survival");
        ensure!(max_players <= zone_server::alife_interests::MAX_PLAYERS, "A-Life interest player limit exceeded");
    }
    ensure!(
        specs.len() == 1 || database.is_some() && catalog.is_some(),
        "a campaign requires an item catalog and persistence database"
    );
    let authored_loot = std::env::var_os("ZONE_AUTHORED_LOOT").map(PathBuf::from);
    let artefact_sites = std::env::var_os("ZONE_ARTEFACT_SITES").map(PathBuf::from);
    ensure!(artefact_sites.is_none() || authored_loot.is_some(), "artefact sites require ZONE_AUTHORED_LOOT");
    let tuning = catalog.as_deref().zip(rules.as_deref())
        .map(|(catalog, rules)| zone_server::survival::Tuning::from_catalog(catalog, rules))
        .transpose()?;
    let mut loot = Vec::new();
    let mut regions = Vec::with_capacity(specs.len());
    for spec in specs {
        let session = Arc::new(spec.session);
        if let Some(path) = &authored_loot {
            ensure!(database.is_some(), "authored loot requires a persistence database");
            let collision = session.collision().context("authored loot requires original collision geometry")?;
            let catalog = catalog.as_deref().context("authored loot requires an original item catalog")?;
            let authored = zone_server::loot::AuthoredLoot::load(
                path, spec.loose_loot.as_deref(), &session.contract.world, &collision, catalog,
            )?;
            loot.push(match &artefact_sites {
                Some(path) => authored.with_artefacts(path, &collision, catalog)?,
                None => authored,
            });
        } else {
            ensure!(spec.loose_loot.is_none(), "loose loot requires ZONE_AUTHORED_LOOT");
        }
        let mut world = session.make_world(spec.alife_socket.is_some())?;
        world.survival_tuning = tuning.clone();
        if let Some(path) = spec.environment_fields {
            ensure!(database.is_some(), "continuous fields require a persistence database");
            let collision = session.collision().context("continuous fields require original collision geometry")?;
            let catalog = catalog.as_deref().context("continuous fields require an original item catalog")?;
            world.environment_fields = Some(zone_server::environment::Fields::load(&path, &collision, catalog)?);
        }
        if let Some(rules) = &rules {
            world.combat_lock_ticks = rules.safe_zone_combat_lock_seconds * TICK_HZ;
        }
        let alife_interests = spec.alife_socket.as_deref().map(|path| {
            zone_server::alife_interests::AlifeInterests::new(path, &session.contract.world)
        }).transpose()?;
        regions.push(Region { session, world, combat: Default::default(), scenes: Default::default(), alife_interests });
    }
    let sessions: Vec<_> = regions.iter().map(|region| region.session.clone()).collect();
    let travel = travel_config.map(|config| {
        let active: Vec<_> = sessions.iter().map(Arc::as_ref).collect();
        zone_server::travel::Routes::load(&config.export, &config.approvals, &active)
    }).transpose()?.map(Arc::new);
    let (persistence, saved_logouts) = if let Some(path) = database {
        let restore_worlds: Vec<_> = sessions.iter()
            .filter(|_| rules.as_ref().is_some_and(|rules| rules.logout_vulnerability_seconds != 0))
            .flat_map(|session| std::iter::once(session.contract.clone()).chain(session.previous_movement_contract())).collect();
        let (store, logouts) = zone_server::persistence::Persistence::start_for_worlds(
            Path::new(&path), catalog.clone(), rules.clone(), loot, &restore_worlds.iter().collect::<Vec<_>>(),
        )?;
        (Some(store), logouts)
    } else {
        (None, Vec::new())
    };
    let ownership_updates = persistence.as_ref().map(|p| p.subscribe());
    let runtime_updates = persistence.as_ref().map(|p| p.runtime());
    let persistence_handle = persistence.clone();
    let socket = UdpSocket::bind(udp).await.context("binding gameplay UDP")?;
    let (tx, rx) = mpsc::channel(32);
    let shutdown_commands = tx.clone();
    let state = Arc::new(HttpState {
        survival:catalog.is_some(),
        sessions,
        commands: tx,
        token,
        persistence,
        origin: std::env::var("ZONE_ORIGIN").unwrap_or_else(|_| format!("http://{http}")),
        travel: travel.clone(),
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
            get(|State(s): State<Arc<HttpState>>| async move { Json(s.sessions[0].contract.clone()) }),
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
        .route("/world.json", get(world_info))
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
        regions,
        RuntimeFeeds {
            ownership: ownership_updates,
            scene: runtime_updates,
            inventory: InventoryRuntime{store:persistence_handle.clone(),catalog,reload_timings,auth_epoch:0,
                logout_ticks:rules.as_ref().map_or(0, |rules| rules.logout_vulnerability_seconds * TICK_HZ),
                checkpoints:CheckpointPhase::Running, travel},
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
async fn world_info(State(state): State<Arc<HttpState>>, headers: HeaderMap) -> impl IntoResponse {
    let mut region = 0;
    if state.sessions.len() > 1 && headers.contains_key("x-zone-identity") {
        if !authorized(&state, &headers) {
            return (StatusCode::FORBIDDEN, Json(json!({"error":"unauthorized origin or token"})));
        }
        let store = state.persistence.as_ref().expect("campaign persistence");
        let identity = match store.execute(identity_header(&headers), zone_server::persistence::Operation::Resume).await {
            Ok(value) if value["principalId"].is_string() => value,
            Ok(_) => return (StatusCode::UNAUTHORIZED, Json(json!({"error":"unauthorized identity"}))),
            Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"identity service unavailable"}))),
        };
        if let Some(world) = identity["campaign"]["world"].as_str() {
            let Some(index) = state.sessions.iter().position(|session| session.contract.world == world) else {
                return (StatusCode::CONFLICT, Json(json!({"error":"saved campaign map is unavailable"})));
            };
            region = index;
        }
    }
    let session = &state.sessions[region];
    let travel_use = state.travel.as_ref().map_or_else(Vec::new, |routes| routes.interaction_points(&session.contract.world));
    (StatusCode::OK, Json(json!({
        "contract":session.contract,"content":session.content,"persistence":state.persistence.is_some(),
        "survival":state.survival,"campaign":state.sessions.len() > 1,"travelUse":travel_use
    })))
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
    let Some(region) = state.sessions.iter().position(|session| session.contract == body.contract) else {
        return (
            StatusCode::CONFLICT,
            Json(json!({"error":"multiplayer world or contract mismatch"})),
        );
    };
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
                let assigned = value["campaign"]["world"].as_str().unwrap_or(&state.sessions[0].contract.world);
                if assigned != body.contract.world {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({"error":"character belongs to another campaign map"})),
                    );
                }
                Some(zone_server::policy::Admission {
                    principal: value["principalId"].as_str().unwrap().to_owned(),
                    auth_epoch: value["authEpoch"].as_i64().expect("database auth epoch"),
                    campaign_visit: value["campaign"]["visit"].as_u64().map_or(0, |visit| {
                        u32::try_from(visit).expect("database campaign visit")
                    }),
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
        .try_send(Command::Offer(region, body.offer, principal, tx))
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
    mut regions: Vec<Region>,
    mut feeds: RuntimeFeeds,
) -> Result<()> {
    // This single socket represents the advertised public ICE endpoint. Hosting
    // NAT (including Fly's UDP ingress) rewrites its destination to the bound
    // interface. Restore the logical destination used by our host candidate;
    // passing the private/wildcard bind address makes ICE reject valid STUN.
    let local = public;
    let mut runtime_healthy = true;
    let mut auth_epoch = 0;
    if let Some(rx) = &feeds.scene {
        let state = rx.borrow().clone();
        ensure!(state.healthy, "persistence unavailable at startup");
        for region in &mut regions {
            region.scenes.reconcile(&state.scenes, &region.session, &mut region.world)?;
        }
        auth_epoch = state.auth_epoch;
    }
    let mut peers: HashMap<u64, Peer> = HashMap::new();
    let mut routes: HashMap<SocketAddr, u64> = HashMap::new();
    let mut next_peer = 0u64;
    let mut metrics = Metrics::default();
    let mut inventory=feeds.inventory;
    inventory.auth_epoch=u64::try_from(auth_epoch)?;
    for saved in feeds.saved_logouts {
        let Some(index) = regions.iter().position(|region| region.session.contract.world == saved.location.world) else { continue; };
        let Region { session, world, .. } = &mut regions[index];
        let remaining = ticks_until(saved.location.logout_until_ms).min(inventory.logout_ticks);
        if remaining == 0 { continue; }
        let Some(id) = restore_saved_pose(world, session, &saved.location) else { continue; };
        let actor = world.entities.get_mut(&id).unwrap();
        actor.set_condition(saved.condition.state);
        actor.loadout = saved.loadout;
        actor.appearance = saved.appearance;
        actor.character_key = Some(CharacterKey { principal: saved.principal.clone(), life: saved.life });
        let mut peer = Peer::new(Instant::now(), None);
        peer.region = index;
        peer.player = Some(id);
        peer.principal = Some(saved.principal);
        peer.inventory_life = Some(saved.life);
        peer.campaign_visit = saved.visit;
        peer.condition_revision = saved.condition.revision;
        peer.logout_until = Some(world.tick.wrapping_add(remaining));
        next_peer += 1;
        peers.insert(next_peer, peer);
    }
    for region in &mut regions { region.combat.capture(&region.world); }
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
                if state.healthy {
                    for region in &mut regions {
                        region.scenes.reconcile(&state.scenes, &region.session, &mut region.world)?;
                    }
                }
            },
            change=async {match &mut feeds.ownership {Some(rx)=>rx.recv().await,None=>std::future::pending().await}} => {
                match change {
                    Ok(change)=>{for peer in peers.values_mut(){if peer.principal.as_ref().is_some_and(|id|change.principals.contains(id)){peer.ownership_dirty=true;}}},
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{for peer in peers.values_mut(){peer.ownership_dirty=peer.principal.is_some();}},
                    Err(tokio::sync::broadcast::error::RecvError::Closed)=>feeds.ownership=None,
                }
            },
            command=commands.recv()=>match command {
                Some(Command::Offer(region,offer,admission,reply))=>{
                    if admission.as_ref().is_some_and(|ticket|!ticket.valid_at(auth_epoch)){let _=reply.send(Err("identity authorization changed; reconnect".into()));continue;}
                    let campaign_visit=admission.as_ref().map_or(0,|ticket|ticket.campaign_visit);
                    let principal=admission.map(|ticket|ticket.principal);
                    if reply.is_closed(){continue;}
                    if !runtime_healthy{let _=reply.send(Err("persistence unavailable".into()));continue;}
                    let Region { session, world, .. } = &mut regions[region];
                    let mut resume = None;
                    let mut departure = None;
                    if let Some((id, old)) = principal.as_ref().and_then(|principal| {
                        peers.iter_mut().find(|(_, peer)| peer.principal.as_ref() == Some(principal))
                    }) {
                        if old.transferred {
                            departure = Some(*id);
                        } else {
                            if old.connected() { let _=reply.send(Err("identity already connected".into()));continue; }
                            if old.region != region || old.campaign_visit != campaign_visit {
                                let _=reply.send(Err("character visit changed; reconnect".into()));continue;
                            }
                            if !old.can_resume_body() || !old.logout_waiting(world) {
                                let _=reply.send(Err("character checkpoint in progress; reconnect".into()));continue;
                            }
                            resume = Some(*id);
                        }
                    }
                    if resume.is_none() && departure.is_none() && peers.len()>=max_players {let _=reply.send(Err("server is full".into()));continue;}
                    match create_peer(offer,public,session) {
                        Ok((mut peer,mut answer))=>{
                            peer.region=region;
                            peer.principal=principal;
                            peer.campaign_visit=campaign_visit;
                            peer.ownership_dirty=peer.principal.is_some();
                            answer["principalId"]=json!(peer.principal);
                            if reply.send(Ok(answer)).is_ok() {
                                if let Some(id) = departure { peers.remove(&id); }
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
                        pump_inventory(&mut peers, &mut regions, &inventory, &mut metrics);
                        let pending = peers.values().any(Peer::inventory_busy);
                        if !pending && inventory.checkpoints == CheckpointPhase::Draining {
                            inventory.checkpoints = CheckpointPhase::Final;
                            for peer in peers.values_mut() {
                                peer.begin_logout(&mut regions[peer.region].world, inventory.logout_ticks);
                                peer.disconnect_saved = false;
                            }
                            continue;
                        }
                        let unfinished = pending || peers.values().any(|peer| peer.needs_final_state(&regions[peer.region].world));
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
                    let context = runtime_healthy.then(|| peers.iter().find_map(|(id, peer)| {
                        let region = &regions[peer.region];
                        let actor = region.world.entities.get(&peer.player?)?;
                        (peer.principal.as_ref() == Some(&principal) && peer.connected() && !actor.travelling)
                            .then(|| zone_server::policy::ActionContext {
                                principal: principal.clone(),
                                world: Some(region.session.contract.world.clone()),
                                session: Some(*id),
                                expires: Instant::now() + Duration::from_secs(2),
                            })
                    })).flatten();
                    let _ = reply.send(context);
                },
                Some(Command::Metrics(reply))=>{
                    metrics.sessions=peers.values().filter(|peer|peer.connected()).count();
                    metrics.players=peers.values().filter(|peer|peer.connected()&&peer.inventory_ready&&peer.player.is_some()).count();
                    metrics.vulnerable_logouts=peers.values().filter(|peer|!peer.inventory_ready||!peer.connected()).filter(|peer|peer.logout_waiting(&regions[peer.region].world)).count();
                    let entry=&regions[0];
                    metrics.tick=entry.world.tick;
                    let movement_errors: u64 = regions.iter().map(|r|r.world.movement_errors).sum();
                    let persistent_entities: usize = regions.iter().map(|r|r.scenes.len()).sum();
                    let _=reply.send(json!({"metrics":metrics,"maxPlayers":max_players,"tickHz":TICK_HZ,"snapshotHz":TICK_HZ/SNAPSHOT_EVERY,"world":entry.session.contract.world,"contentRevision":entry.session.contract.content_revision,"movementErrors":movement_errors,"persistentEntities":persistent_entities,"persistenceHealthy":runtime_healthy,"authEpoch":auth_epoch}));
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
                        let Region { session, world, combat, .. } = &mut regions[peer.region];
                        drain(peer,&socket,world,&mut metrics,session,combat,&inventory);
                    }
                }
            },
            _=timers.tick()=>{
                let now=Instant::now();
                for peer in peers.values_mut() {
                    let Region { session, world, combat, .. } = &mut regions[peer.region];
                    if (!peer.inventory_ready && now.duration_since(peer.born)>Duration::from_secs(15))
                        || now.duration_since(peer.last_input)>Duration::from_secs(20)
                        || (!peer.inventory_ready && peer.logout_until.is_some_and(|until| !newer(until, world.tick)))
                    {peer.disconnect();}
                    if peer.transport.as_ref().is_some_and(|transport| transport.deadline <= now) {
                        peer.receive(RtcInput::Timeout(now));
                        drain(peer,&socket,world,&mut metrics,session,combat,&inventory);
                    }
                    if !peer.connected() {
                        peer.disconnect();
                        if peer.logout_until.is_none() && let Some(id) = peer.player { world.clear_player_input(id); }
                    }
                }
                pump_inventory(&mut peers, &mut regions, &inventory, &mut metrics);
                let targeted = queued_shot_targets(&peers);
                peers.retain(|_,peer|{
                    let world = &mut regions[peer.region].world;
                    if !peer.connected() {
                        if peer.player.is_some_and(|id| targeted.contains(&(peer.region, id))) { return true; }
                        peer.begin_logout(world, inventory.logout_ticks);
                    }
                    let keep=peer.connected() || peer.inventory_busy()
                        || peer.logout_waiting(world) || peer.needs_final_state(world);
                    if !keep && let Some(id)=peer.player {world.remove(id);}
                    keep
                });
                routes.retain(|_,id|peers.get(id).is_some_and(|peer|peer.connected()));
            },
            _=simulation.tick()=>{
                let now=Instant::now();if now.duration_since(last_tick)>Duration::from_millis(50){metrics.late_ticks+=1;}last_tick=now;
                for (index, region) in regions.iter_mut().enumerate() {
                    let Region { session, world, combat, alife_interests, .. } = region;
                    if let Some(host) = alife_interests {
                        host.refresh_npcs(world, inventory.store.as_ref(), |receipt, health| native_shot_result(&mut peers, &mut metrics, receipt, health));
                    }
                    world.step();
                    if world.tick.is_multiple_of(TICK_HZ / 10) && let Some(host) = alife_interests {
                        host.publish(world);
                    }
                    let mut detonations = combat.step_projectiles(world);
                    let mut field_hits = HashMap::<_, Vec<_>>::new();
                    for (id, hits) in world.environment_hits.drain(..) {
                        field_hits.entry(id).or_default().extend(hits);
                    }
                    let mut contacts = HashMap::<u32, Vec<_>>::new();
                    if let Some(host) = alife_interests {
                        use zone_server::alife_interests::NativeImpact;
                        host.drain_impacts(world, |impact| match impact {
                            NativeImpact::Physical(hit) => contacts.entry(hit.target).or_default().push(hit),
                            NativeImpact::Field(target, pulse) => field_hits.entry(target).or_default().push(pulse),
                        });
                    }
                    for detonation in &mut detonations {
                        if let Some(host) = alife_interests {
                            for hit in detonation.native_hits.drain(..) { host.queue_attack(hit, world.tick, None); }
                        }
                        for hit in detonation.hits.drain(..) {
                            contacts.entry(hit.target).or_default().push(hit);
                        }
                    }
                    if let Some(host) = alife_interests {
                        host.flush_attacks(world, |receipt| native_shot_result(&mut peers, &mut metrics, receipt, None));
                    }
                    combat.expire_corpses(world);
                    combat.capture(world);
                    for peer in peers.values_mut().filter(|peer| peer.region == index) {
                        if let Some(id) = peer.player && let Some(hits) = field_hits.remove(&id) {
                            queue_fields(peer, world, id, &hits);
                        }
                        if let Some(hits) = peer.player.and_then(|id| contacts.remove(&id)) {
                            peer.impact_hits.extend(hits);
                        }
                        if !detonations.is_empty() { peer.send_detonations(world, &detonations); }
                        if world.tick.is_multiple_of(3) { peer.send_grenades(world, combat); }
                        poll_grenade_throw(peer, world, combat, &mut metrics);
                        poll_knife(peer, world, combat, &mut metrics);
                        poll_trigger(peer, world, combat, &mut metrics);
                    }
                    if let Some(store) = &inventory.store {
                        store.observe_loot_players(&session.contract.world, world);
                    }
                }
                if let Some(travel) = &inventory.travel {
                    let targeted = queued_shot_targets(&peers);
                    for peer in peers.values_mut() {
                        let Some(id) = peer.player else { continue; };
                        let targeted = targeted.contains(&(peer.region, id));
                        let Region { session, world, .. } = &mut regions[peer.region];
                        let sequence = peer.travel_use.take();
                        if let Err(reason) = start_travel(peer, world, session, &inventory, travel, sequence, targeted)
                            && let Some(sequence) = sequence {
                            reject_travel(peer, sequence, reason);
                        }
                    }
                }
                metrics.ticks+=1;
                metrics.tick_us=now.elapsed().as_micros() as u64;metrics.max_tick_us=metrics.max_tick_us.max(metrics.tick_us);
                if regions[0].world.tick.is_multiple_of(SNAPSHOT_EVERY) {
                    let start=Instant::now();
                    for peer in peers.values_mut() {
                        if !peer.inventory_ready { continue; }
                        let Region { session, world, combat, .. } = &mut regions[peer.region];
                        if let (Some(transport), Some(id)) = (&mut peer.transport, peer.player) {
                            if let Some(actor) = world.entities.get(&id) && actor.armour_revision != peer.armour_seen
                                && transport.rtc.channel(transport.control).is_some_and(|mut channel|
                                    channel.buffered_amount() < 8192 && channel.write(true, &[0x58,0x5a,protocol::VERSION,21]).unwrap_or(false))
                            { peer.armour_seen = actor.armour_revision; }
                            if peer.ownership_dirty && transport.rtc.channel(transport.control).is_some_and(|mut channel|channel.buffered_amount()<8192&&channel.write(true,&[0x58,0x5a,protocol::VERSION,17]).unwrap_or(false)) {peer.ownership_dirty=false;}
                            if let Some(life) = peer.inventory_life
                                && let Some(view) = player_vitals(world, id, life)
                            {
                                if peer.vitals != Some(view)
                                    && (world.tick.is_multiple_of(6) || peer.vitals.is_none_or(|previous| previous[6..12] != view[6..12]))
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
                            if let Some(update)=peer.lifecycle.prepare_persistent(world.tick,&visible,&world.persistent_ids,&world.entities) {
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
                            drain(peer,&socket,world,&mut metrics,session,combat,&inventory);
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
    Ok(zone_server::inventory::Context{principal,life:peer.inventory_life.unwrap_or(0),visit:peer.campaign_visit,auth_epoch:runtime.auth_epoch,world:session.contract.world.clone(),
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
        || peer.incoming_fire
        || ((peer.queued_fire.is_some() || !peer.impact_hits.is_empty() || !peer.field_hits.is_empty())
            && !matches!(response, InventoryResponse::Impact(_) | InventoryResponse::Fields(_)))
    {
        return Err("inventory busy; retry the same request ID".into());
    }
    let reply = runtime.store.as_ref().ok_or("persistence unavailable")?.inventory_request(context, operation)?;
    peer.inventory_pending = Some(InventoryPending { response, reply });
    Ok(())
}

fn finish_reload(peer: &mut Peer, result: Value, cancelled: bool) {
    let Some(reload) = peer.reload.take() else { return; };
    if reload.plan.is_some() {
        peer.control(json!({"type":"weapon_reload","life":reload.command.life,"item":reload.command.item,
            "alias":"","milliseconds":0,"sound":0,"cancelled":cancelled}));
    }
    let result = reload.first_commit.unwrap_or(result);
    peer.control(json!({"type":"action_result","sequence":reload.sequence,"result":result}));
}

fn schedule_reload(peer: &mut Peer, phase: ReloadPhase) {
    let reload = peer.reload.as_mut().unwrap();
    let plan = reload.plan.as_ref().unwrap();
    let cue = match phase {
        ReloadPhase::Open => plan.open.as_ref().unwrap(),
        ReloadPhase::Apply => &plan.apply,
        ReloadPhase::Close => plan.close.as_ref().unwrap(),
        ReloadPhase::Prepare | ReloadPhase::FinishInsert => unreachable!(),
    };
    reload.phase = phase;
    reload.until = Instant::now() + Duration::from_millis(u64::from(cue.milliseconds));
    let message = json!({"type":"weapon_reload","life":reload.command.life,"item":reload.command.item,
        "alias":cue.alias,"milliseconds":cue.milliseconds,"sound":cue.sound as u8,"cancelled":false});
    peer.control(message);
}

fn reload_prepared(peer: &mut Peer, mut result: Value) {
    let Some(reload) = peer.reload.as_mut() else { return; };
    let plan = result.as_object_mut().and_then(|object| object.remove("plan"))
        .and_then(|plan| serde_json::from_value::<zone_server::reload_timing::ReloadPlan>(plan).ok());
    let slot = result["slot"].as_u64().filter(|slot| matches!(*slot, 2 | 3));
    if let Some(plan) = plan && let Some(slot) = slot {
        let phase = if reload.first_commit.is_none() && plan.open.is_some() { ReloadPhase::Open }
            else if reload.interrupted && plan.close.is_some() { ReloadPhase::Close }
            else { ReloadPhase::Apply };
        reload.slot = slot as u8;
        reload.plan = Some(plan);
        schedule_reload(peer, phase);
    } else if reload.first_commit.is_some() {
        schedule_reload(peer, ReloadPhase::Close);
    } else {
        finish_reload(peer, result, true);
    }
}

fn reload_applied(peer: &mut Peer, world: &mut World, mut result: Value) {
    apply_loadout(peer, world, &mut result);
    let committed = result["status"] == "committed";
    if committed { peer.control(json!({"type":"inventory_dirty"})); }
    let Some(reload) = peer.reload.as_mut() else { return; };
    let tube = reload.plan.as_ref().is_some_and(|plan| plan.close.is_some());
    if !tube || !committed && reload.first_commit.is_none() {
        finish_reload(peer, result, !committed);
        return;
    }
    if !committed {
        schedule_reload(peer, ReloadPhase::Close);
        return;
    }
    let revision = result["revision"].as_u64().and_then(|n| u32::try_from(n).ok()).expect("committed reload revision");
    if reload.first_commit.is_none() { reload.first_commit = Some(result); }
    if reload.interrupted {
        // CoP inserts the current shell on interruption but waits for its
        // animation to finish before closing the action.
        reload.phase = ReloadPhase::FinishInsert;
        return;
    }
    use sha2::{Digest, Sha256};
    let step_id = format!("{:x}", Sha256::digest(format!("zone-reload-step-v1\n{}\n{revision}", reload.root)));
    reload.command.request_id = step_id[..32].to_owned();
    reload.command.revision = revision;
    reload.command.action = zone_server::inventory::MoveAction::Reload;
    reload.phase = ReloadPhase::Prepare;
    reload.until = Instant::now();
}

fn poll_reload(peer: &mut Peer, world: &World, session: &SessionConfig, runtime: &InventoryRuntime) -> bool {
    let Some(reload) = peer.reload.as_ref() else { return false; };
    let valid = runtime.checkpoints == CheckpointPhase::Running && peer.connected()
        && peer.inventory_life == Some(reload.command.life)
        && peer.player.and_then(|id| world.entities.get(&id)).is_some_and(|actor|
            actor.health > 0 && !actor.travelling && (reload.slot == 0 || actor.loadout.active_weapon_slot == reload.slot));
    if !valid {
        finish_reload(peer, json!({"status":"rejected","reason":"reload_cancelled"}), true);
        return false;
    }
    if Instant::now() < reload.until && !(reload.phase == ReloadPhase::Apply && reload.interrupted) {
        return false;
    }
    match reload.phase {
        ReloadPhase::Open => schedule_reload(peer, ReloadPhase::Apply),
        ReloadPhase::FinishInsert => schedule_reload(peer, ReloadPhase::Close),
        ReloadPhase::Close => finish_reload(peer, json!({"status":"rejected","reason":"reload_cancelled"}), false),
        phase => {
            let Ok(context) = inventory_context(peer, world, session, runtime) else {
                finish_reload(peer, json!({"status":"rejected","reason":"reload_cancelled"}), true);
                return false;
            };
            let preparing = phase == ReloadPhase::Prepare;
            let operation = zone_server::persistence::Operation::TimedReload(reload.command.clone(),
                if preparing { runtime.reload_timings.clone() } else { None });
            let response = if preparing { InventoryResponse::ReloadPrepare } else { InventoryResponse::ReloadApply };
            let _ = inventory_enqueue(peer, runtime, context, operation, response);
        }
    }
    true
}

fn queue_fields(peer: &mut Peer, world: &mut World, id: u32, pulses: &[zone_server::environment::Pulse]) {
    let available = zone_server::environment::MAX_PENDING_PULSES - peer.field_hits.len();
    let (queued, overflow) = pulses.split_at(available.min(pulses.len()));
    peer.field_hits.extend_from_slice(queued);
    if !overflow.is_empty() {
        tracing::warn!(actor=id, pulses=overflow.len(), "field wear queue saturated");
        world.apply_field_overflow(id, overflow);
    }
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

fn native_shot_result(peers: &mut HashMap<u64, Peer>, metrics: &mut Metrics, receipt: NativeReceipt, health: Option<u16>) {
    use zone_server::combat::ShotResult;
    if let Some(peer) = peers.get_mut(&receipt.peer) {
        let result = health.map_or(ShotResult::Miss { ammo: receipt.ammo }, |health| ShotResult::Hit {
            target: receipt.target, health, ammo: receipt.ammo,
        });
        shot_result(peer, metrics, receipt.sequence, receipt.followup_tick, result);
    }
}

fn submit_owned_shot(
    peer: &mut Peer,
    world: &World,
    combat: &zone_server::combat::Combat,
    command: FireControl,
    queue_index: Option<u32>,
) -> Result<(), &'static str> {
    if let Some(reload) = &mut peer.reload {
        // A trigger press inserts the current shell and then closes the action.
        if reload.phase == ReloadPhase::Apply && reload.plan.as_ref().is_some_and(|plan| plan.close.is_some())
            || reload.phase == ReloadPhase::Prepare && reload.first_commit.is_some()
        {
            reload.interrupted = true;
        }
        return Err("reloading");
    }
    let FireControl { sequence, item, aim } = command;
    let item = item.ok_or("owned_weapon_required")?;
    let player = peer.player.ok_or("invalid_shooter")?;
    let tick = world.tick;
    if queue_index.unwrap_or(0) == 0
        && peer.owned_fire_cooldown.is_some_and(|(fired, interval)| tick.wrapping_sub(fired) < interval)
    {
        return Err("cooldown");
    }
    if !peer.can_queue_shot() {
        return Err("inventory_busy");
    }
    let shot = combat.trace_owned_round(world, player, aim, queue_index.is_some_and(|index| index > 0))?;
    peer.queued_fire = Some(QueuedFire { enqueued: Instant::now(), sequence, item, shot, queue_index, special: None });
    Ok(())
}

fn queue_throw(
    peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat,
    command: FireControl, force: zone_server::hand_grenade::Force,
) -> Result<(), &'static str> {
    let FireControl { sequence, item, aim } = command;
    let player = peer.player.ok_or("invalid_shooter")?;
    let throwable = match world.entities.get(&player).map(|actor| actor.loadout.active_weapon_slot) {
        Some(4) => Throwable::Grenade,
        Some(6) => Throwable::Bolt,
        _ => return Err("grenade_not_drawn"),
    };
    let item = item.ok_or(match throwable { Throwable::Grenade => "grenade_required", Throwable::Bolt => "bolt_required" })?;
    if !peer.can_queue_shot() { return Err("inventory_busy"); }
    if peer.owned_fire_cooldown.is_some_and(|(fired, interval)| world.tick.wrapping_sub(fired) < interval) {
        return Err("cooldown");
    }
    let shot = combat.prepare_hand_throw(world, player, aim, matches!(throwable, Throwable::Bolt))?;
    peer.queued_fire = Some(QueuedFire { enqueued: Instant::now(), sequence, item, shot, queue_index: None, special: Some(SpecialAttack::Throw(throwable, force)) });
    Ok(())
}

fn validate_hand_grenade(
    peer: &Peer, world: &World, combat: &zone_server::combat::Combat, item: &str, aim: zone_server::combat::Aim,
) -> Result<(), &'static str> {
    let player = peer.player.ok_or("invalid_shooter")?;
    let actor = world.entities.get(&player).ok_or("invalid_shooter")?;
    if actor.loadout.active_weapon_slot != 4 { return Err("grenade_not_drawn"); }
    let id = u128::from_str_radix(item, 16).ok().map(u128::to_le_bytes);
    if id.is_none() || actor.loadout.active_item != id { return Err("grenade_not_equipped"); }
    if !peer.can_queue_shot() { return Err("inventory_busy"); }
    if peer.owned_fire_cooldown.is_some_and(|(fired, interval)| world.tick.wrapping_sub(fired) < interval) {
        return Err("cooldown");
    }
    combat.validate_attack_aim(world, player, aim)
}

fn grenade_hud(peer: &mut Peer, item: &str, phase: &str) {
    if let Some(life) = peer.inventory_life {
        peer.control(json!({"type":"grenade_hud","life":life,"item":item,"phase":phase}));
    }
}

fn schedule_grenade(
    peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat,
    command: FireControl, force: zone_server::hand_grenade::Force, throw_start: u32, phase: &str,
) -> Result<(), &'static str> {
    let item = command.item.as_deref().ok_or("grenade_required")?;
    validate_hand_grenade(peer, world, combat, item, command.aim)?;
    grenade_hud(peer, item, phase);
    if !peer.connected() { return Err("inventory_unavailable"); }
    peer.grenade_throw = Some(PendingGrenadeThrow { command, force, accepted: world.tick,
        release: throw_start.wrapping_add(zone_server::hand_grenade::RELEASE_TICKS) });
    Ok(())
}

fn poll_grenade_throw(peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat, metrics: &mut Metrics) {
    if peer.grenade_throw.as_ref().is_none_or(|pending| newer(pending.release, world.tick)) { return; }
    let PendingGrenadeThrow { mut command, force, accepted, .. } = peer.grenade_throw.take().unwrap();
    if !peer.connected() { return; }
    let sequence = command.sequence;
    let item = command.item.clone().expect("validated grenade identity");
    command.aim.tick = world.tick;
    if let Some((yaw, pitch)) = peer.player.and_then(|id| world.look_since(id, accepted)) {
        command.aim.yaw = yaw;
        command.aim.pitch = pitch;
    }
    if let Err(reason) = validate_hand_grenade(peer, world, combat, &item, command.aim)
        .and_then(|()| queue_throw(peer, world, combat, command, force))
    {
        grenade_hud(peer, &item, "cancel");
        shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason });
    }
}

fn grenade_control(peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat, command: GrenadeControl, metrics: &mut Metrics) {
    let GrenadeControl { sequence, item, aim, phase } = command;
    let slot = peer.player.and_then(|id| world.entities.get(&id)).map(|actor| actor.loadout.active_weapon_slot);
    let result = match phase {
        GrenadePhase::Cancel => {
            if peer.primed_grenade.as_ref().is_some_and(|held| held.item == item) {
                peer.primed_grenade = None;
                if slot == Some(4) { grenade_hud(peer, &item, "cancel"); }
            }
            Ok(Some("cancelled"))
        }
        GrenadePhase::Prime => {
            if peer.primed_grenade.is_some() { Err("grenade_already_primed") }
            else if slot == Some(4) {
                validate_hand_grenade(peer, world, combat, &item, aim).map(|()| {
                    grenade_hud(peer, &item, "prime");
                    if peer.connected() {
                        peer.primed_grenade = Some(PrimedGrenade {
                            item, ready: world.tick.wrapping_add(zone_server::hand_grenade::READY_TICKS),
                        });
                    }
                    Some("primed")
                })
            }
            else if peer.player.and_then(|id| world.entities.get(&id)).is_some_and(|actor|
                actor.health > 0 && !actor.travelling && slot == Some(6) && !world.is_safe(actor.position))
            {
                peer.primed_grenade = Some(PrimedGrenade { item, ready: world.tick });
                Ok(Some("primed"))
            } else { Err("grenade_unavailable") }
        }
        GrenadePhase::Release => {
            if peer.primed_grenade.as_ref().is_none_or(|held| held.item != item) {
                Err("grenade_not_primed")
            } else {
                let held = peer.primed_grenade.take().unwrap();
                let before_ready = newer(held.ready, world.tick);
                let throw_start = if before_ready { held.ready } else { world.tick };
                let force = zone_server::hand_grenade::Force::Held(if before_ready { 0 } else { world.tick.wrapping_sub(held.ready) });
                let command = FireControl { sequence, item: Some(item.clone()), aim };
                if slot == Some(4) {
                    let result = schedule_grenade(peer, world, combat, command, force, throw_start, "release");
                    if result.is_err() { grenade_hud(peer, &item, "cancel"); }
                    result.map(|()| None)
                } else {
                    queue_throw(peer, world, combat, command, force).map(|()| None)
                }
            }
        }
    };
    match result {
        Ok(Some(status)) => shot_event(peer, sequence, None, json!({"status":status})),
        Ok(None) => {}
        Err(reason) => shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason }),
    }
}

fn poll_trigger(
    peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat, metrics: &mut Metrics,
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
    if newer(next.tick, world.tick) || !peer.can_queue_shot() {
        return;
    }
    let sequence = held.sequence;
    let command = FireControl { sequence, item: Some(held.item.clone()), aim: held.aim };
    if let Err(reason) = submit_owned_shot(peer, world, combat, command, Some(next.index))
        && reason != "invalid_tick"
    {
        peer.trigger = None;
        shot_result(peer, metrics, sequence, Some(world.tick), zone_server::combat::ShotResult::Rejected { reason });
    }
}

fn start_knife(
    peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat,
    catalog: Option<&zone_server::catalog::Catalog>, command: KnifeControl,
) -> Result<(), &'static str> {
    let catalog = catalog.ok_or("knife_unavailable")?;
    let player = peer.player.ok_or("invalid_shooter")?;
    let life = peer.inventory_life.ok_or("invalid_shooter")?;
    let actor = world.entities.get(&player).ok_or("invalid_shooter")?;
    if actor.loadout.active_weapon_slot != 1 {
        return Err("knife_not_drawn");
    }
    let knife_id = u128::from_str_radix(&command.item, 16).ok().map(u128::to_le_bytes);
    if knife_id.is_none() || actor.loadout.active_item != knife_id || actor.appearance.weapon.as_deref() != Some("wpn_knife") {
        return Err("knife_not_equipped");
    }
    if !peer.can_queue_shot() || peer.trigger.is_some() { return Err("inventory_busy"); }
    if peer.owned_fire_cooldown.is_some_and(|(started, interval)| world.tick.wrapping_sub(started) < interval) {
        return Err("cooldown");
    }
    combat.validate_attack_aim(world, player, command.aim)?;
    let profile = knife::Profile::from_catalog(catalog, command.mode).map_err(|_| "knife_unavailable")?;
    let (windup, recovery) = command.mode.timing();
    let cue = json!({"type":"knife_swing","life":life,"item":command.item,"stab":matches!(command.mode, knife::Mode::Stab)});
    peer.owned_fire_cooldown = Some((world.tick, recovery));
    peer.knife_swing = Some(KnifeSwing {
        command, profile, contact_tick: world.tick.wrapping_add(windup), latest_aim: None,
    });
    peer.control(cue);
    Ok(())
}

fn poll_knife(peer: &mut Peer, world: &World, combat: &zone_server::combat::Combat, metrics: &mut Metrics) {
    if peer.knife_swing.as_ref().is_none_or(|swing| newer(swing.contact_tick, world.tick)) { return; }
    let KnifeSwing { command: KnifeControl { sequence, item, mut aim, mode }, profile, latest_aim, .. } = peer.knife_swing.take().unwrap();
    if !peer.connected() { return; }
    aim.tick = aim.tick.wrapping_add(mode.timing().0);
    let result = peer.player.ok_or("invalid_shooter").and_then(|id| {
        if world.entities.get(&id).is_none_or(|actor| actor.loadout.active_weapon_slot != 1) {
            return Err("knife_not_drawn");
        }
        let aim = latest_aim.filter(|aim| combat.validate_attack_aim(world, id, *aim).is_ok()).unwrap_or(aim);
        combat.trace_knife(world, id, aim, &profile)
    });
    match result {
        Ok(shot) => peer.queued_fire = Some(QueuedFire {
            enqueued: Instant::now(), sequence, item, shot, queue_index: None, special: Some(SpecialAttack::Knife(mode)),
        }),
        Err(reason) => shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason }),
    }
}

fn reject_travel(peer: &mut Peer, sequence: u32, reason: &str) {
    peer.control(json!({"type":"action_result","sequence":sequence,"result":{"status":"rejected","reason":reason}}));
}

fn queued_shot_targets(peers: &HashMap<u64, Peer>) -> HashSet<(usize, u32)> {
    peers.values().flat_map(|peer| peer.queued_fire.iter()
        .flat_map(|round| round.shot.targets().map(|id| (peer.region, id)))).collect()
}

fn start_travel(
    peer: &mut Peer, world: &mut World, session: &SessionConfig,
    runtime: &InventoryRuntime, routes: &zone_server::travel::Routes,
    sequence: Option<u32>, targeted: bool,
) -> Result<(), &'static str> {
    if targeted || !peer.connected() || !peer.inventory_ready || peer.inventory_busy()
        || peer.next_travel.is_some_and(|next| newer(next, world.tick))
    {
        return Err("travel_busy");
    }
    let actor = peer.player.and_then(|id| world.entities.get(&id)).ok_or("actor_unavailable")?;
    if actor.health == 0 || actor.travelling { return Err("actor_unavailable"); }
    if actor.combat_ticks_left(world.tick, world.combat_lock_ticks) != 0 { return Err("combat_locked"); }
    let context;
    let route = if let Some(sequence) = sequence {
        context = inventory_context(peer, world, session, runtime).map_err(|_| "actor_unavailable")?;
        match routes.use_at(&context).map_err(|_| "travel_unavailable")?.ok_or("no_interaction")? {
            zone_server::travel::Interaction::Generator => {
                return inventory_enqueue(peer, runtime, context, zone_server::persistence::Operation::PowerLabLift,
                    InventoryResponse::Action { sequence: Some(sequence), death: false }).map_err(|_| "travel_busy");
            }
            zone_server::travel::Interaction::Lift(route) => route,
        }
    } else {
        if !actor.moving_input(world.tick) { return Ok(()); }
        let position = [actor.position.x, actor.position.y, actor.position.z];
        let Some(route) = routes.touching(&session.contract.world, position, world.capsule_height(actor.id)) else { return Ok(()); };
        context = inventory_context(peer, world, session, runtime).map_err(|_| "actor_unavailable")?;
        route
    };
    let before = zone_server::survival::Record { revision: peer.condition_revision,
        state: actor.condition.clone().ok_or("actor_unavailable")? };
    let request = format!("campaign-{}-{route}", peer.campaign_visit);
    let handoff = routes.prepare(&context, route, request, before, 0, sequence.is_some()).ok_or("no_interaction")?;
    let id = actor.id;
    inventory_enqueue(peer, runtime, context, zone_server::persistence::Operation::Travel(handoff), InventoryResponse::Travel { sequence })
        .map_err(|_| "travel_busy")?;
    // Outstanding hits were checked before submission. Freeze this body
    // until the transaction reports which world owns it.
    world.clear_player_input(id);
    if let Some(actor) = world.entities.get_mut(&id) {
        actor.travelling = true;
    }
    peer.trigger = None;
    Ok(())
}

fn retire_traveller(peer: &mut Peer, world: &mut World) {
    if let Some(id) = peer.player.take() {
        world.remove(id);
    }
    peer.inventory_life = None;
    peer.inventory_ready = false;
    peer.transferred = true;
    // Keep the control channel briefly so the destination notice can arrive.
    peer.born = Instant::now();
    peer.last_input = peer.born;
}

#[derive(Deserialize)]
struct LoadedCharacter {
    life: u32,
    visit: u32,
    alive: bool,
    condition: zone_server::survival::Record,
    location: Option<zone_server::survival::Location>,
    loadout: zone_server::survival::Loadout,
    appearance: zone_server::lifecycle::Appearance,
}

fn join_character(peer: &mut Peer, world: &mut World, session: &SessionConfig, mut saved: LoadedCharacter) {
    let id = saved.location.as_ref().filter(|_| saved.alive)
        .and_then(|place| restore_saved_pose(world, session, place))
        .unwrap_or_else(|| world.spawn(Kind::Player, session.spawn));
    if !saved.alive { saved.condition.state.health = 0.0; }
    let actor = world.entities.get_mut(&id).unwrap();
    actor.set_condition(saved.condition.state);
    actor.loadout = saved.loadout;
    actor.appearance = saved.appearance;
    actor.character_key = peer.principal.clone().map(|principal| CharacterKey { principal, life: saved.life });
    peer.player = Some(id);
    peer.inventory_life = Some(saved.life);
    peer.campaign_visit = saved.visit;
    peer.inventory_dead = !saved.alive;
    peer.condition_revision = saved.condition.revision;
    peer.next_checkpoint = world.tick.wrapping_add(CONDITION_CHECKPOINT_TICKS + id % TICK_HZ);
    peer.welcome(session, world);
}

fn player_vitals(world: &World, player: u32, life: u32) -> Option<[u32; 14]> {
    let actor = world.entities.get(&player)?;
    Some(actor.condition.as_ref()?.wire_view(life, world.survival_tuning.as_ref()?, actor.loadout))
}

fn apply_loadout(peer: &Peer, world: &mut World, result: &mut Value) {
    let appearance = result.as_object_mut().and_then(|fields| fields.remove("appearance"));
    if let Some(loadout) = result.as_object_mut().and_then(|fields| fields.remove("loadout"))
        && let Ok(loadout) = serde_json::from_value::<zone_server::survival::Loadout>(loadout)
        && let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id))
    {
        if actor.loadout.aim != loadout.aim {
            actor.cancel_aim();
        }
        actor.loadout = loadout.with_newer_armour(actor.loadout);
        if let Some(Ok(appearance)) = appearance.map(serde_json::from_value) {
            actor.appearance = appearance;
        }
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
    if place.world != session.contract.world || (place.content_revision != session.contract.content_revision
        && session.previous_movement_contract().is_none_or(|previous| previous.content_revision != place.content_revision))
        || !place.yaw.is_finite() || !place.position.iter().all(|value| value.is_finite())
        || session.collision().is_some_and(|map| {
            let bounds = &map.manifest.bounds;
            (0..3).any(|axis| !(bounds.min[axis]..=bounds.max[axis]).contains(&place.position[axis]))
        })
    { return None; }
    let [x, y, z] = place.position;
    Some(world.restore_player(Vec3 { x, y, z }, place.yaw, place.crouched, ticks_until(place.combat_until_ms)))
}

fn pump_inventory(peers: &mut HashMap<u64, Peer>, regions: &mut [Region], runtime: &InventoryRuntime, metrics: &mut Metrics) {
    let mut effects = FireEffects::default();
    for (&id, peer) in peers.iter_mut() {
        inventory_poll(id, peer, &mut regions[peer.region], runtime, metrics, &mut effects);
    }
    for (victim, commit) in effects.hits {
        let peer = peers.get_mut(&victim).expect("an incoming shot retains its target");
        peer.incoming_fire = false;
        if let Some(commit) = commit {
            debug_assert_eq!(peer.condition_revision.checked_add(1), Some(commit.revision));
            peer.condition_revision = commit.revision;
            peer.next_checkpoint = regions[peer.region].world.tick;
            peer.disconnect_saved = false;
            if !commit.alive {
                peer.inventory_dead = true;
                peer.trigger = None;
                peer.control(json!({"type":"inventory_dirty"}));
            }
        }
    }
    if !effects.shots.is_empty() {
        for peer in peers.values_mut() {
            peer.send_gunshots(&regions[peer.region].world, &effects.shots);
        }
    }

    let mut ready: Vec<_> = peers.iter().filter_map(|(&id, peer)| {
        peer.queued_fire.as_ref().map(|round| (round.enqueued, id))
    }).collect();
    if ready.is_empty() { return; }
    ready.sort_unstable();
    let actors: HashMap<_, _> = peers.iter().filter_map(|(&id, peer)| Some(((peer.region, peer.player?), id))).collect();
    for (enqueued, shooter) in ready {
        let peer = &peers[&shooter];
        let Region { session, world, .. } = &regions[peer.region];
        let round = peer.queued_fire.as_ref().expect("queued shot");
        if round.queue_index.is_some_and(|index| index > 0)
            && peer.trigger.as_ref().is_none_or(|held| held.sequence != round.sequence
                || world.tick.wrapping_sub(held.sampled_at) >= TRIGGER_LEASE_TICKS)
        {
            peers.get_mut(&shooter).unwrap().queued_fire = None;
            continue;
        }
        let expired = enqueued.elapsed() >= Duration::from_secs(2);
        if !expired && (peer.incoming_fire || peer.inventory_pending.is_some() || !peer.impact_hits.is_empty() || !peer.field_hits.is_empty()) {
            continue;
        }
        let mut groups: Vec<(u32, Vec<zone_server::combat::ShotTarget>)> = Vec::new();
        for (actor, pellet) in round.shot.armour_targets(world) {
            if let Some((_, hits)) = groups.iter_mut().find(|(id, _)| *id == actor) { hits.push(pellet); }
            else { groups.push((actor, vec![pellet])); }
        }
        // A queued outgoing shot does not lock its actor. In reciprocal fire
        // the older shot can reserve both actors without a lock cycle.
        if !expired && groups.iter().filter_map(|(actor, _)| actors.get(&(peer.region, *actor))).any(|id| {
            let target = &peers[id];
            target.incoming_fire || target.inventory_pending.is_some() || !target.impact_hits.is_empty() || !target.field_hits.is_empty()
        }) {
            continue;
        }
        let request = (|| {
            let actor = world.entities.get(&peer.player?)?;
            if expired || actor.health == 0 || actor.travelling { return None; }
            let context = inventory_context(peer, world, session, runtime).ok()?;
            let mut targets = Vec::with_capacity(groups.len());
            let mut victims = Vec::with_capacity(groups.len());
            for (target_id, hits) in groups {
                let victim_id = *actors.get(&(peer.region, target_id))?;
                let victim = peers.get(&victim_id)?;
                let hit = world.entities.get(&target_id)?;
                let mut authority = inventory_context(victim, world, session, runtime).ok()?;
                authority.expires = context.expires;
                victims.push(FireReservation { peer: victim_id, actor: target_id, life: authority.life });
                let mut hits = hits.into_iter();
                let target = hits.next()?;
                let authority = zone_server::survival::ShotVictim {
                    target,
                    context: authority,
                    before: zone_server::survival::Record { revision: victim.condition_revision, state: hit.condition.clone()? },
                    location: checkpoint_location(victim, world, session, hit)?,
                    shooter_location: checkpoint_location(peer, world, session, actor)?,
                    combat_lock_ms: (world.combat_lock_ticks * 1000).div_ceil(TICK_HZ),
                };
                targets.push(zone_server::survival::FireVictim { authority, additional: hits.collect() });
            }
            Some((context, targets, victims))
        })();
        let peer = peers.get_mut(&shooter).unwrap();
        let QueuedFire { sequence, item, shot, queue_index, special, .. } = peer.queued_fire.take().unwrap();
        let tick = world.tick;
        let mut locked = Vec::new();
        if request.is_some_and(|(context, targets, victims)| {
            locked.extend(victims.iter().map(|victim| victim.peer));
            let firearm = special.is_none().then(|| (context.life, item.clone()));
            let operation = match special {
                Some(SpecialAttack::Throw(Throwable::Grenade, force)) => zone_server::persistence::Operation::ThrowGrenade(item, force),
                Some(SpecialAttack::Throw(Throwable::Bolt, force)) => zone_server::persistence::Operation::ThrowBolt(item, force),
                Some(SpecialAttack::Knife(mode)) => zone_server::persistence::Operation::StrikeKnife(item, mode,
                    targets.into_iter().next().map(|group| Box::new(group.authority)), shot.knife_splash),
                None => zone_server::persistence::Operation::FireWeapon(item, targets,
                    zone_server::combat::FireState { queue_index, traced: shot.ballistics }),
            };
            inventory_enqueue(peer, runtime, context, operation,
                InventoryResponse::Fire { sequence, tick, shot, queue_index, victims, firearm }).is_ok()
        }) {
            for id in locked { peers.get_mut(&id).unwrap().incoming_fire = true; }
        } else {
            if peer.trigger.as_ref().is_some_and(|held| held.sequence == sequence) { peer.trigger = None; }
            shot_result(peer, metrics, sequence, queue_index.filter(|index| *index > 0).map(|_| tick),
                zone_server::combat::ShotResult::Rejected { reason: "inventory_unavailable" });
        }
    }
}

fn inventory_poll(id:u64,peer:&mut Peer,region:&mut Region,runtime:&InventoryRuntime,metrics:&mut Metrics,effects:&mut FireEffects){
    let Region { session, world, combat, alife_interests, .. } = region;
    if runtime.catalog.is_none() || runtime.store.is_none() || peer.principal.is_none()
        || peer.incoming_fire || (!peer.inventory_ready && peer.inventory_life.is_none()) { return; }
    if let Some(pending)=&mut peer.inventory_pending {
        match pending.reply.try_recv(){
            Err(oneshot::error::TryRecvError::Empty)=>return,
            Err(oneshot::error::TryRecvError::Closed)=>{
                match peer.inventory_pending.take().unwrap().response {
                    InventoryResponse::Travel { .. } => retire_traveller(peer, world),
                    InventoryResponse::Fire { victims, .. } => effects.hits.extend(victims.into_iter().map(|victim| (victim.peer, None))),
                    _ => {}
                }
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
                    InventoryResponse::ReloadPrepare => reload_prepared(peer, result.unwrap_or_else(|error| json!({"error":error}))),
                    InventoryResponse::ReloadApply => reload_applied(peer, world, result.unwrap_or_else(|error| json!({"error":error}))),
                    InventoryResponse::Travel { sequence } => {
                        if let Some(sequence) = sequence {
                            let value = result.as_ref().ok().cloned().unwrap_or_else(|| json!({"status":"rejected","reason":"travel_unavailable"}));
                            peer.control(json!({"type":"action_result","sequence":sequence,"result":value}));
                        }
                        if let Ok(value) = &result && value["status"] == "committed" {
                            retire_traveller(peer, world);
                            peer.control(json!({"type":"travel","world":value["world"]}));
                        } else {
                            if let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id)) {
                                actor.travelling = false;
                            }
                            peer.next_travel = Some(world.tick.wrapping_add(TICK_HZ));
                        }
                    }
                    InventoryResponse::Fire { sequence, tick, shot, queue_index, victims, firearm } => {
                        let mut value = result.unwrap_or_else(|error| json!({"error":error}));
                        let loadout_updated = value.get("loadout").is_some();
                        apply_loadout(peer, world, &mut value);
                        let charge = value.as_object_mut().and_then(|object| object.remove("shot"));
                        let sound = value.as_object_mut().and_then(|object| object.remove("effect"));
                        if let Some(profile) = value.as_object_mut().and_then(|object| object.remove("ballistics"))
                            && let Ok(profile) = serde_json::from_value(profile)
                            && let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id))
                        {
                            actor.loadout.ballistics = profile;
                        }
                        let followup_tick = queue_index.is_some_and(|index| index > 0).then_some(tick);
                        let charge = charge.and_then(|value| serde_json::from_value::<zone_server::combat::ChargedShot>(value).ok());
                        let volley = value.as_object_mut().and_then(|object| object.remove("volley"))
                            .and_then(|value| serde_json::from_value::<Option<Vec<Option<zone_server::combat::VolleyImpact>>>>(value).ok()).flatten();
                        let multi = volley.is_some();
                        let mut impacts = volley.into_iter().flatten();
                        let mut player_hit = None;
                        for victim in victims {
                            let impact = impacts.next().flatten();
                            let commit = if multi { impact.as_ref().map(|hit| hit.commit) }
                                else { charge.as_ref().and_then(|charge| charge.target_commit) };
                            effects.hits.push((victim.peer, commit));
                            if let (Some(impact), Some(charge)) = (impact, charge.as_ref()) {
                                let hit = combat.apply_volley(world, &shot, victim.actor, victim.life, impact, charge.ammo);
                                if player_hit.is_none() { player_hit = hit; }
                            }
                        }
                        if let Some(charge) = charge {
                            if let Some((life, item)) = firearm {
                                peer.control(json!({"type":"weapon_fired","life":life,"item":item,
                                    "ammo":charge.ammo,"launcher":charge.launcher.is_some()}));
                            }
                            if let Some((section, sound)) = sound.and_then(|value| serde_json::from_value::<(String, u8)>(value).ok()) {
                                let (shooter, position) = shot.firing_origin();
                                effects.shots.push((peer.region, ObservedShot { shooter, position, section, sound }));
                            }
                            if !loadout_updated && let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id)) {
                                actor.loadout.mass = (actor.loadout.mass - charge.mass_spent).max(0.0);
                            }
                            if charge.interval != 0 { peer.owned_fire_cooldown = Some((tick, charge.interval)); }
                            if let Some(held) = peer.trigger.as_mut().filter(|held| held.sequence == sequence) {
                                let continues = charge.ammo > 0 && queue_index.zip(charge.queue.as_ref())
                                    .is_some_and(|(index, round)| held.advance(index, tick, round));
                                if !continues {
                                    peer.trigger = None;
                                }
                            }
                            let forwarded = alife_interests.as_mut().is_some_and(|host| {
                                let attacks: Vec<_> = shot.native_attacks(world, &charge).enumerate().map(|(index, attack)| {
                                    let receipt = (index == 0 && player_hit.is_none()).then_some(NativeReceipt {
                                        peer: id, sequence, followup_tick, ammo: charge.ammo, target: attack.target_id,
                                    });
                                    (attack, receipt)
                                }).collect();
                                host.queue_attacks(&attacks, world.tick) && player_hit.is_none()
                            });
                            if !forwarded {
                                let result = if multi { player_hit.unwrap_or_else(|| shot.volley_miss(charge.ammo)) }
                                    else { combat.resolve_owned_shot(world, shot, charge) };
                                shot_result(peer, metrics, sequence, followup_tick, result);
                            }
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
                    InventoryResponse::Impact(hit) => {
                        use zone_server::survival::ImpactOutcome;
                        match result {
                            // The worker rejected this before mutating anything.
                            Ok(value) if value["error"] == "expired session authority" => peer.impact_hits.push_front(hit),
                            Ok(value) => {
                                match serde_json::from_value::<ImpactOutcome>(value) {
                                    Ok(ImpactOutcome::Applied { revision, alive, impact, power_loss }) => {
                                        if peer.condition_revision.checked_add(1) == Some(revision) && hit.apply(world, impact, power_loss, !alive) {
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
                                    Ok(ImpactOutcome::Stale) => {}
                                    Err(error) => tracing::debug!(%error, "impact authority changed"),
                                }
                            }
                            Err(error) => tracing::warn!(%error, "impact transaction failed"),
                        }
                    }
                    InventoryResponse::Fields(pulses) => {
                        match result {
                            Ok(value) if value["error"] == "expired session authority" => {
                                // Preserve arrival order when refreshing a worker request.
                                let later = std::mem::take(&mut peer.field_hits);
                                if let Some(id) = peer.player {
                                    queue_fields(peer, world, id, &pulses);
                                    queue_fields(peer, world, id, &later);
                                }
                            }
                            Ok(value) => if let Ok(Some(outcome)) = serde_json::from_value::<Option<zone_server::environment::Outcome>>(value)
                                && peer.condition_revision.checked_add(1) == Some(outcome.commit.revision)
                                && let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id))
                                && let Some(condition) = &mut actor.condition
                            {
                                let [health, power, radiation, psy] = outcome.deltas;
                                condition.health = if outcome.commit.alive { (condition.health + health).clamp(0.0, 1.0) } else { 0.0 };
                                condition.power = (condition.power + power).clamp(0.0, 1.0);
                                condition.radiation = (condition.radiation + radiation).clamp(0.0, 1.0);
                                condition.psy_health = (condition.psy_health + psy).clamp(0.0, 1.0);
                                actor.health = condition.health_points();
                                if let Some(armour) = outcome.armour {
                                    actor.loadout.fields.armour.take_newer(armour);
                                    actor.armour_revision = actor.armour_revision.wrapping_add(1);
                                }
                                peer.condition_revision = outcome.commit.revision;
                                peer.disconnect_saved = false;
                                if !outcome.commit.alive {
                                    peer.inventory_dead = true;
                                    peer.trigger = None;
                                    peer.control(json!({"type":"inventory_dirty"}));
                                }
                            },
                            Err(error) => tracing::warn!(%error, "continuous field transaction failed"),
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
                            peer.primed_grenade = None;
                            peer.condition_revision = 0;
                            if let Some(store) = &runtime.store {
                                store.observe_loot_players(&session.contract.world, world);
                            }
                        }
                        if value["alive"]==false || death&&value["status"]=="committed" {
                            peer.inventory_dead=true;
                            if let Some(actor) = peer.player.and_then(|id| world.entities.get_mut(&id)) {
                                actor.health = 0;
                                if let Some(state) = &mut actor.condition { state.health = 0.0; }
                            }
                        }
                        if value["status"] == "selected" && value["slot"].is_u64()
                            && let Some(view) = peer.player.zip(peer.inventory_life)
                                .and_then(|(id, life)| player_vitals(world, id, life))
                        {
                            // The engine can act on the new slot as soon as
                            // it receives the selection result.
                            peer.control(json!({"type":"vitals","state":view}));
                            peer.vitals = Some(view);
                        }
                        if let Some(sequence)=sequence{peer.control(json!({"type":"action_result","sequence":sequence,"result":value}));}
                        if value["status"]=="committed"||sequence.is_none()||value["status"]=="selected"&&value["slot"]==4 {
                            peer.control(json!({"type":"inventory_dirty"}));
                        }
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
    while peer.impact_hits.front().is_some_and(|hit| !hit.is_current(world)) {
        peer.impact_hits.pop_front();
    }
    if let Some(hit) = peer.impact_hits.front().cloned() {
        if let (Ok(context), Some(location), Some(state)) = (
            inventory_context(peer, world, session, runtime), checkpoint_location(peer, world, session, actor), &actor.condition,
        ) {
            let impact = zone_server::survival::Impact {
                kind: hit.kind(), power: hit.power,
                before: zone_server::survival::Record { revision: peer.condition_revision, state: state.clone() },
                location,
                combat_lock_ms: if hit.is_pvp() { (world.combat_lock_ticks * 1000).div_ceil(TICK_HZ) } else { 0 },
            };
            let operation = zone_server::persistence::Operation::ResolveImpact(impact);
            if inventory_enqueue(peer, runtime, context, operation, InventoryResponse::Impact(hit)).is_ok() {
                peer.impact_hits.pop_front();
            }
        }
        return;
    }
    if actor.health == 0 { peer.field_hits.clear(); }
    if !peer.field_hits.is_empty() {
        if let (Ok(context), Some(location), Some(state)) = (
            inventory_context(peer, world, session, runtime), checkpoint_location(peer, world, session, actor), &actor.condition,
        ) {
            let pulses: Arc<[_]> = std::mem::take(&mut peer.field_hits).into();
            let exposure = zone_server::environment::Exposure {
                pulses: pulses.clone(),
                before: zone_server::survival::Record { revision: peer.condition_revision, state: state.clone() },
                location,
            };
            let operation = zone_server::persistence::Operation::ResolveFields(exposure);
            if inventory_enqueue(peer, runtime, context, operation, InventoryResponse::Fields(pulses.clone())).is_err() {
                peer.field_hits.extend_from_slice(&pulses);
            }
        }
        return;
    }
    if poll_reload(peer, world, session, runtime) || peer.queued_fire.is_some() { return; }
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
                        store.observe_loot_players(&session.contract.world, world);
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
                if world.entities.get(&player).is_some_and(|actor| actor.travelling) { continue; }
                if data.id == state_channel && data.binary {
                    if let Some((mut input, sample)) = protocol::decode_player_input(&data.data) {
                        // A valid state message remains a heartbeat after death.
                        peer.last_input = now;
                        if inventory.catalog.is_some() && (peer.inventory_life.is_none() || peer.inventory_dead){continue;}
                        input.aiming &= peer.reload.is_none();
                        if world.input(player, input) && let Some(sample) = sample {
                            if let Some(held) = peer.trigger.as_mut().filter(|held| held.sequence == sample.sequence) {
                                held.aim = sample.aim;
                                held.sampled_at = world.tick;
                            } else if let Some(swing) = peer.knife_swing.as_mut().filter(|swing| swing.command.sequence == sample.sequence) {
                                swing.latest_aim = Some(sample.aim);
                            }
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
                                | Control::Grenade(GrenadeControl { sequence, .. })
                                | Control::Knife(KnifeControl { sequence, .. })
                                | Control::TriggerStart(FireControl { sequence, .. })
                                | Control::TriggerStop { sequence }
                                | Control::UseTravel { sequence }
                                | Control::SelectWeapon { sequence, .. }
                                | Control::SelectDetector { sequence, .. }
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
                                Control::SelectDetector { sequence, life, active } => {
                                    let result = if world.entities.get(&player).is_some_and(|actor| actor.health > 0) {
                                        if active {
                                            peer.trigger = None;
                                            peer.primed_grenade = None;
                                        }
                                        inventory_submit(peer, world, session, inventory, Some(sequence),
                                            zone_server::persistence::Operation::SelectDetector { life, active }, false)
                                    } else { Err("dead actor".into()) };
                                    if let Err(reason) = result {
                                        peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));
                                    }
                                }
                                Control::SelectWeapon { sequence, life, slot } => {
                                    peer.trigger = None;
                                    peer.primed_grenade = None;
                                    if peer.inventory_pending.is_none() && peer.inventory_life == Some(life) {
                                        finish_reload(peer, json!({"status":"rejected","reason":"reload_cancelled"}), true);
                                    }
                                    let result = if world.entities.get(&player).is_some_and(|actor| actor.health > 0) {
                                        inventory_submit(peer, world, session, inventory, Some(sequence),
                                            zone_server::persistence::Operation::SelectWeapon { life, slot }, false)
                                    } else { Err("dead actor".into()) };
                                    if let Err(reason) = result {
                                        peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));
                                    }
                                }
                                Control::UseTravel { sequence } => {
                                    if inventory.travel.is_none() { reject_travel(peer, sequence, "no_interaction"); }
                                    else if peer.travel_use.is_some() { reject_travel(peer, sequence, "travel_busy"); }
                                    else { peer.travel_use = Some(sequence); }
                                }
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
                                    let result = inventory_context(peer, world, session, inventory).and_then(|context| {
                                        let detector = zone_server::inventory::DetectorScan {
                                            radar_zones: world.environment_fields.as_ref().and_then(|fields| fields.detector_zones()),
                                            hands_busy: peer.reload.is_some() || world.is_climbing(player) || world.is_aiming(player),
                                        };
                                        let operation = zone_server::persistence::Operation::WorldItems(after, context.clone(), detector);
                                        inventory_enqueue(peer, inventory, context, operation, InventoryResponse::Action { sequence: Some(sequence), death: false })
                                    });
                                    if let Err(reason)=result{peer.control(json!({"type":"action_result","sequence":sequence,"result":{"error":reason}}));}
                                }
                                Control::InventoryMove{sequence,command}=>{
                                    if matches!(command.action, zone_server::inventory::MoveAction::Pickup { .. }) {
                                        tracing::trace!(target: "zone_server::inventory",
                                            player, tick=world.tick, item=%command.item, sequence, "pickup intent received");
                                    }
                                    if peer.reload.is_some() {
                                        peer.control(json!({"type":"action_result","sequence":sequence,"result":{"status":"rejected","reason":"reloading"}}));
                                        continue;
                                    }
                                    peer.primed_grenade = None;
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
                                            if inventory.reload_timings.is_some() && matches!(command.action,
                                                zone_server::inventory::MoveAction::Reload | zone_server::inventory::MoveAction::NextAmmo)
                                            {
                                                if peer.inventory_busy() || actor.travelling {
                                                    return Err("inventory busy; retry the same request ID".into());
                                                }
                                                world.entities.get_mut(&player).unwrap().cancel_aim();
                                                peer.reload = Some(OwnedReload { sequence, root: command.request_id.clone(),
                                                    command, first_commit: None, plan: None, slot: 0, phase: ReloadPhase::Prepare,
                                                    until: Instant::now(), interrupted: false });
                                                return Ok(());
                                            }
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
                                            else if world.entities.get(&player).is_some_and(|actor| matches!(actor.loadout.active_weapon_slot, 4 | 6)) {
                                                if peer.primed_grenade.is_some() { Err("grenade_already_primed") }
                                                else if world.entities[&player].loadout.active_weapon_slot == 4 {
                                                    schedule_grenade(peer, world, combat, command,
                                                        zone_server::hand_grenade::Force::Quick,
                                                        world.tick.wrapping_add(zone_server::hand_grenade::READY_TICKS), "quick")
                                                }
                                                else { queue_throw(peer, world, combat, command, zone_server::hand_grenade::Force::Quick) }
                                            }
                                            else { submit_owned_shot(peer, world, combat, command, None) };
                                        if let Err(reason) = result {
                                            shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason });
                                        }
                                    } else {
                                        let result = combat.fire(world, player, command.aim);
                                        shot_result(peer, metrics, sequence, None, result);
                                    }
                                }
                                Control::Grenade(command) => grenade_control(peer, world, combat, command, metrics),
                                Control::Knife(command) => {
                                    let sequence = command.sequence;
                                    if let Err(reason) = start_knife(peer, world, combat, inventory.catalog.as_deref(), command) {
                                        shot_result(peer, metrics, sequence, None, zone_server::combat::ShotResult::Rejected { reason });
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
                                        submit_owned_shot(peer, world, combat, command, Some(0))
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
        let charge = ChargedShot { ammo: 0, range: 0.0, damage: 0, interval: 1, mass_spent: 0.1, power_loss: 0.0,
            queue: None, armour: None, target_commit: None, launcher: Some(LaunchSpec { section: "wpn_fake_missile2".into(),
                speed: 32.0, timed: false, fuse_ticks: 300, blast_power: 0.4, blast_radius: 4.0 }), native_damage: None };
        assert_eq!(combat.resolve_owned_shot(&mut world, trace, charge), ShotResult::Launched { ammo: 0 });
        let contact = (0..3).find_map(|_| combat.step_projectiles(&mut world).pop()).unwrap().hits.pop().unwrap();
        world.safe_zones.push(SafeZone::sphere(point, 1.0 ));
        assert!(world.is_protected(&world.entities[&target]));

        let mut peer = Peer::new(Instant::now(), None);
        peer.player = Some(target);
        peer.inventory_life = Some(0);
        peer.impact_hits.push_back(contact);
        peer.begin_logout(&mut world, 60);
        assert!(peer.inventory_busy());
        assert_eq!(peer.logout_until, None);
        let hit = peer.impact_hits.pop_front().unwrap();
        assert!(hit.apply(&mut world, ArmourImpact::Hit { power: 0.2, wound: true, gear_changed: true, field_armour: None }, 0.0, false));
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
            sessions: vec![Arc::new(SessionConfig::synthetic())],
            commands,
            token: None,
            persistence: None,
            origin: "http://127.0.0.1:8082".into(),
            travel: None,
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
