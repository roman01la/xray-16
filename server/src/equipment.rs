//! CoP placement rules. Caller owns the inventory transaction and replay ledger.
use crate::{
    catalog::{Catalog, Kind},
    inventory::ItemState,
};
use anyhow::{Result, ensure};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};

pub(crate) const BELT_CELLS: u8 = 5;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Placement {
    Rucksack,
    Slot { slot: u8 },
    Belt { cell: u8 },
}
impl Placement {
    pub fn key(&self) -> String {
        match self {
            Self::Rucksack => "rucksack".into(),
            Self::Slot { slot } => format!("slot:{slot}"),
            Self::Belt { cell } => format!("belt:{cell}"),
        }
    }
}
struct Equipped {
    id: String,
    section: String,
    state: ItemState,
    place: String,
}
fn equipped(tx: &Transaction<'_>, carry: &str) -> Result<Vec<Equipped>> {
    let mut query=tx.prepare("SELECT id,section,state,place FROM inventory_items WHERE container=?1 AND place!='rucksack' ORDER BY id")?;
    let mut result = Vec::new();
    for row in query.query_map([carry], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
        ))
    })? {
        let (id, section, state, place) = row?;
        result.push(Equipped {
            id,
            section,
            state: serde_json::from_str(&state)?,
            place,
        });
    }
    Ok(result)
}
fn bag(tx: &Transaction<'_>, id: &str) -> Result<()> {
    tx.execute(
        "UPDATE inventory_items SET place='rucksack',revision=revision+1 WHERE id=?1",
        [id],
    )?;
    Ok(())
}
/// Removing/dropping an outfit returns the entire artefact belt to the rucksack.
pub(crate) fn removing(tx: &Transaction<'_>, carry: &str, old_place: &str) -> Result<()> {
    if old_place == "slot:7" {
        tx.execute("UPDATE inventory_items SET place='rucksack',revision=revision+1 WHERE container=?1 AND place LIKE 'belt:%'",[carry])?;
    }
    Ok(())
}
pub(crate) fn place(
    tx: &Transaction<'_>,
    carry: &str,
    id: &str,
    placement: &Placement,
    catalog: &Catalog,
) -> Result<Option<&'static str>> {
    let (section, state, old_place): (String, String, String) = tx.query_row(
        "SELECT section,state,place FROM inventory_items WHERE id=?1 AND container=?2",
        params![id, carry],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    let state: ItemState = serde_json::from_str(&state)?;
    catalog.validate_state(&section, &state)?;
    let (definition, kind) = catalog.item(&section)?;
    let equipped = equipped(tx, carry)?;
    let outfit = equipped.iter().find(|e| e.place == "slot:7");
    let key = placement.key();
    if key == old_place {
        return Ok(Some("already_placed"));
    }
    let mut displaced = Vec::new();
    match placement {
        Placement::Rucksack => {}
        Placement::Slot { slot } => {
            if !catalog.compatible_slot(&section, *slot)? {
                return Ok(Some("incompatible_slot"));
            }
            if *slot == 12
                && let Some(outfit) = outfit
                && !catalog
                    .item(&outfit.section)?
                    .0
                    .boolean("helmet_avaliable", true)?
            {
                return Ok(Some("helmet_blocked"));
            }
            if let Some(other) = equipped.iter().find(|e| e.place == key) {
                let persistent = catalog
                    .section("inventory")?
                    .boolean(&format!("slot_persistent_{slot}"), false)?;
                if persistent && *slot != 9 {
                    return Ok(Some("persistent_slot"));
                }
                displaced.push(other.id.as_str());
            }
            if kind == Kind::Outfit
                && !definition.boolean("helmet_avaliable", true)?
                && let Some(helmet) = equipped.iter().find(|e| e.place == "slot:12")
            {
                displaced.push(helmet.id.as_str());
            }
        }
        Placement::Belt { cell } => {
            if !definition.boolean("belt", false)? {
                return Ok(Some("not_belt_item"));
            }
            let Some(outfit) = outfit else {
                return Ok(Some("no_artefact_slots"));
            };
            let width = catalog
                .effective_number(&outfit.section, &outfit.state, "artefact_count", 0.0)?
                .clamp(0.0, f64::from(BELT_CELLS)) as u8;
            let item_width = u8::try_from(definition.integer("inv_grid_width")?)?;
            let item_height = definition.integer("inv_grid_height")?;
            if item_width == 0
                || item_height != 1
                || u16::from(*cell) + u16::from(item_width) > u16::from(width)
            {
                return Ok(Some("belt_full"));
            }
            for other in &equipped {
                if other.id == id {
                    continue;
                }
                if let Some(start) = other.place.strip_prefix("belt:") {
                    let start: u16 = start.parse()?;
                    let w =
                        u16::try_from(catalog.item(&other.section)?.0.integer("inv_grid_width")?)?;
                    if u16::from(*cell) < start + w
                        && start < u16::from(*cell) + u16::from(item_width)
                    {
                        // CoP's cursor placement returns the occupied belt
                        // item to the rucksack. Commit both moves atomically.
                        displaced.push(other.id.as_str());
                    }
                }
            }
        }
    }
    // Validate all rules before the first write. Displacements and the requested
    // placement then commit atomically; no intermediate empty/duplicated slot.
    if old_place == "slot:7" || key == "slot:7" {
        removing(tx, carry, "slot:7")?;
    }
    for displaced in displaced {
        bag(tx, displaced)?;
    }
    let changed = tx.execute(
        "UPDATE inventory_items SET place=?1,revision=revision+1 WHERE id=?2 AND container=?3",
        params![key, id, carry],
    )?;
    ensure!(changed == 1, "lost equipped item");
    Ok(None)
}
