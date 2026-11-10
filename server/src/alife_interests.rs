//! Private player snapshots, creature state and hits for the A-Life host.
use crate::{
    alife_attacks::{NativeAttack, Receipt, ShotOutcome},
    combat::DamageContact,
    environment,
    world::{Kind, World},
};
#[cfg(unix)]
use crate::{
    alife_checkpoint::{self, Offer},
    ballistics::MAX_PENETRATION,
    persistence::Persistence,
    survival::ImpactKind,
    world::TICK_HZ,
};
use anyhow::{Context, Result, ensure};
use std::path::Path;
#[cfg(unix)]
use std::{
    collections::hash_map::RandomState,
    fs,
    hash::BuildHasher,
    os::unix::{
        fs::{FileTypeExt, MetadataExt, PermissionsExt},
        net::UnixDatagram,
    },
    path::PathBuf,
    sync::Arc,
};

pub const MAX_PLAYERS: usize = 512;
const HEADER: usize = 40;
const PLAYER: usize = 28;
const NATIVE_PLAYER: usize = 56;
pub const ENVIRONMENT_OPCODE: u8 = 35;
pub const LOOP_SOUND_OPCODE: u8 = 36;
const ENVIRONMENT_BYTES: usize = 152;
#[cfg(unix)]
const HIT: usize = 68;
#[cfg(unix)]
const ARMOURED_HIT: usize = HIT + 32;
#[cfg(unix)]
const MAX_PENDING_HITS: usize = 512;
#[cfg(unix)]
const EQUIPMENT_INTERVAL: u32 = TICK_HZ;
// Private equipment packet. Values 7 and 12 are native slot numbers.
pub(crate) const ARMOUR_BELT_START: u8 = 16;

pub enum NativeImpact {
    Physical(DamageContact),
    Field(u32, environment::Pulse),
}

#[cfg(unix)]
struct BoundSocket {
    path: PathBuf,
    identity: (u64, u64),
}

#[cfg(unix)]
impl BoundSocket {
    fn bind(
        path: &Path,
        suffix: &str,
        owner: u32,
        capacity: usize,
    ) -> Result<(UnixDatagram, Self)> {
        use std::os::unix::ffi::OsStrExt;
        let mut endpoint = path.as_os_str().to_owned();
        endpoint.push(suffix);
        let endpoint = PathBuf::from(endpoint);
        ensure!(
            endpoint.as_os_str().as_bytes().len() < 104,
            "A-Life socket path is too long"
        );
        let socket = UnixDatagram::bind(&endpoint)
            .with_context(|| format!("bind A-Life {suffix} receiver"))?;
        let file = fs::symlink_metadata(&endpoint)?;
        let bound = Self {
            path: endpoint,
            identity: (file.dev(), file.ino()),
        };
        ensure!(
            file.file_type().is_socket() && file.uid() == owner,
            "A-Life socket owner differs from its directory"
        );
        fs::set_permissions(&bound.path, fs::Permissions::from_mode(0o600))?;
        socket2::SockRef::from(&socket).set_recv_buffer_size(capacity)?;
        socket.set_nonblocking(true)?;
        Ok((socket, bound))
    }
}

#[cfg(unix)]
impl Drop for BoundSocket {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.path)
            .is_ok_and(|file| (file.dev(), file.ino()) == self.identity)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(unix)]
type PersistenceReply =
    tokio::sync::oneshot::Receiver<std::result::Result<serde_json::Value, String>>;

#[cfg(unix)]
#[derive(Default)]
struct WorldAdmission {
    round: u64,
    latest: Option<Offer>,
    admitted: Option<Offer>,
    pending: Option<(Offer, PersistenceReply)>,
    rejected: Option<Offer>,
}

#[cfg(unix)]
impl WorldAdmission {
    fn observe(&mut self, offer: Offer, store: Option<&Persistence>, world: &str) {
        self.latest = Some(offer);
        if self.admitted.is_some_and(|current| {
            current.boot != offer.boot
                || current.checkpoint.lineage != offer.checkpoint.lineage
                || current.checkpoint.generation > offer.checkpoint.generation
        }) {
            self.admitted = None;
        }
        if self.admitted != Some(offer)
            && self.rejected != Some(offer)
            && self.pending.is_none()
            && let Some(store) = store
            && let Ok(reply) = store.native_world_request(world.to_owned(), offer.checkpoint)
        {
            self.pending = Some((offer, reply));
        }
    }

    fn poll(&mut self, world: &str) -> Option<Offer> {
        let (offer, reply) = self.pending.as_mut()?;
        let offer = *offer;
        let accepted = match reply.try_recv() {
            Ok(Ok(value)) => value["accepted"].as_bool(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty) => return None,
            _ => None,
        };
        self.pending = None;
        if self.latest != Some(offer) {
            return None;
        }
        match accepted {
            Some(true) => {
                self.admitted = Some(offer);
                self.rejected = None;
                Some(offer)
            }
            Some(false) => {
                self.admitted = None;
                self.rejected = Some(offer);
                tracing::warn!(
                    world,
                    lineage = offer.checkpoint.lineage,
                    generation = offer.checkpoint.generation,
                    "native A-Life checkpoint rejected by the durable world fence"
                );
                None
            }
            None => None,
        }
    }
}

#[cfg(unix)]
fn boot_payload(bytes: &[u8], boot: u64) -> Option<&[u8]> {
    let (payload, suffix) = bytes.split_at_checked(bytes.len().checked_sub(8)?)?;
    (alife_checkpoint::wide(suffix) == boot).then_some(payload)
}

pub struct AlifeInterests {
    level: String,
    epoch: u64,
    #[cfg(unix)]
    world: String,
    #[cfg(unix)]
    target: PathBuf,
    #[cfg(unix)]
    socket: UnixDatagram,
    #[cfg(unix)]
    _bound: BoundSocket,
    #[cfg(unix)]
    npc_socket: UnixDatagram,
    #[cfg(unix)]
    condition_socket: UnixDatagram,
    #[cfg(unix)]
    weapon_socket: UnixDatagram,
    #[cfg(unix)]
    _weapon_bound: BoundSocket,
    #[cfg(unix)]
    condition_sequence: u64,
    #[cfg(unix)]
    condition_baselines: std::collections::BTreeMap<u32, (crate::native_condition::Fence, crate::native_condition::Checkpoint)>,
    #[cfg(unix)]
    condition_pending: std::collections::BTreeMap<u32, crate::native_condition::Request>,
    #[cfg(unix)]
    condition_actions: std::collections::BTreeMap<u32, crate::native_condition::Request>,
    #[cfg(unix)]
    condition_results: std::collections::BTreeMap<u32, (crate::native_condition::Fence, crate::native_condition::ResultState)>,
    #[cfg(unix)]
    _condition_bound: BoundSocket,
    #[cfg(unix)]
    equipment_pending: Option<(u64, PersistenceReply)>,
    #[cfg(unix)]
    weapon_rules: std::collections::BTreeMap<u32, (u64, u32, u32, crate::alife_weapon::NativeWeaponRules)>,
    #[cfg(unix)]
    _npc_bound: BoundSocket,
    #[cfg(unix)]
    npcs: crate::alife_npcs::NpcRoster,
    #[cfg(unix)]
    sounds: std::collections::VecDeque<crate::alife_npcs::NativeSound>,
    #[cfg(unix)]
    sound_loops: std::collections::BTreeMap<u32, crate::alife_npcs::NativeSound>,
    #[cfg(unix)]
    environment: Option<(u64, EnvironmentSample)>,
    #[cfg(unix)]
    attacks: crate::alife_attacks::AttackQueue,
    #[cfg(unix)]
    corpse_pending: std::collections::BTreeMap<crate::alife_corpse::DeathId, PersistenceReply>,
    #[cfg(unix)]
    admission: WorldAdmission,
    #[cfg(unix)]
    impact_slots: Arc<()>,
    #[cfg(unix)]
    hit_delivery: (u64, u64, Option<(u64, u32, u32, NativeImpact)>),
    frame: Vec<u8>,
}

