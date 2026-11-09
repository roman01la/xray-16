//! Durable campaign visit authority. A transport session may act for one visit.
use crate::{
    authored_shape::{Shape, Volume},
    inventory::Context,
    session::{SessionConfig, campaign_level},
    survival::{Location, Record},
};
use anyhow::{Context as _, Result, ensure};
use parry3d::math::Vector;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};

pub(crate) const SCHEMA: &str = "
ALTER TABLE inventory_characters ADD COLUMN campaign_world TEXT;
ALTER TABLE inventory_characters ADD COLUMN campaign_visit INTEGER NOT NULL DEFAULT 0
    CHECK(campaign_visit BETWEEN 0 AND 4294967295);
PRAGMA user_version=14;";
pub(crate) const LIFT_SCHEMA: &str = "
ALTER TABLE runtime_meta ADD COLUMN lab_lift_powered INTEGER NOT NULL DEFAULT 0
    CHECK(lab_lift_powered IN (0,1));
PRAGMA user_version=15;";

const PRIPYAT: &str = "pripyat-static-v1";
const LAB_X8: &str = "labx8-static-v1";
const ACCESS_CARD: &str = "zat_a23_labx8_key";

#[derive(Debug, Serialize)]
pub(crate) struct Visit {
    pub world: String,
    pub visit: u32,
}

