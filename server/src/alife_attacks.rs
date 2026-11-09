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
const COMMAND_BYTES: usize = 96;

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
}

#[derive(Clone, Copy)]
pub struct Receipt {
    pub peer: u64,
    pub sequence: u32,
    pub followup_tick: Option<u32>,
    pub ammo: u16,
    pub target: u32,
}

pub struct AttackResult {
    pub attack: NativeAttack,
    pub receipt: Option<Receipt>,
    pub health: Option<u16>,
}

struct Pending {
    tick: u32,
    sent: Option<u32>,
    attack: NativeAttack,
    receipt: Option<Receipt>,
}

#[derive(Default)]
pub struct AttackQueue {
    next: u64,
    pending: BTreeMap<u64, Pending>,
}

impl AttackQueue {
    pub fn enqueue_batch(&mut self, attacks: &[(NativeAttack, Option<Receipt>)], tick: u32) -> bool {
        if attacks.is_empty() || attacks.len() > MAX_PENDING - self.pending.len()
            || attacks.iter().any(|(attack, _)| {
                !attack.damage.power.iter().all(|p| (0.0..=100.0).contains(p))
                    || attack.damage.power[0] <= 0.0
                    || !(0.0..=MAX_PENETRATION).contains(&attack.damage.penetration)
                    || !(0.0..=1_000_000.0).contains(&attack.damage.impulse)
            })
        {
            return false;
        }
        for &(attack, receipt) in attacks {
            self.next = self.next.checked_add(1).expect("native attack sequence exhausted");
            self.pending.insert(self.next, Pending { tick, sent: None, attack, receipt });
        }
        true
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
        Some(AttackResult {
            attack: pending.attack,
            receipt: pending.receipt,
            health: (word(28) == 1).then(|| word(32) as u16),
        })
    }

    pub fn poll(
        &mut self,
        world: &World,
        epoch: u64,
        mut send: impl FnMut(&[u8]) -> bool,
        mut expired: impl FnMut(Receipt),
    ) {
        self.pending.retain(|_, request| {
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
                if let Some(receipt) = request.receipt {
                    expired(receipt);
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
            if !send(&encode(epoch, sequence, pending)) {
                break;
            }
            pending.sent = Some(world.tick);
        }
    }
}

fn encode(epoch: u64, sequence: u64, pending: &Pending) -> [u8; COMMAND_BYTES] {
    let mut bytes = [0; COMMAND_BYTES];
    bytes[..4].copy_from_slice(b"ZAS1");
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
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        alife_npcs::{NativeBounds, NativeNpc},
        world::{Kind, Vec3},
    };

    #[test]
    fn retries_keep_the_same_sequence_and_acknowledgements_are_single_use() {
        let mut world = World::new();
        let id = world.spawn(Kind::Npc, Vec3::default());
        let target = NativeTarget {
            host: 9,
            id: 4,
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
        let mut queue = AttackQueue::default();
        let receipt = Receipt {
            peer: 1,
            sequence: 7,
            followup_tick: None,
            ammo: 8,
            target: id,
        };
        let attack = NativeAttack {
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
        };
        let mut invalid = attack;
        invalid.damage.power[0] = 0.0;
        assert!(!queue.enqueue_batch(&[(attack, Some(receipt)), (invalid, None)], world.tick));
        for penetration in [f32::NAN, -1.0, MAX_PENETRATION + 1.0] {
            invalid = attack;
            invalid.damage.penetration = penetration;
            assert!(!queue.enqueue_batch(&[(attack, Some(receipt)), (invalid, None)], world.tick));
        }
        assert!(queue.pending.is_empty());
        assert!(queue.enqueue_batch(&[(attack, Some(receipt))], world.tick));
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
        assert_eq!(&sent[0][36..40], &24u32.to_le_bytes());
        assert_eq!(&sent[0][52..56], &150.0f32.to_le_bytes());
        let mut ack = [0; 36];
        ack[..4].copy_from_slice(b"ZAA1");
        ack[4..12].copy_from_slice(&32u64.to_le_bytes());
        ack[12..20].copy_from_slice(&8u64.to_le_bytes());
        ack[20..28].copy_from_slice(&1u64.to_le_bytes());
        ack[28..32].copy_from_slice(&1u32.to_le_bytes());
        ack[32..36].copy_from_slice(&54u32.to_le_bytes());
        assert!(queue.acknowledge(&ack, 32).is_none());
        ack[12..20].copy_from_slice(&9u64.to_le_bytes());
        let result = queue.acknowledge(&ack, 32).unwrap();
        assert_eq!(
            (result.receipt.unwrap().sequence, result.health),
            (7, Some(54))
        );
        assert_eq!(result.attack.target, target);
        assert!(queue.acknowledge(&ack, 32).is_none());
        assert!(queue.enqueue_batch(&[(attack, Some(receipt))], world.tick));
        world.remove(id);
        queue.poll(
            &world,
            32,
            |_| panic!("retired target was sent"),
            |expired| assert_eq!(expired.sequence, 7),
        );
        assert!(queue.pending.is_empty());
    }
}
