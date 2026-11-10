#pragma once
#include <array>
#include <algorithm>
#include <utility>
#include <cstdint>
#include <cstring>
#include <optional>
#include <vector>
#include <deque>

namespace xray::zone_weapon_action
{
inline constexpr std::size_t Header = 68;
enum class Operation : unsigned char { Reload = 1, Abort = 2, Commit = 3 };
enum class Phase : unsigned char { Running = 1, Complete = 2, Rejected = 3, Aborted = 4, Committed = 5 };
struct Fence
{
    std::uint64_t epoch = 0, boot = 0, sequence = 0, generation = 0;
    std::uint32_t player = 0, life = 0, revision = 0;
    std::array<unsigned char, 16> item{};
    bool operator==(const Fence& b) const
    {
        return epoch == b.epoch && boot == b.boot && sequence == b.sequence && generation == b.generation &&
            player == b.player && life == b.life && revision == b.revision && item == b.item;
    }
};
struct Request { Fence fence; Operation operation = Operation::Reload; };
inline std::optional<Request> decode(const unsigned char* bytes, std::size_t size)
{
    if (!bytes || size != Header || std::memcmp(bytes, "ZWQ1", 4) || bytes[65] || bytes[66] || bytes[67] ||
        bytes[64] < 1 || bytes[64] > 3) return {};
    const auto word = [&](unsigned at) {
        std::uint32_t value = 0;
        for (unsigned i = 0; i < 4; ++i) value |= std::uint32_t(bytes[at+i]) << (8*i);
        return value;
    };
    const auto wide = [&](unsigned at) { return std::uint64_t(word(at)) | (std::uint64_t(word(at+4)) << 32); };
    Request request;
    auto& f = request.fence;
    f.epoch = wide(4); f.boot = wide(12); f.player = word(20); f.life = word(24);
    f.sequence = wide(28); f.generation = wide(36); f.revision = word(60);
    std::copy_n(bytes+44, 16, f.item.begin());
    request.operation = static_cast<Operation>(bytes[64]);
    bool item = false;
    for (auto byte : f.item) item |= byte != 0;
    if (!f.epoch || !f.boot || !f.sequence || !item || f.generation > 9007199254740991ULL) return {};
    return request;
}
inline std::vector<unsigned char> encode(const Request& request)
{
    std::vector<unsigned char> bytes(Header, 0);
    std::memcpy(bytes.data(), "ZWQ1", 4);
    const auto write = [&](unsigned at, std::uint64_t value, unsigned count) {
        for (unsigned i = 0; i < count; ++i) bytes[at+i] = static_cast<unsigned char>(value >> (8*i));
    };
    const auto& f = request.fence;
    write(4,f.epoch,8); write(12,f.boot,8); write(20,f.player,4); write(24,f.life,4);
    write(28,f.sequence,8); write(36,f.generation,8); write(60,f.revision,4);
    std::copy(f.item.begin(), f.item.end(), bytes.begin()+44);
    bytes[64] = static_cast<unsigned char>(request.operation);
    return bytes;
}
// Retry coalescing bounds ingress independently of how fast simulation runs.
// Never replace a queued operation with a different operation: abort/commit
// ordering must remain explicit, even when datagrams arrive out of order.
class Pending
{
    std::deque<Request> requests;
public:
    bool push(const Request& request, std::size_t capacity)
    {
        for (const auto& queued : requests)
            if (queued.fence == request.fence && queued.operation == request.operation) return true;
        if (requests.size() >= capacity) return false;
        requests.push_back(request);
        return true;
    }
    std::optional<Request> pop()
    {
        if (requests.empty()) return {};
        auto result = requests.front(); requests.pop_front(); return result;
    }
    void clear() { requests.clear(); }
};
// This state belongs to one actor incarnation/admitted host generation. Keep
// the completed result until its exact commit/abort handshake, not just send().
enum class Decision { Start, Replay, Abort, AbortNew, Commit, Reject };
struct Replay
{
    std::optional<Fence> fence;
    Phase phase = Phase::Rejected;
    bool settled = true;
    std::vector<unsigned char> output;
    Decision check(const Request& request) const
    {
        if (!fence || request.fence.sequence > fence->sequence)
        {
            if (!settled) return Decision::Reject;
            if (request.operation == Operation::Reload) return Decision::Start;
            if (request.operation == Operation::Abort) return Decision::AbortNew;
            return Decision::Reject;
        }
        if (!(request.fence == *fence)) return Decision::Reject;
        if (request.operation == Operation::Reload) return Decision::Replay;
        if (request.operation == Operation::Abort)
            return settled ? Decision::Replay : Decision::Abort;
        if (phase == Phase::Committed) return Decision::Replay;
        return phase == Phase::Complete && !settled ? Decision::Commit : Decision::Reject;
    }
    void start(const Request& request)
    {
        fence = request.fence; phase = Phase::Running; settled = false; output.clear();
    }
    void complete(std::vector<unsigned char> result)
    {
        phase = Phase::Complete; output = std::move(result);
    }
    void reject(std::vector<unsigned char> result)
    {
        phase = Phase::Rejected; settled = true; output = std::move(result);
    }
    void abort(std::vector<unsigned char> result)
    {
        phase = Phase::Aborted; settled = true; output = std::move(result);
    }
    void commit(std::vector<unsigned char> result = {})
    { phase = Phase::Committed; settled = true; output = std::move(result); }
};
}
