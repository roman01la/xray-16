//! The stock CoP knife. The server owns the strike timing, reach and hit power.
use crate::{
    catalog::Catalog,
    alife_attacks::{NativeDamage, NativeHitKind},
    combat::ChargedShot,
    inventory::{Context, ItemState, active_weapon_slot},
    survival::ShotVictim,
};
use anyhow::{Context as _, Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Slash,
    Stab,
}

impl Mode {
    pub fn observer_mode(self) -> u8 {
        match self {
            Self::Slash => 3,
            Self::Stab => 4,
        }
    }

    // Original wpn_hand_knife_hud_animation.omf, using the HUD's wall-clock
    // motion marks and the quantized speed for the 21-frame motion length.
    pub fn timing(self) -> (u32, u32) {
        match self {
            Self::Slash => (8, 14),
            Self::Stab => (9, 27),
        }
    }
}

pub struct Profile {
    pub reach: f32,
    pub radius: f32,
    pub direction: [f32; 3],
    power: f64,
    direct_scale: f64,
    splash_hits: usize,
    falloff: f64,
}

impl Profile {
    pub fn from_catalog(catalog: &Catalog, mode: Mode) -> Result<Self> {
        let (definition, _) = catalog.item("wpn_knife")?;
        let value = |key, fallback| -> Result<f64> {
            definition.number(if definition.values.contains_key(key) {
                key
            } else {
                fallback
            })
        };
        ensure!(
            definition.text("class")? == "WP_KNIFE"
                && definition.text("hit_type")? == "wound"
                && definition.text("hit_type_2")? == "wound",
            "unsupported knife profile"
        );
        let (reach, radius, direction, power, splash_hits) = match mode {
            // Both original radius keys write into m_Hit1SplashRadius, leaving
            // m_Hit2SplashRadius at its constructor default of one metre.
            Mode::Slash => (
                value("splash1_dist", "spash1_dist")?,
                value("splash2_radius", "spash2_radius")?,
                "splash1_direction",
                "hit_power",
                1,
            ),
            Mode::Stab => (
                value("splash2_dist", "spash2_dist")?,
                1.0,
                "splash2_direction",
                "hit_power_2",
                definition.integer("splash2_hits_count")?,
            ),
        };
        let direction: Vec<f32> = definition
            .text(direction)?
            .split(',')
            .map(|s| s.trim().parse())
            .collect::<Result<_, _>>()?;
        let direction: [f32; 3] = direction
            .try_into()
            .map_err(|_| anyhow::anyhow!("invalid knife direction"))?;
        let power: f64 = definition
            .text(power)?
            .split(',')
            .next()
            .context("missing knife power")?
            .trim()
            .parse()?;
        let direct_scale = definition.number("splash1_pervictim_hcount")?;
        let falloff = definition.number("splash_hit_divide_factor")?;
        ensure!(
            (0.01..=4.0).contains(&reach)
                && (0.0..=2.0).contains(&radius)
                && direction
                    .iter()
                    .all(|component| (-1.0..=1.0).contains(component))
                && (0.0..=10.0).contains(&power)
                && (1.0..=3.0).contains(&direct_scale)
                && (1..=3).contains(&splash_hits)
                && (0.0..=1.0).contains(&falloff),
            "invalid knife profile"
        );
        Ok(Self {
            reach: reach as f32,
            radius: radius as f32,
            direction,
            power,
            direct_scale,
            splash_hits: splash_hits as usize,
            falloff,
        })
    }

    pub fn range(&self) -> f32 {
        self.reach + self.radius
    }
}

