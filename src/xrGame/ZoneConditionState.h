#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <optional>
#include <vector>

namespace xray::zone_condition
{
// Private host checkpoint, not the quantized single-player save format.
inline constexpr unsigned HitTypes = 12, BoostTypes = 17, MaxWounds = 256;
struct Wound
{
    std::uint16_t bone = 0;
    bool destroyed = false;
    std::array<float, HitTypes> sizes{};
};
struct Booster { unsigned type; float value, remaining; };
struct State
{
    // Health, power, radiation, psy, morale, max power, alcohol, satiety,
    // six pending deltas, last health loss, hit/wound bone scales,
    // invulnerability seconds, max health, carry/walk weights, satiety power, equipment pulse timer.
    std::array<float, 23> values{};
    std::array<float, 8> rates{};
    std::array<float, 12> protections{};
    // Seven medicine effects, total seconds, remaining seconds. Inactive=all zero.
    std::array<float, 9> medicine{};
    std::uint16_t conditionFlags = 0;
    // Limping, cannot walk, cannot sprint, bleeding, can be harmed.
    std::uint8_t flags = 0;
    std::vector<Wound> wounds;
    std::vector<Booster> boosters;
};
inline bool valid(const State& s)
{
    const auto finite = [](const auto& values) {
        for (float v : values) if (!std::isfinite(v) || std::abs(v) > 1000000.f) return false;
        return true;
    };
    if (!finite(s.values) || !finite(s.rates) || !finite(s.protections) || !finite(s.medicine) ||
        s.flags > 31 || s.wounds.size() > MaxWounds || s.boosters.size() > BoostTypes ||
        s.values[5] < 0.1f || s.values[18] <= 0.f || s.values[19] <= 0.f || s.values[20] <= 0.f ||
        s.values[17] < 0.f || s.values[22] < 0.f || s.medicine[8] < 0.f ||
        (s.medicine[8] > 0.f && (s.medicine[7] <= 0.f || s.medicine[8] > s.medicine[7]))) return false;
    for (std::size_t i = 0; i < s.wounds.size(); ++i)
    {
        const auto& wound = s.wounds[i];
        for (float v : wound.sizes) if (!std::isfinite(v) || v < 0.f || v > 10.f) return false;
        for (std::size_t j = 0; j < i; ++j) if (s.wounds[j].bone == wound.bone) return false;
    }
    unsigned seen = 0;
    for (const auto& b : s.boosters)
    {
        if (b.type >= BoostTypes || (seen & (1u << b.type)) || !std::isfinite(b.value) ||
            std::abs(b.value) > 1000000.f || !std::isfinite(b.remaining) || b.remaining <= 0.f ||
            b.remaining > 1000000.f) return false;
        seen |= 1u << b.type;
    }
    return true;
}
inline std::vector<unsigned char> encode(const State& s)
{
    if (!valid(s)) return {};
    std::vector<unsigned char> out{'Z', 'C', 'S', '1'};
    const auto word = [&](std::uint32_t v) { for (unsigned i=0;i<4;++i) out.push_back(v >> (i*8)); };
    const auto scalar = [&](float v) { std::uint32_t bits; std::memcpy(&bits,&v,4); word(bits); };
    for (float v : s.values) scalar(v);
    for (float v : s.rates) scalar(v);
    for (float v : s.protections) scalar(v);
    for (float v : s.medicine) scalar(v);
    word(s.conditionFlags); word(s.flags); word(s.wounds.size()); word(s.boosters.size());
    for (const auto& wound : s.wounds)
    {
        word(wound.bone); word(wound.destroyed);
        for (float v : wound.sizes) scalar(v);
    }
    for (const auto& b : s.boosters) { word(b.type); scalar(b.value); scalar(b.remaining); }
    return out;
}
inline std::optional<State> decode(const unsigned char* bytes, std::size_t size)
{
    constexpr std::size_t Header = 4 + (23+8+12+9+4)*4;
    if (size < Header || std::memcmp(bytes,"ZCS1",4)) return {};
    std::size_t cursor=4;
    const auto word = [&]() {
        std::uint32_t v=0;
        for (unsigned i=0;i<4;++i) v |= std::uint32_t(bytes[cursor++]) << (i*8);
        return v;
    };
    const auto scalar = [&]() { auto bits=word(); float v; std::memcpy(&v,&bits,4); return v; };
    State result;
    for (auto& v : result.values) v=scalar();
    for (auto& v : result.rates) v=scalar();
    for (auto& v : result.protections) v=scalar();
    for (auto& v : result.medicine) v=scalar();
    const auto conditions=word(), flags=word(), wounds=word(), boosters=word();
    if (conditions > 65535 || flags > 31 || wounds > MaxWounds || boosters > BoostTypes ||
        size != Header + wounds*(8+HitTypes*4) + boosters*12) return {};
    result.conditionFlags=conditions; result.flags=flags;
    for (unsigned i=0;i<wounds;++i)
    {
        const auto bone=word(), destroyed=word();
        if (bone > 65535 || destroyed > 1) return {};
        Wound wound; wound.bone=bone; wound.destroyed=destroyed;
        for (auto& v : wound.sizes) v=scalar();
        result.wounds.push_back(wound);
    }
    for (unsigned i=0;i<boosters;++i) result.boosters.push_back({word(),scalar(),scalar()});
    return valid(result) ? std::optional<State>(std::move(result)) : std::nullopt;
}
}
