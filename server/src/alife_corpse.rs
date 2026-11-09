//! Post-death inventory from the private native A-Life host.
use crate::{
    catalog::Catalog,
    inventory::{self, ItemPayload, ItemState},
    survival_rules::SurvivalRules,
};
use anyhow::{Result, ensure};
use rusqlite::{Transaction, params};
use serde_json::{Value, json};

pub const MAX_PACKET: usize = 8192;
const MAX_ITEMS: usize = 64;
pub(crate) const SCHEMA: &str = "
CREATE TABLE alife_corpse_deaths (
    world TEXT NOT NULL, host BLOB NOT NULL, death BLOB NOT NULL,
    PRIMARY KEY(world, host, death)
) WITHOUT ROWID;
PRAGMA user_version=21;";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct DeathId {
    pub host: u64,
    pub serial: u64,
}

#[derive(Clone)]
pub struct Corpse {
    pub id: DeathId,
    pub(crate) world: String,
    position: [f64; 3],
    items: Vec<Loot>,
}

impl Corpse {
    pub fn align_with_floor(&mut self, world: &crate::world::World) {
        self.position = world.native_corpse_anchor(self.position);
    }
}

#[derive(Clone)]
struct Loot {
    section: String,
    state: ItemState,
}

struct Reader<'a>(&'a [u8]);
impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_at_checked(N)?;
        self.0 = rest;
        head.try_into().ok()
    }
    fn byte(&mut self) -> Option<u8> {
        Some(self.take::<1>()?[0])
    }
    fn name(&mut self) -> Option<String> {
        let len = usize::from(self.byte()?);
        let (value, rest) = self.0.split_at_checked(len)?;
        self.0 = rest;
        let value = std::str::from_utf8(value).ok()?;
        inventory::section_valid(value).then(|| value.into())
    }
    fn names(&mut self, limit: u8) -> Option<Vec<String>> {
        let count = self.byte()?;
        (count <= limit).then_some(())?;
        (0..count).map(|_| self.name()).collect()
    }
    fn magazine(&mut self) -> Option<Vec<String>> {
        let count = self.byte()?;
        let mut rounds = Vec::new();
        for _ in 0..count {
            let section = self.name()?;
            let size = usize::from(u16::from_le_bytes(self.take()?));
            (size != 0 && rounds.len() + size <= 512).then_some(())?;
            rounds.extend(std::iter::repeat_n(section, size));
        }
        Some(rounds)
    }
    fn item(&mut self) -> Option<Loot> {
        let section = self.name()?;
        let condition = f32::from_le_bytes(self.take()?);
        let upgrades = self.names(32)?;
        let payload = match self.byte()? {
            0 => ItemPayload::Equipment,
            1 => ItemPayload::Ammunition {
                rounds: u32::from(u16::from_le_bytes(self.take()?)),
            },
            2 => ItemPayload::Consumable {
                uses: u32::from(self.byte()?),
            },
            3 => {
                let selected_ammunition = self.name()?;
                let cartridges = self.magazine()?;
                let launcher_cartridges = self.magazine()?;
                let attachments = self.names(3)?;
                let fire_mode = self.byte()?;
                let flags = self.byte()?;
                (flags <= 3).then_some(())?;
                ItemPayload::Weapon {
                    cartridges,
                    launcher_cartridges,
                    selected_ammunition,
                    attachments,
                    attachment_items: Vec::new(),
                    fire_mode,
                    launcher_mode: flags & 1 != 0,
                    jammed: flags & 2 != 0,
                }
            }
            _ => return None,
        };
        let state = ItemState {
            condition,
            upgrades,
            payload,
        };
        state.validate().ok()?;
        Some(Loot { section, state })
    }
}

pub fn decode(bytes: &[u8], epoch: u64, world: &str) -> Option<Corpse> {
    if bytes.len() > MAX_PACKET {
        return None;
    }
    let mut reader = Reader(bytes);
    if reader.take::<4>()? != *b"ZAL1" || u64::from_le_bytes(reader.take()?) != epoch {
        return None;
    }
    let host = u64::from_le_bytes(reader.take()?);
    let serial = u64::from_le_bytes(reader.take()?);
    if host == 0 || serial == 0 || !inventory::section_valid(world) {
        return None;
    }
    let mut position = [0.0; 3];
    for coordinate in &mut position {
        *coordinate = f64::from(f32::from_le_bytes(reader.take()?));
    }
    if !position.iter().all(|v| v.abs() <= 100_000.0) {
        return None;
    }
    let count = usize::from(reader.byte()?);
    if !(1..=MAX_ITEMS).contains(&count) {
        return None;
    }
    let items = (0..count)
        .map(|_| reader.item())
        .collect::<Option<Vec<_>>>()?;
    reader.0.is_empty().then(|| Corpse {
        id: DeathId { host, serial },
        world: world.into(),
        position,
        items,
    })
}

pub(crate) fn commit(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    rules: &SurvivalRules,
    corpse: Corpse,
) -> Result<Value> {
    let inserted = tx.execute(
        "INSERT INTO alife_corpse_deaths(world,host,death) VALUES(?1,?2,?3) ON CONFLICT DO NOTHING",
        params![
            corpse.world,
            corpse.id.host.to_le_bytes(),
            corpse.id.serial.to_le_bytes()
        ],
    )?;
    if inserted == 0 {
        return Ok(json!({"status":"committed","replayed":true}));
    }
    let mut items = Vec::with_capacity(corpse.items.len());
    for item in corpse.items {
        let reviewed = catalog.item(&item.section).and_then(|(section, _)| {
            ensure!(!section.boolean("quest_item", false)?, "quest item");
            catalog.validate_state(&item.section, &item.state)
        });
        if let Err(error) = reviewed {
            tracing::warn!(section=%item.section, "excluded native corpse item: {error}");
            continue;
        }
        items.push(item);
    }
    if items.is_empty() {
        return Ok(json!({"status":"committed","items":0}));
    }
    let container = inventory::world_container(tx, "corpse", &corpse.world, corpse.position)?;
    inventory::set_expiry(tx, &container, rules.corpse_lifetime_seconds)?;
    let count = items.len();
    for item in items {
        inventory::provision(tx, &container, &item.section, &item.state, "rucksack")?;
    }
    Ok(json!({"status":"committed","corpse":container,"items":count}))
}
