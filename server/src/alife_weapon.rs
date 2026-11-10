use crate::{ballistics::{Dispersion, MAX_PELLETS, MAX_PENETRATION, RoundKey, RoundProfile},
    catalog::Catalog, combat::MAX_OWNED_RANGE, inventory::{ItemPayload, ItemState}};
use anyhow::Result;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct NativeWeaponRules {
    item: u128,
    config: [u8; 16],
    pub(crate) mode: i32,
    legacy_misfire: bool,
    intervals: [f32; 2],
    wear: [f32; 2],
    misfire: [f32; 4],
    pub(crate) reload: ReloadRules,
    impact: WeaponImpact,
    launch: WeaponLaunch,
    cartridges: Arc<[Option<CartridgeRules>]>,
}

#[derive(Clone, Debug)]
pub(crate) struct ReloadRules {
    pub capacity: usize,
    pub incremental: bool,
    pub ammunition: Arc<[String]>,
}

#[derive(Clone, Debug)]
struct WeaponImpact {
    power: f32,
    impulse: f32,
    suppressed: bool,
}

#[derive(Clone, Debug)]
struct WeaponLaunch {
    range: f32,
    speed: f32,
    opening_speed: f32,
    opening_rounds: u8,
    drag_factor: f32,
    dispersion_base: f32,
    dispersion_condition: f32,
    actor_dispersion: Dispersion,
    gravity: f32,
    energy_min: f32,
    energy_max: f32,
}

#[derive(Clone, Copy, Debug)]
struct CartridgeRules {
    key: [u8; 16],
    impact: [f32; 3],
    range_factor: f32,
    drag: f32,
    penetration: f32,
    dispersion: f32,
    pellets: u8,
    ricochet: bool,
    magnetic: bool,
}

pub(crate) struct ShotImpact {
    pub power: f64,
    pub impulse: f64,
    pub wear: f64,
    pub suppressed: bool,
}

fn fire_config(section: &str, state: &ItemState) -> Option<[u8; 16]> {
    let ItemPayload::Weapon { attachments, fire_mode, launcher_mode, .. } = &state.payload else {
        return None;
    };
    let tuning = serde_json::to_vec(&(section, &state.upgrades, attachments, fire_mode, launcher_mode)).ok()?;
    Sha256::digest(tuning)[..16].try_into().ok()
}

fn ammunition_key(section: &str) -> [u8; 16] {
    Sha256::digest(section.as_bytes())[..16].try_into().unwrap()
}

pub(crate) fn round_key(section: &str, state: &ItemState, cartridge: &str) -> Option<RoundKey> {
    Some(RoundKey {
        weapon: fire_config(section, state)?,
        ammunition: ammunition_key(cartridge),
        condition: state.condition,
    })
}

impl NativeWeaponRules {
    pub(crate) fn matches_item(&self, item: [u8; 16]) -> bool {
        self.item.to_le_bytes() == item
    }

    pub(crate) fn matches_config(&self, item: &str, section: &str, state: &ItemState) -> bool {
        u128::from_str_radix(item, 16).ok() == Some(self.item)
            && fire_config(section, state) == Some(self.config)
    }

    pub(crate) fn seconds(&self, index: u32) -> f64 {
        f64::from(self.intervals[usize::from(index >= 2)])
    }

    pub(crate) fn wear(&self, index: u32) -> f64 {
        f64::from(self.wear[usize::from(index != 0)])
    }

    fn cartridge_wear(&self, index: u32, impair: f32) -> f32 {
        self.wear[usize::from(index != 0)] * impair
    }

    pub(crate) fn shot_impact(&self, cartridge: &str, index: u32) -> Option<ShotImpact> {
        let i = self.reload.ammunition.iter().position(|ammo| ammo == cartridge)?;
        let [power, impulse, impair] = self.cartridges[i]?.impact;
        Some(ShotImpact {
            power: f64::from(self.impact.power * power),
            impulse: f64::from(self.impact.impulse * impulse),
            wear: f64::from(self.cartridge_wear(index, impair)),
            suppressed: self.impact.suppressed,
        })
    }

