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
    globalThis.zoneEngineApplied?.(tick, entities);
});
namespace zone {
namespace {
SnapshotState state;
std::array<unsigned char, maxSnapshotBytes> buffer;
}
void frame() {
    const int size = zone_poll_snapshot(buffer.data(), buffer.size());
    if (size < 0) {state.reset(); return;}
    if (size && !state.apply(buffer.data(), static_cast<std::size_t>(size))) {
        state.reset();
        Msg("! Multiplayer: rejected invalid engine snapshot");
    } else if (size) {
        zone_report_snapshot(state.tick, static_cast<unsigned>(state.entities.size()));
    }
}
const SnapshotState& snapshot() {return state;}
}
