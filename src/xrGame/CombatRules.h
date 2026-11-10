#pragma once

#include <algorithm>
#include <cmath>

namespace xray::combat
{
struct FireRules
{
    int mode;
    bool legacyMisfire;
    float openingInterval, sustainedInterval, firstWear, followupWear;
    float misfire[4];
    float hitPower, hitImpulse;
    bool suppressed;
    float range, speed, openingSpeed, dragFactor;
    unsigned openingRounds;
    float dispersion[8];
};

inline float conditionDispersion(float condition, float factor)
{
    return 1.f + factor * (1.f - condition);
}

inline float shotInterval(int mode, bool cycleDown, unsigned index, float normal, float alternate)
{
    return mode == 2 || (cycleDown && index < 2) ? alternate : normal;
}

inline float legacyMisfire(float condition, float probability, float conditionFactor)
{
    if (condition > .95f)
        return 0.f;
    return std::clamp(probability + std::pow(1.f - condition, 3.f) * conditionFactor, 0.f, .99f);
}

inline float misfire(float condition, float start, float end, float startProbability, float endProbability)
{
    if (condition > start)
        return 0.f;
    if (condition < end)
        return endProbability;
    const float span = start == end ? start : start - end;
    if (span == 0.f)
        return 0.f;
    return std::clamp(startProbability + (start - condition) * (endProbability - startProbability) / span, 0.f, .99f);
}

// Return count when no compatible inventory box exists. The callback is the
// engine inventory lookup, or a transaction-local snapshot in the server.
template <typename Available>
unsigned selectReloadAmmo(unsigned count, unsigned selected, bool next, bool locked, Available available)
{
    if (!count || selected >= count)
        return count;
    if (next)
    {
        for (unsigned offset = 1; offset < count; ++offset)
        {
            const unsigned candidate = (selected + offset) % count;
            if (available(candidate))
                return candidate;
        }
        return count;
    }
    if (available(selected))
        return selected;
    if (!locked)
        for (unsigned candidate = 0; candidate < count; ++candidate)
            if (candidate != selected && available(candidate))
                return candidate;
    return count;
}

inline bool reloadChangesType(bool locked, bool loaded, bool hasAmmo, bool sameType)
{
    return !locked && loaded && (!hasAmmo || !sameType);
}

enum class TubeReloadPhase : unsigned { Open, Insert, Close, Complete };

inline TubeReloadPhase tubeReloadAfterAnimation(TubeReloadPhase phase, bool insertionFailed)
{
    switch (phase)
    {
    case TubeReloadPhase::Open: return TubeReloadPhase::Insert;
    case TubeReloadPhase::Insert: return insertionFailed ? TubeReloadPhase::Close : TubeReloadPhase::Insert;
    case TubeReloadPhase::Close: return TubeReloadPhase::Complete;
    case TubeReloadPhase::Complete: return TubeReloadPhase::Complete;
    }
    return TubeReloadPhase::Complete;
}

inline bool tubeReloadCanInterrupt(TubeReloadPhase phase)
{
    return phase == TubeReloadPhase::Insert;
}

inline float flightDisplacement(float velocity, float gravity, float drag, float time)
{
    const float halfTimeSquared = time * time * .5f;
    return velocity * time + (gravity - velocity * drag) * halfTimeSquared;
}

inline float flightVelocity(float velocity, float gravity, float drag, float time)
{
    return velocity * std::max(0.f, 1.f - drag * time) + gravity * time;
}

// Stock bullet-manager trajectory. Position and collision velocity deliberately
// use different transition times (1 / drag and 2 / drag respectively).
inline float trajectoryPosition(float position, float velocity, float gravity, float drag,
    float time, bool vertical, float epsilon)
{
    const float transition = std::max(0.f, 1.f / drag - epsilon);
    if (time < transition)
        return position + flightDisplacement(velocity, gravity, vertical ? 0.f : drag, time);
    const float fall = time - transition;
    return position + flightDisplacement(velocity, gravity, drag, transition)
        + flightVelocity(velocity, gravity, drag, transition) * fall + gravity * fall * fall * .5f;
}

inline float trajectoryVelocity(float velocity, float gravity, float drag,
    float time, bool vertical, float epsilon)
{
    const float transition = std::max(0.f, 2.f / drag - epsilon);
    if (time < transition)
        return flightVelocity(velocity, gravity, vertical ? 0.f : drag, time);
    return flightVelocity(velocity, gravity, drag, transition) + gravity * (time - transition);
}

inline float penetrationScale(float piercing, float resistance, float epsilon)
{
    return piercing > epsilon && piercing >= resistance ? (piercing - resistance) / piercing : 0.f;
}

inline float bulletArmourPower(float power, float penetration, float armour, float fraction, float protection,
    bool multiplayer, bool& wound)
{
    if (penetration <= armour)
    {
        wound = false;
        return power * fraction;
    }
    if (multiplayer)
    {
        const auto piercedFraction = std::max((penetration - armour) / penetration, fraction);
        return (power * piercedFraction) * protection;
    }
    return power;
}

inline float ricochetScale(float incidence, float energyMin, float energyMax)
{
    return std::clamp(1.f - std::abs(incidence) * energyMin, 0.f, energyMax);
}

enum class SurfaceAction : unsigned { Transparent, Magnetic, Ricochet, Stop, Penetrate };
struct SurfaceResponse
{
    SurfaceAction action;
    float speedScale;
    float penetration;
};

inline float densitySpeed(float speed, float distance, float density)
{
    return std::max(0.f, speed - distance * density);
}

inline SurfaceResponse surfaceResponse(float penetration, float resistance, float drag, bool magnetic,
    bool ricochet, bool materialRicochet, float incidence, float outgoingDot, float threshold,
    float energyMin, float energyMax, float epsilon)
{
    const float scale = penetrationScale(penetration, resistance, epsilon);
    if (std::abs(resistance) < epsilon)
        return {SurfaceAction::Transparent, 1.f, penetration};
    if (magnetic && scale > epsilon)
        return {SurfaceAction::Magnetic, 1.f, penetration - resistance * drag};
    if (threshold < outgoingDot && materialRicochet && ricochet)
        return {SurfaceAction::Ricochet, ricochetScale(incidence, energyMin, energyMax), penetration};
    if (scale < epsilon)
        return {SurfaceAction::Stop, 0.f, penetration};
    return {SurfaceAction::Penetrate, scale, penetration};
}

// Post-equipment continuous hit calculation from CEntityCondition::ConditionHit.
// Protection applies before immunity; immunity boosters intentionally are not
// clamped here, matching the engine's signed condition deltas.
enum class FieldHit : unsigned { Radiation, Chemical, Heat, Psy, Shock };
struct FieldDamage { float health, power, radiation, psy; };
inline FieldDamage fieldDamage(FieldHit kind, float hit, float protection,
    float immunity, float immunityBoost, float healthPart, float powerPart, float boneScale)
{
    if (kind == FieldHit::Radiation || kind == FieldHit::Chemical || kind == FieldHit::Psy)
        hit = std::max(0.f, hit - protection);
    hit *= immunity - immunityBoost;
    if (kind == FieldHit::Radiation)
        return {0.f, 0.f, hit, 0.f};
    float health = hit * healthPart;
    if (kind == FieldHit::Heat)
        health *= boneScale;
    return {health, hit * powerPart, 0.f, kind == FieldHit::Psy ? hit : 0.f};
}

inline float satietyHealthFactor(float satiety, float critical)
{
    return (satiety - critical) / (satiety >= critical ? 1.f - critical : critical);
}

inline float movementPowerCost(float base, float weightPower, float weight, float overweight)
{
    return base + weightPower * weight * (weight > 1.f ? overweight : 1.f);
}

inline bool conditionRestricted(float value, float begin, float end, bool restricted)
{
    return value < begin || (restricted && value <= end);
}

inline bool conditionLimping(float power, float health, float powerBegin, float powerEnd,
    float healthBegin, float healthEnd, bool limping)
{
    return power < powerBegin || health < healthBegin || (limping && (power <= powerEnd || health <= healthEnd));
}

inline constexpr float maxWoundSize = 10.f;

inline float addWoundHit(float size, float hitPower)
{
    return std::clamp(size + hitPower, 0.f, maxWoundSize);
}

inline bool healWound(float* sizes, unsigned count, float amount, float minimum, float epsilon)
{
    float total = 0.f;
    for (unsigned i = 0; i < count; ++i)
        total += sizes[i];
    bool active = false;
    for (unsigned i = 0; i < count; ++i)
    {
        const float healed = sizes[i] - amount;
        sizes[i] = std::abs(total) < epsilon || healed < minimum ? 0.f : healed;
        active |= sizes[i] != 0.f;
    }
    return active;
}
}
