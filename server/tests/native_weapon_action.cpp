#include "xrGame/ZoneWeaponAction.h"
#include <cassert>
using namespace xray::zone_weapon_action;
int main()
{
    Request a; a.fence.epoch=1; a.fence.boot=2; a.fence.player=3; a.fence.life=4;
    a.fence.sequence=5; a.fence.generation=6; a.fence.item.fill(0x11); a.fence.revision=7;
    const auto packet=encode(a);
    assert(packet.size()==68 && packet[20]==3 && packet[28]==5 && packet[36]==6 && packet[60]==7);
    const auto parsed=decode(packet.data(),packet.size()); assert(parsed && parsed->fence==a.fence);
    for(std::size_t size=0;size<packet.size();++size) assert(!decode(packet.data(),size));
    for(unsigned offset:{0u,64u,65u,66u,67u}) {
        auto bad=packet; bad[offset]=255; assert(!decode(bad.data(),bad.size()));
    }
    auto bad=packet; bad.push_back(0); assert(!decode(bad.data(),bad.size()));
    Pending pending;
    assert(pending.push(a, 2));
    for (int i=0; i<1000; ++i) assert(pending.push(a, 2));
    auto cancellation=a; cancellation.operation=Operation::Abort;
    assert(pending.push(cancellation, 2));
    auto other=a; ++other.fence.player;
    assert(!pending.push(other, 2));
    assert(pending.pop()->operation==Operation::Reload);
    assert(pending.pop()->operation==Operation::Abort);
    assert(!pending.pop());
    assert(pending.push(other, 2)); pending.clear(); assert(!pending.pop());
    Replay cancelled; auto earlyAbort=a;earlyAbort.operation=Operation::Abort;
    assert(cancelled.check(earlyAbort)==Decision::AbortNew);
    cancelled.start(earlyAbort);cancelled.abort({4});
    assert(cancelled.check(a)==Decision::Replay && cancelled.phase==Phase::Aborted);
    Replay replay; assert(replay.check(a)==Decision::Start); replay.start(a);
    assert(replay.check(a)==Decision::Replay);
    auto next=a; ++next.fence.sequence; assert(replay.check(next)==Decision::Reject);
    auto changed=a; ++changed.fence.revision; assert(replay.check(changed)==Decision::Reject);
    changed=a; ++changed.fence.life; assert(replay.check(changed)==Decision::Reject);
    changed=a; ++changed.fence.boot; assert(replay.check(changed)==Decision::Reject);
    auto commit=a; commit.operation=Operation::Commit;
    assert(replay.check(commit)==Decision::Reject); // no premature commit
    replay.complete({1,2,3}); assert(replay.check(a)==Decision::Replay && replay.output.size()==3);
    assert(replay.check(next)==Decision::Reject); // completed is still awaiting persistence
    assert(replay.check(commit)==Decision::Commit); replay.commit();
    assert(replay.check(commit)==Decision::Replay);
    assert(replay.check(next)==Decision::Start); replay.start(next);
    auto abort=next; abort.operation=Operation::Abort;
    assert(replay.check(abort)==Decision::Abort); replay.abort({4});
    assert(replay.check(next)==Decision::Replay && replay.phase==Phase::Aborted);
    assert(replay.check(abort)==Decision::Replay);
    assert(replay.check(a)==Decision::Reject); // older sequence cannot run again
}
