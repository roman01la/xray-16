////////////////////////////////////////////////////////////////////////////
//	Module 		: alife_switch_manager.cpp
//	Created 	: 25.12.2002
//  Modified 	: 12.05.2004
//	Author		: Dmitriy Iassenev
//	Description : ALife Simulator switch manager
////////////////////////////////////////////////////////////////////////////

#include "StdAfx.h"
#include "alife_switch_manager.h"
#include "alife_host_targets.h"
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "Level.h"
#include "game_cl_base.h"
#include "CustomMonster.h"
#include "ai/stalker/ai_stalker.h"
#include "Inventory.h"
#include "Weapon.h"
#include "Include/xrRender/Kinematics.h"
#include "multiplayer/NpcPresentation.h"
#include "Include/xrRender/KinematicsAnimated.h"
#include "Include/xrRender/RenderVisual.h"
#include "xrEngine/Environment.h"
#endif
#include "xrServer_Objects_ALife.h"
#include "alife_graph_registry.h"
#include "alife_object_registry.h"
#include "alife_schedule_registry.h"
#include "xrAICore/Navigation/game_level_cross_table.h"
#include "xrServer.h"
#include "ai_space.h"
#include "xrAICore/Navigation/level_graph.h"
#include "xrNetServer/NET_Messages.h"

#ifdef DEBUG
#include "Level.h"
#endif // DEBUG

using namespace ALife;

struct remove_non_savable_predicate
{
    IPureServer* m_server;

    IC remove_non_savable_predicate(IPureServer* server)
    {
        VERIFY(server);
        m_server = server;
    }

    IC bool operator()(const ALife::_OBJECT_ID& id) const
    {
        CSE_Abstract* object = m_server->GetGameState()->get_entity_from_eid(id);
        VERIFY(object);
        CSE_ALifeObject* alife_object = smart_cast<CSE_ALifeObject*>(object);
        VERIFY(alife_object);
        return (!alife_object->can_save());
    }
};

CALifeSwitchManager::~CALifeSwitchManager() {}

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
void CALifeSwitchManager::open_host_interests()
{
    if (m_hostInterests)
        return;
    string_path outbox;
    FS.update_path(outbox, "$app_data_root$", "zone-alife-outbox");
    convert_path_separators(outbox);
    const auto* configuredOutbox = std::getenv("ZONE_ALIFE_OUTBOX_DIR");
    m_hostInterests = std::make_unique<AlifeHostInterests>();
    R_ASSERT2(m_hostInterests->open(std::getenv("ZONE_ALIFE_INTEREST_SOCKET"),
                  configuredOutbox ? configuredOutbox : outbox),
        "A-Life needs a private Unix socket and writable, exclusive world state");
    m_hostTargets = std::make_unique<AlifeHostTargets>();
    Msg("* Zone A-Life interest receiver ready");
}

void CALifeSwitchManager::poll_host_interests() const
{
    if (!m_hostInterests || !initialized())
        return;
    const auto name = ai().game_graph().header().level(graph().level().level_id()).name();
    m_hostInterests->refresh(name.c_str());
    // Replays and accepted condition proposals must not depend on resuming
    // actor movement. New equipment is reconciled by the normal update path;
    // serviceConditions retains its equipment-generation/readiness checks.
    if (Device.Paused() && m_hostTargets && g_pGameLevel && g_pGameLevel->bReady)
        m_hostTargets->serviceConditions(Level(), *m_hostInterests);
}

void CALifeSwitchManager::advance_host_interests(CLevel& level) const
{
    if (!m_hostInterests || !initialized())
        return;
    if (const auto clock = m_hostInterests->takeCampaignClock())
    {
        const auto error = std::abs(static_cast<s64>(clock->milliseconds) - static_cast<s64>(level.GetGameTime()));
        if (error > 1000 * std::max(1.f, clock->factor) || !fsimilar(clock->factor, level.GetGameTimeFactor()))
            level.game->SetEnvironmentGameTimeFactor(clock->milliseconds, clock->factor);
    }
    if (level.CurrentEntity())
        m_hostTargets->update(level, server(), *m_hostInterests);
}
#endif