impl AlifeInterests {
    pub fn new(path: &Path, world: &str) -> Result<Self> {
        let level =
            crate::session::campaign_level(world).context("A-Life requires a campaign level")?;
        ensure!(
            path.is_absolute(),
            "A-Life interest socket path must be absolute"
        );
        #[cfg(unix)]
        {
            let parent = fs::metadata(
                path.parent()
                    .context("A-Life socket needs a private directory")?,
            )?;
            ensure!(
                parent.is_dir() && parent.mode() & 0o077 == 0,
                "A-Life socket needs a private directory"
            );
            let (socket, bound) = BoundSocket::bind(path, ".hits", parent.uid(), 64 * 1024)?;
            let (npc_socket, npc_bound) =
                BoundSocket::bind(path, ".npcs", parent.uid(), 256 * 1024)?;
            let (condition_socket, condition_bound) =
                BoundSocket::bind(path, ".hits.condition", parent.uid(), 256 * 1024)?;
            let (weapon_socket, weapon_bound) =
                BoundSocket::bind(path, ".hits.weapon", parent.uid(), 256 * 1024)?;
            // Darwin's default 2 KiB send limit is smaller than a 200-player frame.
            socket2::SockRef::from(&socket).set_send_buffer_size(32 * 1024)?;
            Ok(Self {
                level: level.into(),
                world: world.into(),
                // Private stream identity. A restarted server can reuse runtime IDs.
                epoch: RandomState::new().hash_one(()).max(1),
                target: path.to_owned(),
                socket,
                _bound: bound,
                npc_socket,
                condition_socket,
                weapon_socket,
                _weapon_bound: weapon_bound,
                condition_sequence: 0,
                condition_baselines: Default::default(),
                condition_pending: Default::default(),
                condition_actions: Default::default(),
                condition_results: Default::default(),
                _condition_bound: condition_bound,
                equipment_pending: None,
                weapon_rules: Default::default(),
                _npc_bound: npc_bound,
                npcs: Default::default(),
                sounds: Default::default(),
                sound_loops: Default::default(),
                environment: None,
                attacks: Default::default(),
                corpse_pending: Default::default(),
                admission: Default::default(),
                impact_slots: Arc::new(()),
                hit_delivery: (0, 0, None),
                frame: Vec::with_capacity(HEADER + MAX_PLAYERS * NATIVE_PLAYER),
            })
        }
        #[cfg(not(unix))]
        anyhow::bail!("native A-Life requires Unix sockets for level {level}");
    }

    /// Identity of the admitted native condition producer. A new boot invalidates pending work.
    pub fn condition_host(&self) -> Option<(u64, u64)> {
        #[cfg(unix)]
        { self.admission.admitted.map(|host| (self.epoch, host.boot)) }
        #[cfg(not(unix))]
        { None }
    }

    /// Allocate every baseline and simulation request from the same host-stream sequence.
    pub fn prepare_condition(&mut self, player: u32, incarnation: u32, revision: u64,
        equipment: u64, seconds: f32, weight: f32, state: Option<&crate::native_condition::Checkpoint>)
        -> Option<crate::native_condition::Request>
    {
        #[cfg(unix)]
        {
            let (epoch, boot) = self.condition_host()?;
            let sequence = self.condition_sequence.checked_add(1)?;
            let fence = crate::native_condition::Fence { epoch, boot, player, incarnation, revision, sequence, equipment };
            let request = crate::native_condition::Request::new(fence, seconds, weight, state)?;
            self.condition_sequence = sequence;
            Some(request)
        }
        #[cfg(not(unix))]
        { let _ = (player, incarnation, revision, equipment, seconds, weight, state); None }
    }

    pub fn prepare_condition_import(&mut self, player: u32, incarnation: u32, revision: u64,
        equipment: u64, weight: f32, state: &crate::native_condition::Import)
        -> Option<crate::native_condition::Request>
    {
        #[cfg(unix)]
        {
            let (epoch, boot) = self.condition_host()?;
            let sequence = self.condition_sequence.checked_add(1)?;
            let fence = crate::native_condition::Fence { epoch, boot, player, incarnation, revision, sequence, equipment };
            let request = crate::native_condition::Request::import(fence, weight, state)?;
            self.condition_sequence = sequence;
            Some(request)
        }
        #[cfg(not(unix))]
        { let _ = (player, incarnation, revision, equipment, weight, state); None }
    }

