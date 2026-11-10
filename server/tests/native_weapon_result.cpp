#include "xrGame/ZoneWeaponResult.h"
#include <cassert>
#include <fstream>
using namespace xray::zone_weapon_action;
int main(int argc, char** argv)
{
    Fence fence; fence.epoch=1;fence.boot=2;fence.player=3;fence.life=4;fence.sequence=5;
    fence.generation=6;fence.item.fill(0x11);fence.revision=7;
    WeaponResult state;state.condition=.75f;state.mode=2;state.jammed=true;
    state.selected="ammo_fmj";state.cartridges={"ammo_fmj","ammo_ap","ammo_fmj"};state.grenades={"grenade"};
    AmmoResult old;old.id.fill(0x22);old.revision=9;old.native=10;old.rounds=0;old.section="ammo_fmj";
    AmmoResult fresh;fresh.native=11;fresh.rounds=8;fresh.section="ammo_ap";
    state.reserve={old,fresh};
    auto bytes=result(fence,Phase::Complete,&state);assert(!bytes.empty());
    assert(result(fence,Phase::Running).size()==Header);
    assert(result(fence,Phase::Complete).empty());
    assert(result(fence,Phase::Running,&state).empty());
    if(argc==2){std::ofstream file(argv[1],std::ios::binary);file.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());assert(file.good());}
    auto bad=state;bad.reserve.push_back(old);assert(result(fence,Phase::Complete,&bad).empty());
    bad=state;bad.reserve[1].revision=1;assert(result(fence,Phase::Complete,&bad).empty());
    bad=state;bad.reserve[1].native=10;assert(result(fence,Phase::Complete,&bad).empty());
    bad=state;bad.condition=std::nanf("");assert(result(fence,Phase::Complete,&bad).empty());
    bad=state;bad.cartridges.resize(1025,"ammo");assert(result(fence,Phase::Complete,&bad).empty());
    bad=state;bad.selected="bad\nname";assert(result(fence,Phase::Complete,&bad).empty());
}
