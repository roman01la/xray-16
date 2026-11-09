//! Acknowledged, loss-tolerant snapshot deltas. Local motor state stays f32;
//! remote transforms use centimetres and compact signed integer fields.
use crate::{
    protocol::{MAGIC, MAX_PACKET, VERSION},
    world::{SnapshotEntity, newer},
};
use std::collections::VecDeque;
#[derive(Clone, Copy, PartialEq, Eq)]
struct Record {
    id: u32,
    bytes: [u8; 43],
    len: usize,
}
impl Record {
    fn new(id: u32, kind: u8) -> Self {
        let mut r = Self {
            id,
            bytes: [0; 43],
            len: 0,
        };
        r.extend([kind]);
        r.extend(id.to_le_bytes());
        r
    }
    fn extend(&mut self, bytes: impl AsRef<[u8]>) {
        let bytes = bytes.as_ref();
        self.bytes[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
    }
    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}
type Frame = Vec<Record>;
/// State payload budget. Reliable control and DTLS/SCTP overhead are separate.
/// Charge a complete frame before writing any chunks; never intentionally send
/// only half a frame. The burst admits the maximum 512-entity keyframe.
pub struct ByteBudget {
    tokens: u64,
    last_tick: Option<u32>,
}
impl Default for ByteBudget {
    fn default() -> Self {
        Self {
            tokens: 32768 * 30,
            last_tick: None,
        }
    }
}
impl ByteBudget {
    pub fn admit(&mut self, tick: u32, bytes: usize) -> bool {
        if let Some(last) = self.last_tick {
            let elapsed = tick.wrapping_sub(last).min(30) as u64;
            self.tokens = (self.tokens + elapsed * 96 * 1024).min(32768 * 30);
        }
        self.last_tick = Some(tick);
        let cost = bytes as u64 * 30;
        if cost > self.tokens {
            return false;
        }
        self.tokens -= cost;
        true
    }
}
#[derive(Default)]
pub struct Replicator {
    baseline: Option<(u32, Frame)>,
    pending: VecDeque<(u32, Frame)>,
    sampled: Vec<(SnapshotEntity, u32)>,
}
fn i24(out: &mut Record, v: f32) {
    let n = (v * 100.).round() as i32;
    out.extend(&n.to_le_bytes()[..3]);
}
fn record(e: &SnapshotEntity, local: bool) -> Record {
    let compact = !local
        && [e.position.x, e.position.y, e.position.z]
            .iter()
            .all(|v| v.is_finite() && v.abs() < 83000.)
        && [e.velocity.x, e.velocity.y, e.velocity.z]
            .iter()
            .all(|v| v.is_finite() && v.abs() < 327.);
    let kind = if compact { 1 } else { 2 } + if e.native_motion.is_some() { 2 } else { 0 };
    let mut b = Record::new(e.id, kind);
    if compact {
        for v in [e.position.x, e.position.y, e.position.z] {
            i24(&mut b, v);
        }
        for v in [e.velocity.x, e.velocity.y, e.velocity.z] {
            b.extend(((v * 100.).round() as i16).to_le_bytes());
        }
        let yaw =
            (e.yaw + std::f32::consts::PI).rem_euclid(std::f32::consts::TAU) - std::f32::consts::PI;
        b.extend(((yaw / std::f32::consts::PI * 32767.).round() as i16).to_le_bytes());
    } else {
        for v in [
            e.position.x,
            e.position.y,
            e.position.z,
            e.velocity.x,
            e.velocity.y,
            e.velocity.z,
            e.yaw,
        ] {
            b.extend(v.to_le_bytes());
        }
    }
    b.extend(e.health.to_le_bytes());
    b.extend([e.kind, e.flags]);
    if let Some(motion) = e.native_motion {
        b.extend(motion.id.to_le_bytes());
        b.extend(motion.time_ms.to_le_bytes());
    }
    b
}
impl Replicator {
    pub fn acknowledge(&mut self, tick: u32) {
        if self
            .baseline
            .as_ref()
            .is_some_and(|(old, _)| !newer(tick, *old))
        {
            return;
        }
        if let Some(at) = self.pending.iter().position(|(t, _)| *t == tick) {
            let frame = self.pending.remove(at).unwrap();
            self.baseline = Some(frame);
            self.pending.retain(|(t, _)| newer(*t, tick));
        }
    }
    pub fn discard(&mut self, tick: u32) {
        self.pending.retain(|(t, _)| *t != tick);
    }
    pub fn resync(&mut self) {
        self.baseline = None;
        self.pending.clear();
    }
    pub fn encode(
        &mut self,
        tick: u32,
        player: u32,
        ack: u32,
        entities: &[SnapshotEntity],
    ) -> Vec<Vec<u8>> {
        let eye = entities.iter().find(|e| e.id == player).map(|e| e.position);
        let mut samples = Vec::with_capacity(entities.len());
        for e in entities {
            let distance = eye.map_or(0., |p| p.distance_squared(e.position));
            let period = if e.id == player || distance <= 25. * 25. {
                2
            } else if distance <= 60. * 60. {
                6
            } else {
                10
            };
            let previous = self
                .sampled
                .binary_search_by_key(&e.id, |(s, _)| s.id)
                .ok()
                .map(|i| self.sampled[i]);
            let sample = match previous {
                Some((old, at))
                    if period > 2
                        && tick.wrapping_sub(at) < period
                        && old.health == e.health
                        && old.kind == e.kind
                        && old.flags == e.flags =>
                {
                    (old, at)
                }
                _ => (*e, tick),
            };
            samples.push(sample);
        }
        samples.sort_unstable_by_key(|(e, _)| e.id);
        let mut current: Frame = samples
            .iter()
            .map(|(e, _)| record(e, e.id == player))
            .collect();
        self.sampled = samples;
        current.sort_unstable_by_key(|r| r.id);
        let base = self
            .baseline
            .as_ref()
            .filter(|(t, _)| tick.wrapping_sub(*t) <= 60);
        let mut changes = Vec::with_capacity(current.len());
        if let Some((_, old)) = base {
            // Linear merge over contiguous records; no allocation per entity.
            let mut before = old.iter().peekable();
            for value in &current {
                while before.peek().is_some_and(|r| r.id < value.id) {
                    changes.push(Record::new(before.next().unwrap().id, 0));
                }
                if before.peek().is_some_and(|r| r.id == value.id) {
                    if before.next().unwrap() != value {
                        changes.push(*value);
                    }
                } else {
                    changes.push(*value);
                }
            }
            changes.extend(before.map(|r| Record::new(r.id, 0)));
        } else {
            changes.extend_from_slice(&current);
        }
        let mut chunks = vec![Vec::<Record>::new()];
        let mut size = 28;
        for record in changes {
            if size + record.len > MAX_PACKET {
                chunks.push(Vec::new());
                size = 28;
            }
            size += record.len;
            chunks.last_mut().unwrap().push(record);
        }
        let parts = chunks.len();
        let mut output = Vec::with_capacity(parts);
        for (part, records) in chunks.into_iter().enumerate() {
            let mut b = Vec::with_capacity(MAX_PACKET);
            b.extend(MAGIC.to_le_bytes());
            b.extend([VERSION, 3]);
            for n in [tick, player, ack] {
                b.extend(n.to_le_bytes());
            }
            for n in [
                part as u16,
                parts as u16,
                records.len() as u16,
                u16::from(base.is_none()),
            ] {
                b.extend(n.to_le_bytes());
            }
            b.extend(base.map_or(0, |(t, _)| *t).to_le_bytes());
            for r in records {
                b.extend(r.as_bytes());
            }
            output.push(b);
        }
        self.pending.push_back((tick, current));
        // Retain one second of bounded ACK candidates (15 Hz snapshots).
        while self.pending.len() > 16 {
            self.pending.pop_front();
        }
        output
    }
}
pub fn decode_feedback(bytes: &[u8]) -> Option<Option<u32>> {
    if bytes.len() != 8
        || u16::from_le_bytes(bytes[..2].try_into().ok()?) != MAGIC
        || bytes[2] != VERSION
    {
        return None;
    }
    match bytes[3] {
        4 => Some(Some(u32::from_le_bytes(bytes[4..8].try_into().ok()?))),
        5 if bytes[4..8] == [0, 0, 0, 0] => Some(None),
        _ => None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::Vec3;
    fn e(id: u32) -> SnapshotEntity {
        SnapshotEntity {
            id,
            position: Vec3::default(),
            velocity: Vec3::default(),
            yaw: 0.,
            health: 100,
            kind: 1,
            flags: 0,
            native_motion: None,
        }
    }
    #[test]
    fn only_known_acks_establish_baseline_and_removal_repeats_until_ack() {
        let mut r = Replicator::default();
        let a = [e(1), e(2)];
        let first = r.encode(1, 1, 0, &a);
        assert_eq!(first[0][22], 1);
        r.acknowledge(99);
        assert_eq!(r.encode(2, 1, 0, &a)[0][22], 1);
        r.acknowledge(2);
        assert_eq!(r.encode(3, 1, 0, &a)[0].len(), 28);
        let gone = r.encode(4, 1, 0, &a[..1]);
        assert_eq!(gone[0].len(), 33);
        assert_eq!(gone[0][28], 0);
        assert_eq!(r.encode(5, 1, 0, &a[..1])[0].len(), 33);
        r.acknowledge(5);
        assert_eq!(r.encode(6, 1, 0, &a[..1])[0].len(), 28);
        r.resync();
        assert_eq!(r.encode(7, 1, 0, &a)[0][22], 1);
    }
    #[test]
    fn distance_tiers_preserve_local_precision_and_never_delay_lifecycle_or_health() {
        let mut r = Replicator::default();
        let mut entities = [e(1), e(2), e(3)];
        entities[1].position.x = 40.;
        entities[2].position.x = 80.;
        r.encode(2, 1, 0, &entities);
        r.acknowledge(2);
        entities[0].position.y = 0.123456;
        entities[1].position.z = 1.;
        entities[2].position.z = 2.;
        r.encode(4, 1, 0, &entities);
        assert_eq!(r.sampled[0].0.position.y, 0.123456);
        assert_eq!(r.sampled[1].0.position.z, 0.);
        assert_eq!(r.sampled[2].0.position.z, 0.);
        r.encode(8, 1, 0, &entities);
        assert_eq!(r.sampled[1].0.position.z, 1.);
        assert_eq!(r.sampled[2].0.position.z, 0.);
        entities[2].health = 0;
        r.encode(10, 1, 0, &entities);
        assert_eq!(r.sampled[2].0.health, 0);
        let removed = r.encode(12, 1, 0, &entities[..2]);
        assert_eq!(r.sampled.len(), 2);
        assert!(removed[0].windows(5).any(|w| w == [0, 3, 0, 0, 0]));
        // Reentry must use fresh state, even before the old tier interval expires.
        entities[2].position.z = 9.;
        r.encode(14, 1, 0, &entities);
        assert_eq!(r.sampled[2].0.position.z, 9.);
    }
    #[test]
    fn complete_frame_budget_bounds_burst_and_long_term_egress() {
        let mut b = ByteBudget::default();
        assert!(b.admit(u32::MAX, 32768));
        assert!(!b.admit(u32::MAX, 1));
        assert!(b.admit(0, 3276));
        assert!(!b.admit(0, 1));
        let mut b = ByteBudget::default();
        let mut total = 0;
        for tick in 0..300 {
            if b.admit(tick, 15000) {
                total += 15000;
            }
        }
        assert!(total <= 32768 + 96 * 1024 * 10);
        assert!(total > 96 * 1024 * 9);
        let mut r = Replicator::default();
        r.encode(1, 1, 0, &[e(1)]);
        r.discard(1);
        r.acknowledge(1);
        assert!(r.baseline.is_none());
    }
    #[test]
    fn wrap_loss_recovery_and_packet_bounds() {
        let mut r = Replicator::default();
        let entities: Vec<_> = (1..=200).map(e).collect();
        let packets = r.encode(u32::MAX, 1, 0, &entities);
        assert!(packets.iter().all(|p| p.len() <= 1100));
        assert_eq!(packets.len(), 5);
        r.acknowledge(u32::MAX);
        assert_eq!(r.encode(0, 1, 0, &entities)[0][22], 0);
        assert_eq!(r.encode(61, 1, 0, &entities)[0][22], 1);
    }
}
