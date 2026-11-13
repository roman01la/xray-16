#pragma once
#include <cstdint>

namespace xray::detail_cache
{
constexpr unsigned SignatureWords = 4;
// Adjacent source records with adjacent destinations can share one dispatch.
// Storage pages are separate GPU bindings, so a range must stay within a page.
template<class Ranges> void coalesceRanges(Ranges& ranges)
{
    unsigned output = 0;
    for (unsigned input = 0; input < ranges.size(); input += 4)
    {
        const auto source = ranges[input];
        const auto count = ranges[input + 1];
        const auto destination = ranges[input + 2];
        if (output && ranges[output - 4] + ranges[output - 3] == source &&
            ranges[output - 2] + ranges[output - 3] == destination &&
            (ranges[output - 4] >> 21) == (source >> 21))
            ranges[output - 3] += count;
        else
        {
            ranges[output++] = source;
            ranges[output++] = count;
            ranges[output++] = destination;
            ranges[output++] = ranges[input + 3];
        }
    }
    ranges.resize(output);
}
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
    const auto count = static_cast<std::uint32_t>(items->size());
    if(at>=visible.size()) {
        visible.push_back(items);state.revisions.push_back(items->revision);state.counts.push_back(count);
        state.changed=true;state.membershipChanged=true;
    }
    else {
        const bool membershipChanged = visible[at]!=items || state.counts[at]!=count;
        if(membershipChanged || state.revisions[at]!=items->revision) {
            visible[at]=items;state.revisions[at]=items->revision;state.counts[at]=count;state.changed=true;
            state.membershipChanged |= membershipChanged;
        }
    }
}
template<class Visible, class State> void finishVisible(Visible& visible, State& state)
{
    if(visible.size()!=state.cursor) {
        visible.resize(state.cursor);state.revisions.resize(state.cursor);state.counts.resize(state.cursor);
        state.changed=true;state.membershipChanged=true;
    }
    if(state.changed)++state.version;
    if(state.membershipChanged)++state.membershipVersion;
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
    const auto id = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(&items));
    const auto low = static_cast<std::uint32_t>(id);
    const auto high = static_cast<std::uint32_t>(id >> 32);
    const auto count = static_cast<std::uint32_t>(items.size());
    if (signature[0] == low && signature[1] == high && signature[2] == items.storageIndex && signature[3] == count)
        return false;
    signature[0] = low; signature[1] = high; signature[2] = items.storageIndex; signature[3] = count;
    return true;
}
template<class Visible, class Signature> bool updateSignature(const Visible& visible, Signature& saved, std::uint32_t& instanceCount)
{
    bool changed = saved.size() != visible.size()*SignatureWords;
    saved.resize(visible.size()*SignatureWords);
    auto* signature = saved.data();
    instanceCount = 0;
    for (const auto* items : visible)
    {
        changed |= updateSignatureEntry(signature, *items);
        signature += SignatureWords;
        instanceCount += static_cast<std::uint32_t>(items->size());
    }
    return changed;
}
}
