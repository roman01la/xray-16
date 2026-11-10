#pragma once
#include "ZoneConditionState.h"
#include <string>

namespace xray::zone_condition
{
struct Hit
{
    unsigned type = 0;
    float power = 0.f, penetration = 0.f;
    bool aimed = false;
    std::string bone;
};
struct Wear { float outfit = -1.f, helmet = -1.f; };
// Match the native attack bridge and Rust ballistics; stock Gauss uses 150.
inline bool validHit(const Hit& hit)
{
    if (hit.type >= HitTypes || !std::isfinite(hit.power) || hit.power < 0.f || hit.power > 10.f ||
        !std::isfinite(hit.penetration) || hit.penetration < 0.f || hit.penetration > 1000.f || hit.bone.size() > 63)
        return false;
    for (const auto c : hit.bone)
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'))
            return false;
    return true;
}
}
