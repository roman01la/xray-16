#pragma once
#include <algorithm>
#include <cmath>
namespace xray::zone_condition
{
// Timed host treatments use real seconds, like the actor's booster timers.
// Apply the returned fraction through CEntityCondition::ApplyInfluence.
inline float medicineFraction(float total, float& remaining, float seconds)
{
    if (!std::isfinite(total) || !std::isfinite(remaining) || !std::isfinite(seconds) ||
        total <= 0.f || remaining <= 0.f || seconds <= 0.f) return 0.f;
    const float elapsed = std::min(remaining, seconds);
    remaining -= elapsed;
    return elapsed / total;
}
}
