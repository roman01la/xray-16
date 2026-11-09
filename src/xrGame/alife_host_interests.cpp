#include "StdAfx.h"
#include "alife_host_interests.h"

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include <algorithm>
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
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

namespace
{
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
    const int sendBuffer = 16 * 1024;
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
    return ::chmod(path, 0600) == 0;
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
        if (m_count)
            ++m_poseRevision;
        m_count = 0;
        m_hits.clear();
        m_attacks.clear();
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
        if (m_count)
            ++m_poseRevision;
        m_count = 0;
        m_hits.clear();
        m_attacks.clear();
    }
    if (m_level != level)
    {
        m_haveSnapshot = false;
        m_approvedGeneration.reset();
    }
    m_level = level;
    constexpr std::size_t LevelEnd = 32, Header = 40, PlayerBytes = 28;
    // One spare byte makes oversized datagrams fail the exact length check.
    std::array<unsigned char, Header + PlayerBytes * MaxPlayers + 1> bytes;
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
        if (!m_approvedGeneration)
            continue;
        if (length == 96 && std::memcmp(bytes.data(), "ZAS1", 4) == 0)
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
        if (length < Header || std::memcmp(bytes.data(), "ZAI2", 4) != 0 || level.size() > LevelEnd - 10)
            continue;
        const auto count = bytes[8] | (std::size_t(bytes[9]) << 8);
        const auto* name = reinterpret_cast<const char*>(bytes.data() + 10);
        if (count > MaxPlayers || std::size_t(length) != Header + PlayerBytes * count ||
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
            const auto* p = bytes.data() + Header + i * PlayerBytes;
            const auto stance = readWord(p + 24);
            players[i] = {readWord(p), readWord(p + 4), readScalar(p + 8), readScalar(p + 12), readScalar(p + 16),
                readScalar(p + 20), stance != 0};
            const auto& point = players[i];
            if (!point.id || stance > 1 || !(point.yaw >= 0.f && point.yaw <= 6.283186f &&
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
        if (epoch != m_epoch)
        {
            m_hits.clear();
            m_npcTick.reset();
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

void AlifeHostInterests::receiveAttack(const unsigned char* data, std::size_t length)
{
    if (length != 96 || readWide(data + 16) != m_hostEpoch || m_attacks.size() >= 512)
        return;
    Attack hit{readWide(data + 24), readWide(data + 8), readWord(data + 4), readWord(data + 32),
        readWord(data + 36), readWord(data + 40), readWord(data + 44), readWord(data + 48),
        readScalar(data + 52), readScalar(data + 56), {}, {}, {}};
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
    float penetration, std::string_view bone)
{
    if (!m_haveSnapshot || Clock::now() >= m_expires || !(power > 0.f && power <= 10.f) ||
        !(penetration >= 0.f && penetration <= MaxPenetration) || bone.size() >= 32)
        return;
    if (m_hits.size() == MaxPlayers)
    {
        // A blocked worker must not make the native game thread wait or grow memory.
        Msg("! Zone A-Life hit queue is full");
        return;
    }
    m_hits.push_back({});
    auto& packet = m_hits.back();
    std::memcpy(packet.data(), "ZAH1", 4);
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
    std::copy(bone.begin(), bone.end(), packet.begin() + 36);
    writeWide(packet.data() + 68, m_hostEpoch);
}

void AlifeHostInterests::flushHits()
{
    if (m_hits.empty())
        return;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, m_hitPath.c_str(), m_hitPath.size() + 1);
    for (unsigned attempt = 0; attempt < 256 && !m_hits.empty(); ++attempt)
    {
        const auto& packet = m_hits.front();
        const auto sent = ::sendto(m_socket, packet.data(), packet.size(), MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address), socketAddressLength(m_hitPath));
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == ENOBUFS || errno == EINTR))
            break;
        m_hits.pop_front();
    }
}

bool AlifeHostInterests::wantsNpcFrame() const
{
    return m_haveSnapshot && Clock::now() < m_expires && m_npcTick != m_tick;
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
