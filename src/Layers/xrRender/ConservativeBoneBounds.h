#pragma once
#include <cmath>
#include <limits>
// A transformed centered box has extents |basis|*halfSize. Outward roundoff
// padding keeps this bound conservative relative to eight float corner sums.
template<class Box, class Matrix, class Vector>
void ExpandConservativeBoneBounds(Box& box, const Matrix& m, const Vector& half)
{
    Vector extent, lo, hi;
    extent.set(std::abs(m._11)*half.x + std::abs(m._21)*half.y + std::abs(m._31)*half.z,
        std::abs(m._12)*half.x + std::abs(m._22)*half.y + std::abs(m._32)*half.z,
        std::abs(m._13)*half.x + std::abs(m._23)*half.y + std::abs(m._33)*half.z);
    const auto pad = [](float center, float e) { return 8.f*std::numeric_limits<float>::epsilon()*(std::abs(center)+e+1.f); };
    lo.set(m._41-extent.x-pad(m._41,extent.x),m._42-extent.y-pad(m._42,extent.y),m._43-extent.z-pad(m._43,extent.z));
    hi.set(m._41+extent.x+pad(m._41,extent.x),m._42+extent.y+pad(m._42,extent.y),m._43+extent.z+pad(m._43,extent.z));
    box.modify(lo); box.modify(hi);
}
