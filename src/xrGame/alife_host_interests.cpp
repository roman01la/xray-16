#include "StdAfx.h"
#include "ZonePendingSnapshots.h"
#include "alife_host_interests.h"

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "CombatRules.h"
#include "ZoneHitDelivery.h"
#include "WeaponAmmo.h"
#include "WeaponMagazined.h"
#include <algorithm>
#include "multiplayer/NpcPresentation.h"
#include "xrSound/SoundPlaybackObserver.h"
#include <cerrno>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <filesystem>
#include "xrServerEntities/alife_space.h"
#include <random>
#include <mutex>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include <unordered_map>

namespace
{
struct ObservedSound
{
    std::string name;
    Fvector position;
    float volume, frequency, range;
    std::uint32_t loop = 0;
};
struct ObservedLoop
{
    ObservedSound sound;
    std::chrono::steady_clock::time_point updated;
};
std::mutex observedSoundsMutex;
std::deque<ObservedSound> observedSounds;
std::unordered_map<const void*, ObservedLoop> observedLoops;
std::uint32_t loopSequence = static_cast<std::uint32_t>(
    std::chrono::steady_clock::now().time_since_epoch().count());

void observeSound(const char* name, const CSound_params& params, const void* emitter)
{
    if (!name || !_valid(params.position) || !std::isfinite(params.volume) || !std::isfinite(params.freq) ||
        !std::isfinite(params.max_distance) || params.max_distance <= 0.f)
        return;
    const std::string_view path(name);
    if (path.empty() || path.size() > 127 ||
        path.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-\\/ ") != path.npos)
        return;
    std::lock_guard lock(observedSoundsMutex);
    if (emitter)
    {
        const auto now = std::chrono::steady_clock::now();
        auto found = observedLoops.find(emitter);
        if (found == observedLoops.end())
        {
            if (observedLoops.size() >= 128) return;
            found = observedLoops.try_emplace(emitter).first;
        }
        auto& loop = found->second;
        if (loop.sound.name != path)
        {
            loop.sound.name = path;
            if (++loopSequence == 0) ++loopSequence;
            loop.sound.loop = loopSequence;
        }
        loop.sound.position = params.position;
        loop.sound.volume = params.volume;
        loop.sound.frequency = params.freq;
        loop.sound.range = params.max_distance;
        loop.updated = now;
        return;
    }
    if (observedSounds.size() >= 128)
        observedSounds.pop_front();
    observedSounds.push_back({std::string(path), params.position, params.volume, params.freq, params.max_distance});
}

constexpr std::size_t CorpseHeader = 41;
constexpr std::size_t MaxCorpseBytes = 8192;
constexpr std::size_t MaxCorpses = 64;
constexpr std::size_t MaxLevelBytes = 22;
// Keep in sync with MAX_PENETRATION in server/src/ballistics.rs.
constexpr float MaxPenetration = 1000.f;
constexpr char PendingCorpse[] = ".pending";
constexpr char WorldFence[] = "world-fence";
constexpr char PendingWorldFence[] = ".world-fence.tmp";
constexpr u32 WorldChunk = 0x5a415731;

std::uint32_t readWord(const unsigned char* p)
{
    return p[0] | (std::uint32_t(p[1]) << 8) | (std::uint32_t(p[2]) << 16) | (std::uint32_t(p[3]) << 24);
}
std::uint64_t readWide(const unsigned char* p)
{
    return readWord(p) | (std::uint64_t(readWord(p + 4)) << 32);
}
float readScalar(const unsigned char* p)
{
    const auto bits = readWord(p);
    float value;
    std::memcpy(&value, &bits, sizeof(value));
    return value;
}
void writeWord(unsigned char* p, std::uint32_t word)
{
    for (std::size_t i = 0; i < sizeof(word); ++i)
        p[i] = static_cast<unsigned char>(word >> (8 * i));
}
void writeWide(unsigned char* p, std::uint64_t word)
{
    writeWord(p, static_cast<std::uint32_t>(word));
    writeWord(p + 4, static_cast<std::uint32_t>(word >> 32));
}

socklen_t socketAddressLength(const std::string& path)
{
    // A full sockaddr_un leaves trailing zeros in the sender's pathname on Darwin.
    return static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + path.size() + 1);
}

std::string corpseFileName(std::uint64_t host, std::uint64_t serial)
{
    char name[48];
    std::snprintf(name, sizeof(name), "%016llx-%016llx.corpse",
        static_cast<unsigned long long>(host), static_cast<unsigned long long>(serial));
    return name;
}

bool validOutboxLevel(std::string_view level)
{
    return !level.empty() && level.size() <= MaxLevelBytes &&
        level.find_first_not_of("abcdefghijklmnopqrstuvwxyz0123456789_") == std::string_view::npos;
}

template <typename Buffer, typename Transfer>
bool transferFile(int fd, Buffer* buffer, std::size_t length, Transfer transfer)
{
    while (length)
    {
        const auto count = transfer(fd, buffer, length);
        if (count < 0 && errno == EINTR)
            continue;
        if (count <= 0)
            return false;
        buffer += count;
        length -= static_cast<std::size_t>(count);
    }
    return true;
}

template <typename Write>
bool replaceSyncedFile(int directory, const char* temporary, const char* name, Write write)
{
    if (::unlinkat(directory, temporary, 0) != 0 && errno != ENOENT)
        return false;
    const int file = ::openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (file < 0)
        return false;
    const bool written = write(file) && ::fsync(file) == 0;
    const bool closed = ::close(file) == 0;
    if (written && closed && ::renameat(directory, temporary, directory, name) == 0)
        return true;
    ::unlinkat(directory, temporary, 0);
    return false;
}

bool persistWorldFence(int directory, std::uint64_t worldId, std::uint64_t generation)
{
    std::array<unsigned char, 20> bytes{};
    std::memcpy(bytes.data(), "ZAW1", 4);
    writeWide(bytes.data() + 4, worldId);
    writeWide(bytes.data() + 12, generation);
    return replaceSyncedFile(directory, PendingWorldFence, WorldFence,
        [&](int file) { return transferFile(file, bytes.data(), bytes.size(), ::write); }) &&
        ::fsync(directory) == 0;
}

bool persistWorldSave(const std::filesystem::path& path, CMemoryWriter& snapshot)
{
    const auto sourceBytes = static_cast<u32>(snapshot.size());
    std::vector<unsigned char> compressed(rtc_csize(sourceBytes));
    const auto compressedBytes = rtc_compress(compressed.data(), compressed.size(), snapshot.pointer(), sourceBytes);
    if (!compressedBytes)
        return false;
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error)
        return false;
    const int directory = ::open(path.parent_path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0)
        return false;
    const auto name = path.filename();
    const auto temporary = name.string() + ".tmp";
    const std::array<u32, 3> header{u32(-1), ALIFE_VERSION, sourceBytes};
    const bool saved = replaceSyncedFile(directory, temporary.c_str(), name.c_str(), [&](int file) {
        return transferFile(file, header.data(), sizeof(header), ::write) &&
            transferFile(file, compressed.data(), compressedBytes, ::write);
    }) && ::fsync(directory) == 0;
    ::close(directory);
    return saved;
}

bool privateOwned(const struct stat& state)
{
    return state.st_uid == ::geteuid() && (state.st_mode & 0077) == 0;
}

bool removeStaleSocket(const std::string& endpoint, const sockaddr_un& address)
{
    struct stat state{};
    if (::lstat(endpoint.c_str(), &state) != 0 || !S_ISSOCK(state.st_mode) || state.st_uid != ::geteuid())
        return false;
    const int probe = ::socket(AF_UNIX, SOCK_DGRAM, 0);
    if (probe < 0)
        return false;
    const bool stale = ::connect(probe, reinterpret_cast<const sockaddr*>(&address), socketAddressLength(endpoint)) < 0
        && errno == ECONNREFUSED;
    ::close(probe);
    return stale && ::unlink(endpoint.c_str()) == 0;
}
}