bool CALifeSwitchManager::host_interests_requested()
{
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    static const bool enabled = std::strstr(Core.Params, "-zone-alife-host") != nullptr;
    return enabled || Device.IsHeadlessAlifeHost();
#else
    return false;
#endif
}

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
bool CALifeSwitchManager::host_hit_capacity() const
{
    return !m_hostInterests || m_hostInterests->hasHitCapacity();
}

void CALifeSwitchManager::report_host_hit(u16 target, const SHit& hit) const
{
    if (m_hostInterests && m_hostTargets)
        m_hostTargets->reportHit(target, hit, *m_hostInterests);
}
void CALifeSwitchManager::report_host_death(CSE_Abstract& entity)
{
    if (m_hostTargets)
        m_hostTargets->observeDeath(Level(), entity);
}
namespace {
std::size_t packNpcPose(CCustomMonster& npc, std::string_view model,
    std::array<unsigned char, zone::npcPoseCapacity>& packet)
{
    auto* skeleton = PKinematics(npc.Visual());
    if (!skeleton || !skeleton->LL_BoneCount() || skeleton->LL_BoneCount() > zone::npcMaxBones)
        return 0;
    skeleton->CalculateBones(TRUE);
    const auto mask = skeleton->LL_GetBonesVisible();
    if (!mask) return 0;
    const auto modelKey = zone::npcModelKey(model);
    std::memcpy(packet.data(), &modelKey, sizeof(modelKey));
    packet[4] = npc.g_Alive() ? 0 : 1;
    packet[5] = skeleton->LL_BoneCount();
    packet[6] = packet[7] = 0;
    std::memcpy(packet.data() + 8, &mask, sizeof(mask));
    const auto& position = npc.Position();
    const float root[] = {position.x, position.y, position.z};
    std::memcpy(packet.data() + 16, root, sizeof(root));
    if (!_valid(position) || !zone::packNpcRotation(packet.data() + 28, npc.XFORM()))
        return 0;
    auto size = zone::npcPoseHeader;
    for (u16 bone = 0; bone < skeleton->LL_BoneCount(); ++bone)
    {
        if (skeleton->LL_GetBoneVisible(bone) && !zone::packNpcBone(packet.data() + size, skeleton->LL_GetTransform(bone)))
            return 0;
        size += zone::npcBoneBytes;
    }
    auto* stalker = smart_cast<CAI_Stalker*>(&npc);
    if (!stalker || !npc.g_Alive())
        return size;
    auto* weapon = smart_cast<CWeapon*>(stalker->inventory().ActiveItem());
    // CInventoryOwner draws the active item explicitly. CHudItem checks its
    // weapon state and attachment, independent of spatial visibility.
    if (!weapon || (weapon->IsHidden() && !stalker->attached(weapon)) || !weapon->Visual())
        return size;
    const auto& name = weapon->cNameSect();
    if (!name.size() || name.size() > 127)
        return size;
    const std::string_view section(name.c_str(), name.size());
    if (section.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") != section.npos)
        return size;

    weapon->get_LastFP(); // Runs the stock attachment calculation.
    Fmatrix inverse, attached;
    inverse.invert(npc.XFORM());
    attached.mul_43(inverse, weapon->XFORM());
    if (!zone::packNpcBone(packet.data() + size, attached))
        return size;
    packet[6] = section.size();
    packet[7] = (weapon->IsScopeAttached() ? zone::npcScope : 0) |
        (weapon->IsGrenadeLauncherAttached() ? zone::npcLauncher : 0) |
        (weapon->IsSilencerAttached() ? zone::npcSilencer : 0);
    size += zone::npcBoneBytes;
    std::copy(section.begin(), section.end(), packet.begin() + size);
    size += section.size();

    const auto& shot = weapon->zoneNpcShot();
    if (shot.time && Device.dwTimeGlobal - shot.time <= 500)
    {
        Fmatrix muzzle;
        muzzle.mul_43(inverse, shot.muzzle);
        if (zone::packNpcBone(packet.data() + size + sizeof(shot.time), muzzle))
        {
            packet[7] |= zone::npcShot | (shot.launcher ? zone::npcShotLauncher : 0);
            std::memcpy(packet.data() + size, &shot.time, sizeof(shot.time));
            size += zone::npcShotBytes;
        }
    }
    return size;
}
}
void CALifeSwitchManager::publish_host_npcs(CLevel& level) const
{
    if (!m_hostInterests)
        return;
    // CLevel's publication callback also owns movement and attack dispatch.
    // A paused host may service proposals, but must not advance those paths.
    if (Device.Paused())
    {
        if (m_hostTargets)
            m_hostTargets->serviceConditions(level, *m_hostInterests);
        return;
    }
    if (m_hostTargets)
    {
        m_hostTargets->stepMovement(level, *level.Server, *m_hostInterests);
        m_hostTargets->collectCorpses(level, server(), *m_hostInterests);
    }
    for (unsigned i = 0; m_hostTargets && i < 128; ++i)
    {
        const auto attack = m_hostInterests->nextAttack();
        if (!attack)
            break;
        m_hostInterests->completeAttack(*attack, m_hostTargets->applyAttack(level, *attack));
    }
    if (!m_hostInterests->wantsNpcFrame())
        return;
    auto& environment = g_pGamePersistent->Environment();
    const auto cycle = environment.GetWeatherCycle();
    const auto effect = environment.IsWFXPlaying() ? environment.GetWeather() : shared_str{};
    const auto name = [](const shared_str& value) {
        return value.size() ? std::string_view(value.c_str(), value.size()) : std::string_view{};
    };
    m_hostInterests->publishEnvironment(level.GetEnvironmentGameTime(), level.GetGameTimeFactor(),
        name(cycle), name(effect), environment.GetWeatherEffectTimeLeft());
    std::array<AlifeHostInterests::NpcPose, AlifeHostInterests::MaxNpcs> npcs;
    std::array<CCustomMonster*, AlifeHostInterests::MaxNpcs> sources;
    std::size_t count = 0;
    for (u32 i = 0; i < level.Objects.o_count() && count < npcs.size(); ++i)
    {
        auto* npc = smart_cast<CCustomMonster*>(level.Objects.o_get_by_iterator(i));
        if (!npc || !npc->Local() || npc->getDestroy() || !npc->Visual() || !_valid(npc->Position()) ||
            !std::isfinite(npc->GetfHealth()))
            continue;
        const auto name = npc->cNameVisual();
        if (!name.c_str() || !name.size() || name.size() >= 128)
            continue;
        const std::string_view model(name.c_str(), name.size());
        if (model.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-\\") != std::string_view::npos)
            continue;
        float yaw, pitch, bank;
        npc->XFORM().getHPB(yaw, pitch, bank);
        if (!std::isfinite(yaw))
            continue;
        const CBlend* primary = nullptr;
        if (auto* animated = npc->Visual()->dcast_PKinematicsAnimated())
            for (u32 part = 0; part < MAX_PARTS; ++part)
                for (u32 j = 0; j < animated->LL_PartBlendsCount(part); ++j)
                {
                    const auto* blend = animated->LL_PartBlend(part, j);
                    if (blend && blend->channel == 0 && blend->motionID.valid() &&
                        (!primary || blend->blendAmount > primary->blendAmount))
                        primary = blend;
                }
        const auto& p = npc->Position();
        const auto health = static_cast<u16>(npc->g_Alive() ?
            std::max(1.f, std::ceil(std::clamp(npc->GetfHealth(), 0.f, 1.f) * 100.f)) : 0.f);
        const auto time = primary && std::isfinite(primary->timeCurrent) ?
            static_cast<u32>(std::clamp(primary->timeCurrent * 1000.f, 0.f, 65535.f)) : 0;
        Fvector center, half;
        npc->BoundingBox().getcenter(center);
        npc->BoundingBox().getradius(half);
        if (!_valid(center) || !_valid(half) || std::abs(center.x) > 30.f || std::abs(center.y) > 30.f ||
            std::abs(center.z) > 30.f || half.x > 30.f || half.y > 30.f || half.z > 30.f)
            continue;
        sources[count] = npc;
        npcs[count++] = {npc->ID(), health, p.x, p.y, p.z, yaw, primary ? primary->motionID.val : u32(-1), time,
            npc->spawn_time(), {center.x, center.y, center.z},
            {std::max(.025f, half.x), std::max(.025f, half.y), std::max(.025f, half.z)}, model};
    }
    m_hostInterests->publishNpcs(npcs.data(), count);
    // Rotate the starting point so socket backpressure cannot starve later NPCs.
    const auto start = count ? Device.dwFrame % count : 0;
    for (std::size_t n = 0; n < count; ++n)
    {
        const auto i = (start + n) % count;
        const auto& npc = npcs[i];
        if (!m_hostInterests->near(npc.x, npc.y, npc.z, 100.f))
            continue;
        std::array<unsigned char, zone::npcPoseCapacity> pose{};
        const auto size = packNpcPose(*sources[i], npc.model, pose);
        if (size && !m_hostInterests->publishNpcPose(npc.id, npc.spawn, pose.data(), size))
            break;
    }
    m_hostInterests->flushNpcPoses();
    // Keep skeleton refresh and private datagram traffic bounded. Rotate the
    // same candidate list so dense scenes cannot permanently starve one NPC.
    if (m_hostInterests->nativeMovement())
    {
        std::vector<unsigned char> hitboxes;
        std::size_t sampled = 0;
        for (std::size_t n = 0; n < count && sampled < 64; ++n)
        {
            const auto i = (start + n) % count;
            const auto& npc = npcs[i];
            if (!npc.health || !m_hostInterests->near(npc.x, npc.y, npc.z, 100.f))
                continue;
            ++sampled;
            AlifeHostTargets::writeHitboxes(*sources[i], sources[i]->Position(), hitboxes);
            if (hitboxes.size() > 44 && !m_hostInterests->publishHitboxes(npc.id, npc.spawn, hitboxes, true))
                break;
        }
    }
    m_hostInterests->publishSounds();
}
#endif

bool CALifeSwitchManager::uses_host_interests() const noexcept
{
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    return bool(m_hostInterests);
#else
    return false;
#endif
}

bool CALifeSwitchManager::near_switch_interest(const Fvector& position, float distance) const
{
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    if (m_hostInterests)
        return m_hostInterests->near(position.x, position.y, position.z, distance);
#endif
    return graph().actor()->o_Position.distance_to(position) <= distance;
}

std::size_t CALifeSwitchManager::host_interest_count() const noexcept
{
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    return m_hostInterests ? m_hostInterests->size() : 0;
#else
    return 0;
#endif
}

void CALifeSwitchManager::add_online(CSE_ALifeDynamicObject* object, bool update_registries)
{
    START_PROFILE("ALife/switch/add_online")
    VERIFY((ai().game_graph().vertex(object->m_tGraphID)->level_id() == graph().level().level_id()));

    object->m_bOnline = true;

    NET_Packet tNetPacket;
    CSE_Abstract* l_tpAbstract = smart_cast<CSE_Abstract*>(object);
    server().entity_Destroy(l_tpAbstract);
    object->s_flags._or (M_SPAWN_UPDATE);
    ClientID clientID;
    clientID.set(server().GetServerClient() ? server().GetServerClient()->ID.value() : 0);
    server().Process_spawn(tNetPacket, clientID, FALSE, l_tpAbstract);
    object->s_flags._and (u16(-1) ^ M_SPAWN_UPDATE);

	//Alundaio: Workaround for crash with corpses that end up outside AI map
    //R_ASSERT3(!object->used_ai_locations() || ai().level_graph().valid_vertex_id(object->m_tNodeID),
    //          "Invalid vertex for object ", object->name_replace());

#ifndef MASTER_GOLD
    if (psAI_Flags.test(aiALife))
        Msg("[LSS] Spawning object [%s][%s][%d]", object->name_replace(), object->s_name.c_str(), object->ID);
#endif

    object->add_online(update_registries);
    STOP_PROFILE
}

void CALifeSwitchManager::remove_online(CSE_ALifeDynamicObject* object, bool update_registries)
{
    START_PROFILE("ALife/switch/remove_online")
    object->m_bOnline = false;

    m_saved_chidren = object->children;
    CSE_ALifeTraderAbstract* inventory_owner = smart_cast<CSE_ALifeTraderAbstract*>(object);
    if (inventory_owner)
    {
        m_saved_chidren.erase(
            std::remove_if(m_saved_chidren.begin(), m_saved_chidren.end(), remove_non_savable_predicate(&server())),
            m_saved_chidren.end());
    }

    server().Perform_destroy(object, net_flags(TRUE, TRUE));
    VERIFY(object->children.empty());

    _OBJECT_ID object_id = object->ID;
    object->ID = server().PerformIDgen(object_id);

#ifdef DEBUG
    if (psAI_Flags.test(aiALife))
        Msg("[LSS] Destroying object [%s][%s][%d]", object->name_replace(), object->s_name.c_str(), object->ID);
#endif

    object->add_offline(m_saved_chidren, update_registries);
    STOP_PROFILE
}

void CALifeSwitchManager::switch_online(CSE_ALifeDynamicObject* object)
{
    START_PROFILE("ALife/switch/switch_online")
#ifdef DEBUG
    //	if (psAI_Flags.test(aiALife))
    Msg("[LSS][%d] Going online [%d][%s][%d] ([%f][%f][%f] : [%f][%f][%f]), on '%s'", Device.dwFrame,
        Device.dwTimeGlobal, object->name_replace(), object->ID, VPUSH(graph().actor()->o_Position),
        VPUSH(object->o_Position), "*SERVER*");
#endif
    object->switch_online();
    STOP_PROFILE
}

void CALifeSwitchManager::switch_offline(CSE_ALifeDynamicObject* object)
{
    START_PROFILE("ALife/switch/switch_offline")
#ifdef DEBUG
    //	if (psAI_Flags.test(aiALife))
    Msg("[LSS][%d] Going offline [%d][%s][%d] ([%f][%f][%f] : [%f][%f][%f]), on '%s'", Device.dwFrame,
        Device.dwTimeGlobal, object->name_replace(), object->ID, VPUSH(graph().actor()->o_Position),
        VPUSH(object->o_Position), "*SERVER*");
#endif
    object->switch_offline();
    STOP_PROFILE
}

bool CALifeSwitchManager::synchronize_location(CSE_ALifeDynamicObject* I)
{
    START_PROFILE("ALife/switch/synchronize_location")
#ifdef DEBUG
    VERIFY3(ai().level_graph().level_id() == ai().game_graph().vertex(I->m_tGraphID)->level_id(), I->s_name.c_str(),
        I->name_replace());
    if (!I->children.empty())
    {
        u32 size = I->children.size();
        ALife::_OBJECT_ID* test = (ALife::_OBJECT_ID*)xr_alloca(size * sizeof(ALife::_OBJECT_ID));
        memcpy(test, &*I->children.begin(), size * sizeof(ALife::_OBJECT_ID));
        std::sort(test, test + size);
        for (u32 i = 1; i < size; ++i)
        {
            VERIFY3(test[i - 1] != test[i], "Child is registered twice in the child list", (*I).name_replace());
        }
    }
#endif // DEBUG

    // check if we do not use ai locations
    if (!I->used_ai_locations())
        return (true);

    // check if we are not attached
    if (0xffff != I->ID_Parent)
        return (true);

    // check if we are not online and have an invalid level vertex id
    if (!I->m_bOnline && !ai().level_graph().valid_vertex_id(I->m_tNodeID))
        return (true);

    return ((*I).synchronize_location());
    STOP_PROFILE
}

void CALifeSwitchManager::try_switch_online(CSE_ALifeDynamicObject* I)
{
    START_PROFILE("ALife/switch/try_switch_online")
    // so, the object is offline
    // checking if the object is not attached
    if (0xffff != I->ID_Parent)
    {
// so, object is attached
// checking if parent is offline too
#ifdef DEBUG
        if (psAI_Flags.test(aiALife))
        {
            CSE_ALifeCreatureAbstract* l_tpALifeCreatureAbstract =
                smart_cast<CSE_ALifeCreatureAbstract*>(objects().object(I->ID_Parent));
            if (l_tpALifeCreatureAbstract && (l_tpALifeCreatureAbstract->get_health() < EPS_L))
                Msg("! uncontrolled situation [%d][%d][%s][%f]", I->ID, I->ID_Parent,
                    l_tpALifeCreatureAbstract->name_replace(), l_tpALifeCreatureAbstract->get_health());
            VERIFY2(!l_tpALifeCreatureAbstract || (l_tpALifeCreatureAbstract->get_health() >= EPS_L),
                "Parent online, item offline...");
            if (objects().object(I->ID_Parent)->m_bOnline)
                Msg("! uncontrolled situation [%d][%d][%s][%f]", I->ID, I->ID_Parent,
                    l_tpALifeCreatureAbstract->name_replace(), l_tpALifeCreatureAbstract->get_health());
        }
        VERIFY2(!objects().object(I->ID_Parent)->m_bOnline, "Parent online, item offline...");
#endif
        return;
    }

    VERIFY2((ai().game_graph().vertex(I->m_tGraphID)->level_id() != ai().level_graph().level_id()) ||
            !Level().Objects.net_Find(I->ID) || Level().Objects.dump_all_objects(),
        make_string("frame [%d] time [%d] object [%s] with id [%d] is offline, but is on the level", Device.dwFrame,
            Device.dwTimeGlobal, I->name_replace(), I->ID));

    I->try_switch_online();

    if (!I->m_bOnline && !I->keep_saved_data_anyway())
        I->clear_client_data();

    STOP_PROFILE
}

void CALifeSwitchManager::try_switch_offline(CSE_ALifeDynamicObject* I)
{
    START_PROFILE("ALife/switch/try_switch_offline")
    // checking if the object is not attached
    if (0xffff != I->ID_Parent)
    {
#ifdef DEBUG
        // checking if parent is online too
        CSE_ALifeCreatureAbstract* l_tpALifeCreatureAbstract =
            smart_cast<CSE_ALifeCreatureAbstract*>(objects().object(I->ID_Parent));
        if (l_tpALifeCreatureAbstract && (l_tpALifeCreatureAbstract->get_health() < EPS_L))
            Msg("! uncontrolled situation [%d][%d][%s][%f]", I->ID, I->ID_Parent,
                l_tpALifeCreatureAbstract->name_replace(), l_tpALifeCreatureAbstract->get_health());

        VERIFY2(!smart_cast<CSE_ALifeCreatureAbstract*>(objects().object(I->ID_Parent)) ||
                (smart_cast<CSE_ALifeCreatureAbstract*>(objects().object(I->ID_Parent))->get_health() >= EPS_L),
            "Parent offline, item online...");

        if (!objects().object(I->ID_Parent)->m_bOnline)
            Msg("! uncontrolled situation [%d][%d][%s][%f]", I->ID, I->ID_Parent,
                l_tpALifeCreatureAbstract->name_replace(), l_tpALifeCreatureAbstract->get_health());

        VERIFY2(objects().object(I->ID_Parent)->m_bOnline, "Parent offline, item online...");
#endif
        return;
    }

    I->try_switch_offline();
    STOP_PROFILE
}

void CALifeSwitchManager::switch_object(CSE_ALifeDynamicObject* I)
{
    if (I->redundant())
    {
        release(I);
        return;
    }

    if (!synchronize_location(I))
        return;

    if (I->m_bOnline)
        try_switch_offline(I);
    else
        try_switch_online(I);

    if (I->redundant())
        release(I);
}
