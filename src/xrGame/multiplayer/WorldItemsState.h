#pragma once
#include "InventoryState.h"
#include <array>
#include <optional>
namespace zone {
constexpr std::size_t maxWorldItemsBytes = maxInventoryBytes + 12 + 40 + 8192 * 28;
struct WorldItemLocation {std::string source;std::array<float,3> position;};
struct WorldStorageLocation : WorldItemLocation {std::array<float,3> rotation;};
class WorldItemsState {
public:
    bool apply(const unsigned char* bytes,std::size_t size) {
        if(!bytes || size<12 || size>maxWorldItemsBytes)return false;
        inventory_detail::Reader header(bytes,size);
        if(header.integer()!=0x444c575a)return false;
        const auto inventorySize=header.integer();
        const auto storageSize=header.integer();
        if (inventorySize>size-12 || (storageSize!=0 && storageSize!=40) || storageSize>size-12-inventorySize) return false;
        InventoryState next;
        if(!next.apply(bytes+12,inventorySize) || !next.alive || !next.corpse.empty() || next.items.size()>4096)return false;
        if(state.valid && (next.life<state.life || next.generation<state.generation))return false;
        const auto locationBytes=size-12-inventorySize-storageSize;
        if(locationBytes%28 || locationBytes/28<next.items.size() || locationBytes/28-next.items.size()>4096)return false;
        inventory_detail::Reader r(bytes+12+inventorySize,size-12-inventorySize);
        std::optional<WorldStorageLocation> station;
        if (storageSize) {
            station.emplace();
            station->source = r.id();
            for (auto& coordinate : station->position) {
                coordinate = r.real();
                if (!std::isfinite(coordinate)) return false;
            }
            for (auto& angle : station->rotation) {
                angle = r.real();
                if (!std::isfinite(angle)) return false;
            }
        }
        std::vector<WorldItemLocation> places;places.reserve(next.items.size());
        for(const auto& item:next.items){
            if(item.placement!=0)return false;
            WorldItemLocation location;location.source=r.id();
            for(auto& value:location.position){value=r.real();if(!std::isfinite(value))return false;}
            places.push_back(std::move(location));
        }
        std::vector<WorldItemLocation> bodies;
        bodies.reserve(r.left/28);
        while(r.left) {
            WorldItemLocation body;
            body.source=r.id();
            if(!bodies.empty() && body.source<=bodies.back().source)return false;
            for(auto& value:body.position){value=r.real();if(!std::isfinite(value))return false;}
            bodies.push_back(std::move(body));
        }
        if(!r.ok)return false;
        if(state.valid && next.generation==state.generation)return next.life==state.life;
        state=std::move(next);locations=std::move(places);corpses=std::move(bodies);storage=std::move(station);++updates;return true;
    }
    void reset(){state.reset();locations.clear();corpses.clear();storage.reset();updates=0;}
    InventoryState state;
    std::vector<WorldItemLocation> locations,corpses;
    std::optional<WorldStorageLocation> storage;
    std::uint64_t updates=0;
};
}
