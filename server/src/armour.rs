//! CoP hit protection and wear for the target's equipped items.
use crate::{
    catalog::{Catalog, Kind},
    combat::{ArmourImpact, ShotTarget},
    inventory::ItemState,
    survival::ImpactKind,
    environment::Armour as FieldArmour,
    world::CharacterKey,
};
use anyhow::{Context, Result, ensure};
use rusqlite::{Transaction, params};

#[derive(Clone, Copy)]
struct BoneProtection {
    coefficient: f64,
    armour: f64,
}

fn bone_protection(catalog: &Catalog, section: &str, bone: &str) -> Result<Option<BoneProtection>> {
    let definition = catalog.section(section)?;
    definition
        .values
        .get(bone)
        .map(|raw| {
            let mut values = raw.split(',').map(str::trim);
            let coefficient = values
                .next()
                .context("missing bone coefficient")?
                .parse::<f64>()?;
            let armour = values
                .next()
                .context("missing bone armour")?
                .parse::<f64>()?;
            ensure!(
                coefficient >= 0.0 && coefficient.is_finite() && armour.is_finite(),
                "invalid bone armour"
            );
            Ok(BoneProtection {
                coefficient,
                armour,
            })
        })
        .transpose()
}

struct Protection {
    bone: BoneProtection,
    hit_fraction: f64,
    wear: f64,
}

fn protection(
    catalog: &Catalog,
    section: &str,
    state: &ItemState,
    bone: &str,
) -> Result<Protection> {
    let (base, kind) = catalog.item(section)?;
    ensure!(
        matches!(kind, Kind::Outfit | Kind::Helmet),
        "invalid equipped armour class"
    );
    catalog.validate_state(section, state)?;
    let effects = catalog.upgrade_effects(section, &state.upgrades)?;
    let default = BoneProtection {
        coefficient: 1.0,
        armour: 0.0,
    };
    let mut protection = Protection {
        bone: default,
        hit_fraction: 0.1,
        wear: 1.0,
    };
    let mut specific = None;
    let mut fallback = default;
    for (index, definition) in std::iter::once(base).chain(effects).enumerate() {
        if let Some(name) = definition
            .values
            .get("bones_koeff_protection")
            .filter(|name| !name.is_empty())
        {
            specific = bone_protection(catalog, name, bone)?;
            fallback = bone_protection(catalog, name, "default")?.unwrap_or(default);
        }
        if let Some(name) = definition
            .values
            .get("bones_koeff_protection_add")
            .filter(|name| !name.is_empty())
        {
            if let Some(extra) = bone_protection(catalog, name, "default")? {
                fallback.armour += extra.armour;
                fallback.coefficient += extra.coefficient;
            }
            if let Some(extra) = bone_protection(catalog, name, bone)? {
                let layer = specific.get_or_insert(default);
                layer.armour += extra.armour;
                layer.coefficient += extra.coefficient;
            }
        }
        if definition.values.contains_key("hit_fraction_actor") {
            let fraction = definition.number("hit_fraction_actor")?;
            if index == 0 {
                protection.hit_fraction = fraction;
            } else {
                protection.hit_fraction += fraction;
            }
        }
        if let Some(name) = definition
            .values
            .get("immunities_sect")
            .filter(|name| !name.is_empty())
        {
            protection.wear = catalog.section(name)?.number("fire_wound_immunity")?;
        }
        if let Some(name) = definition
            .values
            .get("immunities_sect_add")
            .filter(|name| !name.is_empty())
        {
            let extra = catalog.section(name)?;
            if extra.values.contains_key("fire_wound_immunity") {
                protection.wear += extra.number("fire_wound_immunity")?;
            }
        }
    }
    protection.bone = specific.unwrap_or(fallback);
    ensure!(
        protection.hit_fraction.is_finite()
            && protection.hit_fraction >= 0.0
            && protection.wear.is_finite(),
        "invalid armour hit factors"
    );
    Ok(protection)
}

struct Gear {
    id: String,
    section: String,
    revision: u32,
    raw: String,
    place: String,
}

