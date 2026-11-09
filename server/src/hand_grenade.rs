//! Original CoP grenade and bolt throw profiles. Only grenades consume an item.
use crate::{
    catalog::Catalog,
    combat::{ChargedShot, LaunchSpec},
    inventory::{Context, ItemState, active_weapon_slot, carried_equipment},
    world::TICK_HZ,
};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, Transaction, params};
use serde_json::{Value, json};

// CoP f1_throw_begin is 1067 ms. The f1_throw motion's first release mark
// opens at 368.667 ms. The three stock hand grenades share these aliases.
pub const READY_TICKS: u32 = (1067 * TICK_HZ).div_ceil(1000);
pub const RELEASE_TICKS: u32 = (369 * TICK_HZ).div_ceil(1000);

#[derive(Clone, Copy)]
pub enum Force {
    Quick,
    Held(u32),
}

fn is_grenade(catalog: &Catalog, section: &str) -> bool {
    catalog
        .item(section)
        .is_ok_and(|(definition, _)| matches!(definition.text("class"), Ok("G_F1_S" | "G_RGD5_S")))
}

pub(crate) fn slot_next(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    carry: &str,
    previous: &str,
) -> Result<bool> {
    let mut query = tx.prepare_cached(
        "SELECT id,section,revision FROM inventory_items
        WHERE container=?1 AND place='rucksack' ORDER BY section=?2 DESC,rowid",
    )?;
    let mut rows = query.query(params![carry, previous])?;
    while let Some(row) = rows.next()? {
        let section: String = row.get(1)?;
        if !is_grenade(catalog, &section) || !catalog.compatible_slot(&section, 4)? {
            continue;
        }
        let id: String = row.get(0)?;
        let revision: u32 = row.get(2)?;
        let next = revision
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("grenade revision exhausted"))?;
        ensure!(
            tx.execute(
                "UPDATE inventory_items SET place='slot:4',revision=?1 WHERE id=?2 AND revision=?3",
                params![next, id, revision]
            )? == 1,
            "grenade changed during replacement"
        );
        return Ok(true);
    }
    Ok(false)
}

fn launch_spec(catalog: &Catalog, section: &str, force: Force) -> Result<LaunchSpec> {
    ensure!(section.len() <= 32, "hand grenade section exceeds the visual packet limit");
    let (definition, _) = catalog.item(section)?;
    let min = definition.number("force_min")?;
    let max = definition.number("force_max")?;
    let constant = definition.number("force_const")?;
    let growth = definition.number("force_grow_speed")?;
    ensure!(
        (0.01..=256.0).contains(&min)
            && (min..=256.0).contains(&max)
            && (min..=max).contains(&constant)
            && (0.0..=256.0).contains(&growth),
        "invalid hand grenade force"
    );
    let speed = match force {
        Force::Quick => constant,
        Force::Held(ticks) => (min + growth * f64::from(ticks) / f64::from(TICK_HZ)).min(max),
    };
    let millis = definition.number("destroy_time")?;
    let (power, radius) = if section == "bolt" { (0.0, 0.0) }
        else { (definition.number("blast")?, definition.number("blast_r")?) };
    ensure!(
        (1.0..=30_000.0).contains(&millis)
            && (0.0..=100.0).contains(&power)
            && (0.0..=30.0).contains(&radius)
            && (power == 0.0 && radius == 0.0
                || radius > 0.0 && definition.text("hit_type_blast")? == "explosion"),
        "invalid hand grenade payload"
    );
    Ok(LaunchSpec {
        section: section.into(),
        speed: speed as f32,
        timed: true,
        fuse_ticks: (millis * f64::from(TICK_HZ) / 1000.0).ceil() as u32,
        blast_power: power as f32,
        blast_radius: radius as f32,
    })
}

pub(crate) fn prepare_bolt(
    tx: &Transaction<'_>, context: &Context, id: &str, catalog: &Catalog, force: Force,
) -> Result<Value> {
    let raw: Option<String> = tx.query_row(
        "SELECT i.state FROM inventory_items i
        JOIN item_containers c ON c.id=i.container JOIN inventory_characters a ON a.principal=c.owner
        WHERE i.id=?1 AND i.section='bolt' AND c.owner=?2 AND c.kind='carried'
            AND i.place='slot:6' AND a.life=?3 AND a.alive=1",
        params![id, context.principal, context.life], |row| row.get(0),
    ).optional()?;
    let Some(raw) = raw else { return Ok(json!({"status":"rejected","reason":"bolt_not_equipped"})); };
    if active_weapon_slot(tx, &context.principal)? != 6 {
        return Ok(json!({"status":"rejected","reason":"bolt_not_drawn"}));
    }
    ensure!(catalog.item("bolt")?.0.text("class")? == "II_BOLT", "invalid bolt definition");
    catalog.validate_state("bolt", &serde_json::from_str::<ItemState>(&raw)?)?;
    let launch = launch_spec(catalog, "bolt", force)?;
    Ok(json!({"shot": ChargedShot { ammo: 0, range: 0.0, damage: 0, interval: 12, mass_spent: 0.0,
        power_loss: 0.0, queue: None, armour: None, target_commit: None, launcher: Some(launch), native_damage: None }}))
}

pub(crate) fn debit(
    tx: &Transaction<'_>,
    context: &Context,
    id: &str,
    catalog: &Catalog,
    force: Force,
) -> Result<Value> {
    let reject = |reason| Ok(json!({"status":"rejected","reason":reason}));
    let equipped: Option<(String, String, String, u32)> = tx
        .query_row(
            "SELECT i.section,i.state,i.container,i.revision FROM inventory_items i
         JOIN item_containers c ON c.id=i.container
         JOIN inventory_characters a ON a.principal=c.owner
         WHERE i.id=?1 AND c.owner=?2 AND c.kind='carried'
           AND i.place='slot:4' AND a.life=?3 AND a.alive=1",
            params![id, context.principal, context.life],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((section, raw, carry, revision)) = equipped else {
        return reject("grenade_not_equipped");
    };
    if active_weapon_slot(tx, &context.principal)? != 4 {
        return reject("grenade_not_drawn");
    }
    if !is_grenade(catalog, &section) {
        return reject("not_a_grenade");
    }
    let state: ItemState = serde_json::from_str(&raw)?;
    catalog.validate_state(&section, &state)?;
    let launch = launch_spec(catalog, &section, force)?;
    ensure!(
        tx.execute(
            "DELETE FROM inventory_items WHERE id=?1 AND revision=?2",
            params![id, revision]
        )? == 1,
        "grenade changed during throw"
    );
    if !slot_next(tx, catalog, &carry, &section)? {
        tx.execute(
            "UPDATE inventory_characters SET grenade_drawn=0 WHERE principal=?1",
            [&context.principal],
        )?;
    }
    let (loadout, appearance) = carried_equipment(tx, &context.principal, catalog)?;
    Ok(
        json!({"shot": ChargedShot { ammo: 0, range: 0.0, damage: 0, interval: 12, mass_spent: 0.0, power_loss: 0.0,
        queue: None, armour: None, target_commit: None, launcher: Some(launch), native_damage: None },
        "loadout":loadout,"appearance":appearance}),
    )
}