    pub fn prepare_condition_hit(&mut self, player:u32, incarnation:u32, revision:u64,
        equipment:u64, weight:f32, state:&crate::native_condition::Checkpoint, hit:crate::native_condition::Hit<'_>)
        -> Option<crate::native_condition::Request> {
        #[cfg(unix)]
        {
            let (epoch,boot)=self.condition_host()?;
            let sequence=self.condition_sequence.checked_add(1)?;
            let fence=crate::native_condition::Fence{epoch,boot,player,incarnation,revision,sequence,equipment};
            let request=crate::native_condition::Request::hit(fence,weight,state,hit)?;
            self.condition_sequence=sequence;
            Some(request)
        }
        #[cfg(not(unix))]
        {let _=(player,incarnation,revision,equipment,weight,state,hit);None}
    }

    pub fn prepare_condition_consume(&mut self, player:u32, incarnation:u32, revision:u64,
        equipment:u64, weight:f32, state:&crate::native_condition::Checkpoint, section:&str)
        -> Option<crate::native_condition::Request> {
        #[cfg(unix)]
        {
            let (epoch,boot)=self.condition_host()?;
            let sequence=self.condition_sequence.checked_add(1)?;
            let fence=crate::native_condition::Fence{epoch,boot,player,incarnation,revision,sequence,equipment};
            let request=crate::native_condition::Request::consume(fence,weight,state,section)?;
            self.condition_sequence=sequence; Some(request)
        }
        #[cfg(not(unix))]
        {let _=(player,incarnation,revision,equipment,weight,state,section);None}
    }

    pub fn prepare_condition_fields(&mut self, player:u32, incarnation:u32, revision:u64,
        equipment:u64, weight:f32, state:&crate::native_condition::Checkpoint, pulses:&[crate::environment::Pulse])
        -> Option<crate::native_condition::Request> {
        #[cfg(unix)]
        {
            let (epoch,boot)=self.condition_host()?;
            let sequence=self.condition_sequence.checked_add(1)?;
            let fence=crate::native_condition::Fence{epoch,boot,player,incarnation,revision,sequence,equipment};
            let request=crate::native_condition::Request::fields(fence,weight,state,pulses)?;
            self.condition_sequence=sequence; Some(request)
        }
        #[cfg(not(unix))]
        {let _=(player,incarnation,revision,equipment,weight,state,pulses);None}
    }

    pub fn prepare_condition_batch(&mut self, player:u32, incarnation:u32, revision:u64,
        equipment:u64, weight:f32, state:&crate::native_condition::Checkpoint, hits:&[crate::native_condition::Hit<'_>])
        -> Option<crate::native_condition::Request> {
        #[cfg(unix)]
        {
            let (epoch,boot)=self.condition_host()?;
            let sequence=self.condition_sequence.checked_add(1)?;
            let fence=crate::native_condition::Fence{epoch,boot,player,incarnation,revision,sequence,equipment};
            let request=crate::native_condition::Request::batch(fence,weight,state,hits)?;
            self.condition_sequence=sequence; Some(request)
        }
        #[cfg(not(unix))]
        {let _=(player,incarnation,revision,equipment,weight,state,hits);None}
    }

    /// One outstanding action per actor. Baseline requests must finish first:
    /// otherwise a later sequence could make the earlier action unrepeatable.
    pub fn queue_condition(&mut self, request: crate::native_condition::Request) -> bool {
        #[cfg(unix)]
        {
            let player = request.fence.player;
            if self.condition_host() != Some((request.fence.epoch, request.fence.boot))
                || self.condition_pending.contains_key(&player)
                || self.condition_actions.contains_key(&player)
                || self.condition_results.contains_key(&player)
                || self.condition_actions.len() >= MAX_PLAYERS { return false; }
            self.send_condition(&request);
            self.condition_actions.insert(player, request);
            true
        }
        #[cfg(not(unix))]
        { let _ = request; false }
    }

    /// Cancel only this exact request when a concurrent mutation supersedes it.
    pub fn cancel_condition(&mut self, fence: crate::native_condition::Fence) {
        #[cfg(unix)]
        {
            if self.condition_actions.get(&fence.player).is_some_and(|r| r.fence == fence) {
                self.condition_actions.remove(&fence.player);
            }
            if self.condition_results.get(&fence.player).is_some_and(|(f,_)| *f == fence) {
                self.condition_results.remove(&fence.player);
            }
        }
        #[cfg(not(unix))]
        let _ = fence;
    }

    /// The peer still must compare revision/equipment before submitting to SQLite.
    pub fn take_condition_result(&mut self, player: u32)
        -> Option<(crate::native_condition::Fence, crate::native_condition::ResultState)> {
        #[cfg(unix)]
        {
            let (fence, checkpoint) = self.condition_results.remove(&player)?;
            (self.condition_host() == Some((fence.epoch, fence.boot))).then_some((fence, checkpoint))
        }
        #[cfg(not(unix))]
        { let _ = player; None }
    }

    pub fn send_weapon_action(&self, request: crate::native_weapon_action::Request) -> bool {
        if self.condition_host() != Some((request.fence.epoch, request.fence.boot)) { return false; }
        let Some(bytes) = request.encode() else { return false; };
        #[cfg(unix)]
        { self.socket.send_to(&bytes, &self.target).is_ok_and(|n| n == bytes.len()) }
        #[cfg(not(unix))]
        { let _ = bytes; false }
    }

    /// Transport authenticates the host. The coordinator must additionally match
    /// player life, action sequence, item revision and inventory generation.
    pub fn drain_weapon_actions(&self, mut accept: impl FnMut(crate::native_weapon_action::Reply)) {
        #[cfg(unix)]
        {
            let Some((epoch,boot)) = self.condition_host() else { return; };
            let mut bytes = vec![0u8; 65537]; // spare byte rejects truncated oversized datagrams
            for _ in 0..MAX_PLAYERS {
                let Ok((size,sender)) = self.weapon_socket.recv_from(&mut bytes) else { break; };
                if sender.as_pathname() != Some(self.target.as_path()) { continue; }
                let Some(reply) = crate::native_weapon_action::Reply::decode(&bytes[..size]) else { continue; };
                if (reply.fence.epoch,reply.fence.boot) != (epoch,boot) { continue; }
                accept(reply);
            }
        }
        #[cfg(not(unix))]
        let _ = &mut accept;
    }

    pub fn send_condition(&self, request: &crate::native_condition::Request) -> bool {
        if self.condition_host() != Some((request.fence.epoch, request.fence.boot)) { return false; }
        #[cfg(unix)]
        { self.socket.send_to(request.bytes(), &self.target).is_ok_and(|n| n == request.bytes().len()) }
        #[cfg(not(unix))]
        { false }
    }

    /// Caller must match each reply against its pending Request and current revision.
    pub fn drain_conditions(&self, mut accept: impl FnMut(&[u8])) {
        #[cfg(unix)]
        {
            let Some((epoch, boot)) = self.condition_host() else { return; };
            let mut bytes = [0u8; 60 + 8 + crate::native_condition::MAX_CHECKPOINT + 1];
            for _ in 0..MAX_PLAYERS {
                let Ok((size, sender)) = self.condition_socket.recv_from(&mut bytes) else { break; };
                if sender.as_pathname() != Some(self.target.as_path()) || !(61..bytes.len()).contains(&size)
                    || (&bytes[..4] != b"ZCU1" && &bytes[..4] != b"ZCV1")
                    || alife_checkpoint::wide(&bytes[4..12]) != epoch
                    || alife_checkpoint::wide(&bytes[12..20]) != boot { continue; }
                accept(&bytes[..size]);
            }
        }
        #[cfg(not(unix))]
        let _ = &mut accept;
    }

    /// Engine baseline is a template, not the player's saved condition.
    pub fn condition_baseline(&self, player: u32, incarnation: u32, equipment: u64)
        -> Option<&crate::native_condition::Checkpoint>
    {
        #[cfg(unix)]
        {
            let (fence, state) = self.condition_baselines.get(&player)?;
            (self.condition_host() == Some((fence.epoch, fence.boot))
                && fence.incarnation == incarnation && fence.equipment == equipment).then_some(state)
        }
        #[cfg(not(unix))]
        { let _ = (player, incarnation, equipment); None }
    }

    #[cfg(unix)]
    fn request_condition_baseline(&mut self, player: u32, incarnation: u32, equipment: u64) {
        let Some((epoch, boot)) = self.condition_host() else { return; };
        if self.condition_actions.contains_key(&player) || self.condition_results.contains_key(&player) { return; }
        let matches = |f: &crate::native_condition::Fence| {
            (f.epoch, f.boot, f.incarnation, f.equipment) == (epoch, boot, incarnation, equipment)
        };
        if self.condition_baselines.get(&player).is_some_and(|(f,_)| matches(f))
            || self.condition_pending.get(&player).is_some_and(|r| matches(&r.fence)) { return; }
        self.condition_baselines.remove(&player);
        if self.condition_pending.len() >= MAX_PLAYERS && !self.condition_pending.contains_key(&player) { return; }
        if let Some(request) = self.prepare_condition(player, incarnation, 0, equipment, 0.0, 0.0, None) {
            self.send_condition(&request);
            self.condition_pending.insert(player, request);
        }
    }

    #[cfg(unix)]
    fn poll_condition_baselines(&mut self, world: &World) {
        let host = self.condition_host();
        let current = |f: &crate::native_condition::Fence| host == Some((f.epoch,f.boot))
            && world.native_player_movement && world.entities.get(&f.player).is_some_and(|actor|
                actor.incarnation == f.incarnation && actor.health > 0 && !actor.travelling);
        self.condition_baselines.retain(|_,(f,_)| current(f));
        self.condition_pending.retain(|_,r| current(&r.fence));
        self.condition_actions.retain(|_,r| current(&r.fence));
        self.condition_results.retain(|_,(f,_)| current(f));
        let mut completed = Vec::new();
        let mut actions = Vec::new();
        self.drain_conditions(|packet| {
            let player = u32::from_le_bytes(packet[20..24].try_into().unwrap());
            if let Some(request) = self.condition_pending.get(&player)
                && let Some(checkpoint) = request.accept(packet, request.fence) {
                completed.push((player, request.fence, checkpoint));
            } else if let Some(request) = self.condition_actions.get(&player)
                && let Some(checkpoint) = request.accept_result(packet, request.fence) {
                actions.push((player, request.fence, checkpoint));
            }
        });
        for (player, fence, checkpoint) in completed {
            self.condition_pending.remove(&player);
            self.condition_baselines.insert(player, (fence, checkpoint));
            tracing::debug!(player, boot=fence.boot, equipment=fence.equipment, "native actor condition baseline received");
        }
        for (player, fence, checkpoint) in actions {
            self.condition_actions.remove(&player);
            self.condition_results.insert(player, (fence, checkpoint));
        }
        if world.tick.is_multiple_of(TICK_HZ / 5) {
            for request in self.condition_pending.values().chain(self.condition_actions.values()) { self.send_condition(request); }
        }
    }

    pub fn publish(&mut self, world: &World) {
        // Keep the simulation free of filesystem IO and backpressure. A missed
        // datagram is repaired by the next complete pose snapshot.
        #[cfg(unix)]
        {
            if self.admission.round == 0 || world.tick.is_multiple_of(TICK_HZ) {
                self.admission.round = self.admission.round.wrapping_add(1).max(1);
                let challenge = alife_checkpoint::challenge(self.epoch, self.admission.round);
                let _ = self.socket.send_to(&challenge, &self.target);
            }
            if self.admission.admitted.is_none() {
                return;
            }
        }
        self.frame.clear();
        if !encode(&mut self.frame, &self.level, self.epoch, world) {
            return;
        }
        #[cfg(unix)]
        let _ = self.socket.send_to(&self.frame, &self.target);
    }

    pub fn refresh_npcs(
        &mut self,
        world: &mut World,
        store: Option<&crate::persistence::Persistence>,
        mut result: impl FnMut(ShotOutcome),
    ) {
        #[cfg(unix)]
        {
            self.refresh_equipment(world, store);
            self.poll_condition_baselines(world);
            let socket = &self.socket;
            let target = &self.target;
            let epoch = self.epoch;
            if let Some(offer) = self.admission.poll(&self.world) {
                let _ = socket.send_to(&offer.approval(epoch), target);
            }
            self.corpse_pending
                .retain(|id, reply| match reply.try_recv() {
                    Ok(Ok(value))
                        if value["status"] == "committed" && self.admission.admitted.is_some() =>
                    {
                        let mut ack = [0u8; 28];
                        ack[..4].copy_from_slice(b"ZAC1");
                        ack[4..12].copy_from_slice(&epoch.to_le_bytes());
                        ack[12..20].copy_from_slice(&id.host.to_le_bytes());
                        ack[20..].copy_from_slice(&id.serial.to_le_bytes());
                        let _ = socket.send_to(&ack, target);
                        false
                    }
                    Err(tokio::sync::oneshot::error::TryRecvError::Empty) => true,
                    _ => false,
                });
            let mut bytes = [0; crate::alife_corpse::MAX_PACKET + 8 + 1];
            for _ in 0..128 {
                let Ok((size, sender)) = self.npc_socket.recv_from(&mut bytes) else {
                    break;
                };
                if sender.as_pathname() == Some(target.as_path()) {
                    let packet = &bytes[..size];
                    if let Some(offer) =
                        Offer::decode(packet, epoch, self.admission.round, &self.level)
                    {
                        self.admission.observe(offer, store, &self.world);
                        if self.admission.admitted == Some(offer) {
                            let _ = socket.send_to(&offer.approval(epoch), target);
                        }
                        continue;
                    }
                    let Some(active) = self.admission.admitted else {
                        continue;
                    };
                    if packet.starts_with(b"ZAA1") {
                        if packet.get(12..20).map(alife_checkpoint::wide) != Some(active.boot) {
                            continue;
                        }
                        if let Some(ack) = self.attacks.acknowledge(&bytes[..size], self.epoch) {
                            if ack.health == Some(0) {
                                self.npcs.confirm_death(
                                    ack.attack.target,
                                    ack.attack.target_id,
                                    world,
                                );
                            }
                            if let Some(outcome) = ack.outcome {
                                result(outcome);
                            }
                        }
                    } else if packet.starts_with(b"ZAL1") {
                        if self.corpse_pending.len() < 32
                            && let Some(store) = store
                            && let Some(body) = boot_payload(packet, active.boot)
                            && let Some(mut corpse) =
                                crate::alife_corpse::decode(body, epoch, &self.world)
                            && let std::collections::btree_map::Entry::Vacant(slot) =
                                self.corpse_pending.entry(corpse.id)
                        {
                            corpse.align_with_floor(world);
                            if let Ok(reply) =
                                store.native_corpse_request(corpse, active.checkpoint)
                            {
                                slot.insert(reply);
                            }
                        }
                    } else if packet.starts_with(b"ZAE1") {
                        if let Some(frame) = decode_environment(packet, epoch, active.boot, world.tick)
                            && self.environment.as_ref().is_none_or(|(boot, previous)|
                                *boot != active.boot || crate::world::newer(frame.tick(), previous.tick()))
                        {
                            self.environment = Some((active.boot, frame));
                        }
                    } else if packet.len() > 24 && matches!(&packet[..4], b"ZAP1" | b"ZAU1" | b"ZAV1")
                        && alife_checkpoint::wide(&packet[8..16]) == epoch
                        && alife_checkpoint::wide(&packet[16..24]) == active.boot
                    {
                        let tick = u32::from_le_bytes(packet[4..8].try_into().unwrap());
                        if world.tick.wrapping_sub(tick) > 12 { continue; }
                        if packet.starts_with(b"ZAP1") {
                            self.npcs.ingest_poses(&packet[24..], active.boot, tick);
                        } else if packet.starts_with(b"ZAV1") {
                            for sound in crate::alife_npcs::native_sounds(&packet[24..], active.boot, tick) {
                                if sound.sequence == 0 { continue; }
                                if let Some(previous) = self.sound_loops.get_mut(&sound.sequence) {
                                    if previous.host != sound.host || crate::world::newer(sound.tick, previous.tick) {
                                        *previous = sound;
                                    }
                                } else if self.sound_loops.len() < 128 {
                                    self.sound_loops.insert(sound.sequence, sound);
                                }
                            }
                        } else {
                            self.sounds.extend(crate::alife_npcs::native_sounds(&packet[24..], active.boot, tick));
                            while self.sounds.len() > 128 { self.sounds.pop_front(); }
                        }
                    } else if world.native_player_movement && packet.starts_with(b"ZAM1")
                        && packet.get(16..24).map(alife_checkpoint::wide) == Some(active.boot)
                    {
                        ingest_movement(packet, epoch, world);
                    } else if world.native_player_movement && packet.starts_with(b"ZAB1")
                        && packet.get(16..24).map(alife_checkpoint::wide) == Some(active.boot)
                    {
                        ingest_hitboxes(packet, epoch, world);
                    } else if world.native_player_movement && packet.starts_with(b"ZBN1") {
                        self.npcs.ingest_hitboxes(packet, epoch, active.boot, world);
                    } else if world.native_player_movement && packet.starts_with(b"ZAF5") {
                        if let Some((id, life, tick, rules)) =
                            crate::alife_weapon::decode_weapon_rules(packet, epoch, active.boot, world.tick)
                            && weapon_rules_match(world, id, life, &rules)
                            && self.weapon_rules.get(&id).is_none_or(|(boot, previous_life, previous_tick, _)|
                                *boot != active.boot || *previous_life != life || crate::world::newer(tick, *previous_tick))
                        {
                            self.weapon_rules.insert(id, (active.boot, life, tick, rules));
                        }
                    } else if packet.starts_with(b"ZAN2")
                        && packet.get(16..24).map(alife_checkpoint::wide) == Some(active.boot)
                    {
                        self.npcs.ingest(packet, epoch, world);
                    }
                }
            }
            self.npcs.expire(world);
            self.weapon_rules.retain(|&id, (boot, life, tick, rules)| {
                self.admission.admitted.is_some_and(|active| active.boot == *boot)
                    && world.tick.wrapping_sub(*tick) <= 2 * TICK_HZ
                    && weapon_rules_match(world, id, *life, rules)
            });
            self.sounds.retain(|sound| self.admission.admitted.is_some_and(|active| active.boot == sound.host)
                && world.tick.wrapping_sub(sound.tick) <= 9);
            self.sound_loops.retain(|_, sound| self.admission.admitted.is_some_and(|active| active.boot == sound.host)
                && world.tick.wrapping_sub(sound.tick) <= 12);
        }
        #[cfg(not(unix))]
        let _ = (world, store, &mut result);
    }

    #[cfg(unix)]
    fn refresh_equipment(&mut self, world: &World, store: Option<&Persistence>) {
        let Some(active) = self.admission.admitted.filter(|_| world.native_player_movement) else {
            self.equipment_pending = None;
            return;
        };
        if let Some((boot, reply)) = &mut self.equipment_pending {
            match reply.try_recv() {
                Ok(Ok(value)) if *boot == active.boot => {
                    let mut packet = Vec::new();
                    let snapshots = serde_json::from_value::<Vec<EquipmentSnapshot>>(value).unwrap_or_default();
                    for (id, incarnation, generation, items, weapon) in snapshots {
                        if !world.entities.get(&id).is_some_and(|actor| {
                            actor.incarnation == incarnation && actor.health > 0 && !actor.travelling
                        }) {
                            continue;
                        }
                        if encode_armour(&mut packet, self.epoch, active.boot, id, incarnation, generation, &items) {
                            let _ = self.socket.send_to(&packet, &self.target);
                        }
                        if crate::alife_weapon::encode(&mut packet, self.epoch, active.boot, id, incarnation, weapon.as_ref()) {
                            let _ = self.socket.send_to(&packet, &self.target);
                        }
                        self.request_condition_baseline(id, incarnation, generation);
                    }
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) if *boot == active.boot => return,
                _ => {}
            }
            self.equipment_pending = None;
        }
        let Some(store) = store else { return };
        // Spread read and socket work across ticks. A missed packet is repaired
        // by the next complete snapshot for this actor.
        let players: Vec<_> = world.entities.values().filter_map(|actor| {
            if actor.kind != Kind::Player || actor.health == 0 || actor.travelling ||
                actor.id % EQUIPMENT_INTERVAL != world.tick % EQUIPMENT_INTERVAL {
                return None;
            }
            Some((actor.id, actor.incarnation, actor.character_key.clone()?))
        }).collect();
        if !players.is_empty() && let Ok(reply) = store.native_equipment_request(players) {
            self.equipment_pending = Some((active.boot, reply));
        }
    }

    pub fn npc_pose<'a>(&'a self, npc: &crate::alife_npcs::NativeNpc) -> Option<(u32, &'a [u8])> {
        #[cfg(unix)]
        { self.npcs.pose(npc) }
        #[cfg(not(unix))]
        { let _ = npc; None }
    }

    pub fn weapon_rules(&self, world: &World, id: u32) -> Option<crate::combat::NativeWeaponRules> {
        #[cfg(unix)]
        {
            let (boot, life, tick, rules) = self.weapon_rules.get(&id)?;
            (world.native_player_movement && self.admission.admitted.is_some_and(|active| active.boot == *boot)
                && world.tick.wrapping_sub(*tick) <= 2 * TICK_HZ
                && weapon_rules_match(world, id, *life, rules)).then(|| rules.clone())
        }
        #[cfg(not(unix))]
        { let _ = (world, id); None }
    }

    pub fn environment(&self, tick: u32) -> Option<&[u8]> {
        #[cfg(unix)]
        { self.environment_sample(tick).map(|sample| sample.frame.as_slice()) }
        #[cfg(not(unix))]
        { let _ = tick; None }
    }

    pub fn sound_loops(&self) -> impl Iterator<Item = &crate::alife_npcs::NativeSound> {
        #[cfg(unix)]
        { self.sound_loops.values() }
        #[cfg(not(unix))]
        { std::iter::empty() }
    }

    #[cfg(unix)]
    fn environment_sample(&self, tick: u32) -> Option<&EnvironmentSample> {
        let (boot, sample) = self.environment.as_ref()?;
        (self.admission.admitted.is_some_and(|active| active.boot == *boot)
            && tick.wrapping_sub(sample.tick()) <= 2 * TICK_HZ)
            .then_some(sample)
    }

    pub fn campaign_clock(&self, tick: u32) -> Option<(u64, f32)> {
        #[cfg(unix)]
        {
            let sample = self.environment_sample(tick)?;
            let factor = f32::from_le_bytes(sample.frame[8..12].try_into().unwrap());
            let elapsed = f64::from(tick.wrapping_sub(sample.tick())) * 1000.0 / f64::from(TICK_HZ);
            Some((sample.milliseconds() + (elapsed * f64::from(factor)).round() as u64, factor))
        }
        #[cfg(not(unix))]
        { let _ = tick; None }
    }

    pub fn publish_campaign_clock(&self, milliseconds: u64, factor: f32) {
        #[cfg(unix)]
        if let Some(active) = self.admission.admitted {
            let mut packet = [0; 32];
            packet[..4].copy_from_slice(b"ZAT1");
            packet[4..12].copy_from_slice(&self.epoch.to_le_bytes());
            packet[12..20].copy_from_slice(&active.boot.to_le_bytes());
            packet[20..28].copy_from_slice(&milliseconds.to_le_bytes());
            packet[28..].copy_from_slice(&factor.to_le_bytes());
            let _ = self.socket.send_to(&packet, &self.target);
        }
        #[cfg(not(unix))]
        let _ = (milliseconds, factor);
    }

    pub fn sounds(&self) -> impl Iterator<Item = &crate::alife_npcs::NativeSound> {
        #[cfg(unix)]
        { self.sounds.iter() }
        #[cfg(not(unix))]
        { std::iter::empty() }
    }

    pub fn queue_attack(
        &mut self,
        attack: NativeAttack,
        tick: u32,
    ) -> bool {
        self.queue_attacks(&[attack], tick, None)
    }

    pub fn queue_attacks(&mut self, attacks: &[NativeAttack], tick: u32, receipt: Option<Receipt>) -> bool {
        #[cfg(unix)]
        {
            self.admission
                .admitted
                .is_some_and(|active| attacks.iter().all(|attack| active.boot == attack.target.host))
                && self.attacks.enqueue_batch(attacks, tick, receipt)
        }
        #[cfg(not(unix))]
        {
            let _ = (attacks, tick, receipt);
            false
        }
    }

    pub fn flush_attacks(&mut self, world: &World, mut expired: impl FnMut(ShotOutcome)) {
        #[cfg(unix)]
        self.attacks.poll(
            world,
            self.epoch,
            |bytes| {
                self.admission.admitted.is_some_and(|active| {
                    alife_checkpoint::wide(&bytes[16..24]) == active.boot
                        && self.socket.send_to(bytes, &self.target).is_ok()
                })
            },
            &mut expired,
        );
        #[cfg(not(unix))]
        let _ = (world, &mut expired);
    }

    pub fn drain_impacts(&mut self, world: &World, mut accept: impl FnMut(NativeImpact) -> Result<(),NativeImpact>) {
        #[cfg(unix)]
        {
            let Some(active)=self.admission.admitted else {return;};
            if self.hit_delivery.0!=active.boot {self.hit_delivery=(active.boot,0,None);}
            for _ in 0..256 {
                if let Some((sequence,id,incarnation,hit))=self.hit_delivery.2.take() {
                    if !world.entities.get(&id).is_some_and(|actor|actor.incarnation==incarnation && actor.health>0 && !actor.travelling) {
                        self.hit_delivery.1=sequence;
                        continue;
                    }
                    match accept(hit) {
                        Ok(())=>self.hit_delivery.1=sequence,
                        Err(hit)=>{self.hit_delivery.2=Some((sequence,id,incarnation,hit));break;}
                    }
                }
                if Arc::strong_count(&self.impact_slots)>MAX_PENDING_HITS {break;}
                let mut bytes=[0u8;ARMOURED_HIT+16+1];
                let Ok((size,sender))=self.socket.recv_from(&mut bytes) else {break;};
                if sender.as_pathname()!=Some(self.target.as_path()) {continue;}
                let Some(body)=boot_payload(&bytes[..size],active.boot) else {continue;};
                let old_size=match (body.len(),body.get(..4)) {
                    (n,Some(b"ZAH2")) if n==HIT+8=>HIT,
                    (n,Some(b"ZAH5")) if n==ARMOURED_HIT+8=>ARMOURED_HIT,
                    _=>continue,
                };
                let sequence=alife_checkpoint::wide(&body[old_size..]);
                if sequence==0 || sequence<=self.hit_delivery.1 {continue;}
                // Decode the existing payload with its sequence footer removed.
                let mut payload=body[..old_size].to_vec();
                payload[..4].copy_from_slice(if old_size==HIT {b"ZAH1"} else {b"ZAH4"});
                if let Some(hit)=decode_hit(&payload,self.epoch,world,&self.impact_slots) {
                    self.hit_delivery.2=Some((sequence,u32::from_le_bytes(payload[16..20].try_into().unwrap()),
                        u32::from_le_bytes(payload[20..24].try_into().unwrap()),hit));
                } else {
                    // Invalid/lifetime-obsolete hits must not pin later traffic.
                    self.hit_delivery.1=sequence;
                }
            }
            if self.hit_delivery.1!=0 {
                let mut ack=Vec::with_capacity(28);ack.extend_from_slice(b"ZHA1");
                ack.extend_from_slice(&self.epoch.to_le_bytes());
                ack.extend_from_slice(&active.boot.to_le_bytes());
                ack.extend_from_slice(&self.hit_delivery.1.to_le_bytes());
                let _=self.socket.send_to(&ack,&self.target);
            }
        }
        #[cfg(not(unix))]
        let _=(&world,&mut accept);
    }

}

#[cfg(unix)]
struct EnvironmentSample {
    frame: [u8; ENVIRONMENT_BYTES],
}

#[cfg(unix)]
impl EnvironmentSample {
    fn tick(&self) -> u32 { u32::from_le_bytes(self.frame[..4].try_into().unwrap()) }
    fn milliseconds(&self) -> u64 { alife_checkpoint::wide(&self.frame[144..]) }
}

#[cfg(unix)]
fn decode_environment(packet: &[u8], epoch: u64, boot: u64, now: u32) -> Option<EnvironmentSample> {
    if packet.len() != 172 || !packet.starts_with(b"ZAE1")
        || alife_checkpoint::wide(&packet[8..16]) != epoch
        || alife_checkpoint::wide(&packet[16..24]) != boot
    {
        return None;
    }
    let number = |at| f32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
    let valid_name = |bytes: &[u8], empty| {
        bytes.iter().position(|&byte| byte == 0).is_some_and(|end| {
            (empty || end > 0)
                && bytes[..end].iter().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'-'))
                && bytes[end..].iter().all(|&byte| byte == 0)
        })
    };
    let remaining = number(32);
    if !(0.0..86_400.0).contains(&number(24))
        || !(0.0..=1000.0).contains(&number(28))
        || !(0.0..=86_400.0).contains(&remaining)
        || !valid_name(&packet[36..100], false)
        || !valid_name(&packet[100..164], true)
        || (packet[100] == 0 && remaining != 0.0)
    {
        return None;
    }
    let mut frame = [0; ENVIRONMENT_BYTES];
    frame[..4].copy_from_slice(&packet[4..8]);
    frame[4..].copy_from_slice(&packet[24..]);
    let sample = EnvironmentSample { frame };
    (sample.milliseconds() < 1_000_000_000_000_000
        && now.wrapping_sub(sample.tick()) <= 12).then_some(sample)
}

