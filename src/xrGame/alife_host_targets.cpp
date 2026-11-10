#include "StdAfx.h"
#include "alife_host_targets.h"

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "Actor.h"
#include "ActorCondition.h"
#include "CharacterPhysicsSupport.h"
#include "CombatRules.h"
#include "CustomMonster.h"
#include "Inventory.h"
#include "WeaponAmmo.h"
#include "xrEngine/xr_level_controller.h"
#include <unordered_set>
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
#include "xrPhysics/IPHWorld.h"
#include "xrPhysics/IColisiondamageInfo.h"
#include "xrServer.h"
#include "xrServer_Objects_ALife_Items.h"
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

u16 spawnMirroredItem(xrServer& server, CSE_Abstract& definition)
{
    auto* alife = smart_cast<CSE_ALifeObject*>(&definition);
    if (!alife)
        return InvalidId;
    alife->m_flags.set(CSE_ALifeObject::flCanSave | CSE_ALifeObject::flVisibleForAI |
        CSE_ALifeObject::flUsefulForAI, false);
    definition.s_flags.set(M_SPAWN_ZONE_TARGET, true);
    NET_Packet packet;
    definition.Spawn_Write(packet, TRUE);
    u16 message;
    packet.r_begin(message);
    const auto* spawned = server.Process_spawn(packet, server.GetServerClient()->ID);
    return spawned ? spawned->ID : InvalidId;
}

std::optional<u8> ammoIndex(const xr_vector<shared_str>& types, const std::string& section)
{
    const auto found = std::find_if(types.begin(), types.end(), [&](const auto& type) { return type.c_str() == section; });
    if (found == types.end() || found - types.begin() >= CWeapon::undefined_ammo_type)
        return std::nullopt;
    return static_cast<u8>(found - types.begin());
}

bool loadMagazine(const xr_vector<shared_str>& types, const std::vector<std::string>& rounds,
    xr_vector<CCartridge>& magazine)
{
    magazine.reserve(rounds.size());
    for (const auto& section : rounds)
    {
        const auto index = ammoIndex(types, section);
        if (!index)
            return false;
        magazine.emplace_back().Load(section.c_str(), *index);
    }
    return true;
}

