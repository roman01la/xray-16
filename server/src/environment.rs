//! Continuous CoP fields from the original ALife graph and LTX profiles.
use crate::{
    authored_shape::{Shape, Volume},
    catalog::Catalog,
    collision::{CollisionMap, rotation_basis},
    inventory::{Context, ItemState},
    survival::{ImpactCommit, Location, Record, State},
    survival_rules::SurvivalRules,
};
use anyhow::{Result, ensure};
use parry3d::math::Vector;
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::Path, sync::Arc};

const PULSE_SECONDS: f32 = 0.1;
const MAX_FIELDS: usize = 512;
const MAX_ELECTRAS: usize = 128;
const KIND_COUNT: usize = 5;
pub const MAX_PENDING_PULSES: usize = 2048;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Radiation,
    Acid,
    Heat,
    Psy,
    Shock,
}

impl Kind {
    const ALL: [Self; KIND_COUNT] = [
        Self::Radiation,
        Self::Acid,
        Self::Heat,
        Self::Psy,
        Self::Shock,
    ];
    fn from_section(hit: &str) -> Result<Self> {
        Ok(match hit {
            "radiation" => Self::Radiation,
            "chemical_burn" => Self::Acid,
            "light_burn" => Self::Heat,
            "telepatic" => Self::Psy,
            _ => anyhow::bail!("unsupported continuous field hit type {hit}"),
        })
    }
    fn immunity(self) -> &'static str {
        match self {
            Self::Radiation => "radiation_immunity",
            Self::Acid => "chemical_burn_immunity",
            Self::Heat => "burn_immunity",
            Self::Psy => "telepatic_immunity",
            Self::Shock => "shock_immunity",
        }
    }
    fn protection(self) -> &'static str {
        match self {
            Self::Radiation => "radiation_protection",
            Self::Acid => "chemical_burn_protection",
            Self::Heat => "burn_protection",
            Self::Psy => "telepatic_protection",
            Self::Shock => "shock_protection",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Pulse {
    pub kind: Kind,
    pub power: f32,
}

#[derive(Clone)]
pub struct Exposure {
    pub pulses: Arc<[Pulse]>,
    pub before: Record,
    pub location: Location,
}

#[derive(Deserialize, Serialize)]
pub struct Outcome {
    pub commit: ImpactCommit,
    pub deltas: [f32; 4],
    pub armour: Option<Armour>,
}

pub(crate) fn resolve(
    tx: &Transaction<'_>,
    catalog: &Catalog,
    rules: Option<&SurvivalRules>,
    context: &Context,
    exposure: Exposure,
) -> Result<Option<Outcome>> {
    let Exposure {
        pulses,
        mut before,
        location,
    } = exposure;
    ensure!(before.state.native_checkpoint().is_none(), "native condition field proposal required");
    if !crate::survival::impact_current(tx, context, &before)? {
        return Ok(None);
    }
    let key = crate::world::CharacterKey {
        principal: context.principal.clone(),
        life: context.life,
    };
    let state = &mut before.state;
    let baseline = [state.health, state.power, state.radiation, state.psy_health];
    let armour = crate::armour::field_exposure(tx, catalog, &key, &pulses, state)?;
    let after = [state.health, state.power, state.radiation, state.psy_health];
    let deltas = std::array::from_fn(|i| after[i] - baseline[i]);
    if armour.is_none() && deltas == [0.0; 4] {
        return Ok(None);
    }
    let commit = crate::survival::commit_condition_change(tx, context, rules, before, location)?;
    Ok(Some(Outcome {
        commit,
        deltas,
        armour,
    }))
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Layer {
    protection: [f32; KIND_COUNT],
    wear: [f32; KIND_COUNT],
    pub(crate) condition: f32,
}

impl Layer {
    fn from_item(catalog: &Catalog, section: &str, state: &ItemState) -> Result<Self> {
        let mut layer = Self {
            condition: state.condition,
            ..Self::default()
        };
        for kind in Kind::ALL {
            let i = kind as usize;
            let rating = if kind == Kind::Heat {
                // CoP copies burn protection to light_burn on load. Upgrades
                // modify the burn slot, which is distinct from light_burn.
                let (definition, _) = catalog.item(section)?;
                if definition.values.contains_key(kind.protection()) {
                    definition.number(kind.protection())?
                } else {
                    0.0
                }
            } else {
                catalog.effective_number(section, state, kind.protection(), 0.0)?
            };
            layer.protection[i] = 0.1 * rating as f32;
            layer.wear[i] = item_wear(catalog, section, state, kind.immunity())? as f32;
            ensure!(
                layer.protection[i].is_finite() && layer.wear[i].is_finite(),
                "invalid field armour rating"
            );
        }
        Ok(layer)
    }

    fn absorb(&mut self, kind: Kind, power: f32) -> f32 {
        let i = kind as usize;
        let reduced = (power - self.protection[i] * self.condition).max(0.0);
        self.condition = (self.condition - power * self.wear[i].max(0.0)).clamp(0.0, 1.0);
        reduced
    }
}

pub(crate) fn item_wear(
    catalog: &Catalog,
    section: &str,
    state: &ItemState,
    immunity: &str,
) -> Result<f64> {
    let (base, _) = catalog.item(section)?;
    let mut factor = 1.0;
    for definition in
        std::iter::once(base).chain(catalog.upgrade_effects(section, &state.upgrades)?)
    {
        if let Some(name) = definition
            .values
            .get("immunities_sect")
            .filter(|name| !name.is_empty())
        {
            let profile = catalog.section(name)?;
            factor = if profile.values.contains_key(immunity) {
                profile.number(immunity)?
            } else {
                1.0
            };
        }
        if let Some(name) = definition
            .values
            .get("immunities_sect_add")
            .filter(|name| !name.is_empty())
        {
            let extra = catalog.section(name)?;
            if extra
                .values
                .get(immunity)
                .is_some_and(|value| !value.is_empty())
            {
                factor += extra.number(immunity)?;
            }
        }
    }
    ensure!(factor.is_finite(), "invalid armour wear");
    Ok(factor)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Armour {
    generation: i64,
    pub(crate) outfit: Layer,
    pub(crate) helmet: Layer,
}

impl Armour {
    pub fn generation(&self) -> Option<u64> { u64::try_from(self.generation).ok() }
    pub(crate) fn add(
        &mut self,
        catalog: &Catalog,
        section: &str,
        state: &ItemState,
        place: &str,
    ) -> Result<()> {
        let layer = match place {
            "slot:7" => &mut self.outfit,
            "slot:12" => &mut self.helmet,
            _ => return Ok(()),
        };
        *layer = Layer::from_item(catalog, section, state)?;
        Ok(())
    }

    pub(crate) fn stamp(&mut self, tx: &Transaction<'_>, principal: &str) -> Result<()> {
        self.generation = tx
            .prepare_cached("SELECT generation FROM inventory_characters WHERE principal=?1")?
            .query_row([principal], |row| row.get(0))?;
        Ok(())
    }

    pub fn take_newer(&mut self, other: Self) {
        if other.generation > self.generation {
            *self = other;
        }
    }

    pub(crate) fn needs_wear(self, kind: Kind) -> bool {
        [self.outfit, self.helmet]
            .iter()
            .any(|layer| layer.condition > 0.0 && layer.wear[kind as usize] > 0.0)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Protection {
    belt: [f32; KIND_COUNT],
    pub armour: Armour,
}

impl Protection {
    pub(crate) fn add_artefact(
        &mut self,
        catalog: &Catalog,
        definition: &crate::catalog::Section,
    ) -> Result<()> {
        let Some(profile) = definition
            .values
            .get("hit_absorbation_sect")
            .filter(|name| !name.is_empty())
        else {
            return Ok(());
        };
        let profile = catalog.section(profile)?;
        for kind in Kind::ALL {
            if profile.values.contains_key(kind.immunity()) {
                // The original hit path uses the raw belt absorption rating.
                let rating = &mut self.belt[kind as usize];
                *rating += profile.number(kind.immunity())? as f32;
                ensure!(rating.is_finite(), "invalid field artefact absorption");
            }
        }
        Ok(())
    }

    pub(crate) fn absorb(&mut self, pulse: Pulse) -> f32 {
        let power = (pulse.power - self.belt[pulse.kind as usize]).max(0.0);
        let power = self.armour.outfit.absorb(pulse.kind, power);
        self.armour.helmet.absorb(pulse.kind, power)
    }
}

#[derive(Clone, Copy)]
pub(crate) struct Factors {
    immunity: [f32; KIND_COUNT],
    health: f32,
    power: f32,
}

impl Factors {
    pub(crate) fn from_catalog(catalog: &Catalog) -> Result<Self> {
        let actor = catalog.section("actor")?;
        let condition = catalog.section(actor.text("condition_sect")?)?;
        let immunity_section = catalog.section("actor_immunities_gd_master")?;
        let mut result = Self {
            immunity: [0.0; KIND_COUNT],
            health: condition.number("health_hit_part")? as f32,
            power: condition.number("power_hit_part")? as f32,
        };
        for kind in Kind::ALL {
            if kind == Kind::Shock && !immunity_section.values.contains_key(kind.immunity()) {
                continue; // Continuous-only catalogs predate the shock profile.
            }
            result.immunity[kind as usize] = immunity_section.number(kind.immunity())? as f32;
        }
        ensure!(
            result
                .immunity
                .into_iter()
                .chain([result.health, result.power])
                .all(|v| (0.0..=100.0).contains(&v)),
            "invalid actor field coefficients"
        );
        Ok(result)
    }

    pub(crate) fn apply(self, state: &mut State, protection: &mut Protection, pulse: Pulse) {
        let [health, power, radiation, psy] = crate::xray_combat_rules::field_damage(pulse.kind, [
            protection.absorb(pulse), state.field_boost(pulse.kind),
            self.immunity[pulse.kind as usize], 0.0, self.health, self.power, 1.0,
        ]);
        if pulse.kind == Kind::Radiation {
            state.radiation = (state.radiation + radiation).min(1.0);
        } else {
            state.health = (state.health - health).max(0.0);
            state.power = (state.power - power).max(0.0);
            if pulse.kind == Kind::Psy {
                state.psy_health = (state.psy_health - psy).max(0.0);
            }
        }
    }

    pub(crate) fn apply_all(
        self,
        state: &mut State,
        protection: &mut Protection,
        pulses: &[Pulse],
    ) {
        for &pulse in pulses {
            if state.health == 0.0 {
                break;
            }
            self.apply(state, protection, pulse);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema: u32,
    level: String,
    spawn_sha256: String,
    item_catalog_sha256: String,
    fields: Vec<Spawn>,
    #[serde(default)]
    reactive_mines: Vec<Spawn>,
    detector_zones: Option<Vec<Spawn>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Spawn {
    spawn_id: u16,
    section: String,
    position: [f32; 3],
    rotation: [f32; 3],
    shape: Option<Shape>,
    #[serde(default)]
    shapes: Vec<Shape>,
    start_power: f32,
}

struct Field {
    volumes: Vec<Volume>,
    center: Vector,
    radius_squared: f32,
    pulse: Pulse,
    attenuation: f32,
}

struct Electra {
    section: String,
    position: crate::world::Vec3,
    volume: Volume,
    power: f32,
    radius: f32,
    attenuation: f32,
    wake_ticks: u32,
    recover_ticks: u32,
    bolt_contact_ticks: u32,
    bolt_contacts: std::collections::BTreeMap<u32, (u32, u32)>,
    phase: ElectraPhase,
}

enum ElectraPhase {
    Idle,
    Waking(u32),
    Recovering(u32),
}

impl Electra {
    fn new(spawn: Spawn, catalog: &Catalog) -> Result<Self> {
        ensure!(
            matches!(
                spawn.section.as_str(),
                "zone_mine_electric_weak"
                    | "zone_mine_electric_average"
                    | "zone_mine_electric_strong"
            ),
            "unsupported reactive mine {}",
            spawn.section
        );
        let section = catalog.section(&spawn.section)?;
        ensure!(
            section.text("class")? == "ZS_MBALD"
                && section.text("hit_type")? == "shock"
                && !section.boolean("ignore_small", true)?
                && !section.boolean("ignore_nonalive", true)?
                && !section.boolean("blowout_once", false)?,
            "unsupported Electra configuration"
        );
        for key in [
            "blowout_sound_time",
            "blowout_particles_time",
            "blowout_explosion_time",
        ] {
            ensure!(
                !section.values.contains_key(key) || section.integer(key)? == 0,
                "delayed Electra cue"
            );
        }
        let ticks = |key| -> Result<u32> {
            let milliseconds = section.integer(key)?;
            ensure!(
                (1..=60_000).contains(&milliseconds),
                "invalid Electra timing {key}"
            );
            Ok((milliseconds as u32 * crate::world::TICK_HZ).div_ceil(1000))
        };
        ensure!(
            spawn.shape.is_none() && matches!(spawn.shapes.as_slice(), [Shape::Sphere { .. }]),
            "expected an authored Electra sphere"
        );
        let volume = Volume::new(
            spawn.shapes.into_iter().next().unwrap(),
            spawn.position,
            spawn.rotation,
        )?;
        let power = section.number("max_start_power")? as f32;
        let radius = volume.radius * section.number("effective_radius")? as f32;
        let attenuation = section.number("attenuation")? as f32;
        ensure!(
            (0.0..=10.0).contains(&power)
                && (0.001..=32.0).contains(&radius)
                && (0.0..=10.0).contains(&attenuation),
            "invalid Electra profile"
        );
        let [x, y, z] = spawn.position;
        Ok(Self {
            section: spawn.section,
            position: crate::world::Vec3 { x, y, z },
            volume,
            power,
            radius,
            attenuation,
            wake_ticks: ticks("awaking_time")?,
            recover_ticks: ticks("blowout_time")? + ticks("accamulate_time")?,
            bolt_contact_ticks: ticks("disable_time_small")?,
            bolt_contacts: Default::default(),
            phase: ElectraPhase::Idle,
        })
    }

    fn actors<'a>(
        &'a self,
        world: &'a crate::world::World,
    ) -> impl Iterator<Item = &'a crate::world::Entity> + 'a {
        world
            .entities_near(self.volume.center, self.volume.radius + 2.0)
            .filter(|actor| {
                actor.health > 0
                    && !actor.travelling
                    && actor.kind == crate::world::Kind::Player
                    && self.volume.touches(
                        Vector::new(actor.position.x, actor.position.y, actor.position.z),
                        world.capsule_height(actor.id),
                    )
            })
    }

    fn step(
        &mut self,
        world: &crate::world::World,
        bolts: &[(u32, Vector)],
        effects: &mut Vec<crate::combat::Detonation>,
        hits: &mut Vec<(u32, Pulse)>,
    ) {
        use crate::world::newer;
        for &(id, position) in bolts {
            if self.volume.center.distance_squared(position)
                <= (self.volume.radius + crate::projectile::BOLT_RADIUS).powi(2)
            {
                self.bolt_contacts
                    .entry(id)
                    .or_insert((world.tick, world.tick))
                    .1 = world.tick;
            }
        }
        self.bolt_contacts
            .retain(|_, (_, seen)| *seen == world.tick);
        let active = || {
            self.actors(world).next().is_some()
                || self.bolt_contacts.values().any(|(entered, _)| {
                    world.tick.wrapping_sub(*entered) <= self.bolt_contact_ticks
                })
        };
        match self.phase {
            ElectraPhase::Idle => {
                if active() {
                    self.phase = ElectraPhase::Waking(world.tick.wrapping_add(self.wake_ticks));
                }
                return;
            }
            ElectraPhase::Waking(until) | ElectraPhase::Recovering(until)
                if newer(until, world.tick) =>
            {
                return;
            }
            ElectraPhase::Recovering(_) if !active() => {
                self.phase = ElectraPhase::Idle;
                return;
            }
            ElectraPhase::Waking(_) | ElectraPhase::Recovering(_) => {}
        }
        effects.push(crate::combat::Detonation {
            section: self.section.clone(),
            position: self.position,
            hits: Vec::new(),
            native_hits: Vec::new(),
        });
        for actor in self
            .actors(world)
            .filter(|actor| !world.is_protected(actor))
        {
            let feet = Vector::new(actor.position.x, actor.position.y, actor.position.z);
            let distance = (feet.distance(self.volume.center) - 0.35).max(0.0);
            if distance > self.radius {
                continue;
            }
            let power =
                self.power * (1.0 - self.attenuation * (distance / self.radius).powi(2)).max(0.0);
            if power > 0.01 {
                hits.push((
                    actor.id,
                    Pulse {
                        kind: Kind::Shock,
                        power,
                    },
                ));
            }
        }
        self.phase = ElectraPhase::Recovering(world.tick.wrapping_add(self.recover_ticks));
    }
}

#[derive(Debug)]
struct RadarZone {
    section: String,
    position: [f32; 3],
    center: Vector,
    radius: f32,
    spawn_id: u16,
}

/// Immutable authored zones for Svarog. The simulation keeps its own state
/// for the zone families whose contact effects are implemented.
#[derive(Debug)]
pub struct RadarZones(Vec<RadarZone>);

impl RadarZones {
    fn load(spawns: Vec<Spawn>, collision: &CollisionMap, catalog: &Catalog) -> Result<Self> {
        ensure!(spawns.len() <= MAX_FIELDS, "too many detector zones");
        let mut seen = BTreeSet::new();
        let bounds = &collision.manifest.bounds;
        let zones = spawns.into_iter().map(|spawn| {
            let id = spawn.spawn_id;
            ensure!(seen.insert(id), "duplicate detector zone {id}");
            ensure!(crate::inventory::section_valid(&spawn.section)
                && matches!(catalog.section(&spawn.section)?.text("class")?, "ZS_MBALD" | "ZS_GALAN" | "ZS_MINCE")
                && spawn.shape.is_none() && (1..=16).contains(&spawn.shapes.len()),
                "invalid detector zone {id}");
            // CCF_Shape uses the original sphere for a lone sphere and the
            // enclosing local AABB's sphere for boxes or composite shapes.
            let (local, radius) = match spawn.shapes.as_slice() {
                [Shape::Sphere { center, radius }] => (Vector::from_array(*center), *radius),
                shapes => {
                    let (min, max) = shapes.iter().map(Shape::bounds)
                        .reduce(|(min, max), (a, b)| (min.min(a), max.max(b))).unwrap();
                    ((min + max) * 0.5, (max - min).length() * 0.5)
                }
            };
            let basis = rotation_basis(spawn.rotation);
            let center = Vector::from_array(spawn.position)
                + basis[0] * local.x + basis[1] * local.y + basis[2] * local.z;
            ensure!(center.is_finite() && (0.001..=1000.0).contains(&radius),
                "invalid detector zone bounds {id}");
            let mut overlaps = false;
            for shape in spawn.shapes {
                overlaps |= Volume::new(shape, spawn.position, spawn.rotation)?.overlaps(bounds.min, bounds.max);
            }
            ensure!(overlaps, "detector zone {id} outside collision bounds");
            Ok(RadarZone { section: spawn.section, position: spawn.position, center, radius, spawn_id: id })
        }).collect::<Result<Vec<_>>>()?;
        Ok(Self(zones))
    }

    pub(crate) fn nearest<'a>(
        &'a self, position: [f64; 3], radius: f32, allowed: &BTreeSet<&str>, limit: usize,
    ) -> impl Iterator<Item = (&'a str, [f32; 3])> {
        let position = Vector::from_array(position.map(|axis| axis as f32));
        let mut candidates: Vec<_> = self.0.iter().filter_map(|zone| {
            let distance = zone.center.distance_squared(position);
            (distance <= (radius + zone.radius).powi(2) && allowed.contains(zone.section.as_str()))
                .then_some((zone, distance))
        }).collect();
        candidates.sort_unstable_by(|(a, da), (b, db)| da.total_cmp(db).then(a.spawn_id.cmp(&b.spawn_id)));
        candidates.into_iter().take(limit).map(|(zone, _)| (zone.section.as_str(), zone.position))
    }
}

pub struct Fields {
    fields: Vec<Field>,
    electras: Vec<Electra>,
    detector_zones: Option<Arc<RadarZones>>,
    pub(crate) factors: Factors,
}

impl Fields {
    pub fn load(path: &Path, collision: &CollisionMap, catalog: &Catalog) -> Result<Self> {
        ensure!(
            fs::metadata(path)?.len() <= 512 * 1024,
            "oversized field manifest"
        );
        let manifest: Manifest = serde_json::from_slice(&fs::read(path)?)?;
        ensure!(
            [1, 2, 3, 4].contains(&manifest.schema)
                && manifest.level == collision.manifest.level
                && manifest.item_catalog_sha256 == catalog.sha256,
            "field manifest level or catalog mismatch"
        );
        ensure!(
            manifest.spawn_sha256.len() == 64
                && manifest
                    .spawn_sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "invalid field spawn hash"
        );
        ensure!(
            (1..=MAX_FIELDS).contains(&manifest.fields.len())
                && manifest.reactive_mines.len() <= MAX_ELECTRAS
                && (manifest.schema >= 3 || manifest.reactive_mines.is_empty())
                && (manifest.schema == 4) == manifest.detector_zones.is_some(),
            "invalid field count"
        );
        let mut seen = BTreeSet::new();
        let mut fields = Vec::with_capacity(manifest.fields.len());
        let mut counts = [0; 4];
        let bounds = &collision.manifest.bounds;
        for spawn in manifest.fields {
            ensure!(
                seen.insert(spawn.spawn_id),
                "duplicate field spawn {}",
                spawn.spawn_id
            );
            let id = spawn.spawn_id;
            let section = catalog.section(&spawn.section)?;
            let kind = Kind::from_section(section.text("hit_type")?)?;
            ensure!(
                matches!(section.text("class")?, "Z_RADIO" | "ZS_RADIO")
                    && (manifest.schema >= 2 || kind == Kind::Radiation),
                "invalid continuous field section {}",
                spawn.section
            );
            let power = if section.values.contains_key("max_start_power") {
                section.number("max_start_power")? as f32
            } else {
                spawn.start_power
            };
            let radius = section.number("effective_radius")? as f32;
            let attenuation = section.number("attenuation")? as f32;
            counts[kind as usize] += 1;
            let field = Field::new(
                spawn,
                manifest.schema,
                Pulse { kind, power },
                radius,
                attenuation,
            )?;
            // A stock Zaton heat field is centered below the CFORM AABB.
            // Its volume still reaches walkable ground inside the bounds.
            ensure!(
                field
                    .volumes
                    .iter()
                    .any(|volume| volume.overlaps(bounds.min, bounds.max)),
                "field {id} has no volume inside collision bounds"
            );
            fields.push(field);
        }
        let electras = manifest
            .reactive_mines
            .into_iter()
            .map(|spawn| {
                let id = spawn.spawn_id;
                ensure!(seen.insert(id), "duplicate reactive field spawn {id}");
                let mine = Electra::new(spawn, catalog)?;
                ensure!(
                    mine.volume.overlaps(bounds.min, bounds.max),
                    "Electra {id} outside collision bounds"
                );
                Ok(mine)
            })
            .collect::<Result<Vec<_>>>()?;
        if !electras.is_empty() {
            catalog
                .section("actor_immunities_gd_master")?
                .number(Kind::Shock.immunity())?;
        }
        let detector_zones = manifest.detector_zones
            .map(|spawns| RadarZones::load(spawns, collision, catalog).map(Arc::new)).transpose()?;
        tracing::info!(radiation=counts[0], acid=counts[1], heat=counts[2], psy=counts[3], electra=electras.len(),
            detector_zones = detector_zones.as_ref().map_or(0, |zones| zones.0.len()),
            spawn_sha256 = %manifest.spawn_sha256, "loaded original continuous fields");
        Ok(Self {
            fields,
            electras,
            detector_zones,
            factors: Factors::from_catalog(catalog)?,
        })
    }

    pub fn detector_zones(&self) -> Option<Arc<RadarZones>> {
        self.detector_zones.clone()
    }

    pub(crate) fn sample(&self, feet: Vector, height: f32) -> impl Iterator<Item = Pulse> + '_ {
        self.fields
            .iter()
            .filter_map(move |field| field.at(feet, height))
    }

    pub(crate) fn step_electras(
        &mut self,
        world: &crate::world::World,
        bolts: impl Iterator<Item = (u32, Vector)>,
        effects: &mut Vec<crate::combat::Detonation>,
        hits: &mut Vec<(u32, Pulse)>,
    ) {
        if self.electras.is_empty() {
            return;
        }
        let bolts: Vec<_> = bolts.collect();
        for mine in &mut self.electras {
            mine.step(world, &bolts, effects, hits);
        }
    }
}

impl Field {
    fn new(
        spawn: Spawn,
        schema: u32,
        pulse: Pulse,
        effective_radius: f32,
        attenuation: f32,
    ) -> Result<Self> {
        ensure!(
            (0.0..=100.0).contains(&pulse.power)
                && (0.0..=100.0).contains(&attenuation)
                && effective_radius.is_finite()
                && effective_radius > 0.0,
            "invalid field profile"
        );
        let shapes = match (schema, spawn.shape, spawn.shapes) {
            (1, Some(shape), shapes) if shapes.is_empty() => vec![shape],
            (2..=4, None, shapes) if (1..=16).contains(&shapes.len()) => shapes,
            _ => anyhow::bail!("invalid authored field shape count"),
        };
        let composite = if shapes.len() > 1 {
            // CCF_Shape supplies the union AABB center. CRadioactiveZone
            // takes its falloff radius from the first authored sphere.
            let Shape::Sphere { radius, .. } = shapes[0] else {
                anyhow::bail!("unsupported composite falloff");
            };
            let (min, max) = shapes
                .iter()
                .map(Shape::bounds)
                .reduce(|(a, b), (c, d)| (a.min(c), b.max(d)))
                .unwrap();
            let local = (min + max) * 0.5;
            let basis = rotation_basis(spawn.rotation);
            Some((
                Vector::from_array(spawn.position)
                    + basis[0] * local.x
                    + basis[1] * local.y
                    + basis[2] * local.z,
                radius,
            ))
        } else {
            None
        };
        let volumes = shapes
            .into_iter()
            .map(|shape| Volume::new(shape, spawn.position, spawn.rotation))
            .collect::<Result<Vec<_>>>()?;
        let (center, radius) = composite.unwrap_or((volumes[0].center, volumes[0].radius));
        let radius = radius * effective_radius;
        ensure!(
            center.is_finite() && (0.001..=2000.0).contains(&radius),
            "invalid field range"
        );
        Ok(Self {
            volumes,
            center,
            radius_squared: radius * radius,
            pulse: Pulse {
                power: pulse.power * PULSE_SECONDS,
                ..pulse
            },
            attenuation,
        })
    }

    fn at(&self, feet: Vector, height: f32) -> Option<Pulse> {
        let distance_squared = feet.distance_squared(self.center);
        if distance_squared > self.radius_squared
            || !self
                .volumes
                .iter()
                .any(|volume| volume.touches(feet, height))
        {
            return None;
        }
        let power = self.pulse.power
            * (1.0 - self.attenuation * distance_squared / self.radius_squared).max(0.0);
        (power > 0.0).then_some(Pulse {
            power,
            ..self.pulse
        })
    }
}

#[cfg(test)]
pub(crate) fn native_field_fixture() -> Fields {
    Fields {
        fields: [Kind::Heat,Kind::Radiation].into_iter().map(|kind|Field {
            volumes:vec![Volume::new(Shape::Sphere{center:[0.0;3],radius:10.0},[0.0;3],[0.0;3]).unwrap()],
            center:Vector::ZERO,radius_squared:100.0,pulse:Pulse{kind,power:0.2},attenuation:0.0,
        }).collect(),
        electras:Vec::new(),detector_zones:None,
        factors:Factors{immunity:[1.0;KIND_COUNT],health:1.0,power:1.0},
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn radar_selects_intersecting_supported_zones_and_keeps_authored_marker_positions() {
        let zone = |id, section: &str, x, radius| RadarZone {
            section: section.into(), position: [x, 0., 0.],
            center: Vector::new(x + 1., 0., 0.), radius, spawn_id: id,
        };
        let zones = RadarZones(vec![
            zone(2, "zone_b", 31., 2.),
            zone(4, "zone_b", 32., 2.),
            zone(3, "zone_b", 31., 2.),
            zone(1, "zone_a", 10., 2.),
        ]);
        let allowed = BTreeSet::from(["zone_b"]);
        assert_eq!(zones.nearest([0.; 3], 30., &allowed, 32).count(), 2);
        assert_eq!(zones.nearest([0.; 3], 30., &allowed, 1).collect::<Vec<_>>(),
            vec![("zone_b", [31., 0., 0.])]);
    }

    #[test]
    fn electra_wakes_on_bolt_contact_but_needs_a_live_target_to_deal_damage() {
        use crate::world::{Kind as ActorKind, SafeZone, Vec3, World};
        let mut world = World::new();
        world.safe_zones.clear();
        let mut mine = Electra {
            section: "zone_mine_electric_weak".into(),
            position: Vec3::default(),
            volume: Volume::new(
                Shape::Sphere {
                    center: [0.0; 3],
                    radius: 2.0,
                },
                [0.0; 3],
                [0.0; 3],
            )
            .unwrap(),
            power: 0.8,
            radius: 2.0,
            attenuation: 1.0,
            wake_ticks: 3,
            recover_ticks: 48,
            bolt_contact_ticks: 15,
            bolt_contacts: Default::default(),
            phase: ElectraPhase::Idle,
        };
        let mut effects = Vec::new();
        let mut hits = Vec::new();
        let bolt = [(9, Vector::ZERO)];
        for _ in 0..3 {
            mine.step(&world, &bolt, &mut effects, &mut hits);
            assert!(effects.is_empty());
            world.step();
        }
        mine.step(&world, &bolt, &mut effects, &mut hits);
        assert_eq!(effects.len(), 1);
        assert!(hits.is_empty());
        for _ in 0..55 {
            world.step();
            mine.step(&world, &bolt, &mut effects, &mut hits);
        }
        assert_eq!(effects.len(), 1, "a resting bolt stops activating the mine");
        let target = world.spawn(ActorKind::Player, Vec3::default());
        let safe = Vec3 {
            x: 1.0,
            ..Vec3::default()
        };
        world.spawn(ActorKind::Player, safe);
        world.safe_zones.push(SafeZone::sphere(safe, 0.25));
        for _ in 0..4 {
            world.step();
            mine.step(&world, &[], &mut effects, &mut hits);
        }
        assert_eq!(effects.len(), 2);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, target);
        assert_eq!(hits[0].1.kind, Kind::Shock);
        assert!((hits[0].1.power - 0.8).abs() < 1e-6);
    }

    #[test]
    fn falloff_uses_authored_radius_and_rotated_contact() {
        let spawn = |shape| Spawn {
            spawn_id: 0,
            section: "fixture".into(),
            position: [0.0; 3],
            rotation: [0.0, std::f32::consts::FRAC_PI_2, 0.0],
            shape: Some(shape),
            shapes: vec![],
            start_power: 0.0,
        };
        let pulse = Pulse {
            kind: Kind::Radiation,
            power: 0.02,
        };
        let sphere = Field::new(
            spawn(Shape::Sphere {
                center: [1.0, 0.0, 0.0],
                radius: 10.0,
            }),
            1,
            pulse,
            1.0,
            0.5,
        )
        .unwrap();
        assert!((sphere.at(Vector::new(5.0, 0.0, 1.0), 1.8).unwrap().power - 0.00175).abs() < 1e-7);
        assert!(sphere.at(Vector::new(0.0, 0.0, 12.0), 1.8).is_none());
        let cuboid = Field::new(
            spawn(Shape::Box {
                center: [0.0; 3],
                axes: [[8.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 2.0]],
            }),
            1,
            pulse,
            1.0,
            0.5,
        )
        .unwrap();
        assert!(cuboid.at(Vector::new(0.0, 0.0, 2.0), 1.8).is_some());
        assert!(cuboid.at(Vector::new(2.0, 0.0, 0.0), 1.8).is_none());
    }
}
