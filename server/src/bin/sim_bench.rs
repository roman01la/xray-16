//! Measures simulation + AOI + encoding, not WebRTC/DTLS/network or real AI.
use std::{hint::black_box, time::Instant};
use zone_server::{protocol::encode_snapshots, world::*};
fn main() {
    for crowded in [false, true] {
        let mut w = World::new();
        let mut players = vec![];
        for n in 0..1200 {
            let p = if crowded {
                Vec3 {
                    x: (n % 20) as f32,
                    y: 0.,
                    z: (n / 20 % 20) as f32,
                }
            } else {
                Vec3 {
                    x: (n % 40) as f32 * 45.,
                    y: 0.,
                    z: (n / 40) as f32 * 45.,
                }
            };
            let id = w.spawn(if n < 200 { Kind::Player } else { Kind::Npc }, p);
            if n < 200 {
                players.push(id);
            }
        }
        let mut times = vec![];
        let mut bytes = 0u64;
        for tick in 1..=600 {
            let start = Instant::now();
            for &id in &players {
                w.input(
                    id,
                    Input {
                        sequence: tick,
                        x: 0.,
                        z: 0.,
                        yaw: 0.,
                        sprint: false,
                        jump: false,
                        crouch: false,
                    },
                );
            }
            w.step();
            if tick % SNAPSHOT_EVERY == 0 {
                for &id in &players {
                    for packet in encode_snapshots(w.tick, id, tick, &w.visible_to(id)) {
                        bytes += packet.len() as u64;
                        black_box(packet);
                    }
                }
            }
            times.push(start.elapsed().as_secs_f64() * 1000.);
        }
        times.sort_by(f64::total_cmp);
        println!(
            "{}: 200 players + 1000 stationary NPCs; tick incl replication p50={:.3}ms p95={:.3}ms max={:.3}ms; application egress={:.2} MiB/s at 30Hz (excludes WebRTC)",
            if crowded { "crowded" } else { "spread" },
            times[300],
            times[570],
            times[599],
            bytes as f64 / (600. / 30.) / 1048576.
        );
    }
}
