#pragma once

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "alife_host_interests.h"
#include <cstdint>
#include <unordered_map>

class CLevel;
class IPureServer;
class CSE_Abstract;
struct SHit;

class AlifeHostTargets
{
public:
    void update(CLevel& level, IPureServer& server, const AlifeHostInterests& interests);
    void reportHit(std::uint16_t nativeId, const SHit& hit, AlifeHostInterests& interests) const;
    std::optional<std::uint16_t> applyAttack(CLevel& level, const AlifeHostInterests::Attack& attack) const;
    void observeDeath(CLevel& level, CSE_Abstract& entity);
    bool hasUnsettledCorpses() const { return !m_corpseCandidates.empty(); }
    void collectCorpses(CLevel& level, IPureServer& server, AlifeHostInterests& interests);

private:
    struct Target
    {
        std::uint32_t life;
        std::uint32_t seenUpdate;
        std::uint16_t nativeId;
    };
    std::uint64_t m_epoch = 0;
    std::uint64_t m_poseRevision = 0;
    std::uint32_t m_update = 0;
    std::unordered_map<std::uint32_t, Target> m_targets;
    struct CorpseCandidate { std::uint16_t id; std::uint32_t spawn, died; };
    std::deque<CorpseCandidate> m_corpseCandidates;
};
#endif
