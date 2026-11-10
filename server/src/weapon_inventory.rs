//! CoP magazine and ammunition-box transactions. The caller owns the durable
//! request journal and the live character/item revision checks.
use crate::{
    ballistics::{Dispersion, MAX_PELLETS, MAX_PENETRATION, RoundProfile, SurfaceProfile},
    catalog::{Catalog, Kind, Section},
    alife_attacks::{NativeDamage, NativeHitKind},
    combat::{ArmourImpact, ChargedShot, FireState, LaunchSpec, MAX_OWNED_RANGE, QueueRound, VolleyImpact},
    inventory::{self, AttachedItem, AttachmentSlot, ItemPayload, ItemState, Move, MoveAction},
};
use anyhow::{Context, Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;

struct AmmoBox {
    id: String,
    revision: u32,
    state: ItemState,
}

fn ammo_boxes(
    tx: &Transaction<'_>,
    carried: &str,
    section: &str,
    limit: usize,
) -> Result<Vec<AmmoBox>> {
    // CInventory::GetAny searches the rucksack before the belt.
    let mut query = tx.prepare_cached(
        "SELECT id,revision,state FROM inventory_items
         WHERE container=?1 AND section=?2 AND (place='rucksack' OR place LIKE 'belt:%')
         ORDER BY CASE WHEN place='rucksack' THEN 0 ELSE 1 END,rowid LIMIT ?3",
    )?;
    let rows = query.query_map(params![carried, section, u32::try_from(limit)?], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, u32>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    rows.map(|row| {
        let (id, revision, raw) = row?;
        let state: ItemState = serde_json::from_str(&raw)?;
        ensure!(
            matches!(state.payload, ItemPayload::Ammunition { .. }),
            "invalid ammo box"
        );
        Ok(AmmoBox {
            id,
            revision,
            state,
        })
    })
    .collect()
}

fn has_rounds(tx: &Transaction<'_>, carried: &str, section: &str) -> Result<bool> {
    Ok(tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM inventory_items WHERE container=?1 AND section=?2
         AND (place='rucksack' OR place LIKE 'belt:%'))",
        params![carried, section],
        |row| row.get(0),
    )?)
}

fn save_box(tx: &Transaction<'_>, carried: &str, ammo: &AmmoBox) -> Result<()> {
    let next = ammo
        .revision
        .checked_add(1)
        .context("ammo box revision exhausted")?;
    let changed = tx.execute(
        "UPDATE inventory_items SET revision=?1,state=?2 WHERE id=?3 AND container=?4 AND revision=?5",
        params![next, serde_json::to_string(&ammo.state)?, ammo.id, carried, ammo.revision],
    )?;
    ensure!(changed == 1, "ammo box changed during magazine transaction");
    Ok(())
}

fn take_rounds(
    tx: &Transaction<'_>,
    carried: &str,
    section: &str,
    catalog: &Catalog,
    wanted: usize,
) -> Result<usize> {
    let mut taken = 0;
    for mut ammo in ammo_boxes(tx, carried, section, wanted)? {
        catalog.validate_state(section, &ammo.state)?;
        let ItemPayload::Ammunition { rounds } = &mut ammo.state.payload else {
            unreachable!()
        };
        let count = u32::try_from(wanted - taken)?.min(*rounds);
        *rounds -= count;
        taken += count as usize;
        if *rounds == 0 {
            ensure!(
                tx.execute(
                    "DELETE FROM inventory_items WHERE id=?1 AND container=?2 AND revision=?3",
                    params![ammo.id, carried, ammo.revision]
                )? == 1,
                "ammo box changed during magazine transaction"
            );
        } else {
            save_box(tx, carried, &ammo)?;
        }
        if taken == wanted {
            break;
        }
    }
    Ok(taken)
}

fn return_rounds(
    tx: &Transaction<'_>,
    carried: &str,
    catalog: &Catalog,
    magazine: &mut Vec<String>,
) -> Result<()> {
    let mut types = BTreeMap::<String, u32>::new();
    for round in magazine.drain(..) {
        *types.entry(round).or_default() += 1;
    }
    for (section, mut count) in types {
        let (definition, kind) = catalog.item(&section)?;
        ensure!(kind == Kind::Ammunition, "invalid unloaded cartridge");
        let capacity = u32::try_from(definition.integer("box_size")?)?;
        ensure!(capacity > 0, "empty ammo-box definition");
        // CoP fills the first matching box before creating more boxes.
        if let Some(mut ammo) = ammo_boxes(tx, carried, &section, 1)?.into_iter().next() {
            catalog.validate_state(&section, &ammo.state)?;
            let ItemPayload::Ammunition { rounds } = &mut ammo.state.payload else {
                unreachable!()
            };
            let returned = count.min(capacity - *rounds);
            if returned != 0 {
                *rounds += returned;
                count -= returned;
                save_box(tx, carried, &ammo)?;
            }
        }
        let mut state = catalog.initial_state(&section)?;
        while count != 0 {
            let rounds = count.min(capacity);
            state.payload = ItemPayload::Ammunition { rounds };
            inventory::provision(tx, carried, &section, &state, "rucksack")?;
            count -= rounds;
        }
    }
    Ok(())
}

