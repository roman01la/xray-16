//! CoP magazine and ammunition-box transactions. The caller owns the durable
//! request journal and the live character/item revision checks.
use crate::{
    catalog::{Catalog, Kind},
    combat::{ChargedShot, LaunchSpec, MAX_OWNED_RANGE, QueueRound, ShotTarget},
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
    let ammo_key = if launcher {
        "grenade_class"
    } else {
        "ammo_class"
    };
    let ammunition = catalog.effective_list(&section, &state, ammo_key)?;
    if launcher && !catalog.launcher_available(&section, &state)? {
        return Ok(Some("no_launcher"));
    }
    let capacity = if launcher {
        1
    } else {
        let size = catalog.effective_number(&section, &state, "ammo_mag_size", 0.0)?;
        ensure!(
            size.fract() == 0.0 && (1.0..=1024.0).contains(&size),
            "invalid magazine capacity"
        );
        size as usize
    };
    let incremental = !launcher
        && catalog
            .item(&section)?
            .0
            .boolean("tri_state_reload", false)?;
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
        } else if next_type {
            // CWeapon::SwitchAmmoType only cycles through types with a box.
            let at = ammunition
                .iter()
                .position(|value| Some(value.as_str()) == current)
                .context("weapon ammunition selection unavailable")?;
            let mut found = None;
            for offset in 1..ammunition.len() {
                let candidate = &ammunition[(at + offset) % ammunition.len()];
                if has_rounds(tx, carried, candidate)? {
                    found = Some(candidate.as_str());
                    break;
                }
            }
            found
        } else {
            let mut found = None;
            for candidate in current
                .into_iter()
                .chain(ammunition.iter().map(String::as_str))
            {
                if has_rounds(tx, carried, candidate)? {
                    found = Some(candidate);
                    break;
                }
            }
            found
        };
        if let Some(selected) = selected.map(str::to_owned) {
            if !incremental && magazine.last().is_some_and(|loaded| *loaded != selected) {
                return_rounds(tx, carried, catalog, magazine)?;
            }
            let needed = if incremental {
                1
            } else {
                capacity - magazine.len()
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
        let start = required(start)?;
        if condition > start {
            return Ok(0.0);
        }
        let end = required(end)?;
        let end_probability = required(end_probability)?;
        if condition < end {
            return Ok(f64::from(end_probability));
        }
        let start_probability = required(start_probability)?;
        let denominator = if start == end { start } else { start - end };
        if denominator == 0.0 {
            return Ok(0.0);
        }
        start_probability + (start - condition) * (end_probability - start_probability) / denominator
    } else {
        if condition > 0.95 || !definition.values.contains_key("misfire_probability") {
            return Ok(0.0);
        }
        effective("misfire_probability", 0.0)?
            + (1.0 - condition).powi(3) * effective("misfire_condition_k", 1.0)?
    };
    ensure!(probability.is_finite(), "invalid weapon misfire probability");
    Ok(f64::from(probability.clamp(0.0, 0.99)))
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
        fuse_ticks: (milliseconds * f64::from(crate::world::TICK_HZ) / 1000.0).ceil() as u32,
        blast_power: power as f32,
        blast_radius: radius as f32,
    })
}

