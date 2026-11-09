//! Real-map native/WASM traversal comparison fixtures, not full controller parity.
use anyhow::{Result, ensure};
use std::path::Path;
use zone_server::{collision::CollisionMap, movement::Character};
fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .expect("usage: traversal_probe MANIFEST");
    let map = CollisionMap::load(Path::new(&path))?;
    let mut routes = Vec::new();
    let mut skipped = 0;
    for row in -2..=2 {
        for col in -2..=2 {
            let Ok(spawn) = map.spawn_feet(87.6 + col as f32 * 16., 115. + row as f32 * 16.) else {
                skipped += 1;
                continue;
            };
            let mut motor = Character::new(spawn);
            let mut commands = Vec::new();
            let mut checkpoints = Vec::new();
            let mut grounded = 0;
            let mut crouched = 0;
            let mut airborne = 0;
            for tick in 0..600 {
                let direction = match (tick / 75) % 4 {
                    0 => (1., 0.),
                    1 => (0., 1.),
                    2 => (-1., 0.),
                    _ => (0., -1.),
                };
                let sprint = tick % 120 < 30;
                let jump = tick % 90 == 45;
                let crouch = (30..60).contains(&(tick % 120));
                let walk = (60..90).contains(&(tick % 120));
                let previous = motor.feet;
                motor.step_command(&map, direction.0, direction.1, sprint, jump, crouch, walk)?;
                ensure!(
                    motor.feet.is_finite() && motor.feet.y >= map.manifest.bounds.min[1] - 2.,
                    "invalid/fallen traversal state"
                );
                ensure!(
                    (motor.feet - previous).length() < 1.6,
                    "unbounded motor displacement"
                );
                grounded += u32::from(motor.grounded);
                crouched += u32::from(motor.crouched);
                airborne += u32::from(!motor.grounded);
                commands.push(serde_json::json!({"x":direction.0,"z":direction.1,"sprint":sprint,"jump":jump,"crouch":crouch,"walk":walk}));
                if tick % 15 == 14 {
                    checkpoints.push(serde_json::json!({"tick":tick,"feet":motor.feet.to_array(),"grounded":motor.grounded,"crouched":motor.crouched}));
                }
            }
            routes.push(serde_json::json!({"spawn":spawn.to_array(),"commands":commands,"checkpoints":checkpoints,"groundedTicks":grounded,"crouchedTicks":crouched,"airborneTicks":airborne}));
        }
    }
    ensure!(routes.len() >= 20, "not enough validated route starts");
    println!(
        "{}",
        serde_json::json!({"sha256":map.manifest.sha256,"routes":routes,"skippedStarts":skipped,"scope":"20-second walk/sprint/jump/crouch loops across 64x64m Zaton grid; static collision only"})
    );
    Ok(())
}
