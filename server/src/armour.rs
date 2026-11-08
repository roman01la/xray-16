//! CoP hit protection and wear for the target's equipped items.
use crate::{
    catalog::{Catalog, Kind},
    combat::{ArmourImpact, ShotTarget},
    inventory::ItemState,
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

pub(crate) fn strike(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    target: &ShotTarget,
    mut power: f64,
    penetration: f64,
) -> Result<ArmourImpact> {
    let rows = equipped(tx, &target.character, false)?;
    if rows.is_empty() {
        return Ok(ArmourImpact::Stale);
    }

    let mut wound = true;
    let mut gear_changed = false;
    for gear in rows.into_iter().flatten() {
        let mut state: ItemState = serde_json::from_str(&gear.raw)?;
        let profile = protection(catalog, &gear.section, &state, target.bone)?;
        if profile.bone.armour < 0.0 {
            continue;
        }
        let armour = profile.bone.armour * f64::from(state.condition);
        let received = power;
        if penetration > armour {
            let fraction = ((penetration - armour) / penetration).max(profile.hit_fraction);
            power *= fraction * profile.bone.coefficient;
        } else {
            power *= profile.hit_fraction;
            wound = false;
        }
        gear_changed |= wear(tx, &gear, &mut state, received, profile.wear)?;
    }
    ensure!(
        (power as f32).is_finite() && power >= 0.0,
        "invalid armoured shot power"
    );
    Ok(ArmourImpact::Hit {
        power: power as f32,
        wound,
        gear_changed,
    })
}

pub(crate) fn blast(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    character: &CharacterKey,
    mut power: f64,
) -> Result<ArmourImpact> {
    let rows = equipped(tx, character, true)?;
    if rows.is_empty() {
        return Ok(ArmourImpact::Stale);
    }
    let mut gear_changed = false;
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
                power -= catalog.section(section)?.number("explosion_immunity")?;
            }
            continue;
        }
        ensure!(matches!(kind, Kind::Outfit | Kind::Helmet), "invalid equipped blast armour");
        let received = power.max(0.0);
        let protection = catalog.effective_number(&gear.section, &state, "explosion_protection", 0.0)?;
        power = (received - protection * f64::from(state.condition)).max(0.0);
        let mut factor = 1.0;
        for definition in std::iter::once(base).chain(catalog.upgrade_effects(&gear.section, &state.upgrades)?) {
            if let Some(name) = definition.values.get("immunities_sect").filter(|name| !name.is_empty()) {
                factor = catalog.section(name)?.number("explosion_immunity")?;
            }
            if let Some(name) = definition.values.get("immunities_sect_add").filter(|name| !name.is_empty()) {
                let extra = catalog.section(name)?;
                if extra.values.get("explosion_immunity").is_some_and(|value| !value.is_empty()) {
                    factor += extra.number("explosion_immunity")?;
                }
            }
        }
        ensure!(factor.is_finite(), "invalid blast armour wear");
        gear_changed |= wear(tx, &gear, &mut state, received, factor)?;
    }
    let power = power.max(0.0) as f32;
    ensure!(power.is_finite(), "invalid protected blast power");
    Ok(ArmourImpact::Hit { power, wound: true, gear_changed })
}
