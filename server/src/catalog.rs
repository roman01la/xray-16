//! Effective original CoP configuration exported by tools/export-item-catalog.mjs.
//! Keep the source values: weapon/upgrade/survival consumers share one catalog.
use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Section {
    pub source: String,
    pub values: BTreeMap<String, String>,
}
impl Section {
    pub fn text(&self, key: &str) -> Result<&str> {
        self.values
            .get(key)
            .map(String::as_str)
            .with_context(|| format!("missing {key} in {}", self.source))
    }
    pub fn number(&self, key: &str) -> Result<f64> {
        // Original configs use C float suffixes (e.g. control_inertion_factor=1.2f).
        let value: f64 = self.text(key)?.trim_end_matches(['f', 'F']).parse()?;
        ensure!(value.is_finite(), "nonfinite {key}");
        Ok(value)
    }
    pub fn integer(&self, key: &str) -> Result<i32> {
        Ok(self.text(key)?.parse()?)
    }
    pub fn boolean(&self, key: &str, default: bool) -> Result<bool> {
        match self.values.get(key).map(String::as_str) {
            None => Ok(default),
            Some("true" | "on" | "1" | "yes") => Ok(true),
            Some("false" | "off" | "0" | "no") => Ok(false),
            _ => bail!("invalid boolean {key}"),
        }
    }
    pub fn list(&self, key: &str) -> Vec<&str> {
        self.values
            .get(key)
            .map(|v| {
                v.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceFile {
    path: String,
    sha256: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Export {
    schema: u32,
    entry: String,
    files: Vec<SourceFile>,
    sections: BTreeMap<String, Section>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Weapon,
    Ammunition,
    Consumable,
    Outfit,
    Helmet,
    Artefact,
    Equipment,
}
#[derive(Clone, Debug)]
pub struct Catalog {
    pub sha256: String,
    sections: BTreeMap<String, Section>,
}
impl Catalog {
    pub fn load(path: &Path) -> Result<Self> {
        ensure!(
            std::fs::metadata(path)?.len() <= 16 * 1024 * 1024,
            "catalog too large"
        );
        Self::from_bytes(&std::fs::read(path)?)
    }
    pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() <= 16 * 1024 * 1024, "catalog too large");
        let export: Export = serde_json::from_slice(bytes)?;
        ensure!(
            export.schema == 1 && export.entry == "system.ltx",
            "unsupported catalog"
        );
        ensure!(
            !export.files.is_empty()
                && export.files.len() <= 10000
                && export.sections.len() <= 20000,
            "invalid catalog size"
        );
        for file in &export.files {
            ensure!(
                !file.path.starts_with('/')
                    && !file.path.split('/').any(|v| v == "..")
                    && file.sha256.len() == 64
                    && file.sha256.bytes().all(|v| v.is_ascii_hexdigit()),
                "invalid source provenance"
            );
        }
        let catalog = Self {
            sha256: format!("{:x}", Sha256::digest(bytes)),
            sections: export.sections,
        };
        ensure!(
            catalog.section("inventory")?.number("take_dist")? > 0.0,
            "invalid pickup distance"
        );
        ensure!(
            catalog.section("inventory")?.number("max_weight")? > 0.0,
            "invalid weight threshold"
        );
        Ok(catalog)
    }
    pub fn section(&self, name: &str) -> Result<&Section> {
        self.sections
            .get(name)
            .with_context(|| format!("unknown section {name}"))
    }
    pub fn item(&self, name: &str) -> Result<(&Section, Kind)> {
        ensure!(
            !name.starts_with("mp_"),
            "native arena definitions are not survival items"
        );
        let s = self.section(name)?;
        s.text("inv_name")?;
        ensure!(s.number("inv_weight")? >= 0.0, "negative item weight");
        let kind = match s.text("class")? {
            "WP_AK74" | "WP_GROZA" | "WP_RPG7" | "WP_RG6" | "WP_LR300" | "WP_VAL" | "WP_SVD"
            | "WP_HPSA" | "WP_PM" | "WP_BM16" | "WP_SVU" | "WP_ASHTG" => Kind::Weapon,
            "AMMO_S" | "S_OG7B" | "S_VOG25" | "S_M209" => Kind::Ammunition,
            "S_FOOD" => Kind::Consumable,
            "E_STLK" => Kind::Outfit,
            "E_HLMET" => Kind::Helmet,
            "ARTEFACT" | "SCRPTART" => Kind::Artefact,
            "WP_KNIFE" | "WP_BINOC" | "II_BOLT" | "G_F1_S" | "G_RGD5_S" | "WP_SCOPE"
            | "WP_SILEN" | "WP_GLAUN" | "II_ATTCH" | "S_PDA" | "D_PDA" | "TORCH_S" | "D_FLARE"
            | "DET_SIMP" | "DET_ADVA" | "DET_ELIT" | "DET_SCIE" => Kind::Equipment,
            value => bail!("unsupported inventory class {value}"),
        };
        Ok((s, kind))
    }
    pub fn sections_len(&self) -> usize {
        self.sections.len()
    }
    pub fn item_names(&self) -> impl Iterator<Item = &str> {
        self.sections
            .keys()
            .filter(|name| self.item(name).is_ok())
            .map(String::as_str)
    }
    /// LTX slots are zero based; the engine adds one to reserve NO_ACTIVE_SLOT.
    pub fn base_slot(&self, name: &str) -> Result<Option<u8>> {
        let (s, _) = self.item(name)?;
        let slot = s
            .values
            .get("slot")
            .map(|_| s.integer("slot"))
            .transpose()?
            .unwrap_or(-1);
        ensure!((-1..=12).contains(&slot), "invalid item slot");
        Ok(if slot < 0 {
            None
        } else {
            Some((slot + 1) as u8)
        })
    }
    pub fn compatible_slot(&self, name: &str, slot: u8) -> Result<bool> {
        let base = self.base_slot(name)?;
        // CoP permits either ordinary weapon slot, unlike the earlier games.
        Ok(base == Some(slot) || matches!(base, Some(2 | 3)) && matches!(slot, 2 | 3))
    }
    pub fn initial_state(&self, name: &str) -> Result<crate::inventory::ItemState> {
        use crate::inventory::{ItemPayload, ItemState};
        let (s, kind) = self.item(name)?;
        let positive = |key| -> Result<u32> {
            let n = u32::try_from(s.integer(key)?)?;
            ensure!(n > 0, "invalid {key}");
            Ok(n)
        };
        let payload = match kind {
            Kind::Ammunition => ItemPayload::Ammunition {
                rounds: positive("box_size")?,
            },
            Kind::Consumable => ItemPayload::Consumable {
                uses: positive("eat_portions_num")?,
            },
            Kind::Weapon => {
                let selected = s
                    .list("ammo_class")
                    .first()
                    .context("weapon has no ammunition")?
                    .to_string();
                ItemPayload::Weapon {
                    cartridges: vec![],
                    launcher_cartridges: vec![],
                    selected_ammunition: selected,
                    attachments: vec![],
                    attachment_items: vec![],
                    fire_mode: 0,
                    launcher_mode: false,
                    jammed: false,
                }
            }
            _ => ItemPayload::Equipment,
        };
        let state = ItemState {
            condition: 1.0,
            upgrades: s
                .list("installed_upgrades")
                .into_iter()
                .map(String::from)
                .collect(),
            payload,
        };
        state.validate()?;
        Ok(state)
    }

    pub(crate) fn upgrade_effects<'a>(&'a self, name: &str, upgrades: &[String]) -> Result<Vec<&'a Section>> {
        use std::collections::BTreeSet;
        let (base, _) = self.item(name)?;
        if upgrades.is_empty() { return Ok(Vec::new()); }
        let mut groups = base.list("upgrades");
        let mut visited = BTreeSet::new();
        let mut allowed = BTreeSet::new();
        while let Some(group) = groups.pop() {
            if !visited.insert(group) {
                continue;
            }
            for id in self.section(group)?.list("elements") {
                allowed.insert(id);
                groups.extend(self.section(id)?.list("effects"));
            }
        }
        let mut unique = BTreeSet::new();
        let mut result = Vec::new();
        for id in upgrades {
            ensure!(
                unique.insert(id) && allowed.contains(id.as_str()),
                "invalid or duplicate upgrade {id} for {name}"
            );
            result.push(self.section(self.section(id)?.text("section")?)?);
        }
        Ok(result)
    }
    /// Numeric upgrade parameters use addition in CInventoryItem::process_if_exists.
    pub fn effective_number(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
        key: &str,
        default: f64,
    ) -> Result<f64> {
        let (base, _) = self.item(name)?;
        let mut value = if base.values.contains_key(key) {
            base.number(key)?
        } else {
            default
        };
        for effect in self.upgrade_effects(name, &state.upgrades)? {
            if effect.values.get(key).is_some_and(|v| !v.is_empty()) {
                value += effect.number(key)?;
            }
        }
        ensure!(value.is_finite(), "invalid effective {key}");
        Ok(value)
    }
    pub fn effective_text(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
        key: &str,
    ) -> Result<Option<String>> {
        let mut value = self.item(name)?.0.values.get(key).cloned();
        for effect in self.upgrade_effects(name, &state.upgrades)? {
            if let Some(next) = effect.values.get(key).filter(|s| !s.is_empty()) {
                value = Some(next.clone());
            }
        }
        Ok(value)
    }
    pub(crate) fn effective_list(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
        key: &str,
    ) -> Result<Vec<String>> {
        Ok(self
            .effective_text(name, state, key)?
            .unwrap_or_default()
            .split(',')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect())
    }
    pub(crate) fn addons(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
    ) -> Result<Vec<(u8, Vec<String>)>> {
        let mut result = Vec::new();
        for addon in ["scope", "silencer", "grenade_launcher"] {
            let status: u8 = self
                .effective_text(name, state, &format!("{addon}_status"))?
                .unwrap_or_else(|| "0".into())
                .parse()?;
            ensure!(status <= 2, "invalid addon status");
            let mut names = self.effective_list(name, state, &format!("{addon}_name"))?;
            if addon == "scope" && status == 2 {
                // The engine builds its list from the base and appends scopes
                // from each upgrade that sets the status to attachable.
                names.clear();
                for definition in std::iter::once(self.section(name)?)
                    .chain(self.upgrade_effects(name, &state.upgrades)?)
                    .filter(|s| s.values.get("scope_status").is_some_and(|v| v == "2"))
                {
                    if definition.values.contains_key("scopes_sect") {
                        for scope in definition.list("scopes_sect") {
                            names.push(self.section(scope)?.text("scope_name")?.into());
                        }
                    } else {
                        names.push(definition.text("scope_name")?.into());
                    }
                }
            }
            result.push((status, names));
        }
        Ok(result)
    }
    pub(crate) fn equipped_addons(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
        attachments: &[String],
    ) -> Result<(u8, Option<String>)> {
        // X-Ray's scope, silencer and launcher flags.
        let mut mask = 0;
        let mut scope = None;
        for ((status, names), flag) in self.addons(name, state)?.into_iter().zip([1, 4, 2]) {
            let attached = attachments.iter().find(|section| names.contains(section));
            if status == 1 || (status == 2 && attached.is_some()) {
                mask |= flag;
                if flag == 1 && status == 2 {
                    scope = attached.cloned();
                }
            }
        }
        Ok((mask, scope))
    }
    pub(crate) fn launcher_available(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
    ) -> Result<bool> {
        let crate::inventory::ItemPayload::Weapon { attachments, .. } = &state.payload else {
            return Ok(false);
        };
        let addons = self.addons(name, state)?;
        let (status, names) = &addons[2];
        Ok(*status == 1 || (*status == 2 && attachments.iter().any(|addon| names.contains(addon))))
    }
    pub(crate) fn fire_modes(
        &self,
        name: &str,
        state: &crate::inventory::ItemState,
    ) -> Result<Vec<i8>> {
        let modes = self.effective_list(name, state, "fire_modes")?
            .iter().map(|mode| mode.trim().parse::<i8>()).collect::<Result<Vec<_>, _>>()?;
        ensure!(modes.len() <= usize::from(u8::MAX)
            && modes.iter().all(|mode| *mode == -1 || *mode > 0), "invalid fire modes");
        Ok(modes)
    }
    pub fn validate_state(&self, name: &str, state: &crate::inventory::ItemState) -> Result<()> {
        use crate::inventory::ItemPayload;
        state.validate()?;
        let (s, kind) = self.item(name)?;
        self.upgrade_effects(name, &state.upgrades)?;
        match (&state.payload, kind) {
            (ItemPayload::Ammunition { rounds }, Kind::Ammunition) => ensure!(
                *rounds <= u32::try_from(s.integer("box_size")?)?,
                "ammo box overflow"
            ),
            (ItemPayload::Consumable { uses }, Kind::Consumable) => ensure!(
                *uses <= u32::try_from(s.integer("eat_portions_num")?)?,
                "consumable uses overflow"
            ),
            (
                ItemPayload::Weapon {
                    cartridges,
                    launcher_cartridges,
                    selected_ammunition,
                    attachments,
                    attachment_items,
                    fire_mode,
                    ..
                },
                Kind::Weapon,
            ) => {
                ensure!(usize::from(*fire_mode) <= self.fire_modes(name, state)?.len(), "invalid fire mode selector");
                let ammo = self.effective_list(name, state, "ammo_class")?;
                let grenades = self.effective_list(name, state, "grenade_class")?;
                ensure!(
                    ammo.contains(selected_ammunition)
                        && cartridges.iter().all(|v| ammo.contains(v))
                        && launcher_cartridges.iter().all(|v| grenades.contains(v)),
                    "incompatible ammunition"
                );
                ensure!(
                    cartridges.len() as f64
                        <= self.effective_number(name, state, "ammo_mag_size", 0.0)?
                        && launcher_cartridges.len() <= 1,
                    "magazine overflow"
                );
                let addons = self.addons(name, state)?;
                let mut unique = std::collections::BTreeSet::new();
                ensure!(
                    attachments.iter().all(|v| unique.insert(v)
                        && self.attachment_slot(v).is_ok_and(|slot| {
                            let (status, names) = &addons[slot as usize];
                            *status == 2 && names.contains(v)
                        })),
                    "incompatible attachment"
                );
                for (_, names) in &addons {
                    ensure!(
                        attachments.iter().filter(|v| names.contains(v)).count() <= 1,
                        "multiple addons of same type"
                    );
                }
                for addon in attachment_items {
                    self.validate_state(&addon.section, &addon.state())?;
                }
                for ammo in cartridges.iter().chain(launcher_cartridges) {
                    ensure!(
                        self.item(ammo)?.1 == Kind::Ammunition,
                        "invalid cartridge section"
                    );
                }
            }
            (
                ItemPayload::Equipment,
                Kind::Equipment | Kind::Outfit | Kind::Helmet | Kind::Artefact,
            ) => {}
            _ => bail!("item state/class mismatch"),
        }
        Ok(())
    }
    pub(crate) fn attachment_slot(&self, section: &str) -> Result<crate::inventory::AttachmentSlot> {
        let (definition, _) = self.item(section)?;
        crate::inventory::AttachmentSlot::for_class(definition.text("class")?)
            .context("item is not an attachment")
    }
    pub fn weight(&self, name: &str, state: &crate::inventory::ItemState) -> Result<f64> {
        use crate::inventory::ItemPayload;
        self.validate_state(name, state)?;
        let mut weight = self.effective_number(name, state, "inv_weight", 0.0)?;
        match &state.payload {
            ItemPayload::Ammunition { rounds } => {
                weight *= f64::from(*rounds) / self.section(name)?.number("box_size")?
            }
            ItemPayload::Weapon {
                cartridges,
                launcher_cartridges,
                attachments,
                ..
            } => {
                for ammo in cartridges.iter().chain(launcher_cartridges) {
                    weight += self.round_weight(ammo)?;
                }
                for addon in attachments {
                    weight += self.item(addon)?.0.number("inv_weight")?;
                }
                for (status, names) in self.addons(name, state)? {
                    if status == 1
                        && let Some(addon) = names.first()
                    {
                        weight += self.item(addon)?.0.number("inv_weight")?;
                    }
                }
            }
            ItemPayload::Consumable { uses } => {
                let definition = self.section(name)?;
                if definition.boolean("use_condition", false)? {
                    let full = self.effective_number(name, state, "max_uses", 1.0)?;
                    let empty = self.effective_number(name, state, "empty_weight", 0.0)?;
                    weight = empty + (weight - empty) * f64::from(*uses) / full.max(1.0);
                }
            }
            _ => {}
        }
        ensure!(weight.is_finite() && weight >= 0.0, "invalid item weight");
        Ok(weight)
    }
    pub(crate) fn round_weight(&self, ammo: &str) -> Result<f64> {
        let (definition, kind) = self.item(ammo)?;
        ensure!(kind == Kind::Ammunition, "not ammunition");
        let count = definition.number("box_size")?;
        ensure!(count > 0.0, "invalid box size");
        Ok(definition.number("inv_weight")? / count)
    }
}