/// Only the simulation builds this after checking contact with an approved
/// route and validating the arrival against the destination collision.
#[derive(Clone)]
pub struct Handoff {
    pub(crate) request_id: String,
    pub(crate) route: u16,
    pub(crate) before: Record,
    pub(crate) arrival: Location,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Approval {
    schema: u32,
    spawn_sha256: String,
    routes: Vec<u16>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Export {
    schema: u32,
    spawn_sha256: String,
    routes: Vec<Placement>,
    generator: Option<GeneratorPlacement>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    spawn_id: u16,
    name: String,
    level: String,
    enabled: bool,
    silent: bool,
    story_id: u32,
    spawn_story_id: u32,
    parent: u16,
    custom_data_length: u16,
    ini: String,
    position: [f32; 3],
    rotation: [f32; 3],
    shapes: Vec<Shape>,
    destination: Destination,
    entry: Option<UnderpassExit>,
    lift_button: Option<LiftButton>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiftButton {
    spawn_id: u16,
    position: [f32; 3],
    rotation: [f32; 3],
    model_center: [f32; 3],
    model_sha256: String,
    control_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratorPlacement {
    spawn_id: u16,
    position: [f32; 3],
    rotation: [f32; 3],
    control_sha256: String,
    shapes: Vec<Shape>,
    restrictor_type: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnderpassExit {
    spawn_id: u16,
    name: String,
    control_sha256: String,
    restrictor_type: u8,
    position: [f32; 3],
    rotation: [f32; 3],
    shapes: Vec<Shape>,
}

#[derive(Deserialize)]
struct Destination {
    level: String,
    position: [f32; 3],
    rotation: [f32; 3],
}

struct Route {
    world: String,
    geometry: String,
    volumes: Vec<Volume>,
    arrival: Location,
    lift_button: Option<[f32; 3]>,
}

struct Generator {
    position: [f32; 3],
    volumes: Vec<Volume>,
}

pub enum Interaction {
    Generator,
    Lift(u16),
}

/// Only explicitly approved routes for the running region set are usable.
pub struct Routes {
    routes: BTreeMap<u16, Route>,
    generator: Option<Generator>,
}

impl Routes {
    pub fn load(export: &Path, approvals: &Path, sessions: &[&SessionConfig]) -> Result<Self> {
        ensure!(
            fs::metadata(export)?.len() <= 256 * 1024
                && fs::metadata(approvals)?.len() <= 16 * 1024,
            "oversized campaign route input"
        );
        let export: Export = serde_json::from_slice(&fs::read(export)?)?;
        let approvals: Approval = serde_json::from_slice(&fs::read(approvals)?)?;
        ensure!(
            export.schema == 1
                && approvals.schema == 1
                && approvals.spawn_sha256 == export.spawn_sha256
                && is_digest(&export.spawn_sha256),
            "campaign route provenance mismatch"
        );
        ensure!(
            (1..=128).contains(&export.routes.len()),
            "invalid campaign route count"
        );
        let approved: BTreeSet<_> = approvals.routes.iter().copied().collect();
        ensure!(
            !approved.is_empty() && approved.len() == approvals.routes.len(),
            "empty or duplicate campaign route approvals"
        );
        let mut seen = BTreeSet::new();
        let mut routes = BTreeMap::new();
        for placement in export.routes {
            let id = placement.spawn_id;
            ensure!(seen.insert(id), "duplicate campaign route {id}");
            if !approved.contains(&id) {
                continue;
            }
            let route = Route::from_placement(placement, sessions)
                .with_context(|| format!("invalid approved campaign route {id}"))?;
            routes.insert(id, route);
        }
        ensure!(
            routes.len() == approved.len(),
            "approved campaign route missing from export"
        );
        let generator = if routes
            .values()
            .any(|route| route.world == PRIPYAT && route.lift_button.is_some())
        {
            let placement = export
                .generator
                .context("missing authored lift generator")?;
            let collision = sessions
                .iter()
                .find(|session| session.contract.world == PRIPYAT)
                .and_then(|session| session.collision())
                .context("missing Pripyat collision")?;
            let bounds = &collision.manifest.bounds;
            ensure!(
                placement.spawn_id == 5235
                    && placement.restrictor_type == 3
                    && is_digest(&placement.control_sha256)
                    && (1..=16).contains(&placement.shapes.len())
                    && (0..3)
                        .all(|i| (bounds.min[i]..=bounds.max[i]).contains(&placement.position[i])),
                "invalid authored lift generator"
            );
            let volumes = placement
                .shapes
                .into_iter()
                .map(|shape| Volume::new(shape, placement.position, placement.rotation))
                .collect::<Result<Vec<_>>>()?;
            Some(Generator {
                position: placement.position,
                volumes,
            })
        } else {
            None
        };
        Ok(Self { routes, generator })
    }

    pub fn prepare(
        &self,
        context: &Context,
        route: u16,
        request_id: String,
        before: Record,
        combat_until_ms: i64,
        use_button: bool,
    ) -> Option<Handoff> {
        let route_data = self.routes.get(&route)?;
        let height = context.eye_height + 0.25;
        let feet = Vector::from_array(context.position.map(|n| n as f32));
        if context.world != route_data.world
            || !(1.2..=1.8).contains(&height)
            || !feet.is_finite()
            || context
                .collision
                .as_ref()
                .is_none_or(|map| map.manifest.sha256 != route_data.geometry)
            || if use_button {
                !route_data.button_near(context).ok()?
            } else {
                !route_data.touches(feet, height)
            }
        {
            return None;
        }
        let mut arrival = route_data.arrival.clone();
        arrival.combat_until_ms = combat_until_ms;
        Some(Handoff {
            request_id,
            route,
            before,
            arrival,
        })
    }

    pub fn touching(&self, world: &str, feet: [f32; 3], height: f32) -> Option<u16> {
        let feet = Vector::from_array(feet);
        let mut matches = self.routes.iter().filter_map(|(&id, route)| {
            (route.world == world && route.touches(feet, height)).then_some(id)
        });
        let route = matches.next()?;
        // Some original routes overlap and are selected by campaign scripts.
        matches.next().is_none().then_some(route)
    }

    pub fn use_at(&self, context: &Context) -> Result<Option<Interaction>> {
        if context.world == PRIPYAT
            && let Some(generator) = &self.generator
        {
            let feet = Vector::from_array(context.position.map(|n| n as f32));
            let height = context.eye_height + 0.25;
            if generator
                .volumes
                .iter()
                .any(|volume| volume.touches(feet, height))
                && crate::inventory::interaction_near(
                    context,
                    generator.position.map(f64::from),
                    0.,
                )?
            {
                return Ok(Some(Interaction::Generator));
            }
        }
        for (&id, route) in &self.routes {
            if route.world == context.world && route.button_near(context)? {
                return Ok(Some(Interaction::Lift(id)));
            }
        }
        Ok(None)
    }

    pub fn interaction_points(&self, world: &str) -> Vec<(&'static str, [f32; 3])> {
        let mut points = Vec::new();
        if world == PRIPYAT
            && let Some(generator) = &self.generator
        {
            points.push(("generator", generator.position));
        }
        points.extend(
            self.routes
                .values()
                .filter(|route| route.world == world)
                .filter_map(|route| route.lift_button.map(|position| ("lift", position))),
        );
        points
    }
}

impl Route {
    fn touches(&self, feet: Vector, height: f32) -> bool {
        self.lift_button.is_none()
            && self
                .volumes
                .iter()
                .any(|volume| volume.touches(feet, height))
    }

    fn button_near(&self, context: &Context) -> Result<bool> {
        let Some(position) = self.lift_button else {
            return Ok(false);
        };
        crate::inventory::interaction_near(context, position.map(f64::from), 0.)
    }

    fn from_placement(placement: Placement, sessions: &[&SessionConfig]) -> Result<Self> {
        ensure!(
            placement.enabled
                && placement.silent
                && placement.story_id == u32::MAX
                && placement.spawn_story_id == u32::MAX
                && placement.parent == u16::MAX
                && placement.custom_data_length == 0
                && placement.ini.trim().is_empty()
                && (1..=16).contains(&placement.shapes.len()),
            "route has scripted state or invalid shapes"
        );
        ensure!(
            placement.level != placement.destination.level,
            "route must change maps"
        );
        let session = |level: &str| {
            sessions
                .iter()
                .find(|session| campaign_level(&session.contract.world) == Some(level))
                .context("route references an unavailable map")
        };
        let source = session(&placement.level)?;
        let target = session(&placement.destination.level)?;
        let source_map = source.collision().context("source map has no geometry")?;
        let target_map = target.collision().context("target map has no geometry")?;
        let underpass_exit =
            placement.level == "jupiter_underground" && placement.destination.level == "pripyat";
        let (shapes, position, rotation) = match placement.entry {
            Some(entry) if underpass_exit => {
                ensure!(
                    placement.name == "pas_b400_level_changer"
                        && entry.name == "pas_b400_sr_exit"
                        && entry.spawn_id != placement.spawn_id
                        && entry.restrictor_type == 3
                        && is_digest(&entry.control_sha256)
                        && (1..=16).contains(&entry.shapes.len()),
                    "invalid authored underpass exit"
                );
                // The original controller moves the player from this zone to
                // the level changer. Persist the same destination directly.
                (entry.shapes, entry.position, entry.rotation)
            }
            None if !underpass_exit => (placement.shapes, placement.position, placement.rotation),
            _ => anyhow::bail!("unexpected or missing scripted route entry"),
        };
        let volumes = shapes
            .into_iter()
            .map(|shape| Volume::new(shape, position, rotation))
            .collect::<Result<Vec<_>>>()?;
        let bounds = &source_map.manifest.bounds;
        let lift_button = match (
            source.contract.world.as_str(),
            target.contract.world.as_str(),
            placement.lift_button,
        ) {
            (PRIPYAT, LAB_X8, Some(button)) | (LAB_X8, PRIPYAT, Some(button)) => {
                let expected_id = if source.contract.world == PRIPYAT {
                    4663
                } else {
                    5935
                };
                ensure!(
                    button.spawn_id == expected_id
                        && is_digest(&button.control_sha256)
                        && is_digest(&button.model_sha256)
                        && button
                            .model_center
                            .iter()
                            .all(|value| (-1.0..=1.0).contains(value))
                        && button.rotation.iter().all(|value| value.is_finite())
                        && (0..3)
                            .all(|i| (bounds.min[i]..=bounds.max[i]).contains(&button.position[i])),
                    "invalid authored lift button"
                );
                // The pivot can be inside the wall. Aim at the stock model's
                // bounds center so a normal wall ray can still gate Use.
                let axes = crate::collision::rotation_basis(button.rotation);
                let [x, y, z] = button.model_center;
                Some(
                    (Vector::from_array(button.position) + axes[0] * x + axes[1] * y + axes[2] * z)
                        .to_array(),
                )
            }
            (PRIPYAT, LAB_X8, None) | (LAB_X8, PRIPYAT, None) => {
                anyhow::bail!("missing authored lift button")
            }
            (_, _, Some(_)) => anyhow::bail!("unexpected lift button"),
            _ => None,
        };
        ensure!(
            volumes
                .iter()
                .all(|volume| volume.overlaps(bounds.min, bounds.max)),
            "route volume outside source map"
        );
        let [x, y, z] = placement.destination.position;
        let feet = target_map.spawn_feet_near(x, y + 0.1, z)?;
        let yaw = placement.destination.rotation[1].rem_euclid(std::f32::consts::TAU);
        ensure!(yaw.is_finite(), "invalid arrival rotation");
        Ok(Self {
            world: source.contract.world.clone(),
            geometry: source_map.manifest.sha256.clone(),
            volumes,
            lift_button,
            arrival: Location {
                world: target.contract.world.clone(),
                content_revision: target.contract.content_revision.clone(),
                position: feet.to_array(),
                yaw,
                crouched: false,
                combat_until_ms: 0,
                logout_until_ms: 0,
            },
        })
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(crate) fn authority(tx: &Transaction<'_>, principal: &str) -> Result<Option<Visit>> {
    let row: Option<(Option<String>, u32)> = tx
        .prepare_cached(
            "SELECT coalesce(campaign_world,json_extract(location,'$.world')),campaign_visit
         FROM inventory_characters WHERE principal=?1",
        )?
        .query_row([principal], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    Ok(row.and_then(|(world, visit)| {
        world
            .filter(|world| campaign_level(world).is_some())
            .map(|world| Visit { world, visit })
    }))
}

pub(crate) fn bind(tx: &Transaction<'_>, context: &Context) -> Result<()> {
    if let Some(level) = campaign_level(&context.world) {
        ensure!(
            context
                .collision
                .as_ref()
                .is_some_and(|map| map.manifest.level == level),
            "campaign authority requires the active map collision"
        );
        tx.execute(
            "UPDATE inventory_characters SET campaign_world=?2
             WHERE principal=?1 AND campaign_world IS NULL",
            params![context.principal, context.world],
        )?;
    }
    Ok(())
}

pub(crate) fn power_lift(tx: &Transaction<'_>, context: &Context) -> Result<Value> {
    ensure!(
        context.world == PRIPYAT,
        "lift generator requires Pripyat authority"
    );
    let alive: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM inventory_characters WHERE principal=?1 AND life=?2 AND alive=1)",
        params![context.principal, context.life], |row| row.get(0),
    )?;
    if !alive {
        return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"}));
    }
    let changed = tx.execute(
        "UPDATE runtime_meta SET lab_lift_powered=1 WHERE id=1 AND lab_lift_powered=0",
        [],
    )?;
    Ok(json!({"status":if changed == 1 { "powered" } else { "already_powered" }}))
}

pub(crate) fn commit(tx: &Transaction<'_>, context: &Context, handoff: Handoff) -> Result<Value> {
    let Handoff {
        request_id,
        route,
        before,
        arrival,
    } = handoff;
    crate::persistence::validate_request_id(&request_id)?;
    ensure!(
        campaign_level(&context.world).is_some_and(|level| {
            context
                .collision
                .as_ref()
                .is_some_and(|map| map.manifest.level == level)
        }) && campaign_level(&arrival.world).is_some()
            && context.world != arrival.world,
        "invalid campaign route worlds"
    );
    ensure!(
        arrival.position.iter().all(|v| v.is_finite())
            && arrival.yaw.is_finite()
            && arrival.logout_until_ms == 0
            && arrival.combat_until_ms >= 0
            && is_digest(&arrival.content_revision),
        "invalid campaign arrival"
    );
    let principal = &context.principal;
    // Source visit disambiguates two later uses of the same authored route.
    let request = format!(
        "campaign-travel-v1\n{}\n{}\n{}\n{}\n{route}",
        context.world, context.visit, context.life, arrival.world
    );
    let current = authority(tx, principal)?;
    let previous: Option<(String, String)> = tx
        .prepare_cached(
            "SELECT request,response FROM outcomes WHERE principal=?1 AND request_id=?2",
        )?
        .query_row(params![principal, request_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    if let Some((original, response)) = previous {
        if original != request {
            return Ok(json!({"error":"request id reused with different payload"}));
        }
        return Ok(serde_json::from_str(&response)?);
    }
    let Some(current) =
        current.filter(|visit| visit.world == context.world && visit.visit == context.visit)
    else {
        return Ok(json!({"status":"rejected","reason":"stale_visit"}));
    };
    if !(0.0 < before.state.health && before.state.health <= 1.0) {
        return Ok(json!({"status":"rejected","reason":"stale_or_dead_life"}));
    }
    if matches!(
        (context.world.as_str(), arrival.world.as_str()),
        (PRIPYAT, LAB_X8) | (LAB_X8, PRIPYAT)
    ) {
        if context.world == PRIPYAT
            && !tx.query_row(
                "SELECT lab_lift_powered FROM runtime_meta WHERE id=1",
                [],
                |row| row.get::<_, bool>(0),
            )?
        {
            return Ok(json!({"status":"rejected","reason":"lift_unpowered"}));
        }
        let has_card: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM inventory_items i JOIN item_containers c ON i.container=c.id
             WHERE c.kind='carried' AND c.owner=?1 AND i.section=?2)",
            params![principal, ACCESS_CARD], |row| row.get(0),
        )?;
        if !has_card {
            return Ok(json!({"status":"rejected","reason":"access_card_required"}));
        }
    }
    let count: u32 = tx
        .prepare_cached("SELECT count(*) FROM outcomes WHERE principal=?1")?
        .query_row([principal], |row| row.get(0))?;
    if count >= 10_000 {
        return Ok(json!({"error":"request ledger full"}));
    }
    let visit = current
        .visit
        .checked_add(1)
        .context("campaign visit exhausted")?;
    let revision = before
        .revision
        .checked_add(1)
        .context("condition revision exhausted")?;
    let changed = tx.execute(
        "UPDATE inventory_characters
         SET campaign_world=?1,campaign_visit=?2,location=?3,condition=?4,condition_revision=?5
         WHERE principal=?6 AND life=?7 AND alive=1 AND condition_revision=?8 AND campaign_visit=?9",
        params![arrival.world, visit, serde_json::to_string(&arrival)?, serde_json::to_string(&before.state)?,
            revision, principal, context.life, before.revision, context.visit],
    )?;
    if changed == 0 {
        return Ok(json!({"status":"rejected","reason":"stale_condition_or_life"}));
    }
    let result =
        json!({"status":"committed","world":arrival.world,"visit":visit,"life":context.life});
    tx.execute(
        "INSERT INTO outcomes(principal,request_id,request,response) VALUES(?1,?2,?3,?4)",
        params![
            principal,
            request_id,
            request,
            serde_json::to_string(&result)?
        ],
    )?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_routes_require_an_unambiguous_contact_in_the_current_map() {
        let route = |world: &str, x: f32| Route {
            world: world.into(),
            geometry: String::new(),
            lift_button: None,
            volumes: vec![
                Volume::new(
                    Shape::Sphere {
                        center: [0., 0., 0.],
                        radius: 2.,
                    },
                    [x, 1., 0.],
                    [0., 0., 0.],
                )
                .unwrap(),
            ],
            arrival: Location {
                world: "labx8-static-v1".into(),
                content_revision: String::new(),
                position: [0.; 3],
                yaw: 0.,
                crouched: false,
                combat_until_ms: 0,
                logout_until_ms: 0,
            },
        };
        let routes = Routes {
            routes: BTreeMap::from([
                (1, route("zaton-static-v1", 0.)),
                (2, route("zaton-static-v1", 3.)),
                (3, route("jupiter-static-v1", 0.)),
            ]),
            generator: None,
        };
        assert_eq!(routes.touching("zaton-static-v1", [0.; 3], 1.8), Some(1));
        assert_eq!(routes.touching("zaton-static-v1", [1.5, 0., 0.], 1.8), None);
        assert_eq!(
            routes.touching("jupiter-static-v1", [1.5, 0., 0.], 1.8),
            Some(3)
        );
    }
}