pub(crate) fn change_weapon(
    tx: &Transaction<'_>,
    carried: &str,
    command: &Move,
    catalog: &Catalog,
    next_revision: u32,
    can_take_addon: impl Fn(&str) -> Result<bool>,
    reload: Option<&crate::alife_weapon::ReloadRules>,
) -> Result<Option<&'static str>> {
    let (section, raw, place): (String, String, String) = tx.query_row(
        "SELECT section,state,place FROM inventory_items WHERE id=?1 AND container=?2",
        params![command.item, carried],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let mut state: ItemState = serde_json::from_str(&raw)?;
    let ItemPayload::Weapon { launcher_mode, fire_mode, .. } = &state.payload else {
        return Ok(Some("not_a_weapon"));
    };
    let launcher = *launcher_mode;
    let unload = matches!(command.action, MoveAction::Unload);
    if !unload && !matches!(command.action, MoveAction::Detach { .. })
        && !matches!(place.as_str(), "slot:2" | "slot:3")
    {
        return Ok(Some("weapon_not_equipped"));
    }
    catalog.validate_state(&section, &state)?;
    if matches!(command.action, MoveAction::Attach { .. } | MoveAction::Detach { .. }) {
        if let Some(reason) = change_attachment(tx, carried, command, catalog, &section, &mut state, can_take_addon)? {
            return Ok(Some(reason));
        }
        catalog.validate_state(&section, &state)?;
        save_weapon(tx, &command.item, command.revision, next_revision, &state)?;
        return Ok(None);
    }
    if let MoveAction::FireMode { next } = command.action {
        let count = catalog.fire_modes(&section, &state)?.len();
        if launcher || count < 2 {
            return Ok(Some("no_fire_selector"));
        }
        let current = mode_index(*fire_mode, count);
        let ItemPayload::Weapon { fire_mode, .. } = &mut state.payload else { unreachable!() };
        *fire_mode = u8::try_from((current + if next { 1 } else { count - 1 }) % count + 1)?;
        save_weapon(tx, &command.item, command.revision, next_revision, &state)?;
        return Ok(None);
    }
    if let MoveAction::LauncherMode { active } = command.action {
        if active && (!catalog.launcher_available(&section, &state)?
            || catalog.effective_list(&section, &state, "grenade_class")?.is_empty())
        {
            return Ok(Some("no_launcher"));
        }
        if launcher == active {
            return Ok(Some("launcher_mode_unchanged"));
        }
        let ItemPayload::Weapon { launcher_mode, .. } = &mut state.payload else { unreachable!() };
        *launcher_mode = active;
        save_weapon(tx, &command.item, command.revision, next_revision, &state)?;
        return Ok(None);
    }
    if launcher && !catalog.launcher_available(&section, &state)? {
        return Ok(Some("no_launcher"));
    }
    let catalog_ammunition;
    let (ammunition, capacity, incremental) = if let Some(native) = reload {
        tracing::trace!(item = command.item, native.capacity, native.incremental, "using X-Ray reload rules");
        (native.ammunition.as_ref(), native.capacity, native.incremental)
    } else {
        let ammo_key = if launcher { "grenade_class" } else { "ammo_class" };
        catalog_ammunition = catalog.effective_list(&section, &state, ammo_key)?;
        let capacity = if launcher { 1 } else {
            let size = catalog.effective_number(&section, &state, "ammo_mag_size", 0.0)?;
            ensure!(size.fract() == 0.0 && (1.0..=1024.0).contains(&size), "invalid magazine capacity");
            size as usize
        };
        let incremental = !launcher && catalog.item(&section)?.0.boolean("tri_state_reload", false)?;
        (catalog_ammunition.as_slice(), capacity, incremental)
    };
    let ItemPayload::Weapon {
        cartridges,
        launcher_cartridges,
        selected_ammunition,
        jammed,
        ..
    } = &mut state.payload
    else {
        unreachable!()
    };
    let magazine = if launcher {
        launcher_cartridges
    } else {
        cartridges
    };
    if unload {
        if magazine.is_empty() {
            return Ok(Some("empty_magazine"));
        }
        return_rounds(tx, carried, catalog, magazine)?;
    } else {
        let next_type = matches!(command.action, MoveAction::NextAmmo);
        // A regular reload can clear a loaded magazine-fed weapon without
        // inserting a round. A tri-state reload must actually insert a shell.
        let clear_only = *jammed && !next_type && !incremental && !magazine.is_empty();
        let full = magazine.len() >= capacity && (!next_type || incremental);
        let current = if launcher {
            magazine.last().or(ammunition.first()).map(String::as_str)
        } else {
            Some(selected_ammunition.as_str())
        };
        let selected = if full {
            if !clear_only {
                return Ok(Some("magazine_full"));
            }
            None
        } else {
            let at = ammunition.iter().position(|value| Some(value.as_str()) == current);
            let at = if next_type { at.context("weapon ammunition selection unavailable")? } else { at.unwrap_or(0) };
            let available = ammunition.iter().map(|candidate| has_rounds(tx, carried, candidate).map(u8::from))
                .collect::<Result<Vec<_>>>()?;
            crate::xray_combat_rules::select_reload_ammo(&available, at, next_type, false)
                .map(|index| ammunition[index].as_str())
        };
        if let Some(selected) = selected.map(str::to_owned) {
            if crate::xray_combat_rules::reload_changes_type(incremental, !magazine.is_empty(), true,
                magazine.last().is_some_and(|loaded| *loaded == selected)) {
                return_rounds(tx, carried, catalog, magazine)?;
            }
            let needed = if incremental {
                1
            } else {
                capacity.saturating_sub(magazine.len())
            };
            if needed == 0 {
                return Ok(Some("magazine_full"));
            }
            let count = take_rounds(tx, carried, &selected, catalog, needed)?;
            ensure!(count > 0, "ammunition disappeared during reload");
            magazine.extend(std::iter::repeat_n(selected.clone(), count));
            if !launcher {
                *selected_ammunition = selected;
            }
        } else if !clear_only {
            return Ok(Some("no_compatible_ammunition"));
        }
        *jammed = false;
    }
    catalog.validate_state(&section, &state)?;
    save_weapon(tx, &command.item, command.revision, next_revision, &state)?;
    Ok(None)
}

