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
    poses: BTreeMap<NativeTarget, (u32, Arc<[u8]>)>,
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

pub const NPC_POSE_OPCODE: u8 = 33;
pub const NPC_SOUND_OPCODE: u8 = 34;
pub const POSE_HEADER: usize = 32;
pub const BONE_BYTES: usize = 10;
const SHOT: u8 = 8;
const SHOT_LAUNCHER: u8 = 16;
const WEAPON_FLAGS: u8 = 31;
const SHOT_BYTES: usize = 4 + BONE_BYTES;

fn model_key(model: &str) -> u32 {
    model.bytes().fold(2166136261, |hash, byte| (hash ^ u32::from(byte)).wrapping_mul(16777619))
}

fn valid_pose(data: &[u8]) -> bool {
    if data.len() < POSE_HEADER || data[4] > 1 || !(1..=64).contains(&data[5]) {
        return false;
    }
    let weapon_at = POSE_HEADER + usize::from(data[5]) * BONE_BYTES;
    let weapon_bytes = usize::from(data[6]);
    let flags = data[7];
    let weapon_end = weapon_at + if weapon_bytes == 0 { 0 } else { BONE_BYTES + weapon_bytes };
    let expected = weapon_end + if flags & SHOT != 0 { SHOT_BYTES } else { 0 };
    if expected != data.len() || weapon_bytes > 127 || flags & !WEAPON_FLAGS != 0 ||
        (weapon_bytes == 0 && flags != 0) || (flags & SHOT_LAUNCHER != 0 && flags & SHOT == 0) ||
        ![16, 20, 24].into_iter().all(|offset| f32::from_bits(word(data, offset)).abs() <= 100_000.0)
    {
        return false;
    }
    weapon_bytes == 0 || data[weapon_at + BONE_BYTES..weapon_end].iter()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'_' | b'.' | b'-'))
}

pub struct NativeSound {
    pub host: u64,
    pub tick: u32,
    pub sequence: u32,
    pub position: Vec3,
    pub range: f32,
    pub data: Vec<u8>,
}

