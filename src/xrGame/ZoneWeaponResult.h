#pragma once
#include "ZoneWeaponAction.h"
#include <cmath>
#include <string>
#include <set>

namespace xray::zone_weapon_action
{
struct AmmoResult
{
    // Persisted boxes use id/revision. Native-created boxes have a zero id and
    // an action-local native id; Rust assigns durable ids when committing.
    std::array<unsigned char, 16> id{};
    std::uint32_t revision = 0;
    std::uint16_t native = 0, rounds = 0;
    std::string section;
};
struct WeaponResult
{
    float condition = 1.f;
    unsigned char mode = 0;
    bool jammed = false, launcher = false;
    std::string selected;
    std::vector<std::string> cartridges, grenades;
    std::vector<AmmoResult> reserve;
};
inline std::vector<unsigned char> result(const Fence& fence, Phase phase, const WeaponResult* state = nullptr)
{
    if ((phase == Phase::Complete) != (state != nullptr)) return {};
    auto bytes = encode({fence, Operation::Reload});
    if (!decode(bytes.data(), bytes.size())) return {};
    std::memcpy(bytes.data(), "ZWR1", 4);
    bytes[64] = static_cast<unsigned char>(phase);
    if (bytes[64] < 1 || bytes[64] > 5) return {};
    if (!state) return bytes;
    const auto integer = [&](std::uint32_t value, unsigned width) {
        for (unsigned i=0; i<width; ++i) bytes.push_back(static_cast<unsigned char>(value>>(8*i)));
    };
    const auto name = [&](const std::string& text) {
        if (text.empty() || text.size()>63) return false;
        for (unsigned char c : text) if (c<33 || c>126) return false;
        bytes.push_back(static_cast<unsigned char>(text.size()));
        bytes.insert(bytes.end(),text.begin(),text.end()); return true;
    };
    if (!std::isfinite(state->condition) || state->condition<0 || state->condition>1 || state->reserve.size()>128)
        return {};
    std::uint32_t bits; std::memcpy(&bits,&state->condition,4); integer(bits,4);
    bytes.push_back(state->mode); bytes.push_back((state->jammed?1:0)|(state->launcher?2:0));
    if (!name(state->selected)) return {};
    for (const auto* magazine : {&state->cartridges,&state->grenades})
    {
        if (magazine->size()>1024) return {};
        integer(static_cast<std::uint32_t>(magazine->size()),2);
        for (const auto& section : *magazine) if (!name(section)) return {};
    }
    bytes.push_back(static_cast<unsigned char>(state->reserve.size()));
    std::set<std::array<unsigned char,16>> ids;
    std::set<std::uint16_t> natives;
    for (const auto& ammo : state->reserve)
    {
        const bool persisted = std::any_of(ammo.id.begin(),ammo.id.end(),[](auto b){return b!=0;});
        if (ammo.native==65535 || !natives.insert(ammo.native).second ||
            (persisted && !ids.insert(ammo.id).second) || (!persisted && ammo.revision)) return {};
        bytes.insert(bytes.end(),ammo.id.begin(),ammo.id.end());
        integer(ammo.revision,4); integer(ammo.native,2); integer(ammo.rounds,2);
        if (!name(ammo.section)) return {};
    }
    // Remain below the private Unix datagram receive limit.
    return bytes.size()<=65536 ? bytes : std::vector<unsigned char>{};
}
}
