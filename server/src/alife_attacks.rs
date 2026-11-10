//! Bounded private delivery of committed player hits to the native A-Life host.
use crate::{
    alife_npcs::NativeTarget,
    ballistics::MAX_PENETRATION,
    world::{TICK_HZ, World},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const LEASE: u32 = TICK_HZ * 12 / 10;
const MAX_PENDING: usize = 512;
const MAX_SEND: usize = 64;
const LEGACY_BYTES: usize = 96;
const COMMAND_BYTES: usize = 124;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[repr(u32)]
pub enum NativeHitKind {
    Bullet,
    Wound,
    Explosion,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct NativeDamage {
    pub kind: NativeHitKind,
    pub power: [f32; 3],
    pub penetration: f32,
    pub impulse: f32,
}

#[derive(Clone, Copy)]
pub struct NativeAttack {
    pub target_id: u32,
    pub target: NativeTarget,
    pub shooter: u32,
    pub life: u32,
    pub damage: NativeDamage,
    pub direction: [f32; 3],
    pub offset: [f32; 3],
    pub ray: Option<NativeRay>,
}

#[derive(Clone, Copy)]
pub struct NativeRay {
    pub origin: [f32; 3],
    pub direction: [f32; 3],
    pub range: f32,
}

impl NativeRay {
    fn valid(self) -> bool {
        let length = self.direction.iter().map(|value| value * value).sum::<f32>();
        self.origin.iter().all(|value| value.abs() <= 100_000.0)
            && (0.95..=1.05).contains(&length)
            && self.range > 0.0 && self.range <= crate::combat::MAX_OWNED_RANGE
    }
}

#[derive(Clone, Copy)]
pub struct Receipt {
    pub peer: u64,
    pub sequence: u32,
    pub followup_tick: Option<u32>,
    pub ammo: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Hit {
    pub target: u32,
    pub health: u16,
}

pub struct ShotOutcome {
    pub receipt: Receipt,
    pub hit: Option<Hit>,
}

pub struct AttackResult {
    pub attack: NativeAttack,
    pub health: Option<u16>,
    pub outcome: Option<ShotOutcome>,
}

struct Pending {
    tick: u32,
    sent: Option<u32>,
    attack: NativeAttack,
    volley: Option<u64>,
}

struct Volley {
    receipt: Receipt,
    remaining: usize,
    hits: Vec<(u64, Hit)>,
}

#[derive(Default)]
pub struct AttackQueue {
    next: u64,
    pending: BTreeMap<u64, Pending>,
    volleys: BTreeMap<u64, Volley>,
}

impl AttackQueue {
    pub fn enqueue_batch(&mut self, attacks: &[NativeAttack], tick: u32, receipt: Option<Receipt>) -> bool {
        if attacks.is_empty() || attacks.len() > MAX_PENDING - self.pending.len()
            || attacks.iter().any(|attack| {
                !attack.damage.power.iter().all(|p| (0.0..=100.0).contains(p))
                    || attack.damage.power[0] <= 0.0
                    || !(0.0..=MAX_PENETRATION).contains(&attack.damage.penetration)
                    || !(0.0..=1_000_000.0).contains(&attack.damage.impulse)
                    || attack.ray.is_some_and(|ray| !matches!(attack.damage.kind, NativeHitKind::Bullet) || !ray.valid())
            })
        {
            return false;
        }
        let volley = receipt.map(|receipt| {
            let id = self.next.checked_add(1).expect("native attack sequence exhausted");
            self.volleys.insert(id, Volley { receipt, remaining: attacks.len(), hits: Vec::new() });
            id
        });
        for &attack in attacks {
            self.next = self.next.checked_add(1).expect("native attack sequence exhausted");
            self.pending.insert(self.next, Pending { tick, sent: None, attack, volley });
        }
        true
    }

    fn complete(
        volleys: &mut BTreeMap<u64, Volley>,
        sequence: u64,
        pending: &Pending,
        health: Option<u16>,
    ) -> Option<ShotOutcome> {
        let id = pending.volley?;
        let volley = volleys.get_mut(&id).expect("pending attack retains its volley");
        if let Some(health) = health {
            volley.hits.push((sequence, Hit { target: pending.attack.target_id, health }));
        }
        volley.remaining -= 1;
        if volley.remaining > 0 {
            return None;
        }
        let volley = volleys.remove(&id).expect("completed volley exists");
        // Keep contact order independent of delivery order. Later pellets
        // against the selected NPC may have reduced its health further.
        let hit = volley.hits.iter().min_by_key(|(sequence, _)| *sequence).map(|(_, first)| {
            let health = volley.hits.iter().filter(|(_, hit)| hit.target == first.target)
                .map(|(_, hit)| hit.health).min().expect("first hit is present");
            Hit { target: first.target, health }
        });
        Some(ShotOutcome { receipt: volley.receipt, hit })
    }

    pub fn acknowledge(&mut self, bytes: &[u8], epoch: u64) -> Option<AttackResult> {
        if bytes.len() != 36 || &bytes[..4] != b"ZAA1" {
            return None;
        }
        let wide = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let word = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let id = wide(20);
        if wide(4) != epoch
            || self.pending.get(&id)?.attack.target.host != wide(12)
            || word(28) > 1
            || word(32) > 100
        {
            return None;
        }
        let pending = self.pending.remove(&id)?;
        let health = (word(28) == 1).then(|| word(32) as u16);
        Some(AttackResult {
            attack: pending.attack,
            health,
            outcome: Self::complete(&mut self.volleys, id, &pending, health),
        })
    }

    pub fn poll(
        &mut self,
        world: &World,
        epoch: u64,
        mut send: impl FnMut(&[u8]) -> bool,
        mut expired: impl FnMut(ShotOutcome),
    ) {
        let volleys = &mut self.volleys;
        self.pending.retain(|&sequence, request| {
            let target_gone = world
                .entities
                .get(&request.attack.target_id)
                .and_then(|npc| npc.native.as_ref())
                .is_none_or(|npc| npc.target != request.attack.target);
            // A sent hit may already have applied. Allow its acknowledgement
            // to arrive even if a subsequent roster removed that target.
            if world.tick.wrapping_sub(request.tick) > LEASE
                || (request.sent.is_none() && target_gone)
            {
                if let Some(outcome) = Self::complete(volleys, sequence, request, None) {
                    expired(outcome);
                }
                false
            } else {
                true
            }
        });
        for (&sequence, pending) in self
            .pending
            .iter_mut()
            .filter(|(_, p)| p.sent.is_none_or(|sent| world.tick.wrapping_sub(sent) >= 3))
            .take(MAX_SEND)
        {
            let packet = encode(epoch, sequence, pending);
            let size = if pending.attack.ray.is_some() { COMMAND_BYTES } else { LEGACY_BYTES };
            if !send(&packet[..size]) {
                break;
            }
            pending.sent = Some(world.tick);
        }
    }
}

fn encode(epoch: u64, sequence: u64, pending: &Pending) -> [u8; COMMAND_BYTES] {
    let mut bytes = [0; COMMAND_BYTES];
    bytes[..4].copy_from_slice(if pending.attack.ray.is_some() { b"ZAS2" } else { b"ZAS1" });
    for (at, value) in [(8, epoch), (16, pending.attack.target.host), (24, sequence)] {
        bytes[at..at + 8].copy_from_slice(&value.to_le_bytes());
    }
    let attack = &pending.attack;
    let values = [
        pending.tick,
        u32::from(attack.target.id),
        attack.target.spawn,
        attack.shooter,
        attack.life,
        attack.damage.kind as u32,
        attack.damage.penetration.to_bits(),
        attack.damage.impulse.to_bits(),
        attack.damage.power[0].to_bits(),
        attack.damage.power[1].to_bits(),
        attack.damage.power[2].to_bits(),
        attack.direction[0].to_bits(),
        attack.direction[1].to_bits(),
        attack.direction[2].to_bits(),
        attack.offset[0].to_bits(),
        attack.offset[1].to_bits(),
        attack.offset[2].to_bits(),
    ];
    for (at, value) in [
        4, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92,
    ]
    .into_iter()
    .zip(values)
    {
        bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
    }
    if let Some(ray) = attack.ray {
        for (chunk, value) in bytes[LEGACY_BYTES..].chunks_exact_mut(4)
            .zip(ray.origin.into_iter().chain(ray.direction).chain([ray.range]))
        {
            chunk.copy_from_slice(&value.to_le_bytes());
        }
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        alife_npcs::{NativeBounds, NativeNpc},
        world::{Kind, Vec3},
    };

    fn npc_attack(world: &mut World, native_id: u16) -> NativeAttack {
        let id = world.spawn(Kind::Npc, Vec3::default());
        let target = NativeTarget {
            host: 9,
            id: native_id,
            spawn: 24,
        };
        world.entities.get_mut(&id).unwrap().native = Some(NativeNpc {
            target,
            model: "dog".into(),
            bounds: NativeBounds {
                center: [0.0; 3],
                half: [1.0; 3],
            },
            motion: None,
        });
        NativeAttack {
            target_id: id,
            target,
            shooter: 5,
            life: 1,
            damage: NativeDamage {
                kind: NativeHitKind::Bullet,
                power: [0.2, 0.0, 0.0],
                penetration: 150.0,
                impulse: 4.0,
            },
            direction: [0.0, 0.0, 1.0],
            offset: [0.0; 3],
            ray: Some(NativeRay { origin: [1.0, 2.0, 3.0], direction: [0.0, 0.0, 1.0], range: 10.0 }),
        }
    }

    fn receipt() -> Receipt {
        Receipt { peer: 1, sequence: 7, followup_tick: None, ammo: 8 }
    }

    fn ack(sequence: u64, host: u64, health: Option<u16>) -> [u8; 36] {
        let mut packet = [0; 36];
        packet[..4].copy_from_slice(b"ZAA1");
        packet[4..12].copy_from_slice(&32u64.to_le_bytes());
        packet[12..20].copy_from_slice(&host.to_le_bytes());
        packet[20..28].copy_from_slice(&sequence.to_le_bytes());
        packet[28..32].copy_from_slice(&u32::from(health.is_some()).to_le_bytes());
        packet[32..36].copy_from_slice(&u32::from(health.unwrap_or(0)).to_le_bytes());
        packet
    }

    #[test]
    fn retries_keep_the_same_sequence_and_acknowledgements_are_single_use() {
        let mut world = World::new();
        let attack = npc_attack(&mut world, 4);
        let mut queue = AttackQueue::default();
        let mut invalid = attack;
        invalid.damage.power[0] = 0.0;
        assert!(!queue.enqueue_batch(&[attack, invalid], world.tick, Some(receipt())));
        for penetration in [f32::NAN, -1.0, MAX_PENETRATION + 1.0] {
            invalid = attack;
            invalid.damage.penetration = penetration;
            assert!(!queue.enqueue_batch(&[attack, invalid], world.tick, Some(receipt())));
        }
        assert!(queue.pending.is_empty());
        assert!(queue.volleys.is_empty());
        assert!(queue.enqueue_batch(&[attack], world.tick, Some(receipt())));
        let mut sent = Vec::new();
        queue.poll(
            &world,
            32,
            |packet| {
                sent.push(packet.to_vec());
                true
            },
            |_| panic!("early expiry"),
        );
        world.tick += 3;
        queue.poll(
            &world,
            32,
            |packet| {
                sent.push(packet.to_vec());
                true
            },
            |_| panic!("early expiry"),
        );
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], sent[1]);
        assert_eq!(&sent[0][..4], b"ZAS2");
        assert_eq!(&sent[0][96..100], &1.0f32.to_le_bytes());
        assert_eq!(&sent[0][120..124], &10.0f32.to_le_bytes());
        assert_eq!(&sent[0][36..40], &24u32.to_le_bytes());
        assert_eq!(&sent[0][52..56], &150.0f32.to_le_bytes());
        assert!(queue.acknowledge(&ack(1, 8, Some(54)), 32).is_none());
        let packet = ack(1, 9, Some(54));
        let result = queue.acknowledge(&packet, 32).unwrap();
        let outcome = result.outcome.unwrap();
        assert_eq!((outcome.receipt.sequence, result.health), (7, Some(54)));
        assert_eq!(outcome.hit, Some(Hit { target: attack.target_id, health: 54 }));
        assert_eq!(result.attack.target, attack.target);
        assert!(queue.acknowledge(&packet, 32).is_none());
        assert!(queue.enqueue_batch(&[attack], world.tick, Some(receipt())));
        world.remove(attack.target_id);
        queue.poll(
            &world,
            32,
            |_| panic!("retired target was sent"),
            |expired| assert_eq!((expired.receipt.sequence, expired.hit), (7, None)),
        );
        assert!(queue.pending.is_empty());
        assert!(queue.volleys.is_empty());
    }

    #[test]
    fn volley_waits_for_later_pellets_and_uses_the_selected_targets_final_health() {
        let mut world = World::new();
        let first = npc_attack(&mut world, 4);
        let other = npc_attack(&mut world, 5);
        let mut queue = AttackQueue::default();
        assert!(queue.enqueue_batch(&[first, first, other, first], world.tick, Some(receipt())));
        // Replies arrive out of order, including a late reply from the first
        // pellet that missed. The first successful pellet selects the target.
        for (sequence, health) in [(4, Some(0)), (3, Some(11)), (1, None)] {
            assert!(queue.acknowledge(&ack(sequence, 9, health), 32).unwrap().outcome.is_none());
        }
        let outcome = queue.acknowledge(&ack(2, 9, Some(50)), 32).unwrap().outcome.unwrap();
        assert_eq!(outcome.hit, Some(Hit { target: first.target_id, health: 0 }));
        assert!(queue.acknowledge(&ack(2, 9, Some(50)), 32).is_none());
        assert!(queue.volleys.is_empty());
    }

    #[test]
    fn expired_pellet_preserves_an_already_confirmed_hit() {
        let mut world = World::new();
        let attack = npc_attack(&mut world, 4);
        let mut queue = AttackQueue::default();
        assert!(queue.enqueue_batch(&[attack, attack], world.tick, Some(receipt())));
        queue.poll(&world, 32, |_| true, |_| panic!("early expiry"));
        assert!(queue.acknowledge(&ack(2, 9, Some(40)), 32).unwrap().outcome.is_none());
        world.tick += LEASE + 1;
        let mut outcomes = Vec::new();
        queue.poll(&world, 32, |_| panic!("expired pellet was sent"), |outcome| outcomes.push(outcome));
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].hit, Some(Hit { target: attack.target_id, health: 40 }));
        assert!(queue.acknowledge(&ack(1, 9, Some(20)), 32).is_none());
    }
}
