#include "CombatRules.h"

extern "C" float zone_weapon_misfire(
    bool legacy, float condition, float first, float second, float startProbability, float endProbability)
{
    if (legacy)
        return xray::combat::legacyMisfire(condition, first, second);
    return xray::combat::misfire(condition, first, second, startProbability, endProbability);
}

extern "C" unsigned zone_select_reload_ammo(const unsigned char* available, unsigned count,
    unsigned selected, bool next, bool locked)
{
    return xray::combat::selectReloadAmmo(count, selected, next, locked,
        [&](unsigned candidate) { return available[candidate] != 0; });
}

extern "C" bool zone_reload_changes_type(bool locked, bool loaded, bool hasAmmo, bool sameType)
{
    return xray::combat::reloadChangesType(locked, loaded, hasAmmo, sameType);
}

extern "C" unsigned zone_tube_reload_after_animation(unsigned phase, bool insertionFailed)
{
    return static_cast<unsigned>(xray::combat::tubeReloadAfterAnimation(
        static_cast<xray::combat::TubeReloadPhase>(phase), insertionFailed));
}

extern "C" float zone_weapon_condition_dispersion(float condition, float factor)
{
    return xray::combat::conditionDispersion(condition, factor);
}

extern "C" void zone_trajectory(const float* velocity, float gravity, float drag, float seconds, float* result)
{
    const bool vertical = velocity[0] * velocity[0] + velocity[2] * velocity[2] < .0000001f;
    for (unsigned axis = 0; axis < 3; ++axis)
    {
        const float g = axis == 1 ? -gravity : 0.f;
        result[axis] = xray::combat::trajectoryPosition(0.f, velocity[axis], g, drag, seconds, vertical, .1f);
        result[axis + 3] = xray::combat::trajectoryVelocity(velocity[axis], g, drag, seconds, vertical, .1f);
    }
}

extern "C" float zone_bullet_armour_power(float power, float penetration, float armour, float fraction,
    float protection, bool* wound)
{
    return xray::combat::bulletArmourPower(power, penetration, armour, fraction, protection, true, *wound);
}

extern "C" float zone_density_speed(float speed, float distance, float density)
{
    return xray::combat::densitySpeed(speed, distance, density);
}

extern "C" unsigned zone_surface_response(const float* values, unsigned flags, float* result)
{
    const auto response = xray::combat::surfaceResponse(values[0], values[1], values[2],
        flags & 1, flags & 2, flags & 4, values[3], values[4], values[5], values[6], values[7], values[8]);
    result[0] = response.speedScale;
    result[1] = response.penetration;
    return static_cast<unsigned>(response.action);
}

extern "C" float zone_satiety_health_factor(float satiety, float critical)
{
    return xray::combat::satietyHealthFactor(satiety, critical);
}

extern "C" float zone_movement_power_cost(float base, float weightPower, float weight, float overweight)
{
    return xray::combat::movementPowerCost(base, weightPower, weight, overweight);
}

extern "C" unsigned zone_movement_restrictions(float power, float health, const float* thresholds, unsigned previous)
{
    const bool sprint = xray::combat::conditionRestricted(power, thresholds[0], thresholds[1], previous & 1);
    const bool walk = xray::combat::conditionRestricted(power, thresholds[2], thresholds[3], previous & 2);
    const bool limp = xray::combat::conditionLimping(power, health, thresholds[4], thresholds[5],
        thresholds[6], thresholds[7], previous & 4);
    return unsigned(sprint) | (unsigned(walk) << 1) | (unsigned(limp) << 2);
}

extern "C" float zone_add_wound_hit(float size, float power)
{
    return xray::combat::addWoundHit(size, power);
}

extern "C" bool zone_heal_wound(float* sizes, unsigned count, float amount, float minimum)
{
    return xray::combat::healWound(sizes, count, amount, minimum, 0.0000001f);
}

extern "C" void zone_field_damage(unsigned kind, const float* values, float* result)
{
    const auto damage = xray::combat::fieldDamage(static_cast<xray::combat::FieldHit>(kind),
        values[0], values[1], values[2], values[3], values[4], values[5], values[6]);
    result[0] = damage.health; result[1] = damage.power;
    result[2] = damage.radiation; result[3] = damage.psy;
}
