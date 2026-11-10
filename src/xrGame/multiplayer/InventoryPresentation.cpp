#include "pch_script.h"
#include "InventoryPresentation.h"
#include "EngineAdapter.h"
#include "Level.h"
#include "Actor.h"
#include "ActorCondition.h"
#include "Artefact.h"
#include "CustomDetector.h"
#include "Inventory.h"
#include "inventory_item.h"
#include "eatable_item.h"
#include "Weapon.h"
#include "WeaponMagazined.h"
#include "WeaponMagazinedWGrenade.h"
#include "WeaponPistol.h"
#include "WeaponRevolver.h"
#include "weaponBM16.h"
#include "game_cl_base.h"
#include "HUDManager.h"
#include "player_hud.h"
#include "UIGameCustom.h"
#include "ui/UIActorMenu.h"
#include "ui/UIMainIngameWnd.h"
#include "ui/ArtefactDetectorUI.h"
#include "xrServer_Objects_ALife_Monsters.h"
#include "xrServer_Objects_ALife_Items.h"
#include "clsid_game.h"
#include "xrPhysics/IPHWorld.h"
#include "xrNetServer/NET_Messages.h"
#include <emscripten.h>

#include "InventoryIntent.h"
EM_JS(int, zone_engine_weapon_slot, (unsigned life), {
    return globalThis.zoneEngineWeaponSlot?.(life >>> 0) ?? 0;
});
EM_JS(int, zone_engine_pending_weapon_slot, (unsigned life), {
    return globalThis.zoneEnginePendingWeaponSlot?.(life >>> 0) ?? -1;
});
EM_JS(void, zone_engine_select_weapon, (unsigned life, unsigned slot), {
    globalThis.zoneEngineSelectWeapon?.(life >>> 0, slot);
});
EM_JS(int, zone_engine_vitals, (unsigned life, void* values), {
    return globalThis.zoneEngineVitals?.(life>>>0, values) ? 1 : 0;
});
EM_JS(int, zone_engine_weapon_misfire, (unsigned life), {
    return globalThis.zoneEngineWeaponMisfire?.(life>>>0) ? 1 : 0;
});
EM_JS(int, zone_engine_weapon_fire, (unsigned life, const char* item, unsigned* ammo), {
    const cue = globalThis.zoneEngineConsumeWeaponFire?.();
    if (!cue || !Number(item) || cue.life !== (life >>> 0) || cue.item !== UTF8ToString(Number(item)))
        return 0;
    if (cue.type === 'knife_swing')
        return cue.stab ? 4 : 3;
    if (cue.type === 'grenade_hud')
        return {prime:5,quick:6,release:7,cancel:8}[cue.phase] ?? 0;
    HEAPU32[Number(ammo) / 4] = cue.ammo;
    return cue.launcher ? 2 : 1;
});
EM_JS(int, zone_engine_weapon_reload, (unsigned life, const char* item, char* alias, unsigned capacity, unsigned* sound), {
    const cue = globalThis.zoneEngineConsumeWeaponReload?.();
    if (!cue || !Number(item) || cue.life !== (life >>> 0) || cue.item !== UTF8ToString(Number(item)))
        return -1;
    if (cue.cancelled)
        return -2;
    stringToUTF8(cue.alias, Number(alias), capacity);
    HEAPU32[Number(sound) / 4] = cue.sound;
    return cue.milliseconds;
});