fn change_attachment(
    tx: &Transaction<'_>,
    carried: &str,
    command: &Move,
    catalog: &Catalog,
    section: &str,
    state: &mut ItemState,
    can_take_addon: impl Fn(&str) -> Result<bool>,
) -> Result<Option<&'static str>> {
    let addons = catalog.addons(section, state)?;
    let ItemPayload::Weapon {
        attachments, attachment_items, launcher_cartridges, launcher_mode, ..
    } = &mut state.payload else { unreachable!() };
    match &command.action {
        MoveAction::Attach { addon, addon_revision } => {
            let item = tx.query_row(
                "SELECT i.section,i.revision,i.state,i.container FROM inventory_items i
                 JOIN item_containers c ON c.id=i.container
                 WHERE i.id=?1 AND i.place='rucksack'
                   AND (i.container=?2 OR c.kind IN('corpse','storage'))",
                params![addon, carried],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)),
            ).optional()?;
            let Some((section, revision, raw, source)) = item else { return Ok(Some("addon_unavailable")); };
            if source != carried && !can_take_addon(&source)? {
                return Ok(Some("addon_unavailable"));
            }
            if revision != *addon_revision {
                return Ok(Some("addon_revision_changed"));
            }
            let Ok(slot) = catalog.attachment_slot(&section) else {
                return Ok(Some("incompatible_addon"));
            };
            let (status, names) = &addons[slot as usize];
            if *status != 2 || !names.contains(&section) {
                return Ok(Some("incompatible_addon"));
            }
            if attachments.iter().any(|name| names.contains(name)) {
                return Ok(Some("addon_slot_occupied"));
            }
            let addon_state = serde_json::from_str(&raw)?;
            catalog.validate_state(&section, &addon_state)?;
            let Some(revision) = revision.checked_add(1) else {
                return Ok(Some("addon_revision_exhausted"));
            };
            ensure!(tx.execute(
                "DELETE FROM inventory_items WHERE id=?1 AND container=?2 AND revision=?3",
                params![addon, source, addon_revision],
            )? == 1, "attachment changed during transaction");
            attachments.push(section.clone());
            attachment_items.push(AttachedItem {
                id: addon.clone(), revision, section,
                condition: addon_state.condition, upgrades: addon_state.upgrades,
            });
        }
        MoveAction::Detach { slot } => {
            let (status, names) = &addons[*slot as usize];
            let Some(index) = attachments.iter().position(|name| names.contains(name))
                .filter(|_| *status == 2)
            else {
                return Ok(Some("no_detachable_addon"));
            };
            let section = attachments.remove(index);
            if let Some(index) = attachment_items.iter().position(|item| item.section == section) {
                let item = attachment_items.remove(index);
                let Some(revision) = item.revision.checked_add(1) else {
                    return Ok(Some("addon_revision_exhausted"));
                };
                tx.execute(
                    "INSERT INTO inventory_items(id,container,revision,section,state,place)
                     VALUES(?1,?2,?3,?4,?5,'rucksack')",
                    params![item.id, carried, revision, section, serde_json::to_string(&item.state())?],
                )?;
            } else {
                // Imported weapons with an authored addon have a section
                // but no loose item instance until their first detach.
                let state = catalog.initial_state(&section)?;
                inventory::provision(tx, carried, &section, &state, "rucksack")?;
            }
            if *slot == AttachmentSlot::Launcher {
                return_rounds(tx, carried, catalog, launcher_cartridges)?;
                *launcher_mode = false;
            }
        }
        _ => unreachable!(),
    }
    Ok(None)
}

fn mode_index(selector: u8, count: usize) -> usize {
    selector.checked_sub(1).map_or(count.saturating_sub(1), usize::from)
}

fn save_weapon(
    tx: &Transaction<'_>,
    item: &str,
    revision: u32,
    next_revision: u32,
    state: &ItemState,
) -> Result<()> {
    ensure!(
        tx.execute(
            "UPDATE inventory_items SET revision=?1,state=?2 WHERE id=?3 AND revision=?4",
            params![next_revision, serde_json::to_string(state)?, item, revision],
        )? == 1,
        "weapon changed during inventory transaction"
    );
    Ok(())
}

fn misfire_probability(catalog: &Catalog, section: &str, state: &ItemState) -> Result<f64> {
    // CWeapon chooses its formula when loading the base LTX. Upgrades add to
    // the selected parameters without switching the formula.
    let (definition, _) = catalog.item(section)?;
    let condition = state.condition;
    let keys = [
        "misfire_start_condition", "misfire_end_condition",
        "misfire_start_prob", "misfire_end_prob",
    ];
    let effective = |key, default| -> Result<f32> {
        Ok(catalog.effective_number(section, state, key, default)? as f32)
    };
    let probability = if keys.iter().any(|key| definition.values.contains_key(*key)) {
        let [start, end, start_probability, end_probability] = keys;
        let required = |key| effective(key, definition.number(key)?);
        crate::xray_combat_rules::misfire(condition, required(start)?, required(end)?,
            required(start_probability)?, required(end_probability)?)
    } else {
        if !definition.values.contains_key("misfire_probability") {
            return Ok(0.0);
        }
        crate::xray_combat_rules::legacy_misfire(condition,
            effective("misfire_probability", 0.0)?, effective("misfire_condition_k", 1.0)?)
    };
    ensure!(probability.is_finite(), "invalid weapon misfire probability");
    Ok(f64::from(probability))
}

