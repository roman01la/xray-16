//! Server-owned actor conditions and durable consumable treatments.
use crate::{
    catalog::{Catalog, Section},
    combat::ArmourImpact,
    inventory::Context,
    survival_rules::SurvivalRules,
};
use anyhow::{Context as _, Result, ensure};
use rusqlite::{Transaction, params};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub(crate) const SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN condition TEXT NOT NULL DEFAULT '{}';
ALTER TABLE inventory_characters ADD COLUMN condition_revision INTEGER NOT NULL DEFAULT 0 CHECK(condition_revision BETWEEN 0 AND 4294967295);
PRAGMA user_version=12;";

pub(crate) const LOCATION_SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN location TEXT;
PRAGMA user_version=13;";

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
struct Influence {
    health: f32,
    power: f32,
    satiety: f32,
    radiation: f32,
    heal: f32,
    alcohol: f32,
    thirst: f32,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default)]
struct Booster {
    rate: f32,
    remaining: f32,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
struct Medicine {
    total: Influence,
    duration: f32,
    remaining: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default)]
pub struct State {
    #[serde(skip_serializing_if = "Option::is_none")]
    native_checkpoint: Option<crate::native_condition::Checkpoint>,
    pub health: f32,
    pub power: f32,
    pub satiety: f32,
    pub thirst: f32,
    pub bleeding: f32,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    wounds: BTreeMap<String, [f32; 12]>,
    pub radiation: f32,
    pub psy_health: f32,
    pub alcohol: f32,
    sprint_blocked: bool,
    walk_blocked: bool,
    limping: bool,
    medicine: Option<Medicine>,
    boosts: [Booster; 4],
    weight_boost: Booster,
    radiation_protection: Booster,
    acid_protection: Booster,
    psy_protection: Booster,
}
impl Default for State {
    fn default() -> Self {
        Self {
            native_checkpoint: None,
            health: 1.0,
            power: 1.0,
            satiety: 1.0,
            thirst: 1.0,
            bleeding: 0.0,
            wounds: BTreeMap::new(),
            radiation: 0.0,
            psy_health: 1.0,
            alcohol: 0.0,
            sprint_blocked: false,
            walk_blocked: false,
            limping: false,
            medicine: None,
            boosts: [Booster::default(); 4],
            weight_boost: Booster::default(),
            radiation_protection: Booster::default(),
            acid_protection: Booster::default(),
            psy_protection: Booster::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct AimProfile {
    pub weapon: [u8; 16],
    pub raise_ticks: u16,
    pub launcher: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Loadout {
    pub mass: f64,
    pub capacity_bonus: f64,
    pub power_loss: f64,
    pub outfit_allows_sprint: bool,
    #[serde(default)]
    pub active_weapon_slot: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_item: Option<[u8; 16]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ballistics: Option<crate::ballistics::RoundProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aim: Option<AimProfile>,
    #[serde(default)]
    pub active_item_blocks_sprint: bool,
    #[serde(default)]
    pub restoration: Restoration,
    #[serde(default)]
    pub fields: crate::environment::Protection,
}

impl Loadout {
    pub fn with_newer_armour(mut self, current: Self) -> Self {
        self.fields.armour.take_newer(current.fields.armour);
        self
    }
}

/// Per-second effects of the worn outfit and the artefacts on its belt.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Restoration {
    health: f32,
    power: f32,
    satiety: f32,
    bleeding: f32,
    radiation: f32,
}

impl Restoration {
    pub(crate) fn add(
        &mut self,
        catalog: &Catalog,
        section: &str,
        state: &crate::inventory::ItemState,
        scale: f32,
    ) -> Result<()> {
        for (total, key) in [
            (&mut self.health, "health_restore_speed"),
            (&mut self.power, "power_restore_speed"),
            (&mut self.satiety, "satiety_restore_speed"),
            (&mut self.bleeding, "bleeding_restore_speed"),
            (&mut self.radiation, "radiation_restore_speed"),
        ] {
            let rate = catalog.effective_number(section, state, key, 0.0)? as f32;
            *total += rate * scale;
            ensure!(total.is_finite(), "invalid equipment restoration rate {key}");
        }
        Ok(())
    }
}

impl Default for Loadout {
    fn default() -> Self {
        Self {
            mass: 0.0,
            capacity_bonus: 0.0,
            power_loss: 0.5,
            outfit_allows_sprint: true,
            active_weapon_slot: 0,
            active_item: None,
            ballistics: None,
            aim: None,
            active_item_blocks_sprint: false,
            restoration: Restoration::default(),
            fields: crate::environment::Protection::default(),
        }
    }
}

#[derive(Clone, Copy)]
pub enum Activity {
    Standing,
    Walking,
    Running,
    Sprinting,
}

#[derive(Clone, Copy)]
pub struct Motion {
    pub walk: bool,
    pub sprint: bool,
    pub limp_scale: f32,
    pub over_limit: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Record {
    pub revision: u32,
    pub state: State,
}

/// The last server-owned pose for this life, tied to its collision data.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Location {
    pub world: String,
    pub content_revision: String,
    pub position: [f32; 3],
    pub yaw: f32,
    pub crouched: bool,
    pub combat_until_ms: i64,
    #[serde(default)]
    pub logout_until_ms: i64,
}

#[derive(Clone)]
pub struct Impact {
    pub kind: ImpactKind,
    pub power: f32,
    pub before: Record,
    pub location: Location,
    pub combat_lock_ms: u32,
    pub native_armour: Option<NativeArmourImpact>,
}

#[derive(Clone, Copy)]
pub struct NativeArmourImpact {
    pub health: f32,
    pub power_loss: f32,
    pub generation: u64,
    pub power: f32,
    pub outfit: Option<f32>,
    pub helmet: Option<f32>,
    pub wound: bool,
}

#[derive(Clone)]
pub enum ImpactKind {
    Blast { bone: String },
    Wound { bone: String },
    Strike,
    Bullet { bone: String, penetration: f32 },
}

// CoP EHitType slots in CWound. The empty bone key represents an unknown site.
#[derive(Clone, Copy)]
pub(crate) enum WoundKind {
    Cut = 5,
    Bullet = 6,
    Blast = 8,
}

impl ImpactKind {
    pub(crate) fn wound_site(&self) -> (WoundKind, &str) {
        match self {
            Self::Blast { bone } => (WoundKind::Blast, bone),
            Self::Wound { bone } => (WoundKind::Cut, bone),
            Self::Strike => (WoundKind::Cut, ""),
            Self::Bullet { bone, .. } => (WoundKind::Bullet, bone),
        }
    }
}

#[derive(Clone)]
pub struct ShotVictim {
    pub target: crate::combat::ShotTarget,
    pub context: Context,
    pub before: Record,
    pub location: Location,
    pub shooter_location: Location,
    pub combat_lock_ms: u32,
}

#[derive(Clone)]
pub struct FireVictim {
    pub authority: ShotVictim,
    /// Server-produced native proposal; never deserialized from client input.
    pub native: Option<crate::native_condition::Shot>,
    pub additional: Vec<crate::combat::ShotTarget>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct ImpactCommit {
    pub revision: u32,
    pub alive: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ImpactOutcome {
    Stale,
    Applied { revision: u32, alive: bool, impact: ArmourImpact, power_loss: f32 },
}

pub struct SavedLogout {
    pub principal: String,
    pub life: u32,
    pub visit: u32,
    pub condition: Record,
    pub location: Location,
    pub loadout: Loadout,
    pub appearance: crate::lifecycle::Appearance,
}

fn get(section: &Section, key: &str) -> Result<f32> {
    if !section.values.contains_key(key) {
        return Ok(0.0);
    }
    let n = section.number(key)? as f32;
    ensure!(n.is_finite(), "invalid survival value {key}");
    Ok(n)
}

#[derive(Clone)]
pub struct Tuning {
    satiety_decay: f32,
    satiety_critical: f32,
    satiety_health: f32,
    satiety_power: f32,
    bleeding_damage: f32,
    wound_recovery: f32,
    minimum_wound: f32,
    health_restore: f32,
    radiation_damage: f32,
    radiation_decay: f32,
    psy_recovery: f32,
    alcohol_decay: f32,
    sprint_min: f32,
    sprint_recover: f32,
    walk_min: f32,
    walk_recover: f32,
    limp_health_min: f32,
    limp_health_recover: f32,
    limp_power_min: f32,
    limp_power_recover: f32,
    limp_scale: f32,
    carry_limit: f32,
    walk_limit: f32,
    stand_power: f32,
    walk_power: f32,
    walk_weight_power: f32,
    overweight_walk: f32,
    run_factor: f32,
    sprint_factor: f32,
    jump_power: f32,
    jump_weight_power: f32,
    overweight_jump: f32,
    thirst_decay: f32,
    dehydration_damage: f32,
}

impl Tuning {
    pub fn from_catalog(catalog: &Catalog, rules: &SurvivalRules) -> Result<Self> {
        let actor = catalog.section("actor")?;
        let c = catalog.section(actor.text("condition_sect")?)?;
        let result = Self {
            satiety_decay: get(c, "satiety_v")?,
            satiety_critical: get(c, "satiety_critical")?,
            satiety_health: get(c, "satiety_health_v")?,
            satiety_power: get(c, "satiety_power_v")?,
            bleeding_damage: get(c, "bleeding_v")?,
            wound_recovery: get(c, "wound_incarnation_v")?,
            minimum_wound: get(c, "min_wound_size")?,
            health_restore: get(c, "health_restore_v")?,
            radiation_damage: get(c, "radiation_health_v")?,
            radiation_decay: get(c, "radiation_v")?,
            psy_recovery: get(c, "psy_health_v")?,
            alcohol_decay: get(c, "alcohol_v")?,
            sprint_min: get(c, "cant_sprint_power_begin")?,
            sprint_recover: get(c, "cant_sprint_power_end")?,
            walk_min: get(c, "cant_walk_power_begin")?,
            walk_recover: get(c, "cant_walk_power_end")?,
            limp_health_min: get(c, "limping_health_begin")?,
            limp_health_recover: get(c, "limping_health_end")?,
            limp_power_min: get(c, "limping_power_begin")?,
            limp_power_recover: get(c, "limping_power_end")?,
            limp_scale: 1.0 / get(actor, "run_coef")?.max(1.0),
            carry_limit: get(catalog.section("inventory")?, "max_weight")?,
            walk_limit: get(c, "max_walk_weight")?,
            // The stock LTX contains this literal. CInifile uses atof, which
            // stops at the second decimal point.
            stand_power: if c.values.get("stand_power").is_some_and(|v| v == "-0.001.1") {
                -0.001
            } else {
                get(c, "stand_power")?
            },
            walk_power: get(c, "walk_power")?,
            walk_weight_power: get(c, "walk_weight_power")?,
            overweight_walk: get(c, "overweight_walk_k")?,
            run_factor: get(c, "accel_k")?,
            sprint_factor: get(c, "sprint_k")?,
            jump_power: get(c, "jump_power")?,
            jump_weight_power: get(c, "jump_weight_power")?,
            overweight_jump: get(c, "overweight_jump_k")?,
            thirst_decay: rules.thirst_drain_per_second,
            dehydration_damage: rules.dehydration_damage_per_second,
        };
        ensure!(
            result.satiety_critical > 0.0 && result.satiety_critical < 1.0,
            "invalid satiety threshold"
        );
        ensure!(
            (0.0..=1.0).contains(&result.sprint_min)
                && (result.sprint_min..=1.0).contains(&result.sprint_recover),
            "invalid sprint thresholds"
        );
        ensure!(
            result.carry_limit > 0.0 && result.walk_limit >= result.carry_limit,
            "invalid original weight limits"
        );
        Ok(result)
    }
}

const BOOSTS: [&str; 4] = [
    "boost_health_restore",
    "boost_power_restore",
    "boost_bleeding_restore",
    "boost_radiation_restore",
];

pub(crate) struct Dose {
    influence: Influence,
    duration: f32,
    boosts: [Booster; 4],
    weight_boost: Booster,
    radiation_protection: Booster,
    acid_protection: Booster,
    psy_protection: Booster,
}
impl Dose {
    pub(crate) fn immediate_wound_heal(&self) -> f32 {
        if self.duration > 0.0 { 0.0 } else { self.influence.heal }
    }

    pub(crate) fn from_catalog(
        section: &str,
        definition: &Section,
        rules: &SurvivalRules,
    ) -> Result<Option<Self>> {
        // Leave script-only and unsupported protection drugs in inventory.
        for key in definition.values.keys() {
            if (key.starts_with("boost_")
                && key != "boost_time"
                && key != "boost_max_weight"
                && key != "boost_radiation_protection"
                && key != "boost_chemburn_protection"
                && key != "boost_telepat_protection"
                && !BOOSTS.contains(&key.as_str())
                || key == "eat_max_power")
                && get(definition, key)? != 0.0
            {
                return Ok(None);
            }
        }
        let influence = Influence {
            health: get(definition, "eat_health")?,
            power: get(definition, "eat_power")?,
            satiety: get(definition, "eat_satiety")?,
            radiation: get(definition, "eat_radiation")?,
            heal: get(definition, "wounds_heal_perc")?.clamp(0.0, 1.0),
            alcohol: get(definition, "eat_alcohol")?,
            thirst: rules.hydration_sources.get(section).copied().unwrap_or(0.0),
        };
        let duration = get(definition, "apply_time_sec")?.max(0.0);
        let boost_time = get(definition, "boost_time")?;
        let booster = |key| -> Result<Booster> {
            let rate = get(definition, key)?;
            Ok(if rate > 0.0 && boost_time > 0.0 {
                Booster { rate, remaining: boost_time }
            } else {
                Booster::default()
            })
        };
        let weight_boost = booster("boost_max_weight")?;
        let radiation_protection = booster("boost_radiation_protection")?;
        let acid_protection = booster("boost_chemburn_protection")?;
        let psy_protection = booster("boost_telepat_protection")?;
        let mut boosts = [Booster::default(); 4];
        for (boost, key) in boosts.iter_mut().zip(BOOSTS) {
            *boost = booster(key)?;
        }
        let effect = [
            influence.health,
            influence.power,
            influence.satiety,
            influence.radiation,
            influence.heal,
            influence.alcohol,
            influence.thirst,
        ]
        .into_iter()
        .any(|n| n != 0.0)
            || boosts.iter().any(|boost| boost.remaining > 0.0)
            || weight_boost.remaining > 0.0
            || radiation_protection.remaining > 0.0
            || acid_protection.remaining > 0.0
            || psy_protection.remaining > 0.0;
        Ok(effect.then_some(Self {
            influence,
            duration,
            boosts,
            weight_boost,
            radiation_protection,
            acid_protection,
            psy_protection,
        }))
    }
}

impl State {
    pub fn native_import(&self) -> Option<crate::native_condition::Import> {
        if self.native_checkpoint.is_some() { return None; }
        let mut bytes = b"ZCL1".to_vec();
        for value in [self.health, self.power, self.satiety, self.radiation, self.psy_health, self.alcohol] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        let medicine = self.medicine.filter(|m| m.remaining > 0.0).map_or([0.0;9], |m| [
            m.total.health, m.total.power, m.total.satiety, m.total.radiation,
            m.total.heal, 0.0, m.total.alcohol, m.duration, m.remaining]);
        for value in medicine { bytes.extend_from_slice(&value.to_le_bytes()); }
        let flags = u32::from(self.limping) | (u32::from(self.walk_blocked)<<1) | (u32::from(self.sprint_blocked)<<2);
        bytes.extend_from_slice(&flags.to_le_bytes());
        let mut wounds = self.wounds.clone();
        if wounds.is_empty() && self.bleeding > 0.0 {
            wounds.entry(String::new()).or_insert([0.0;12])[WoundKind::Bullet as usize] = self.bleeding;
        }
        let boosts = [(0u32,self.boosts[0]), (1,self.boosts[1]), (3,self.boosts[2]), (2,self.boosts[3]),
            (4,self.weight_boost), (5,self.radiation_protection), (6,self.psy_protection), (7,self.acid_protection)]
            .into_iter().filter(|(_,b)| b.remaining > 0.0).collect::<Vec<_>>();
        if wounds.len()>256 { return None; }
        bytes.extend_from_slice(&(wounds.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&(boosts.len() as u32).to_le_bytes());
        for (bone,sizes) in wounds {
            if bone.len()>63 { return None; }
            bytes.push(bone.len() as u8); bytes.extend_from_slice(bone.as_bytes());
            for value in sizes { bytes.extend_from_slice(&value.to_le_bytes()); }
        }
        for (kind,b) in boosts {
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&b.rate.to_le_bytes());
            bytes.extend_from_slice(&b.remaining.to_le_bytes());
        }
        crate::native_condition::Import::parse(bytes)
    }

    /// Prepare custom policy on a clone. Commit the returned state only after
    /// the matching X-Ray result; the live actor remains unchanged on retries.
    pub fn prepare_native_step(&self, tuning: &Tuning, seconds: f32, protected: bool)
        -> Option<(Self, crate::native_condition::Checkpoint)> {
        if !seconds.is_finite() || !(0.0..=1.0).contains(&seconds) || self.health<=0.0 { return None; }
        let checkpoint=self.native_checkpoint.as_ref()?;
        let mut state=self.clone();
        // An imported legacy treatment may also contain custom hydration.
        // Only its thirst component stays here; X-Ray owns all stock effects.
        if let Some(mut medicine)=state.medicine {
            let elapsed=seconds.min(medicine.remaining);
            if medicine.duration>0.0 { state.thirst+=medicine.total.thirst*elapsed/medicine.duration; }
            medicine.remaining-=elapsed;
            state.medicine=(medicine.remaining>0.0).then_some(medicine);
        }
        state.thirst=(state.thirst-tuning.thirst_decay*seconds).clamp(0.0,1.0);
        let loss=if !protected && state.thirst<=0.0 { tuning.dehydration_damage*seconds } else {0.0};
        let input=checkpoint.with_policy(protected,loss)?;
        Some((state,input))
    }

    pub fn native_checkpoint(&self) -> Option<&crate::native_condition::Checkpoint> {
        self.native_checkpoint.as_ref()
    }
    pub(crate) fn install_native_checkpoint(&mut self, checkpoint: crate::native_condition::Checkpoint) -> Result<()> {
        let state = checkpoint.projection().context("invalid native condition projection")?;
        self.health = state.health;
        self.power = state.power;
        self.radiation = state.radiation;
        self.psy_health = state.psy_health;
        self.satiety = state.satiety;
        self.alcohol = state.alcohol;
        self.bleeding = state.bleeding;
        self.limping = state.limping;
        self.walk_blocked = state.walk_blocked;
        self.sprint_blocked = state.sprint_blocked;
        self.native_checkpoint = Some(checkpoint);
        Ok(())
    }

    pub fn health_points(&self) -> u16 {
        (self.health.clamp(0.0, 1.0) * 100.0).ceil() as u16
    }
    pub fn wire_view(&self, life: u32, tuning: &Tuning, loadout: Loadout) -> [u32; 14] {
        let quantize = |value: f32| (value.clamp(0.0, 1.0) * 1000.0).round() as u32;
        let grams = |kg: f64| (kg * 1000.0).round() as u32;
        let motion = self.motion(tuning, loadout);
        let (carry, walk) = self.limits(tuning, loadout);
        // Stock HUD order (EBoostParams). Low byte is active, high byte is expiring.
        let boosters = [
            self.boosts[0], self.boosts[1], self.boosts[3], self.boosts[2],
            self.weight_boost, self.radiation_protection, self.psy_protection, self.acid_protection,
        ];
        let booster_icons = boosters.iter().enumerate().fold(0, |icons, (index, booster)| {
            let active = booster.remaining > 0.0;
            let expiring = active && booster.remaining <= 3.0;
            icons | (u32::from(active) << index) | (u32::from(expiring) << (index + 8))
        });
        let booster_icons = self.native_checkpoint.as_ref().and_then(|state| state.projection())
            .map_or(booster_icons, |state| state.booster_icons);
        [
            life,
            quantize(self.power),
            quantize(self.satiety),
            quantize(self.thirst),
            quantize(self.bleeding),
            quantize(self.radiation),
            u32::from(motion.sprint)
                | (u32::from(motion.walk) << 1)
                | (u32::from(motion.over_limit) << 2),
            grams(loadout.mass),
            grams(carry),
            grams(walk),
            quantize(motion.limp_scale),
            u32::from(loadout.active_weapon_slot),
            quantize(self.psy_health),
            booster_icons,
        ]
    }
    fn limits(&self, tuning: &Tuning, loadout: Loadout) -> (f64, f64) {
        if let Some(state) = self.native_checkpoint.as_ref().and_then(|state| state.projection()) {
            // Checkpoint limits include native boosters; equipment's separate
            // additional-weight contribution is already present in the loadout.
            return ((f64::from(state.carry_limit)+loadout.capacity_bonus).max(0.001),
                (f64::from(state.walk_limit)+loadout.capacity_bonus).max(0.001));
        }
        let extra = loadout.capacity_bonus
            + if self.weight_boost.remaining > 0.0 {
                f64::from(self.weight_boost.rate)
            } else {
                0.0
            };
        (
            (f64::from(tuning.carry_limit) + extra).max(0.001),
            (f64::from(tuning.walk_limit) + extra).max(0.001),
        )
    }
    pub fn motion(&self, tuning: &Tuning, loadout: Loadout) -> Motion {
        let (_, walk_limit) = self.limits(tuning, loadout);
        let over_limit = loadout.mass > walk_limit;
        let walk = !over_limit && !self.walk_blocked;
        Motion {
            walk,
            sprint: walk && !self.sprint_blocked && !self.limping && loadout.outfit_allows_sprint
                && !loadout.active_item_blocks_sprint,
            limp_scale: if self.limping { tuning.limp_scale } else { 1.0 },
            over_limit,
        }
    }
    pub fn damage(&mut self, points: u16, fire_wound: bool) {
        self.apply_hit(f32::from(points) / 100.0, fire_wound);
    }
    pub(crate) fn apply_hit(&mut self, power: f32, fire_wound: bool) {
        self.apply_hit_at(power, fire_wound.then_some((WoundKind::Bullet, "")));
    }

    pub(crate) fn apply_hit_at(&mut self, power: f32, wound: Option<(WoundKind, &str)>) {
        self.health = (self.health - power).max(0.0);
        if self.health > 0.0 && let Some((kind, bone)) = wound {
            self.add_wound(kind, bone, power);
        }
    }

    pub(crate) fn add_wound(&mut self, kind: WoundKind, bone: &str, power: f32) {
        if power <= 0.0 { return; }
        self.restore_legacy_wound();
        let sizes = self.wounds.entry(bone.to_owned()).or_default();
        let size = &mut sizes[kind as usize];
        *size = crate::xray_combat_rules::add_wound_hit(*size, power);
        self.update_bleeding();
    }

    fn restore_legacy_wound(&mut self) {
        if self.wounds.is_empty() && self.bleeding > 0.0 {
            self.wounds.entry(String::new()).or_default()[WoundKind::Bullet as usize] = self.bleeding;
        }
    }

    fn update_bleeding(&mut self) {
        self.bleeding = if self.wounds.is_empty() { 0.0 } else {
            self.wounds.values().flatten().sum::<f32>() / self.wounds.len() as f32
        };
    }

    fn heal_wounds(&mut self, amount: f32, minimum: f32) {
        self.restore_legacy_wound();
        self.wounds.retain(|_, sizes| crate::xray_combat_rules::heal_wound(sizes, amount, minimum));
        self.update_bleeding();
    }
    pub(crate) fn field_boost(&self, kind: crate::environment::Kind) -> f32 {
        use crate::environment::Kind;
        let booster = match kind {
            Kind::Radiation => self.radiation_protection,
            Kind::Acid => self.acid_protection,
            Kind::Psy => self.psy_protection,
            Kind::Heat | Kind::Shock => return 0.0,
        };
        if booster.remaining > 0.0 { booster.rate } else { 0.0 }
    }
    pub(crate) fn dose(&mut self, dose: Dose) -> bool {
        if self.medicine.is_some() {
            return false;
        }
        if dose.duration > 0.0 {
            self.medicine = Some(Medicine {
                total: dose.influence,
                duration: dose.duration,
                remaining: dose.duration,
            });
        } else {
            self.influence(dose.influence, 1.0);
        }
        for (active, added) in self.boosts.iter_mut().zip(dose.boosts) {
            if added.remaining > 0.0 {
                *active = added;
            }
        }
        if dose.weight_boost.remaining > 0.0 {
            self.weight_boost = dose.weight_boost;
        }
        for (active, added) in [
            (&mut self.radiation_protection, dose.radiation_protection),
            (&mut self.acid_protection, dose.acid_protection),
            (&mut self.psy_protection, dose.psy_protection),
        ] {
            if added.remaining > 0.0 { *active = added; }
        }
        true
    }
    fn influence(&mut self, effect: Influence, fraction: f32) {
        self.health += effect.health * fraction;
        self.power += effect.power * fraction;
        self.satiety += effect.satiety * fraction;
        self.radiation += effect.radiation * fraction;
        self.alcohol += effect.alcohol * fraction;
        self.thirst += effect.thirst * fraction;
        if effect.heal != 0.0 {
            self.heal_wounds(effect.heal * fraction, 0.0);
        }
        self.bound();
    }
    fn bound(&mut self) {
        for value in [
            &mut self.health,
            &mut self.power,
            &mut self.satiety,
            &mut self.radiation,
            &mut self.psy_health,
            &mut self.alcohol,
            &mut self.thirst,
        ] {
            *value = value.clamp(0.0, 1.0);
        }
    }
    pub fn step(
        &mut self,
        tuning: &Tuning,
        loadout: Loadout,
        dt: f32,
        activity: Activity,
        jumped: bool,
        protected: bool,
    ) {
        use crate::xray_combat_rules as stock;
        if self.health <= 0.0 {
            return;
        }
        if let Some(mut medicine) = self.medicine {
            let elapsed = dt.min(medicine.remaining);
            self.influence(medicine.total, elapsed / medicine.duration);
            medicine.remaining -= elapsed;
            self.medicine = (medicine.remaining > 0.0).then_some(medicine);
        }
        let boosts = self.boosts.each_mut().map(|boost| {
            let elapsed = dt.min(boost.remaining);
            boost.remaining -= elapsed;
            boost.rate * elapsed
        });
        let restoration = loadout.restoration;
        self.satiety += (restoration.satiety - tuning.satiety_decay) * dt;
        self.thirst -= tuning.thirst_decay * dt;
        let satiety_effect = stock::satiety_health_factor(self.satiety.clamp(0.0, 1.0), tuning.satiety_critical);
        let equipment_health = if protected { restoration.health.max(0.0) } else { restoration.health };
        self.health += (tuning.health_restore + equipment_health) * dt + boosts[0];
        let satiety_health = tuning.satiety_health * satiety_effect * dt;
        self.health += if protected {
            satiety_health.max(0.0)
        } else {
            satiety_health
                - (self.bleeding * tuning.bleeding_damage
                    + self.radiation * tuning.radiation_damage
                    + if self.thirst <= 0.0 {
                        tuning.dehydration_damage
                    } else {
                        0.0
                    })
                    * dt
        };
        let (carry, _) = self.limits(tuning, loadout);
        let ratio = (loadout.mass / carry) as f32;
        let power_loss = loadout.power_loss as f32;
        let power_rate = match activity {
            Activity::Standing => tuning.stand_power,
            _ => {
                let factor = match activity {
                    Activity::Running => tuning.run_factor,
                    Activity::Sprinting => tuning.sprint_factor,
                    _ => 1.0,
                };
                stock::movement_power_cost(tuning.walk_power, tuning.walk_weight_power, ratio,
                    tuning.overweight_walk) * factor * power_loss
            }
        };
        if jumped {
            self.power -= stock::movement_power_cost(tuning.jump_power, tuning.jump_weight_power, ratio,
                tuning.overweight_jump) * power_loss;
        }
        self.power += (tuning.satiety_power * self.satiety.clamp(0.0, 1.0) - power_rate
            + restoration.power) * dt + boosts[1];
        self.weight_boost.remaining = (self.weight_boost.remaining - dt).max(0.0);
        for booster in [&mut self.radiation_protection, &mut self.acid_protection, &mut self.psy_protection] {
            booster.remaining = (booster.remaining - dt).max(0.0);
        }
        self.psy_health += tuning.psy_recovery * dt;
        if self.bleeding > 0.0 {
            self.heal_wounds((tuning.wound_recovery + restoration.bleeding) * dt + boosts[2],
                tuning.minimum_wound);
        }
        self.radiation += (restoration.radiation - tuning.radiation_decay) * dt - boosts[3];
        self.alcohol += tuning.alcohol_decay * dt;
        self.bound();
        [self.sprint_blocked, self.walk_blocked, self.limping] = stock::movement_restrictions(
            self.power, self.health, [
                tuning.sprint_min, tuning.sprint_recover, tuning.walk_min, tuning.walk_recover,
                tuning.limp_power_min, tuning.limp_power_recover, tuning.limp_health_min, tuning.limp_health_recover,
            ], [self.sprint_blocked, self.walk_blocked, self.limping]);
    }
    /// The simulation keeps progressing while a dose is queued. Preserve new
    /// damage/changes, and retain the committed timer/booster replacement.
    pub fn merge_dose(mut self, before: &Self, live: &Self, wound_heal: f32) -> Self {
        self.health += live.health - before.health;
        self.power += live.power - before.power;
        self.satiety += live.satiety - before.satiety;
        self.thirst += live.thirst - before.thirst;
        self.bleeding = live.bleeding;
        self.wounds.clone_from(&live.wounds);
        if wound_heal != 0.0 {
            self.heal_wounds(wound_heal, 0.0);
        }
        self.radiation += live.radiation - before.radiation;
        self.psy_health += live.psy_health - before.psy_health;
        self.alcohol += live.alcohol - before.alcohol;
        self.sprint_blocked = live.sprint_blocked;
        self.walk_blocked = live.walk_blocked;
        self.limping = live.limping;
        if self.weight_boost == before.weight_boost {
            self.weight_boost = live.weight_boost;
        }
        for (active, old, current) in [
            (&mut self.radiation_protection, before.radiation_protection, live.radiation_protection),
            (&mut self.acid_protection, before.acid_protection, live.acid_protection),
            (&mut self.psy_protection, before.psy_protection, live.psy_protection),
        ] {
            if *active == old { *active = current; }
        }
        for index in 0..self.boosts.len() {
            if self.boosts[index] == before.boosts[index] {
                self.boosts[index] = live.boosts[index];
            }
        }
        self.bound();
        self
    }
}

pub(crate) fn load(
    tx: &Transaction<'_>,
    principal: &str,
) -> Result<(u32, bool, Record, Option<Location>)> {
    let (life, alive, revision, raw, location): (u32, bool, u32, String, Option<String>) = tx.query_row(
        "SELECT life,alive,condition_revision,condition,location FROM inventory_characters WHERE principal=?1",
        [principal], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    Ok((
        life,
        alive,
        Record {
            revision,
            state: serde_json::from_str(&raw)?,
        },
        location.as_deref().map(serde_json::from_str).transpose()?,
    ))
}

pub(crate) fn load_logouts(
    tx: &Transaction<'_>,
    contract: &crate::contract::Contract,
    catalog: &Catalog,
) -> Result<Vec<SavedLogout>> {
    let mut query = tx.prepare(
        "SELECT c.principal,c.life,c.condition_revision,c.condition,c.location,c.campaign_visit
         FROM inventory_characters c JOIN principals p ON p.id=c.principal
         WHERE c.alive=1 AND p.revoked=0 AND json_extract(c.location,'$.logout_until_ms')>?1
           AND json_extract(c.location,'$.world')=?2 AND json_extract(c.location,'$.content_revision')=?3
         LIMIT 4097"
    )?;
    let mut rows = query.query(params![
        crate::survival_rules::unix_millis()?,
        contract.world,
        contract.content_revision
    ])?;
    let mut saved = Vec::new();
    while let Some(row) = rows.next()? {
        let principal: String = row.get(0)?;
        let (loadout, appearance) = crate::inventory::carried_equipment(tx, &principal, catalog)?;
        saved.push(SavedLogout {
            loadout,
            appearance,
            principal,
            life: row.get(1)?,
            visit: row.get(5)?,
            condition: Record {
                revision: row.get(2)?,
                state: serde_json::from_str(&row.get::<_, String>(3)?)?,
            },
            location: serde_json::from_str(&row.get::<_, String>(4)?)?,
        });
    }
    ensure!(saved.len() <= 4096, "logout body capacity exceeded");
    Ok(saved)
}

pub(crate) fn checkpoint(
    tx: &Transaction<'_>,
    principal: &str,
    life: u32,
    record: &Record,
    location: &Location,
) -> Result<bool> {
    Ok(tx.execute(
        "UPDATE inventory_characters SET condition=?1,location=?5 WHERE principal=?2
        AND life=?3 AND alive=1 AND condition_revision=?4",
        params![
            serde_json::to_string(&record.state)?,
            principal,
            life,
            record.revision,
            serde_json::to_string(location)?,
        ],
    )? == 1)
}

pub(crate) fn resolve_impact(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    rules: Option<&SurvivalRules>,
    context: &Context,
    impact: Impact,
) -> Result<ImpactOutcome> {
    let Impact { power, mut before, location, combat_lock_ms, kind, native_armour } = impact;
    ensure!(before.state.native_checkpoint().is_none(), "native condition hit proposal required");
    if !impact_current(tx, context, &before)? {
        return Ok(ImpactOutcome::Stale);
    }
    let character = crate::world::CharacterKey { principal: context.principal.clone(), life: context.life };
    let native = native_armour
        .map(|sample| crate::armour::apply_native_impact(tx, catalog, &character, &kind, sample))
        .transpose()?.flatten();
    let (impact, power_loss) = match native {
        Some(result) => {
            tracing::trace!(generation = native_armour.map(|sample| sample.generation), "committing X-Ray armour impact");
            result
        }
        None => crate::armour::impact(tx, catalog, &character, &kind, f64::from(power), before.state.health)?,
    };
    let ArmourImpact::Hit { power, wound, .. } = impact else { return Ok(ImpactOutcome::Stale); };
    before.state.power = (before.state.power - power_loss).max(0.0);
    let deadline = impact_deadline(power, combat_lock_ms)?;
    let ImpactCommit { revision, alive } = commit_impact(tx, context, rules, before, location,
        (power, wound.then(|| kind.wound_site())), deadline)?;
    Ok(ImpactOutcome::Applied { revision, alive, impact, power_loss })
}

pub(crate) fn impact_current(tx: &Transaction<'_>, context: &Context, before: &Record) -> Result<bool> {
    Ok(before.state.health > 0.0 && tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM inventory_characters c JOIN principals p ON p.id=c.principal
         WHERE c.principal=?1 AND c.life=?2 AND c.alive=1 AND c.condition_revision=?3 AND p.revoked=0)",
        params![context.principal, context.life, before.revision], |row| row.get::<_, bool>(0),
    )?)
}

pub(crate) fn impact_deadline(power: f32, combat_lock_ms: u32) -> Result<i64> {
    if power == 0.0 || combat_lock_ms == 0 { return Ok(0); }
    Ok(crate::survival_rules::unix_millis()? + i64::from(combat_lock_ms))
}

pub(crate) fn commit_impact(
    tx: &Transaction<'_>, context: &Context, rules: Option<&SurvivalRules>, mut record: Record,
    mut location: Location, (power, wound): (f32, Option<(WoundKind, &str)>), deadline: i64,
) -> Result<ImpactCommit> {
    record.state.apply_hit_at(power, wound);
    location.combat_until_ms = location.combat_until_ms.max(deadline);
    commit_condition_change(tx, context, rules, record, location)
}

pub(crate) fn commit_condition_change(
    tx: &Transaction<'_>, context: &Context, rules: Option<&SurvivalRules>,
    mut record: Record, location: Location,
) -> Result<ImpactCommit> {
    let principal = &context.principal;
    let previous = record.revision;
    record.revision = previous.checked_add(1).context("condition revision exhausted")?;
    ensure!(tx.execute(
        "UPDATE inventory_characters SET condition=?1,condition_revision=?2,location=?3
         WHERE principal=?4 AND life=?5 AND alive=1 AND condition_revision=?6",
        params![serde_json::to_string(&record.state)?, record.revision, serde_json::to_string(&location)?,
            principal, context.life, previous],
    )? == 1, "condition changed during impact");
    let alive = record.state.health > 0.0;
    if !alive {
        let death = crate::inventory::die(tx, principal, context, rules)?;
        ensure!(death["status"] == "committed", "impact death did not commit");
    }
    Ok(ImpactCommit { revision: record.revision, alive })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_view_uses_native_boosters_and_capacity_without_legacy_stacking() {
        let mut bytes=b"ZCS1".to_vec();
        let mut values=[0.0f32;23+8+12+9];
        values[0]=0.8; values[1]=0.7; values[5]=1.0; values[18]=1.0;
        values[19]=70.0; values[20]=80.0;
        for value in values { bytes.extend_from_slice(&value.to_le_bytes()); }
        for value in [0u32,16,0,2] { bytes.extend_from_slice(&value.to_le_bytes()); }
        for (kind,value,remaining) in [(4u32,20.0f32,2.0f32),(14,0.1,30.0)] {
            bytes.extend_from_slice(&kind.to_le_bytes()); bytes.extend_from_slice(&value.to_le_bytes());
            bytes.extend_from_slice(&remaining.to_le_bytes());
        }
        let mut state=State::default();
        state.weight_boost=Booster{rate:99.0,remaining:999.0};
        state.boosts[0]=Booster{rate:0.5,remaining:99.0};
        state.install_native_checkpoint(crate::native_condition::Checkpoint::parse(bytes).unwrap()).unwrap();
        let mut loadout=Loadout::default(); loadout.capacity_bonus=5.0; loadout.mass=84.0;
        let view=state.wire_view(0,&tuning(),loadout);
        assert_eq!((view[8],view[9]),(75000,85000));
        assert_eq!(view[13],(1<<4)|(1<<5)|(1<<12));
        assert!(!state.motion(&tuning(),loadout).over_limit);
        loadout.mass=86.0; assert!(state.motion(&tuning(),loadout).over_limit);
        state.thirst=0.0;
        let (pending,input)=state.prepare_native_step(&tuning(),0.5,false).unwrap();
        assert_eq!(pending.health,state.health); assert_eq!(pending.thirst,0.0);
        assert_eq!(f32::from_le_bytes(input.bytes()[36..40].try_into().unwrap()),-tuning().dehydration_damage*0.5);
        let (_,protected)=state.prepare_native_step(&tuning(),0.5,true).unwrap();
        assert_eq!(f32::from_le_bytes(protected.bytes()[36..40].try_into().unwrap()),0.0);
        assert!(state.prepare_native_step(&tuning(),1.01,false).is_none());
        assert!(state.prepare_native_step(&tuning(),f32::NAN,false).is_none());
        state.medicine=Some(Medicine{total:Influence{health:0.8,thirst:0.2,..Influence::default()},duration:1.0,remaining:1.0});
        let (hydrated,_)=state.prepare_native_step(&tuning(),0.5,false).unwrap();
        assert!((hydrated.thirst-(0.1-tuning().thirst_decay*0.5)).abs()<1e-6);
        assert_eq!(hydrated.health,state.health);
        assert_eq!(hydrated.medicine.unwrap().remaining,0.5);
        assert_eq!(state.medicine.unwrap().remaining,1.0);
        let mut world=crate::world::World::new();
        world.survival_tuning=Some(tuning());
        let id=world.spawn(crate::world::Kind::Player,crate::world::Vec3::default());
        world.entities.get_mut(&id).unwrap().set_condition(state.clone());
        let before=serde_json::to_value(&state).unwrap();
        world.safe_zones.clear();
        world.environment_fields=Some(crate::environment::native_field_fixture());
        let mut batches=0;
        for _ in 0..30 {
            world.step();
            for (target,pulses) in &world.environment_hits {
                assert_eq!(*target,id);assert_eq!(pulses.len(),2);
                assert!(matches!(pulses[0].kind,crate::environment::Kind::Heat));
                assert!(matches!(pulses[1].kind,crate::environment::Kind::Radiation));
                assert_eq!(pulses[0].power,0.2);assert_eq!(pulses[1].power,0.2);
                batches+=1;
            }
        }
        assert_eq!(batches,10);
        assert_eq!(serde_json::to_value(world.entities[&id].condition.as_ref().unwrap()).unwrap(),before);
        world.native_player_movement=true;
        for _ in 0..30 {
            world.step();
            assert!(world.environment_hits.is_empty(),"native actor received duplicate Rust field hits");
        }
        assert_eq!(serde_json::to_value(world.entities[&id].condition.as_ref().unwrap()).unwrap(),before);




    }

    #[test]
    fn native_import_preserves_wounds_treatment_and_booster_types() {
        let mut state = State::default();
        state.health = 0.71; state.power = 0.63; state.satiety = 0.52;
        state.wounds.entry("bip01_spine".into()).or_default()[WoundKind::Bullet as usize] = 0.1234567;
        state.boosts[2] = Booster { rate: 0.03, remaining: 42.5 };
        state.medicine = Some(Medicine { total: Influence { health: 0.2, heal: 0.15,
            radiation: -0.1, ..Influence::default() }, duration: 60.0, remaining: 12.5 });
        let imported = state.native_import().unwrap();
        let fence = crate::native_condition::Fence { epoch: 1, boot: 2, player: 3, incarnation: 4,
            revision: 5, sequence: 6, equipment: 7 };
        let request = crate::native_condition::Request::import(fence, 25.0, &imported).unwrap();
        let bytes = &request.bytes()[60..];
        let scalar = |at| f32::from_le_bytes(bytes[at..at+4].try_into().unwrap());
        assert_eq!(&bytes[..4], b"ZCL1");
        assert_eq!((scalar(4), scalar(8), scalar(12)), (0.71,0.63,0.52));
        assert_eq!((scalar(28),scalar(40),scalar(44),scalar(56),scalar(60)), (0.2,-0.1,0.15,60.0,12.5));
        assert_eq!(bytes[76], 11);
        assert_eq!(&bytes[77..88], b"bip01_spine");
        assert_eq!(scalar(88+WoundKind::Bullet as usize*4),0.1234567);
        assert_eq!(u32::from_le_bytes(bytes[136..140].try_into().unwrap()),3); // native bleeding restore enum
        assert_eq!((scalar(140),scalar(144)),(0.03,42.5));
        state.wounds.clear(); state.bleeding=0.4;
        assert!(state.native_import().is_some()); // legacy bleeding becomes unknown-bone wound
        state.wounds.insert("invalid/name".into(),[0.0;12]);
        assert!(state.native_import().is_none());
    }

    fn tuning() -> Tuning {
        Tuning {
            satiety_decay: 0.0000162,
            satiety_critical: 0.3,
            satiety_health: 0.0001,
            satiety_power: 0.005,
            bleeding_damage: 0.002,
            wound_recovery: 0.0003,
            minimum_wound: 0.0256,
            health_restore: 0.0001,
            radiation_damage: 0.002,
            radiation_decay: 0.0,
            psy_recovery: 0.001,
            alcohol_decay: -0.0003,
            sprint_min: 0.1,
            sprint_recover: 0.3,
            walk_min: 0.01,
            walk_recover: 0.1,
            limp_health_min: 0.1,
            limp_health_recover: 0.2,
            limp_power_min: 0.1,
            limp_power_recover: 0.2,
            limp_scale: 0.5,
            carry_limit: 50.0,
            walk_limit: 60.0,
            stand_power: -0.001,
            walk_power: 0.00002,
            walk_weight_power: 0.0002,
            overweight_walk: 5.0,
            run_factor: 3.0,
            sprint_factor: 100.0,
            jump_power: 0.01,
            jump_weight_power: 0.05,
            overweight_jump: 5.0,
            thirst_decay: 0.0002,
            dehydration_damage: 0.001,
        }
    }

    #[test]
    fn wounds_average_by_bone_and_treatment_merges_with_live_healing() {
        let mut before = State::default();
        before.apply_hit_at(0.15, Some((WoundKind::Bullet, "bip01_spine")));
        before.apply_hit_at(0.15, Some((WoundKind::Cut, "bip01_spine")));
        before.apply_hit_at(0.06, Some((WoundKind::Bullet, "bip01_head")));
        assert!((before.bleeding - 0.18).abs() < 1e-6);

        let persisted = serde_json::to_string(&before).unwrap();
        let mut live: State = serde_json::from_str(&persisted).unwrap();
        live.heal_wounds(0.01, 0.0);
        let mut treated = before.clone();
        treated.heal_wounds(0.05, 0.0);
        let merged = treated.merge_dose(&before, &live, 0.05);
        assert_eq!(merged.wounds.len(), 1);
        assert!((merged.bleeding - 0.18).abs() < 1e-6);

        let mut legacy: State = serde_json::from_str(r#"{"bleeding":0.3}"#).unwrap();
        legacy.heal_wounds(0.05, 0.0);
        assert!((legacy.bleeding - 0.25).abs() < 1e-6);
        assert!(legacy.wounds.contains_key(""));
    }

    #[test]
    fn treatment_uses_original_rates_and_same_type_replaces_the_booster() {
        let dose = || Dose {
            influence: Influence::default(),
            duration: 0.0,
            weight_boost: Booster::default(),
            radiation_protection: Booster::default(),
            acid_protection: Booster::default(),
            psy_protection: Booster::default(),
            boosts: [
                Booster::default(),
                Booster::default(),
                Booster {
                    rate: 0.02,
                    remaining: 5.0,
                },
                Booster::default(),
            ],
        };
        let tuning = tuning();
        let mut state = State::default();
        state.damage(30, true);
        assert!(state.dose(dose()));
        assert_eq!(state.wire_view(0, &tuning, Loadout::default())[13], 0x0008);
        state.step(
            &tuning,
            Loadout::default(),
            2.0,
            Activity::Standing,
            false,
            false,
        );
        assert!(state.health < 0.7);
        assert_eq!(state.wire_view(0, &tuning, Loadout::default())[13], 0x0808);
        let before = state.bleeding;
        assert!(state.dose(dose()));
        assert_eq!(state.wire_view(0, &tuning, Loadout::default())[13], 0x0008);
        state.step(
            &tuning,
            Loadout::default(),
            5.0,
            Activity::Standing,
            false,
            false,
        );
        assert!((state.bleeding - (before - 0.1015)).abs() < 1e-6);
        assert_eq!(state.boosts[2].remaining, 0.0);
        assert_eq!(state.wire_view(0, &tuning, Loadout::default())[13], 0);
        let before = state.health;
        state.step(
            &tuning,
            Loadout::default(),
            1.0,
            Activity::Standing,
            false,
            true,
        );
        assert!(state.health > before);
    }

    #[test]
    fn sprint_hysteresis_dehydration_and_timed_medicine_are_server_simulated() {
        let tuning = tuning();
        let mut state = State {
            power: 0.105,
            health: 0.5,
            thirst: 0.0,
            ..State::default()
        };
        let loadout = Loadout {
            mass: 55.0,
            ..Loadout::default()
        };
        state.step(&tuning, loadout, 1.0, Activity::Sprinting, false, false);
        assert!(!state.motion(&tuning, loadout).sprint);
        assert!(state.health < 0.5);
        let medicine = || Dose {
            influence: Influence {
                health: 0.2,
                ..Influence::default()
            },
            duration: 2.0,
            boosts: [Booster::default(); 4],
            weight_boost: Booster::default(),
            radiation_protection: Booster::default(),
            acid_protection: Booster::default(),
            psy_protection: Booster::default(),
        };
        assert!(state.dose(medicine()));
        assert!(!state.dose(medicine()));
        let before = state.health;
        state.step(&tuning, loadout, 1.0, Activity::Standing, false, true);
        assert!((state.health - before - 0.1002).abs() < 1e-5);
        state.step(&tuning, loadout, 1.0, Activity::Standing, false, true);
        assert!(state.medicine.is_none());
        state.step(&tuning, loadout, 60.0, Activity::Standing, false, true);
        assert!(state.motion(&tuning, loadout).sprint);
    }

    #[test]
    fn overload_and_weight_boost_apply_original_limits_and_power_costs() {
        let tuning = tuning();
        let overloaded = Loadout {
            mass: 61.0,
            ..Loadout::default()
        };
        let mut state = State {
            power: 0.75,
            satiety: 0.0,
            ..State::default()
        };
        assert!(state.motion(&tuning, overloaded).over_limit);
        let carried = Loadout {
            mass: 55.0,
            ..overloaded
        };
        assert!(state.motion(&tuning, carried).sprint);
        state.step(&tuning, carried, 1.0, Activity::Sprinting, true, true);
        assert!((state.power - (0.75 - 0.056 - 0.1425)).abs() < 1e-6);

        let outfit = Loadout {
            capacity_bonus: 30.0,
            outfit_allows_sprint: false,
            ..overloaded
        };
        assert!(state.motion(&tuning, outfit).walk);
        assert!(!state.motion(&tuning, outfit).sprint);
        assert!(state.dose(Dose {
            influence: Influence::default(),
            duration: 0.0,
            boosts: [Booster::default(); 4],
            radiation_protection: Booster::default(),
            acid_protection: Booster::default(),
            psy_protection: Booster::default(),
            weight_boost: Booster {
                rate: 20.0,
                remaining: 1.0
            }
        }));
        assert_eq!(state.limits(&tuning, overloaded), (70.0, 80.0));
        assert!(state.motion(&tuning, overloaded).walk);
        state.step(&tuning, overloaded, 1.0, Activity::Standing, false, true);
        assert!(!state.motion(&tuning, overloaded).walk);
    }

    #[test]
    fn worn_equipment_changes_authoritative_condition_rates() {
        let tuning = tuning();
        let mut naked = State {
            health: 0.5, power: 0.5, satiety: 0.5, bleeding: 0.5, radiation: 0.5,
            ..State::default()
        };
        let mut equipped = naked.clone();
        let loadout = Loadout {
            restoration: Restoration {
                health: 0.02, power: 0.03, satiety: 0.04, bleeding: 0.05, radiation: -0.06,
            },
            ..Loadout::default()
        };
        naked.step(&tuning, Loadout::default(), 1.0, Activity::Standing, false, true);
        equipped.step(&tuning, loadout, 1.0, Activity::Standing, false, true);
        assert!((equipped.health - naked.health - 0.0200057).abs() < 1e-6);
        assert!((equipped.power - naked.power - 0.0302).abs() < 1e-6);
        assert!((equipped.satiety - naked.satiety - 0.04).abs() < 1e-6);
        assert!((naked.bleeding - equipped.bleeding - 0.05).abs() < 1e-6);
        assert!((naked.radiation - equipped.radiation - 0.06).abs() < 1e-6);
    }

    #[test]
    fn protection_doses_resume_and_expire_with_the_saved_condition() {
        use crate::environment::Kind;
        let definition = Section { source: "fixture".into(), values: [
            ("boost_radiation_protection", "0.015"), ("boost_chemburn_protection", "0.1"),
            ("boost_telepat_protection", "0.05"), ("boost_time", "1"),
        ].into_iter().map(|(key, value)| (key.into(), value.into())).collect() };
        let dose = Dose::from_catalog("protection", &definition, &SurvivalRules::default()).unwrap().unwrap();
        let mut state = State::default();
        assert!(state.dose(dose));
        let mut state: State = serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap();
        assert_eq!(state.field_boost(Kind::Radiation), 0.015);
        assert_eq!(state.field_boost(Kind::Acid), 0.1);
        assert_eq!(state.field_boost(Kind::Psy), 0.05);
        state.step(&tuning(), Loadout::default(), 1.0, Activity::Standing, false, false);
        for kind in [Kind::Radiation, Kind::Acid, Kind::Psy] { assert_eq!(state.field_boost(kind), 0.0); }
    }
}
