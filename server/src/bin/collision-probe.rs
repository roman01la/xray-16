//! Offline real-map validation and query-cost measurement; never joins a session.
use anyhow::{Result, ensure};
use parry3d::math::Vector;
use std::{path::Path, time::Instant};
use zone_server::collision::CollisionMap;
fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .expect("usage: collision-probe MANIFEST.json");
    let started = Instant::now();
    let map = CollisionMap::load(Path::new(&path))?;
    let build_ms = started.elapsed().as_secs_f64() * 1000.;
    let b = &map.manifest.bounds;
    let x = (b.min[0] + b.max[0]) * 0.5;
    let z = (b.min[2] + b.max[2]) * 0.5;
    let origin = Vector::new(x, b.max[1] + 10., z);
    let distance = b.max[1] - b.min[1] + 20.;
    let floor_y = origin.y
        - map
            .ray(origin, -Vector::Y, distance)?
            .expect("no ground at map centre");
    if map.manifest.level == "zaton" {
        ensure!(
            (floor_y - -7.055702).abs() < 0.002,
            "Rust/X-Ray anchor height mismatch: {floor_y}"
        );
    }
    let mut motor_report = serde_json::Value::Null;
    if map.actor_ready() {
        let spawn = map.spawn_feet(x, z)?;
        let mut character = zone_server::movement::Character::new(spawn);
        let mut grounded_ticks = 0;
        let started = Instant::now();
        for _ in 0..300 {
            character.step(&map, 1., 0., false)?;
            grounded_ticks += u32::from(character.grounded);
            ensure!(
                character.feet.y >= b.min[1] - 2.,
                "character fell through level"
            );
        }
        let moved = (character.feet - spawn).length();
        ensure!(
            moved > 25. && moved < 45.,
            "unexpected 10-second movement: {moved}"
        );
        motor_report = serde_json::json!({"ticks":300,"spawn":spawn.to_array(),"end":character.feet.to_array(),"distance":moved,"groundedTicks":grounded_ticks,"totalMs":started.elapsed().as_secs_f64()*1000.});
    }
    let mut samples = Vec::new();
    let mut ray_hits = 0;
    let mut sweep_hits = 0;
    // 30 batches of 200 candidate characters, spread over a 100 x 100 m area.
    // Queries only: not a simulation/replication or player-capacity benchmark.
    for batch in 0..30 {
        let start = Instant::now();
        for i in 0..200 {
            let px = x + ((i * 37 + batch * 3) % 100) as f32 - 50.;
            let pz = z + ((i * 61 + batch * 7) % 100) as f32 - 50.;
            let top = Vector::new(px, origin.y, pz);
            if let Some(toi) = map.ray(top, -Vector::Y, distance)? {
                ray_hits += 1;
                let feet = Vector::new(px, top.y - toi + 0.02, pz);
                if map.sweep_capsule(feet, Vector::new(0.2, 0., 0.))?.is_some() {
                    sweep_hits += 1;
                }
            }
        }
        samples.push(start.elapsed().as_secs_f64() * 1000.);
    }
    samples.sort_by(f64::total_cmp);
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "level":map.manifest.level,"sha256":map.manifest.sha256,
            "vertices":map.manifest.vertices,"triangles":map.manifest.triangles,
            "loadAndBvhMs":build_ms,"actorTriangles":map.actor_triangle_ids.len(),"motor":motor_report,"anchor":[x,floor_y,z],
            "batches":30,"queriesPerBatch":{"rays":200,"capsuleSweepsMax":200},
            "batchMedianMs":samples[15],"batchP95Ms":samples[28],"batchMaxMs":samples[29],
            "rayHits":ray_hits,"sweepHits":sweep_hits,
            "scope":"offline single-character regression and raw geometry queries; not 200-player capacity"
        }))?
    );
    Ok(())
}
