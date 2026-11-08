#include "pch_script.h"
#include "EngineAdapter.h"
#include <emscripten.h>
#include <array>

EM_JS(int, zone_poll_snapshot, (unsigned char* destination, unsigned capacity), {
    // Absent until the dedicated launcher binds the application pthread.
    if (!globalThis.zoneEnginePoll) return -1;
    return globalThis.zoneEnginePoll(destination, capacity);
});
EM_JS(void, zone_report_snapshot, (unsigned tick, unsigned entities), {
    globalThis.zoneEngineApplied?.(tick>>>0, entities>>>0);
});
EM_JS(int, zone_poll_inventory, (unsigned char* destination, unsigned capacity), {
    return globalThis.zoneEngineInventoryPoll?.(destination, capacity) ?? 0;
});
EM_JS(void, zone_report_inventory, (double generation, unsigned life, unsigned items, int alive), {
    globalThis.zoneEngineInventoryApplied?.({generation,life:life>>>0,items:items>>>0,alive:!!alive});
});
EM_JS(int, zone_poll_world_items, (unsigned char* destination, unsigned capacity), {
    return globalThis.zoneEngineWorldItemsPoll?.(destination, capacity) ?? 0;
});
EM_JS(int, zone_poll_corpse_search, (unsigned char* destination, unsigned capacity), {
    return globalThis.zoneEngineCorpseSearchPoll?.(destination, capacity) ?? 0;
});
namespace zone {
namespace {
SnapshotState state;
InventoryState inventoryState;
WorldItemsState worldItemsState;
CorpseSearchState corpseSearchState;
std::array<unsigned char, maxSnapshotBytes> buffer;
// Allocate on first active multiplayer frame, never in the single-player path.
std::vector<unsigned char> inventoryBuffer,worldItemsBuffer,corpseSearchBuffer;
}
void frame() {
    const int size = zone_poll_snapshot(buffer.data(), buffer.size());
    if (size < 0) {state.reset(); inventoryState.reset(); worldItemsState.reset(); corpseSearchState.reset(); return;}
    if (size && !state.apply(buffer.data(), static_cast<std::size_t>(size))) {
        state.reset();
        Msg("! Multiplayer: rejected invalid engine snapshot");
    } else if (size) {
        zone_report_snapshot(state.tick, static_cast<unsigned>(state.entities.size()));
    }
    if (inventoryBuffer.empty()) inventoryBuffer.resize(maxInventoryBytes);
    const int inventorySize = zone_poll_inventory(inventoryBuffer.data(), inventoryBuffer.size());
    if (inventorySize < 0) inventoryState.reset();
    else if (inventorySize && !inventoryState.apply(inventoryBuffer.data(), static_cast<std::size_t>(inventorySize))) {
        inventoryState.reset();
        Msg("! Multiplayer: rejected invalid engine inventory");
    } else if (inventorySize) {
        zone_report_inventory(static_cast<double>(inventoryState.generation), inventoryState.life,
            static_cast<unsigned>(inventoryState.items.size()), inventoryState.alive);
    }
    if(corpseSearchBuffer.empty())corpseSearchBuffer.resize(maxCorpseSearchBytes);
    const int corpseSize=zone_poll_corpse_search(corpseSearchBuffer.data(),corpseSearchBuffer.size());
    if(corpseSize<0)corpseSearchState.reset();
    else if(corpseSize && !corpseSearchState.apply(corpseSearchBuffer.data(),static_cast<std::size_t>(corpseSize))) {
        corpseSearchState.reset();Msg("! Multiplayer: rejected invalid corpse search");
    }
    if(worldItemsBuffer.empty())worldItemsBuffer.resize(maxWorldItemsBytes);
    const int worldSize=zone_poll_world_items(worldItemsBuffer.data(),worldItemsBuffer.size());
    if(worldSize<0)worldItemsState.reset();
    else if(worldSize && !worldItemsState.apply(worldItemsBuffer.data(),static_cast<std::size_t>(worldSize))) {
        worldItemsState.reset();Msg("! Multiplayer: rejected invalid world items");
    }
}
const CorpseSearchState& corpseSearch() {return corpseSearchState;}
const WorldItemsState& worldItems() {return worldItemsState;}
const SnapshotState& snapshot() {return state;}
const InventoryState& inventory() {return inventoryState;}
}