    /// Resolve damage from the same native snapshot and round used for tracing.
    /// A different item, cartridge, fire configuration or launch profile must
    /// be retraced before requesting a native victim condition proposal.
    pub fn traced_damage(&self, item: &str, profile: RoundProfile, index: u32)
        -> Option<crate::alife_attacks::NativeDamage> {
        if u128::from_str_radix(item,16).ok()!=Some(self.item)
            || self.launch_profile(profile,index)?!=profile { return None; }
        let key=profile.key?;
        let round=self.cartridges.iter().flatten().find(|round|round.key==key.ammunition)?;
        Some(crate::alife_attacks::NativeDamage {
            kind:crate::alife_attacks::NativeHitKind::Bullet,
            power:[self.impact.power*round.impact[0],0.0,0.0],
            impulse:self.impact.impulse*round.impact[1],penetration:round.penetration,
        })
    }

    pub(crate) fn launch_profile(&self, mut profile: RoundProfile, index: u32) -> Option<RoundProfile> {
        let key = profile.key?;
        if key.weapon != self.config { return None; }
        let round = self.cartridges.iter().flatten().find(|round| round.key == key.ammunition)?;
        let opening = index < u32::from(self.launch.opening_rounds);
        profile.range = self.launch.range * round.range_factor;
        profile.speed = if opening {
            self.launch.opening_speed
        } else {
            self.launch.speed
        };
        profile.drag = self.launch.drag_factor * round.drag;
        profile.gravity = self.launch.gravity;
        profile.pellets = round.pellets;
        profile.surface.penetration = round.penetration;
        profile.surface.ricochet = round.ricochet;
        profile.surface.magnetic = round.magnetic;
        profile.surface.energy_min = self.launch.energy_min;
        profile.surface.energy_max = self.launch.energy_max;
        // Stock opening rounds use the weapon's cone without actor dispersion.
        let actor = if opening { Dispersion::default() } else { self.launch.actor_dispersion };
        let cone = |index| {
            let condition = (key.condition - self.cartridge_wear(index, round.impact[2])).clamp(0.0, 1.0);
            self.launch.dispersion_base * round.dispersion
                * crate::xray_combat_rules::weapon_condition_dispersion(condition, self.launch.dispersion_condition)
        };
        profile.spread = Dispersion { first: cone(0), followup: cone(1), ..actor };
        Some(profile)
    }

    pub(crate) fn misfire_probability(&self, condition: f32) -> f64 {
        let [first, second, start_p, end_p] = self.misfire;
        f64::from(if self.legacy_misfire {
            crate::xray_combat_rules::legacy_misfire(condition, first, second)
        } else {
            crate::xray_combat_rules::misfire(condition, first, second, start_p, end_p)
        })
    }
}