namespace zone {
namespace {
InventoryPresentation* current = nullptr;
class PresentationGame final : public game_cl_GameState {
public:
    // Select original CoP item/UI rules, but do not create a native server,
    // ALife simulator, game_cl_Single or its server-dependent time setters.
    PresentationGame() {m_type = eGameIDSingle;}
    void shedule_Update(::u32) override {}
    CUIGameCustom* createGameUI() override {
        auto* ui = xr_new<CUIGameCustom>(); ui->Load(); ui->SetClGame(this); return ui;
    }
};
void prepare(CSE_Abstract* entity, unsigned short id, const Fvector& position) {
    entity->ID = id; entity->ID_Parent = 0xffff; entity->ID_Phantom = 0xffff;
    entity->o_Position = position; entity->o_Angle.set(0,0,0);
    entity->set_name_replace(""); entity->s_flags.assign(M_SPAWN_OBJECT_LOCAL);
}
unsigned char ammoIndex(const xr_vector<shared_str>& types, const std::string& section) {
    const auto type = std::find_if(types.begin(), types.end(), [&](const auto& name) {return section == name.c_str();});
    return type == types.end() ? 0 : static_cast<unsigned char>(type - types.begin());
}
u8 addonFlag(pcstr section) {
    switch (pSettings->r_clsid(section, "class")) {
    case CLSID_OBJECT_W_SCOPE:
    case xray::make_clsid("WP_SCOPE"):
        return CSE_ALifeItemWeapon::eWeaponAddonScope;
    case CLSID_OBJECT_W_SILENCER:
    case xray::make_clsid("WP_SILEN"):
        return CSE_ALifeItemWeapon::eWeaponAddonSilencer;
    case CLSID_OBJECT_W_GLAUNCHER:
    case xray::make_clsid("WP_GLAUN"):
        return CSE_ALifeItemWeapon::eWeaponAddonGrenadeLauncher;
    default:
        return 0;
    }
}
}
InventoryPresentation::InventoryPresentation(CLevel& value) : level(value) {VERIFY(!current);current=this;}
InventoryPresentation::~InventoryPresentation() {
    if (g_player_hud) g_player_hud->set_detached_hands_visible(false);
    stopReloadSounds();
    detachDetectorHud();
    detachWeaponHud();
    if (CurrentGameUI()) CurrentGameUI()->HideActorMenu();
    if (actor) HUD().OnDisconnected();
    updateStorageBox(nullptr);
    if(CurrentGameUI())CurrentGameUI()->UIMainIngameWnd->SetPickUpItem(nullptr);
    for (auto& entry : corpseLoot) remove(entry.second.object);
    for (auto& entry : looseItems) remove(entry.second.object);
    looseItems.clear();
    for (auto& entry : items) remove(entry.second.object);
    items.clear();
    if (actor) {
        level.SetEntity(nullptr);actor->setDestroy(TRUE);
        // Restore the registration solely for the original net_Destroy contract;
        // no scheduler update can run between these synchronous calls.
        Engine.Sheduler.Register(actor,TRUE);actor->net_Destroy();level.Objects.Destroy(actor);actor=nullptr;
    }
    current=nullptr;
}
void InventoryPresentation::start(const Fvector& position) {
    VERIFY(!level.game);level.game=xr_new<PresentationGame>();
    if (!physics_world()) create_physics_world(false,&level.ObjectSpace,&level.Objects);
    CSE_Abstract* definition=F_entity_Create("actor");R_ASSERT(definition);
    prepare(definition,1,position);definition->s_flags.set(M_SPAWN_OBJECT_ASPLAYER,TRUE);
    // Spawn_Read normally resolves this before CInventoryOwner::net_Spawn.
    // Fresh presentation definitions must also initialize faction/rank/name.
    auto* trader=smart_cast<CSE_ALifeTraderAbstract*>(definition);R_ASSERT(trader);
    trader->specific_character();
    Msg("* Zone inventory: actor definition initialized");
    auto* object=level.Objects.Create("actor");actor=smart_cast<CActor*>(object);
    Msg("* Zone inventory: actor resources loaded");
    R_ASSERT(actor && actor->net_Spawn(definition));F_entity_Destroy(definition);
    // Story profiles may supply random money; multiplayer currency is not
    // implemented and must not be invented by this presentation object.
    actor->set_money(0,false);
    Msg("* Zone inventory: actor spawned");
    // The Rust motor and snapshots own position/health. Do not register a local
    // AI/condition/physics tick or use CLevel::OnFrame for these objects.
    Engine.Sheduler.Unregister(actor);actor->setVisible(FALSE);actor->setEnabled(FALSE);
    level.SetEntity(actor);
    HUD().Load();
    HUD().OnConnected();
    CurrentGameUI()->OnConnected();
    Msg("* Zone inventory: native presentation actor ready, local simulation disabled");
}
void InventoryPresentation::remove(CInventoryItem* item) {
    if (presentedWeapon && &presentedWeapon->item() == item)
        detachWeaponHud();
    if (presentedDetector && &presentedDetector->CHudItem::item() == item)
        detachDetectorHud();
    CGameObject& object=item->object();
    if (item->m_pInventory) actor->inventory().DropItem(&object,true,true);
    if (object.H_Parent()) object.H_SetParent(nullptr,true);
    destroy(object);
}
void InventoryPresentation::destroy(CGameObject& object) {
    object.setDestroy(TRUE);
    if(object.register_schedule())Engine.Sheduler.Register(&object);
    object.net_Destroy();level.Objects.Destroy(&object);
}
CInventoryItem* InventoryPresentation::spawn(const InventoryItemState& state, unsigned short id, const Fvector& position, bool carried) {
    CSE_Abstract* definition=F_entity_Create(state.section.c_str());R_ASSERT(definition);
    prepare(definition,id,position);
    auto* inventoryItem=smart_cast<CSE_ALifeInventoryItem*>(definition);R_ASSERT(inventoryItem);
    inventoryItem->m_fCondition=state.condition;
    auto* object=smart_cast<CGameObject*>(level.Objects.Create(state.section.c_str()));
    auto* item=smart_cast<CInventoryItem*>(object);R_ASSERT(item);
    const bool probe = strstr(Core.Params, "-zone-weapon-hud-probe");
    // This level has no A-Life upgrade manager. Apply the saved native effects
    // after Load and before the weapon's net_Spawn reads its ammo indices.
    for (const auto& upgrade : state.upgrades) {
        if (!pSettings->line_exist(upgrade.c_str(), "section")) continue;
        const auto* effect = pSettings->r_string(upgrade.c_str(), "section");
        item->install_upgrade(effect);
        item->add_upgrade(upgrade.c_str(), true);
        if (probe)
            Msg("* Zone native upgrade: %s %s %s", state.section.c_str(), upgrade.c_str(), effect);
    }
    auto* nativeWeapon = item->cast_weapon();
    pcstr scopeSection = nullptr;
    if (auto* ammo=smart_cast<CSE_ALifeItemAmmo*>(definition)) ammo->a_elapsed=static_cast<u16>(state.quantity);
    if (auto* weapon=smart_cast<CSE_ALifeItemWeapon*>(definition)) {
        R_ASSERT(nativeWeapon);
        weapon->a_elapsed=static_cast<u16>(state.cartridges.size());
        weapon->ammo_type=ammoIndex(nativeWeapon->m_ammoTypes,state.selectedAmmunition);
        weapon->a_elapsed_grenades.grenades_count=static_cast<u8>(state.launcherCartridges.size());
        if (!state.launcherCartridges.empty())
            if (auto* launcher=smart_cast<CWeaponMagazinedWGrenade*>(nativeWeapon))
                weapon->a_elapsed_grenades.grenades_type=ammoIndex(launcher->m_ammoTypes2,state.launcherCartridges.front());
        for (const auto& addon : state.attachments) {
            const auto flag = addonFlag(addon.c_str());
            if (flag)
                weapon->m_addon_flags.set(flag, TRUE);
            if (flag == CSE_ALifeItemWeapon::eWeaponAddonScope)
                scopeSection = addon.c_str();
        }
    }
    R_ASSERT(object->net_Spawn(definition));F_entity_Destroy(definition);
    if(object->register_schedule())Engine.Sheduler.Unregister(object);
    if (nativeWeapon) {
        nativeWeapon->SetPresentationMisfire(state.jammed);
        // The ordinary spawn path fills the magazine with the selected
        // cartridge. Restore its actual order before any launcher mode swap.
        auto& magazine = nativeWeapon->m_magazine;
        R_ASSERT(magazine.size() == state.cartridges.size());
        for (size_t i = 0; i < magazine.size(); ++i) {
            const auto& section = state.cartridges[i];
            if (section != magazine[i].m_ammoSect.c_str()) {
                const auto index = ammoIndex(nativeWeapon->m_ammoTypes, section);
                magazine[i].Load(nativeWeapon->m_ammoTypes[index].c_str(), index);
            }
        }
        if (!magazine.empty()) nativeWeapon->m_fCurrentCartirdgeDisp = magazine.back().param_s.kDisp;
        if (probe && (!state.upgrades.empty() || !magazine.empty())) {
            const auto first = magazine.empty() ? "-" : magazine.front().m_ammoSect.c_str();
            const auto last = magazine.empty() ? "-" : magazine.back().m_ammoSect.c_str();
            const auto exact = std::equal(magazine.begin(), magazine.end(), state.cartridges.begin(),
                [](const auto& round, const auto& section) {return section == round.m_ammoSect.c_str();});
            Msg("* Zone native magazine: %s condition=%.4f capacity=%d rounds=%d selected=%s first=%s last=%s exact=%d",
                state.section.c_str(), item->GetCondition(), nativeWeapon->GetAmmoMagSize(), nativeWeapon->GetAmmoElapsed(),
                nativeWeapon->m_ammoTypes[nativeWeapon->GetAmmoType()].c_str(), first, last, exact);
        }
    }
    if (auto* weapon=smart_cast<CWeaponMagazined*>(item)) {
        weapon->SetPresentationFireMode(state.fireMode);
        if (scopeSection)
            weapon->SetPresentationScope(scopeSection);
    }
    if (auto* weapon=smart_cast<CWeaponMagazinedWGrenade*>(item))
        weapon->SetPresentationLauncherMode(state.launcherMode);
    if (auto* food=smart_cast<CEatableItem*>(item)) food->SetRemainingUses(static_cast<u8>(state.quantity));
    if(carried) {
        item->m_ItemCurrPlace.type=eItemPlaceRuck;
        object->H_SetParent(actor);actor->inventory().Take(object,true,true);
    } else {
        object->setEnabled(FALSE);object->setVisible(TRUE);
        object->Position().set(position);object->spatial_move();
    }
    return item;
}
void InventoryPresentation::update(const Fvector& position,float health) {
    const auto& view=inventory();
    if (!view.valid) {cancelDeferredWeaponAction();hasVitals=false;if (CurrentGameUI()) CurrentGameUI()->HideActorMenu();return;}
    if (!actor) start(position);
    if (corpseMenuShown && !menuOpen()) dismissCorpse();
    if (!view.alive && !requestedContainer.empty()) dismissCorpse();
    const bool misfire = zone_engine_weapon_misfire(view.life);
    if (view.alive && misfire) CurrentGameUI()->AddCustomStatic("gun_jammed", true);
    actor->Position().set(position);actor->conditions().SetHealth(view.alive?health:0.f);
    const bool hadVitals = hasVitals;
    const auto previousVitals = currentVitals;
    hasVitals = view.alive && zone_engine_vitals(view.life, &currentVitals);
    if (hasVitals) actor->conditions().SetPower(currentVitals.power);
    if (hasVitals && (!hadVitals || currentVitals.carriedWeight != previousVitals.carriedWeight ||
        currentVitals.carryLimit != previousVitals.carryLimit) && menuOpen())
        CurrentGameUI()->GetActorMenu().UpdateActor();
    if (!applied || updates!=view.updates) {
        const bool shown = menuOpen();
        const bool showingCorpse = corpseMenuShown;
        if (shown) CurrentGameUI()->HideActorMenu();
        corpseMenuShown = false;
        const auto* previousWeapon = hudFirearm();
        const bool wasAiming = previousWeapon && previousWeapon->IsZoomed();
        const float aimRotation = previousWeapon ? previousWeapon->PresentationAimRotation() : 0.f;
        std::map<std::string,const InventoryItemState*> wanted;
        for(const auto& item:view.items) wanted.emplace(item.id,&item);
        for(auto i=items.begin();i!=items.end();) {
            const auto found=wanted.find(i->first);
            if(found==wanted.end() || found->second->revision!=i->second.revision) {remove(i->second.object);i=items.erase(i);} else ++i;
        }
        for(const auto& state:view.items) if(!items.count(state.id)) {
            const auto id=allocateId();
            items.emplace(state.id,Item{spawn(state,id,actor->Position()),state.revision,id});
        }
        // An ammunition or condition update rebuilds the native HUD item.
        // Preserve the raise across a new revision of the same owned weapon.
        if (!presentedWeapon && (wasAiming || aimRotation > 0.f)) {
            if (auto* weapon = hudFirearm()) {
                weapon->SetPresentationAim(wasAiming);
                weapon->SetPresentationAimRotation(aimRotation);
                if (strstr(Core.Params, "-zone-weapon-hud-probe"))
                    Msg("* Zone weapon HUD aim restored: %s %.3f", weapon->cNameSect().c_str(), aimRotation);
            }
        }
        // Clear placements first so an atomic server swap cannot encounter a
        // temporarily occupied native slot. Outfit precedes helmet and belt.
        const auto* detectorInSlot = actor->inventory().ItemFromSlot(DETECTOR_SLOT);
        const bool keepDetector = detectorInSlot && std::any_of(view.items.begin(), view.items.end(), [&](const auto& state) {
            return state.placement == 1 && state.index == DETECTOR_SLOT && items.at(state.id).object == detectorInSlot;
        });
        for(auto& entry:items) if(!(keepDetector && entry.second.object == detectorInSlot) && !actor->inventory().InRuck(entry.second.object))
            actor->inventory().Ruck(entry.second.object,true);
        for(unsigned pass=0;pass<3;++pass) for(const auto& state:view.items) {
            auto* item=items.at(state.id).object;
            if(state.placement==1 && !(keepDetector && item == detectorInSlot)
                && ((pass==0 && state.index==7)||(pass==1 && state.index!=7)))
                R_ASSERT(actor->inventory().Slot(state.index,item,true,true));
            if(pass==2 && state.placement==2) R_ASSERT(actor->inventory().Belt(item,true));
        }
        const auto& inv=actor->inventory();
        std::size_t placed=inv.m_ruck.size()+inv.m_belt.size();
        for(u16 slot=inv.FirstSlot();slot<=inv.LastSlot();++slot) if(inv.ItemFromSlot(slot))++placed;
        R_ASSERT2(placed==items.size() && inv.m_all.size()==items.size(),"Native inventory placement duplicated or lost an item");
        updates=view.updates;applied=true;
        if(shown && view.alive && !showingCorpse) CurrentGameUI()->ShowActorMenu();
        Msg("* Zone inventory: native items reconciled: %u",static_cast<unsigned>(items.size()));
    }
    if (deferredWeaponAction) {
        if (deferredWeaponAction->life != view.life || !view.alive || health <= 0.f || menuOpen()) {
            cancelDeferredWeaponAction();
        } else if (zone_engine_pending_weapon_slot(view.life) < 0) {
            const auto request = std::move(*deferredWeaponAction);
            cancelDeferredWeaponAction();
            if (const auto* weapon = equippedWeapon(); weapon && weapon->id == request.item)
                equippedWeaponAction(request.action, request.index);
        }
    }
}

unsigned short InventoryPresentation::allocateId() {
    R_ASSERT2(items.size()+looseItems.size()+corpseLoot.size()<65532,"Native inventory object ID space exhausted");
    while(level.Objects.net_Find(nextId)) {if(++nextId==0xffff)nextId=2;}
    const auto id=nextId++;if(nextId==0xffff)nextId=2;return id;
}
void InventoryPresentation::updateStorageBox(const WorldStorageLocation* storage) {
    if (!storage) {
        if (storageBox) {
            destroy(*storageBox);
            storageBox = nullptr;
        }
        return;
    }
    if (storageBox) return;
    auto* definition = F_entity_Create("inventory_box");
    R_ASSERT(definition);
    const auto& p = storage->position;
    const auto& rotation = storage->rotation;
    prepare(definition, allocateId(), Fvector().set(p[0], p[1], p[2]));
    definition->o_Angle.set(rotation[0], rotation[1], rotation[2]);
    storageBox = smart_cast<CGameObject*>(level.Objects.Create("inventory_box"));
    R_ASSERT(storageBox && storageBox->net_Spawn(definition));
    F_entity_Destroy(definition);
    if (storageBox->register_schedule()) Engine.Sheduler.Unregister(storageBox);
    storageBox->setVisible(TRUE);
    storageBox->setEnabled(FALSE);
    storageBox->spatial_move();
}

void InventoryPresentation::updateWorld(const std::function<Fvector(const std::array<float,3>&)>& project,bool firstPerson) {
    if(!actor)return;
    const auto& world=worldItems();const auto& carried=inventory();
    const bool valid=world.state.valid && carried.valid && carried.alive && world.state.life==carried.life;
    if((!valid && !looseItems.empty()) || (valid && (worldUpdates!=world.updates || worldInventoryUpdates!=carried.updates))) {
        CurrentGameUI()->UIMainIngameWnd->SetPickUpItem(nullptr);pickupId.clear();
        std::map<std::string,std::size_t> wanted;
        if(valid)for(std::size_t i=0;i<world.state.items.size();++i)
            if(!items.count(world.state.items[i].id))wanted.emplace(world.state.items[i].id,i);
        for(auto i=looseItems.begin();i!=looseItems.end();) {
            const auto found=wanted.find(i->first);
            if(found==wanted.end() || world.state.items[found->second].revision!=i->second.revision) {remove(i->second.object);i=looseItems.erase(i);}else ++i;
        }
        for(const auto& entry:wanted) {
            const auto& state=world.state.items[entry.second];const auto position=project(world.locations[entry.second].position);
            if(!looseItems.count(state.id)) {const auto id=allocateId();looseItems.emplace(state.id,Item{spawn(state,id,position,false),state.revision,id});}
            auto& object=looseItems.at(state.id).object->object();object.Position().set(position);object.spatial_move();
        }
        worldUpdates=world.updates;worldInventoryUpdates=carried.updates;
        Msg("* Zone world items: reconciled %u",static_cast<unsigned>(looseItems.size()));
    }
    const auto* storage = valid && world.storage ? &*world.storage : nullptr;
    updateStorageBox(storage);
    updateCorpseMenu();
    // Keep native model and effect transforms current while the server owns movement.
    for (const auto& entry : looseItems)
        if (auto* artefact = entry.second.object->object().cast_artefact())
            artefact->UpdateNetworkPresentation();
    pickupId.clear();
    targetedContainer.clear();
    targetingStorage = false;
    CInventoryItem* selected=nullptr;float best=1.f;
    if(valid && !menuOpen())for(const auto& entry:looseItems) {
        auto* item=entry.second.object;Fvector center;item->object().Center(center);
        if(!item->CanTake() || center.distance_to_sqr(actor->Position())>4.f)continue;
        Fvector delta;delta.sub(center,Device.vCameraPosition);
        const float along=delta.dotproduct(Device.vCameraDirection);if(along<=0.f)continue;
        Fvector projected;projected.mad(Device.vCameraPosition,Device.vCameraDirection,along);
        const float score=firstPerson?projected.distance_to_sqr(center):center.distance_to_sqr(actor->Position())/4.f;
        if(score>=best)continue;
        const float distance=delta.magnitude();if(distance>0.01f) {
            delta.div(distance);collide::rq_result hit;
            if(level.ObjectSpace.RayPick(Device.vCameraPosition,delta,distance-0.01f,collide::rqtStatic,hit,nullptr))continue;
        }
        best=score;selected=item;pickupId=entry.first;
    }
    if (valid && !menuOpen()) {
        auto considerContainer = [&](const std::string& id, const Fvector& feet, bool locker) {
            if (feet.distance_to_sqr(actor->Position()) > 4.f) return;
            auto center = feet;
            center.y += locker ? 0.55f : 0.25f;
            auto eye = Device.vCameraPosition;
            if (locker && !firstPerson) {
                eye = actor->Position();
                eye.y += 1.55f;
            }
            Fvector ray;
            ray.sub(center, eye);
            const float along = ray.dotproduct(Device.vCameraDirection);
            if ((firstPerson || !locker) && along <= 0.f) return;
            Fvector aim;
            aim.mad(Device.vCameraPosition, Device.vCameraDirection, along);
            const float score = firstPerson ? aim.distance_to_sqr(center) : feet.distance_to_sqr(actor->Position()) / 4.f;
            if (score >= best) return;
            const float distance = ray.magnitude();
            collide::rq_result hit;
            if (distance > 0.01f && level.ObjectSpace.RayPick(eye, ray.div(distance),
                    distance - 0.01f, collide::rqtStatic, hit, nullptr)) return;
            best = score;
            selected = nullptr;
            pickupId.clear();
            targetedContainer = id;
            targetingStorage = locker;
        };
        for (const auto& body : world.corpses)
            considerContainer(body.source, project(body.position), false);
        if (storageBox && storage)
            considerContainer(storage->source, storageBox->Position(), true);
    }
    CurrentGameUI()->UIMainIngameWnd->SetPickUpItem(selected);
}
const char* InventoryPresentation::containerUseTip() const {
    if (targetedContainer.empty()) return nullptr;
    return targetingStorage ? "inventory_box_use" : "dead_character_use";
}
bool InventoryPresentation::pickup() {
    if (!inventory().alive) return false;
    if (!targetedContainer.empty()) {
        requestedContainer = targetedContainer;
        zone_corpse_open(requestedContainer.c_str(), inventory().life);
        return true;
    }
    if (pickupId.empty()) return false;
    const auto& world=worldItems();
    for(std::size_t i=0;i<world.state.items.size();++i)if(world.state.items[i].id==pickupId) {
        const auto& state=world.state.items[i];
        zone_inventory_pickup(state.id.c_str(),world.locations[i].source.c_str(),state.revision,inventory().life);return true;
    }
    return false;
}
void InventoryPresentation::dismissCorpse() {
    requestedContainer.clear();
    corpseMenuShown = false;
    if (inventory().alive) zone_corpse_dismiss(inventory().life);
}
void InventoryPresentation::updateCorpseMenu() {
    const auto& search = corpseSearch();
    const auto& carried = inventory();
    const bool valid = search.open && carried.alive && search.state.life == carried.life &&
        search.state.corpse == requestedContainer;
    if (!valid) {
        if (corpseMenuShown) {
            CurrentGameUI()->HideActorMenu();
            dismissCorpse();
        }
        for (auto& entry : corpseLoot) remove(entry.second.object);
        corpseLoot.clear();
        return;
    }
    if (corpseMenuShown && corpseUpdates == search.updates) return;
    CurrentGameUI()->HideActorMenu();
    std::map<std::string, const InventoryItemState*> wanted;
    for (const auto& state : search.state.items)
        if (!items.count(state.id)) wanted.emplace(state.id, &state);
    for (auto it = corpseLoot.begin(); it != corpseLoot.end();) {
        const auto found = wanted.find(it->first);
        if (found == wanted.end() || found->second->revision != it->second.revision) {
            remove(it->second.object);
            it = corpseLoot.erase(it);
        } else ++it;
    }
    for (const auto& entry : wanted) {
        if (corpseLoot.count(entry.first)) continue;
        const auto id = allocateId();
        auto* item = spawn(*entry.second, id, actor->Position(), false);
        item->object().setVisible(FALSE);
        corpseLoot.emplace(entry.first, Item{item, entry.second->revision, id});
    }
    CurrentGameUI()->HidePdaMenu();
    auto& menu = CurrentGameUI()->GetActorMenu();
    menu.SetActor(actor);
    menu.SetMenuMode(mmDeadBodySearch);
    menu.ShowDialog(true);
    corpseUpdates = search.updates;
    corpseMenuShown = true;
}
void InventoryPresentation::corpseItems(std::vector<CInventoryItem*>& out) const {
    for (const auto& entry : corpseLoot) out.push_back(entry.second.object);
}
bool InventoryPresentation::takeCorpseItem(const CInventoryItem* item) {
    const auto& search = corpseSearch();
    if (!corpseMenuShown || !search.open || search.updates != corpseUpdates ||
        search.state.corpse != requestedContainer || search.state.life != inventory().life) return false;
    std::string ids;
    for (const auto& entry : corpseLoot) {
        if (item && item != entry.second.object) continue;
        if (!ids.empty()) ids += ',';
        ids += entry.first;
    }
    if (ids.empty()) return false;
    zone_corpse_take(requestedContainer.c_str(), search.state.life, static_cast<double>(search.state.generation), ids.c_str());
    return true;
}
bool InventoryPresentation::storeItem(const CInventoryItem* item) {
    const auto& search = corpseSearch();
    const auto& storage = worldItems().storage;
    const auto& carried = inventory();
    if (!storage || storage->source != requestedContainer || !corpseMenuShown ||
        !search.open || search.updates != corpseUpdates || search.state.corpse != requestedContainer ||
        !carried.alive || search.state.life != carried.life) return false;

    if (!item) zone_inventory_batch_begin();
    bool stored = false;
    for (const auto& state : carried.items) {
        const auto found = items.find(state.id);
        if (found == items.end() || (item ? found->second.object != item : state.placement != 0) ||
            found->second.object->IsQuestItem()) continue;
        zone_inventory_store(state.id.c_str(), storage->source.c_str(), state.revision, carried.life);
        stored = true;
        if (item) break;
    }
    if (!item) zone_inventory_batch_end();
    return stored;
}

bool InventoryPresentation::toggle() {
    if(!actor||!inventory().valid||!inventory().alive)return false;
    cancelDeferredWeaponAction();
    if (!requestedContainer.empty()) dismissCorpse();
    return CurrentGameUI()->ShowActorMenu();
}
bool InventoryPresentation::menuOpen() const {return actor && CurrentGameUI() && CurrentGameUI()->GetActorMenu().IsShown();}
void InventoryPresentation::selectWeaponSlot(unsigned slot) {
    if (!inventory().valid || !inventory().alive) return;
    cancelDeferredWeaponAction();
    zone_engine_select_weapon(inventory().life, slot);
}
const InventoryItemState* InventoryPresentation::equippedWeapon() const {
    const auto* item = equippedHudItem();
    return item && item->kind == 3 ? item : nullptr;
}
const InventoryItemState* InventoryPresentation::equippedThrowable() const {
    const auto* item = equippedHudItem();
    return item && (item->index == 4 || item->index == 6) ? item : nullptr;
}
const InventoryItemState* InventoryPresentation::equippedKnife() const {
    const auto* item = equippedHudItem();
    return item && item->index == 1 ? item : nullptr;
}
const InventoryItemState* InventoryPresentation::equippedHudItem() const {
    return hudItemInSlot(zone_engine_weapon_slot(inventory().life));
}
const InventoryItemState* InventoryPresentation::hudItemInSlot(int slot) const {
    const auto& view = inventory();
    if (!view.valid || !view.alive) return nullptr;
    if (slot < 1 || slot > 6 || slot == 5) return nullptr;
    const auto kind = slot == 2 || slot == 3 ? 3 : 0;
    for (const auto& item : view.items)
        if (item.placement == 1 && item.index == static_cast<unsigned>(slot) && item.kind == kind)
            return &item;
    return nullptr;
}
CInventoryItem* InventoryPresentation::hudWeapon(const CInventoryOwner* owner) const {
    if (!actor || static_cast<const CInventoryOwner*>(actor) != owner) return nullptr;
    const auto* selected = equippedHudItem();
    if (!selected) return nullptr;
    const auto item = items.find(selected->id);
    return item == items.end() ? nullptr : item->second.object;
}
CWeapon* InventoryPresentation::hudFirearm() const {
    if (presentedWeapon)
        return smart_cast<CWeapon*>(presentedWeapon);
    if (presentedWeaponId.empty())
        return nullptr;
    const auto item = items.find(presentedWeaponId);
    return item == items.end() ? nullptr : smart_cast<CWeapon*>(item->second.object);
}
void InventoryPresentation::setWeaponAim(bool aiming) {
    if (auto* weapon = hudFirearm(); weapon && weapon->IsZoomed() != aiming) {
        weapon->SetPresentationAim(aiming);
        weaponAimIdleDirty = true;
    }
    if (actor)
        actor->SetZoomAimingMode(aiming);
}
void InventoryPresentation::detachWeaponHud() {
    if (!presentedWeapon)
        return;
    if (auto* weapon = smart_cast<CWeapon*>(presentedWeapon))
        weapon->ClearPresentationAim();
    g_player_hud->detach_item(presentedWeapon);
    if (actor)
        actor->SetZoomAimingMode(false);
    presentedWeapon = nullptr;
    weaponAimIdleDirty = false;
}
void InventoryPresentation::detachDetectorHud() {
    if (presentedDetector) {
        g_player_hud->detach_item(presentedDetector);
        presentedDetector->ClearNetworkHud();
        presentedDetector = nullptr;
    }
    detectorMotionEnd.reset();
    detectorStowing = false;
    detectorBeepTime = 0.f;
    detectorSound.StopAllSounds();
}
void InventoryPresentation::updateDetectorHud(const Fmatrix& camera, bool firstPerson,
                                               CHudItem* primary, const DetectorHint* hint) {
    auto* carriedDetector = smart_cast<CCustomDetector*>(actor->inventory().ItemFromSlot(DETECTOR_SLOT));
    if (presentedDetector && (!firstPerson || !inventory().alive || carriedDetector != presentedDetector))
        detachDetectorHud();

    constexpr const char* sections[] = {"detector_simple", "detector_advanced", "detector_elite", "detector_scientific"};
    const auto tier = hint ? static_cast<unsigned>(hint->tier) : 0;
    const bool selected = firstPerson && inventory().alive && hint && tier >= 1 && tier <= std::size(sections)
        && carriedDetector && carriedDetector->cNameSect() == sections[tier - 1];
    const bool interlocked = selected && (!hint->working || !carriedDetector->NetworkHudCompatible(primary));
    if (!selected || interlocked)
        detectorResumeFast = interlocked;
    const bool draw = selected && !interlocked;
    if (draw && (!presentedDetector || detectorStowing)) {
        presentedDetector = carriedDetector;
        presentedDetector->PrepareNetworkHud();
        g_player_hud->attach_item(presentedDetector);
        detectorStowing = false;
        const auto duration = presentedDetector->PlayNetworkHudMotion(true, detectorResumeFast);
        detectorResumeFast = false;
        detectorMotionEnd = Device.dwTimeGlobal + duration;
        if (strstr(Core.Params, "-zone-detector-probe"))
            Msg("* Zone detector draw: %s %u ms", sections[tier - 1], duration);
    } else if (!draw && presentedDetector && !detectorStowing) {
        detectorStowing = true;
        detectorBeepTime = 0.f;
        detectorSound.StopAllSounds();
        const auto duration = presentedDetector->PlayNetworkHudMotion(false, interlocked);
        detectorMotionEnd = Device.dwTimeGlobal + duration;
        if (strstr(Core.Params, "-zone-detector-probe"))
            Msg("* Zone detector stow: %s %u ms", presentedDetector->cNameSect().c_str(), duration);
    }
    if (detectorMotionEnd && static_cast<std::int32_t>(Device.dwTimeGlobal - *detectorMotionEnd) >= 0) {
        detectorMotionEnd.reset();
        if (detectorStowing)
            detachDetectorHud();
        else if (const auto idle = presentedDetector->WhichHUDAnimationExist("anm_idle", "anim_idle", true))
            presentedDetector->PlayHUDMotion_noCB(idle, TRUE);
    }
    if (primary || presentedDetector)
        g_player_hud->update(camera);
    if (!draw || !presentedDetector)
        return;

    auto* ui = presentedDetector->NetworkHudUI();
    if (tier == 2) {
        const auto direction = hint->period > 0.f ? Fvector().set(std::sin(hint->bearing), 0.f, std::cos(hint->bearing))
                                                  : Fvector().set(0.f, 0.f, 0.f);
        static_cast<CUIArtefactDetectorAdv*>(ui)->SetValue(0.f, direction);
    } else if (tier >= 3) {
        auto* radar = static_cast<CUIArtefactDetectorElite*>(ui);
        radar->Clear();
        for (unsigned i = 0; i < static_cast<unsigned>(hint->count); ++i) {
            const auto& point = hint->points[i];
            radar->RegisterItemToDraw(Fvector().set(point[0], point[1], point[2]),
                tier == 4 ? hint->labels[i].data() : "af_sign");
        }
    }
    ui->update();
    if (tier > 2 || hint->period <= 0.f) {
        detectorBeepTime = 0.f;
        return;
    }
    detectorBeepTime += Device.fTimeDelta;
    if (detectorBeepTime < hint->period)
        return;
    detectorBeepTime = 0.f;
    auto* beep = detectorSound.FindSoundItem("beep", false);
    if (!beep) {
        detectorSound.LoadSound("detector_simple", "af_sound_1_", "beep");
        beep = detectorSound.FindSoundItem("beep", false);
    }
    if (beep) {
        HUD_SOUND_ITEM::PlaySound(*beep, Fvector().set(0.f, 0.f, 0.f), nullptr, true);
        if (beep->m_activeSnd) beep->m_activeSnd->snd.set_frequency(hint->pitch);
    }
    if (tier == 1)
        static_cast<CUIArtefactDetectorSimple*>(ui)->Flash(true, std::clamp((1.4f - hint->pitch) / 0.5f, 0.f, 1.f));
}
void InventoryPresentation::stopReloadSounds() {
    for (auto& voice : reloadSounds) {
        if (!voice._handle()) continue;
        if (voice._feedback() && strstr(Core.Params, "-zone-weapon-hud-probe"))
            Msg("* Zone weapon HUD reload stopped: %s", voice._handle()->file_name());
        voice.stop();
        voice.destroy();
    }
}
static pcstr firearmMotion(CWeapon& weapon, bool launcher, unsigned ammo) {
    // Stock PlayAnimShoot selects these aliases before the round is removed.
    if (smart_cast<CWeaponMagazinedWGrenade*>(&weapon) && weapon.IsGrenadeLauncherAttached()) {
        return launcher ? weapon.WhichHUDAnimationExist("anm_shots_g", "anim_shoot_g", true)
                        : weapon.WhichHUDAnimationExist("anm_shots_w_gl", "anim_shoot_gl", true);
    }
    if (smart_cast<CWeaponBM16*>(&weapon)) {
        return ammo == 0 ? weapon.WhichHUDAnimationExist("anm_shot_1", "anim_shoot_1", true)
                         : weapon.WhichHUDAnimationExist("anm_shot_2", "anim_shoot", true);
    }
    if (ammo == 0 && (smart_cast<CWeaponPistol*>(&weapon) || smart_cast<CWeaponRevolver*>(&weapon)))
        if (pcstr last = weapon.WhichHUDAnimationExist("anm_shot_l", "anim_shot_last", true))
            return last;
    return weapon.WhichHUDAnimationExist("anm_shots", "anim_shoot", true);
}
pcstr InventoryPresentation::grenadeHudMotion(CHudItem& hud, unsigned cue, bool& playIdle) {
    switch (cue) {
    case 5: // Prime
    case 6: // Quick
        grenadeStage = GrenadeStage::Pin;
        grenadeReleased = cue == 6;
        hud.PlaySound("sndCheckout", actor->Position());
        return hud.WhichHUDAnimationExist("anm_throw_begin", "anim_throw_begin", true);
    case 7: // Release
        grenadeReleased = true;
        break;
    case 8: // Cancel
        grenadeStage.reset();
        grenadeReleased = false;
        weaponMotionEnd.reset();
        playIdle = true;
        return nullptr;
    }
    if (grenadeReleased && (grenadeStage != GrenadeStage::Pin || playIdle)
        && grenadeStage != GrenadeStage::Throw) {
        grenadeStage = GrenadeStage::Throw;
        return hud.WhichHUDAnimationExist("anm_throw", "anim_throw_act", true);
    }
    if (grenadeStage == GrenadeStage::Pin && playIdle) {
        grenadeStage = GrenadeStage::Ready;
        return hud.WhichHUDAnimationExist("anm_throw_idle", "anim_throw_idle", true);
    }
    if (grenadeStage == GrenadeStage::Throw && playIdle) {
        grenadeStage.reset();
        grenadeReleased = false;
    }
    if (grenadeStage == GrenadeStage::Ready)
        playIdle = false;
    return nullptr;
}
void InventoryPresentation::updateWeaponHud(const Fmatrix& camera, bool firstPerson, const DetectorHint* detector) {
    const auto* selected = firstPerson ? equippedHudItem() : nullptr;
    const auto item = selected ? items.find(selected->id) : items.end();
    auto* hud = item == items.end() ? nullptr : smart_cast<CHudItem*>(item->second.object);
    unsigned roundsLeft = 0;
    const auto fired = zone_engine_weapon_fire(inventory().life,
        hud && (selected->kind == 3 || selected->index == 1 || selected->index == 4) ? selected->id.c_str() : nullptr, &roundsLeft);
    const bool blade = fired == 3 || fired == 4;
    const bool gunfire = fired == 1 || fired == 2;
    char reloadAlias[64];
    unsigned reloadSound = 0;
    const auto reload = zone_engine_weapon_reload(inventory().life,
        hud && selected->kind == 3 ? selected->id.c_str() : nullptr, reloadAlias, sizeof(reloadAlias), &reloadSound);
    const bool followThrough = firstPerson && inventory().alive && grenadeStage == GrenadeStage::Throw
        && weaponMotionEnd && static_cast<std::int32_t>(Device.dwTimeGlobal - *weaponMotionEnd) < 0
        && items.find(presentedWeaponId) == items.end() && !menuOpen();
    g_player_hud->set_detached_hands_visible(followThrough);
    if (followThrough) {
        detachDetectorHud();
        g_player_hud->update(camera);
        return;
    }
    if (!hud || !hud->HudSection().size()) {
        stopReloadSounds();
        detachWeaponHud();
        presentedWeaponId.clear();
        weaponMotionEnd.reset();
        knifeRecovery.reset();
        grenadeStage.reset();
        grenadeReleased = false;
        updateDetectorHud(camera, firstPerson, nullptr, detector);
        return;
    }

    bool playIdle = weaponMotionEnd && static_cast<std::int32_t>(Device.dwTimeGlobal - *weaponMotionEnd) >= 0;
    if (playIdle)
        weaponMotionEnd.reset();
    pcstr motion = nullptr;
    bool knifeMotion = false;
    if (hud != presentedWeapon) {
        detachWeaponHud();
        presentedWeapon = hud;
        g_player_hud->attach_item(hud);
        // Presentation items skip UpdateCL, which normally syncs the cached
        // HUD model's addon bones after it is attached to the player HUD.
        if (auto* weapon = hudFirearm())
            weapon->UpdateHUDAddonsVisibility();
        // The HUD keeps its animation tracks when the same owned item is rebound.
        if (presentedWeaponId != selected->id) {
            stopReloadSounds();
            presentedWeaponId = selected->id;
            weaponMotionEnd.reset();
            knifeRecovery.reset();
            grenadeStage.reset();
            grenadeReleased = false;
            motion = hud->WhichHUDAnimationExist("anm_show", "anim_draw", true);
            if (!motion && hud->isHUDAnimationExist("anim_show", true))
                motion = "anim_show";
        }
        playIdle = !weaponMotionEnd;
    }
    const bool reloading = reload > 0 && hud->isHUDAnimationExist(reloadAlias, true);
    if (reloading)
        motion = reloadAlias;
    else if (reload == 0 || reload == -2) {
        if (reload == -2) stopReloadSounds();
        weaponMotionEnd.reset();
        playIdle = true;
    }
    if (blade && selected->index == 1) {
        const bool stab = fired == 4;
        if (const auto strike = hud->WhichHUDAnimationExist(stab ? "anm_attack2" : "anm_attack",
                stab ? "anim_shoot2_start" : "anim_shoot1_start", true)) {
            motion = strike;
            knifeRecovery = stab;
            knifeMotion = true;
        }
    } else if (gunfire && !reloading) {
        // A shot that preceded this reload can arrive in the same engine frame.
        auto* weapon = smart_cast<CWeapon*>(hud);
        if (pcstr shot = weapon ? firearmMotion(*weapon, fired == 2, roundsLeft) : nullptr) {
            motion = shot;
            if (strstr(Core.Params, "-zone-weapon-hud-probe"))
                Msg("* Zone weapon HUD shot: %s %s rounds=%u", selected->section.c_str(), shot, roundsLeft);
        }
    }
    if (selected->index == 4)
        if (const auto throwing = grenadeHudMotion(*hud, fired, playIdle))
            motion = throwing;
    if (playIdle && !motion && knifeRecovery) {
        const bool stab = *knifeRecovery;
        knifeRecovery.reset();
        motion = hud->WhichHUDAnimationExist(stab ? "anm_attack2_end" : "anm_attack_end",
            stab ? "anim_shoot2_end" : "anim_shoot1_end", true);
        if (!motion && hud->isHUDAnimationExist(stab ? "anm_attack2_e" : "anm_attack_e", true))
            motion = stab ? "anm_attack2_e" : "anm_attack_e";
        knifeMotion = motion != nullptr;
    }
    if (motion) {
        const auto duration = hud->PlayHUDMotion_noCB(motion, FALSE);
        weaponMotionEnd = Device.dwTimeGlobal + duration;
        if (knifeMotion && strstr(Core.Params, "-zone-weapon-hud-probe"))
            Msg("* Zone weapon HUD knife: %s %u ms", motion, duration);
        if (selected->index == 4 && grenadeStage && strstr(Core.Params, "-zone-weapon-hud-probe"))
            Msg("* Zone grenade HUD: %s %s %u ms", selected->section.c_str(), motion, duration);
        if (motion == reloadAlias) {
            if (strstr(Core.Params, "-zone-weapon-hud-probe"))
                Msg("* Zone weapon HUD reload: %s %s %u ms", selected->section.c_str(), motion, duration);
            if (auto* weapon = smart_cast<CWeaponMagazined*>(hud); weapon && reloadSound < reloadSounds.size()) {
                // A new reload clears older voices. Tube insert and close may
                // overlap a previous distinct, nonexclusive stock sample.
                if (reloadSound <= 6) stopReloadSounds();
                weapon->PlayConfirmedHudReload(reloadSound, reloadSounds[reloadSound]);
            }
        }
    } else if (playIdle || (weaponAimIdleDirty && !weaponMotionEnd)) {
        pcstr idle = nullptr;
        if (const auto* weapon = hudFirearm(); weapon && weapon->IsZoomed()) {
            if (selected->launcherMode)
                idle = hud->WhichHUDAnimationExist("anm_idle_g_aim", "anim_idle_g_aim", true);
            else if (weapon->IsGrenadeLauncherAttached())
                idle = hud->WhichHUDAnimationExist("anm_idle_w_gl_aim", "anim_idle_gl_aim", true);
            if (!idle)
                idle = hud->WhichHUDAnimationExist("anm_idle_aim", "anim_idle_aim", true);
        }
        if (!idle)
            idle = hud->WhichHUDAnimationExist("anm_idle", "anim_idle", true);
        if (idle)
            hud->PlayHUDMotion_noCB(idle, TRUE);
        weaponAimIdleDirty = false;
    }
    updateDetectorHud(camera, firstPerson, hud, detector);
    if (auto* weapon = gunfire ? smart_cast<CWeaponMagazined*>(hud) : nullptr)
        weapon->PlayConfirmedHudShot(fired == 2);
}
bool InventoryPresentation::equippedWeaponAction(unsigned action, unsigned index) {
    if (!inventory().valid || !inventory().alive) return false;
    const auto life = inventory().life;
    if (const int pending = zone_engine_pending_weapon_slot(life); pending >= 0) {
        if (action == InventoryReload || action == InventoryNextAmmo) {
            if (const auto* weapon = hudItemInSlot(pending); weapon && weapon->kind == 3) {
                deferredWeaponAction = DeferredWeaponAction{life, weapon->id, action, index};
                return true;
            }
        }
        return false;
    }
    const auto* selected = equippedWeapon();
    if (!selected) return false;
    const auto item = items.find(selected->id);
    return item != items.end() && move(item->second.object, action, index);
}
bool InventoryPresentation::useQuickItem(unsigned index) {
    if (!actor || !inventory().valid || !inventory().alive) return false;
    auto& carried = actor->inventory();
    CInventoryItem* item = nullptr;
    if (index < 4) {
        const auto& section = ACTOR_DEFS::g_quick_use_slots[index];
        if (section[0]) item = carried.GetAny(section);
    } else {
        item = carried.item(index == 4 ? CLSID_IITEM_BANDAGE : CLSID_IITEM_MEDKIT);
    }
    return item && item->Useful() && move(item, InventoryConsume);
}
bool InventoryPresentation::move(CInventoryItem* item,unsigned action,unsigned index) {
    if(!inventory().valid||!inventory().alive)return false;
    for(const auto& entry:items) if(entry.second.object==item) {
        zone_inventory_intent(entry.first.c_str(),entry.second.revision,inventory().life,action,index);return true;
    }
    return false;
}
bool InventoryPresentation::attach(const CInventoryItem* weapon, const CInventoryItem* addon) {
    if (!weapon || !addon || !inventory().valid || !inventory().alive) return false;
    const auto target = std::find_if(items.begin(), items.end(), [&](const auto& entry) {
        return entry.second.object == weapon;
    });
    if (target == items.end()) return false;
    const auto send = [&](const auto& source) {
        for (const auto& [id, entry] : source) {
            if (entry.object != addon) continue;
            zone_inventory_attach(target->first.c_str(), target->second.revision,
                id.c_str(), entry.revision, inventory().life);
            return true;
        }
        return false;
    };
    if (send(items)) return true;
    const auto& search = corpseSearch();
    return corpseMenuShown && search.open && search.updates == corpseUpdates &&
        search.state.corpse == requestedContainer && search.state.life == inventory().life &&
        send(corpseLoot);
}
bool InventoryPresentation::detach(const CInventoryItem* weapon, unsigned slot) {
    if (!inventory().valid || !inventory().alive) return false;
    for (const auto& [id, entry] : items) {
        if (entry.object != weapon) continue;
        zone_inventory_detach(id.c_str(), entry.revision, inventory().life, slot);
        return true;
    }
    return false;
}
void inventoryCorpseItems(std::vector<CInventoryItem*>& out) {if (current) current->corpseItems(out);}
bool inventoryTakeCorpseItem(const CInventoryItem* item) {return current && current->takeCorpseItem(item);}
const SurvivalVitals* inventoryVitals() {return current ? current->vitals() : nullptr;}
const SurvivalVitals* InventoryPresentation::vitals(const CInventoryOwner* owner) const {
    return actor && static_cast<const CInventoryOwner*>(actor) == owner ? vitals() : nullptr;
}
const SurvivalVitals* inventoryVitals(const CInventoryOwner* owner) {return current ? current->vitals(owner) : nullptr;}
CInventoryItem* inventoryHudWeapon(const CInventoryOwner* owner) {return current ? current->hudWeapon(owner) : nullptr;}
const char* inventoryContainerUseTip() {return current ? current->containerUseTip() : nullptr;}
bool inventoryStoreItem(const CInventoryItem* item) {return current && current->storeItem(item);}
void inventoryBatchBegin() {zone_inventory_batch_begin();}
void inventoryBatchEnd() {zone_inventory_batch_end();}
bool inventoryMenuAction(CInventoryItem* item,unsigned action,unsigned index) {return current && current->move(item,action,index);}
bool inventoryAttach(const CInventoryItem* weapon, const CInventoryItem* addon) {return current && current->attach(weapon,addon);}
bool inventoryDetach(const CInventoryItem* weapon, unsigned slot) {return current && current->detach(weapon,slot);}
int InventoryPresentation::beltCell(const CInventoryItem* item) const {
    for (const auto& entry:items) if (entry.second.object==item)
        for (const auto& state:inventory().items) if(state.id==entry.first && state.placement==2) return state.index;
    return -1;
}
int inventoryBeltCell(const CInventoryItem* item) {return current?current->beltCell(item):-1;}
}
