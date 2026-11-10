#include "xrGame/ZonePendingSnapshots.h"
#include <cassert>
#include <vector>
struct Snapshot { unsigned id, life, revision; };
int main()
{
    using xray::zone_pending_snapshots::retain;
    std::vector<Snapshot> pending;
    assert(retain(pending, Snapshot{1, 0, 1}, 2));
    assert(retain(pending, Snapshot{2, 0, 1}, 2));
    // A stalled consumer cannot accumulate retransmitted snapshots.
    for (unsigned revision = 2; revision < 10000; ++revision)
        assert(retain(pending, Snapshot{1, 0, revision}, 2));
    assert(pending.size() == 2 && pending[0].revision == 9999);
    assert(!retain(pending, Snapshot{3, 0, 1}, 2));
    assert(pending.size() == 2 && pending[1].id == 2);
    // A new incarnation replaces the old player's pending state.
    assert(retain(pending, Snapshot{1, 1, 0}, 2));
    assert(pending[0].life == 1 && pending[0].revision == 0);
    // Consumption (or epoch retirement) frees capacity for another player.
    pending.clear();
    assert(retain(pending, Snapshot{3, 0, 1}, 2));
    pending.clear();
    assert(!retain(pending, Snapshot{1, 0, 1}, 0));
}