pub(crate) fn strike(
    tx: &Transaction<'_>,
    context: &Context,
    id: &str,
    catalog: &Catalog,
    (mode, splash): (Mode, bool),
    victim: Option<ShotVictim>,
    rules: Option<&crate::survival_rules::SurvivalRules>,
) -> Result<Value> {
    let state: Option<String> = tx
        .query_row(
            "SELECT i.state FROM inventory_items i
        JOIN item_containers c ON c.id=i.container
        JOIN inventory_characters a ON a.principal=c.owner
        WHERE i.id=?1 AND i.section='wpn_knife' AND c.owner=?2 AND c.kind='carried'
            AND i.place='slot:1' AND a.life=?3 AND a.alive=1",
            params![id, context.principal, context.life],
            |row| row.get(0),
        )
        .optional()?;
    let Some(state) = state else {
        return Ok(json!({"status":"rejected","reason":"knife_not_equipped"}));
    };
    if active_weapon_slot(tx, &context.principal)? != 1 {
        return Ok(json!({"status":"rejected","reason":"knife_not_drawn"}));
    }
    catalog.validate_state("wpn_knife", &serde_json::from_str::<ItemState>(&state)?)?;
    let profile = Profile::from_catalog(catalog, mode)?;
    let mut powers = [0.0; 3];
    let count = if splash {
        for (index, power) in powers[..profile.splash_hits].iter_mut().enumerate() {
            *power = profile.power * profile.falloff.powi(index as i32);
        }
        profile.splash_hits
    } else {
        powers[0] = profile.power * profile.direct_scale;
        1
    };
    let (armour, target_commit, power_loss) =
        if let Some(victim) = victim.filter(|v| v.target.distance <= profile.range()) {
            let (impact, commit, power_loss) = crate::weapon_inventory::commit_shot_hit(
                tx,
                context,
                victim,
                rules,
                |target, state| {
                    crate::armour::wound(
                        tx,
                        catalog,
                        &target.character,
                        &powers[..count],
                        state.health,
                    )
                },
            )?;
            (Some(impact), commit, power_loss)
        } else {
            (None, None, 0.0)
        };
    let (definition, _) = catalog.item("wpn_knife")?;
    let impulse_key = match mode { Mode::Slash => "hit_impulse", Mode::Stab => "hit_impulse_2" };
    let impulse = if definition.values.contains_key(impulse_key) { definition.number(impulse_key)? as f32 } else { 0.0 };
    let damage = (powers[..count].iter().sum::<f64>() * 100.0).round() as u16;
    Ok(json!({"effect":("wpn_knife", mode.observer_mode()), "shot":ChargedShot {
        ammo: 0, range: profile.range(), damage, interval: 0, mass_spent: 0.0, power_loss,
        queue: None, armour, target_commit, launcher: None,
        native_damage: Some(NativeDamage { kind: NativeHitKind::Wound, power: powers.map(|v| v as f32), penetration: 0.0, impulse }),
    }}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        combat::{Aim, Combat},
        world::{Kind, Vec3, World},
    };
    use std::sync::Arc;

    #[test]
    fn blade_splash_reaches_one_close_body_and_respects_static_cover() {
        let map = crate::collision::tests::actor_fixture(0);
        let mut world = World::with_collision(Arc::new(map)).unwrap();
        world.safe_zones.clear();
        let at = |x, z| Vec3 { x, y: 0.0, z };
        let shooter = world.spawn(Kind::Player, at(1.4, 0.0));
        let target = world.spawn(Kind::Player, at(1.4, 0.9));
        world.spawn(Kind::Player, at(2.4, 0.0)); // Behind the fixture wall at x=2.
        let mut combat = Combat::default();
        combat.capture(&world);
        let profile = Profile {
            reach: 1.0,
            radius: 1.0,
            direction: [0.0, 0.0, 1.0],
            power: 1.5,
            direct_scale: 1.0,
            splash_hits: 2,
            falloff: 0.75,
        };
        let aim = |yaw| Aim {
            tick: world.tick,
            yaw,
            pitch: 0.0,
        };
        let direct = combat
            .trace_knife(&world, shooter, aim(0.0), &profile)
            .unwrap();
        assert_eq!(direct.target(), Some(target));
        assert!(!direct.knife_splash);
        let off_center = combat
            .trace_knife(&world, shooter, aim(-0.9), &profile)
            .unwrap();
        assert_eq!(off_center.target(), Some(target));
        assert!(off_center.knife_splash);
        let through_wall = combat
            .trace_knife(&world, shooter, aim(std::f32::consts::FRAC_PI_2), &profile)
            .unwrap();
        assert_eq!(through_wall.target(), None);
    }
}
