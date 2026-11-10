//! Stock HUD reload durations for server-owned reload phases.
use crate::catalog::{Catalog, Kind};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

/// Stock shotgun substates. An interrupted insertion sets Close without
/// starting a new animation, so its current animation ends in Complete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum TubeReloadPhase { Open, Insert, Close, Complete }

pub fn tube_reload_after_animation(phase: TubeReloadPhase, insertion_failed: bool) -> TubeReloadPhase {
    match crate::xray_combat_rules::tube_reload_after_animation(phase as u32, insertion_failed) {
        0 => TubeReloadPhase::Open, 1 => TubeReloadPhase::Insert,
        2 => TubeReloadPhase::Close, 3 => TubeReloadPhase::Complete,
        _ => unreachable!("invalid native tube reload phase"),
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ReloadMotion {
    Magazine {
        empty: bool,
        jammed: bool,
        launcher_attached: bool,
    },
    Launcher,
    BreakAction {
        two: bool,
    },
    Open,
    Insert,
    Close,
}

#[derive(Deserialize, Serialize)]
pub struct ReloadCue {
    pub alias: String,
    pub milliseconds: u32,
    pub sound: ReloadSound,
}

// Sent as a compact discriminator. Zero is reserved for a terminal cue.
#[derive(Clone, Copy, Deserialize, Serialize)]
#[repr(u8)]
pub enum ReloadSound {
    Magazine = 1,
    Empty = 2,
    Misfire = 3,
    Launcher = 4,
    OneShell = 5,
    Open = 6,
    Insert = 7,
    Close = 8,
}

#[derive(Deserialize, Serialize)]
pub struct ReloadPlan {
    pub open: Option<ReloadCue>,
    pub apply: ReloadCue,
    pub close: Option<ReloadCue>,
}

impl ReloadMotion {
    fn aliases(self) -> &'static [&'static str] {
        match self {
            Self::Magazine {
                jammed: true,
                launcher_attached: true,
                ..
            } => &[
                "anm_reload_misfire_w_gl",
                "anm_reload_w_gl",
                "anim_reload_gl",
            ],
            Self::Magazine {
                empty: true,
                launcher_attached: true,
                jammed: false,
            } => &["anm_reload_empty_w_gl", "anm_reload_w_gl", "anim_reload_gl"],
            Self::Magazine {
                launcher_attached: true,
                ..
            } => &["anm_reload_w_gl", "anim_reload_gl"],
            Self::Magazine { jammed: true, .. } => &[
                "anm_reload_misfire",
                "anim_reload_misfire",
                "anm_reload",
                "anim_reload",
            ],
            Self::Magazine { empty: true, .. } => &[
                "anm_reload_empty",
                "anim_reload_empty",
                "anm_reload",
                "anim_reload",
            ],
            Self::Magazine { .. } => &["anm_reload", "anim_reload"],
            Self::Launcher => &["anm_reload_g", "anim_reload_g"],
            Self::BreakAction { two: true } => &["anm_reload_2", "anim_reload"],
            Self::BreakAction { two: false } => &["anm_reload_1", "anim_reload_1"],
            Self::Open => &["anm_open", "anim_open_weapon"],
            Self::Insert => &["anm_add_cartridge", "anim_add_cartridge"],
            Self::Close => &["anm_close", "anim_close_weapon"],
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AliasTiming {
    duration_ms: u32,
    clips: BTreeMap<String, u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    path: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReloadTimings {
    schema: u32,
    catalog_sha256: String,
    sources: Vec<Source>,
    weapons: BTreeMap<String, String>,
    actor_profiles: BTreeMap<String, usize>,
    profiles: Vec<BTreeMap<String, BTreeMap<String, AliasTiming>>>,
}

impl ReloadTimings {
    pub fn load(path: &Path, catalog: &Catalog) -> Result<Self> {
        ensure!(
            std::fs::metadata(path)?.len() <= 1024 * 1024,
            "reload timings too large"
        );
        let timings: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        timings.validate(catalog)?;
        Ok(timings)
    }

    fn validate(&self, catalog: &Catalog) -> Result<()> {
        ensure!(
            self.schema == 1 && self.catalog_sha256 == catalog.sha256,
            "reload timing catalog mismatch"
        );
        ensure!(
            !self.sources.is_empty()
                && !self.profiles.is_empty()
                && self.actor_profiles.contains_key("actor_hud"),
            "missing reload timing sources or hands profiles"
        );
        let mut sources = BTreeSet::new();
        for source in &self.sources {
            ensure!(
                source.path.starts_with("meshes/")
                    && !source
                        .path
                        .split('/')
                        .any(|part| matches!(part, "" | "." | ".."))
                    && !source.path.contains(['\\', '\0'])
                    && (source.path.ends_with(".ogf") || source.path.ends_with(".omf"))
                    && source.sha256.len() == 64
                    && source
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    && sources.insert(&source.path),
                "invalid reload timing source"
            );
        }
        let mut expected = BTreeMap::new();
        for name in catalog.item_names() {
            let (section, kind) = catalog.item(name)?;
            if kind == Kind::Weapon {
                expected.insert(name, section.text("hud")?);
            }
            if kind == Kind::Outfit
                && let Some(actor) = section.values.get("player_hud_section")
            {
                ensure!(
                    self.actor_profiles.contains_key(actor),
                    "missing reload profile for {actor}"
                );
            }
        }
        ensure!(
            self.weapons
                .iter()
                .map(|(weapon, hud)| (weapon.as_str(), hud.as_str()))
                .eq(expected.iter().map(|(&weapon, &hud)| (weapon, hud))),
            "reload timings must match every catalog weapon and HUD"
        );
        let huds: BTreeSet<_> = expected.values().copied().collect();
        for profile in &self.profiles {
            ensure!(
                profile.keys().map(String::as_str).eq(huds.iter().copied()),
                "reload HUD profile mismatch"
            );
            for (hud, aliases) in profile {
                let section = catalog.section(hud)?;
                let expected_aliases = section.values.keys().filter(|alias| {
                    alias
                        .strip_prefix("anm_")
                        .or_else(|| alias.strip_prefix("anim_"))
                        .is_some_and(|motion| {
                            ["reload", "open", "close", "add_cartridge"]
                                .iter()
                                .any(|prefix| {
                                    motion.strip_prefix(prefix).is_some_and(|suffix| {
                                        suffix.is_empty() || suffix.starts_with('_')
                                    })
                                })
                        })
                });
                ensure!(
                    !aliases.is_empty() && aliases.keys().eq(expected_aliases),
                    "reload alias mismatch for {hud}"
                );
                for (alias, timing) in aliases {
                    let base = section.text(alias)?.split(',').next().unwrap_or_default();
                    ensure!(
                        !base.is_empty()
                            && (1..=30_000).contains(&timing.duration_ms)
                            && timing.clips.values().copied().max() == Some(timing.duration_ms),
                        "invalid duration for {hud}/{alias}"
                    );
                    for (clip, duration) in &timing.clips {
                        ensure!(
                            *duration > 0
                                && (clip == base
                                    || clip.strip_prefix(base).is_some_and(|suffix| {
                                        suffix.len() == 1
                                            && (b'1'..=b'8').contains(&suffix.as_bytes()[0])
                                    })),
                            "invalid clip for {hud}/{alias}"
                        );
                    }
                }
            }
        }
        for (actor, &index) in &self.actor_profiles {
            catalog.section(actor)?.text("visual")?;
            ensure!(
                index < self.profiles.len(),
                "invalid reload profile for {actor}"
            );
            for (weapon, hud) in &self.weapons {
                let (section, _) = catalog.item(weapon)?;
                let animations = &self.profiles[index][hud];
                use ReloadMotion::*;
                if section.boolean("tri_state_reload", false)? {
                    for kind in [Open, Insert, Close] {
                        self.motion(weapon, actor, kind)?;
                    }
                } else if section.text("class")? == "WP_BM16" {
                    for two in [false, true] {
                        self.motion(weapon, actor, BreakAction { two })?;
                    }
                } else {
                    let launcher = section
                        .values
                        .get("grenade_launcher_status")
                        .is_some_and(|value| value != "0")
                        || animations.contains_key("anm_reload_g")
                        || animations.contains_key("anim_reload_g");
                    for empty in [false, true] {
                        for jammed in [false, true] {
                            self.motion(
                                weapon,
                                actor,
                                Magazine {
                                    empty,
                                    jammed,
                                    launcher_attached: false,
                                },
                            )?;
                            if launcher {
                                self.motion(
                                    weapon,
                                    actor,
                                    Magazine {
                                        empty,
                                        jammed,
                                        launcher_attached: true,
                                    },
                                )?;
                            }
                        }
                    }
                    if launcher {
                        self.motion(weapon, actor, Launcher)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn motion(&self, weapon: &str, actor: &str, kind: ReloadMotion) -> Result<(&str, u32)> {
        let hud = self
            .weapons
            .get(weapon)
            .with_context(|| format!("missing reload weapon {weapon}"))?;
        let profile = self
            .actor_profiles
            .get(actor)
            .with_context(|| format!("missing reload profile {actor}"))?;
        let aliases = &self.profiles[*profile][hud];
        kind.aliases()
            .iter()
            .find_map(|alias| {
                aliases
                    .get_key_value(*alias)
                    .map(|(name, timing)| (name.as_str(), timing.duration_ms))
            })
            .with_context(|| format!("missing {kind:?} timing for {actor}/{weapon}"))
    }
}
