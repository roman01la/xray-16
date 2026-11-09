#include "StdAfx.h"
#include "alife_host_targets.h"

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "Actor.h"
#include "CustomMonster.h"
#include "Inventory.h"
#include "WeaponAmmo.h"
#include "WeaponMagazinedWGrenade.h"
#include "ai/stalker/ai_stalker.h"
#include "eatable_item.h"
#include "Hit.h"
#include "Include/xrRender/Kinematics.h"
#include "Level.h"
#include "ai_space.h"
#include "alife_host_interests.h"
#include "game_sv_base.h"
#include "xrAICore/Navigation/level_graph.h"
#include "xrNetServer/NET_Messages.h"
#include "xrServer.h"
#include "xrEngine/xr_collide_form.h"
#include "xrServer_Objects_ALife_Monsters.h"

namespace
{
constexpr u16 InvalidId = u16(-1);

CSE_Abstract* findTarget(IPureServer& server, u16 id)
{
    auto* entity = server.GetGameState()->get_entity_from_eid(id);
    return entity && entity->s_flags.test(M_SPAWN_ZONE_TARGET) ? entity : nullptr;
}

u16 spawnTarget(CLevel& level, IPureServer& server, const Fvector& position)
{
    const auto node = ai().level_graph().vertex_id(position);
    auto* definition = level.spawn_item("actor", position, node, InvalidId, true);
    auto* actor = smart_cast<CSE_ALifeCreatureActor*>(definition);
    VERIFY(actor);
    actor->set_health(1.f);
    definition->s_flags.set(M_SPAWN_ZONE_TARGET, true);
    definition->set_name_replace("zone_player");
    NET_Packet packet;
    definition->Spawn_Write(packet, TRUE);
    F_entity_Destroy(definition);
    u16 message;
    packet.r_begin(message);
    const auto* entity = server.Process_spawn(packet, server.GetServerClient()->ID);
    return entity ? entity->ID : InvalidId;
}

using CorpseBytes = std::vector<unsigned char>;

template <typename Integer>
void appendCorpseInteger(CorpseBytes& bytes, Integer value)
{
    for (unsigned i = 0; i < sizeof(value); ++i)
        bytes.push_back(static_cast<unsigned char>(value >> (8 * i)));
}

bool appendCorpseName(CorpseBytes& bytes, const shared_str& value)
{
    if (!value.c_str() || !value.size() || value.size() > 128)
        return false;
    const std::string_view name(value.c_str(), value.size());
    if (name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-") != std::string_view::npos)
        return false;
    bytes.push_back(static_cast<unsigned char>(name.size()));
    bytes.insert(bytes.end(), name.begin(), name.end());
    return true;
}

bool appendCorpseMagazine(CorpseBytes& bytes, const xr_vector<CCartridge>& magazine)
{
    if (magazine.size() > 512)
        return false;
    const auto header = bytes.size();
    bytes.push_back(0);
    for (std::size_t start = 0; start < magazine.size();)
    {
        const auto& ammo = magazine[start].m_ammoSect;
        auto end = start + 1;
        while (end < magazine.size() && magazine[end].m_ammoSect == ammo)
            ++end;
        if (bytes[header] == 255 || !appendCorpseName(bytes, ammo))
            return false;
        ++bytes[header];
        appendCorpseInteger(bytes, static_cast<u16>(end - start));
        start = end;
    }
    return true;
}

bool appendCorpseItem(CorpseBytes& bytes, CInventoryItem& item)
{
    const auto condition = item.GetCondition();
    if (!(condition >= 0.f && condition <= 1.f) || !appendCorpseName(bytes, item.object().cNameSect()))
        return false;
    std::uint32_t bits;
    std::memcpy(&bits, &condition, sizeof(bits));
    appendCorpseInteger(bytes, bits);
    const auto upgrades = item.get_upgrades();
    if (upgrades.size() > 32)
        return false;
    bytes.push_back(static_cast<unsigned char>(upgrades.size()));
    for (const auto& upgrade : upgrades)
        if (!appendCorpseName(bytes, upgrade))
            return false;

    if (const auto* ammo = smart_cast<const CWeaponAmmo*>(&item))
    {
        if (!ammo->m_boxCurr)
            return false;
        bytes.push_back(1);
        appendCorpseInteger(bytes, ammo->m_boxCurr);
    }
    else if (const auto* consumable = smart_cast<const CEatableItem*>(&item))
    {
        if (!consumable->GetRemainingUses())
            return false;
        bytes.push_back(2);
        bytes.push_back(consumable->GetRemainingUses());
    }
    else if (const auto* weapon = smart_cast<const CWeapon*>(&item); weapon && !weapon->m_ammoTypes.empty())
    {
        const auto* launcher = smart_cast<const CWeaponMagazinedWGrenade*>(weapon);
        const bool grenadesActive = launcher && launcher->m_bGrenadeMode;
        const auto& types = grenadesActive ? launcher->m_ammoTypes2 : weapon->m_ammoTypes;
        const auto selected = grenadesActive ? launcher->m_ammoType2 : weapon->m_ammoType;
        const auto& bullets = grenadesActive ? launcher->m_magazine2 : weapon->m_magazine;
        bytes.push_back(3);
        if (selected >= types.size() || !appendCorpseName(bytes, types[selected]) || !appendCorpseMagazine(bytes, bullets))
            return false;
        if (launcher)
        {
            if (!appendCorpseMagazine(bytes, grenadesActive ? weapon->m_magazine : launcher->m_magazine2))
                return false;
        }
        else
            bytes.push_back(0);
        const auto addonCount = bytes.size();
        bytes.push_back(0);
        const auto addon = [&](const shared_str& section) {
            ++bytes[addonCount];
            return appendCorpseName(bytes, section);
        };
        if (weapon->get_ScopeStatus() == ALife::eAddonAttachable && weapon->IsScopeAttached() && !addon(weapon->GetScopeName()))
            return false;
        if (weapon->get_SilencerStatus() == ALife::eAddonAttachable && weapon->IsSilencerAttached() && !addon(weapon->GetSilencerName()))
            return false;
        if (weapon->get_GrenadeLauncherStatus() == ALife::eAddonAttachable && weapon->IsGrenadeLauncherAttached()
            && !addon(weapon->GetGrenadeLauncherName()))
            return false;
        const auto* magazined = smart_cast<const CWeaponMagazined*>(weapon);
        bytes.push_back(magazined ? magazined->NativeFireModeSelector() : 0);
        bytes.push_back((grenadesActive ? 1 : 0) | (weapon->IsMisfire() ? 2 : 0));
    }
    else
        bytes.push_back(0);
    return true;
}
}

void AlifeHostTargets::observeDeath(CLevel& level, CSE_Abstract& entity)
{
    const auto* definition = smart_cast<const CSE_ALifeHumanStalker*>(&entity);
    if (!definition || definition->m_story_id != INVALID_STORY_ID || definition->m_spawn_story_id != INVALID_SPAWN_STORY_ID
        || m_corpseCandidates.size() >= 64)
        return;
    auto* npc = smart_cast<CAI_Stalker*>(level.Objects.net_Find(entity.ID));
    if (!npc || !npc->Local() || npc->getDestroy())
        return;
    if (const auto* ini = npc->spawn_ini(); ini && ini->section_exist("story_object"))
        return;
    const auto& carried = npc->inventory().m_all;
    const bool armed = std::any_of(carried.begin(), carried.end(), [](CInventoryItem* item) {
        const auto* weapon = smart_cast<const CWeapon*>(item);
        return weapon && !weapon->m_ammoTypes.empty();
    });
    if (armed)
        m_corpseCandidates.push_back({entity.ID, npc->spawn_time(), Device.dwTimeGlobal});
}

void AlifeHostTargets::collectCorpses(CLevel& level, IPureServer& server, AlifeHostInterests& interests)
{
    // The server death event precedes the native Lua callback and its
    // follow-up ownership events. Let those settle before reading the body.
    constexpr u32 SettleMs = 250;
    for (unsigned attempt = 0; !m_corpseCandidates.empty() && attempt < 8; ++attempt)
    {
        const auto candidate = m_corpseCandidates.front();
        if (Device.dwTimeGlobal - candidate.died < SettleMs)
            break;
        m_corpseCandidates.pop_front();
        auto* npc = smart_cast<CAI_Stalker*>(level.Objects.net_Find(candidate.id));
        if (!npc || npc->g_Alive() || npc->getDestroy() || npc->spawn_time() != candidate.spawn || !_valid(npc->Position()))
            continue;
        CorpseBytes bytes;
        std::vector<u16> moved;
        for (auto* item : npc->inventory().m_all)
        {
            const auto id = item->object().ID();
            const auto* native = smart_cast<const CSE_ALifeDynamicObject*>(server.GetGameState()->get_entity_from_eid(id));
            if (!native || native->ID_Parent != candidate.id || item->object().getDestroy() || item->IsQuestItem()
                || native->m_story_id != INVALID_STORY_ID || native->m_spawn_story_id != INVALID_SPAWN_STORY_ID)
                continue;
            const auto oldSize = bytes.size();
            if (!appendCorpseItem(bytes, *item) || bytes.size() + 41 > 8192)
            {
                bytes.resize(oldSize);
                continue;
            }
            moved.push_back(id);
            if (moved.size() == 64)
                break;
        }
        const auto& p = npc->Position();
        if (!interests.queueCorpse({p.x, p.y, p.z}, static_cast<unsigned char>(moved.size()), bytes))
            continue;
        // Match the stock Lua ALife release of an online item. The sidecar
        // outbox now owns this inventory and can resend until SQLite commits.
        for (const auto id : moved)
        {
            NET_Packet packet;
            packet.w_begin(M_EVENT);
            packet.w_u32(level.timeServer());
            packet.w_u16(GE_DESTROY);
            packet.w_u16(id);
            level.Send(packet, net_flags(TRUE, TRUE));
        }
        Msg("* Zone native corpse queued: npc=%u items=%u", candidate.id, static_cast<unsigned>(moved.size()));
    }
}

void AlifeHostTargets::update(CLevel& level, IPureServer& server, const AlifeHostInterests& interests)
{
    auto* director = smart_cast<CActor*>(level.CurrentEntity());
    if (!server.GetServerClient() || !director)
        return;
    // The original actor stays available to stock campaign Lua.
    director->GetSpatialData().type &= ~STYPE_VISIBLEFORAI;
    if (m_poseRevision == interests.poseRevision())
        return;
    m_poseRevision = interests.poseRevision();
    ++m_update;
    const auto remove = [&](u16 id) {
        if (auto* entity = findTarget(server, id))
            server.Perform_destroy(entity, net_flags(TRUE, TRUE));
    };
    if (interests.epoch() != m_epoch)
    {
        for (const auto& [id, target] : m_targets)
            remove(target.nativeId);
        m_targets.clear();
        m_epoch = interests.epoch();
    }

    for (const auto& player : interests)
    {
        const Fvector position{player.x, player.y, player.z};
        auto it = m_targets.find(player.id);
        if (it != m_targets.end() && it->second.life != player.life)
        {
            remove(it->second.nativeId);
            m_targets.erase(it);
            it = m_targets.end();
        }
        if (it != m_targets.end() && !findTarget(server, it->second.nativeId))
        {
            m_targets.erase(it);
            it = m_targets.end();
        }
        if (it == m_targets.end())
        {
            const auto id = spawnTarget(level, server, position);
            if (id != InvalidId)
                m_targets.emplace(player.id, Target{player.life, m_update, id});
            continue;
        }
        auto& target = it->second;
        target.seenUpdate = m_update;
        if (auto* actor = smart_cast<CActor*>(level.Objects.net_Find(target.nativeId)); actor && actor->zoneAlifeTarget())
            actor->applyZoneAlifePose(position, player.yaw, player.crouched);
    }

    for (auto it = m_targets.begin(); it != m_targets.end();)
    {
        if (it->second.seenUpdate == m_update)
        {
            ++it;
            continue;
        }
        remove(it->second.nativeId);
        it = m_targets.erase(it);
    }
}
void AlifeHostTargets::reportHit(std::uint16_t nativeId, const SHit& hit, AlifeHostInterests& interests) const
{
    // Rust already simulates authored anomaly fields. Only a native NPC can
    // originate one of these damage reports, including its delayed projectiles.
    if (m_epoch != interests.epoch() || !smart_cast<CCustomMonster*>(hit.who))
        return;
    const auto target = std::find_if(m_targets.begin(), m_targets.end(),
        [nativeId](const auto& entry) { return entry.second.nativeId == nativeId; });
    if (target == m_targets.end())
        return;
    unsigned kind;
    switch (hit.hit_type)
    {
    case ALife::eHitTypeWound:
    case ALife::eHitTypeWound_2: kind = 0; break;
    case ALife::eHitTypeStrike:
    case ALife::eHitTypePhysicStrike: kind = 1; break;
    case ALife::eHitTypeFireWound: kind = 2; break;
    case ALife::eHitTypeExplosion: kind = 3; break;
    case ALife::eHitTypeTelepatic: kind = 4; break;
    case ALife::eHitTypeBurn:
    case ALife::eHitTypeLightBurn: kind = 5; break;
    case ALife::eHitTypeChemicalBurn: kind = 6; break;
    case ALife::eHitTypeShock: kind = 7; break;
    case ALife::eHitTypeRadiation: kind = 8; break;
    default: return;
    }
    const char* bone = "";
    if (kind == 2)
        if (const auto* object = Level().Objects.net_Find(nativeId))
            if (auto* skeleton = smart_cast<IKinematics*>(object->Visual()); skeleton && hit.boneID < skeleton->LL_BoneCount())
                bone = skeleton->LL_BoneName_dbg(hit.boneID);
    interests.queueHit(target->first, target->second.life, kind, hit.power,
        kind == 2 ? hit.armor_piercing : 0.f, bone);
}
std::optional<std::uint16_t> AlifeHostTargets::applyAttack(CLevel& level, const AlifeHostInterests::Attack& attack) const
{
    const auto source = m_targets.find(attack.shooter);
    if (m_epoch != attack.epoch || source == m_targets.end() || source->second.life != attack.life)
        return std::nullopt;
    auto* shooter = smart_cast<CActor*>(level.Objects.net_Find(source->second.nativeId));
    auto* npc = smart_cast<CCustomMonster*>(level.Objects.net_Find(static_cast<u16>(attack.target)));
    if (!shooter || !shooter->zoneAlifeTarget() || shooter->getDestroy() || !npc || !npc->Local() ||
        npc->getDestroy() || !npc->g_Alive() || npc->spawn_time() != attack.spawn || !npc->Visual())
        return std::nullopt;
    auto* skeleton = npc->Visual()->dcast_PKinematics();
    if (!skeleton)
        return std::nullopt;

    Fvector direction{attack.direction[0], attack.direction[1], attack.direction[2]};
    direction.normalize();
    u16 bone = skeleton->LL_GetBoneRoot();
    Fvector bonePosition{0.f, 0.f, 0.f};
    if (auto* form = npc->GetCForm())
    {
        // The server checked the rewound model bounds and wall cover. Reuse
        // the current skeleton only to locate the stock bone and hit effect.
        Fvector contact, start;
        npc->XFORM().transform_tiny(contact, Fvector{attack.offset[0], attack.offset[1], attack.offset[2]});
        const float radius = std::max(1.f, npc->Radius() * 2.f);
        start.mad(contact, direction, -radius);
        collide::rq_results result;
        if (form->_RayQuery(collide::ray_defs(start, direction, radius * 2.f, CDB::OPT_ONLYNEAREST, collide::rqtObject), result)
            && result.r_count() && result.r_begin()->element >= 0 && result.r_begin()->element < skeleton->LL_BoneCount())
        {
            const auto& intersection = *result.r_begin();
            bone = static_cast<u16>(intersection.element);
            contact.mad(start, direction, intersection.range);
            Fmatrix transform, inverse;
            transform.mul_43(npc->XFORM(), skeleton->LL_GetTransform(bone));
            inverse.invert(transform);
            inverse.transform_tiny(bonePosition, contact);
        }
    }
    const auto type = attack.kind == 0 ? ALife::eHitTypeFireWound :
        (attack.kind == 1 ? ALife::eHitTypeWound : ALife::eHitTypeExplosion);
    for (float power : attack.power)
    {
        if (power <= 0.f || !npc->g_Alive())
            break;
        SHit hit(power, direction, shooter, bone, bonePosition, attack.impulse, type, attack.penetration, false);
        npc->SetHitInfo(shooter, nullptr, bone, bonePosition, direction);
        npc->Hit(&hit);
    }
    const auto health = npc->GetfHealth();
    if (!npc->g_Alive() || !std::isfinite(health))
        return 0;
    return static_cast<u16>(std::max(1.f, std::ceil(std::clamp(health, 0.f, 1.f) * 100.f)));
}
#endif