AlifeHostInterests::~AlifeHostInterests()
{
    set_sound_playback_observer(nullptr);
    {
        std::lock_guard lock(observedSoundsMutex);
        observedSounds.clear();
        observedLoops.clear();
    }
    if (m_worldWrite.valid())
        m_worldWrite.wait();
    if (m_socket >= 0)
        ::close(m_socket);
    struct stat state{};
    if (!m_path.empty() && ::lstat(m_path.c_str(), &state) == 0 && S_ISSOCK(state.st_mode) &&
        static_cast<std::uint64_t>(state.st_dev) == m_socketDevice &&
        static_cast<std::uint64_t>(state.st_ino) == m_socketInode)
        ::unlink(m_path.c_str());
    if (m_socketLock >= 0)
        ::close(m_socketLock);
    if (m_outbox >= 0)
        ::close(m_outbox);
}

bool AlifeHostInterests::open(const char* path, const char* outbox)
{
    sockaddr_un address{};
    if (!path || path[0] != '/' || std::strlen(path) >= sizeof(address.sun_path))
        return false;
    const std::string endpoint(path);
    m_hitPath = endpoint + ".hits";
    m_npcPath = endpoint + ".npcs";
    if (m_hitPath.size() >= sizeof(address.sun_path))
        return false;
    const auto parent = endpoint.substr(0, endpoint.rfind('/'));
    struct stat state{};
    if (::stat(parent.c_str(), &state) != 0 || !S_ISDIR(state.st_mode) || !privateOwned(state))
        return false;
    m_socketLock = ::open((endpoint + ".lock").c_str(), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (m_socketLock < 0 || ::fstat(m_socketLock, &state) != 0 || !S_ISREG(state.st_mode) ||
        !privateOwned(state) || ::flock(m_socketLock, LOCK_EX | LOCK_NB) != 0)
    {
        Msg("! Could not acquire the native A-Life socket lock for '%s'", path);
        return false;
    }
    if (!openOutbox(outbox))
    {
        Msg("! Could not open or recover the native corpse outbox '%s'", outbox ? outbox : "");
        return false;
    }

    if (!openWorldFence())
    {
        Msg("! Could not recover the native A-Life world fence in '%s'", outbox);
        return false;
    }

    m_socket = ::socket(AF_UNIX, SOCK_DGRAM, 0);
    const int receiveBuffer = 64 * 1024;
    const int sendBuffer = 128 * 1024; // Native weapon results can reach 64 KiB.
    if (m_socket < 0 || ::fcntl(m_socket, F_SETFD, FD_CLOEXEC) != 0 ||
        ::setsockopt(m_socket, SOL_SOCKET, SO_RCVBUF, &receiveBuffer, sizeof(receiveBuffer)) != 0 ||
        ::setsockopt(m_socket, SOL_SOCKET, SO_SNDBUF, &sendBuffer, sizeof(sendBuffer)) != 0)
        return false;
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path, endpoint.size() + 1);
    const auto bindSocket = [&]() {
        return ::bind(m_socket, reinterpret_cast<const sockaddr*>(&address), socketAddressLength(endpoint));
    };
    if (bindSocket() != 0 && (errno != EADDRINUSE || !removeStaleSocket(endpoint, address) || bindSocket() != 0))
    {
        Msg("! Could not bind the native A-Life socket '%s': %s", path, std::strerror(errno));
        return false;
    }
    if (::lstat(path, &state) != 0 || !S_ISSOCK(state.st_mode))
        return false;
    m_path = endpoint;
    std::random_device random;
    do
        m_hostEpoch = (static_cast<std::uint64_t>(random()) << 32) | static_cast<std::uint32_t>(random());
    while (!m_hostEpoch);
    m_socketDevice = state.st_dev;
    m_socketInode = state.st_ino;
    if (::chmod(path, 0600) != 0) return false;
    set_sound_playback_observer(observeSound);
    return true;
}

