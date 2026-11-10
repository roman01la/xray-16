#pragma once
#include <cstddef>

namespace xray::zone_hit_delivery
{
// Application-acknowledged delivery retains successfully sent packets as well.
// The receiver suppresses duplicate sequence numbers; socket success alone is
// insufficient evidence that its bounded work queue accepted the hit.
template<class Queue, class Send>
std::size_t transmit(const Queue& queue, std::size_t budget, Send&& send)
{
    std::size_t sentCount = 0;
    for (const auto& packet : queue)
    {
        if (sentCount == budget) break;
        const auto sent = send(packet);
        if (sent < 0 || static_cast<std::size_t>(sent) != packet.size) break;
        ++sentCount;
    }
    return sentCount;
}

}
