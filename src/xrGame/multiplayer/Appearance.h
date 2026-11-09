#pragma once
#include "Snapshot.h"
#include <map>
#include <string>
#include <string_view>

namespace zone {
struct EquipmentAppearance {
    std::string outfit, helmet, weapon, visual;
    std::uint8_t weaponAddons = 0;
};
constexpr std::size_t maxAppearanceEntries = 512;
constexpr std::size_t maxAppearanceBytes = 4 + maxAppearanceEntries * (5 + 4 * 129);

class AppearanceState {
public:
    bool apply(const unsigned char* data, std::size_t size) {
        if (!data || size < 4 || size > maxAppearanceBytes) return false;
        const auto count = u32(data);
        if (count > maxAppearanceEntries) return false;
        std::size_t at = 4;
        std::uint32_t previous = 0;
        std::map<std::uint32_t, EquipmentAppearance> next;
        for (std::uint32_t i = 0; i < count; ++i) {
            if (size - at < 4) return false;
            const auto id = u32(data + at); at += 4;
            if (id <= previous) return false;
            previous = id;
            EquipmentAppearance appearance;
            for (auto* field : {&appearance.outfit, &appearance.helmet, &appearance.weapon, &appearance.visual}) {
                if (at == size) return false;
                const auto length = data[at++];
                const bool model = field == &appearance.visual;
                if (length > (model ? 127 : 128) || length > size - at) return false;
                const auto* end = data + at + length;
                for (auto p = data + at; p != end; ++p) {
                    const auto c = *p;
                    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                          (c >= '0' && c <= '9') || c == '_' || c == '.' || c == '-' || (model && c == '\\'))) return false;
                }
                field->assign(reinterpret_cast<const char*>(data + at), length);
                at += length;
            }
            if (at == size) return false;
            appearance.weaponAddons = data[at++];
            if (appearance.weaponAddons > 7 || (appearance.weaponAddons && appearance.weapon.empty())) return false;
            const bool equipment = !appearance.outfit.empty() || !appearance.helmet.empty() || !appearance.weapon.empty();
            if (appearance.visual.empty()) {
                if (!equipment) return false;
            } else {
                if (equipment) return false;
                std::string_view path(appearance.visual);
                for (;;) {
                    const auto slash = path.find('\\');
                    const auto part = path.substr(0, slash);
                    if (part.empty() || part == "." || part == "..") return false;
                    if (slash == path.npos) break;
                    path.remove_prefix(slash + 1);
                }
            }
            next.emplace(id, std::move(appearance));
        }
        if (at != size) return false;
        entries.swap(next);
        return true;
    }
    const EquipmentAppearance& get(std::uint32_t id) const {
        static const EquipmentAppearance empty;
        const auto it = entries.find(id);
        return it == entries.end() ? empty : it->second;
    }
    void clear() { entries.clear(); }
private:
    std::map<std::uint32_t, EquipmentAppearance> entries;
};
}
