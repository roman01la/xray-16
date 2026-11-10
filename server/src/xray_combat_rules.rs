//! The same gameplay kernels compiled into X-Ray and the Rust server.
use parry3d::math::Vector;

unsafe extern "C" {
    fn zone_field_damage(kind: u32, values: *const f32, result: *mut f32);
    fn zone_weapon_misfire(
        legacy: bool,
        condition: f32,
        first: f32,
        second: f32,
        start_p: f32,
        end_p: f32,
    ) -> f32;
    fn zone_select_reload_ammo(available: *const u8, count: u32, selected: u32, next: bool, locked: bool) -> u32;
    fn zone_reload_changes_type(locked: bool, loaded: bool, has_ammo: bool, same_type: bool) -> bool;
    fn zone_tube_reload_after_animation(phase: u32, insertion_failed: bool) -> u32;
    fn zone_weapon_condition_dispersion(condition: f32, factor: f32) -> f32;
    fn zone_trajectory(velocity: *const f32, gravity: f32, drag: f32, seconds: f32, result: *mut f32);
    fn zone_bullet_armour_power(
        power: f32,
        penetration: f32,
        armour: f32,
        fraction: f32,
        protection: f32,
        wound: *mut bool,
    ) -> f32;
    fn zone_density_speed(speed: f32, distance: f32, density: f32) -> f32;
    fn zone_surface_response(values: *const f32, flags: u32, result: *mut f32) -> u32;
    fn zone_satiety_health_factor(satiety: f32, critical: f32) -> f32;
    fn zone_movement_power_cost(base: f32, weight_power: f32, weight: f32, overweight: f32) -> f32;
    fn zone_movement_restrictions(
        power: f32,
        health: f32,
        thresholds: *const f32,
        previous: u32,
    ) -> u32;
    fn zone_add_wound_hit(size: f32, power: f32) -> f32;
    fn zone_heal_wound(sizes: *mut f32, count: u32, amount: f32, minimum: f32) -> bool;
}

pub(crate) fn legacy_misfire(condition: f32, probability: f32, condition_factor: f32) -> f32 {
    unsafe { zone_weapon_misfire(true, condition, probability, condition_factor, 0.0, 0.0) }
}

pub(crate) fn misfire(condition: f32, start: f32, end: f32, start_p: f32, end_p: f32) -> f32 {
    unsafe { zone_weapon_misfire(false, condition, start, end, start_p, end_p) }
}

pub(crate) fn select_reload_ammo(available: &[u8], selected: usize, next: bool, locked: bool) -> Option<usize> {
    let count = u32::try_from(available.len()).ok()?;
    let selected = u32::try_from(selected).ok()?;
    // The native routine reads only indices below count, and retains no pointer.
    let result = unsafe { zone_select_reload_ammo(available.as_ptr(), count, selected, next, locked) };
    (result < count).then_some(result as usize)
}

pub(crate) fn reload_changes_type(locked: bool, loaded: bool, has_ammo: bool, same_type: bool) -> bool {
    unsafe { zone_reload_changes_type(locked, loaded, has_ammo, same_type) }
}

pub(crate) fn tube_reload_after_animation(phase: u32, insertion_failed: bool) -> u32 {
    unsafe { zone_tube_reload_after_animation(phase, insertion_failed) }
}

pub(crate) fn weapon_condition_dispersion(condition: f32, factor: f32) -> f32 {
    unsafe { zone_weapon_condition_dispersion(condition, factor) }
}

pub(crate) fn trajectory(velocity: Vector, gravity: f32, drag: f32, seconds: f32) -> (Vector, Vector) {
    let velocity = velocity.to_array();
    let mut result = [0.0; 6];
    // Three input components and six output components, with no retained pointers.
    unsafe { zone_trajectory(velocity.as_ptr(), gravity, drag, seconds, result.as_mut_ptr()); }
    let [x, y, z, vx, vy, vz] = result;
    (Vector::new(x, y, z), Vector::new(vx, vy, vz))
}