#[cfg(unix)]
fn decode_hit(bytes: &[u8], epoch: u64, world: &World, slots: &Arc<()>) -> Option<NativeImpact> {
    let has_armour = match (bytes.len(), bytes.get(..4)?) {
        (HIT, b"ZAH1") => false,
        (ARMOURED_HIT, b"ZAH4") => true,
        _ => return None,
    };
    let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    // Sequenced packets may wait behind consumer backpressure. Their epoch,
    // boot and actor incarnation fence validity; elapsed queue time must not
    // erase an otherwise valid hit before it can be acknowledged.
    if u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != epoch {
        return None;
    }
    let id = word(16);
    let target = world.entities.get(&id)?;
    if target.kind != Kind::Player
        || target.health == 0
        || target.travelling
        || target.incarnation != word(20)
        || world.is_protected(target)
    {
        return None;
    }
    let life = target.character_key.as_ref()?.life;
    let power = f32::from_bits(word(28));
    if !(power > 0.0 && power <= 10.0) {
        return None;
    }
    let hit_type = word(24);
    if has_armour && hit_type > 3 {
        return None;
    }
    let bone_name = || {
        let name = &bytes[36..HIT];
        let end = name.iter().position(|&ch| ch == 0)?;
        if name[end..].iter().any(|&ch| ch != 0)
            || !name[..end].iter().all(|ch| ch.is_ascii_alphanumeric() || *ch == b'_')
        {
            return None;
        }
        Some(std::str::from_utf8(&name[..end]).ok()?.to_owned())
    };
    let kind = match hit_type {
        0 => ImpactKind::Wound { bone: bone_name()? },
        1 => ImpactKind::Strike,
        2 => {
            let penetration = f32::from_bits(word(32));
            if !(0.0..=MAX_PENETRATION).contains(&penetration) {
                return None;
            }
            ImpactKind::Bullet {
                bone: bone_name()?,
                penetration,
            }
        }
        3 => ImpactKind::Blast { bone: bone_name()? },
        field @ 4..=8 => {
            use environment::Kind::*;
            let kind = [Psy, Heat, Acid, Shock, Radiation][(field - 4) as usize];
            return Some(NativeImpact::Field(id, environment::Pulse { kind, power }));
        }
        _ => return None,
    };
    let native_armour = if has_armour {
        let generation = u64::from_le_bytes(bytes[68..76].try_into().ok()?);
        let power = f32::from_bits(word(76));
        let condition = |offset| match f32::from_bits(word(offset)) {
            -1.0 => Some(None),
            value if (0.0..=1.0).contains(&value) => Some(Some(value)),
            _ => None,
        };
        if !(0.0..=10.0).contains(&power) || generation > 9_007_199_254_740_991 {
            return None;
        }
        let health = f32::from_bits(word(92));
        let power_loss = f32::from_bits(word(96));
        if !(0.0..=1000.0).contains(&health) || !(0.0..=1000.0).contains(&power_loss) {
            return None;
        }
        Some(crate::survival::NativeArmourImpact {
            health, power_loss, generation, power, outfit: condition(80)?, helmet: condition(84)?,
            wound: match word(88) { 0 => false, 1 => true, _ => return None },
        })
    } else { None };
    Some(NativeImpact::Physical(DamageContact::native(
        slots.clone(),
        id,
        life,
        target.incarnation,
        power,
        kind,
        native_armour,
    )))
}

