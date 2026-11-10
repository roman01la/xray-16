#pragma once

#include <cassert>
#include "_matrix.h"
#include "_fbox.h"
#include "_sphere.h"
#include "_cylinder.h"

// Stock skeleton intersections shared with the multiplayer rewind service.
namespace xray::collision
{
inline bool RAYvsOBB(const Fmatrix& IM, const Fvector& b_hsize, const Fvector& S, const Fvector& D, float& R, bool bCull)
{
    Fbox E = {-b_hsize.x, -b_hsize.y, -b_hsize.z, b_hsize.x, b_hsize.y, b_hsize.z};
    // XForm world-2-local
    Fvector SL, DL, PL;
    IM.transform_tiny(SL, S);
    IM.transform_dir(DL, D);

    // Actual test
    Fbox::ERP_Result rp_res = E.Pick2(SL, DL, PL);
    if ((rp_res == Fbox::rpOriginOutside) || (!bCull && (rp_res == Fbox::rpOriginInside)))
    {
        float d = PL.distance_to_sqr(SL);
        if (d < R * R)
        {
            R = _sqrt(d);
            assert(R >= 0.f);
            return true;
        }
    }
    return false;
}
inline bool RAYvsSPHERE(const Fsphere& s_sphere, const Fvector& S, const Fvector& D, float& R, bool bCull)
{
    Fsphere::ERP_Result rp_res = s_sphere.intersect(S, D, R);
    assert(R >= 0.f);
    return ((rp_res == Fsphere::rpOriginOutside) || (!bCull && (rp_res == Fsphere::rpOriginInside)));
}
inline bool RAYvsCYLINDER(const Fcylinder& c_cylinder, const Fvector& S, const Fvector& D, float& R, bool bCull)
{
    // Actual test
    Fcylinder::ERP_Result rp_res = c_cylinder.intersect(S, D, R);
    assert(R >= 0.f);
    return ((rp_res == Fcylinder::rpOriginOutside) || (!bCull && (rp_res == Fcylinder::rpOriginInside)));
}

}
