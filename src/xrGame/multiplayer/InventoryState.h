#pragma once
// Coherent presentation state only. Item ownership and mutations remain in Rust.
// Independent of X-Ray for sanitizer and wasm64 ABI tests.
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <unordered_set>
#include <utility>
#include <vector>

namespace zone {
constexpr std::size_t maxInventoryBytes = 16 * 1024 * 1024;
constexpr std::size_t maxInventoryItems = 100000;
struct InventoryItemState {
    std::string id, section;
    std::uint32_t revision = 0, quantity = 0;
    float condition = 1;
    // 0 rucksack, 1 slot, 2 belt; kind 0 equipment, 1 ammo, 2 consumable, 3 weapon.
    std::uint8_t placement = 0, index = 0, kind = 0, fireMode = 0;
    bool launcherMode = false, jammed = false;
    std::vector<std::string> upgrades, attachments, cartridges, launcherCartridges;
    std::string selectedAmmunition;
};
namespace inventory_detail {
class Reader {
public:
    Reader(const unsigned char* data, std::size_t size) : p(data), left(size) {}
    std::uint8_t byte() {if (!left) {ok = false; return 0;} --left; return *p++;}
    std::uint16_t shortValue() {auto lo = byte(); return std::uint16_t(lo | (std::uint16_t(byte()) << 8));}
    std::uint32_t integer() {auto lo = shortValue(); return std::uint32_t(lo) | (std::uint32_t(shortValue()) << 16);}
    std::uint64_t wide() {auto lo = integer(); return std::uint64_t(lo) | (std::uint64_t(integer()) << 32);}
    float real() {auto bits = integer(); float f; std::memcpy(&f, &bits, 4); return f;}
    std::string id(bool nullable = false) {
        static const char hex[] = "0123456789abcdef";
        std::string value; value.reserve(32); bool zero = true;
        for (unsigned i = 0; i < 16; ++i) {auto b = byte(); zero = zero && !b; value += hex[b >> 4]; value += hex[b & 15];}
        return nullable && zero ? std::string{} : value;
    }
    std::string section() {
        const auto size = shortValue();
        if (!size || size > 128 || size > left) {ok = false; return {};}
        std::string value; value.reserve(size);
        for (unsigned i = 0; i < size; ++i) {
            const auto b = byte();
            if (!((b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') ||
                  (b >= '0' && b <= '9') || b == '_' || b == '-' || b == '.')) ok = false;
            value += static_cast<char>(b);
        }
        return value;
    }
    std::vector<std::string> strings() {
        const auto count = shortValue(); std::vector<std::string> result;
        if (count > 1024 || count > left / 3) {ok = false; return result;}
        result.reserve(count);
        for (unsigned i = 0; i < count && ok; ++i) result.push_back(section());
        return result;
    }
    bool ok = true;
    const unsigned char* p;
    std::size_t left;
};
}
class InventoryState {
public:
    bool apply(const unsigned char* data, std::size_t size) {
        if (!data || size < 48 || size > maxInventoryBytes) return false;
        inventory_detail::Reader r(data, size);
        if (r.integer() != 0x564e495a || r.integer() != 1) return false;
        const auto nextGeneration = r.wide(); const auto nextLife = r.integer();
        const auto live = r.integer(), count = r.integer(), reserved = r.integer();
        const auto nextCorpse = r.id(true);
        if (nextGeneration > 9007199254740991ull || live > 1 || reserved ||
            count > maxInventoryItems || count > r.left / 33 || (!live && count) ||
            (valid && (nextGeneration < generation || nextLife < life))) return false;
        std::vector<InventoryItemState> next; next.reserve(count);
        std::unordered_set<std::string> ids; std::unordered_set<unsigned> places;
        for (std::uint32_t i = 0; i < count; ++i) {
            InventoryItemState item;
            item.id = r.id(); item.revision = r.integer();
            item.placement = r.byte(); item.index = r.byte(); item.kind = r.byte();
            if (r.byte() || item.placement > 2 || item.kind > 3 ||
                (item.placement == 0 && item.index) ||
                (item.placement == 1 && (!item.index || item.index > 13)) ||
                (item.placement == 2 && item.index > 4)) return false;
            item.condition = r.real(); item.section = r.section(); item.upgrades = r.strings();
            if (!std::isfinite(item.condition) || item.condition < 0 || item.condition > 1 ||
                !ids.insert(item.id).second ||
                (item.placement && !places.insert(unsigned(item.placement) * 256 + item.index).second)) return false;
            if (item.kind == 3) {
                item.fireMode = r.byte(); const auto flags = r.byte();
                if (flags > 3) return false;
                item.launcherMode = (flags & 1) != 0;
                item.jammed = (flags & 2) != 0;
                item.selectedAmmunition = r.section();
                item.attachments = r.strings(); item.cartridges = r.strings(); item.launcherCartridges = r.strings();
            } else if (item.kind) {item.quantity = r.integer(); if (!item.quantity) return false;}
            if (!r.ok) return false;
            next.push_back(std::move(item));
        }
        if (!r.ok || r.left) return false;
        if (valid && nextGeneration == generation) {
            if (nextLife != life || (live != 0) != alive || nextCorpse != corpse) return false;
            ++updates;return true;
        }
        items.swap(next); generation = nextGeneration; life = nextLife;
        alive = live != 0; corpse = nextCorpse; valid = true;++updates;
        return true;
    }
    void reset() {items.clear(); corpse.clear(); generation = updates = 0; life = 0; alive = false; valid = false;}
    std::vector<InventoryItemState> items;
    std::string corpse;
    std::uint64_t generation = 0;
    std::uint64_t updates = 0;
    std::uint32_t life = 0;
    bool alive = false, valid = false;
};
}
