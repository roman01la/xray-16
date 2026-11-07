#pragma once
// Worker-to-engine ABI, not a network packet. All values are little endian.
// Kept independent of X-Ray so malformed input can be tested without a renderer.
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <vector>

namespace zone {
constexpr std::size_t maxEntities = 7424;
constexpr std::size_t headerBytes = 24;
constexpr std::size_t entityBytes = 36;
constexpr std::size_t maxSnapshotBytes = headerBytes + entityBytes * maxEntities;
struct Entity {
    std::uint32_t id;
    float x, y, z, vx, vy, vz, yaw;
    std::uint16_t health;
    std::uint8_t kind, flags;
};
inline std::uint32_t u32(const unsigned char* p) {
    return std::uint32_t(p[0]) | (std::uint32_t(p[1]) << 8) |
        (std::uint32_t(p[2]) << 16) | (std::uint32_t(p[3]) << 24);
}
inline float f32(const unsigned char* p) {
    const auto bits = u32(p); float f; std::memcpy(&f, &bits, 4); return f;
}
inline bool newer(std::uint32_t a, std::uint32_t b) {
    const auto delta = a - b; return delta != 0 && delta < 0x80000000u;
}
class SnapshotState {
public:
    bool apply(const unsigned char* data, std::size_t size) {
        if (!data || size < headerBytes || size > maxSnapshotBytes) return false;
        const auto count = u32(data + 20), nextTick = u32(data + 8), self = u32(data + 12);
        // Magic ZENG, ABI 1, tick, local player, input ack, count.
        if (u32(data) != 0x474e455a || u32(data + 4) != 1 || !self ||
            count > maxEntities || size != headerBytes + count * entityBytes ||
            (valid && (self != playerId || !newer(nextTick, tick)))) return false;
        scratch.clear();
        for (std::size_t i = 0; i < count; ++i) {
            const auto* p = data + headerBytes + i * entityBytes;
            Entity e{u32(p), f32(p+4), f32(p+8), f32(p+12), f32(p+16),
                f32(p+20), f32(p+24), f32(p+28),
                std::uint16_t(p[32] | (std::uint16_t(p[33]) << 8)), p[34], p[35]};
            if (!e.id || !std::isfinite(e.x) || !std::isfinite(e.y) || !std::isfinite(e.z) ||
                !std::isfinite(e.vx) || !std::isfinite(e.vy) || !std::isfinite(e.vz) ||
                !std::isfinite(e.yaw) || (e.kind != 1 && e.kind != 2) || (e.flags & ~15u)) return false;
            scratch.push_back(e);
        }
        std::sort(scratch.begin(), scratch.end(), [](const Entity& a, const Entity& b) {return a.id < b.id;});
        bool foundSelf = false;
        for (std::size_t i = 0; i < scratch.size(); ++i) {
            if (i && scratch[i-1].id == scratch[i].id) return false;
            if (scratch[i].id == self) {if (scratch[i].kind != 1) return false; foundSelf = true;}
        }
        if (!foundSelf) return false;
        // Commit only after complete validation. No partial spawn/despawn effects.
        entities.swap(scratch); tick = nextTick; playerId = self; ack = u32(data+16); valid = true;
        return true;
    }
    void reset() {entities.clear(); scratch.clear(); tick = playerId = ack = 0; valid = false;}
    std::vector<Entity> entities;
    std::uint32_t tick = 0, playerId = 0, ack = 0;
    bool valid = false;
private:
    std::vector<Entity> scratch;
};
} // namespace zone