#[cfg(unix)]
fn weapon_rules_match(world: &World, id: u32, life: u32, rules: &crate::alife_weapon::NativeWeaponRules) -> bool {
    world.entities.get(&id).is_some_and(|actor| {
        actor.kind == Kind::Player && actor.incarnation == life && actor.health > 0 && !actor.travelling
            && actor.loadout.active_item.is_some_and(|item| rules.matches_item(item))
    })
}

#[cfg(unix)]
fn ingest_hitboxes(bytes: &[u8], epoch: u64, world: &mut World) {
    let Some(header) = bytes.get(..44) else { return };
    if alife_checkpoint::wide(&header[8..16]) != epoch { return; }
    let word = |at| u32::from_le_bytes(header[at..at + 4].try_into().unwrap());
    let tick = word(4);
    if world.tick.wrapping_sub(tick) > crate::alife_hitboxes::MAX_AGE { return; }
    let Some(player) = world.entities.get_mut(&word(24)) else { return };
    if player.kind != Kind::Player || player.incarnation != word(28) || player.health == 0
        || player.travelling || player.character_key.is_none()
        || player.hitboxes.as_ref().is_some_and(|(previous, _)| !crate::world::newer(tick, *previous))
    { return; }
    let feet = parry3d::math::Vector::from_array([32, 36, 40].map(|offset| f32::from_bits(word(offset))));
    if let Some(hitboxes) = crate::alife_hitboxes::Hitboxes::decode(feet, &bytes[44..]) {
        player.hitboxes = Some((tick, Arc::new(hitboxes)));
    }
}