bool AlifeHostInterests::openOutbox(const char* path)
{
    if (!path || path[0] != '/' || (::mkdir(path, 0700) != 0 && errno != EEXIST))
        return false;
    m_outbox = ::open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct stat state{};
    if (m_outbox < 0 || ::fstat(m_outbox, &state) != 0 || !privateOwned(state) ||
        ::flock(m_outbox, LOCK_EX | LOCK_NB) != 0)
        return false;
    if (::unlinkat(m_outbox, PendingCorpse, 0) != 0 && errno != ENOENT)
        return false;

    const int listing = ::dup(m_outbox);
    if (listing < 0)
        return false;
    auto* entries = ::fdopendir(listing);
    if (!entries)
    {
        ::close(listing);
        return false;
    }
    bool valid = true;
    for (;;)
    {
        errno = 0;
        const auto* entry = ::readdir(entries);
        if (!entry)
        {
            valid = errno == 0;
            break;
        }
        const std::string_view name(entry->d_name);
        if (name.size() < 7 || name.substr(name.size() - 7) != ".corpse")
            continue;
        const int file = ::openat(m_outbox, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
        valid = file >= 0 && ::fstat(file, &state) == 0 && S_ISREG(state.st_mode) && privateOwned(state) &&
            state.st_size >= static_cast<off_t>(2 + CorpseHeader) &&
            state.st_size <= static_cast<off_t>(1 + MaxLevelBytes + MaxCorpseBytes) &&
            m_corpses.size() < MaxCorpses;
        std::vector<unsigned char> record;
        if (valid)
        {
            record.resize(static_cast<std::size_t>(state.st_size));
            valid = transferFile(file, record.data(), record.size(), ::read);
        }
        if (file >= 0)
            ::close(file);
        if (!valid)
            break;
        const auto levelSize = static_cast<std::size_t>(record.front());
        if (!(1 <= levelSize && levelSize <= MaxLevelBytes) ||
            record.size() < 1 + levelSize + CorpseHeader || record.size() > 1 + levelSize + MaxCorpseBytes)
        {
            valid = false;
            break;
        }
        const std::string_view level(reinterpret_cast<const char*>(record.data() + 1), levelSize);
        const auto* bytes = record.data() + 1 + levelSize;
        const auto host = readWide(bytes + 12);
        const auto serial = readWide(bytes + 20);
        if (!validOutboxLevel(level) || std::memcmp(bytes, "ZAL1", 4) != 0 || readWide(bytes + 4) ||
            !host || !serial || !bytes[40] || bytes[40] > 64 || corpseFileName(host, serial) != name)
        {
            valid = false;
            break;
        }
        const auto* end = record.data() + record.size();
        m_corpses.push_back({host, serial, std::string(level), {bytes, end}, {}, false});
    }
    ::closedir(entries);
    return valid;
}

bool AlifeHostInterests::openWorldFence()
{
    const int file = ::openat(m_outbox, WorldFence, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (file < 0)
    {
        if (errno != ENOENT)
            return false;
        // Resolve pending records from an earlier unfenced host before migrating.
        if (!m_corpses.empty())
            return false;
        std::random_device random;
        do
            m_worldId = (static_cast<std::uint64_t>(random()) << 32) | static_cast<std::uint32_t>(random());
        while (!m_worldId);
        return writeWorldFence(0);
    }

    std::array<unsigned char, 20> bytes{};
    struct stat state{};
    const bool read = ::fstat(file, &state) == 0 && S_ISREG(state.st_mode) &&
        privateOwned(state) && state.st_size == static_cast<off_t>(bytes.size()) &&
        transferFile(file, bytes.data(), bytes.size(), ::read);
    ::close(file);
    if (!read || std::memcmp(bytes.data(), "ZAW1", 4) != 0)
        return false;
    m_worldId = readWide(bytes.data() + 4);
    m_worldGeneration = readWide(bytes.data() + 12);
    return m_worldId != 0;
}

bool AlifeHostInterests::writeWorldFence(std::uint64_t generation)
{
    if (!persistWorldFence(m_outbox, m_worldId, generation))
        return false;
    m_worldGeneration = generation;
    return true;
}

bool AlifeHostInterests::hasStagedCorpses() const
{
    return std::any_of(m_corpses.begin(), m_corpses.end(), [](const auto& corpse) { return !corpse.committed; });
}

void AlifeHostInterests::writeWorldCheckpoint(IWriter& stream) const
{
    stream.open_chunk(WorldChunk);
    stream.w_u64(m_worldId);
    stream.w_u64(m_worldGeneration + 1);
    stream.w_u32(static_cast<u32>(m_corpses.size()));
    for (const auto& corpse : m_corpses)
    {
        stream.w_u64(corpse.host);
        stream.w_u64(corpse.serial);
    }
    stream.close_chunk();
}

void AlifeHostInterests::startWorldCheckpoint(std::string path, std::unique_ptr<CMemoryWriter> snapshot)
{
    std::vector<CorpsePacket> staged;
    for (const auto& corpse : m_corpses)
        if (!corpse.committed)
            staged.push_back(corpse);
    try
    {
        m_worldWrite = std::async(std::launch::async,
            [path = std::move(path), snapshot = std::move(snapshot), staged = std::move(staged),
                retired = m_retiredCorpses, outbox = m_outbox, worldId = m_worldId,
                generation = m_worldGeneration + 1, serial = m_corpseSerial]() {
                const auto start = Clock::now();
                const bool saved = [&]() {
                    // Retire acknowledged records before writing replacements. At
                    // most MaxCorpses files can remain after an interrupted write.
                    for (const auto& name : retired)
                        if (::unlinkat(outbox, name.c_str(), 0) != 0 && errno != ENOENT)
                            return false;
                    for (const auto& corpse : staged)
                        if (!persistCorpse(outbox, corpse))
                            return false;
                    if ((!staged.empty() || !retired.empty()) && ::fsync(outbox) != 0)
                        return false;
                    return persistWorldSave(path, *snapshot) && persistWorldFence(outbox, worldId, generation);
                }();
                const auto milliseconds = std::chrono::duration<double, std::milli>(Clock::now() - start).count();
                return WorldWriteResult{generation, serial, retired.size(), milliseconds, saved};
            });
    }
    catch (const std::system_error& error)
    {
        Msg("! Could not start A-Life checkpoint writer: %s", error.what());
    }
}

bool AlifeHostInterests::pollWorldCheckpoint()
{
    if (!m_worldWrite.valid() || m_worldWrite.wait_for(std::chrono::milliseconds(0)) != std::future_status::ready)
        return false;
    const auto result = m_worldWrite.get();
    if (!result.saved)
    {
        Msg("! A-Life checkpoint write failed after %.2f ms", result.milliseconds);
        return false;
    }
    m_worldGeneration = result.generation;
    for (auto& corpse : m_corpses)
        if (corpse.host == m_hostEpoch && corpse.serial <= result.serial)
            corpse.committed = true;
    m_retiredCorpses.erase(m_retiredCorpses.begin(), m_retiredCorpses.begin() + result.retired);
    Msg("* A-Life checkpoint %llu persisted off-thread in %.2f ms",
        static_cast<unsigned long long>(result.generation), result.milliseconds);
    return true;
}

bool AlifeHostInterests::restoreWorldCheckpoint(IReader& stream)
{
    auto* checkpoint = stream.open_chunk(WorldChunk);
    if (!checkpoint)
        return false;
    const auto size = checkpoint->length();
    bool valid = size >= 20 && (size - 20) % 16 == 0 && (size - 20) / 16 <= MaxCorpses;
    std::vector<std::pair<std::uint64_t, std::uint64_t>> committed;
    std::uint64_t generation = 0;
    if (valid)
    {
        const auto worldId = checkpoint->r_u64();
        generation = checkpoint->r_u64();
        const auto count = checkpoint->r_u32();
        valid = worldId == m_worldId && generation && generation >= m_worldGeneration &&
            generation - m_worldGeneration <= 1 && count == (size - 20) / 16;
        if (valid)
            for (u32 i = 0; i < count; ++i)
            {
                const auto host = checkpoint->r_u64();
                const auto serial = checkpoint->r_u64();
                committed.emplace_back(host, serial);
            }
    }
    checkpoint->close();
    if (!valid || (generation != m_worldGeneration && !writeWorldFence(generation)))
        return false;
    return recoverCorpses(committed);
}

bool AlifeHostInterests::recoverFreshWorld()
{
    return !hasWorldCheckpoint() && recoverCorpses({});
}

bool AlifeHostInterests::recoverCorpses(
    const std::vector<std::pair<std::uint64_t, std::uint64_t>>& committed)
{
    // Keep files outside this checkpoint on disk until Rust admits the world.
    // Restoring an older pair must not delete records belonging to a newer save.
    for (auto corpse = m_corpses.begin(); corpse != m_corpses.end();)
    {
        const auto key = std::make_pair(corpse->host, corpse->serial);
        if (std::find(committed.begin(), committed.end(), key) != committed.end())
        {
            corpse->committed = true;
            ++corpse;
            continue;
        }
        m_retiredCorpses.push_back(corpseFileName(corpse->host, corpse->serial));
        corpse = m_corpses.erase(corpse);
    }
    m_worldReady = true;
    return true;
}

void AlifeHostInterests::offerWorld(std::uint64_t epoch, std::uint64_t round)
{
    if (!m_worldReady || !epoch || !round || !validOutboxLevel(m_level))
        return;
    if (m_admissionEpoch != epoch)
    {
        m_admissionEpoch = epoch;
        m_approvedGeneration.reset();
        m_haveSnapshot = false;
        m_campaignClock.reset();
        if (m_count)
            ++m_poseRevision;
        m_count = 0;
        m_hits.clear();
        m_attacks.clear();
        m_conditions.clear();
        m_weaponActions.clear();
        m_armour.clear();
        m_weapons.clear();
    }

    std::array<unsigned char, 66> offer{};
    std::memcpy(offer.data(), "ZWO1", 4);
    writeWide(offer.data() + 4, epoch);
    writeWide(offer.data() + 12, round);
    writeWide(offer.data() + 20, m_hostEpoch);
    writeWide(offer.data() + 28, m_worldId);
    writeWide(offer.data() + 36, m_worldGeneration);
    std::memcpy(offer.data() + 44, m_level.data(), m_level.size());
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    ::sendto(m_socket, offer.data(), offer.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath));
}

void AlifeHostInterests::refresh(std::string_view level)
{
    const auto now = Clock::now();
    if (m_level != level || now >= m_expires)
    {
        clearPendingLoadouts();
        if (m_count)
            ++m_poseRevision;
        m_count = 0;
        // A snapshot lease stops new simulation inputs, not delivery of hits
        // already produced for this epoch/life. Retain them for acknowledgement.
        m_attacks.clear();
        m_conditions.clear();
        m_weaponActions.clear();
    }
    if (m_level != level)
    {
        m_hits.clear(); // Map/epoch changes still retire their old delivery scope.
        m_haveSnapshot = false;
        m_approvedGeneration.reset();
    }
    m_level = level;
    constexpr std::size_t LevelEnd = 32, Header = 40, ActorBytes = 56;
    // One spare byte makes oversized datagrams fail the exact length check.
    std::array<unsigned char, std::max<std::size_t>(Header + ActorBytes * MaxPlayers, 32060) + 1> bytes;
    std::array<Player, MaxPlayers> players;
    for (unsigned attempt = 0; attempt < 128; ++attempt)
    {
        sockaddr_un from{};
        socklen_t addressLength = sizeof(from);
        const auto length = ::recvfrom(m_socket, bytes.data(), bytes.size(), MSG_DONTWAIT,
            reinterpret_cast<sockaddr*>(&from), &addressLength);
        if (length < 0)
            break;
        if (from.sun_family != AF_UNIX || std::strncmp(from.sun_path, m_hitPath.c_str(), sizeof(from.sun_path)) != 0)
            continue;
        if (length == 20 && std::memcmp(bytes.data(), "ZWF1", 4) == 0)
        {
            offerWorld(readWide(bytes.data() + 4), readWide(bytes.data() + 12));
            continue;
        }
        if (length == 36 && std::memcmp(bytes.data(), "ZWR1", 4) == 0)
        {
            if (m_admissionEpoch && readWide(bytes.data() + 4) == m_admissionEpoch &&
                readWide(bytes.data() + 12) == m_hostEpoch && readWide(bytes.data() + 20) == m_worldId &&
                readWide(bytes.data() + 28) == m_worldGeneration)
            {
                if (!m_approvedGeneration)
                    Msg("* Zone A-Life world admitted at checkpoint %llu", static_cast<unsigned long long>(m_worldGeneration));
                m_approvedGeneration = m_worldGeneration;
            }
            continue;
        }
        if (length == 28 && std::memcmp(bytes.data(), "ZHA1", 4) == 0)
        {
            const auto sequence = readWide(bytes.data() + 20);
            if (m_approvedGeneration && readWide(bytes.data() + 4) == m_epoch &&
                readWide(bytes.data() + 12) == m_hostEpoch && sequence <= m_hitSequence)
                while (!m_hits.empty() && m_hits.front().sequence <= sequence)
                    m_hits.pop_front();
            continue;
        }
        if (!m_approvedGeneration)
            continue;
        if (length >= 60 && (std::memcmp(bytes.data(), "ZCT1", 4) == 0 || std::memcmp(bytes.data(), "ZCI1", 4) == 0 || std::memcmp(bytes.data(), "ZCM1", 4) == 0 || std::memcmp(bytes.data(), "ZCH1", 4) == 0 || std::memcmp(bytes.data(), "ZCF1", 4) == 0 || std::memcmp(bytes.data(), "ZCB1", 4) == 0))
        {
            if (m_conditions.size() < MaxPlayers)
                if (auto request = xray::zone_condition::request(bytes.data(), length);
                    request && request->epoch == m_admissionEpoch && request->boot == m_hostEpoch)
                    m_conditions.push_back(std::move(*request));
            continue;
        }
        if (length == xray::zone_weapon_action::Header && std::memcmp(bytes.data(), "ZWQ1", 4) == 0)
        {
            if (auto request = xray::zone_weapon_action::decode(bytes.data(), length);
                request && request->fence.epoch == m_admissionEpoch && request->fence.boot == m_hostEpoch)
                m_weaponActions.push(*request, MaxPlayers);
            continue;
        }
        if (length >= 29 && std::memcmp(bytes.data(), "ZAW3", 4) == 0)
        {
            receiveWeapon(bytes.data(), length);
            continue;
        }
        if ((length >= 29 && std::memcmp(bytes.data(), "ZAG2", 4) == 0) ||
            (length >= 37 && std::memcmp(bytes.data(), "ZAG3", 4) == 0))
        {
            receiveArmour(bytes.data(), length);
            continue;
        }
        if (length == 32 && std::memcmp(bytes.data(), "ZAT1", 4) == 0)
        {
            const auto time = readWide(bytes.data() + 20);
            const auto factor = readScalar(bytes.data() + 28);
            if (readWide(bytes.data() + 4) == m_admissionEpoch &&
                readWide(bytes.data() + 12) == m_hostEpoch && time < 1000000000000000ULL &&
                factor >= 0.f && factor <= 1000.f)
                m_campaignClock = WorldClock{time, factor};
            continue;
        }
        if ((length == 96 && std::memcmp(bytes.data(), "ZAS1", 4) == 0) ||
            (length == 124 && std::memcmp(bytes.data(), "ZAS2", 4) == 0))
        {
            receiveAttack(bytes.data(), length);
            continue;
        }
        if (length == 28 && std::memcmp(bytes.data(), "ZAC1", 4) == 0)
        {
            if (readWide(bytes.data() + 4) == m_admissionEpoch)
                acknowledgeCorpse(readWide(bytes.data() + 12), readWide(bytes.data() + 20));
            continue;
        }
        if (length < Header || level.size() > LevelEnd - 10)
            continue;
        const bool nativeActor = std::memcmp(bytes.data(), "ZAI5", 4) == 0;
        const bool nativeMovement = nativeActor || std::memcmp(bytes.data(), "ZAI3", 4) == 0;
        if (!nativeMovement && std::memcmp(bytes.data(), "ZAI2", 4) != 0)
            continue;
        const auto playerBytes = nativeActor ? ActorBytes : (nativeMovement ? 40 : 28);
        const auto count = bytes[8] | (std::size_t(bytes[9]) << 8);
        const auto* name = reinterpret_cast<const char*>(bytes.data() + 10);
        if (count > MaxPlayers || std::size_t(length) != Header + playerBytes * count ||
            std::string_view(name, level.size()) != level ||
            std::any_of(bytes.begin() + 10 + level.size(), bytes.begin() + LevelEnd, [](auto byte) { return byte != 0; }))
            continue;
        const auto tick = readWord(bytes.data() + 4);
        const auto epoch = readWide(bytes.data() + 32);
        if (epoch != m_admissionEpoch ||
            (m_haveSnapshot && epoch == m_epoch && (tick == m_tick || tick - m_tick >= 0x80000000u)))
            continue;
        bool valid = true;
        for (std::size_t i = 0; i < count; ++i)
        {
            const auto* p = bytes.data() + Header + i * playerBytes;
            const auto stance = readWord(p + 24);
            players[i] = {readWord(p), readWord(p + 4), readScalar(p + 8), readScalar(p + 12), readScalar(p + 16),
                readScalar(p + 20), stance != 0, 0, 0, 1.f, 0.f, 1.f, 1.f};
            if (nativeMovement)
            {
                players[i].sequence = readWord(p + 28);
                players[i].controls = readWord(p + 32);
                players[i].speedScale = readScalar(p + 36);
            }
            if (nativeActor)
            {
                players[i].pitch = readScalar(p + 40);
                players[i].health = readScalar(p + 44);
                players[i].power = readScalar(p + 48);
                if (readWord(p + 52) > 1) { valid = false; break; }
                players[i].nativeCondition = readWord(p + 52) != 0;
            }
            const auto& point = players[i];
            if (!point.id || stance > 1 || point.controls > 255 ||
                !(std::abs(point.pitch) <= 1.55f && point.health > 0.f && point.health <= 1.f &&
                    point.power >= 0.f && point.power <= 1.f) ||
                !(point.speedScale >= 0.f && point.speedScale <= 1.f) || !(point.yaw >= 0.f && point.yaw <= 6.283186f &&
                    std::abs(point.x) <= 100000.f && std::abs(point.y) <= 100000.f && std::abs(point.z) <= 100000.f))
            {
                valid = false;
                break;
            }
        }
        if (!valid)
            continue;
        const auto end = players.begin() + count;
        std::sort(players.begin(), end, [](const auto& a, const auto& b) { return a.id < b.id; });
        if (std::adjacent_find(players.begin(), end, [](const auto& a, const auto& b) { return a.id == b.id; }) != end)
            continue;
        std::sort(players.begin(), end, [](const auto& a, const auto& b) { return a.x < b.x; });
        ++m_poseRevision;
        m_count = count;
        std::copy_n(players.begin(), count, m_players.begin());
        m_tick = tick;
        if (nativeMovement && !m_nativeMovement)
            Msg("* Zone X-Ray player movement enabled");
        m_nativeMovement = nativeMovement;
        if (epoch != m_epoch)
        {
            m_hits.clear();
            m_npcTick.reset();
            m_movementTick.reset();
            m_environmentTick.reset();
            m_completed.fill({});
            m_attackHigh = 0;
        }
        m_epoch = epoch;
        m_haveSnapshot = true;
        m_expires = now + std::chrono::milliseconds(1200);
    }
    flushHits();
    flushCorpses();
}

bool AlifeHostInterests::queueCorpse(const std::array<float, 3>& position, unsigned char count,
    const std::vector<unsigned char>& items)
{
    if (!count || count > 64 || items.size() > MaxCorpseBytes - CorpseHeader ||
        !validOutboxLevel(m_level) || m_corpses.size() >= MaxCorpses || !m_approvedGeneration)
        return false;
    CorpsePacket corpse{m_hostEpoch, ++m_corpseSerial, m_level, std::vector<unsigned char>(CorpseHeader), {}, false};
    auto* bytes = corpse.bytes.data();
    std::memcpy(bytes, "ZAL1", 4);
    writeWide(bytes + 12, m_hostEpoch);
    writeWide(bytes + 20, corpse.serial);
    for (unsigned i = 0; i < position.size(); ++i)
    {
        std::uint32_t bits;
        std::memcpy(&bits, &position[i], sizeof(bits));
        writeWord(bytes + 28 + 4 * i, bits);
    }
    bytes[40] = count;
    corpse.bytes.insert(corpse.bytes.end(), items.begin(), items.end());

    // Transfers stay in memory until the worker writes them together
    // with the checkpoint that removed the original inventory.
    m_corpses.push_back(std::move(corpse));
    return true;
}

bool AlifeHostInterests::persistCorpse(int outbox, const CorpsePacket& corpse)
{
    const auto name = corpseFileName(corpse.host, corpse.serial);
    const auto levelSize = static_cast<unsigned char>(corpse.level.size());
    return replaceSyncedFile(outbox, PendingCorpse, name.c_str(), [&](int file) {
        return transferFile(file, &levelSize, 1, ::write) &&
            transferFile(file, corpse.level.data(), levelSize, ::write) &&
            transferFile(file, corpse.bytes.data(), corpse.bytes.size(), ::write);
    });
}

void AlifeHostInterests::acknowledgeCorpse(std::uint64_t host, std::uint64_t serial)
{
    const auto pending = std::find_if(m_corpses.begin(), m_corpses.end(),
        [host, serial](const auto& corpse) { return corpse.committed && corpse.host == host && corpse.serial == serial; });
    if (pending == m_corpses.end())
        return;
    // SQLite committed already. A restart before unlink can safely resend.
    m_retiredCorpses.push_back(corpseFileName(host, serial));
    m_corpses.erase(pending);
}

void AlifeHostInterests::flushCorpses()
{
    const auto now = Clock::now();
    if (!checkpointAdmitted() || !m_haveSnapshot || now >= m_expires || m_corpses.empty())
        return;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    std::array<unsigned char, MaxCorpseBytes + 8> packet;
    unsigned sent = 0;
    for (auto& corpse : m_corpses)
    {
        if (!corpse.committed || corpse.level != m_level || now - corpse.sent < std::chrono::milliseconds(250))
            continue;
        std::copy(corpse.bytes.begin(), corpse.bytes.end(), packet.begin());
        writeWide(packet.data() + 4, m_epoch);
        writeWide(packet.data() + corpse.bytes.size(), m_hostEpoch);
        if (::sendto(m_socket, packet.data(), corpse.bytes.size() + 8, MSG_DONTWAIT,
                reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath)) < 0)
            break;
        corpse.sent = now;
        if (++sent == 4)
            break;
    }
}