fn launch_spec(catalog: &Catalog, section: &str, state: &ItemState, round: &str) -> Result<LaunchSpec> {
    let addons = catalog.addons(section, state)?;
    let (status, names) = &addons[AttachmentSlot::Launcher as usize];
    let base_speed = if *status == 1 {
        catalog.item(section)?.0.number("grenade_vel")?
    } else {
        let ItemPayload::Weapon { attachments, .. } = &state.payload else { unreachable!() };
        let addon = attachments.iter().find(|addon| names.contains(addon)).context("launcher missing")?;
        catalog.item(addon)?.0.number("grenade_vel")?
    };
    // The launcher reads grenade_vel on load or attachment. Only upgrade
    // sections apply launch_speed, whose base LTX entry may be zero.
    let mut speed = base_speed;
    for upgrade in catalog.upgrade_effects(section, &state.upgrades)? {
        if upgrade.values.get("launch_speed").is_some_and(|value| !value.is_empty()) {
            speed += upgrade.number("launch_speed")?;
        }
    }
    let round = catalog.item(round)?.0;
    let projectile_section = round.text("fake_grenade_name")?;
    ensure!(inventory::section_valid(projectile_section), "invalid launcher projectile section");
    let explosive = catalog.section(projectile_section)?;
    ensure!(explosive.text("class")? == "G_FAKE"
        && explosive.text("hit_type_blast")? == "explosion", "unsupported launcher projectile");
    let milliseconds = explosive.number("force_explode_time")?;
    let power = explosive.number("blast")?;
    let radius = explosive.number("blast_r")?;
    ensure!((0.01..=256.0).contains(&speed)
        && (1.0..=30_000.0).contains(&milliseconds)
        && (0.0..=100.0).contains(&power)
        && (0.01..=30.0).contains(&radius), "invalid launcher projectile parameters");
    Ok(LaunchSpec {
        section: projectile_section.to_owned(),
        speed: speed as f32,
        timed: false,
        fuse_ticks: (milliseconds * f64::from(crate::world::TICK_HZ) / 1000.0).ceil() as u32,
        blast_power: power as f32,
        blast_radius: radius as f32,
    })
}

fn silencer(catalog: &Catalog, section: &str, state: &ItemState, attachments: &[String]) -> Result<(bool, Option<String>)> {
    let status = catalog.effective_text(section, state, "silencer_status")?;
    let attached = if status.as_deref() == Some("2") {
        catalog.effective_text(section, state, "silencer_name")?
            .filter(|silencer| attachments.contains(silencer))
    } else {
        None
    };
    Ok((status.as_deref() == Some("1") || attached.is_some(), attached))
}

fn shot_wear(catalog: &Catalog, section: &str, state: &ItemState, round: &Section, first: bool) -> Result<f64> {
    let wear = if first {
        catalog.effective_number(section, state, "condition_shot_dec", 0.0)?
    } else {
        let definition = catalog.item(section)?.0;
        let base = definition.values.get("condition_shot_dec")
            .map(|_| definition.number("condition_shot_dec")).transpose()?.unwrap_or_default();
        catalog.effective_number(section, state, "condition_queue_shot_dec", base)?
    } * round.number("impair")?;
    ensure!(wear.is_finite() && wear >= 0.0, "invalid shot wear");
    Ok(wear)
}

fn catalog_shot_impact(
    catalog: &Catalog, section: &str, state: &ItemState, round: &Section, attachments: &[String],
    index: u32, native: Option<&crate::combat::NativeWeaponRules>,
) -> Result<crate::alife_weapon::ShotImpact> {
    // The multiplayer weapon uses the first (Master) hit-power value.
    let hit_power = catalog.effective_text(section, state, "hit_power")?.context("missing hit power")?;
    let master: f64 = hit_power.split(',').next().unwrap_or_default().trim().trim_end_matches(['f', 'F']).parse()?;
    let mut power = master * round.number("k_hit")?;
    let impulse_factor = if round.values.contains_key("k_impulse") { round.number("k_impulse")? } else { 1.0 };
    let mut impulse = catalog.effective_number(section, state, "hit_impulse", 0.0)? * impulse_factor;
    let (suppressed, silencer) = silencer(catalog, section, state, attachments)?;
    if let Some(silencer) = silencer {
        let definition = catalog.item(&silencer)?.0;
        if definition.values.contains_key("bullet_hit_power_k") {
            power *= definition.number("bullet_hit_power_k")?.clamp(0.0, 1.0);
        }
        if definition.values.contains_key("bullet_hit_impulse_k") {
            impulse *= definition.number("bullet_hit_impulse_k")?.clamp(0.0, 1.0);
        }
    }
    let wear = if let Some(rules) = native {
        rules.wear(index) * round.number("impair")?
    } else {
        shot_wear(catalog, section, state, round, index == 0)?
    };
    Ok(crate::alife_weapon::ShotImpact { power, impulse, wear, suppressed })
}

