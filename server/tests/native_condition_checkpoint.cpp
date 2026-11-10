#include "xrGame/ZoneConditionProtocol.h"
#include "xrGame/ZoneConditionMedicine.h"
#include "xrGame/ZoneConditionHit.h"
#include <cassert>
#include <limits>
using namespace xray::zone_condition;
int main()
{
    State state;
    state.values[0]=0.9234567f; state.values[5]=0.8754321f;
    state.values[18]=1; state.values[19]=50; state.values[20]=60;
    state.values[8]=-0.0031234567f;
    state.flags=31; state.conditionFlags=0x1234;
    state.medicine={0.2f,0.1f,0.3f,-0.1f,0.1f,0.05f,0.f,60.f,12.34567f};
    state.rates[0]=0.1234567f; state.protections[11]=0.2345678f;
    Wound wound; wound.bone=65535; wound.sizes[0]=0.00000012345f;
    wound.sizes[11]=9.123456f; state.wounds.push_back(wound);
    state.boosters.push_back({16,0.234567f,123.4567f});
    auto bytes=encode(state); assert(!bytes.empty());
    for (int i=0;i<1000;++i) {
        auto copy=decode(bytes.data(),bytes.size()); assert(copy);
        assert(copy->wounds[0].sizes==state.wounds[0].sizes);
        assert(copy->values==state.values && copy->medicine==state.medicine);
        assert(encode(*copy)==bytes); // repeated checkpoints never quantize
    }
    for (std::size_t n=0;n<bytes.size();++n) assert(!decode(bytes.data(),n));
    auto extra=bytes; extra.push_back(0); assert(!decode(extra.data(),extra.size()));
    auto invalid=state; invalid.boosters.push_back(state.boosters[0]); assert(encode(invalid).empty());
    invalid=state; invalid.wounds.push_back(wound); assert(encode(invalid).empty());
    invalid=state; invalid.medicine[8]=61; assert(encode(invalid).empty());
    invalid=state; invalid.values[0]=std::numeric_limits<float>::quiet_NaN(); assert(encode(invalid).empty());
    invalid=state; invalid.wounds[0].sizes[1]=-0.1f; assert(encode(invalid).empty());
    invalid=state; invalid.wounds.clear();
    for (unsigned i=0;i<MaxWounds;++i) { wound.bone=i; invalid.wounds.push_back(wound); }
    auto maximum=encode(invalid); assert(decode(maximum.data(),maximum.size()));
    invalid.wounds.push_back(wound); assert(encode(invalid).empty());
    // Hostile encoded counts are rejected before vector allocation or record reads.
    auto bad=bytes; const auto countOffset=4+(23+8+12+9+2)*4;
    for (unsigned i=0;i<4;++i) bad[countOffset+i]=255;
    assert(!decode(bad.data(),bad.size()));

    std::vector<unsigned char> frame(RequestHeader,0);
    std::memcpy(frame.data(), "ZCT1", 4);
    frame[4]=1; frame[12]=2; frame[36]=3;
    auto baseline=request(frame.data(),frame.size()); assert(baseline && !baseline->state);
    Replay cache;
    assert(cache.check(*baseline)==ReplayDecision::New);
    auto response=reply(*baseline,state); assert(response[2]=='U');
    assert(decode(response.data()+RequestHeader,response.size()-RequestHeader));
    cache.complete(*baseline,response);
    assert(cache.check(*baseline)==ReplayDecision::Replay);
    frame[28]=1; // same sequence with a different state revision is not a retry
    auto altered=request(frame.data(),frame.size()); assert(altered);
    assert(cache.check(*altered)==ReplayDecision::Reject);
    frame[36]=2; auto stale=request(frame.data(),frame.size()); assert(stale);
    assert(cache.check(*stale)==ReplayDecision::Reject);
    frame[36]=4;
    float dt=0.1f; std::memcpy(frame.data()+52,&dt,4);
    assert(!request(frame.data(),frame.size())); // nonzero step requires checkpoint
    frame.insert(frame.end(),bytes.begin(),bytes.end());
    auto step=request(frame.data(),frame.size()); assert(step && step->state);
    assert(cache.check(*step)==ReplayDecision::New);
    dt=60.f; std::memcpy(frame.data()+52,&dt,4);
    assert(request(frame.data(),frame.size()));
    dt=60.1f; std::memcpy(frame.data()+52,&dt,4);
    assert(!request(frame.data(),frame.size()));
    std::vector<float> steps;
    assert(advanceBatch(12.25f,[&](float delta){steps.push_back(delta);return true;}));
    assert(steps.size()==13 && steps.back()==0.25f);
    for(unsigned i=0;i<12;++i) assert(steps[i]==1.f);
    unsigned calls=0;
    assert(advanceBatch(60.f,[&](float delta){assert(delta==1.f);++calls;return true;}));
    assert(calls==60);
    calls=0;
    assert(advanceBatch(60.f,[&](float){return ++calls<3;}));assert(calls==3);
    calls=0;
    assert(!advanceBatch(60.1f,[&](float){++calls;return true;}));assert(calls==0);
    assert(advanceBatch(0.f,[&](float){++calls;return true;}));assert(calls==0);

    // Import data is distinct from a checkpoint and cannot advance time itself.
    std::vector<unsigned char> legacy{'Z','C','L','1'};
    const auto word=[&](unsigned value) { for(unsigned i=0;i<4;++i) legacy.push_back(value>>(8*i)); };
    const auto scalar=[&](float value) { unsigned bits; std::memcpy(&bits,&value,4); word(bits); };
    for(unsigned i=0;i<6;++i) scalar(0.5f);
    for(unsigned i=0;i<9;++i) scalar(0.f);
    word(7); word(1); word(1);
    legacy.push_back(11); const char* bone="bip01_spine"; legacy.insert(legacy.end(),bone,bone+11);
    for(unsigned i=0;i<12;++i) scalar(0.1234567f);
    word(3); scalar(0.03f); scalar(42.5f);
    auto import=decodeImport(legacy.data(),legacy.size()); assert(import);
    assert(import->wounds[0].bone=="bip01_spine" && import->wounds[0].sizes[0]==0.1234567f);
    assert(import->boosters[0].type==3 && import->boosters[0].remaining==42.5f);
    for(std::size_t n=0;n<legacy.size();++n) assert(!decodeImport(legacy.data(),n));
    frame.resize(RequestHeader); frame[2]='I';
    dt=0.f; std::memcpy(frame.data()+52,&dt,4);
    frame.insert(frame.end(),legacy.begin(),legacy.end());
    auto migration=request(frame.data(),frame.size()); assert(migration && migration->imported);
    dt=0.1f; std::memcpy(frame.data()+52,&dt,4); assert(!request(frame.data(),frame.size()));

    frame.resize(RequestHeader); frame[2]='M';
    dt=0.f; std::memcpy(frame.data()+52,&dt,4);
    const auto checkpointSize=static_cast<unsigned>(bytes.size());
    for(unsigned i=0;i<4;++i) frame.push_back(checkpointSize>>(8*i));
    frame.insert(frame.end(),bytes.begin(),bytes.end());
    const auto sectionOffset=frame.size();
    const char* section="medkit_army";
    frame.insert(frame.end(),section,section+11);
    auto medicine=request(frame.data(),frame.size());
    assert(medicine && medicine->state && medicine->consumable==section);
    for(std::size_t n=0;n<=sectionOffset;++n) assert(!request(frame.data(),n));
    auto malformed=frame; malformed[RequestHeader]=255;
    assert(!request(malformed.data(),malformed.size()));
    malformed=frame; malformed.back()='/'; assert(!request(malformed.data(),malformed.size()));
    malformed=frame; malformed.resize(sectionOffset+129,'a'); assert(!request(malformed.data(),malformed.size()));
    dt=0.1f; std::memcpy(frame.data()+52,&dt,4); assert(!request(frame.data(),frame.size()));

    Hit hit; hit.type=6; hit.power=0.5f; hit.penetration=0.7f; hit.bone="bip01_spine";
    assert(validHit(hit));
    for(unsigned type=0;type<HitTypes;++type) { hit.type=type; assert(validHit(hit)); }
    hit.type=HitTypes; assert(!validHit(hit)); hit.type=0;
    hit.power=std::numeric_limits<float>::quiet_NaN(); assert(!validHit(hit)); hit.power=0.5f;
    hit.penetration=-1.f; assert(!validHit(hit)); hit.penetration=0.f;
    hit.penetration=150.f; assert(validHit(hit));
    hit.penetration=1000.f; assert(validHit(hit));
    hit.penetration=1000.1f; assert(!validHit(hit)); hit.penetration=0.f;
    hit.bone="../bone"; assert(!validHit(hit)); hit.bone=""; assert(validHit(hit));

    frame.resize(RequestHeader); frame[2]='H'; dt=0.f; std::memcpy(frame.data()+52,&dt,4);
    for(unsigned i=0;i<4;++i) frame.push_back(checkpointSize>>(8*i));
    frame.insert(frame.end(),bytes.begin(),bytes.end());
    const auto hitAt=frame.size();
    for(unsigned value : {6u,0u,0u,1u}) for(unsigned i=0;i<4;++i) frame.push_back(value>>(8*i));
    float power=0.5f; std::memcpy(frame.data()+hitAt+4,&power,4);
    auto hitRequest=request(frame.data(),frame.size()); assert(hitRequest && hitRequest->hit);
    Wear wear{0.7f,-1.f}; auto hitReply=reply(*hitRequest,state,&wear);
    assert(hitReply[2]=='V' && decode(hitReply.data()+RequestHeader+8,hitReply.size()-RequestHeader-8));
    for(std::size_t n=0;n<frame.size();++n) assert(!request(frame.data(),n));
    frame[hitAt]=12; assert(!request(frame.data(),frame.size())); frame[hitAt]=6;
    frame[hitAt+12]=2; assert(!request(frame.data(),frame.size()));

    frame.resize(hitAt); frame[2]='B';
    const auto appendWord=[&](unsigned value) {for(unsigned i=0;i<4;++i) frame.push_back(value>>(8*i));};
    appendWord(2);
    for (const std::string bone : {"bip01_head", "bip01_spine"}) {
        appendWord(6); unsigned bits; std::memcpy(&bits,&power,4); appendWord(bits);
        appendWord(0); appendWord(1); appendWord(static_cast<unsigned>(bone.size()));
        frame.insert(frame.end(),bone.begin(),bone.end());
    }
    const auto batch=request(frame.data(),frame.size());
    assert(batch && batch->hits.size()==2 && !batch->hit);
    assert(batch->hits[0].bone=="bip01_head" && batch->hits[1].bone=="bip01_spine");
    for(const auto& pellet:batch->hits)
        assert(pellet.type==6 && pellet.power==power && pellet.penetration==0.f && pellet.aimed);
    for(std::size_t n=0;n<frame.size();++n) assert(!request(frame.data(),n));
    auto batchReply=reply(*batch,state,&wear);
    assert(batchReply[2]=='V' && decode(batchReply.data()+RequestHeader+8,batchReply.size()-RequestHeader-8));
    frame.push_back(0); assert(!request(frame.data(),frame.size()));

    float remaining=2.5f, applied=0.f;
    for (unsigned i=0;i<5;++i) applied+=medicineFraction(2.5f,remaining,0.5f);
    assert(std::abs(applied-1.f)<0.000001f && remaining==0.f);
    assert(medicineFraction(2.5f,remaining,1.f)==0.f);
    remaining=0.25f; assert(medicineFraction(2.f,remaining,1.f)==0.125f && remaining==0.f);
    remaining=3.f; assert(medicineFraction(3.f,remaining,0.f)==0.f && remaining==3.f);
    assert(medicineFraction(0.f,remaining,1.f)==0.f && remaining==3.f);
}
