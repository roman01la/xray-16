// Compile the engine's own skeleton query routines without the engine runtime.
#include "Common/Common.hpp"
#define XRCORE_API
#include "xrCore/_std_extensions.h"
#include "xrCore/SkeletonRay.h"
#include "xrCore/_cylinder_impl.inl"

extern "C" bool zone_skeleton_ray(unsigned kind, const float* data,
    const float* origin, const float* direction, float* range)
{
    const Fvector start{origin[0], origin[1], origin[2]};
    const Fvector ray{direction[0], direction[1], direction[2]};
    const auto vector = [&](unsigned at) { return Fvector{data[at], data[at + 1], data[at + 2]}; };
    switch (kind)
    {
    case 1:
    {
        Fmatrix inverse{};
        inverse._44 = 1.f;
        inverse.i = vector(0);
        inverse.j = vector(3);
        inverse.k = vector(6);
        inverse.c = vector(9);
        return xray::collision::RAYvsOBB(inverse, vector(12), start, ray, *range, true);
    }
    case 2:
    {
        Fsphere sphere;
        sphere.P = vector(0);
        sphere.R = data[3];
        return xray::collision::RAYvsSPHERE(sphere, start, ray, *range, true);
    }
    case 3:
    {
        Fcylinder cylinder;
        cylinder.m_center = vector(0);
        cylinder.m_direction = vector(3);
        cylinder.m_height = data[6];
        cylinder.m_radius = data[7];
        return xray::collision::RAYvsCYLINDER(cylinder, start, ray, *range, true);
    }
    default:
        return false;
    }
}