pub(crate) fn bullet_armour_power(
    power: f32,
    penetration: f32,
    armour: f32,
    fraction: f32,
    protection: f32,
    wound: &mut bool,
) -> f32 {
    unsafe { zone_bullet_armour_power(power, penetration, armour, fraction, protection, wound) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfaceAction { Transparent, Magnetic, Ricochet, Stop, Penetrate }

pub(crate) fn density_speed(speed: f32, distance: f32, density: f32) -> f32 {
    unsafe { zone_density_speed(speed, distance, density) }
}

pub(crate) fn surface_response(values: [f32; 9], magnetic: bool, ricochet: bool, material_ricochet: bool)
    -> (SurfaceAction, f32, f32)
{
    let flags = u32::from(magnetic) | (u32::from(ricochet) << 1) | (u32::from(material_ricochet) << 2);
    let mut result = [0.0; 2];
    // Nine immutable inputs and two output scalars; no pointers are retained.
    let kind = unsafe { zone_surface_response(values.as_ptr(), flags, result.as_mut_ptr()) };
    let action = match kind {
        0 => SurfaceAction::Transparent, 1 => SurfaceAction::Magnetic,
        2 => SurfaceAction::Ricochet, 3 => SurfaceAction::Stop, 4 => SurfaceAction::Penetrate,
        _ => unreachable!("unknown native material response"),
    };
    (action, result[0], result[1])
}

pub(crate) fn satiety_health_factor(satiety: f32, critical: f32) -> f32 {
    unsafe { zone_satiety_health_factor(satiety, critical) }
}

pub(crate) fn movement_power_cost(
    base: f32,
    weight_power: f32,
    weight: f32,
    overweight: f32,
) -> f32 {
    unsafe { zone_movement_power_cost(base, weight_power, weight, overweight) }
}

pub(crate) fn movement_restrictions(
    power: f32,
    health: f32,
    thresholds: [f32; 8],
    previous: [bool; 3],
) -> [bool; 3] {
    let [sprint, walk, limp] = previous.map(u32::from);
    // The engine reads eight thresholds in the order of the packed state.
    let flags = unsafe {
        zone_movement_restrictions(
            power,
            health,
            thresholds.as_ptr(),
            sprint | (walk << 1) | (limp << 2),
        )
    };
    [flags & 1 != 0, flags & 2 != 0, flags & 4 != 0]
}

pub(crate) fn add_wound_hit(size: f32, power: f32) -> f32 {
    unsafe { zone_add_wound_hit(size, power) }
}

pub(crate) fn heal_wound(sizes: &mut [f32; 12], amount: f32, minimum: f32) -> bool {
    // The stock routine modifies exactly the twelve entries passed by the caller.
    unsafe { zone_heal_wound(sizes.as_mut_ptr(), 12, amount, minimum) }
}

#[cfg(test)]
mod reload_tests {
    use super::*;

    #[test]
    fn stock_reload_selection_respects_selected_locked_and_cycle_order() {
        assert_eq!(select_reload_ammo(&[1, 1, 1], 2, false, false), Some(2));
        assert_eq!(select_reload_ammo(&[1, 1, 0], 2, false, false), Some(0));
        assert_eq!(select_reload_ammo(&[1, 1, 0], 2, false, true), None);
        assert_eq!(select_reload_ammo(&[1, 0, 1], 2, true, false), Some(0));
        assert_eq!(select_reload_ammo(&[1, 0, 1], 0, true, false), Some(2));
        assert_eq!(select_reload_ammo(&[0, 1, 0], 1, true, false), None);
        assert_eq!(select_reload_ammo(&[0, 0], 0, false, false), None);
        assert_eq!(select_reload_ammo(&[], 0, false, false), None);
        assert_eq!(select_reload_ammo(&[1], 4, false, false), None);
    }

    #[test]
    fn magazine_type_switch_preserves_locked_or_empty_magazines() {
        assert!(reload_changes_type(false, true, true, false));
        assert!(!reload_changes_type(false, true, true, true));
        assert!(!reload_changes_type(true, true, true, false));
        assert!(!reload_changes_type(false, false, true, false));
        // Stock unlimited ammunition has no box pointer and still unloads.
        assert!(reload_changes_type(false, true, false, true));
    }
}

pub(crate) fn field_damage(kind: crate::environment::Kind, values: [f32; 7]) -> [f32; 4] {
    use crate::environment::Kind;
    let kind = match kind {
        Kind::Radiation => 0, Kind::Acid => 1, Kind::Heat => 2, Kind::Psy => 3, Kind::Shock => 4,
    };
    let mut result = [0.0; 4];
    unsafe { zone_field_damage(kind, values.as_ptr(), result.as_mut_ptr()) };
    result
}

#[cfg(test)]
mod field_tests {
    use super::*;
    use crate::environment::Kind;

    fn close(actual: [f32; 4], expected: [f32; 4]) {
        for (a, b) in actual.into_iter().zip(expected) {
            assert!((a - b).abs() < 0.000001, "{actual:?} != {expected:?}");
        }
    }

    #[test]
    fn stock_fields_preserve_protection_order_bone_scaling_and_condition_channels() {
        // Protection precedes immunity; only heat scales health by the hit bone.
        let values = [0.8, 0.2, 0.5, 0.1, 0.75, 0.25, 2.0];
        close(field_damage(Kind::Radiation, values), [0.0, 0.0, 0.24, 0.0]);
        close(field_damage(Kind::Acid, values), [0.18, 0.06, 0.0, 0.0]);
        close(field_damage(Kind::Psy, values), [0.18, 0.06, 0.0, 0.24]);
        close(field_damage(Kind::Heat, values), [0.48, 0.08, 0.0, 0.0]);
        close(field_damage(Kind::Shock, values), [0.24, 0.08, 0.0, 0.0]);
    }

    #[test]
    fn stock_fields_absorb_fully_and_preserve_signed_immunity_boosters() {
        for kind in [Kind::Radiation, Kind::Acid, Kind::Psy] {
            close(field_damage(kind, [0.1, 0.2, 0.5, 0.0, 1.0, 1.0, 1.0]), [0.0; 4]);
        }
        close(field_damage(Kind::Psy, [0.5, 0.0, 0.2, 0.4, 1.0, 0.5, 1.0]),
            [-0.1, -0.05, 0.0, -0.1]);
    }
}
