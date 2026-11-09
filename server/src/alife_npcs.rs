//! Atomic, bounded online creature snapshots from the native A-Life host.
use crate::world::{Kind, TICK_HZ, Vec3, World, newer};
use std::{collections::BTreeMap, sync::Arc};

const MAX_NPCS: usize = 512;
const PER_PACKET: usize = 10;
const HEADER: usize = 36;
const ROW: usize = 188;
pub const MAX_PACKET: usize = HEADER + PER_PACKET * ROW;
const LEASE: u32 = TICK_HZ * 12 / 10;

pub fn valid_model(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 127
        && path.split('\\').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'.' | b'-'))
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NpcMotion {
    pub id: u32,
    pub time_ms: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct NativeTarget {
    pub host: u64,
    pub id: u16,
    pub spawn: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct NativeBounds {
    pub center: [f32; 3],
    pub half: [f32; 3],
}

impl NativeBounds {
    pub fn world_center(&self, origin: parry3d::math::Vector, yaw: f32) -> parry3d::math::Vector {
        origin + rotate_yaw(parry3d::math::Vector::from_array(self.center), yaw)
    }
}

pub(crate) fn rotate_yaw(v: parry3d::math::Vector, yaw: f32) -> parry3d::math::Vector {
    let (sin, cos) = yaw.sin_cos();
    parry3d::math::Vector::new(cos * v.x - sin * v.z, v.y, sin * v.x + cos * v.z)
}

#[derive(Clone, Debug)]
pub struct NativeNpc {
    pub target: NativeTarget,
    pub model: Arc<str>,
    pub bounds: NativeBounds,
    pub motion: Option<NpcMotion>,
}

struct Npc {
    target: NativeTarget,
    bounds: NativeBounds,
    position: Vec3,
    yaw: f32,
    health: u16,
    motion: Option<NpcMotion>,
    model: String,
}

struct Frame {
    tick: u32,
    host: u64,
    total: usize,
    parts: Vec<Option<Vec<Npc>>>,
}

#[derive(Default)]
pub struct NpcRoster {
    pending: Option<Frame>,
    last: Option<u32>,
    active: BTreeMap<NativeTarget, u32>,
    confirmed_deaths: BTreeMap<NativeTarget, u32>,
}

fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn decode_row(row: &[u8], host: u64) -> Option<Npc> {
    let native_id = u16::try_from(word(row, 0))
        .ok()
        .filter(|id| *id != u16::MAX)?;
    let [x, y, z, yaw] = [4, 8, 12, 16].map(|at| f32::from_bits(word(row, at)));
    if ![x, y, z].iter().all(|n| n.abs() <= 100_000.0) || !(-7.0..=7.0).contains(&yaw) {
        return None;
    }
    let health = u16::try_from(word(row, 20)).ok().filter(|n| *n <= 100)?;
    let time_ms = u16::try_from(word(row, 28)).ok()?;
    let motion = (word(row, 24) != u32::MAX).then(|| NpcMotion {
        id: word(row, 24),
        time_ms,
    });
    let target = NativeTarget {
        host,
        id: native_id,
        spawn: word(row, 32),
    };
    let read = |at| f32::from_bits(word(row, at));
    let bounds = NativeBounds {
        center: [36, 40, 44].map(read),
        half: [48, 52, 56].map(read),
    };
    if !bounds.center.iter().all(|n| n.abs() <= 30.0)
        || !bounds.half.iter().all(|n| (0.025..=30.0).contains(n))
    {
        return None;
    }
    let model = &row[60..];
    let end = model.iter().position(|&b| b == 0)?;
    let model = std::str::from_utf8(&model[..end]).ok()?;
    if !valid_model(model) {
        return None;
    }
    Some(Npc {
        target,
        bounds,
        position: Vec3 { x, y, z },
        yaw,
        health,
        motion,
        model: model.to_owned(),
    })
}

impl NpcRoster {
    pub fn confirm_death(&mut self, target: NativeTarget, id: u32, world: &mut World) {
        if self.active.get(&target) == Some(&id)
            && let Some(npc) = world.entities.get_mut(&id)
        {
            npc.health = 0;
            npc.velocity = Vec3::default();
            // A-Life may retire the object before its next roster. Give peers
            // time to receive the authoritative zero before removing the replica.
            self.confirmed_deaths.entry(target).or_insert(world.tick);
        }
    }

    pub fn ingest(&mut self, bytes: &[u8], epoch: u64, world: &mut World) {
        if bytes.len() < HEADER
            || &bytes[..4] != b"ZAN2"
            || u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != epoch
        {
            return;
        }
        let tick = word(bytes, 4);
        if world.tick.wrapping_sub(tick) > LEASE || self.last.is_some_and(|last| !newer(tick, last))
        {
            return;
        }
        let host = u64::from_le_bytes(bytes[16..24].try_into().unwrap());
        let [part, parts, total] = [24, 28, 32].map(|at| word(bytes, at) as usize);
        if total > MAX_NPCS || parts != total.div_ceil(PER_PACKET).max(1) || part >= parts {
            return;
        }
        let count = (total - part * PER_PACKET).min(PER_PACKET);
        if bytes.len() != HEADER + count * ROW {
            return;
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|frame| newer(frame.tick, tick))
        {
            return;
        }
        let Some(rows) = bytes[HEADER..]
            .chunks_exact(ROW)
            .map(|row| decode_row(row, host))
            .collect::<Option<Vec<_>>>()
        else {
            return;
        };
        if self.pending.as_ref().is_none_or(|frame| frame.tick != tick) {
            self.pending = Some(Frame {
                tick,
                host,
                total,
                parts: (0..parts).map(|_| None).collect(),
            });
        }
        let frame = self.pending.as_mut().unwrap();
        if frame.total != total || frame.host != host || frame.parts[part].is_some() {
            return;
        }
        frame.parts[part] = Some(rows);
        if frame.parts.iter().any(Option::is_none) {
            return;
        }
        let mut rows: Vec<_> = self
            .pending
            .take()
            .unwrap()
            .parts
            .into_iter()
            .flatten()
            .flatten()
            .collect();
        rows.sort_unstable_by_key(|row| row.target);
        if rows
            .windows(2)
            .any(|pair| pair[0].target.id == pair[1].target.id)
        {
            return;
        }
        let elapsed = self.last.map_or(0, |last| tick.wrapping_sub(last));
        self.last = Some(tick);
        self.confirmed_deaths
            .retain(|target, died| target.host == host && world.tick.wrapping_sub(*died) < TICK_HZ);
        self.active.retain(|id, local| {
            if rows.binary_search_by_key(id, |npc| npc.target).is_ok()
                || self.confirmed_deaths.contains_key(id)
            {
                return true;
            }
            world.remove(*local);
            false
        });
        for row in rows {
            let local = *self
                .active
                .entry(row.target)
                .or_insert_with(|| world.spawn(Kind::Npc, row.position));
            let npc = world
                .entities
                .get_mut(&local)
                .expect("native replica remains indexed");
            if elapsed > 0 && npc.position.distance_squared(row.position) <= 400.0 {
                let scale = TICK_HZ as f32 / elapsed as f32;
                npc.velocity = Vec3 {
                    x: (row.position.x - npc.position.x) * scale,
                    y: (row.position.y - npc.position.y) * scale,
                    z: (row.position.z - npc.position.z) * scale,
                };
            } else {
                npc.velocity = Vec3::default();
            }
            npc.position = row.position;
            npc.yaw = row.yaw;
            if npc.health != 0 {
                npc.health = row.health;
            }
            let model = npc
                .native
                .as_ref()
                .filter(|old| old.model.as_ref() == row.model)
                .map(|old| old.model.clone())
                .unwrap_or_else(|| Arc::from(row.model));
            npc.native = Some(NativeNpc {
                target: row.target,
                model,
                bounds: row.bounds,
                motion: row.motion,
            });
        }
    }

    pub fn expire(&mut self, world: &mut World) {
        if self
            .last
            .is_some_and(|last| world.tick.wrapping_sub(last) > LEASE)
        {
            self.confirmed_deaths.clear();
            for (_, local) in std::mem::take(&mut self.active) {
                world.remove(local);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(tick: u32, part: usize, total: usize, first_id: u32, x: f32) -> Vec<u8> {
        let count = (total - part * PER_PACKET).min(PER_PACKET);
        let mut bytes = vec![0; HEADER + count * ROW];
        bytes[..4].copy_from_slice(b"ZAN2");
        bytes[8..16].copy_from_slice(&9u64.to_le_bytes());
        bytes[16..24].copy_from_slice(&5u64.to_le_bytes());
        for (at, value) in [
            (4, tick),
            (24, part as u32),
            (28, total.div_ceil(PER_PACKET).max(1) as u32),
            (32, total as u32),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (i, row) in bytes[HEADER..].chunks_exact_mut(ROW).enumerate() {
            for (at, value) in [
                (0, first_id + i as u32),
                (4, x.to_bits()),
                (20, 75),
                (24, 1),
                (28, 123),
                (32, 1),
                (48, 0.3f32.to_bits()),
                (52, 0.4f32.to_bits()),
                (56, 0.7f32.to_bits()),
            ] {
                row[at..at + 4].copy_from_slice(&value.to_le_bytes());
            }
            let model = b"monsters\\dog\\dog_01";
            row[60..60 + model.len()].copy_from_slice(model);
        }
        bytes
    }

    #[test]
    fn native_roster_commits_complete_frames_and_expires_without_reusing_ids() {
        let mut world = World::new();
        world.tick = 10;
        let observer = world.spawn(Kind::Player, Vec3::default());
        let mut roster = NpcRoster::default();
        roster.ingest(&packet(10, 1, 11, 10, 4.0), 8, &mut world);
        assert_eq!(world.entities.len(), 1);
        roster.ingest(&packet(10, 1, 11, 10, 4.0), 9, &mut world);
        assert_eq!(world.entities.len(), 1);
        roster.ingest(&packet(10, 0, 11, 0, 4.0), 9, &mut world);
        assert_eq!(world.entities.len(), 12);
        let target = NativeTarget {
            host: 5,
            id: 0,
            spawn: 1,
        };
        let id = roster.active[&target];
        world.tick = 13;
        roster.ingest(&packet(13, 0, 1, 0, 5.0), 9, &mut world);
        world.step();
        let visible = world.visible_to(observer);
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[1].id, id);
        assert_eq!(visible[1].position.x, 5.0);
        assert_eq!(visible[1].velocity.x, 10.0);
        assert_eq!(visible[1].health, 75);
        assert_eq!(
            visible[1].native_motion,
            Some(NpcMotion {
                id: 1,
                time_ms: 123
            })
        );
        assert_eq!(
            world.entities[&id]
                .native
                .as_ref()
                .map(|npc| npc.model.as_ref()),
            Some("monsters\\dog\\dog_01")
        );
        roster.ingest(&packet(12, 0, 0, 0, 0.0), 9, &mut world);
        assert!(world.entities.contains_key(&id));
        world.tick += LEASE;
        roster.expire(&mut world);
        assert!(!world.entities.contains_key(&id));
        roster.ingest(&packet(world.tick, 0, 1, 0, 5.0), 9, &mut world);
        assert_ne!(roster.active[&target], id);
    }

    #[test]
    fn confirmed_native_death_is_visible_even_if_the_next_roster_retires_it() {
        let mut world = World::new();
        let first = world.spawn(Kind::Player, Vec3::default());
        let second = world.spawn(Kind::Player, Vec3::default());
        let mut roster = NpcRoster::default();
        roster.ingest(&packet(0, 0, 1, 8, 5.0), 9, &mut world);
        let target = NativeTarget {
            host: 5,
            id: 8,
            spawn: 1,
        };
        let id = roster.active[&target];
        roster.confirm_death(NativeTarget { spawn: 2, ..target }, id, &mut world);
        assert_eq!(world.entities[&id].health, 75);
        roster.confirm_death(target, id, &mut world);
        world.tick = 3;
        roster.ingest(&packet(3, 0, 1, 8, 5.0), 9, &mut world);
        world.tick = 6;
        roster.ingest(&packet(6, 0, 0, 0, 0.0), 9, &mut world);
        world.step();
        for observer in [first, second] {
            assert!(
                world
                    .visible_to(observer)
                    .iter()
                    .any(|row| row.id == id && row.health == 0)
            );
        }
        world.tick = TICK_HZ;
        roster.ingest(&packet(TICK_HZ, 0, 0, 0, 0.0), 9, &mut world);
        assert!(!world.entities.contains_key(&id));
    }
}