void AlifeHostInterests::receiveArmour(const unsigned char* data, std::size_t length)
{
    PlayerArmour armour{readWord(data + 20), readWord(data + 24), {}, {}};
    std::size_t cursor = 28;
    if (data[3] == '3')
    {
        armour.generation = readWide(data + cursor);
        cursor += 8;
        if (*armour.generation > 9007199254740991ULL)
            return;
    }
    const auto count = data[cursor++];
    if (readWide(data + 4) != m_admissionEpoch || readWide(data + 12) != m_hostEpoch ||
        count > armour.items.size())
        return;
    const auto readName = [&](std::string& name) {
        if (cursor == length)
            return false;
        const auto size = data[cursor++];
        if (!size || size > 128 || length - cursor < size)
            return false;
        name.assign(reinterpret_cast<const char*>(data + cursor), size);
        cursor += size;
        return name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") == name.npos;
    };
    for (unsigned i = 0; i < count; ++i)
    {
        if (length - cursor < 6)
            return;
        const auto slot = data[cursor++];
        const bool belt = slot >= PlayerArmour::BeltStart && slot < PlayerArmour::BeltStart + PlayerArmour::BeltCells;
        if (slot != 7 && slot != 12 && !belt)
            return;
        auto& item = armour.items[belt ? 2 + slot - PlayerArmour::BeltStart : unsigned(slot == 12)];
        item.condition = readScalar(data + cursor);
        cursor += 4;
        const auto upgrades = data[cursor++];
        if (!item.section.empty() || !(item.condition >= 0.f && item.condition <= 1.f) ||
            upgrades > 32 || (belt && upgrades) || !readName(item.section) || item.section.size() >= 64)
            return;
        item.upgrades.resize(upgrades);
        for (auto& name : item.upgrades)
            if (!readName(name))
                return;
    }
    if (cursor == length)
        xray::zone_pending_snapshots::retain(m_armour, std::move(armour), MaxPlayers);
}