#[cfg(unix)]
pub(crate) fn decode_weapon_rules(packet: &[u8], epoch: u64, boot: u64, now: u32)
    -> Option<(u32, u32, u32, NativeWeaponRules)>
{
    if packet.len() < 194 || !packet.starts_with(b"ZAF5") {
        return None;
    }
    let word = |at| u32::from_le_bytes(packet[at..at + 4].try_into().unwrap());
    let scalar = |at| f32::from_bits(word(at));
    let wide = |at| u64::from_le_bytes(packet[at..at + 8].try_into().unwrap());
    let tick = word(4);
    if wide(8) != epoch || wide(16) != boot || now.wrapping_sub(tick) > 5 {
        return None;
    }
    let item = u128::from_str_radix(std::str::from_utf8(&packet[32..64]).ok()?, 16).ok()?;
    let mode = word(80) as i32;
    let legacy_misfire = match word(84) { 0 => false, 1 => true, _ => return None };
    let values = |start| std::array::from_fn(|i| f32::from_bits(word(start + i * 4)));
    let intervals: [f32; 2] = values(88);
    let wear: [f32; 2] = values(96);
    let misfire: [f32; 4] = std::array::from_fn(|i| f32::from_bits(word(104 + i * 4)));
    if item == 0 || (mode != -1 && !(1..=255).contains(&mode))
        || !intervals.iter().all(|time| (0.001..=10.0).contains(time))
        || !wear.iter().all(|amount| (0.0..=1.0).contains(amount))
        || !(0.0..=1.0).contains(&misfire[0])
        || !(0.0..=if legacy_misfire { 100.0 } else { 1.0 }).contains(&misfire[1])
        || !misfire[2..].iter().all(|chance| (0.0..=1.0).contains(chance))
    {
        return None;
    }
    let capacity = usize::from(u16::from_le_bytes(packet[120..122].try_into().ok()?));
    let incremental = match packet[122] { 0 => false, 1 => true, _ => return None };
    let count = usize::from(packet[123]);
    if !(1..=1024).contains(&capacity) || !(1..=64).contains(&count) {
        return None;
    }
    let power = f32::from_bits(word(124));
    let impulse = f32::from_bits(word(128));
    let suppressed = match packet[132] { 0 => false, 1 => true, _ => return None };
    if !(0.0..=100.0).contains(&power) || !(0.0..=1_000_000.0).contains(&impulse) {
        return None;
    }
    let launch = WeaponLaunch {
        range: scalar(134),
        speed: scalar(138),
        opening_speed: scalar(142),
        opening_rounds: packet[133],
        drag_factor: scalar(146),
        dispersion_base: scalar(150),
        dispersion_condition: scalar(154),
        actor_dispersion: Dispersion {
            actor_base: scalar(158), actor_aim: scalar(162), velocity_factor: scalar(166),
            acceleration_factor: scalar(170), crouch_factor: scalar(174), crouch_still_factor: scalar(178),
            ..Default::default()
        },
        gravity: scalar(182),
        energy_min: scalar(186),
        energy_max: scalar(190),
    };
    if !launch.range.is_finite() || launch.range <= 0.0
        || !(1.0..=100_000.0).contains(&launch.speed)
        || !(1.0..=100_000.0).contains(&launch.opening_speed)
        || !launch.drag_factor.is_finite() || launch.drag_factor < 0.0
        || !(0.0..=std::f32::consts::PI).contains(&launch.dispersion_base)
        || ![154, 158, 162, 166, 170, 174, 178].iter().all(|&at| (-100.0..=100.0).contains(&scalar(at)))
        || !(0.0..=100.0).contains(&launch.gravity)
        || ![launch.energy_min, launch.energy_max].iter().all(|v| (0.0..=1.0).contains(v))
    {
        return None;
    }
    let mut remaining = &packet[194..];
    let mut ammunition = Vec::with_capacity(count);
    let mut cartridges = Vec::with_capacity(count);
    for _ in 0..count {
        let (&length, bytes) = remaining.split_first()?;
        if !(1..=63).contains(&length) { return None; }
        let (name, rest) = bytes.split_at_checked(usize::from(length))?;
        if !name.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')) {
            return None;
        }
        let name = std::str::from_utf8(name).ok()?;
        if ammunition.iter().any(|previous| previous == name) { return None; }
        ammunition.push(name.to_owned());
        let (&kind, rest) = rest.split_first()?;
        remaining = match kind {
            0 => { cartridges.push(None); rest }
            1 => {
                let (bytes, tail) = rest.split_at_checked(30)?;
                let [hit, impulse_factor, impair, range_factor, drag, penetration, dispersion] = std::array::from_fn(|i|
                    f32::from_le_bytes(bytes[4 * i..4 * i + 4].try_into().unwrap()));
                let pellets = bytes[28];
                let flags = bytes[29];
                let range = launch.range * range_factor;
                if ![hit, impulse_factor, impair].iter().all(|factor| (0.0..=100.0).contains(factor))
                    || power * hit > 100.0 || impulse * impulse_factor > 1_000_000.0
                    || !(range > 0.0 && range <= MAX_OWNED_RANGE)
                    || !(0.0..=10.0).contains(&(launch.drag_factor * drag))
                    || !drag.is_finite() || drag < 0.0
                    || !(0.0..=MAX_PENETRATION).contains(&penetration)
                    || !(0.0..=100.0).contains(&dispersion)
                    || !(1..=MAX_PELLETS).contains(&pellets) || flags > 3
                {
                    return None;
                }
                cartridges.push(Some(CartridgeRules {
                    key: ammunition_key(name),
                    impact: [hit, impulse_factor, impair],
                    range_factor, drag, penetration, dispersion, pellets,
                    ricochet: flags & 1 != 0,
                    magnetic: flags & 2 != 0,
                }));
                tail
            }
            _ => return None,
        };
    }
    if !remaining.is_empty() { return None; }
    Some((word(24), word(28), tick, NativeWeaponRules {
        item, config: packet[64..80].try_into().ok()?, mode, legacy_misfire, intervals, wear, misfire,
        reload: ReloadRules { capacity, incremental, ammunition: ammunition.into() },
        impact: WeaponImpact { power, impulse, suppressed },
        launch,
        cartridges: cartridges.into(),
    }))
}

