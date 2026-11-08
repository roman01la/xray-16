use crate::{catalog::Catalog, equipment::Placement};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StarterItem {
    pub section: String,
    pub count: u32,
    pub placement: Placement,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageStation {
    pub world: String,
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub max_items: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurvivalRules {
    pub starter_kit: Vec<StarterItem>,
    pub respawn_delay_seconds: u32,
    pub corpse_lifetime_seconds: u32,
    pub dropped_item_lifetime_seconds: u32,
    pub loot_respawn_seconds: u32,
    pub loot_player_exclusion_meters: f64,
    pub loot_max_items_per_spawn: u32,
    #[serde(default)]
    pub private_storage: Option<StorageStation>,
    #[serde(default = "thirst_drain")]
    pub thirst_drain_per_second: f32,
    #[serde(default = "dehydration_damage")]
    pub dehydration_damage_per_second: f32,
    #[serde(default = "hydration_sources")]
    pub hydration_sources: std::collections::BTreeMap<String, f32>,
    pub logout_vulnerability_seconds: u32,
    pub safe_zone_combat_lock_seconds: u32,
}
fn thirst_drain() -> f32 { 0.0002 }
fn dehydration_damage() -> f32 { 0.001 }
fn hydration_sources() -> std::collections::BTreeMap<String, f32> {
    std::collections::BTreeMap::from([("energy_drink".into(), 0.35)])
}
impl Default for SurvivalRules {
    fn default() -> Self {
        serde_json::from_str(include_str!("../config/survival-development.json"))
            .expect("valid development rules")
    }
}
impl SurvivalRules {
    pub fn load(path: &std::path::Path) -> Result<Self> {
        ensure!(std::fs::metadata(path)?.len() < 65536, "rules too large");
        Ok(serde_json::from_slice(&std::fs::read(path)?)?)
    }
    pub fn validate(&self, catalog: &Catalog) -> Result<()> {
        ensure!(self.starter_kit.len() <= 64, "starter kit too large");
        let mut total = 0u64;
        let mut slots = std::collections::BTreeSet::new();
        for item in &self.starter_kit {
            ensure!(item.count > 0, "empty starter grant");
            total += u64::from(item.count);
            catalog.validate_state(&item.section, &catalog.initial_state(&item.section)?)?;
            match &item.placement {
                Placement::Rucksack => {}
                Placement::Slot { slot } => ensure!(
                    item.count == 1
                        && catalog.compatible_slot(&item.section, *slot)?
                        && slots.insert(*slot),
                    "invalid starter slot"
                ),
                Placement::Belt { .. } => {
                    anyhow::bail!("starter artefacts must be granted in rucksack")
                }
            }
        }
        ensure!(total <= 64, "starter kit too large");
        ensure!(
            self.respawn_delay_seconds <= 3600,
            "respawn delay too large"
        );
        for seconds in [
            self.corpse_lifetime_seconds,
            self.dropped_item_lifetime_seconds,
            self.loot_respawn_seconds,
        ] {
            ensure!(
                (1..=604800).contains(&seconds),
                "invalid expiry/respawn interval"
            );
        }
        ensure!(
            self.loot_player_exclusion_meters.is_finite()
                && (0.0..=10000.0).contains(&self.loot_player_exclusion_meters),
            "invalid loot exclusion radius"
        );
        ensure!(
            (1..=1000).contains(&self.loot_max_items_per_spawn),
            "invalid loot cap"
        );
        if let Some(station) = &self.private_storage {
            ensure!(crate::inventory::section_valid(&station.world), "invalid storage world");
            ensure!(station.position.iter().chain(&station.rotation).all(|&value| (value as f32).is_finite()), "invalid storage transform");
            ensure!((1..=128).contains(&station.max_items), "invalid storage item limit");
            ensure!(catalog.section("inventory_box")?.text("class")? == "S_INVBOX", "original locker definition required");
        }
        for rate in [self.thirst_drain_per_second, self.dehydration_damage_per_second] {
            ensure!((0.0..=1.0).contains(&rate), "invalid survival rate");
        }
        ensure!(self.hydration_sources.iter().all(|(item, value)|
            crate::inventory::section_valid(item) && (0.0..=1.0).contains(value)), "invalid hydration source");
        ensure!(
            self.logout_vulnerability_seconds <= 3600 && self.safe_zone_combat_lock_seconds <= 3600,
            "invalid combat timers"
        );
        Ok(())
    }
}
pub fn unix_millis() -> Result<i64> {
    Ok(i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis(),
    )?)
}