#[cfg(unix)]
fn ingest_movement(bytes: &[u8], epoch: u64, world: &mut World) {
    use crate::world::Vec3;
    const HEADER: usize = 24;
    const ROW: usize = 40;
    if !(HEADER + ROW..=HEADER + ROW * 128).contains(&bytes.len())
        || (bytes.len() - HEADER) % ROW != 0
        || alife_checkpoint::wide(&bytes[8..16]) != epoch
    { return; }
    let word = |buf: &[u8], at| u32::from_le_bytes(buf[at..at + 4].try_into().unwrap());
    let tick = word(bytes, 4);
    if world.tick.wrapping_sub(tick) > TICK_HZ / 4 { return; }
    for row in bytes[HEADER..].chunks_exact(ROW) {
        let [x, y, z, vx, vy, vz] = [12, 16, 20, 24, 28, 32].map(|at| f32::from_bits(word(row, at)));
        let flags = word(row, 36);
        if [x, y, z].iter().all(|v| v.abs() <= 100_000.0)
            && [vx, vy, vz].iter().all(|v| v.abs() <= 250.0) && flags & !62 == 0
        {
            world.apply_native_movement(word(row, 0), word(row, 4), tick, word(row, 8),
                Vec3 { x, y, z }, Vec3 { x: vx, y: vy, z: vz }, flags);
        }
    }
}

#[cfg(unix)]
type ArmourItem = (u8, String, f32, Vec<String>);
#[cfg(unix)]
type EquipmentSnapshot = (u32, u32, u64, Vec<ArmourItem>, Option<crate::alife_weapon::Weapon>);

#[cfg(unix)]
fn encode_armour(packet: &mut Vec<u8>, epoch: u64, boot: u64, id: u32, incarnation: u32,
    generation: u64, items: &[ArmourItem]) -> bool {
    const BELT: std::ops::Range<u8> = ARMOUR_BELT_START..(ARMOUR_BELT_START + crate::equipment::BELT_CELLS);
    if items.len() > usize::from(crate::equipment::BELT_CELLS) + 2 || !items.iter().all(|(slot, section, condition, upgrades)| {
        (matches!(slot, 7 | 12) || (BELT.contains(slot) && upgrades.is_empty())) &&
            section.len() < 64 && crate::inventory::section_valid(section) &&
            (0.0..=1.0).contains(condition) && upgrades.len() <= 32 &&
            upgrades.iter().all(|name| crate::inventory::section_valid(name))
    }) {
        return false;
    }
    packet.clear();
    packet.extend_from_slice(b"ZAG3");
    packet.extend_from_slice(&epoch.to_le_bytes());
    packet.extend_from_slice(&boot.to_le_bytes());
    packet.extend_from_slice(&id.to_le_bytes());
    packet.extend_from_slice(&incarnation.to_le_bytes());
    packet.extend_from_slice(&generation.to_le_bytes());
    packet.push(items.len() as u8);
    for (slot, section, condition, upgrades) in items {
        packet.push(*slot);
        packet.extend_from_slice(&condition.to_le_bytes());
        packet.push(upgrades.len() as u8);
        for name in std::iter::once(section).chain(upgrades) {
            packet.push(name.len() as u8);
            packet.extend_from_slice(name.as_bytes());
        }
    }
    true
}

