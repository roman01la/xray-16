//! Optimized map-backed CPU/encoding benchmark; no WebRTC transport claim.
use anyhow::{Result, ensure};
use std::{path::Path, sync::Arc, time::Instant};
use zone_server::{
    collision::CollisionMap,
    replication::Replicator,
    world::{Input, Kind, TICK_HZ, World},
};
fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p) as usize]
}
fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("usage: map_bench MANIFEST");
    let map = Arc::new(CollisionMap::load(Path::new(&path))?);
    let mut reports = Vec::new();
    for dense in [true, false] {
        let mut world = World::with_collision(map.clone())?;
        let mut ids = Vec::new();
        for i in 0..4000 {
            if ids.len() == 200 {
                break;
            }
            let spacing = if dense { 0.5 } else { 12. };
            let x = 87.6 + ((i % 20) as f32 - 10.) * spacing;
            let z = 115. + ((i / 20) as f32 - 5.) * spacing;
            if let Ok(id) = world.spawn_on_map(Kind::Player, x, z) {
                ids.push(id);
            }
        }
        ensure!(ids.len() == 200, "could not validate 200 map spawns");
        let mut peers: Vec<_> = ids.iter().map(|_| Replicator::default()).collect();
        let mut ticks = Vec::new();
        let mut replication = Vec::new();
        let mut bytes = 0usize;
        for tick in 1..=600 {
            for (i, id) in ids.iter().enumerate() {
                let angle = (i as f32 * 0.5) + (tick / 90) as f32;
                world.input(
                    *id,
                    Input {
                        sequence: tick,
                        x: angle.sin(),
                        z: angle.cos(),
                        yaw: angle,
                        pitch: 0.0,
                        sprint: false,
                        jump: false,
                        crouch: false,
                        walk: false,
                        aiming: false,
                    },
                );
            }
            let started = Instant::now();
            world.step();
            ticks.push(started.elapsed().as_secs_f64() * 1000.);
            if tick % 2 == 0 {
                let start = Instant::now();
                for (id, peer) in ids.iter().zip(&mut peers) {
                    // 133 ms round-trip ACK delay with deterministic 10% ACK loss.
                    if tick > 4 && tick % 20 != 0 {
                        peer.acknowledge(tick - 4);
                    }
                    for b in peer.encode(
                        world.tick,
                        *id,
                        world.entities[id].last_input(),
                        &world.visible_to(*id),
                    ) {
                        bytes += b.len();
                    }
                }
                replication.push(start.elapsed().as_secs_f64() * 1000.);
            }
        }
        ensure!(world.movement_errors == 0, "movement errors in benchmark");
        ensure!(
            world.entities.values().all(|e| e.position.x.is_finite()
                && e.position.y.is_finite()
                && e.position.z.is_finite()),
            "invalid world state"
        );
        reports.push(serde_json::json!({"layout":if dense{"crowded"}else{"spread"},"players":ids.len(),"ticks":600,"tickHz":TICK_HZ,"movementP50Ms":percentile(&mut ticks,0.5),"movementP95Ms":percentile(&mut ticks,0.95),"movementMaxMs":percentile(&mut ticks,1.),"replicationP95Ms":percentile(&mut replication,0.95),"deltaSnapshotMiBPerSecond":bytes as f64/20./1048576.,"movementErrors":world.movement_errors,"scope":"offline CPU + acknowledged delta encoding, 133ms ACK delay/10% ACK loss; no WebRTC or client rendering"}));
    }
    println!("{}", serde_json::to_string_pretty(&reports)?);
    Ok(())
}
