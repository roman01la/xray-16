//! Little-endian versioned binary packets. Full, chunked snapshots avoid
//! dependency on lost baselines. No message exceeds 1100 application bytes.
use crate::world::{Input, SnapshotEntity};
pub const MAGIC: u16 = 0x5a58;
pub const VERSION: u8 = 2;
pub const MAX_PACKET: usize = 1100;
pub const HEADER: usize = 24;
pub const ENTITY_BYTES: usize = 36;
pub const PER_PACKET: usize = (MAX_PACKET - HEADER) / ENTITY_BYTES;
pub fn decode_input(data: &[u8]) -> Option<Input> {
    if data.len() != 20
        || u16::from_le_bytes(data[0..2].try_into().ok()?) != MAGIC
        || data[2] != VERSION
        || data[3] != 1
    {
        return None;
    }
    let sequence = u32::from_le_bytes(data[4..8].try_into().ok()?);
    let x = i16::from_le_bytes(data[8..10].try_into().ok()?) as f32 / 32767.0;
    let z = i16::from_le_bytes(data[10..12].try_into().ok()?) as f32 / 32767.0;
    let yaw = f32::from_le_bytes(data[12..16].try_into().ok()?);
    let flags = u16::from_le_bytes(data[16..18].try_into().ok()?);
    if !yaw.is_finite() || flags & !7 != 0 || data[18..20] != [0, 0] {
        return None;
    }
    Some(Input {
        sequence,
        x,
        z,
        yaw,
        sprint: flags & 1 != 0,
        jump: flags & 2 != 0,
        crouch: flags & 4 != 0,
    })
}
pub fn encode_snapshots(
    tick: u32,
    player: u32,
    ack: u32,
    entities: &[SnapshotEntity],
) -> Vec<Vec<u8>> {
    let parts = entities.len().max(1).div_ceil(PER_PACKET);
    let mut output = Vec::with_capacity(parts);
    for part in 0..parts {
        let start = (part * PER_PACKET).min(entities.len());
        let end = (start + PER_PACKET).min(entities.len());
        let chunk = &entities[start..end];
        let mut b = Vec::with_capacity(HEADER + chunk.len() * ENTITY_BYTES);
        b.extend(MAGIC.to_le_bytes());
        b.extend([VERSION, 2]);
        for n in [tick, player, ack] {
            b.extend(n.to_le_bytes());
        }
        for n in [part as u16, parts as u16, chunk.len() as u16, 0] {
            b.extend(n.to_le_bytes());
        }
        for e in chunk {
            b.extend(e.id.to_le_bytes());
            for f in [
                e.position.x,
                e.position.y,
                e.position.z,
                e.velocity.x,
                e.velocity.y,
                e.velocity.z,
                e.yaw,
            ] {
                b.extend(f.to_le_bytes());
            }
            b.extend(e.health.to_le_bytes());
            b.extend([e.kind, e.flags]);
        }
        output.push(b);
    }
    output
}
