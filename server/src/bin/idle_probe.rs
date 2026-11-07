//! Real-map idle regression, including the terrain used by the weapon test.
use anyhow::{Result, ensure};
use std::path::Path;
use zone_server::{collision::CollisionMap, movement::Character};
fn main() -> Result<()> {
    let path = std::env::args().nth(1).expect("usage: idle_probe MANIFEST");
    let map = CollisionMap::load(Path::new(&path))?;
    let mut report = Vec::new();
    for x in [87.599976, 102.599976, 107.599976] {
        let spawn = map.spawn_feet(x, 115.)?;
        let mut c = Character::new(spawn);
        for _ in 0..30 {
            c.step(&map, 0., 0., false)?;
        }
        let start = c.feet;
        for _ in 0..300 {
            c.step(&map, 0., 0., false)?;
        }
        let drift = ((c.feet.x - start.x).powi(2) + (c.feet.z - start.z).powi(2)).sqrt();
        ensure!(
            c.grounded && drift < 0.001,
            "idle drift at {x}: {drift}, grounded {}",
            c.grounded
        );
        report.push(serde_json::json!({"spawn":spawn.to_array(),"end":c.feet.to_array(),"idleTicks":330,"driftMetres":drift}));
    }
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
