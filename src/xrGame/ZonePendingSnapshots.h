#pragma once
#include <algorithm>
#include <cstddef>
#include <utility>

namespace xray::zone_pending_snapshots
{
// One pending snapshot per player. Repeated socket polls must neither discard
// unconsumed state nor grow a queue with retransmitted full snapshots.
template<class Container, class Snapshot>
bool retain(Container& pending, Snapshot snapshot, std::size_t capacity)
{
    const auto found = std::find_if(pending.begin(), pending.end(),
        [&](const auto& previous) { return previous.id == snapshot.id; });
    if (found != pending.end())
    {
        *found = std::move(snapshot);
        return true;
    }
    if (pending.size() >= capacity)
        return false;
    pending.push_back(std::move(snapshot));
    return true;
}
}