fn equipped(tx: &Transaction<'_>, character: &CharacterKey, belt: bool) -> Result<Vec<Option<Gear>>> {
    // The left join distinguishes an unarmoured living target from a stale life.
    // Belt artefacts absorb first, then the outfit, then the helmet.
    let mut query = tx.prepare_cached(
        "SELECT i.id,i.section,i.revision,i.state,i.place FROM inventory_characters a
         JOIN item_containers c ON c.owner=a.principal AND c.kind='carried'
         LEFT JOIN inventory_items i ON i.container=c.id
           AND (i.place IN ('slot:7','slot:12') OR (?3 AND i.place GLOB 'belt:*'))
         WHERE a.principal=?1 AND a.life=?2 AND a.alive=1
         ORDER BY i.place='slot:12',i.place='slot:7',i.place",
    )?;
    Ok(query
        .query_map(
            params![character.principal, character.life, belt],
            |row| {
                let Some(id) = row.get::<_, Option<String>>(0)? else {
                    return Ok(None);
                };
                Ok(Some(Gear {
                    id,
                    section: row.get(1)?,
                    revision: row.get(2)?,
                    raw: row.get(3)?,
                    place: row.get(4)?,
                }))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

fn wear(tx: &Transaction<'_>, gear: &Gear, state: &mut ItemState, received: f64, factor: f64) -> Result<bool> {
    let condition = (f64::from(state.condition) - received * factor.max(0.0)).clamp(0.0, 1.0) as f32;
    save_condition(tx, gear, state, condition)
}

fn save_condition(tx: &Transaction<'_>, gear: &Gear, state: &mut ItemState, condition: f32) -> Result<bool> {
    if condition == state.condition {
        return Ok(false);
    }
    state.condition = condition;
    let next = gear.revision.checked_add(1).context("armour revision exhausted")?;
    ensure!(
        tx.execute(
            "UPDATE inventory_items SET state=?1,revision=?2 WHERE id=?3 AND revision=?4",
            params![serde_json::to_string(state)?, next, gear.id, gear.revision],
        )? == 1,
        "armour changed during hit transaction"
    );
    Ok(true)
}

pub(crate) fn field_exposure(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey,
    pulses: &[crate::environment::Pulse], state: &mut crate::survival::State,
) -> Result<Option<FieldArmour>> {
    use crate::environment::{Factors, Protection};
    let factors = Factors::from_catalog(catalog)?;
    let mut protection = Protection::default();
    let mut worn = Vec::new();
    for gear in equipped(tx, character, true)?.into_iter().flatten() {
        let (definition, kind) = catalog.item(&gear.section)?;
        if gear.place.starts_with("belt:") {
            if kind == Kind::Artefact { protection.add_artefact(catalog, definition)?; }
        } else {
            ensure!(matches!(kind, Kind::Outfit | Kind::Helmet), "invalid equipped field armour");
            let item: ItemState = serde_json::from_str(&gear.raw)?;
            protection.armour.add(catalog, &gear.section, &item, &gear.place)?;
            worn.push((gear, item));
        }
    }
    factors.apply_all(state, &mut protection, pulses);
    let mut gear_changed = false;
    for (gear, mut item) in worn {
        let layer = if gear.place == "slot:7" { protection.armour.outfit } else { protection.armour.helmet };
        gear_changed |= save_condition(tx, &gear, &mut item, layer.condition)?;
    }
    if gear_changed { protection.armour.stamp(tx, &character.principal)?; }
    Ok(gear_changed.then_some(protection.armour))
}

pub(crate) fn strike(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    target: &ShotTarget,
    power: f64,
    penetration: f64,
) -> Result<ArmourImpact> {
    strike_for_bone(tx, catalog, &target.character, &target.bone, power, penetration)
}

fn strike_for_bone(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey, bone: &str,
    mut power: f64, penetration: f64,
) -> Result<ArmourImpact> {
    let rows = equipped(tx, character, false)?;
    if rows.is_empty() {
        return Ok(ArmourImpact::Stale);
    }

    let mut wound = true;
    let mut gear_changed = false;
    let mut field_armour = FieldArmour::default();
    for gear in rows.into_iter().flatten() {
        let mut state: ItemState = serde_json::from_str(&gear.raw)?;
        let profile = protection(catalog, &gear.section, &state, bone)?;
        if profile.bone.armour < 0.0 {
            field_armour.add(catalog, &gear.section, &state, &gear.place)?;
            continue;
        }
        let received = power;
        power = f64::from(crate::xray_combat_rules::bullet_armour_power(
            power as f32, penetration as f32, profile.bone.armour as f32 * state.condition,
            profile.hit_fraction as f32, profile.bone.coefficient as f32, &mut wound,
        ));
        gear_changed |= wear(tx, &gear, &mut state, received, profile.wear)?;
        field_armour.add(catalog, &gear.section, &state, &gear.place)?;
    }
    ensure!(
        (power as f32).is_finite() && power >= 0.0,
        "invalid armoured shot power"
    );
    if gear_changed {
        field_armour.stamp(tx, &character.principal)?;
    }
    Ok(ArmourImpact::Hit {
        power: power as f32,
        wound,
        gear_changed,
        field_armour: gear_changed.then_some(field_armour),
    })
}

pub(crate) fn impact(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey,
    kind: &ImpactKind, power: f64, health: f32,
) -> Result<(ArmourImpact, f32)> {
    let (impact, immunity, adds_wound) = match kind {
        // Preserve the existing grenade damage rules.
        ImpactKind::Blast { .. } => return Ok((absorb_hit(tx, catalog, character, power,
            ("explosion_protection", "explosion_immunity"))?, 0.0)),
        ImpactKind::Wound { .. } => return wound(tx, catalog, character, &[power], health),
        ImpactKind::Strike => (absorb_hit(tx, catalog, character, power,
            ("strike_protection", "strike_immunity"))?, "strike_immunity", false),
        ImpactKind::Bullet { bone, penetration } => (strike_for_bone(tx, catalog, character, bone,
            power, f64::from(*penetration))?, "fire_wound_immunity", true),
    };
    let ArmourImpact::Hit { power, wound, gear_changed, field_armour } = impact else { return Ok((impact, 0.0)); };
    let (health_factor, power_factor) = actor_hit_factors(catalog, immunity)?;
    Ok((ArmourImpact::Hit { power: power * health_factor, wound: wound && adds_wound, gear_changed, field_armour },
        power * power_factor))
}

pub(crate) fn apply_native_impact(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey, kind: &ImpactKind,
    sample: crate::survival::NativeArmourImpact,
) -> Result<Option<(ArmourImpact, f32)>> {
    let wound = match kind {
        ImpactKind::Strike => false,
        _ => sample.wound,
    };
    if !(0.0..=10.0).contains(&sample.power)
        || !(0.0..=1000.0).contains(&sample.health)
        || !(0.0..=1000.0).contains(&sample.power_loss) {
        return Ok(None);
    }
    let Some((gear_changed, field_armour)) = apply_native_wear(tx, catalog, character,
        sample.generation, [sample.outfit, sample.helmet])? else { return Ok(None); };
    Ok(Some((ArmourImpact::Hit { power:sample.health, wound, gear_changed, field_armour }, sample.power_loss)))
}

pub(crate) fn apply_native_wear(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey,
    generation_expected: u64, conditions: [Option<f32>;2],
) -> Result<Option<(bool, Option<FieldArmour>)>> {
    let generation: i64 = tx.query_row(
        "SELECT generation FROM inventory_characters WHERE principal=?1",
        [&character.principal], |row| row.get(0),
    )?;
    if u64::try_from(generation).ok() != Some(generation_expected) {
        return Ok(None);
    }
    let rows = equipped(tx, character, false)?;
    if rows.is_empty() { return Ok(None); }
    let mut predicted = conditions;
    let mut wear = Vec::new();
    for gear in rows.into_iter().flatten() {
        let Some(condition) = predicted[usize::from(gear.place == "slot:12")].take() else {
            return Ok(None);
        };
        let state: ItemState = serde_json::from_str(&gear.raw)?;
        if !(0.0..=state.condition).contains(&condition) {
            return Ok(None);
        }
        wear.push((gear, state, condition));
    }
    if predicted.iter().any(Option::is_some) {
        return Ok(None);
    }
    let mut gear_changed = false;
    let mut field_armour = FieldArmour::default();
    for (gear, mut state, condition) in wear {
        gear_changed |= save_condition(tx, &gear, &mut state, condition)?;
        field_armour.add(catalog, &gear.section, &state, &gear.place)?;
    }
    if gear_changed {
        field_armour.stamp(tx, &character.principal)?;
    }
    Ok(Some((gear_changed, gear_changed.then_some(field_armour))))
}

fn actor_hit_factors(catalog: &Catalog, hit: &str) -> Result<(f32, f32)> {
    let actor = catalog.section("mp_actor")?;
    let condition = catalog.section(actor.text("condition_sect")?)?;
    let immunity = catalog.section(actor.text("immunities_sect")?)?.number(hit)?;
    let health = (immunity * condition.number("health_hit_part")?) as f32;
    let power = (immunity * condition.number("power_hit_part")?) as f32;
    ensure!((0.0..=100.0).contains(&health) && (0.0..=100.0).contains(&power), "invalid actor hit factors");
    Ok((health, power))
}

pub(crate) fn wound(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey, hits: &[f64], health: f32,
) -> Result<(ArmourImpact, f32)> {
    let (health_factor, power_factor) = actor_hit_factors(catalog, "wound_immunity")?;
    let mut damage = 0.0;
    let mut power_loss = 0.0;
    let mut worn = None;
    for &hit in hits {
        let impact = absorb_hit(tx, catalog, character, hit, ("wound_protection", "wound_immunity"))?;
        let ArmourImpact::Hit { power, field_armour, .. } = impact else { return Ok((impact, 0.0)); };
        damage += power * health_factor;
        power_loss += power * power_factor;
        worn = field_armour.or(worn);
        if damage >= health { break; }
    }
    Ok((ArmourImpact::Hit { power: damage, wound: true, gear_changed: worn.is_some(), field_armour: worn }, power_loss))
}

fn absorb_hit(
    tx: &Transaction<'_>, catalog: &Catalog, character: &CharacterKey, mut power: f64,
    (protection_key, immunity_key): (&str, &str),
) -> Result<ArmourImpact> {
    let rows = equipped(tx, character, true)?;
    if rows.is_empty() {
        return Ok(ArmourImpact::Stale);
    }
    let mut gear_changed = false;
    let mut field_armour = FieldArmour::default();
    for gear in rows.into_iter().flatten() {
        let mut state: ItemState = serde_json::from_str(&gear.raw)?;
        let (base, kind) = catalog.item(&gear.section)?;
        catalog.validate_state(&gear.section, &state)?;
        if gear.place.starts_with("belt:") {
            if kind == Kind::Artefact
                && let Some(section) = base.values.get("hit_absorbation_sect").filter(|name| !name.is_empty())
            {
                // CoP's hit path applies the raw artefact value. Condition
                // scaling is used by its protection display, not this hit.
                power -= catalog.section(section)?.number(immunity_key)?;
            }
            continue;
        }
        ensure!(matches!(kind, Kind::Outfit | Kind::Helmet), "invalid equipped impact armour");
        let received = power.max(0.0);
        let protection = catalog.effective_number(&gear.section, &state, protection_key, 0.0)?;
        power = (received - protection * f64::from(state.condition)).max(0.0);
        let mut factor = 1.0;
        for definition in std::iter::once(base).chain(catalog.upgrade_effects(&gear.section, &state.upgrades)?) {
            if let Some(name) = definition.values.get("immunities_sect").filter(|name| !name.is_empty()) {
                factor = catalog.section(name)?.number(immunity_key)?;
            }
            if let Some(name) = definition.values.get("immunities_sect_add").filter(|name| !name.is_empty()) {
                let extra = catalog.section(name)?;
                if extra.values.get(immunity_key).is_some_and(|value| !value.is_empty()) {
                    factor += extra.number(immunity_key)?;
                }
            }
        }
        ensure!(factor.is_finite(), "invalid impact armour wear");
        gear_changed |= wear(tx, &gear, &mut state, received, factor)?;
        field_armour.add(catalog, &gear.section, &state, &gear.place)?;
    }
    let power = power.max(0.0) as f32;
    ensure!(power.is_finite(), "invalid protected impact power");
    if gear_changed {
        field_armour.stamp(tx, &character.principal)?;
    }
    Ok(ArmourImpact::Hit { power, wound: true, gear_changed, field_armour: gear_changed.then_some(field_armour) })
}
