#pragma once

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include <array>
#include <chrono>
#include <cstdint>
#include <deque>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

class CMemoryWriter;
class IReader;
class IWriter;

// Native-only endpoint. A fresh snapshot replaces the full previous set.
class AlifeHostInterests
{
public:
    struct Player
    {
        std::uint32_t id, life;
        float x, y, z, yaw;
        bool crouched;
    };

    struct NpcPose
    {
        std::uint16_t id, health;
        float x, y, z, yaw;
        std::uint32_t motion, timeMs, spawn;
        std::array<float, 3> center, half;
        std::string_view model;
    };
    struct Attack
    {
        std::uint64_t sequence, epoch;
        std::uint32_t tick, target, spawn, shooter, life, kind;
        float penetration, impulse;
        std::array<float, 3> power, direction, offset;
    };
    std::optional<Attack> nextAttack();
    void completeAttack(const Attack& attack, std::optional<std::uint16_t> health);
    static constexpr std::size_t MaxNpcs = 512;
    bool wantsNpcFrame() const;
    void publishNpcs(const NpcPose* npcs, std::size_t count);
    bool queueCorpse(const std::array<float, 3>& position, unsigned char count,
        const std::vector<unsigned char>& items);

    AlifeHostInterests() = default;
    AlifeHostInterests(const AlifeHostInterests&) = delete;
    AlifeHostInterests& operator=(const AlifeHostInterests&) = delete;
    ~AlifeHostInterests();
    bool open(const char* path, const char* outbox);
    static constexpr char WorldSaveName[] = "zone-alife-world";
    bool hasWorldCheckpoint() const { return m_worldGeneration != 0; }
    bool checkpointAdmitted() const { return m_approvedGeneration == m_worldGeneration; }
    bool hasStagedCorpses() const;
    void writeWorldCheckpoint(IWriter& stream) const;
    bool checkpointWriting() const { return m_worldWrite.valid(); }
    void startWorldCheckpoint(std::string path, std::unique_ptr<CMemoryWriter> snapshot);
    bool pollWorldCheckpoint();
    bool restoreWorldCheckpoint(IReader& stream);
    bool recoverFreshWorld();
    void refresh(std::string_view level);
    bool near(float x, float y, float z, float distance) const;
    void queueHit(std::uint32_t id, std::uint32_t life, std::uint32_t kind, float power,
        float penetration, std::string_view bone);
    std::size_t size() const { return m_count; }
    const Player* begin() const { return m_players.data(); }
    const Player* end() const { return begin() + m_count; }
    std::uint64_t epoch() const { return m_epoch; }
    std::uint64_t poseRevision() const { return m_poseRevision; }

private:
    static constexpr std::size_t MaxPlayers = 512;
    using HitPacket = std::array<unsigned char, 76>;
    void offerWorld(std::uint64_t epoch, std::uint64_t round);
    void flushHits();
    void flushCorpses();
    bool openOutbox(const char* path);
    bool openWorldFence();
    bool writeWorldFence(std::uint64_t generation);
    bool recoverCorpses(const std::vector<std::pair<std::uint64_t, std::uint64_t>>& committed);
    void acknowledgeCorpse(std::uint64_t host, std::uint64_t serial);
    void receiveAttack(const unsigned char* data, std::size_t length);
    void sendAttackResult(std::uint64_t sequence, std::optional<std::uint16_t> health) const;
    using Clock = std::chrono::steady_clock;
    int m_socket = -1;
    int m_socketLock = -1;
    int m_outbox = -1;
    bool m_worldReady = false;
    std::uint64_t m_admissionEpoch = 0;
    std::optional<std::uint64_t> m_approvedGeneration;
    std::uint64_t m_worldId = 0;
    std::uint64_t m_worldGeneration = 0;
    std::string m_path;
    std::string m_hitPath;
    std::string m_npcPath;
    std::optional<std::uint32_t> m_npcTick;
    std::deque<HitPacket> m_hits;
    std::deque<Attack> m_attacks;
    struct CorpsePacket
    {
        std::uint64_t host, serial;
        std::string level;
        std::vector<unsigned char> bytes;
        Clock::time_point sent;
        bool committed;
    };
    static bool persistCorpse(int outbox, const CorpsePacket& corpse);
    struct WorldWriteResult
    {
        std::uint64_t generation, serial;
        std::size_t retired;
        double milliseconds;
        bool saved;
    };
    std::future<WorldWriteResult> m_worldWrite;
    std::deque<CorpsePacket> m_corpses;
    std::vector<std::string> m_retiredCorpses;
    std::uint64_t m_corpseSerial{};
    struct AttackResult { std::uint64_t sequence{}; std::optional<std::uint16_t> health; };
    std::array<AttackResult, 2048> m_completed{};
    std::uint64_t m_attackHigh{};
    std::uint64_t m_hostEpoch{};
    std::uint64_t m_socketDevice = 0;
    std::uint64_t m_socketInode = 0;
    std::string m_level;
    std::array<Player, MaxPlayers> m_players;
    std::size_t m_count = 0;
    std::uint64_t m_epoch = 0;
    std::uint64_t m_poseRevision = 0;
    std::uint32_t m_tick = 0;
    bool m_haveSnapshot = false;
    Clock::time_point m_expires = Clock::time_point::min();
};
#endif
