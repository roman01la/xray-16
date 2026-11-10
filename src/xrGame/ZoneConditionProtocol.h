#pragma once
#include "ZoneConditionState.h"
#include "ZoneConditionImport.h"
#include "ZoneConditionHit.h"
namespace xray::zone_condition
{
inline constexpr std::size_t RequestHeader = 60;
inline constexpr float MaxBatchSeconds = 60.f;
// Preserve the stock bounded integration step while amortizing bridge/SQLite
// round trips under accelerated campaign clocks. Returning false stops at death.
template<class Step> bool advanceBatch(float seconds, Step&& step)
{
    if (!std::isfinite(seconds) || seconds<0.f || seconds>MaxBatchSeconds) return false;
    while (seconds>0.f) {
        const float delta=seconds>1.f ? 1.f : seconds;
        if (!step(delta)) break;
        seconds-=delta;
    }
    return true;
}
struct Request
{
    std::uint64_t epoch, boot, revision, sequence, equipment;
    std::uint32_t player, life;
    float seconds, weight;
    std::optional<State> state;
    std::optional<Import> imported;
    std::vector<unsigned char> bytes;
    std::string consumable;
    std::optional<Hit> hit;
    std::vector<Hit> hits;
};
inline std::optional<Request> request(const unsigned char* bytes, std::size_t size)
{
    if (size < RequestHeader || size > RequestHeader+32000 || (std::memcmp(bytes,"ZCT1",4) && std::memcmp(bytes,"ZCI1",4) && std::memcmp(bytes,"ZCM1",4) && std::memcmp(bytes,"ZCH1",4) && std::memcmp(bytes,"ZCF1",4) && std::memcmp(bytes,"ZCB1",4))) return {};
    const auto word = [&](unsigned at) {
        std::uint32_t value=0;
        for (unsigned i=0;i<4;++i) value|=std::uint32_t(bytes[at+i])<<(i*8);
        return value;
    };
    const auto wide = [&](unsigned at) { return std::uint64_t(word(at)) | (std::uint64_t(word(at+4))<<32); };
    const auto scalar = [&](unsigned at) { auto bits=word(at); float value; std::memcpy(&value,&bits,4); return value; };
    Request r{wide(4),wide(12),wide(28),wide(36),wide(44),word(20),word(24),scalar(52),scalar(56),{}, {}, {}, {}, {}, {}};
    if (!r.epoch || !r.boot || !r.sequence || !std::isfinite(r.seconds) || r.seconds<0.f || r.seconds>MaxBatchSeconds ||
        !std::isfinite(r.weight) || r.weight<0.f || r.weight>1000000.f) return {};
    if (bytes[2]=='B')
    {
        if(r.seconds!=0.f || size<RequestHeader+8) return {};
        const auto count=word(RequestHeader);
        if(count>size-RequestHeader-8) return {};
        r.state=decode(bytes+RequestHeader+4,count);
        if(!r.state) return {};
        auto at=RequestHeader+4+count;
        const auto hits=word(at); at+=4;
        if(!hits || hits>64) return {};
        for(unsigned i=0;i<hits;++i) {
            if(size-at<20) return {};
            const auto flags=word(at+12), length=word(at+16);
            if(flags>1 || length>63 || length>size-at-20) return {};
            Hit hit{word(at),scalar(at+4),scalar(at+8),flags!=0,
                std::string(reinterpret_cast<const char*>(bytes+at+20),length)};
            if(!validHit(hit)) return {};
            r.hits.push_back(std::move(hit));
            at+=20+length;
        }
        if(at!=size) return {};
    }
    else if (bytes[2]=='F')
    {
        if(r.seconds!=0.f || size<RequestHeader+16) return {};
        const auto count=word(RequestHeader);
        if(count>size-RequestHeader-16) return {};
        r.state=decode(bytes+RequestHeader+4,count);
        if(!r.state) return {};
        auto at=RequestHeader+4+count;
        const auto hits=word(at); at+=4;
        if(!hits || hits>64 || size-at!=hits*8) return {};
        for(unsigned i=0;i<hits;++i,at+=8) {
            Hit hit{word(at),scalar(at+4),0.f,false,{}};
            if(!validHit(hit) || !(hit.type<=4 || hit.type==10)) return {};
            r.hits.push_back(std::move(hit));
        }
    }
    else if (bytes[2]=='H')
    {
        if (r.seconds != 0.f || size < RequestHeader+20) return {};
        const auto count=word(RequestHeader);
        if (count>size-RequestHeader-20) return {};
        r.state=decode(bytes+RequestHeader+4,count);
        if (!r.state) return {};
        const auto at=RequestHeader+4+count;
        const auto flags=word(at+12);
        if(flags>1) return {};
        Hit hit{word(at),scalar(at+4),scalar(at+8),flags!=0,
            std::string(reinterpret_cast<const char*>(bytes+at+16),size-at-16)};
        if(!validHit(hit)) return {};
        r.hit=std::move(hit);
    }
    else if (bytes[2]=='M')
    {
        if (r.seconds != 0.f || size < RequestHeader+5) return {};
        const auto count=word(RequestHeader);
        if (count > size-RequestHeader-5) return {};
        const auto sectionAt=RequestHeader+4+count;
        const auto sectionSize=size-sectionAt;
        if (!sectionSize || sectionSize>128) return {};
        r.state=decode(bytes+RequestHeader+4,count);
        if (!r.state) return {};
        for (auto at=sectionAt; at<size; ++at)
        {
            const auto c=bytes[at];
            if (!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_')) return {};
            r.consumable.push_back(c);
        }
    }
    else if (bytes[2]=='I')
    {
        if(r.seconds!=0.f) return {};
        r.imported=decodeImport(bytes+RequestHeader,size-RequestHeader);
        if(!r.imported) return {};
    }
    else if (size>RequestHeader)
    {
        r.state=decode(bytes+RequestHeader,size-RequestHeader);
        if (!r.state) return {};
    }
    else if (r.seconds != 0.f) return {}; // only a baseline request may omit its checkpoint
    r.bytes.assign(bytes,bytes+size);
    return r;
}
inline std::vector<unsigned char> reply(const Request& request, const State& state, const Wear* wear = nullptr)
{
    auto checkpoint=encode(state);
    if (checkpoint.empty()) return {};
    std::vector<unsigned char> result(request.bytes.begin(),request.bytes.begin()+RequestHeader);
    result[2]=wear ? 'V' : 'U';
    if (wear)
    {
        for (const float value : {wear->outfit, wear->helmet})
        {
            if (!std::isfinite(value) || (value != -1.f && (value < 0.f || value > 1.f))) return {};
            std::uint32_t bits; std::memcpy(&bits,&value,4);
            for (unsigned i=0;i<4;++i) result.push_back(bits>>(8*i));
        }
    }
    result.insert(result.end(),checkpoint.begin(),checkpoint.end());
    return result;
}
enum class ReplayDecision { New, Replay, Reject };
struct Replay
{
    std::uint64_t sequence = 0;
    std::vector<unsigned char> input, output;
    ReplayDecision check(const Request& request) const
    {
        if (request.sequence > sequence) return ReplayDecision::New;
        if (request.sequence == sequence && request.bytes == input) return ReplayDecision::Replay;
        return ReplayDecision::Reject;
    }
    void complete(const Request& request, std::vector<unsigned char> result)
    {
        sequence = request.sequence; input = request.bytes; output = std::move(result);
    }
};

}