fn dispersion(catalog: &Catalog, section: &str, state: &ItemState, round: &Section, addon: Option<&Section>) -> Result<Dispersion> {
    let value = |key, default| catalog.effective_number(section, state, key, default);
    let mut base = value("fire_dispersion_base", 0.0)?.to_radians();
    if round.values.contains_key("k_disp") { base *= round.number("k_disp")?; }
    if let Some(addon) = addon.filter(|addon| addon.values.contains_key("fire_dispersion_base_k")) {
        base *= addon.number("fire_dispersion_base_k")?.clamp(0.0, 1.0);
    }
    let condition_factor = value("fire_dispersion_condition_factor", 0.0)?;
    let cone = |first| -> Result<f32> {
        let condition = (f64::from(state.condition) - shot_wear(catalog, section, state, round, first)?).clamp(0.0, 1.0);
        Ok((base * (1.0 + condition_factor * (1.0 - condition))) as f32)
    };
    let mut profile = Dispersion { first: cone(true)?, followup: cone(false)?, ..Default::default() };
    if let Some(actor) = catalog.section("mp_actor").ok().filter(|actor| actor.values.contains_key("disp_base")) {
        let factor = |actor_key, weapon_key| -> Result<f32> { Ok((actor.number(actor_key)? * value(weapon_key, 1.0)?) as f32) };
        profile.actor_base = (actor.number("disp_base")?.to_radians() * value("PDM_disp_base", 1.0)?) as f32;
        if actor.values.contains_key("disp_aim") {
            profile.actor_aim = actor.number("disp_aim")?.to_radians() as f32;
        }
        profile.velocity_factor = factor("disp_vel_factor", "PDM_disp_vel_factor")?;
        profile.acceleration_factor = factor("disp_accel_factor", "PDM_disp_accel_factor")?;
        profile.crouch_factor = factor("disp_crouch_factor", "PDM_disp_crouch")?;
        profile.crouch_still_factor = factor("disp_crouch_no_acc_factor", "PDM_disp_crouch_no_acc")?;
    }
    ensure!([profile.first, profile.followup, profile.actor_base, profile.actor_aim, profile.velocity_factor,
        profile.acceleration_factor, profile.crouch_factor, profile.crouch_still_factor]
        .into_iter().all(f32::is_finite), "invalid shot dispersion");
    Ok(profile)
}

pub(crate) fn round_profile(catalog: &Catalog, section: &str, state: &ItemState, revision: u32) -> Result<Option<RoundProfile>> {
    // The synthetic inventory fixtures have no engine-wide bullet settings.
    let Ok(manager) = catalog.section("mp_bullet_manager").or_else(|_| catalog.section("bullet_manager"))
        else { return Ok(None); };
    let ItemPayload::Weapon { cartridges, launcher_mode: false, jammed: false, attachments, .. } = &state.payload
        else { return Ok(None); };
    let Some(cartridge) = cartridges.last() else { return Ok(None); };
    let round = catalog.item(cartridge)?.0;
    if round.text("class")? != "AMMO_S" { return Ok(None); }

    let gravity = manager.number("gravity_const")?;
    let drag = if round.values.contains_key("k_air_resistance") {
        round.number("k_air_resistance")?
    } else {
        catalog.section("bullet_manager")?.number("air_resistance_k")?
    } * catalog.effective_number(section, state, "air_resistance_factor", 1.0)?;
    let mut speed = catalog.effective_number(section, state, "bullet_speed", 0.0)?;
    let attached = silencer(catalog, section, state, attachments)?.1;
    let addon = attached.as_deref().map(|name| catalog.item(name).map(|item| item.0)).transpose()?;
    if let Some(addon) = addon.filter(|addon| addon.values.contains_key("bullet_speed_k")) {
        speed *= addon.number("bullet_speed_k")?.clamp(0.0, 1.0);
    }
    let pellets = if round.values.contains_key("buck_shot") { u8::try_from(round.integer("buck_shot")?)? } else { 1 };
    ensure!((1..=MAX_PELLETS).contains(&pellets), "invalid pellet count");
    let spread = dispersion(catalog, section, state, round, addon)?;
    let setting = |section: &Section, key, default| {
        if section.values.contains_key(key) { section.number(key) } else { Ok(default) }
    };
    let penetration = setting(round, "k_ap", 0.0)?;
    let energy_min = setting(manager, "collision_energy_min", 0.8)?;
    let energy_max = setting(manager, "collision_energy_max", 0.5)?;
    ensure!((0.0..=f64::from(MAX_PENETRATION)).contains(&penetration) && (0.0..=1.0).contains(&energy_min)
        && (0.0..=1.0).contains(&energy_max), "invalid bullet surface profile");
    let surface = SurfaceProfile { penetration: penetration as f32,
        ricochet: round.boolean("allow_ricochet", true)?, magnetic: round.boolean("magnetic_beam_shot", false)?,
        energy_min: energy_min as f32, energy_max: energy_max as f32 };
    let range = catalog.effective_number(section, state, "fire_distance", 0.0)? * round.number("k_dist")?;
    // The original quest Gauss rifle uses 100,000 m/s.
    ensure!((1.0..=100_000.0).contains(&speed) && (0.0..=10.0).contains(&drag)
        && (0.0..=100.0).contains(&gravity) && range > 0.0 && range <= f64::from(MAX_OWNED_RANGE),
        "invalid ballistic profile for {section}/{cartridge}");
    let key = crate::alife_weapon::round_key(section, state, cartridge);
    Ok(Some(RoundProfile { revision, key, range: range as f32, speed: speed as f32, drag: drag as f32,
        gravity: gravity as f32, pellets, spread, surface }))
}

