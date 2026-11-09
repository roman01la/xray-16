//! Cross-language codec fixtures; no game data required.
use zone_server::{
    replication::Replicator,
    world::{SnapshotEntity, Vec3},
};
fn main() {
    let mut entities: Vec<_> = (1..=200)
        .map(|id| SnapshotEntity {
            id,
            position: Vec3 {
                x: if id == 1 { 1.234567 } else { -12.345 },
                y: 3.125,
                z: 830.,
            },
            velocity: Vec3 {
                x: 0.01234,
                y: -3.456,
                z: 0.,
            },
            yaw: 1.2345,
            health: 100,
            kind: 1,
            flags: 14,
            native_motion: None,
        })
        .collect();
    let mut r = Replicator::default();
    let mut frames = Vec::new();
    frames.push(r.encode(1, 1, 7, &entities));
    r.acknowledge(1);
    entities[1].position.x = -9.999;
    frames.push(r.encode(2, 1, 8, &entities));
    entities.remove(1);
    frames.push(r.encode(3, 1, 9, &entities));
    frames.push(r.encode(4, 1, 10, &entities));
    r.acknowledge(4);
    frames.push(r.encode(5, 1, 11, &entities));
    r.resync();
    frames.push(r.encode(6, 1, 12, &entities));
    println!("{}", serde_json::to_string(&frames).unwrap());
}