pub fn native_sounds(rows: &[u8], host: u64, tick: u32) -> impl Iterator<Item = NativeSound> + '_ {
    rows.chunks_exact(160).take(32).filter_map(move |row| {
        let [x, y, z, volume, frequency, range] = [4, 8, 12, 16, 20, 24]
            .map(|at| f32::from_bits(word(row, at)));
        let end = row[28..].iter().position(|byte| *byte == 0)? + 28;
        let name = std::str::from_utf8(&row[28..end]).ok()?;
        if ![x, y, z].iter().all(|v| v.abs() <= 100_000.0)
            || !(0.0..=4.0).contains(&volume) || !(0.1..=4.0).contains(&frequency)
            || !(1.0..=100.0).contains(&range) || name.len() > 127
            || !valid_model(&name.replace('/', "\\").replace(' ', "_"))
        {
            return None;
        }
        Some(NativeSound { host, tick, sequence: word(row, 0), position: Vec3 { x, y, z }, range,
            data: row[4..end].to_vec() })
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
        self.poses.retain(|target, _| self.active.contains_key(target));
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

    pub fn ingest_hitboxes(&self, bytes: &[u8], epoch: u64, host: u64, world: &mut World) {
        if bytes.len() < 44 || &bytes[..4] != b"ZBN1"
            || u64::from_le_bytes(bytes[8..16].try_into().unwrap()) != epoch
            || u64::from_le_bytes(bytes[16..24].try_into().unwrap()) != host
        { return; }
        let tick = word(bytes, 4);
        if world.tick.wrapping_sub(tick) > crate::alife_hitboxes::MAX_AGE { return; }
        let Ok(id) = u16::try_from(word(bytes, 24)) else { return; };
        let target = NativeTarget { host, id, spawn: word(bytes, 28) };
        let Some(local) = self.active.get(&target) else { return; };
        let Some(npc) = world.entities.get_mut(local) else { return; };
        if npc.kind != Kind::Npc || npc.health == 0 || npc.travelling
            || npc.native.as_ref().is_none_or(|n| n.target != target)
            || npc.hitboxes.as_ref().is_some_and(|(previous, _)| !newer(tick, *previous))
        { return; }
        let feet = parry3d::math::Vector::from_array([32, 36, 40].map(|at| f32::from_bits(word(bytes, at))));
        if let Some(boxes) = crate::alife_hitboxes::Hitboxes::decode(feet, &bytes[44..]) {
            npc.hitboxes = Some((tick, Arc::new(boxes)));
        }
    }

    pub fn ingest_poses(&mut self, mut rows: &[u8], host: u64, tick: u32) {
        while let Some((header, rest)) = rows.split_at_checked(12) {
            let Some((data, remainder)) = rest.split_at_checked(word(header, 8) as usize) else { return };
            rows = remainder;
            let Ok(id) = u16::try_from(word(header, 0)) else { continue };
            let target = NativeTarget { host, id, spawn: word(header, 4) };
            if !self.active.contains_key(&target) || !valid_pose(data) {
                continue;
            }
            if self.poses.get(&target).is_none_or(|(old, _)| newer(tick, *old)) {
                self.poses.insert(target, (tick, Arc::from(data)));
            }
        }
    }

    pub fn pose(&self, npc: &NativeNpc) -> Option<(u32, &[u8])> {
        let (tick, data) = self.poses.get(&npc.target)?;
        // Visual changes can cross the pose stream in either order.
        (word(data, 0) == model_key(&npc.model)).then_some((*tick, data))
    }

    pub fn expire(&mut self, world: &mut World) {
        if self
            .last
            .is_some_and(|last| world.tick.wrapping_sub(last) > LEASE)
        {
            self.confirmed_deaths.clear();
            self.poses.clear();
            for (_, local) in std::mem::take(&mut self.active) {
                world.remove(local);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pose_validates_stock_weapon_section_and_optional_shot() {
        let weapon = b"wpn_ak74";
        let section_start = POSE_HEADER + 2 * BONE_BYTES;
        let mut pose = vec![0; section_start + weapon.len()];
        pose[5] = 1;
        pose[6] = weapon.len() as u8;
        pose[7] = 1;
        pose[section_start..].copy_from_slice(weapon);
        assert!(valid_pose(&pose));

        pose[7] = SHOT | SHOT_LAUNCHER;
        assert!(!valid_pose(&pose));
        pose.extend_from_slice(&[0; SHOT_BYTES]);
        assert!(valid_pose(&pose));
        pose[section_start] = b'\\';
        assert!(!valid_pose(&pose));
    }

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
    fn npc_hitboxes_are_bound_to_host_spawn_freshness_and_liveness() {
        use parry3d::{math::Vector, query::Ray};
        let mut world = World::new();
        world.tick = 10;
        let mut roster = NpcRoster::default();
        roster.ingest(&packet(10, 0, 1, 0, 0.0), 9, &mut world);
        let target = NativeTarget { host: 5, id: 0, spawn: 1 };
        let local = roster.active[&target];
        let mut shapes = vec![0u8; 44 + 96];
        shapes[..4].copy_from_slice(b"ZBN1");
        shapes[4..8].copy_from_slice(&10u32.to_le_bytes());
        shapes[8..16].copy_from_slice(&9u64.to_le_bytes());
        shapes[16..24].copy_from_slice(&5u64.to_le_bytes());
        shapes[28..32].copy_from_slice(&1u32.to_le_bytes());
        shapes[44] = 2;
        shapes[48..52].copy_from_slice(b"head");
        shapes[88..92].copy_from_slice(&5.0f32.to_le_bytes());
        shapes[92..96].copy_from_slice(&0.5f32.to_le_bytes());
        for (epoch, host) in [(8, 5), (9, 6)] {
            roster.ingest_hitboxes(&shapes, epoch, host, &mut world);
            assert!(world.entities[&local].hitboxes.is_none());
        }
        let mut wrong_spawn = shapes.clone();
        wrong_spawn[28..32].copy_from_slice(&2u32.to_le_bytes());
        roster.ingest_hitboxes(&wrong_spawn, 9, 5, &mut world);
        assert!(world.entities[&local].hitboxes.is_none());
        roster.ingest_hitboxes(&shapes, 9, 5, &mut world);
        let (_, boxes) = world.entities[&local].hitboxes.as_ref().unwrap();
        let (distance, bone) = boxes.cast(&Ray::new(Vector::ZERO, Vector::Z), 10.0, Vector::ZERO).unwrap();
        assert!((distance - 4.5).abs() < 0.0001);
        assert_eq!(&*bone, "head");
        // Duplicate or old packets must not replace newer geometry.
        shapes[88..92].copy_from_slice(&7.0f32.to_le_bytes());
        roster.ingest_hitboxes(&shapes, 9, 5, &mut world);
        assert!((world.entities[&local].hitboxes.as_ref().unwrap().1
            .cast(&Ray::new(Vector::ZERO, Vector::Z), 10.0, Vector::ZERO).unwrap().0 - 4.5).abs() < 0.0001);
        world.entities.get_mut(&local).unwrap().hitboxes = None;
        world.tick = 16;
        roster.ingest_hitboxes(&shapes, 9, 5, &mut world);
        assert!(world.entities[&local].hitboxes.is_none());
        shapes[4..8].copy_from_slice(&16u32.to_le_bytes());
        roster.confirm_death(target, local, &mut world);
        roster.ingest_hitboxes(&shapes, 9, 5, &mut world);
        assert!(world.entities[&local].hitboxes.is_none());
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