/// A reliable, sequenced trigger is submitted once by the live session. This
/// transaction owns the round and weapon wear before combat can apply damage.
pub(crate) fn debit_shot(
    tx: &Transaction<'_>,
    principal: &str,
    life: u32,
    item: &str,
    catalog: &Catalog,
    target: Option<&ShotTarget>,
    queue_index: Option<u32>,
) -> Result<Value> {
    let reject = |reason| Ok(json!({"status":"rejected","reason":reason}));
    let equipped: Option<(String, String, u32)> = tx
        .query_row(
            "SELECT i.section,i.state,i.revision FROM inventory_items i
         JOIN item_containers c ON c.id=i.container
         JOIN inventory_characters a ON a.principal=c.owner
         WHERE i.id=?1 AND c.owner=?2 AND c.kind='carried'
           AND i.place IN('slot:2','slot:3') AND a.life=?3 AND a.alive=1",
            params![item, principal, life],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let Some((section, raw, revision)) = equipped else {
        return reject("weapon_not_equipped");
    };
    let mut state: ItemState = serde_json::from_str(&raw)?;
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
        return Ok(json!({"shot":ChargedShot {
            ammo: 0, range: 0.0, damage: 0, interval: 1, mass_spent,
            queue: None, armour: None, launcher: Some(spec),
        }}));
    }
    if *jammed {
        return reject("jammed");
    }
    let Some(cartridge) = cartridges.last() else {
        return reject("empty");
    };
    catalog.validate_state(&section, &state)?;
    let modes = catalog.fire_modes(&section, &state)?;
    let mode = modes.get(mode_index(*fire_mode, modes.len())).copied().unwrap_or(1);
    let limit = u8::try_from(mode).ok();
    let index = queue_index.unwrap_or(0);
    if limit.is_some_and(|limit| index >= u32::from(limit)) {
        return reject("queue_complete");
    }
    let (round, _) = catalog.item(cartridge)?;
    if round.text("class")? != "AMMO_S" {
        return reject("projectile_unavailable");
    }
    let next = revision.checked_add(1).context("weapon revision exhausted")?;
    let probability = misfire_probability(catalog, &section, &state)?;
    if probability > 0.0
        && tx.query_row("SELECT (random() & 4294967295) / 4294967296.0", [], |row| row.get::<_, f64>(0))? < probability
    {
        let ItemPayload::Weapon { jammed, .. } = &mut state.payload else {
            unreachable!()
        };
        *jammed = true;
        save_weapon(tx, item, revision, next, &state)?;
        return reject("misfire");
    }
    let mass_spent = catalog.round_weight(cartridge)?;
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
    let range = catalog.effective_number(&section, &state, "fire_distance", 0.0)?
        * round.number("k_dist")?;
    // Native multiplayer uses the first (Master) hit-power value.
    let hit_power = catalog
        .effective_text(&section, &state, "hit_power")?
        .context("missing hit power")?;
    let master: f64 = hit_power
        .split(',')
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches(['f', 'F'])
        .parse()?;
    let mut power = master * round.number("k_hit")?;
    if catalog
        .effective_text(&section, &state, "silencer_status")?
        .as_deref()
        == Some("2")
        && let Some(silencer) = catalog.effective_text(&section, &state, "silencer_name")?
        && attachments.contains(&silencer)
    {
        let definition = catalog.item(&silencer)?.0;
        if definition.values.contains_key("bullet_hit_power_k") {
            power *= definition.number("bullet_hit_power_k")?.clamp(0.0, 1.0);
        }
    }
    let wear = if index == 0 {
        catalog.effective_number(&section, &state, "condition_shot_dec", 0.0)?
    } else {
        let base = definition.values.get("condition_shot_dec")
            .map(|_| definition.number("condition_shot_dec")).transpose()?.unwrap_or_default();
        catalog.effective_number(&section, &state, "condition_queue_shot_dec", base)?
    } * round.number("impair")?;
    let ticks = f64::from(crate::world::TICK_HZ) * 60.0 / rpm;
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
    let armour = target.filter(|target| target.distance <= range as f32).map(|target| {
        ensure!(target.character.principal != principal, "self-hit is not a valid shot target");
        let penetration = round.number("k_ap")?;
        ensure!(penetration >= 0.0, "invalid cartridge penetration");
        crate::armour::strike(tx, catalog, target, power, penetration)
    }).transpose()?;
    let ItemPayload::Weapon { cartridges, .. } = &mut state.payload else {
        unreachable!()
    };
    cartridges.pop();
    let ammo = u16::try_from(cartridges.len())?;
    state.condition = (f64::from(state.condition) - wear).clamp(0.0, 1.0) as f32;
    save_weapon(tx, item, revision, next, &state)?;
    Ok(json!({"shot":ChargedShot {
        ammo,
        range: range as f32,
        damage: (power * 100.0).round().clamp(0.0, f64::from(u16::MAX)) as u16,
        interval: interval as u32,
        mass_spent,
        queue: queue_index.map(|_| QueueRound { limit, ticks }),
        armour,
        launcher: None,
    }}))
}