#[derive(Serialize, Deserialize)]
pub(crate) struct ReserveAmmo {
    id: String,
    revision: u32,
    section: String,
    rounds: u16,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Weapon {
    slot: u8,
    id: String,
    revision: u32,
    section: String,
    state: ItemState,
    addons: u8,
    scope: Option<String>,
    generation: u64,
    reserve: Vec<ReserveAmmo>,
}

pub(crate) fn read(tx: &Transaction<'_>, principal: &str, catalog: Option<&Catalog>, generation: u64) -> Result<Option<Weapon>> {
    let Some(catalog) = catalog else { return Ok(None) };
    let slot = crate::inventory::active_weapon_slot(tx, principal)?;
    if !matches!(slot, 2 | 3) {
        return Ok(None);
    }
    let row: Option<(String, u32, String, String)> = tx.query_row(
        "SELECT i.id,i.revision,i.section,i.state FROM inventory_items i
         JOIN item_containers c ON c.id=i.container
         WHERE c.owner=?1 AND c.kind='carried' AND i.place=?2",
        params![principal, format!("slot:{slot}")],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).optional()?;
    let Some((id, revision, section, raw)) = row else { return Ok(None) };
    let state: ItemState = serde_json::from_str(&raw)?;
    let ItemPayload::Weapon { attachments, .. } = &state.payload else { return Ok(None) };
    let (addons, scope) = catalog.equipped_addons(&section, &state, attachments)?;
    let mut query = tx.prepare("SELECT i.id,i.revision,i.section,i.state FROM inventory_items i
        JOIN item_containers c ON c.id=i.container WHERE c.owner=?1 AND c.kind='carried'
        AND (i.place='rucksack' OR i.place LIKE 'belt:%') ORDER BY i.id")?;
    let mut rows = query.query(params![principal])?;
    let mut reserve = Vec::new();
    while let Some(row) = rows.next()? {
        let raw: String = row.get(3)?;
        let ammo: ItemState = serde_json::from_str(&raw)?;
        if let ItemPayload::Ammunition { rounds } = ammo.payload {
            anyhow::ensure!(rounds > 0 && rounds <= u16::MAX as u32 && reserve.len() < 128,
                "native reserve ammunition exceeds bounded snapshot");
            reserve.push(ReserveAmmo { id: row.get(0)?, revision: row.get(1)?,
                section: row.get(2)?, rounds: rounds as u16 });
        }
    }
    Ok(Some(Weapon { slot, id, revision, section, state, addons, scope, generation, reserve }))
}

#[cfg(unix)]
pub(crate) fn encode(packet: &mut Vec<u8>, epoch: u64, boot: u64, player: u32, incarnation: u32, weapon: Option<&Weapon>) -> bool {
    packet.clear();
    packet.extend_from_slice(b"ZAW3");
    packet.extend_from_slice(&epoch.to_le_bytes());
    packet.extend_from_slice(&boot.to_le_bytes());
    packet.extend_from_slice(&player.to_le_bytes());
    packet.extend_from_slice(&incarnation.to_le_bytes());
    let Some(weapon) = weapon else {
        packet.push(0);
        return true;
    };
    let ItemPayload::Weapon {
        cartridges, launcher_cartridges, selected_ammunition, fire_mode, launcher_mode, jammed, ..
    } = &weapon.state.payload else { return false };
    let Ok(id) = u128::from_str_radix(&weapon.id, 16) else { return false };
    if id == 0 || !crate::ownership::valid_id(&weapon.id) || weapon.section.len() >= 64 ||
        !(0.0..=1.0).contains(&weapon.state.condition) || weapon.state.upgrades.len() > 32 ||
        cartridges.len() > 512 || launcher_cartridges.len() > 1
    {
        return false;
    }
    let mut names: Vec<&str> = Vec::new();
    let mut rounds = Vec::with_capacity(cartridges.len() + launcher_cartridges.len());
    for section in cartridges.iter().chain(launcher_cartridges) {
        let index = names.iter().position(|name| *name == section).unwrap_or_else(|| {
            names.push(section);
            names.len() - 1
        });
        if index >= 64 { return false; }
        rounds.push(index as u8);
    }
    let section = |packet: &mut Vec<u8>, name: &str| {
        if !crate::inventory::section_valid(name) { return false; }
        packet.extend_from_slice(&(name.len() as u16).to_le_bytes());
        packet.extend_from_slice(name.as_bytes());
        true
    };
    packet.push(weapon.slot);
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&weapon.revision.to_le_bytes());
    packet.extend_from_slice(&weapon.state.condition.to_le_bytes());
    packet.extend([*fire_mode, u8::from(*launcher_mode) | (u8::from(*jammed) << 1), weapon.addons]);
    if !section(packet, &weapon.section) || !section(packet, selected_ammunition) { return false; }
    packet.push(u8::from(weapon.scope.is_some()));
    if let Some(scope) = &weapon.scope && !section(packet, scope) { return false; }
    packet.push(weapon.state.upgrades.len() as u8);
    for name in &weapon.state.upgrades {
        if !section(packet, name) { return false; }
    }
    packet.push(names.len() as u8);
    for name in names {
        if !section(packet, name) { return false; }
    }
    packet.extend_from_slice(&(cartridges.len() as u16).to_le_bytes());
    packet.push(launcher_cartridges.len() as u8);
    packet.extend(rounds);
    let Some(config) = fire_config(&weapon.section, &weapon.state) else { return false; };
    packet.extend_from_slice(&config);
    if weapon.reserve.len() > 128 || weapon.generation > 9007199254740991 { return false; }
    packet.extend_from_slice(&weapon.generation.to_le_bytes());
    packet.push(weapon.reserve.len() as u8);
    let mut seen = std::collections::BTreeSet::new();
    for ammo in &weapon.reserve {
        let Ok(id) = u128::from_str_radix(&ammo.id, 16) else { return false; };
        if id == 0 || !crate::ownership::valid_id(&ammo.id) || !seen.insert(id) || ammo.rounds == 0 || ammo.section.len() >= 64 {
            return false;
        }
        packet.extend_from_slice(&id.to_be_bytes());
        packet.extend_from_slice(&ammo.revision.to_le_bytes());
        packet.extend_from_slice(&ammo.rounds.to_le_bytes());
        if !section(packet, &ammo.section) { return false; }
    }
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn native_weapon_packet_keeps_mixed_cartridges_and_clears_holstered_weapon() {
        let mut weapon = Weapon {
            slot: 3, id: "0123456789abcdef0123456789abcdef".into(), revision: 12,
            section: "wpn_ak74".into(), addons: 2, scope: None, generation: 7, reserve: vec![],
            state: ItemState { condition: 0.7, upgrades: vec![], payload: ItemPayload::Weapon {
                cartridges: vec!["fmj".into(), "ap".into(), "fmj".into()],
                launcher_cartridges: vec!["grenade".into()], selected_ammunition: "ap".into(),
                attachments: vec!["launcher".into()], attachment_items: vec![],
                fire_mode: 1, launcher_mode: true, jammed: true,
            }},
        };
        let mut packet = Vec::new();
        assert!(encode(&mut packet, 1, 2, 3, 4, Some(&weapon)));
        assert_eq!(&packet[..4], b"ZAW3");
        assert_eq!(&packet[28..33], &[3, 0x01, 0x23, 0x45, 0x67]);
        assert_eq!(&packet[53..56], &[1, 3, 2]);
        assert!(packet[..packet.len()-25].ends_with(b"\x03\x03\x00fmj\x02\x00ap\x07\x00grenade\x03\x00\x01\x00\x01\x00\x02"));
        assert_eq!(&packet[packet.len()-25..packet.len()-9], &fire_config(&weapon.section, &weapon.state).unwrap());
        assert_eq!(&packet[packet.len()-9..], &[7,0,0,0,0,0,0,0,0]);
        weapon.reserve.push(ReserveAmmo { id: "11111111111111111111111111111111".into(),
            revision: 9, section: "ammo_545x39_fmj".into(), rounds: 23 });
        assert!(encode(&mut packet, 1, 2, 3, 4, Some(&weapon)));
        let tail = &packet[packet.len() - (16 + 4 + 2 + 2 + 15)..];
        assert_eq!(&tail[..16], &[0x11; 16]);
        assert_eq!(&tail[16..24], &[9,0,0,0,23,0,15,0]);
        assert_eq!(&tail[24..], b"ammo_545x39_fmj");
        weapon.reserve.push(ReserveAmmo { id: weapon.reserve[0].id.clone(),
            revision: 10, section: "ammo_545x39_ap".into(), rounds: 1 });
        assert!(!encode(&mut packet, 1, 2, 3, 4, Some(&weapon))); // duplicate box
        weapon.reserve.pop();
        weapon.reserve[0].rounds = 0;
        assert!(!encode(&mut packet, 1, 2, 3, 4, Some(&weapon)));
        assert!(encode(&mut packet, 1, 2, 3, 4, None));
        assert_eq!(&packet[28..], &[0]);
    }

    #[test]
    fn native_weapon_rules_bind_to_the_weapon_configuration_and_expire_on_the_wire() {
        let item = "0123456789abcdef0123456789abcdef";
        let mut state = ItemState {
            condition: 0.5,
            upgrades: vec![],
            payload: ItemPayload::Weapon {
                cartridges: vec!["fmj".into()],
                launcher_cartridges: vec![],
                selected_ammunition: "fmj".into(),
                attachments: vec![],
                attachment_items: vec![],
                fire_mode: 2,
                launcher_mode: false,
                jammed: false,
            },
        };
        let mut packet = Vec::from(*b"ZAF5");
        packet.extend(20u32.to_le_bytes());
        packet.extend(1u64.to_le_bytes());
        packet.extend(2u64.to_le_bytes());
        packet.extend(3u32.to_le_bytes());
        packet.extend(4u32.to_le_bytes());
        packet.extend(item.as_bytes());
        packet.extend(fire_config("wpn_abakan", &state).unwrap());
        packet.extend((-1i32).to_le_bytes());
        packet.extend(0u32.to_le_bytes());
        for value in [0.05f32, 0.1, 0.002, 0.004, 0.75, 0.25, 0.1, 0.5] {
            packet.extend(value.to_le_bytes());
        }
        packet.extend([6, 0, 1, 2]);
        packet.extend(0.5f32.to_le_bytes());
        packet.extend(10.0f32.to_le_bytes());
        packet.extend([1, 2]);
        for value in [200.0f32, 900.0, 1100.0, 2.0] {
            packet.extend(value.to_le_bytes());
        }
        for value in [0.03f32, 2.0, 0.02, 0.001, 4.0, 5.0, -0.35, -0.75, 9.81, 0.8, 0.5] {
            packet.extend(value.to_le_bytes());
        }
        packet.extend([3, b'f', b'm', b'j', 1]);
        for value in [0.75f32, 1.25, 2.0, 0.5, 0.5, 0.75, 1.5] {
            packet.extend(value.to_le_bytes());
        }
        packet.extend([3, 1]);
        packet.extend([2, b'a', b'p', 0]);
        let (player, life, tick, rules) = decode_weapon_rules(&packet, 1, 2, 25).unwrap();
        assert_eq!((player, life, tick, rules.mode), (3, 4, 20, -1));
        assert_eq!(rules.reload.capacity, 6);
        assert!(rules.reload.incremental);
        assert_eq!(&*rules.reload.ammunition, &["fmj", "ap"]);
        let impact = rules.shot_impact("fmj", 1).unwrap();
        assert_eq!((impact.power, impact.impulse, impact.suppressed), (0.375, 12.5, true));
        assert!((impact.wear - 0.008).abs() < 1e-7);
        assert!(rules.shot_impact("ap", 1).is_none());
        let profile = RoundProfile {
            revision: 7, key: round_key("wpn_abakan", &state, "fmj"),
            range: 300.0, speed: 400.0, drag: 0.1, gravity: 9.81, pellets: 1,
            spread: Default::default(), surface: Default::default(),
        };
        let launch = rules.launch_profile(profile, 1).unwrap();
        assert_eq!((launch.speed, launch.range, launch.drag, launch.pellets), (1100.0, 100.0, 1.0, 3));
        assert_eq!((launch.surface.penetration, launch.surface.ricochet), (0.75, true));
        assert_eq!((launch.gravity, launch.surface.energy_min, launch.surface.energy_max), (9.81, 0.8, 0.5));
        assert_eq!(launch.spread.actor_base, 0.0);
        assert!((launch.spread.followup - 0.09072).abs() < 1e-7);
        let damage=rules.traced_damage(item,launch,1).unwrap();
        assert_eq!(damage.power,[impact.power as f32,0.0,0.0]);
        assert_eq!(damage.impulse,impact.impulse as f32);
        assert_eq!(damage.penetration,launch.surface.penetration);
        assert!(rules.traced_damage("ffffffffffffffffffffffffffffffff",launch,1).is_none());
        assert!(rules.traced_damage(item,profile,1).is_none());
        assert!(rules.traced_damage(item,launch,2).is_none());
        assert!(rules.traced_damage(item,RoundProfile{key:None,..launch},1).is_none());
        let sustained = rules.launch_profile(profile, 2).unwrap();
        assert_eq!((sustained.speed, sustained.spread.actor_base), (900.0, 0.02));
        assert!(rules.launch_profile(RoundProfile { key: round_key("wpn_abakan", &state, "ap"), ..profile }, 1).is_none());
        assert!(decode_weapon_rules(&packet[..packet.len() - 1], 1, 2, 25).is_none());
        assert!((rules.seconds(1) - 0.05).abs() < 1e-7);
        assert!((rules.seconds(2) - 0.1).abs() < 1e-7);
        assert!((rules.wear(1) - 0.004).abs() < 1e-7);
        assert!((rules.misfire_probability(state.condition) - 0.3).abs() < 1e-6);
        assert!(decode_weapon_rules(&packet, 1, 2, 26).is_none());
        assert!(decode_weapon_rules(&packet, 1, 3, 25).is_none());
        assert!(rules.matches_config(item, "wpn_abakan", &state));
        state.condition = 0.4;
        let ItemPayload::Weapon { cartridges, .. } = &mut state.payload else { unreachable!() };
        cartridges.clear();
        assert!(rules.matches_config(item, "wpn_abakan", &state));
        let ItemPayload::Weapon { fire_mode, .. } = &mut state.payload else { unreachable!() };
        *fire_mode = 1;
        assert!(!rules.matches_config(item, "wpn_abakan", &state));
    }
}
