//! Private player snapshots, creature state and hits for the A-Life host.
use crate::{
    alife_attacks::{NativeAttack, Receipt},
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
#[cfg(unix)]
const HIT: usize = 68;
#[cfg(unix)]
const MAX_PENDING_HITS: usize = 512;

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
    _npc_bound: BoundSocket,
    #[cfg(unix)]
    npcs: crate::alife_npcs::NpcRoster,
    #[cfg(unix)]
    attacks: crate::alife_attacks::AttackQueue,
    #[cfg(unix)]
    corpse_pending: std::collections::BTreeMap<crate::alife_corpse::DeathId, PersistenceReply>,
    #[cfg(unix)]
    admission: WorldAdmission,
    #[cfg(unix)]
    impact_slots: Arc<()>,
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
            // Darwin's default 2 KiB send limit is smaller than a 200-player frame.
            socket2::SockRef::from(&socket).set_send_buffer_size(16 * 1024)?;
            Ok(Self {
                level: level.into(),
                world: world.into(),
                // Private stream identity. A restarted server can reuse runtime IDs.
                epoch: RandomState::new().hash_one(()).max(1),
                target: path.to_owned(),
                socket,
                _bound: bound,
                npc_socket,
                _npc_bound: npc_bound,
                npcs: Default::default(),
                attacks: Default::default(),
                corpse_pending: Default::default(),
                admission: Default::default(),
                impact_slots: Arc::new(()),
                frame: Vec::with_capacity(HEADER + MAX_PLAYERS * PLAYER),
            })
        }
        #[cfg(not(unix))]
        anyhow::bail!("native A-Life requires Unix sockets for level {level}");
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
        mut result: impl FnMut(Receipt, Option<u16>),
    ) {
        #[cfg(unix)]
        {
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
                            if let Some(receipt) = ack.receipt {
                                result(receipt, ack.health);
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
                    } else if packet.starts_with(b"ZAN2")
                        && packet.get(16..24).map(alife_checkpoint::wide) == Some(active.boot)
                    {
                        self.npcs.ingest(packet, epoch, world);
                    }
                }
            }
            self.npcs.expire(world);
        }
        #[cfg(not(unix))]
        let _ = (world, store, &mut result);
    }

    pub fn queue_attack(
        &mut self,
        attack: NativeAttack,
        tick: u32,
        receipt: Option<Receipt>,
    ) -> bool {
        self.queue_attacks(&[(attack, receipt)], tick)
    }

    pub fn queue_attacks(&mut self, attacks: &[(NativeAttack, Option<Receipt>)], tick: u32) -> bool {
        #[cfg(unix)]
        {
            self.admission
                .admitted
                .is_some_and(|active| attacks.iter().all(|(attack, _)| active.boot == attack.target.host))
                && self.attacks.enqueue_batch(attacks, tick)
        }
        #[cfg(not(unix))]
        {
            let _ = (attacks, tick);
            false
        }
    }

    pub fn flush_attacks(&mut self, world: &World, mut expired: impl FnMut(Receipt)) {
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

    pub fn drain_impacts(&self, world: &World, mut accept: impl FnMut(NativeImpact)) {
        #[cfg(unix)]
        for _ in 0..256 {
            let Some(active) = self.admission.admitted else {
                break;
            };
            if Arc::strong_count(&self.impact_slots) > MAX_PENDING_HITS {
                break;
            }
            let mut bytes = [0; HIT + 8 + 1];
            let Ok((size, sender)) = self.socket.recv_from(&mut bytes) else {
                break;
            };
            if sender.as_pathname() != Some(self.target.as_path()) {
                continue;
            }
            if let Some(body) = boot_payload(&bytes[..size], active.boot)
                && let Some(hit) = decode_hit(body, self.epoch, world, &self.impact_slots)
            {
                accept(hit);
            }
        }
        #[cfg(not(unix))]
        let _ = (&world, &mut accept);
    }
}

#[cfg(unix)]
fn decode_hit(bytes: &[u8], epoch: u64, world: &World, slots: &Arc<()>) -> Option<NativeImpact> {
    if bytes.len() != HIT || &bytes[..4] != b"ZAH1" {
        return None;
    }
    let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    if world.tick.wrapping_sub(word(4)) > TICK_HZ * 12 / 10
        || u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != epoch
    {
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
    let kind = match word(24) {
        0 => ImpactKind::Wound,
        1 => ImpactKind::Strike,
        2 => {
            let penetration = f32::from_bits(word(32));
            if !(0.0..=MAX_PENETRATION).contains(&penetration) {
                return None;
            }
            let name = &bytes[36..];
            let end = name.iter().position(|&ch| ch == 0)?;
            if name[end..].iter().any(|&ch| ch != 0)
                || !name[..end]
                    .iter()
                    .all(|ch| ch.is_ascii_alphanumeric() || *ch == b'_')
            {
                return None;
            }
            ImpactKind::Bullet {
                bone: std::str::from_utf8(&name[..end]).ok()?.to_owned(),
                penetration,
            }
        }
        3 => ImpactKind::Blast,
        field @ 4..=8 => {
            use environment::Kind::*;
            let kind = [Psy, Heat, Acid, Shock, Radiation][(field - 4) as usize];
            return Some(NativeImpact::Field(id, environment::Pulse { kind, power }));
        }
        _ => return None,
    };
    Some(NativeImpact::Physical(DamageContact::native(
        slots.clone(),
        id,
        life,
        target.incarnation,
        power,
        kind,
    )))
}

fn encode(frame: &mut Vec<u8>, level: &str, epoch: u64, world: &World) -> bool {
    debug_assert!(level.len() <= 22);
    frame.extend_from_slice(b"ZAI2");
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
    }
    frame[8..10].copy_from_slice(&count.to_le_bytes());
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{CharacterKey, Vec3};

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
        let Some(NativeImpact::Physical(contact)) = decode_hit(&packet, 14, &world, &slots) else {
            panic!("missing native hit");
        };
        assert!(contact.is_current(&world) && !contact.is_pvp());
        assert!(matches!(contact.kind(), ImpactKind::Wound));
        assert_eq!(contact.power, 0.25);
        assert!(decode_hit(&packet, 15, &world, &slots).is_none());
        assert!(decode_hit(&packet[..HIT - 1], 14, &world, &slots).is_none());
        packet[24..28].copy_from_slice(&2u32.to_le_bytes());
        packet[32..36].copy_from_slice(&150.0f32.to_le_bytes());
        let Some(NativeImpact::Physical(bullet)) = decode_hit(&packet, 14, &world, &slots) else {
            panic!("missing native Gauss hit");
        };
        assert!(matches!(bullet.kind(), ImpactKind::Bullet { penetration: 150.0, .. }));
        for penetration in [f32::NAN, -1.0, MAX_PENETRATION + 1.0] {
            packet[32..36].copy_from_slice(&penetration.to_le_bytes());
            assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        }
        packet[32..36].copy_from_slice(&150.0f32.to_le_bytes());
        world.safe_zones.push(SafeZone::sphere(position, 1.0));
        assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        world.safe_zones.clear();
        world.entities.get_mut(&player).unwrap().incarnation = 10;
        assert!(!contact.is_current(&world));
        assert!(decode_hit(&packet, 14, &world, &slots).is_none());
        world.entities.get_mut(&player).unwrap().incarnation = 9;
        world.tick += TICK_HZ * 2;
        assert!(decode_hit(&packet, 14, &world, &slots).is_none());
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
    }
}