void AlifeHostInterests::receiveWeapon(const unsigned char* data, std::size_t length)
{
    zone::inventory_detail::Reader read(data + 4, length - 4);
    const auto epoch = read.wide(), boot = read.wide();
    if (epoch != m_admissionEpoch || boot != m_hostEpoch)
        return;
    PlayerWeapon weapon;
    weapon.id = read.integer();
    weapon.life = read.integer();
    auto& item = weapon.item;
    item.index = read.byte();
    if (!item.index)
    {
        if (read.ok && !read.left)
            xray::zone_pending_snapshots::retain(m_weapons, std::move(weapon), MaxPlayers);
        return;
    }
    if (item.index != 2 && item.index != 3)
        return;
    item.id = read.id(true);
    item.revision = read.integer();
    item.condition = read.real();
    item.fireMode = read.byte();
    const auto flags = read.byte();
    weapon.addons = read.byte();
    item.launcherMode = (flags & 1) != 0;
    item.jammed = (flags & 2) != 0;
    item.section = read.section();
    item.selectedAmmunition = read.section();
    const auto hasScope = read.byte();
    if (hasScope)
        weapon.scope = read.section();
    const auto upgrades = read.byte();
    if (!read.ok || item.id.empty() || item.section.size() >= 64 ||
        !(item.condition >= 0.f && item.condition <= 1.f) || flags > 3 || weapon.addons > 7 ||
        hasScope > 1 || upgrades > 32)
        return;
    for (unsigned i = 0; i < upgrades && read.ok; ++i)
        item.upgrades.push_back(read.section());
    const auto types = read.byte();
    if (types > 64)
        return;
    std::vector<std::string> names;
    names.reserve(types);
    for (unsigned i = 0; i < types && read.ok; ++i)
        names.push_back(read.section());
    const auto bullets = read.shortValue();
    const auto grenades = read.byte();
    if (!read.ok || bullets > 512 || grenades > 1 || read.left < std::size_t(bullets) + grenades + 25)
        return;
    for (unsigned i = 0; i < unsigned(bullets) + grenades; ++i)
    {
        const auto type = read.byte();
        if (type >= names.size())
            return;
        (i < bullets ? item.cartridges : item.launcherCartridges).push_back(names[type]);
    }
    for (auto& byte : weapon.fireConfig.emplace())
        byte = read.byte();
    weapon.generation = read.wide();
    const auto boxes = read.byte();
    if (!read.ok || boxes > 128 || weapon.generation > 9007199254740991ULL)
        return;
    for (unsigned i = 0; i < boxes; ++i)
    {
        ReserveAmmo ammo;
        ammo.id = read.id(true);
        ammo.revision = read.integer();
        ammo.rounds = read.shortValue();
        ammo.section = read.section();
        if (!read.ok || ammo.id.empty() || !ammo.rounds || ammo.section.size() >= 64 ||
            std::any_of(weapon.reserve.begin(), weapon.reserve.end(),
                [&](const auto& previous) { return previous.id == ammo.id; }))
            return;
        weapon.reserve.push_back(std::move(ammo));
    }
    if (!read.ok || read.left)
        return;
    xray::zone_pending_snapshots::retain(m_weapons, std::move(weapon), MaxPlayers);
}

