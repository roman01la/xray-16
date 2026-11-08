#pragma once
#include "InventoryState.h"
namespace zone {
constexpr std::size_t maxCorpseSearchBytes=24+maxInventoryBytes;
class CorpseSearchState {
public:
    bool apply(const unsigned char* data,std::size_t size) {
        if(!data || size<24 || size>maxCorpseSearchBytes)return false;
        inventory_detail::Reader r(data,size);
        if(r.integer()!=0x5052435a || r.integer()!=1)return false;
        const auto nextSequence=r.wide();const auto opened=r.integer(),payload=r.integer();
        if(!nextSequence || nextSequence>9007199254740991ull || nextSequence<=sequence || opened>1 || payload!=r.left)return false;
        InventoryState next;
        if(opened) {
            if(!next.apply(r.p,r.left) || !next.alive || next.corpse.empty() || next.items.size()>4096)return false;
            for(const auto& item:next.items)if(item.placement!=0)return false;
        } else if(payload)return false;
        state=std::move(next);open=opened!=0;sequence=nextSequence;++updates;return true;
    }
    void reset(){state.reset();open=false;sequence=0;++updates;}
    InventoryState state;
    bool open=false;
    std::uint64_t sequence=0,updates=0;
};
}
