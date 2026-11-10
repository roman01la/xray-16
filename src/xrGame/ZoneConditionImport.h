#pragma once
#include "ZoneConditionState.h"
#include <string>
namespace xray::zone_condition
{
struct NamedWound { std::string bone; std::array<float, HitTypes> sizes{}; };
struct Import
{
    // Health, power, satiety, radiation, psy health, alcohol.
    std::array<float, 6> values{};
    std::array<float, 9> medicine{};
    unsigned flags = 0;
    std::vector<NamedWound> wounds;
    std::vector<Booster> boosters;
};
inline std::optional<Import> decodeImport(const unsigned char* bytes, std::size_t size)
{
    if (size<76 || size>32000 || std::memcmp(bytes,"ZCL1",4)) return {};
    std::size_t cursor=4;
    const auto word=[&]() { std::uint32_t value=0; for(unsigned i=0;i<4;++i) value|=std::uint32_t(bytes[cursor++])<<(8*i); return value; };
    const auto scalar=[&]() { auto bits=word(); float value; std::memcpy(&value,&bits,4); return value; };
    Import result;
    for(auto& value:result.values) { value=scalar(); if(!std::isfinite(value)||value<0.f||value>1.f) return {}; }
    for(auto& value:result.medicine) { value=scalar(); if(!std::isfinite(value)||std::abs(value)>1000000.f) return {}; }
    result.flags=word(); const auto wounds=word(), boosters=word();
    if(result.flags>7 || wounds>MaxWounds || boosters>BoostTypes || result.medicine[8]<0.f ||
        (result.medicine[8]>0.f && (result.medicine[7]<=0.f || result.medicine[8]>result.medicine[7]))) return {};
    for(unsigned i=0;i<wounds;++i)
    {
        if(cursor>=size) return {};
        const auto count=bytes[cursor++];
        if(count>63 || size-cursor<count+HitTypes*4) return {};
        NamedWound wound;
        for(unsigned n=0;n<count;++n) {
            const auto c=bytes[cursor++];
            if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_')) return {};
            wound.bone.push_back(c);
        }
        for(const auto& previous:result.wounds) if(previous.bone==wound.bone) return {};
        for(auto& value:wound.sizes) { value=scalar(); if(!std::isfinite(value)||value<0.f||value>10.f) return {}; }
        result.wounds.push_back(std::move(wound));
    }
    if(size-cursor!=boosters*12) return {};
    unsigned seen=0;
    for(unsigned i=0;i<boosters;++i) {
        Booster boost{word(),scalar(),scalar()};
        if(boost.type>=BoostTypes || (seen&(1u<<boost.type)) || !std::isfinite(boost.value) ||
            std::abs(boost.value)>1000000.f || !std::isfinite(boost.remaining) || boost.remaining<=0.f || boost.remaining>1000000.f) return {};
        seen|=1u<<boost.type; result.boosters.push_back(boost);
    }
    return result;
}
}