bool AlifeHostInterests::publishWeaponRules(const PlayerWeapon& weapon, CWeaponMagazined& native) const
{
    if (!freshMovement() || !weapon.fireConfig || weapon.item.id.size() != 32)
        return false;
    const auto capacity = native.GetAmmoMagSize();
    const auto& ammo = native.m_ammoTypes;
    if (capacity < 1 || capacity > 1024 || ammo.empty() || ammo.size() > 64)
        return false;
    std::vector<unsigned char> packet;
    packet.reserve(194 + ammo.size() * 60);
    packet.resize(194);
    std::memcpy(packet.data(), "ZAF5", 4);
    writeWord(packet.data() + 4, m_tick);
    writeWide(packet.data() + 8, m_epoch);
    writeWide(packet.data() + 16, m_hostEpoch);
    writeWord(packet.data() + 24, weapon.id);
    writeWord(packet.data() + 28, weapon.life);
    std::copy(weapon.item.id.begin(), weapon.item.id.end(), packet.begin() + 32);
    std::copy(weapon.fireConfig->begin(), weapon.fireConfig->end(), packet.begin() + 64);
    const auto rules = native.NativeFireRules();
    writeWord(packet.data() + 80, static_cast<std::uint32_t>(rules.mode));
    writeWord(packet.data() + 84, rules.legacyMisfire);
    const auto writeFloat = [&](std::size_t offset, float value) {
        std::uint32_t bits;
        std::memcpy(&bits, &value, sizeof(bits));
        writeWord(packet.data() + offset, bits);
    };
    const float values[] = {rules.openingInterval, rules.sustainedInterval, rules.firstWear, rules.followupWear,
        rules.misfire[0], rules.misfire[1], rules.misfire[2], rules.misfire[3]};
    for (std::size_t i = 0; i < std::size(values); ++i)
        writeFloat(88 + i * 4, values[i]);
    packet[120] = static_cast<unsigned char>(capacity);
    packet[121] = static_cast<unsigned char>(capacity >> 8);
    packet[122] = !weapon.item.launcherMode && native.IsTriStateReload();
    packet[123] = static_cast<unsigned char>(ammo.size());
    writeFloat(124, rules.hitPower);
    writeFloat(128, rules.hitImpulse);
    packet[132] = rules.suppressed;
    packet[133] = static_cast<unsigned char>(rules.openingRounds);
    writeFloat(134, rules.range);
    writeFloat(138, rules.speed);
    writeFloat(142, rules.openingSpeed);
    writeFloat(146, rules.dragFactor);
    for (std::size_t i = 0; i < std::size(rules.dispersion); ++i)
        writeFloat(150 + i * 4, rules.dispersion[i]);
    // Select the same settings as the engine's multiplayer bullet manager.
    static const auto bulletManager = [] {
        const char* section = pSettings->section_exist("mp_bullet_manager") ? "mp_bullet_manager" : "bullet_manager";
        return std::array{pSettings->r_float(section, "gravity_const"),
            pSettings->r_float(section, "collision_energy_min"), pSettings->r_float(section, "collision_energy_max")};
    }();
    for (std::size_t i = 0; i < bulletManager.size(); ++i)
        writeFloat(182 + i * 4, bulletManager[i]);
    // Ammo configuration is immutable for a headless host. Share the parsed
    // cartridge parameters across all the mirrored weapons using each round.
    struct CartridgeProfile
    {
        SCartridgeParam params;
        unsigned char flags;
    };
    static std::unordered_map<std::string, std::optional<CartridgeProfile>> cartridges;
    for (const auto& section : ammo)
    {
        const char* name = section.c_str();
        const auto size = name ? std::strlen(name) : 0;
        if (!size || size > 63)
            return false;
        packet.push_back(static_cast<unsigned char>(size));
        packet.insert(packet.end(), name, name + size);
        const auto [entry, inserted] = cartridges.try_emplace(name);
        if (inserted && std::strcmp(pSettings->r_string(name, "class"), "AMMO_S") == 0)
        {
            CCartridge cartridge;
            cartridge.Load(name, 0);
            unsigned char flags = 0;
            if (cartridge.m_flags.test(CCartridge::cfRicochet))
                flags |= 1;
            if (cartridge.m_flags.test(CCartridge::cfMagneticBeam))
                flags |= 2;
            entry->second = CartridgeProfile{cartridge.param_s, flags};
        }
        packet.push_back(entry->second.has_value());
        if (entry->second)
        {
            const auto& round = *entry->second;
            const auto& params = round.params;
            const float factors[] = {params.kHit, params.kImpulse, params.impair,
                params.kDist, params.kAirRes, params.kAP, params.kDisp};
            const auto start = packet.size();
            packet.resize(start + sizeof(factors));
            for (std::size_t i = 0; i < std::size(factors); ++i)
                writeFloat(start + i * 4, factors[i]);
            packet.push_back(static_cast<unsigned char>(std::clamp(params.buckShot, 0, 255)));
            packet.push_back(round.flags);
        }
    }
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    return ::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath)) >= 0;
}

void AlifeHostInterests::receiveAttack(const unsigned char* data, std::size_t length)
{
    if (readWide(data + 16) != m_hostEpoch || m_attacks.size() >= 512)
        return;
    Attack hit{readWide(data + 24), readWide(data + 8), readWord(data + 4), readWord(data + 32),
        readWord(data + 36), readWord(data + 40), readWord(data + 44), readWord(data + 48),
        readScalar(data + 52), readScalar(data + 56), {}, {}, {}, {}};
    for (unsigned i = 0; i < 3; ++i)
    {
        hit.power[i] = readScalar(data + 60 + i * 4);
        hit.direction[i] = readScalar(data + 72 + i * 4);
        hit.offset[i] = readScalar(data + 84 + i * 4);
    }
    const float directionLength = hit.direction[0]*hit.direction[0] + hit.direction[1]*hit.direction[1] + hit.direction[2]*hit.direction[2];
    if (!hit.sequence || !hit.shooter || hit.target >= 65535 || hit.kind > 2 ||
        !(hit.penetration >= 0 && hit.penetration <= MaxPenetration && hit.impulse >= 0 && hit.impulse <= 1000000) ||
        !(directionLength >= .95f && directionLength <= 1.05f) ||
        !(hit.power[0] > 0.f) || !std::all_of(hit.power.begin(), hit.power.end(), [](float v) { return v >= 0 && v <= 100; }) ||
        !std::all_of(hit.offset.begin(), hit.offset.end(), [](float v) { return std::abs(v) <= 50.f; }))
        return;
    if (length == 124)
    {
        const Attack::Ray ray{{readScalar(data + 96), readScalar(data + 100), readScalar(data + 104)},
            {readScalar(data + 108), readScalar(data + 112), readScalar(data + 116)}, readScalar(data + 120)};
        const float squareLength = ray.direction.square_magnitude();
        if (hit.kind != 0 || !(std::abs(ray.origin.x) <= 100000.f && std::abs(ray.origin.y) <= 100000.f &&
            std::abs(ray.origin.z) <= 100000.f && squareLength >= .95f && squareLength <= 1.05f &&
            ray.range > 0.f && ray.range <= 4096.f))
            return;
        hit.ray = ray;
    }
    m_attacks.push_back(hit);
}

