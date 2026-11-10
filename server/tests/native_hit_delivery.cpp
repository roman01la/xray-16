#include "xrGame/ZoneHitDelivery.h"
#include <cassert>
#include <cerrno>
#include <deque>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <string>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
struct Packet { int id; std::size_t size; };
int main()
{
    // All socket errors preserve the oldest hit, including peer restart races.
    for (int error : {EAGAIN, EWOULDBLOCK, ENOBUFS, EINTR, ENOENT, ECONNREFUSED, EBADF})
    {
        std::deque<Packet> queue{{1, 76}, {2, 108}};
        int calls=0;
        const auto count=xray::zone_hit_delivery::transmit(queue,256,[&](const Packet& p) {
            assert(p.id==1); ++calls; errno=error; return -1;
        });
        assert(count==0 && calls==1 && queue.size()==2 && queue.front().id==1);
        std::vector<int> order;
        assert(xray::zone_hit_delivery::transmit(queue,256,[&](const Packet& p) {
            order.push_back(p.id); return static_cast<int>(p.size);
        })==2);
        assert(queue.size()==2 && (order==std::vector<int>{1,2}));
    }
    std::deque<Packet> queue{{1,76},{2,108},{3,76}};
    assert(xray::zone_hit_delivery::transmit(queue,0,[](const Packet&){assert(false);return -1;})==0);
    assert(xray::zone_hit_delivery::transmit(queue,1,[](const Packet& p){return static_cast<int>(p.size);})==1);
    assert(queue.size()==3 && queue.front().id==1);
    // Partial/zero sends must not retire a packet either.
    for(int bytes:{0,75}) {
        assert(xray::zone_hit_delivery::transmit(queue,256,[&](const Packet&){return bytes;})==0);
        assert(queue.size()==3 && queue.front().id==1);
    }
    // A failure after a successful prefix retains the whole unacknowledged queue.
    assert(xray::zone_hit_delivery::transmit(queue,256,[](const Packet& p) {
        return p.id==1 ? static_cast<int>(p.size) : -1;
    })==1);
    assert(queue.size()==3 && queue.front().id==1);
    std::deque<Packet> retained{{1,76},{2,108}};
    assert(xray::zone_hit_delivery::transmit(retained,256,[](const Packet& p){return static_cast<int>(p.size);})==2);
    assert(retained.size()==2); // only an application acknowledgement may retire
    assert(xray::zone_hit_delivery::transmit(retained,256,[](const Packet&){return -1;})==0);
    assert(retained.size()==2);
    // Exercise the actual missing-socket/rebind race without a native game.
    char directory[]="/tmp/zone-hit-delivery-XXXXXX";
    assert(::mkdtemp(directory));
    const std::string path=std::string(directory)+"/receiver";
    sockaddr_un address{}; address.sun_family=AF_UNIX;
    assert(path.size()<sizeof(address.sun_path));
    std::memcpy(address.sun_path,path.c_str(),path.size()+1);
    const int sender=::socket(AF_UNIX,SOCK_DGRAM,0); assert(sender>=0);
    struct WirePacket { int id; std::size_t size=sizeof(int); };
    std::deque<WirePacket> wire{{11},{12}};
    auto send=[&](const WirePacket& packet) {
        return ::sendto(sender,&packet.id,packet.size,MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&address),sizeof(address));
    };
    assert(xray::zone_hit_delivery::transmit(wire,256,send)==0 && wire.size()==2);
    auto receive=[&]() {
        const int socket=::socket(AF_UNIX,SOCK_DGRAM,0); assert(socket>=0);
        assert(::bind(socket,reinterpret_cast<const sockaddr*>(&address),sizeof(address))==0);
        return socket;
    };
    int receiver=receive();
    assert(xray::zone_hit_delivery::transmit(wire,1,send)==1);
    int id=0; assert(::recv(receiver,&id,sizeof(id),MSG_DONTWAIT)==sizeof(id) && id==11);
    assert(wire.size()==2); wire.pop_front(); // model receiver acknowledgement
    ::close(receiver); assert(::unlink(path.c_str())==0);
    assert(xray::zone_hit_delivery::transmit(wire,256,send)==0 && wire.front().id==12);
    receiver=receive();
    assert(xray::zone_hit_delivery::transmit(wire,256,send)==1 && wire.size()==1);
    assert(::recv(receiver,&id,sizeof(id),MSG_DONTWAIT)==sizeof(id) && id==12);
    wire.pop_front(); assert(wire.empty());
    ::close(receiver); ::close(sender);
    assert(::unlink(path.c_str())==0); assert(::rmdir(directory)==0);

}
