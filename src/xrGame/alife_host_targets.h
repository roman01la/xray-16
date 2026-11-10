#pragma once

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "alife_host_interests.h"
#include "ZoneWeaponResult.h"
#include <cstdint>
#include <unordered_map>

class CLevel;
class CActor;
class CGameObject;
class IPureServer;
class xrServer;
class CSE_Abstract;
struct SHit;

class AlifeHostTargets
{
public:
    static void writeHitboxes(CGameObject& object, const Fvector& feet, std::vector<unsigned char>& packet);
    void update(CLevel& level, IPureServer& server, const AlifeHostInterests& interests);
    void stepMovement(CLevel& level, xrServer& server, AlifeHostInterests& interests);
    void serviceConditions(CLevel& level, AlifeHostInterests& interests);
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
        std::uint32_t sequence = 0, simulatedSequence = 0;
        u64 physicsStep = 0;
        bool movementReady = false;
        bool jumped = false;
        bool nativeCondition = false;
        struct ArmourSlot
        {
            AlifeHostInterests::ArmourItem desired;
            std::uint16_t id = std::uint16_t(-1);
            float lastReported = -1.f;
        };
        std::array<ArmourSlot, 2 + AlifeHostInterests::PlayerArmour::BeltCells> armour;
        std::optional<std::uint64_t> armourGeneration;
        AlifeHostInterests::PlayerWeapon desiredWeapon, spawnedWeapon;
        std::uint16_t weaponId = std::uint16_t(-1);
        std::optional<std::uint32_t> weaponRevision;
        struct AmmoSlot
        {
            std::string section;
            std::uint16_t nativeId = std::uint16_t(-1);
            std::optional<std::uint32_t> revision;
        };
        std::unordered_map<std::string, AmmoSlot> reserve;
        std::optional<std::uint64_t> reserveGeneration;
        bool weaponRulesPending = false;
        xray::zone_condition::Replay conditionReplay;
        xray::zone_weapon_action::Replay weaponReplay;
        u32 weaponActionFrame = 0;
    };
    void serviceWeapons(CLevel& level, xrServer& server, AlifeHostInterests& interests);
    static std::optional<xray::zone_weapon_action::WeaponResult> captureWeapon(CActor& actor, const Target& target);
    static bool armourReady(CLevel& level, CActor& actor, const Target& target);
    static void reconcileArmour(CLevel& level, xrServer& server, CActor& actor, Target& target);
    static std::optional<AlifeHostInterests::ArmourImpact> previewArmour(CLevel& level, CActor& actor,
        const Target& target, std::uint32_t kind, float power, u16 bone = u16(-1), float penetration = 0.f);
    static void reconcileReserveAmmo(CLevel& level, xrServer& server, CActor& actor, Target& target);
    static void reconcileWeapon(CLevel& level, xrServer& server, CActor& actor, Target& target, AlifeHostInterests& interests);
    std::uint64_t m_epoch = 0;
    std::uint64_t m_poseRevision = 0;
    std::uint32_t m_update = 0;
    std::unordered_map<std::uint32_t, Target> m_targets;
    std::vector<AlifeHostInterests::PlayerMovement> m_movementPoses;
    std::vector<unsigned char> m_hitboxPacket;
    struct CorpseCandidate { std::uint16_t id; std::uint32_t spawn, died; };
    std::deque<CorpseCandidate> m_corpseCandidates;
};
#endif