std::optional<AlifeHostInterests::Attack> AlifeHostInterests::nextAttack()
{
    while (!m_attacks.empty())
    {
        const auto hit = m_attacks.front();
        m_attacks.pop_front();
        if (!m_haveSnapshot || Clock::now() >= m_expires || hit.epoch != m_epoch)
            continue;
        const auto& cached = m_completed[hit.sequence % m_completed.size()];
        if (cached.sequence == hit.sequence)
        {
            sendAttackResult(hit.sequence, cached.health);
            continue;
        }
        if (m_attackHigh >= hit.sequence && m_attackHigh - hit.sequence >= m_completed.size())
            continue;
        const auto age = m_tick - hit.tick;
        if (age <= 36 || hit.tick - m_tick <= 6)
            return hit;
        completeAttack(hit, std::nullopt);
    }
    return std::nullopt;
}

std::optional<xray::zone_condition::Request> AlifeHostInterests::nextCondition()
{
    if (m_conditions.empty()) return {};
    auto request = std::move(m_conditions.front());
    m_conditions.pop_front();
    return request;
}

std::optional<xray::zone_weapon_action::Request> AlifeHostInterests::nextWeaponAction()
{
    return m_weaponActions.pop();
}

void AlifeHostInterests::sendWeaponAction(const std::vector<unsigned char>& packet) const
{
    const auto path = m_hitPath + ".weapon";
    sockaddr_un address{};
    if (packet.empty() || path.size() >= sizeof(address.sun_path)) return;
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size()+1);
    ::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(path));
}

void AlifeHostInterests::sendCondition(const std::vector<unsigned char>& packet) const
{
    const auto path = m_hitPath + ".condition";
    sockaddr_un address{};
    if (packet.empty() || path.size() >= sizeof(address.sun_path)) return;
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.c_str(), path.size()+1);
    ::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(path));
}

void AlifeHostInterests::completeAttack(const Attack& attack, std::optional<std::uint16_t> health)
{
    m_attackHigh = std::max(m_attackHigh, attack.sequence);
    m_completed[attack.sequence % m_completed.size()] = {attack.sequence, health};
    sendAttackResult(attack.sequence, health);
}

void AlifeHostInterests::sendAttackResult(std::uint64_t sequence, std::optional<std::uint16_t> health) const
{
    std::array<unsigned char, 36> bytes{};
    std::memcpy(bytes.data(), "ZAA1", 4);
    writeWide(bytes.data() + 4, m_epoch);
    writeWide(bytes.data() + 12, m_hostEpoch);
    writeWide(bytes.data() + 20, sequence);
    writeWord(bytes.data() + 28, health.has_value());
    writeWord(bytes.data() + 32, health.value_or(0));
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    ::sendto(m_socket, bytes.data(), bytes.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath));
}

void AlifeHostInterests::queueHit(std::uint32_t id, std::uint32_t life, std::uint32_t kind, float power,
    float penetration, std::string_view bone, std::optional<ArmourImpact> armour)
{
    if (!m_haveSnapshot || Clock::now() >= m_expires || !(power > 0.f && power <= 10.f) ||
        !(penetration >= 0.f && penetration <= MaxPenetration) || bone.size() >= 32)
        return;
    if (!hasHitCapacity())
    {
        // A blocked worker must not make the native game thread wait or grow memory.
        Msg("! Zone A-Life hit queue is full");
        return;
    }
    m_hits.push_back({});
    auto& hit = m_hits.back();
    auto& packet = hit.bytes;
    hit.size = armour ? 116 : 84;
    hit.sequence = ++m_hitSequence;
    std::memcpy(packet.data(), armour ? "ZAH5" : "ZAH2", 4);
    const auto word = [&](std::size_t offset, std::uint32_t value) {
        for (std::size_t i = 0; i < sizeof(value); ++i)
            packet[offset + i] = static_cast<unsigned char>(value >> (i * 8));
    };
    const auto scalar = [&](std::size_t offset, float value) {
        std::uint32_t bits;
        std::memcpy(&bits, &value, sizeof(bits));
        word(offset, bits);
    };
    word(4, m_tick);
    word(8, static_cast<std::uint32_t>(m_epoch));
    word(12, static_cast<std::uint32_t>(m_epoch >> 32));
    word(16, id);
    word(20, life);
    word(24, kind);
    scalar(28, power);
    scalar(32, penetration);
    if (!bone.empty())
        std::copy(bone.begin(), bone.end(), packet.begin() + 36);
    if (armour)
    {
        writeWide(packet.data() + 68, armour->generation);
        scalar(76, armour->power);
        scalar(80, armour->outfit);
        scalar(84, armour->helmet);
        word(88, armour->wound);
        scalar(92, armour->health);
        scalar(96, armour->powerLoss);
    }
    writeWide(packet.data() + hit.size - 16, hit.sequence);
    writeWide(packet.data() + hit.size - 8, m_hostEpoch);
}

void AlifeHostInterests::flushHits()
{
    if (m_hits.empty())
        return;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_hitPath.c_str(), m_hitPath.size() + 1);
    const auto now = Clock::now();
    if (now - m_hitSent < std::chrono::milliseconds(100))
        return;
    m_hitSent = now;
    xray::zone_hit_delivery::transmit(m_hits, 256, [&](const HitPacket& packet) {
        return ::sendto(m_socket, packet.bytes.data(), packet.size, MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_hitPath));
    });
}

bool AlifeHostInterests::freshMovement() const
{
    return m_nativeMovement && m_haveSnapshot && Clock::now() < m_expires - std::chrono::milliseconds(1000);
}

bool AlifeHostInterests::wantsMovementFrame() const
{
    return freshMovement() && m_movementTick != m_tick;
}

void AlifeHostInterests::publishMovement(const std::vector<PlayerMovement>& poses)
{
    constexpr std::size_t Header = 24, Row = 40, Batch = 128;
    m_movementTick = m_tick;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    for (std::size_t start = 0; start < poses.size(); start += Batch)
    {
        const auto count = std::min(Batch, poses.size() - start);
        std::array<unsigned char, Header + Batch * Row> bytes{};
        std::memcpy(bytes.data(), "ZAM1", 4);
        writeWord(bytes.data() + 4, m_tick);
        writeWide(bytes.data() + 8, m_epoch);
        writeWide(bytes.data() + 16, m_hostEpoch);
        for (std::size_t i = 0; i < count; ++i)
        {
            const auto& pose = poses[start + i];
            auto* row = bytes.data() + Header + i * Row;
            writeWord(row, pose.id);
            writeWord(row + 4, pose.life);
            writeWord(row + 8, pose.sequence);
            const float axes[] = {pose.position.x, pose.position.y, pose.position.z,
                pose.velocity.x, pose.velocity.y, pose.velocity.z};
            for (unsigned j = 0; j < std::size(axes); ++j)
            {
                std::uint32_t bits;
                std::memcpy(&bits, &axes[j], sizeof(bits));
                writeWord(row + 12 + 4 * j, bits);
            }
            writeWord(row + 36, pose.flags);
        }
        ::sendto(m_socket, bytes.data(), Header + count * Row, MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath));
    }
}

bool AlifeHostInterests::publishHitboxes(std::uint32_t id, std::uint32_t life,
    std::vector<unsigned char>& packet, bool npc) const
{
    constexpr std::size_t Header = 44;
    if (packet.size() <= Header)
        return false;
    std::memcpy(packet.data(), npc ? "ZBN1" : "ZAB1", 4);
    writeWord(packet.data() + 4, m_tick);
    writeWide(packet.data() + 8, m_epoch);
    writeWide(packet.data() + 16, m_hostEpoch);
    writeWord(packet.data() + 24, id);
    writeWord(packet.data() + 28, life);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    return ::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath)) >= 0;
}

