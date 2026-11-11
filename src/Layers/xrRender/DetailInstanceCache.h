#pragma once
#include <cstdint>

namespace xray::detail_cache
{
// A completed gathered output is independent of subsequent source-page eviction.
// Revisit source allocation/revisions on every new frame or visibility/reset epoch.
struct PreparedFrame
{
    std::uint32_t frame = std::uint32_t(-1), storage = 0, count = 0;
    std::uint64_t visibility = std::uint64_t(-1);
    bool matches(std::uint32_t currentFrame, std::uint64_t currentVisibility, std::uint32_t currentStorage) const
    {
        return frame == currentFrame && visibility == currentVisibility && storage == currentStorage;
    }
};
// Build exact visibility/content epochs while the producer already visits slots.
template<class Visible, class State, class Items>
void appendVisible(Visible& visible, State& state, Items* items, std::uint32_t frame)
{
    const auto at=state.cursor++;
    items->visibleFrame=frame;
    if(at>=visible.size()) { visible.push_back(items);state.revisions.push_back(items->revision);state.changed=true; }
    else if(visible[at]!=items || state.revisions[at]!=items->revision) {
        visible[at]=items;state.revisions[at]=items->revision;state.changed=true;
    }
}
template<class Visible, class State> void finishVisible(Visible& visible, State& state)
{
    if(visible.size()!=state.cursor) {visible.resize(state.cursor);state.revisions.resize(state.cursor);state.changed=true;}
    if(state.changed)++state.version;
}
// Only lists which contained or will contain the changed instance are dirty.
template<class Lists> void invalidate(Lists& lists, unsigned before, unsigned after)
{
    if (before < 3) ++lists[before].revision;
    if (after < 3 && after != before) ++lists[after].revision;
}
template<class Items> bool needsUpload(const Items& items)
{
    return items.storageIndex == std::uint32_t(-1) || items.uploadedRevision != items.revision;
}
// Ordered exact identity, GPU allocation and count; no probabilistic hash.
// Compare while visiting records for upload, then revisit only allocations that
// an upload could have changed. Unchanged entries need no signature writes.
template<class Items> bool updateSignatureEntry(std::uint32_t* signature, const Items& items)
{
    const auto id = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(&items));
    const auto count = static_cast<std::uint32_t>(items.size());
    if (signature[0] == id && signature[1] == items.storageIndex && signature[2] == count)
        return false;
    signature[0] = id; signature[1] = items.storageIndex; signature[2] = count;
    return true;
}
template<class Visible, class Signature> bool updateSignature(const Visible& visible, Signature& saved, std::uint32_t& instanceCount)
{
    bool changed = saved.size() != visible.size()*3;
    saved.resize(visible.size()*3);
    auto* signature = saved.data();
    instanceCount = 0;
    for (const auto* items : visible)
    {
        changed |= updateSignatureEntry(signature, *items);
        signature += 3;
        instanceCount += static_cast<std::uint32_t>(items->size());
    }
    return changed;
}
}
