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
template<class Visible, class Signature> bool updateSignature(const Visible& visible, Signature& saved, std::uint32_t& instanceCount)
{
    bool changed = saved.size() != visible.size()*3;
    saved.resize(visible.size()*3);
    auto* signature = saved.data();
    instanceCount = 0;
    for (const auto* items : visible)
    {
        const auto id = static_cast<std::uint32_t>(reinterpret_cast<std::uintptr_t>(items));
        const auto count = static_cast<std::uint32_t>(items->size());
        changed |= signature[0] != id || signature[1] != items->storageIndex || signature[2] != count;
        signature[0] = id; signature[1] = items->storageIndex; signature[2] = count; signature += 3;
        instanceCount += count;
    }
    return changed;
}
}