void AlifeHostInterests::publishEnvironment(std::uint64_t gameTime, float factor, std::string_view cycle,
    std::string_view effect, float remaining)
{
    if (!m_haveSnapshot || Clock::now() >= m_expires ||
        (m_environmentTick && m_tick - *m_environmentTick < 30) ||
        cycle.empty() || cycle.size() >= 64 || effect.size() >= 64)
        return;
    // Host header, three float32 values, two stock section names and absolute game time.
    std::array<unsigned char, 24 + 12 + 2 * 64 + 8> packet{};
    std::memcpy(packet.data(), "ZAE1", 4);
    writeWord(packet.data() + 4, m_tick);
    writeWide(packet.data() + 8, m_epoch);
    writeWide(packet.data() + 16, m_hostEpoch);
    const float seconds = static_cast<float>(gameTime % 86400000u) * .001f;
    const float values[] = {std::min(seconds, std::nextafter(86400.f, 0.f)), factor, remaining};
    std::memcpy(packet.data() + 24, values, sizeof(values));
    std::copy(cycle.begin(), cycle.end(), packet.begin() + 36);
    std::copy(effect.begin(), effect.end(), packet.begin() + 100);
    writeWide(packet.data() + 164, gameTime);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    if (::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath)) >= 0)
        m_environmentTick = m_tick;
}

bool AlifeHostInterests::wantsNpcFrame() const
{
    return m_haveSnapshot && Clock::now() < m_expires && (!m_npcTick || m_tick - *m_npcTick >= 3);
}

void AlifeHostInterests::publishNpcs(const NpcPose* npcs, std::size_t count)
{
    constexpr std::size_t Header = 36, Row = 188, PerPacket = 10;
    VERIFY(count <= MaxNpcs);
    m_npcTick = m_tick;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    const auto parts = std::max<std::size_t>(1, (count + PerPacket - 1) / PerPacket);
    for (std::size_t part = 0; part < parts; ++part)
    {
        const auto rows = std::min(PerPacket, count - part * PerPacket);
        std::array<unsigned char, Header + PerPacket * Row> bytes{};
        const auto word = [&](std::size_t offset, std::uint32_t value) {
            for (std::size_t i = 0; i < sizeof(value); ++i)
                bytes[offset + i] = static_cast<unsigned char>(value >> (8 * i));
        };
        const auto scalar = [&](std::size_t offset, float value) {
            std::uint32_t bits;
            std::memcpy(&bits, &value, sizeof(bits));
            word(offset, bits);
        };
        std::memcpy(bytes.data(), "ZAN2", 4);
        word(4, m_tick);
        word(8, static_cast<std::uint32_t>(m_epoch));
        word(12, static_cast<std::uint32_t>(m_epoch >> 32));
        writeWide(bytes.data() + 16, m_hostEpoch);
        word(24, part);
        word(28, parts);
        word(32, count);
        for (std::size_t i = 0; i < rows; ++i)
        {
            const auto& npc = npcs[part * PerPacket + i];
            const auto at = Header + i * Row;
            word(at, npc.id);
            scalar(at + 4, npc.x);
            scalar(at + 8, npc.y);
            scalar(at + 12, npc.z);
            scalar(at + 16, npc.yaw);
            word(at + 20, npc.health);
            word(at + 24, npc.motion);
            word(at + 28, npc.timeMs);
            word(at + 32, npc.spawn);
            for (unsigned axis = 0; axis < 3; ++axis)
            {
                scalar(at + 36 + axis * 4, npc.center[axis]);
                scalar(at + 48 + axis * 4, npc.half[axis]);
            }
            std::copy(npc.model.begin(), npc.model.end(), bytes.begin() + at + 60);
        }
        const auto sent = ::sendto(m_socket, bytes.data(), Header + rows * Row, MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath));
        // The next complete frame supersedes an incomplete or dropped frame.
        if (sent < 0)
            return;
    }
}

bool AlifeHostInterests::publishNpcPose(std::uint16_t id, std::uint32_t spawn,
    const unsigned char* pose, std::size_t size)
{
    constexpr std::size_t Header = 24, RowHeader = 12;
    if (size > zone::npcPoseCapacity) return false;
    if (m_poseFrame.size() + RowHeader + size > 8192 && !flushNpcPoses())
        return false;
    if (m_poseFrame.empty())
    {
        m_poseFrame.resize(Header);
        std::memcpy(m_poseFrame.data(), "ZAP1", 4);
        writeWord(m_poseFrame.data() + 4, m_tick);
        writeWide(m_poseFrame.data() + 8, m_epoch);
        writeWide(m_poseFrame.data() + 16, m_hostEpoch);
    }
    const auto start = m_poseFrame.size();
    m_poseFrame.resize(start + RowHeader + size);
    auto* row = m_poseFrame.data() + start;
    writeWord(row, id);
    writeWord(row + 4, spawn);
    writeWord(row + 8, size);
    std::copy_n(pose, size, row + RowHeader);
    return true;
}

bool AlifeHostInterests::flushNpcPoses()
{
    if (m_poseFrame.empty()) return true;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    const auto sent = ::sendto(m_socket, m_poseFrame.data(), m_poseFrame.size(), MSG_DONTWAIT,
        reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath));
    m_poseFrame.clear();
    return sent >= 0;
}

void AlifeHostInterests::publishSounds()
{
    std::deque<ObservedSound> sounds;
    std::vector<ObservedSound> loops;
    {
        std::lock_guard lock(observedSoundsMutex);
        sounds.swap(observedSounds);
        const auto now = std::chrono::steady_clock::now();
        for (auto loop = observedLoops.begin(); loop != observedLoops.end();)
        {
            if (now - loop->second.updated > std::chrono::milliseconds(250))
            {
                loop = observedLoops.erase(loop);
                continue;
            }
            const auto& sound = loop->second.sound;
            if (near(sound.position.x, sound.position.y, sound.position.z, std::clamp(sound.range, 1.f, 100.f)))
                loops.push_back(sound);
            ++loop;
        }
    }
    if (sounds.empty() && loops.empty()) return;
    constexpr std::size_t Header = 24, Row = 160;
    std::array<unsigned char, Header + Row * 32> bytes{};
    writeWord(bytes.data() + 4, m_tick);
    writeWide(bytes.data() + 8, m_epoch);
    writeWide(bytes.data() + 16, m_hostEpoch);
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_npcPath.c_str(), m_npcPath.size() + 1);
    const auto publish = [&](const char* kind, const auto& samples, bool looped)
    {
        std::memcpy(bytes.data(), kind, 4);
        unsigned count = 0;
        const auto flush = [&] {
            return !count || ::sendto(m_socket, bytes.data(), Header + count * Row, MSG_DONTWAIT,
                reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_npcPath)) >= 0;
        };
        for (const auto& sound : samples)
        {
            const auto& p = sound.position;
            const auto range = std::clamp(sound.range, 1.f, 100.f);
            if (!looped && !near(p.x, p.y, p.z, range)) continue;
            auto* row = bytes.data() + Header + count * Row;
            std::fill_n(row, Row, 0);
            writeWord(row, looped ? sound.loop : ++m_soundSequence);
            const float fields[] = {p.x, p.y, p.z, std::clamp(sound.volume, 0.f, 4.f),
                std::clamp(sound.frequency, .1f, 4.f), range};
            std::memcpy(row + 4, fields, sizeof(fields));
            std::copy(sound.name.begin(), sound.name.end(), row + 28);
            if (++count == 32)
            {
                if (!flush() || !looped) return;
                count = 0;
            }
        }
        flush();
    };
    publish("ZAU1", sounds, false);
    publish("ZAV1", loops, true);
}

bool AlifeHostInterests::near(float x, float y, float z, float distance) const
{
    const auto end = m_players.begin() + m_count;
    auto point = std::lower_bound(m_players.begin(), end, x - distance,
        [](const auto& p, float lower) { return p.x < lower; });
    for (; point != end && point->x <= x + distance; ++point)
    {
        const float dx = x - point->x, dy = y - point->y, dz = z - point->z;
        if (dx * dx + dy * dy + dz * dz <= distance * distance)
            return true;
    }
    return false;
}
#endif