bool applyWeapon(CWeapon& weapon, const AlifeHostInterests::PlayerWeapon& desired)
{
    const auto& item = desired.item;
    auto* launcher = smart_cast<CWeaponMagazinedWGrenade*>(&weapon);
    const bool usingLauncher = launcher && launcher->m_bGrenadeMode;
    const auto& rifleTypes = usingLauncher ? launcher->m_ammoTypes2 : weapon.m_ammoTypes;
    const auto index = ammoIndex(rifleTypes, item.selectedAmmunition);
    xr_vector<CCartridge> bullets, grenades;
    if (!index || !loadMagazine(rifleTypes, item.cartridges, bullets))
        return false;
    const bool loadedLauncher = !item.launcherCartridges.empty();
    std::optional<u8> grenadeIndex;
    if (item.launcherMode || loadedLauncher)
    {
        if (!launcher || !weapon.IsGrenadeLauncherAttached())
            return false;
        const auto& grenadeTypes = usingLauncher ? weapon.m_ammoTypes : launcher->m_ammoTypes2;
        if (grenadeTypes.empty() || !loadMagazine(grenadeTypes, item.launcherCartridges, grenades))
            return false;
        grenadeIndex = loadedLauncher ? ammoIndex(grenadeTypes, item.launcherCartridges.back()) : std::optional<u8>(0);
    }
    if (usingLauncher)
        launcher->PerformSwitchGL();
    weapon.SetCondition(item.condition);
    weapon.SetPresentationMisfire(item.jammed);
    weapon.SetAmmoType(*index);
    weapon.m_DefaultCartridge.Load(weapon.m_ammoTypes[*index].c_str(), *index);
    weapon.SetAmmoElapsed(static_cast<int>(bullets.size()));
    weapon.m_magazine.swap(bullets);
    if (launcher)
    {
        launcher->m_magazine2.swap(grenades);
        launcher->iAmmoElapsed2 = static_cast<u8>(launcher->m_magazine2.size());
        if (grenadeIndex)
        {
            launcher->m_ammoType2 = *grenadeIndex;
            launcher->m_DefaultCartridge2.Load(launcher->m_ammoTypes2[*grenadeIndex].c_str(), *grenadeIndex);
        }
        if (item.launcherMode)
            launcher->PerformSwitchGL();
        launcher->UpdateGrenadeVisibility(item.launcherMode && loadedLauncher);
    }
    weapon.m_fCurrentCartirdgeDisp = weapon.m_magazine.empty() ? weapon.m_DefaultCartridge.param_s.kDisp :
        weapon.m_magazine.back().param_s.kDisp;
    if (auto* magazine = smart_cast<CWeaponMagazined*>(&weapon))
    {
        magazine->SetPresentationFireMode(item.fireMode);
        if (!desired.scope.empty())
            magazine->SetPresentationScope(desired.scope.c_str());
    }
    return true;
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

void AlifeHostTargets::writeHitboxes(CGameObject& actor, const Fvector& feet, std::vector<unsigned char>& packet)
{
    constexpr std::size_t Header = 44, Shape = 96, MaxShapes = 64;
    packet.clear();
    auto* skeleton = PKinematics(actor.Visual());
    auto* form = smart_cast<CCF_Skeleton*>(actor.GetCForm());
    if (!skeleton || !form)
        return;
    packet.resize(Header);
    const std::array sampleFeet{feet.x, feet.y, feet.z};
    std::memcpy(packet.data() + 32, sampleFeet.data(), sizeof(sampleFeet));
    for (const auto& element : form->RefreshElements())
    {
        if (!element.valid())
            continue;
        if (packet.size() == Header + Shape * MaxShapes)
            break;
        const std::string_view bone = skeleton->LL_BoneName_dbg(element.elem_id);
        if (bone.empty() || bone.size() >= 32)
            continue;
        std::array<float, 15> data{};
        const auto vector = [&](unsigned index, const Fvector& value) {
            data[index] = value.x;
            data[index + 1] = value.y;
            data[index + 2] = value.z;
        };
        unsigned char type;
        switch (element.type)
        {
        case SBoneShape::stBox:
            type = 1;
            vector(0, element.b_IM.i);
            vector(3, element.b_IM.j);
            vector(6, element.b_IM.k);
            vector(9, element.b_IM.c);
            vector(12, element.b_hsize);
            break;
        case SBoneShape::stSphere:
            type = 2;
            vector(0, element.s_sphere.P);
            data[3] = element.s_sphere.R;
            break;
        case SBoneShape::stCylinder:
            type = 3;
            vector(0, element.c_cylinder.m_center);
            vector(3, element.c_cylinder.m_direction);
            data[6] = element.c_cylinder.m_height;
            data[7] = element.c_cylinder.m_radius;
            break;
        default:
            continue;
        }
        const auto offset = packet.size();
        packet.resize(offset + Shape);
        auto* row = packet.data() + offset;
        row[0] = type;
        std::copy(bone.begin(), bone.end(), row + 4);
        std::memcpy(row + 36, data.data(), sizeof(data));
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
                m_targets.emplace(player.id, Target{.life = player.life, .seenUpdate = m_update,
                    .nativeId = id, .nativeCondition = player.nativeCondition, .armour = {}, .armourGeneration = {},
                    .desiredWeapon = {}, .spawnedWeapon = {}, .weaponRevision = {}});
            continue;
        }
        auto& target = it->second;
        target.seenUpdate = m_update;
        target.nativeCondition = player.nativeCondition;
        if (!interests.nativeMovement())
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
void AlifeHostTargets::reconcileArmour(CLevel& level, xrServer& server, CActor& actor, Target& target)
{
    constexpr u16 Slots[] = {OUTFIT_SLOT, HELMET_SLOT};
    const bool probe = strstr(Core.Params, "-zone-alife-armour-probe") != nullptr;
    auto& inventory = actor.inventory();
    for (std::size_t i = 0; i < target.armour.size(); ++i)
    {
        auto& equipped = target.armour[i];
        const auto& desired = equipped.desired;
        const bool belt = i >= std::size(Slots);
        const auto slot = belt ? u16(AlifeHostInterests::PlayerArmour::BeltStart + i - std::size(Slots)) : Slots[i];
        if (equipped.id == InvalidId && desired.section.empty())
            continue;
        auto* entity = findTarget(server, equipped.id);
        if (entity && entity->ID_Parent != actor.ID())
            entity = nullptr;
        if (entity)
        {
            auto* item = smart_cast<CSE_ALifeInventoryItem*>(entity);
            const auto sameUpgrade = [](const shared_str& a, const std::string& b) { return a.c_str() == b; };
            if (item && desired.section == entity->name() &&
                std::equal(item->m_upgrades.begin(), item->m_upgrades.end(), desired.upgrades.begin(),
                    desired.upgrades.end(), sameUpgrade))
            {
                item->m_fCondition = desired.condition;
                if (auto* local = smart_cast<CInventoryItem*>(level.Objects.net_Find(equipped.id));
                    local && local->object().H_Parent() == &actor && !local->object().getDestroy())
                {
                    local->SetCondition(desired.condition);
                    if (belt)
                    {
                        if (!inventory.BeltWidth() && inventory.InBelt(local))
                            inventory.Ruck(local, true);
                        else if (!inventory.InBelt(local))
                            inventory.Belt(local);
                    }
                    else if (!inventory.ItemFromSlot(slot))
                        inventory.Slot(slot, local, true, true);
                    if (probe && (belt ? inventory.InBelt(local) : inventory.ItemFromSlot(slot) == local) &&
                        equipped.lastReported != desired.condition)
                    {
                        equipped.lastReported = desired.condition;
                        Msg("* Zone player armour equipped: %u %s %.3f", slot, desired.section.c_str(), desired.condition);
                        if (belt)
                            Msg("* Zone player belt chemical protection: %.6f",
                                actor.GetProtection_ArtefactsOnBelt(ALife::eHitTypeChemicalBurn));
                    }
                }
                continue;
            }
            auto* parent = findTarget(server, actor.ID());
            if (parent)
            {
                server.Perform_reject(entity, parent, 2 * NET_Latency);
                server.Perform_destroy(entity, net_flags(TRUE, TRUE));
                if (probe)
                    Msg("* Zone player armour removed from slot %u", slot);
            }
            equipped.id = InvalidId;
            equipped.lastReported = -1.f;
        }
        if (desired.section.empty() || (belt ? !inventory.BeltWidth() : inventory.ItemFromSlot(slot) != nullptr) ||
            !pSettings->section_exist(desired.section.c_str()))
            continue;
        const auto position = actor.Position();
        auto* definition = level.spawn_item(desired.section.c_str(), position, ai().level_graph().vertex_id(position),
            actor.ID(), true);
        auto* item = smart_cast<CSE_ALifeInventoryItem*>(definition);
        const bool correctClass = belt ? bool(smart_cast<CSE_ALifeItemArtefact*>(definition)) :
            slot == OUTFIT_SLOT ? bool(smart_cast<CSE_ALifeItemCustomOutfit*>(definition)) :
                bool(smart_cast<CSE_ALifeItemHelmet*>(definition));
        if (item && correctClass)
        {
            item->m_fCondition = desired.condition;
            for (const auto& name : desired.upgrades)
                item->m_upgrades.emplace_back(name.c_str());
            equipped.id = spawnMirroredItem(server, *definition);
        }
        F_entity_Destroy(definition);
    }
}

bool AlifeHostTargets::armourReady(CLevel& level, CActor& actor, const Target& target)
{
    const auto& inventory = actor.inventory();
    constexpr u16 Slots[] = {OUTFIT_SLOT, HELMET_SLOT};
    std::size_t beltItems = 0;
    for (std::size_t i = 0; i < target.armour.size(); ++i)
    {
        const auto& entry = target.armour[i];
        const bool belt = i >= std::size(Slots);
        auto* slotted = belt ? nullptr : inventory.ItemFromSlot(Slots[i]);
        if (entry.desired.section.empty())
        {
            if (slotted)
                return false;
            continue;
        }
        auto* item = smart_cast<CInventoryItem*>(level.Objects.net_Find(entry.id));
        if (!item || item->object().getDestroy() || item->object().H_Parent() != &actor ||
            (belt ? !inventory.InBelt(item) : item != slotted) ||
            item->object().cNameSect().c_str() != entry.desired.section ||
            item->GetCondition() != entry.desired.condition ||
            !std::all_of(entry.desired.upgrades.begin(), entry.desired.upgrades.end(),
                [item](const auto& name) { return item->has_upgrade(name.c_str()); }))
            return false;
        beltItems += belt;
    }
    if (inventory.m_belt.size() != beltItems)
        return false;
    return true;
}

std::optional<AlifeHostInterests::ArmourImpact> AlifeHostTargets::previewArmour(CLevel& level, CActor& actor,
    const Target& target, std::uint32_t kind, float power, u16 bone, float penetration)
{
    if (!target.armourGeneration || !(power > 0.f && power <= 10.f))
        return std::nullopt;
    ALife::EHitType type;
    switch (kind)
    {
    case 0: type = ALife::eHitTypeWound; break;
    case 1: type = ALife::eHitTypeStrike; break;
    case 2: type = ALife::eHitTypeFireWound; break;
    case 3: type = ALife::eHitTypeExplosion; break;
    default: return std::nullopt;
    }

    if (!armourReady(level, actor, target)) return std::nullopt;
    if (type == ALife::eHitTypeFireWound && bone == BI_NONE)
        return std::nullopt;
    const auto reduced = type == ALife::eHitTypeFireWound ? power : actor.HitArtefactsOnBelt(power, type);
    const auto sample = actor.conditions().PreviewZoneArmourHit(reduced, type, bone, penetration);
    if (!(sample.power >= 0.f && sample.power <= 10.f))
        return std::nullopt;
    if (strstr(Core.Params, "-zone-alife-armour-probe"))
        Msg("* Zone armour impact: generation=%llu kind=%u incoming=%.6f power=%.6f outfit=%.6f helmet=%.6f",
            static_cast<unsigned long long>(*target.armourGeneration), kind, power, sample.power, sample.outfit, sample.helmet);
    return AlifeHostInterests::ArmourImpact{*target.armourGeneration, sample.power, sample.outfit, sample.helmet,
        sample.wound, sample.health, sample.powerLoss};
}

void AlifeHostTargets::reconcileReserveAmmo(CLevel& level, xrServer& server, CActor& actor, Target& target)
{
    const auto& desired = target.desiredWeapon;
    if (desired.item.index && (!target.armourGeneration || *target.armourGeneration != desired.generation))
        return;
    if (desired.item.index && target.reserveGeneration && desired.generation < *target.reserveGeneration)
        return;
    // Validate every authored box before mutating the mirrored inventory.
    for (const auto& source : desired.reserve)
        if (!pSettings->section_exist(source.section.c_str()) ||
            !pSettings->line_exist(source.section.c_str(), "box_size") ||
            source.rounds > pSettings->r_u32(source.section.c_str(), "box_size"))
            return;
    for (auto it = target.reserve.begin(); it != target.reserve.end();)
    {
        const auto source = std::find_if(desired.reserve.begin(), desired.reserve.end(),
            [&](const auto& item) { return item.id == it->first && item.section == it->second.section; });
        if (desired.item.index && source != desired.reserve.end()) { ++it; continue; }
        if (auto* entity = findTarget(server, it->second.nativeId); entity && entity->ID_Parent == actor.ID())
            if (auto* parent = findTarget(server, actor.ID()))
            {
                server.Perform_reject(entity, parent, 2 * NET_Latency);
                server.Perform_destroy(entity, net_flags(TRUE, TRUE));
            }
        it = target.reserve.erase(it);
    }
    if (!desired.item.index) { target.reserveGeneration.reset(); return; }
    bool ready = true;
    for (const auto& source : desired.reserve)
    {
        auto& entry = target.reserve[source.id];
        entry.section = source.section;
        auto* entity = findTarget(server, entry.nativeId);
        if (!entity)
        {
            // A native reload may consume and destroy this box before Rust
            // commits its delta. Keep a revision tombstone instead of respawning
            // the unchanged authoritative snapshot with its old full count.
            if (entry.revision && source.revision <= *entry.revision)
            { ready = false; continue; }
            entry.nativeId = InvalidId;
            entry.revision.reset();
            const auto position = actor.Position();
            auto* definition = level.spawn_item(source.section.c_str(), position,
                ai().level_graph().vertex_id(position), actor.ID(), true);
            if (auto* ammo = smart_cast<CSE_ALifeItemAmmo*>(definition))
            {
                ammo->a_elapsed = source.rounds;
                entry.nativeId = spawnMirroredItem(server, *definition);
            }
            F_entity_Destroy(definition);
            ready = false;
            continue;
        }
        auto* ammo = smart_cast<CWeaponAmmo*>(level.Objects.net_Find(entry.nativeId));
        auto* serverAmmo = smart_cast<CSE_ALifeItemAmmo*>(entity);
        if (entity->ID_Parent != actor.ID() || source.section != entity->name() || !ammo || !serverAmmo ||
            ammo->H_Parent() != &actor || ammo->getDestroy() || source.rounds > ammo->m_boxSize)
        { ready = false; continue; }
        if (entry.revision && source.revision < *entry.revision)
        { ready = false; continue; }
        // Repeated snapshots must not replenish rounds used by a native action.
        if (entry.revision != source.revision)
        {
            ammo->m_boxCurr = source.rounds;
            serverAmmo->a_elapsed = source.rounds;
            ammo->SetDropManual(false);
            actor.inventory().InvalidateState();
            entry.revision = source.revision;
        }
        if (!actor.inventory().InRuck(ammo))
            ready = actor.inventory().Ruck(ammo, true) && ready;
    }
    if (ready) target.reserveGeneration = desired.generation;
}

std::optional<xray::zone_weapon_action::WeaponResult> AlifeHostTargets::captureWeapon(CActor& actor, const Target& target)
{
    using namespace xray::zone_weapon_action;
    auto* weapon = smart_cast<CWeapon*>(actor.inventory().ItemFromSlot(target.spawnedWeapon.item.index));
    if (!weapon || weapon->ID() != target.weaponId || weapon->H_Parent() != &actor || weapon->getDestroy() ||
        weapon->IsPending() || weapon->GetState() != CWeapon::eIdle || weapon->GetNextState() != CWeapon::eIdle)
        return {};
    WeaponResult state;
    state.condition = weapon->GetCondition(); state.jammed = weapon->IsMisfire();
    auto* launcher = smart_cast<CWeaponMagazinedWGrenade*>(weapon);
    state.launcher = launcher && launcher->m_bGrenadeMode;
    if (auto* magazined = smart_cast<CWeaponMagazined*>(weapon)) state.mode = magazined->NativeFireModeSelector();
    const auto& types = state.launcher ? launcher->m_ammoTypes2 : weapon->m_ammoTypes;
    const auto selected = state.launcher ? launcher->m_ammoType2 : weapon->m_ammoType;
    if (selected >= types.size()) return {};
    state.selected = types[selected].c_str();
    const auto& rounds = state.launcher ? launcher->m_magazine2 : weapon->m_magazine;
    for (const auto& round : rounds) state.cartridges.emplace_back(round.m_ammoSect.c_str());
    if (launcher)
        for (const auto& round : state.launcher ? weapon->m_magazine : launcher->m_magazine2)
            state.grenades.emplace_back(round.m_ammoSect.c_str());
    const auto identity = [](const std::string& text, std::array<unsigned char,16>& bytes) {
        if (text.size()!=32) return false;
        const auto digit=[](char c)->int { if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1; };
        for(unsigned i=0;i<16;++i){int a=digit(text[2*i]),b=digit(text[2*i+1]);if(a<0||b<0)return false;bytes[i]=(a<<4)|b;}
        return std::any_of(bytes.begin(),bytes.end(),[](auto b){return b!=0;});
    };
    std::unordered_set<u16> seen;
    // Include consumed/destroyed persisted boxes with zero rounds. Omitting
    // them would leave their pre-reload rounds in the durable inventory.
    for (const auto& [id, slot] : target.reserve)
    {
        if (!slot.revision || slot.nativeId==InvalidId || !seen.insert(slot.nativeId).second) return {};
        AmmoResult ammo; if (!identity(id,ammo.id)) return {};
        ammo.revision=*slot.revision; ammo.native=slot.nativeId; ammo.section=slot.section;
        for (auto* item : actor.inventory().m_all)
            if (item->object().ID()==slot.nativeId && !item->object().getDestroy())
            {
                auto* box=smart_cast<CWeaponAmmo*>(item);
                if (!box || box->H_Parent()!=&actor || slot.section!=box->cNameSect().c_str()) return {};
                ammo.rounds=box->m_boxCurr;
            }
        state.reserve.push_back(std::move(ammo));
    }
    // Stock unloading can create new ammo boxes. Retain their native identity
    // for this result; persistence assigns their permanent inventory IDs.
    for (auto* item : actor.inventory().m_all)
        if (auto* box=smart_cast<CWeaponAmmo*>(item); box && !box->getDestroy() && !seen.count(box->ID()))
        {
            if (box->H_Parent()!=&actor) return {};
            AmmoResult ammo;ammo.native=box->ID();ammo.rounds=box->m_boxCurr;ammo.section=box->cNameSect().c_str();
            state.reserve.push_back(std::move(ammo));
        }
    std::sort(state.reserve.begin(),state.reserve.end(),[](const auto& a,const auto& b){return a.native<b.native;});
    return state;
}

void AlifeHostTargets::reconcileWeapon(CLevel& level, xrServer& server, CActor& actor, Target& target,
    AlifeHostInterests& interests)
{
    if (!target.weaponReplay.settled) return; // Freeze mirrors until result commit/abort.
    const auto& desired = target.desiredWeapon;
    const auto& item = desired.item;
    reconcileReserveAmmo(level, server, actor, target);
    if (!item.index && target.weaponId == InvalidId)
        return;
    const bool probe = strstr(Core.Params, "-zone-alife-weapon-probe") != nullptr;
    auto& inventory = actor.inventory();
    auto* entity = findTarget(server, target.weaponId);
    const auto& spawned = target.spawnedWeapon;
    const bool sameWeapon = entity && entity->ID_Parent == actor.ID() &&
        item.id == spawned.item.id && item.index == spawned.item.index && item.section == spawned.item.section &&
        item.upgrades == spawned.item.upgrades && desired.scope == spawned.scope && desired.addons == spawned.addons;
    if (!sameWeapon && target.weaponId != InvalidId)
    {
        if (auto* parent = findTarget(server, actor.ID()); entity && parent && entity->ID_Parent == actor.ID())
        {
            if (inventory.GetActiveSlot() == spawned.item.index)
                inventory.SetActiveSlot(NO_ACTIVE_SLOT);
            server.Perform_reject(entity, parent, 2 * NET_Latency);
            server.Perform_destroy(entity, net_flags(TRUE, TRUE));
            if (probe)
                Msg("* Zone player weapon removed from slot %u native=%u", spawned.item.index, target.weaponId);
        }
        target.weaponId = InvalidId;
        target.weaponRevision.reset();
    }
    if (!item.index)
        return;
    if (target.weaponId == InvalidId)
    {
        if (inventory.ItemFromSlot(item.index) || !pSettings->section_exist(item.section.c_str()))
            return;
        const auto position = actor.Position();
        auto* definition = level.spawn_item(item.section.c_str(), position, ai().level_graph().vertex_id(position),
            actor.ID(), true);
        if (auto* weapon = smart_cast<CSE_ALifeItemWeapon*>(definition))
        {
            weapon->m_fCondition = item.condition;
            for (const auto& upgrade : item.upgrades)
                weapon->m_upgrades.emplace_back(upgrade.c_str());
            weapon->m_addon_flags.assign(desired.addons);
            weapon->wpn_state = CWeapon::eHidden;
            weapon->a_elapsed = 0;
            weapon->ammo_type = 0;
            weapon->a_elapsed_grenades = {};
            target.weaponId = spawnMirroredItem(server, *definition);
            target.spawnedWeapon = desired;
        }
        F_entity_Destroy(definition);
        return;
    }
    auto* weapon = smart_cast<CWeapon*>(level.Objects.net_Find(target.weaponId));
    if (!weapon || weapon->H_Parent() != &actor || weapon->getDestroy())
        return;
    const auto publishRules = [&] {
        if (!target.weaponRulesPending)
            return;
        if (auto* magazined = smart_cast<CWeaponMagazined*>(weapon))
            target.weaponRulesPending = !interests.publishWeaponRules(desired, *magazined);
    };
    if (target.weaponRevision == item.revision)
    {
        publishRules();
        // Disposable native integration harness only: exercise the original
        // action/animation path without introducing a production command lane.
        if (Device.IsHeadlessAlifeHost() && strstr(Core.Params, "-zone-alife-probe") &&
            strstr(Core.Params, "-zone-native-reload-probe") &&
            target.reserveGeneration == desired.generation && weapon->GetState() == CWeapon::eIdle &&
            !weapon->IsPending())
        {
            static std::unordered_set<u16> started;
            if (started.insert(actor.ID()).second)
                Msg("* Zone native reload probe: actor=%u weapon=%u accepted=%d", actor.ID(), weapon->ID(),
                    weapon->Action(kWPN_RELOAD, CMD_START));
        }
        return;
    }
    if (!applyWeapon(*weapon, desired))
        return;
    if (inventory.ItemFromSlot(item.index) != weapon)
    {
        if (inventory.ItemFromSlot(item.index) || !inventory.Slot(item.index, weapon, true, true))
            return;
    }
    inventory.SetActiveSlot(item.index);
    weapon->SetState(CWeapon::eIdle);
    weapon->SetNextState(CWeapon::eIdle);
    target.weaponRevision = item.revision;
    publishRules();
    if (probe)
    {
        auto* launcher = smart_cast<CWeaponMagazinedWGrenade*>(weapon);
        const auto& magazine = launcher && launcher->m_bGrenadeMode ? launcher->m_magazine2 : weapon->m_magazine;
        const auto exact = std::equal(magazine.begin(), magazine.end(), item.cartridges.begin(), item.cartridges.end(),
            [](const CCartridge& round, const auto& section) { return round.m_ammoSect.c_str() == section; });
        const auto* selected = (launcher && launcher->m_bGrenadeMode ?
            launcher->m_ammoTypes2[launcher->m_ammoType2] : weapon->m_ammoTypes[weapon->GetAmmoType()]).c_str();
        const auto grenadeCount = launcher ? (launcher->m_bGrenadeMode ? weapon->m_magazine.size() : launcher->m_magazine2.size()) : 0;
        auto* magazineWeapon = smart_cast<CWeaponMagazined*>(weapon);
        Msg("* Zone player weapon %u %s revision=%u native=%u rounds=%zu selected=%s exact=%d jammed=%d launcher=%d grenades=%zu mode=%u",
            item.index, item.section.c_str(), item.revision, target.weaponId, magazine.size(), selected, exact,
            weapon->IsMisfire(), launcher && launcher->m_bGrenadeMode, grenadeCount,
            magazineWeapon ? magazineWeapon->NativeFireModeSelector() : 0);
    }
}

void AlifeHostTargets::stepMovement(CLevel& level, xrServer& server, AlifeHostInterests& interests)
{
    if (!interests.nativeMovement() || m_epoch != interests.epoch())
        return;
    for (const auto& snapshot : interests.armour())
    {
        auto it = m_targets.find(snapshot.id);
        if (it != m_targets.end() && it->second.life == snapshot.life)
        {
            it->second.armourGeneration = snapshot.generation;
            for (std::size_t i = 0; i < snapshot.items.size(); ++i)
                it->second.armour[i].desired = snapshot.items[i];
        }
    }
    for (const auto& snapshot : interests.weapons())
        if (const auto it = m_targets.find(snapshot.id); it != m_targets.end() && it->second.life == snapshot.life)
        {
            it->second.desiredWeapon = snapshot;
            it->second.weaponRulesPending = snapshot.fireConfig.has_value();
        }
    interests.clearPendingLoadouts();
    const bool publish = interests.wantsMovementFrame();
    const auto physicsStep = physics_world()->StepsNum();
    const bool fresh = interests.freshMovement();
    m_movementPoses.clear();
    for (const auto& player : interests)
    {
        const auto it = m_targets.find(player.id);
        if (it == m_targets.end() || it->second.life != player.life)
            continue;
        auto& target = it->second;
        auto* actor = smart_cast<CActor*>(level.Objects.net_Find(target.nativeId));
        if (!actor || !actor->zoneAlifeTarget() || actor->getDestroy())
            continue;

        reconcileArmour(level, server, *actor, target);
        reconcileWeapon(level, server, *actor, target, interests);
        if (!target.movementReady)
        {
            actor->resetZoneMovement(Fvector{player.x, player.y, player.z}, Fvector{0.f, 0.f, 0.f}, player.crouched);
            actor->UpdateAnimation();
            target.movementReady = true;
        }
        const bool stepped = target.physicsStep != physicsStep;
        if (stepped)
        {
            target.simulatedSequence = target.sequence;
            target.physicsStep = physicsStep;
        }
        Fvector position, velocity;
        const u32 flags = actor->sampleZoneMovement(position, velocity);
        actor->conditions().SetHealth(player.health);
        actor->conditions().SetPower(player.power);
        actor->updateZoneActorPose(position, player.yaw, player.pitch, Device.fTimeDelta);
        if (publish)
        {
            m_movementPoses.push_back({player.id, player.life, target.simulatedSequence, position, velocity,
                flags | (target.jumped ? 32u : 0u)});
            target.jumped = false;
        }

        const u32 controls = fresh ? player.controls : (flags & 4 ? 16u : 0u);
        const u32 previousState = actor->MovingState();
        target.jumped |= actor->driveZoneMovement(controls, player.yaw, player.speedScale, Device.fTimeDelta);
        if (stepped)
        {
            // Stock character physics measures falls and impacts against moving
            // objects. Rust still authorizes the hit and commits its outcome.
            auto* movement = actor->character_physics_support()->movement();
            const float impact = movement->gcontact_HealthLost;
            if (impact > 0.f && movement->CollisionDamageInfo()->HitType() == ALife::eHitTypeStrike)
            {
                const auto power = std::min(impact, 10.f);
                interests.queueHit(player.id, player.life, 1, power, 0.f, {}, previewArmour(level, *actor, target, 1, power));
            }
        }
        if (actor->MovingState() != previousState)
            actor->UpdateAnimation();
        if (publish && interests.wantsPlayerHitboxes(player.id))
        {
            writeHitboxes(*actor, position, m_hitboxPacket);
            interests.publishHitboxes(player.id, player.life, m_hitboxPacket);
        }
        if (fresh)
            target.sequence = player.sequence;
    }
    serviceWeapons(level, server, interests);
    serviceConditions(level, interests);
    if (publish) interests.publishMovement(m_movementPoses);
}

void AlifeHostTargets::serviceWeapons(CLevel& level, xrServer& server, AlifeHostInterests& interests)
{
    using namespace xray::zone_weapon_action;
    // Opt-in until the Rust durable commit/recovery coordinator is connected.
    if (!strstr(Core.Params, "-zone-native-weapon-actions") || !interests.nativeMovement() || m_epoch!=interests.epoch())
        return;
    const auto send = [&](Target& target) { interests.sendWeaponAction(target.weaponReplay.output); };
    while (auto request = interests.nextWeaponAction())
    {
        const auto found=m_targets.find(request->fence.player);
        if (found==m_targets.end() || found->second.life!=request->fence.life) continue;
        auto& target=found->second;
        auto& replay=target.weaponReplay;
        const auto decision=replay.check(*request);
        if (decision==Decision::Reject) continue;
        if (decision==Decision::Replay) { send(target); continue; }
        if (decision==Decision::AbortNew)
        {
            // Cancellation can overtake the initial datagram. Remember it so a
            // late Reload cannot start an action Rust already cancelled.
            replay.start(*request);replay.abort(result(request->fence,Phase::Aborted));
            send(target);continue;
        }
        auto* actor=smart_cast<CActor*>(level.Objects.net_Find(target.nativeId));
        auto* weapon=smart_cast<CWeapon*>(level.Objects.net_Find(target.weaponId));
        if (!actor || !actor->zoneAlifeTarget() || actor->getDestroy() || !weapon ||
            weapon->getDestroy() || weapon->H_Parent()!=actor) continue;
        if (decision==Decision::Start)
        {
            const auto& desired=target.desiredWeapon;
            static const char hex[]="0123456789abcdef";
            std::string id;id.reserve(32);
            for(auto byte:request->fence.item){id.push_back(hex[byte>>4]);id.push_back(hex[byte&15]);}
            if (desired.item.id!=id || desired.item.revision!=request->fence.revision ||
                target.weaponRevision!=request->fence.revision || desired.generation!=request->fence.generation ||
                target.armourGeneration!=desired.generation || target.reserveGeneration!=desired.generation ||
                !actor->g_Alive() || !armourReady(level,*actor,target) || weapon->GetState()!=CWeapon::eIdle ||
                weapon->GetNextState()!=CWeapon::eIdle || weapon->IsPending()) continue;
            replay.start(*request);
            target.weaponActionFrame=Device.dwFrame;
            if (weapon->Action(kWPN_RELOAD,CMD_START))
                replay.output=result(request->fence,Phase::Running);
            else
                replay.reject(result(request->fence,Phase::Rejected));
            send(target);
            continue;
        }
        // A commit must be accompanied by a newer durable inventory snapshot.
        // Otherwise releasing the freeze could resurrect pre-reload ammunition.
        if (decision==Decision::Commit && target.desiredWeapon.generation<=request->fence.generation) continue;
        if (u32(Device.dwFrame-target.weaponActionFrame)<2) continue;
        weapon->CancelZoneWeaponAction();
        // Discard the temporary native ammo graph (including stock-created boxes).
        // Reconciliation reconstructs it from the latest authoritative snapshot.
        if (auto* parent=findTarget(server,actor->ID()))
        {
            const auto children=parent->children;
            for(auto id:children)
                if(auto* entity=server.GetGameState()->get_entity_from_eid(id);
                    entity && entity->ID_Parent==actor->ID() && smart_cast<CSE_ALifeItemAmmo*>(entity))
                {
                    server.Perform_reject(entity,parent,2*NET_Latency);
                    server.Perform_destroy(entity,net_flags(TRUE,TRUE));
                }
        }
        target.reserve.clear();target.reserveGeneration.reset();target.weaponRevision.reset();
        if(decision==Decision::Commit) replay.commit(result(request->fence,Phase::Committed));
        else replay.abort(result(request->fence,Phase::Aborted));
        send(target);
    }
    for(auto& [id,target]:m_targets)
    {
        auto& replay=target.weaponReplay;
        if(replay.settled || replay.phase!=Phase::Running || !replay.fence ||
            u32(Device.dwFrame-target.weaponActionFrame)<2) continue;
        auto* actor=smart_cast<CActor*>(level.Objects.net_Find(target.nativeId));
        if(!actor || actor->getDestroy() || !actor->zoneAlifeTarget()) continue;
        // captureWeapon requires both current and queued states to be idle.
        // The two-frame delay also prevents completion on the initial queued event.
        if(auto state=captureWeapon(*actor,target))
        {
            auto bytes=result(*replay.fence,Phase::Complete,&*state);
            if(bytes.empty()) continue;
            replay.complete(std::move(bytes));send(target);
        }
    }
}

void AlifeHostTargets::serviceConditions(CLevel& level, AlifeHostInterests& interests)
{
    // This entry point intentionally does not advance actors, physics or weapons.
    // It can service accepted proposals while a host simulation gate is closed.
    if (!interests.nativeMovement() || m_epoch != interests.epoch())
        return;
    // Condition work is an explicit proposal, never a second autonomous tick.
    while (auto request = interests.nextCondition())
    {
        auto it = m_targets.find(request->player);
        if (it == m_targets.end() || it->second.life != request->life) continue;
        auto& target = it->second;
        if (!target.armourGeneration || *target.armourGeneration != request->equipment) continue;
        const auto decision = target.conditionReplay.check(*request);
        if (decision == xray::zone_condition::ReplayDecision::Reject) continue;
        if (decision == xray::zone_condition::ReplayDecision::Replay)
        {
            interests.sendCondition(target.conditionReplay.output);
            continue;
        }
        auto* actor = smart_cast<CActor*>(level.Objects.net_Find(target.nativeId));
        if (!actor || actor->getDestroy() || !actor->zoneAlifeTarget() ||
            !armourReady(level, *actor, target)) continue;
        auto& condition = actor->conditions();
        auto current = condition.CaptureZoneCondition();
        if (!xray::zone_condition::valid(current)) continue;
        if (request->state && !condition.RestoreZoneCondition(*request->state)) continue;
        if (request->imported && !condition.ImportZoneCondition(*request->imported))
        {
            R_ASSERT(condition.RestoreZoneCondition(current));
            continue;
        }
        if (!request->consumable.empty() && !condition.ConsumeZoneCondition(request->consumable.c_str()))
        {
            R_ASSERT(condition.RestoreZoneCondition(current));
            continue;
        }
        if (request->seconds > 0.f)
            xray::zone_condition::advanceBatch(request->seconds, [&](float seconds) {
                if (condition.GetHealth()<=0.f) return false;
                condition.AdvanceZoneCondition(seconds, request->weight);
                return condition.GetHealth()>0.f;
            });
        xray::zone_condition::Wear wear;
        if (request->hit && !condition.HitZoneCondition(*request->hit, wear))
        {
            R_ASSERT(condition.RestoreZoneCondition(current));
            continue;
        }
        if (!request->hits.empty() && !condition.HitZoneBatch(request->hits.data(), request->hits.size(), wear))
        {
            R_ASSERT(condition.RestoreZoneCondition(current));
            continue;
        }
        auto result = xray::zone_condition::reply(*request, condition.CaptureZoneCondition(),
            request->hit || !request->hits.empty() ? &wear : nullptr);
        // Rust must commit the result before it becomes the next input state.
        R_ASSERT(condition.RestoreZoneCondition(current));
        if (result.empty()) continue;
        target.conditionReplay.complete(*request, std::move(result));
        interests.sendCondition(target.conditionReplay.output);
    }
}

void AlifeHostTargets::reportHit(std::uint16_t nativeId, const SHit& hit, AlifeHostInterests& interests) const
{
    // Native condition owners also receive the engine's actual zone/physics
    // hits. Legacy actors still use Rust's authored-field approximation.
    if (m_epoch != interests.epoch())
        return;
    const auto target = std::find_if(m_targets.begin(), m_targets.end(),
        [nativeId](const auto& entry) { return entry.second.nativeId == nativeId; });
    if (target == m_targets.end() ||
        (!target->second.nativeCondition && !smart_cast<CCustomMonster*>(hit.who)))
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
    std::string_view bone;
    if (kind == 0 || kind == 2 || kind == 3)
        if (const auto* object = Level().Objects.net_Find(nativeId))
            if (auto* skeleton = smart_cast<IKinematics*>(object->Visual()); skeleton && hit.boneID < skeleton->LL_BoneCount())
                bone = skeleton->LL_BoneName_dbg(hit.boneID);
    if (bone.size() >= 32)
        bone = {};
    auto& level = Level();
    auto* actor = smart_cast<CActor*>(level.Objects.net_Find(nativeId));
    const auto armour = actor ? previewArmour(level, *actor, target->second, kind, hit.power,
        bone.empty() ? BI_NONE : hit.boneID, kind == 2 ? hit.armor_piercing : 0.f) : std::nullopt;
    interests.queueHit(target->first, target->second.life, kind, hit.power,
        kind == 2 ? hit.armor_piercing : 0.f, bone, armour);
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
    const auto locateBone = [&](const collide::rq_result& hit, const Fvector& start, const Fvector& rayDirection) {
        bone = static_cast<u16>(hit.element);
        Fvector contact;
        contact.mad(start, rayDirection, hit.range);
        Fmatrix transform, inverse;
        transform.mul_43(npc->XFORM(), skeleton->LL_GetTransform(bone));
        inverse.invert(transform);
        inverse.transform_tiny(bonePosition, contact);
    };
    if (attack.ray)
    {
        const auto& ray = *attack.ray;
        Fvector rayDirection = ray.direction;
        rayDirection.normalize();
        collide::rq_results results;
        const auto include = [](const collide::ray_defs&, IGameObject* object, void* excluded) {
            auto* body = smart_cast<CEntity*>(object);
            return object != excluded && (!body || body->in_solid_state());
        };
        const collide::ray_defs query(ray.origin, rayDirection, ray.range, CDB::OPT_ONLYNEAREST | CDB::OPT_CULL,
            collide::rqtBoth);
        const bool intersected = level.ObjectSpace.RayQuery(results, query, nullptr, level.CurrentEntity(), include, shooter);
        const bool hit = intersected && results.r_begin()->O == npc && results.r_begin()->element >= 0 &&
            results.r_begin()->element < skeleton->LL_BoneCount();
        if (strstr(Core.Params, "-zone-alife-ray-probe"))
            Msg("* Zone bullet contact: target=%u accepted=%d bone=%d",
                attack.target, hit, hit ? results.r_begin()->element : -1);
        if (!hit)
            return std::nullopt;
        locateBone(*results.r_begin(), ray.origin, rayDirection);
    }
    else if (auto* form = npc->GetCForm())
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
            locateBone(*result.r_begin(), start, direction);
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