fn encode(frame: &mut Vec<u8>, level: &str, epoch: u64, world: &World) -> bool {
    debug_assert!(level.len() <= 22);
    let (magic, row) = if world.native_player_movement { (b"ZAI5", NATIVE_PLAYER) } else { (b"ZAI2", PLAYER) };
    frame.extend_from_slice(magic);
    frame.extend_from_slice(&world.tick.to_le_bytes());
    frame.extend_from_slice(&[0; 2]); // u16 count, followed by a zero-padded level name.
    frame.extend_from_slice(level.as_bytes());
    frame.resize(32, 0);
    frame.extend_from_slice(&epoch.to_le_bytes());
    let mut count = 0u16;
    for actor in world.entities.values() {
        if actor.kind != Kind::Player
            || actor.health == 0
            || actor.travelling
            || actor.character_key.is_none()
        {
            continue;
        }
        let p = [actor.position.x, actor.position.y, actor.position.z];
        let yaw = actor.yaw.rem_euclid(std::f32::consts::TAU);
        if !p.iter().all(|coordinate| coordinate.abs() <= 100_000.0) || !yaw.is_finite() {
            continue;
        }
        if usize::from(count) == MAX_PLAYERS {
            return false;
        }
        count += 1;
        frame.extend_from_slice(&actor.id.to_le_bytes());
        frame.extend_from_slice(&actor.incarnation.to_le_bytes());
        for coordinate in p {
            frame.extend_from_slice(&coordinate.to_le_bytes());
        }
        frame.extend_from_slice(&yaw.to_le_bytes());
        let crouched = world.capsule_height(actor.id) < 1.8;
        frame.extend_from_slice(&u32::from(crouched).to_le_bytes());
        if world.native_player_movement {
            let (sequence, controls, scale, pitch) = world.native_movement_input(actor);
            let (health, power) = actor.condition.as_ref().map_or((f32::from(actor.health) / 100.0, 1.0),
                |condition| (condition.health, condition.power));
            frame.extend_from_slice(&sequence.to_le_bytes());
            frame.extend_from_slice(&controls.to_le_bytes());
            frame.extend_from_slice(&scale.to_le_bytes());
            frame.extend_from_slice(&pitch.clamp(-1.55, 1.55).to_le_bytes());
            frame.extend_from_slice(&health.to_le_bytes());
            frame.extend_from_slice(&power.to_le_bytes());
            let native=actor.condition.as_ref().is_some_and(|state|state.native_checkpoint().is_some());
            frame.extend_from_slice(&u32::from(native).to_le_bytes());
        }
    }
    debug_assert_eq!(frame.len(), HEADER + usize::from(count) * row);
    frame[8..10].copy_from_slice(&count.to_le_bytes());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{CharacterKey, Vec3};

    #[cfg(unix)]
    #[test]
    fn hit_delivery_retries_backpressure_without_duplicate_or_new_life_damage() {
        let directory=std::path::PathBuf::from(format!("/tmp/zone-hit-ack-{}",std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory,std::fs::Permissions::from_mode(0o700)).unwrap();
        let endpoint=directory.join("host");
        let native=UnixDatagram::bind(&endpoint).unwrap();native.set_nonblocking(true).unwrap();
        let mut host=AlifeInterests::new(&endpoint,"zaton-static-v1").unwrap();
        host.admission.admitted=Some(Offer{boot:17,checkpoint:alife_checkpoint::Checkpoint{lineage:1,generation:1}});
        let mut world=World::new();world.safe_zones.clear();world.tick=1;
        let player=world.spawn(Kind::Player,Vec3::default());
        let actor=world.entities.get_mut(&player).unwrap();actor.incarnation=9;
        actor.character_key=Some(CharacterKey{principal:"a".repeat(32),life:0});
        let make=|sequence:u64,boot:u64| {
            let mut bytes=vec![0u8;HIT+16];bytes[..4].copy_from_slice(b"ZAH2");
            bytes[4..8].copy_from_slice(&1u32.to_le_bytes());bytes[8..16].copy_from_slice(&host.epoch.to_le_bytes());
            bytes[16..20].copy_from_slice(&player.to_le_bytes());bytes[20..24].copy_from_slice(&9u32.to_le_bytes());
            bytes[24..28].copy_from_slice(&8u32.to_le_bytes());bytes[28..32].copy_from_slice(&0.1f32.to_le_bytes());
            bytes[HIT..HIT+8].copy_from_slice(&sequence.to_le_bytes());bytes[HIT+8..].copy_from_slice(&boot.to_le_bytes());bytes
        };
        let one=make(1,17);let two=make(2,17);let wrong=make(3,18);
        let receiver=directory.join("host.hits");let mut ack=[0u8;28];
        native.send_to(&one,&receiver).unwrap();
        host.drain_impacts(&world,Err);assert!(native.recv(&mut ack).is_err());
        assert_eq!(host.hit_delivery.1,0);assert!(host.hit_delivery.2.is_some());
        native.send_to(&one,&receiver).unwrap();native.send_to(&two,&receiver).unwrap();
        world.tick+=TICK_HZ*10; // pending and not-yet-decoded hits survive congestion
        let mut accepted=0;
        host.drain_impacts(&world,|hit|{assert!(matches!(hit,NativeImpact::Field(..)));accepted+=1;Ok(())});
        assert_eq!(accepted,2);assert_eq!(native.recv(&mut ack).unwrap(),28);
        assert_eq!(&ack[..4],b"ZHA1");assert_eq!(alife_checkpoint::wide(&ack[20..]),2);
        native.send_to(&two,&receiver).unwrap();native.send_to(&wrong,&receiver).unwrap();
        host.drain_impacts(&world,|_|panic!("duplicate or wrong boot delivered"));
        assert_eq!(native.recv(&mut ack).unwrap(),28);
        let mut third=two.clone();third[HIT..HIT+8].copy_from_slice(&3u64.to_le_bytes());
        native.send_to(&third,&receiver).unwrap();host.drain_impacts(&world,Err);
        native.recv(&mut ack).unwrap(); // previous accepted watermark only
        world.entities.get_mut(&player).unwrap().incarnation=10;
        host.drain_impacts(&world,|_|panic!("old life hit delivered"));
        assert_eq!(native.recv(&mut ack).unwrap(),28);assert_eq!(alife_checkpoint::wide(&ack[20..]),3);
        drop(host);drop(native);std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn condition_baseline_socket_fences_boot_equipment_and_player_lifetime() {
        let directory = std::path::PathBuf::from(format!("/tmp/zc-baseline-{}", std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
        let endpoint = directory.join("host");
        let native = UnixDatagram::bind(&endpoint).unwrap();
        native.set_read_timeout(Some(std::time::Duration::from_secs(1))).unwrap();
        let mut host = AlifeInterests::new(&endpoint, "zaton-static-v1").unwrap();
        host.admission.admitted = Some(Offer { boot: 17, checkpoint: alife_checkpoint::Checkpoint { lineage: 1, generation: 1 } });
        let mut world = World::new(); world.native_player_movement = true; world.tick = 1;
        let player = world.spawn(Kind::Player, Vec3::default());
        world.entities.get_mut(&player).unwrap().incarnation = 9;
        host.request_condition_baseline(player, 9, 7);
        let mut input = [0; 60]; assert_eq!(native.recv(&mut input).unwrap(), 60);
        assert_eq!(&input[..4], b"ZCT1");
        let mut state = b"ZCS1".to_vec();
        let mut values = [0.0f32; 23+8+12+9];
        values[0]=1.0; values[5]=1.0; values[18]=1.0; values[19]=50.0; values[20]=60.0;
        for value in values { state.extend_from_slice(&value.to_le_bytes()); }
        for value in [0u32,16,0,0] { state.extend_from_slice(&value.to_le_bytes()); }
        let reply = |mut header: [u8; 60]| { header[2]=b'U'; [header.as_slice(), &state].concat() };
        let receiver = directory.join("host.hits.condition");
        native.send_to(&reply(input), &receiver).unwrap();
        host.poll_condition_baselines(&world);
        assert!(host.condition_baseline(player, 9, 7).is_some());
        assert!(host.condition_baseline(player, 8, 7).is_none());
        host.request_condition_baseline(player, 9, 8);
        assert!(host.condition_baseline(player, 9, 7).is_none());
        let mut next = [0; 60]; assert_eq!(native.recv(&mut next).unwrap(), 60);
        native.send_to(&reply(input), &receiver).unwrap(); // delayed old equipment result
        host.poll_condition_baselines(&world);
        assert!(host.condition_baseline(player, 9, 8).is_none());
        native.send_to(&reply(next), &receiver).unwrap();
        host.poll_condition_baselines(&world);
        assert!(host.condition_baseline(player, 9, 8).is_some());
        let checkpoint = host.condition_baseline(player,9,8).unwrap().clone();
        let action = host.prepare_condition(player,9,5,8,0.1,12.0,Some(&checkpoint)).unwrap();
        let fence = action.fence;
        let mut action_header = [0u8;60]; action_header.copy_from_slice(&action.bytes()[..60]);
        assert!(host.queue_condition(action));
        let second = host.prepare_condition(player,9,5,8,0.1,12.0,Some(&checkpoint)).unwrap();
        assert!(!host.queue_condition(second)); // never invalidate an in-flight action
        let mut packet = [0u8;16060]; let size=native.recv(&mut packet).unwrap(); assert!(size>60);
        let sent=packet[..size].to_vec();
        world.tick=TICK_HZ/5;
        host.poll_condition_baselines(&world);
        let retry_size=native.recv(&mut packet).unwrap();
        assert_eq!(&packet[..retry_size],sent.as_slice());
        world.tick=1;
        host.request_condition_baseline(player,9,9);
        assert!(host.condition_pending.is_empty()); // no newer baseline sequence interleaves
        native.send_to(&reply(next), &receiver).unwrap(); // old baseline must not complete action
        host.poll_condition_baselines(&world);
        assert!(host.take_condition_result(player).is_none());
        native.send_to(&reply(action_header), &receiver).unwrap();
        host.poll_condition_baselines(&world);
        let completed = host.take_condition_result(player).unwrap();
        assert_eq!(completed.0,fence); assert_eq!(completed.1.checkpoint,checkpoint);
        native.send_to(&reply(action_header), &receiver).unwrap();
        host.poll_condition_baselines(&world);
        assert!(host.take_condition_result(player).is_none()); // duplicate is not delivered twice
        let hit=host.prepare_condition_hit(player,9,6,8,12.0,&checkpoint,
            crate::native_condition::Hit{kind:6,power:0.5,penetration:0.7,aimed:false,bone:"bip01_spine"}).unwrap();
        let hit_fence=hit.fence;
        let mut response=hit.bytes()[..60].to_vec(); response[2]=b'V';
        response.extend_from_slice(&0.65f32.to_le_bytes()); response.extend_from_slice(&(-1.0f32).to_le_bytes());
        response.extend_from_slice(&state);
        assert!(host.queue_condition(hit)); assert!(native.recv(&mut packet).unwrap()>60);
        native.send_to(&response,&receiver).unwrap(); host.poll_condition_baselines(&world);
        let result=host.take_condition_result(player).unwrap();
        assert_eq!(result.0,hit_fence); assert_eq!(result.1.wear,Some([Some(0.65),None]));
        assert_eq!(result.1.checkpoint,checkpoint);
        let action = host.prepare_condition(player,9,6,8,0.1,12.0,Some(&checkpoint)).unwrap();
        let next_fence = action.fence;
        assert!(host.queue_condition(action));
        host.cancel_condition(fence); // old cancel cannot remove new request
        assert!(host.condition_actions.contains_key(&player));
        host.cancel_condition(next_fence);
        assert!(host.condition_actions.is_empty());
        world.entities.get_mut(&player).unwrap().incarnation = 10;
        host.poll_condition_baselines(&world);
        assert!(host.condition_baselines.is_empty());
        assert!(host.condition_pending.is_empty());
        drop(host); drop(native);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn native_armour_packet_carries_incarnation_and_replaces_empty_slots() {
        let mut packet = Vec::new();
        let outfit = (7, "stalker_outfit".into(), 0.5, vec!["upgrade".into()]);
        assert!(encode_armour(&mut packet, 7, 11, 13, 17, 19, &[outfit]));
        assert_eq!(&packet[..28], &[b'Z', b'A', b'G', b'3', 7, 0, 0, 0, 0, 0, 0, 0, 11, 0, 0, 0,
            0, 0, 0, 0, 13, 0, 0, 0, 17, 0, 0, 0]);
        assert_eq!(&packet[28..36], &19u64.to_le_bytes());
        assert_eq!(&packet[36..], b"\x01\x07\x00\x00\x00\x3f\x01\x0estalker_outfit\x07upgrade");
        assert!(encode_armour(&mut packet, 7, 11, 13, 17, 19, &[(20, "af_medusa".into(), 0.25, vec![])]));
        assert_eq!(&packet[37..], b"\x14\x00\x00\x80\x3e\x00\x09af_medusa");
        assert!(!encode_armour(&mut packet, 7, 11, 13, 17, 19, &[(21, "af_medusa".into(), 1.0, vec![])]));
        assert!(encode_armour(&mut packet, 7, 11, 13, 17, 19, &[]));
        assert_eq!((packet.len(), packet[36]), (37, 0));
        assert!(!encode_armour(&mut packet, 7, 11, 13, 17, 19, &[(12, "helm".into(), f32::NAN, vec![])]));
    }

    #[cfg(unix)]
    #[test]
    fn native_environment_requires_the_admitted_host_and_a_fresh_sample() {
        let mut packet = [0; 172];
        packet[..4].copy_from_slice(b"ZAE1");
        packet[4..8].copy_from_slice(&30u32.to_le_bytes());
        packet[8..16].copy_from_slice(&7u64.to_le_bytes());
        packet[16..24].copy_from_slice(&11u64.to_le_bytes());
        packet[24..28].copy_from_slice(&3600f32.to_le_bytes());
        packet[28..32].copy_from_slice(&10f32.to_le_bytes());
        packet[36..43].copy_from_slice(b"default");
        packet[164..].copy_from_slice(&3600000u64.to_le_bytes());

        let sample = decode_environment(&packet, 7, 11, 31).unwrap();
        assert_eq!(sample.tick(), 30);
        assert_eq!(sample.milliseconds(), 3600000);
        assert!(decode_environment(&packet, 7, 12, 31).is_none());
        assert!(decode_environment(&packet, 7, 11, 43).is_none());
        packet[28..32].copy_from_slice(&f32::NAN.to_le_bytes());
        assert!(decode_environment(&packet, 7, 11, 31).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn native_damage_is_scoped_to_a_live_unprotected_player_and_current_publisher() {
        use crate::world::SafeZone;

        let mut world = World::new();
        world.tick = 120;
        world.safe_zones.clear();
        let position = Vec3 {
            x: 1.0,
            y: 2.0,
            z: 3.0,
        };
        let player = world.spawn(Kind::Player, position);
        world.entities.get_mut(&player).unwrap().character_key = Some(CharacterKey {
            principal: "fixture".into(),
            life: 5,
        });
        world.entities.get_mut(&player).unwrap().incarnation = 9;
        let slots = Arc::new(());
        let mut packet = [0; HIT];
        packet[..4].copy_from_slice(b"ZAH1");
        packet[4..8].copy_from_slice(&117u32.to_le_bytes());
        packet[8..16].copy_from_slice(&14u64.to_le_bytes());
        packet[16..20].copy_from_slice(&player.to_le_bytes());
        packet[20..24].copy_from_slice(&9u32.to_le_bytes());
        packet[28..32].copy_from_slice(&0.25f32.to_le_bytes());
        packet[36..47].copy_from_slice(b"bip01_spine");
        let Some(NativeImpact::Physical(contact)) = decode_hit(&packet, 14, &world, &slots) else {
            panic!("missing native hit");
        };
        assert!(contact.is_current(&world) && !contact.is_pvp());
        assert!(matches!(contact.kind(), ImpactKind::Wound { bone } if bone == "bip01_spine"));
        assert_eq!(contact.power, 0.25);
        assert!(decode_hit(&packet, 15, &world, &slots).is_none());
        assert!(decode_hit(&packet[..HIT - 1], 14, &world, &slots).is_none());
        let mut armoured = [0; ARMOURED_HIT];
        armoured[..HIT].copy_from_slice(&packet);
        armoured[..4].copy_from_slice(b"ZAH4");
        armoured[68..76].copy_from_slice(&19u64.to_le_bytes());
        armoured[76..80].copy_from_slice(&0.125f32.to_le_bytes());
        armoured[80..84].copy_from_slice(&0.75f32.to_le_bytes());
        armoured[84..88].copy_from_slice(&(-1.0f32).to_le_bytes());
        armoured[88..92].copy_from_slice(&1u32.to_le_bytes());
        armoured[92..96].copy_from_slice(&0.2f32.to_le_bytes());
        armoured[96..100].copy_from_slice(&0.3f32.to_le_bytes());
        let Some(NativeImpact::Physical(wound)) = decode_hit(&armoured, 14, &world, &slots) else {
            panic!("missing native armour proposal");
        };
        let armour = wound.native_armour().unwrap();
        assert_eq!((armour.generation, armour.power, armour.outfit, armour.helmet), (19, 0.125, Some(0.75), None));
        assert_eq!((armour.health, armour.power_loss), (0.2, 0.3));
        for offset in [92, 96] {
            for invalid in [f32::NAN, f32::INFINITY, -0.1, 1001.0] {
                let mut bad = armoured;
                bad[offset..offset + 4].copy_from_slice(&invalid.to_le_bytes());
                assert!(decode_hit(&bad, 14, &world, &slots).is_none());
            }
        }
        let mut old = armoured;
        old[..4].copy_from_slice(b"ZAH3");
        assert!(decode_hit(&old, 14, &world, &slots).is_none());
        packet[24..28].copy_from_slice(&2u32.to_le_bytes());
        packet[32..36].copy_from_slice(&150.0f32.to_le_bytes());
        let Some(NativeImpact::Physical(bullet)) = decode_hit(&packet, 14, &world, &slots) else {
            panic!("missing native Gauss hit");
        };
        assert!(matches!(bullet.kind(), ImpactKind::Bullet { penetration: 150.0, .. }));
        armoured[24..36].copy_from_slice(&packet[24..36]);
        armoured[36..HIT].fill(0);
        armoured[36..46].copy_from_slice(b"bip01_head");
        armoured[88..92].copy_from_slice(&0u32.to_le_bytes());
        let Some(NativeImpact::Physical(bullet)) = decode_hit(&armoured, 14, &world, &slots) else {
            panic!("missing native bullet protection");
        };
        assert!(!bullet.native_armour().unwrap().wound);
        armoured[88..92].copy_from_slice(&2u32.to_le_bytes());
        assert!(decode_hit(&armoured, 14, &world, &slots).is_none());
        for penetration in [f32::NAN, -1.0, MAX_PENETRATION + 1.0] {
            packet[32..36].copy_from_slice(&penetration.to_le_bytes());
            assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        }
        packet[32..36].copy_from_slice(&150.0f32.to_le_bytes());
        world.safe_zones.push(SafeZone::sphere(position, 1.0));
        assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        assert!(decode_hit(&armoured, 14, &world, &slots).is_none());
        world.safe_zones.clear();
        world.entities.get_mut(&player).unwrap().incarnation = 10;
        assert!(!contact.is_current(&world));
        assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        world.entities.get_mut(&player).unwrap().incarnation = 9;
        world.tick += TICK_HZ * 2;
        assert!(decode_hit(&packet, 14, &world, &slots).is_some());
    }

    #[test]
    fn only_current_authoritative_living_bodies_enter_the_level_snapshot() {
        let mut world = World::new();
        for n in 0..6 {
            let id = world.spawn(
                if n == 5 { Kind::Npc } else { Kind::Player },
                Vec3 {
                    x: n as f32,
                    y: 7.0,
                    z: -2.0,
                },
            );
            let actor = world.entities.get_mut(&id).unwrap();
            actor.incarnation = n + 10;
            actor.character_key = (n != 2).then(|| CharacterKey {
                principal: format!("player-{n}"),
                life: 0,
            });
            if n == 3 {
                actor.health = 0;
            }
            if n == 4 {
                actor.travelling = true;
            }
        }
        let mut bytes = Vec::new();
        assert!(encode(&mut bytes, "zaton", 1234, &world));
        assert_eq!(&bytes[..15], b"ZAI2\0\0\0\0\x02\0zaton");
        assert_eq!(bytes.len(), HEADER + 2 * PLAYER);
        assert_eq!(&bytes[32..HEADER], &1234u64.to_le_bytes());
        assert_eq!(&bytes[HEADER..HEADER + 4], &1u32.to_le_bytes());
        assert_eq!(&bytes[HEADER + 4..HEADER + 8], &10u32.to_le_bytes());
        assert_eq!(
            &bytes[HEADER + PLAYER + 8..HEADER + PLAYER + 12],
            &1.0f32.to_le_bytes()
        );
        world.native_player_movement=true;
        let mut state=crate::survival::State::default();
        let mut raw=b"ZCS1".to_vec();let mut values=[0.0f32;52];
        values[0]=1.0;values[5]=1.0;values[18]=1.0;values[19]=50.0;values[20]=60.0;
        for value in values {raw.extend_from_slice(&value.to_le_bytes());}
        for value in [0u32,16,0,0] {raw.extend_from_slice(&value.to_le_bytes());}
        state.install_native_checkpoint(crate::native_condition::Checkpoint::parse(raw).unwrap()).unwrap();
        world.entities.get_mut(&1).unwrap().set_condition(state);
        bytes.clear();assert!(encode(&mut bytes,"zaton",1234,&world));
        assert_eq!(&bytes[..4],b"ZAI5");assert_eq!(bytes.len(),HEADER+2*NATIVE_PLAYER);
        assert_eq!(&bytes[HEADER+52..HEADER+56],&1u32.to_le_bytes());
        assert_eq!(&bytes[HEADER+NATIVE_PLAYER+52..HEADER+NATIVE_PLAYER+56],&0u32.to_le_bytes());

    }
}
