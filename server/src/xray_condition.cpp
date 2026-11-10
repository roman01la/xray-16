#include "ZoneConditionProtocol.h"
extern "C" bool zone_condition_inspect(const unsigned char* bytes, unsigned size,
    float* values, unsigned* flags, float* bleeding, unsigned* icons)
{
    auto state=xray::zone_condition::decode(bytes,size);
    if (!state) return false;
    std::copy(state->values.begin(),state->values.end(),values);
    *flags=state->flags;
    *icons=0;
    constexpr unsigned hudTypes[]={0,1,2,3,4,14,15,16};
    for (const auto& boost : state->boosters)
        for (unsigned i=0;i<8;++i)
            if (boost.type==hudTypes[i])
                *icons |= (1u<<i) | (boost.remaining<=3.f ? (1u<<(i+8)) : 0u);
    float total=0.f;
    for (const auto& wound : state->wounds)
        for (float value : wound.sizes) total+=value;
    *bleeding=state->wounds.empty() ? 0.f : total/state->wounds.size();
    return true;
}
extern "C" bool zone_condition_request_valid(const unsigned char* bytes, unsigned size)
{
    return xray::zone_condition::request(bytes,size).has_value();
}

extern "C" bool zone_condition_import_valid(const unsigned char* bytes, unsigned size)
{
    return xray::zone_condition::decodeImport(bytes,size).has_value();
}

// Custom server policy enters the same native delta accumulator as stock effects.
// The input is immutable, so retrying a request never spends the delta twice.
extern "C" unsigned zone_condition_policy(const unsigned char* bytes, unsigned size,
    bool protected_area, float health_loss, unsigned char* output, unsigned capacity)
{
    if (!std::isfinite(health_loss) || health_loss < 0.f || health_loss > 1.f) return 0;
    auto state=xray::zone_condition::decode(bytes,size);
    if (!state) return 0;
    if (protected_area) state->flags &= ~16u;
    else { state->flags |= 16u; state->values[8] -= health_loss; }
    const auto result=xray::zone_condition::encode(*state);
    if (result.empty() || result.size()>capacity) return 0;
    std::copy(result.begin(),result.end(),output);
    return result.size();
}