/// A reliable, sequenced trigger is submitted once by the live session. This
/// transaction owns the round, weapon wear and any durable hit.
pub(crate) fn debit_shot(
    tx: &Transaction<'_>,
    shooter: &inventory::Context,
    item: &str,
    catalog: &Catalog,
    targets: Vec<crate::survival::FireVictim>,
    FireState { queue_index, traced, native_rules }: FireState,
    rules: Option<&crate::survival_rules::SurvivalRules>,
) -> Result<Value> {
    let principal = &shooter.principal;
    let reject = |reason| Ok(json!({"status":"rejected","reason":reason}));
    let equipped: Option<(String, String, u32, String)> = tx
        .query_row(
            "SELECT i.section,i.state,i.revision,i.place FROM inventory_items i
         JOIN item_containers c ON c.id=i.container
         JOIN inventory_characters a ON a.principal=c.owner
         WHERE i.id=?1 AND c.owner=?2 AND c.kind='carried'
           AND i.place IN('slot:2','slot:3') AND a.life=?3 AND a.alive=1",
            params![item, principal, shooter.life],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((section, raw, revision, place)) = equipped else {
        return reject("weapon_not_equipped");
    };
    match (crate::inventory::active_weapon_slot(tx, principal)?, place.as_str()) {
        (2, "slot:2") | (3, "slot:3") => {}
        _ => return reject("weapon_not_drawn"),
    }
    let mut state: ItemState = serde_json::from_str(&raw)?;
    let native_rules = native_rules.as_ref().filter(|rules| rules.matches_config(item, &section, &state));
    let index = queue_index.unwrap_or(0);
    let expected = round_profile(catalog, &section, &state, revision)?.map(|profile|
        native_rules.and_then(|rules| rules.launch_profile(profile, index)).unwrap_or(profile));
    if traced != expected {
        return reject("stale_ballistics");
    }
    if targets.iter().any(|victim| victim.native.as_ref().is_some_and(|native| Some(native.attack) != expected.map(crate::native_condition::Attack::Firearm))) {
        return reject("stale_native_ballistics");
    }
    let ItemPayload::Weapon {
        cartridges,
        launcher_cartridges,
        launcher_mode,
        attachments,
        jammed,
        fire_mode,
        ..
    } = &state.payload
    else {
        return reject("not_a_weapon");
    };
    if *launcher_mode {
        if queue_index.is_some_and(|index| index > 0) {
            return reject("queue_complete");
        }
        if !catalog.launcher_available(&section, &state)? {
            return reject("no_launcher");
        }
        let Some(cartridge) = launcher_cartridges.last() else {
            return reject("empty");
        };
        catalog.validate_state(&section, &state)?;
        let spec = launch_spec(catalog, &section, &state, cartridge)?;
        let mass_spent = catalog.round_weight(cartridge)?;
        let next = revision.checked_add(1).context("weapon revision exhausted")?;
        let ItemPayload::Weapon { launcher_cartridges, .. } = &mut state.payload else { unreachable!() };
        launcher_cartridges.pop();
        save_weapon(tx, item, revision, next, &state)?;
        return Ok(json!({"effect":(section, 2), "shot":ChargedShot {
            ammo: 0, range: 0.0, damage: 0, interval: 1, mass_spent, power_loss: 0.0,
            queue: None, armour: None, target_commit: None, launcher: Some(spec), native_damage: None,
        }}));
    }
    if *jammed {
        return reject("jammed");
    }
    let Some(cartridge) = cartridges.last() else {
        return reject("empty");
    };
    catalog.validate_state(&section, &state)?;
    let mode = if let Some(rules) = native_rules {
        rules.mode
    } else {
        let modes = catalog.fire_modes(&section, &state)?;
        i32::from(modes.get(mode_index(*fire_mode, modes.len())).copied().unwrap_or(1))
    };
    let limit = u8::try_from(mode).ok();
    if limit.is_some_and(|limit| index >= u32::from(limit)) {
        return reject("queue_complete");
    }
    let (round, _) = catalog.item(cartridge)?;
    if round.text("class")? != "AMMO_S" {
        return reject("projectile_unavailable");
    }
    let next = revision.checked_add(1).context("weapon revision exhausted")?;
    let probability = if let Some(rules) = native_rules {
        tracing::trace!(item, revision, index, mode, "using X-Ray weapon action rules");
        rules.misfire_probability(state.condition)
    } else {
        misfire_probability(catalog, &section, &state)?
    };
    if probability > 0.0
        && tx.query_row("SELECT (random() & 4294967295) / 4294967296.0", [], |row| row.get::<_, f64>(0))? < probability
    {
        let ItemPayload::Weapon { jammed, .. } = &mut state.payload else {
            unreachable!()
        };
        *jammed = true;
        save_weapon(tx, item, revision, next, &state)?;
        return Ok(json!({"status":"rejected","reason":"misfire","ballistics":null}));
    }
    let mass_spent = catalog.round_weight(cartridge)?;
    let rate = f64::from(crate::world::TICK_HZ);
    let ticks = if let Some(rules) = native_rules {
        // X-Ray stores seconds as float32. Drop its last-bit rounding error
        // so 600 RPM still schedules a three-tick shot at 30 Hz.
        (rules.seconds(index) * rate * 1_000_000.0).round() / 1_000_000.0
    } else {
        let (definition, _) = catalog.item(&section)?;
        let alternate_rate = mode == 2 || (index < 2 && definition.boolean("cycle_down", false)?);
        let rpm = if alternate_rate {
            if definition.values.contains_key("rpm_mode_2") {
                definition.number("rpm_mode_2")?
            } else {
                definition.number("rpm")?
            }
        } else {
            catalog.effective_number(&section, &state, "rpm", 0.0)?
        };
        rate * 60.0 / rpm
    };
    let (range, penetration) = match traced {
        Some(profile) => (f64::from(profile.range), f64::from(profile.surface.penetration)),
        None => (
            catalog.effective_number(&section, &state, "fire_distance", 0.0)? * round.number("k_dist")?,
            round.values.get("k_ap").map(|_| round.number("k_ap")).transpose()?.unwrap_or_default(),
        ),
    };
    ensure!((0.0..=f64::from(MAX_PENETRATION)).contains(&penetration), "invalid cartridge penetration");
    let impact = if let Some(native) = native_rules.and_then(|rules| rules.shot_impact(cartridge, index)) {
        tracing::trace!(item, cartridge, native.power, native.impulse, native.wear, native.suppressed,
            "using X-Ray cartridge impact");
        native
    } else {
        catalog_shot_impact(catalog, &section, &state, round, attachments, index, native_rules)?
    };
    let crate::alife_weapon::ShotImpact { power, impulse, wear, suppressed } = impact;
    let interval = ticks.ceil();
    ensure!(
        (1.0..=f64::from(u32::MAX)).contains(&interval),
        "invalid firing interval"
    );
    ensure!(
        range > 0.0 && range <= f64::from(MAX_OWNED_RANGE),
        "invalid shot range"
    );
    ensure!(
        power.is_finite() && power >= 0.0 && wear.is_finite() && wear >= 0.0,
        "invalid shot power or wear"
    );
    let ItemPayload::Weapon { cartridges, .. } = &mut state.payload else {
        unreachable!()
    };
    cartridges.pop();
    let ammo = u16::try_from(cartridges.len())?;
    state.condition = (f64::from(state.condition) - wear).clamp(0.0, 1.0) as f32;
    save_weapon(tx, item, revision, next, &state)?;
    let mut volley = None;
    let (armour, target_commit) = if traced.is_some_and(|profile| profile.pellets > 1) || targets.iter().any(|target|target.native.is_some()) {
        let mut impacts = Vec::with_capacity(targets.len());
        for target in targets {
            impacts.push(commit_volley(tx, catalog, shooter, target, rules, (power, penetration, range as f32))?);
        }
        volley = Some(impacts);
        (None, None)
    } else if let Some(victim) = targets.into_iter().next().map(|v| v.authority).filter(|v| v.target.distance <= range as f32) {
        let (impact, commit, _) = commit_shot_hit(tx, shooter, victim, rules, crate::survival::WoundKind::Bullet,
            |target, _| Ok((crate::armour::strike(tx, catalog, target,
                power * f64::from(target.speed_factor), target.penetration.map_or(penetration, f64::from))?, 0.0)))?;
        (Some(impact), commit)
    } else { (None, None) };
    let ballistics = round_profile(catalog, &section, &state, next)?;
    Ok(json!({"effect":(section, u8::from(suppressed)), "ballistics":ballistics, "volley":volley, "shot":ChargedShot {
        ammo,
        range: range as f32,
        damage: (power * 100.0).round().clamp(0.0, f64::from(u16::MAX)) as u16,
        interval: interval as u32,
        mass_spent,
        power_loss: 0.0,
        queue: queue_index.map(|_| QueueRound { limit, ticks }),
        armour,
        target_commit,
        launcher: None,
        native_damage: Some(NativeDamage { kind: NativeHitKind::Bullet, power: [power as f32, 0.0, 0.0],
            penetration: penetration as f32, impulse: impulse as f32 }),
    }}))
}

pub(crate) fn commit_volley(tx: &Transaction<'_>, catalog: &Catalog, shooter: &inventory::Context, volley: crate::survival::FireVictim,
    rules: Option<&crate::survival_rules::SurvivalRules>, (power, penetration, range): (f64, f64, f32)) -> Result<Option<VolleyImpact>>
{
    use crate::survival::{self, ShotVictim};
    if !shot_current(tx, shooter, &volley.authority)? {
        ensure!(volley.native.is_none(), "native volley condition changed");
        return Ok(None);
    }
    if let Some(native) = volley.native {
        let applied_pellets=std::iter::once(&volley.authority.target).chain(&volley.additional)
            .filter(|pellet|pellet.distance<=range).count();
        ensure!(applied_pellets>0 && applied_pellets<=64
            && applied_pellets==1+volley.additional.len(), "native volley range changed");
        let ShotVictim { context, before, location, shooter_location, combat_lock_ms, .. }=volley.authority;
        ensure!(before.state.native_checkpoint().is_some(), "native volley requires owned condition");
        let projection=native.result.checkpoint.projection().context("invalid native victim checkpoint")?;
        let damaged=projection.health<before.state.health || projection.power<before.state.power;
        let deadline=survival::impact_deadline(if damaged {1.0} else {0.0},combat_lock_ms)?;
        let value=crate::native_condition::commit_impact(tx,&context,catalog,rules,
            crate::native_condition::Impact {
                condition:crate::native_condition::Commit{before,equipment:native.equipment,
                    checkpoint:native.result.checkpoint,location},
                wear:native.result.wear.context("native volley omitted equipment wear")?,combat_until_ms:deadline})?;
        // A stale victim must roll back the already debited round as well.
        ensure!(value["status"]=="committed", "native volley authority changed");
        let state:survival::State=serde_json::from_value(value["state"].clone())?;
        let commit=serde_json::from_value(value.clone())?;
        let field_armour=serde_json::from_value(value["field_armour"].clone())?;
        save_shooter_lock(tx,shooter,shooter_location,deadline)?;
        return Ok(Some(VolleyImpact{applied_pellets:applied_pellets as u8,damaged,health:state.health,
            wounds:Vec::new(),native_state:Some(state),field_armour,commit}));
    }
    ensure!(volley.authority.before.state.native_checkpoint().is_none(), "native volley proposal required");
    let ShotVictim { target, context, mut before, mut location, shooter_location, combat_lock_ms } = volley.authority;
    let mut applied_pellets = 0;
    let mut damaged = false;
    let mut field_armour = None;
    let mut wounds = Vec::new();
    for pellet in std::iter::once(target).chain(volley.additional).filter(|pellet| pellet.distance <= range) {
        let impact = crate::armour::strike(tx, catalog, &pellet, power * f64::from(pellet.speed_factor),
            pellet.penetration.map_or(penetration, f64::from))?;
        let ArmourImpact::Hit { power, wound, field_armour: updated, .. } = impact else {
            anyhow::bail!("volley victim changed inside its transaction");
        };
        if updated.is_some() { field_armour = updated; }
        before.state.apply_hit_at(power, wound.then_some((survival::WoundKind::Bullet, &pellet.bone)));
        if wound && power > 0.0 && before.state.health > 0.0 {
            wounds.push((pellet.bone.to_string(), power));
        }
        applied_pellets += 1;
        damaged |= power > 0.0;
        if before.state.health == 0.0 { break; }
    }
    if applied_pellets == 0 { return Ok(None); }
    let deadline = survival::impact_deadline(if damaged { 1.0 } else { 0.0 }, combat_lock_ms)?;
    location.combat_until_ms = location.combat_until_ms.max(deadline);
    let health = before.state.health;
    let commit = survival::commit_condition_change(tx, &context, rules, before, location)?;
    save_shooter_lock(tx, shooter, shooter_location, deadline)?;
    Ok(Some(VolleyImpact { applied_pellets, damaged, health, wounds, native_state: None, field_armour, commit }))
}

fn shot_current(tx: &Transaction<'_>, shooter: &inventory::Context, victim: &crate::survival::ShotVictim) -> Result<bool> {
    use crate::survival::{self, ShotVictim};
    let ShotVictim { target, context, before, location, shooter_location, .. } = victim;
    ensure!(context.principal != shooter.principal && context.principal == target.character.principal
        && context.life == target.character.life && context.world == shooter.world
        && context.auth_epoch == shooter.auth_epoch && location.world == shooter.world
        && shooter_location.world == shooter.world && location.content_revision == shooter_location.content_revision,
        "invalid shot authority");
    let visit = crate::travel::authority(tx, &context.principal)?;
    Ok(visit.as_ref().map_or(context.visit == 0, |visit| visit.visit == context.visit && visit.world == context.world)
        && survival::impact_current(tx, context, before)?)
}

fn save_shooter_lock(tx: &Transaction<'_>, shooter: &inventory::Context, mut location: crate::survival::Location, deadline: i64) -> Result<()> {
    if deadline != 0 {
        location.combat_until_ms = location.combat_until_ms.max(deadline);
        ensure!(tx.execute("UPDATE inventory_characters SET location=?1 WHERE principal=?2 AND life=?3 AND alive=1",
            params![serde_json::to_string(&location)?, shooter.principal, shooter.life])? == 1,
            "shooter changed during impact");
    }
    Ok(())
}

pub(crate) fn commit_shot_hit(
    tx: &Transaction<'_>, shooter: &inventory::Context,
    victim: crate::survival::ShotVictim,
    rules: Option<&crate::survival_rules::SurvivalRules>,
    kind: crate::survival::WoundKind,
    resolve: impl FnOnce(&crate::combat::ShotTarget, &crate::survival::State) -> Result<(ArmourImpact, f32)>,
) -> Result<(ArmourImpact, Option<crate::survival::ImpactCommit>, f32)> {
    use crate::survival::{self, ShotVictim};
    if !shot_current(tx, shooter, &victim)? {
        return Ok((ArmourImpact::Stale, None, 0.0));
    }
    ensure!(victim.before.state.native_checkpoint().is_none(), "native hit proposal required");
    let ShotVictim { target, context, mut before, location, shooter_location, combat_lock_ms } = victim;
    let (impact, power_loss) = resolve(&target, &before.state)?;
    let ArmourImpact::Hit { power, wound, .. } = impact else { return Ok((impact, None, 0.0)); };
    let deadline = survival::impact_deadline(power, combat_lock_ms)?;
    before.state.power = (before.state.power - power_loss).max(0.0);
    let commit = survival::commit_impact(tx, &context, rules, before, location,
        (power, wound.then_some((kind, &target.bone))), deadline)?;
    save_shooter_lock(tx, shooter, shooter_location, deadline)?;
    Ok((impact, Some(commit), power_loss))
}
