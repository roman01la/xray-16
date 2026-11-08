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
    pub health: f32,
    pub power: f32,
    pub satiety: f32,
    pub thirst: f32,
    pub bleeding: f32,
    pub radiation: f32,
    pub alcohol: f32,
    sprint_blocked: bool,
    walk_blocked: bool,
    limping: bool,
    medicine: Option<Medicine>,
    boosts: [Booster; 4],
    weight_boost: Booster,
}
impl Default for State {
    fn default() -> Self {
        Self {
            health: 1.0,
            power: 1.0,
            satiety: 1.0,
            thirst: 1.0,
            bleeding: 0.0,
            radiation: 0.0,
            alcohol: 0.0,
            sprint_blocked: false,
            walk_blocked: false,
            limping: false,
            medicine: None,
            boosts: [Booster::default(); 4],
            weight_boost: Booster::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Loadout {
    pub mass: f64,
    pub capacity_bonus: f64,
    pub power_loss: f64,
    pub outfit_allows_sprint: bool,
}
impl Default for Loadout {
    fn default() -> Self {
        Self {
            mass: 0.0,
            capacity_bonus: 0.0,
            power_loss: 0.5,
            outfit_allows_sprint: true,
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
pub struct Blast {
    pub power: f32,
    pub before: Record,
    pub location: Location,
    pub combat_lock_ms: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BlastOutcome {
    Stale,
    Applied { revision: u32, alive: bool, impact: ArmourImpact },
}

pub struct SavedLogout {
    pub principal: String,
    pub life: u32,
    pub condition: Record,
    pub location: Location,
    pub loadout: Loadout,
}

fn get(section: &Section, key: &str) -> Result<f32> {
    if !section.values.contains_key(key) {
        return Ok(0.0);
    }
    let n = section.number(key)? as f32;
    ensure!(n.is_finite(), "invalid survival value {key}");
    Ok(n)
}

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
}
impl Dose {
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
        let extra_weight = get(definition, "boost_max_weight")?;
        let weight_boost = if extra_weight > 0.0 && boost_time > 0.0 {
            Booster {
                rate: extra_weight,
                remaining: boost_time,
            }
        } else {
            Booster::default()
        };
        let mut boosts = [Booster::default(); 4];
        for (boost, key) in boosts.iter_mut().zip(BOOSTS) {
            let rate = get(definition, key)?;
            if rate > 0.0 && boost_time > 0.0 {
                *boost = Booster {
                    rate,
                    remaining: boost_time,
                };
            }
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
            || weight_boost.remaining > 0.0;
        Ok(effect.then_some(Self {
            influence,
            duration,
            boosts,
            weight_boost,
        }))
    }
}

impl State {
    pub fn health_points(&self) -> u16 {
        (self.health.clamp(0.0, 1.0) * 100.0).ceil() as u16
    }
    pub fn wire_view(&self, life: u32, tuning: &Tuning, loadout: Loadout) -> [u32; 11] {
        let quantize = |value: f32| (value.clamp(0.0, 1.0) * 1000.0).round() as u32;
        let grams = |kg: f64| (kg * 1000.0).round() as u32;
        let motion = self.motion(tuning, loadout);
        let (carry, walk) = self.limits(tuning, loadout);
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
        ]
    }
    fn limits(&self, tuning: &Tuning, loadout: Loadout) -> (f64, f64) {
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
            sprint: walk && !self.sprint_blocked && !self.limping && loadout.outfit_allows_sprint,
            limp_scale: if self.limping { tuning.limp_scale } else { 1.0 },
            over_limit,
        }
    }
    pub fn damage(&mut self, points: u16, fire_wound: bool) {
        self.apply_hit(f32::from(points) / 100.0, fire_wound);
    }
    pub(crate) fn apply_hit(&mut self, power: f32, fire_wound: bool) {
        self.health = (self.health - power).max(0.0);
        if fire_wound && self.health > 0.0 {
            self.bleeding = (self.bleeding + power).min(1.0);
        }
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
        true
    }
    fn influence(&mut self, effect: Influence, fraction: f32) {
        self.health += effect.health * fraction;
        self.power += effect.power * fraction;
        self.satiety += effect.satiety * fraction;
        self.radiation += effect.radiation * fraction;
        self.alcohol += effect.alcohol * fraction;
        self.thirst += effect.thirst * fraction;
        self.bleeding -= effect.heal * fraction;
        self.bound();
    }
    fn bound(&mut self) {
        for value in [
            &mut self.health,
            &mut self.power,
            &mut self.satiety,
            &mut self.radiation,
            &mut self.alcohol,
            &mut self.thirst,
            &mut self.bleeding,
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
        self.satiety -= tuning.satiety_decay * dt;
        self.thirst -= tuning.thirst_decay * dt;
        let satiety_effect = (self.satiety.clamp(0.0, 1.0) - tuning.satiety_critical)
            / if self.satiety >= tuning.satiety_critical {
                1.0 - tuning.satiety_critical
            } else {
                tuning.satiety_critical
            };
        self.health += tuning.health_restore * dt + boosts[0];
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
                let weight = ratio
                    * if ratio > 1.0 {
                        tuning.overweight_walk
                    } else {
                        1.0
                    };
                let factor = match activity {
                    Activity::Running => tuning.run_factor,
                    Activity::Sprinting => tuning.sprint_factor,
                    _ => 1.0,
                };
                (tuning.walk_power + tuning.walk_weight_power * weight) * factor * power_loss
            }
        };
        if jumped {
            let weight = ratio
                * if ratio > 1.0 {
                    tuning.overweight_jump
                } else {
                    1.0
                };
            self.power -= (tuning.jump_power + tuning.jump_weight_power * weight) * power_loss;
        }
        self.power += (tuning.satiety_power * self.satiety.max(0.0) - power_rate) * dt + boosts[1];
        self.weight_boost.remaining = (self.weight_boost.remaining - dt).max(0.0);
        self.bleeding -= tuning.wound_recovery * dt + boosts[2];
        if self.bleeding < tuning.minimum_wound {
            self.bleeding = 0.0;
        }
        self.radiation -= tuning.radiation_decay * dt + boosts[3];
        self.alcohol += tuning.alcohol_decay * dt;
        self.bound();
        let blocked =
            |previous, min, recover| self.power < min || (previous && self.power <= recover);
        self.sprint_blocked = blocked(
            self.sprint_blocked,
            tuning.sprint_min,
            tuning.sprint_recover,
        );
        self.walk_blocked = blocked(self.walk_blocked, tuning.walk_min, tuning.walk_recover);
        self.limping = self.power < tuning.limp_power_min
            || self.health < tuning.limp_health_min
            || (self.limping
                && (self.power <= tuning.limp_power_recover
                    || self.health <= tuning.limp_health_recover));
    }
    /// The simulation keeps progressing while a dose is queued. Preserve new
    /// damage/changes, and retain the committed timer/booster replacement.
    pub fn merge_dose(mut self, before: &Self, live: &Self) -> Self {
        self.health += live.health - before.health;
        self.power += live.power - before.power;
        self.satiety += live.satiety - before.satiety;
        self.thirst += live.thirst - before.thirst;
        self.bleeding += live.bleeding - before.bleeding;
        self.radiation += live.radiation - before.radiation;
        self.alcohol += live.alcohol - before.alcohol;
        self.sprint_blocked = live.sprint_blocked;
        self.walk_blocked = live.walk_blocked;
        self.limping = live.limping;
        if self.weight_boost == before.weight_boost {
            self.weight_boost = live.weight_boost;
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
        "SELECT c.principal,c.life,c.condition_revision,c.condition,c.location
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
        saved.push(SavedLogout {
            loadout: crate::inventory::loadout(tx, &principal, catalog)?,
            principal,
            life: row.get(1)?,
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

pub(crate) fn resolve_blast(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    rules: Option<&SurvivalRules>,
    context: &Context,
    blast: Blast,
) -> Result<BlastOutcome> {
    let Blast { power, before: mut record, mut location, combat_lock_ms } = blast;
    let principal = &context.principal;
    let previous = record.revision;
    let current: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM inventory_characters
         WHERE principal=?1 AND life=?2 AND alive=1 AND condition_revision=?3)",
        params![principal, context.life, previous], |row| row.get(0),
    )?;
    if !current || record.state.health <= 0.0 {
        return Ok(BlastOutcome::Stale);
    }
    record.revision = previous.checked_add(1).context("condition revision exhausted")?;
    let character = crate::world::CharacterKey { principal: principal.clone(), life: context.life };
    let impact = crate::armour::blast(tx, catalog, &character, f64::from(power))?;
    let ArmourImpact::Hit { power, wound, .. } = impact else { return Ok(BlastOutcome::Stale); };
    record.state.apply_hit(power, wound);
    if power > 0.0 && combat_lock_ms != 0 {
        let deadline = crate::survival_rules::unix_millis()? + i64::from(combat_lock_ms);
        location.combat_until_ms = location.combat_until_ms.max(deadline);
    }
    ensure!(tx.execute(
        "UPDATE inventory_characters SET condition=?1,condition_revision=?2,location=?3
         WHERE principal=?4 AND life=?5 AND alive=1 AND condition_revision=?6",
        params![serde_json::to_string(&record.state)?, record.revision, serde_json::to_string(&location)?,
            principal, context.life, previous],
    )? == 1, "condition changed during blast");
    let alive = record.state.health > 0.0;
    if !alive {
        let death = crate::inventory::die(tx, principal, context, rules)?;
        ensure!(death["status"] == "committed", "blast death did not commit");
    }
    Ok(BlastOutcome::Applied { revision: record.revision, alive, impact })
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn treatment_uses_original_rates_and_same_type_replaces_the_booster() {
        let dose = || Dose {
            influence: Influence::default(),
            duration: 0.0,
            weight_boost: Booster::default(),
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
        state.step(
            &tuning,
            Loadout::default(),
            2.0,
            Activity::Standing,
            false,
            false,
        );
        assert!(state.health < 0.7);
        let before = state.bleeding;
        assert!(state.dose(dose()));
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
}
