#include "pch_script.h"
#include "InventoryPresentation.h"
#include "EngineAdapter.h"
#include "Level.h"
#include "Actor.h"
#include "ActorCondition.h"
#include "Inventory.h"
#include "inventory_item.h"
#include "eatable_item.h"
#include "Weapon.h"
#include "WeaponMagazined.h"
#include "WeaponMagazinedWGrenade.h"
#include "game_cl_base.h"
#include "HUDManager.h"
#include "UIGameCustom.h"
#include "ui/UIActorMenu.h"
#include "ui/UIMainIngameWnd.h"
#include "xrServer_Objects_ALife_Monsters.h"
#include "xrServer_Objects_ALife_Items.h"
#include "clsid_game.h"
#include "xrPhysics/IPHWorld.h"
#include "xrNetServer/NET_Messages.h"
#include <emscripten.h>

#include "InventoryIntent.h"
EM_JS(int, zone_engine_vitals, (unsigned life, void* values), {
    return globalThis.zoneEngineVitals?.(life>>>0, values) ? 1 : 0;
});
EM_JS(int, zone_engine_weapon_misfire, (unsigned life), {
    return globalThis.zoneEngineWeaponMisfire?.(life>>>0) ? 1 : 0;
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
unsigned char ammoIndex(pcstr section, pcstr key, const std::string& ammo) {
    if (!pSettings->line_exist(section,key)) return 0;
    pcstr list = pSettings->r_string(section,key); string128 value;
    for (int i=0;i<_GetItemCount(list);++i) if (ammo == _GetItem(list,i,value)) return static_cast<unsigned char>(i);
    return 0;
}
}
InventoryPresentation::InventoryPresentation(CLevel& value) : level(value) {VERIFY(!current);current=this;}
InventoryPresentation::~InventoryPresentation() {
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
    level.SetEntity(actor);HUD().Load();HUD().OnConnected();
    Msg("* Zone inventory: native presentation actor ready, local simulation disabled");
}
void InventoryPresentation::remove(CInventoryItem* item) {
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
    for (const auto& upgrade : state.upgrades) inventoryItem->m_upgrades.emplace_back(upgrade.c_str());
    if (auto* ammo=smart_cast<CSE_ALifeItemAmmo*>(definition)) ammo->a_elapsed=static_cast<u16>(state.quantity);
    if (auto* weapon=smart_cast<CSE_ALifeItemWeapon*>(definition)) {
        weapon->a_elapsed=static_cast<u16>(state.cartridges.size());
        weapon->ammo_type=ammoIndex(state.section.c_str(),"ammo_class",state.selectedAmmunition);
        weapon->a_elapsed_grenades.grenades_count=static_cast<u8>(state.launcherCartridges.size());
        if (!state.launcherCartridges.empty()) weapon->a_elapsed_grenades.grenades_type=ammoIndex(state.section.c_str(),"grenade_class",state.launcherCartridges.front());
        for (const auto& addon:state.attachments) {
            const auto cls=pSettings->r_clsid(addon.c_str(),"class");
            if (cls==CLSID_OBJECT_W_SCOPE) weapon->m_addon_flags.set(CSE_ALifeItemWeapon::eWeaponAddonScope,TRUE);
            else if (cls==CLSID_OBJECT_W_SILENCER) weapon->m_addon_flags.set(CSE_ALifeItemWeapon::eWeaponAddonSilencer,TRUE);
            else if (cls==CLSID_OBJECT_W_GLAUNCHER) weapon->m_addon_flags.set(CSE_ALifeItemWeapon::eWeaponAddonGrenadeLauncher,TRUE);
        }
    }
    if (auto* weapon=smart_cast<CSE_ALifeItemWeaponShotGun*>(definition))
        for (const auto& cartridge:state.cartridges) weapon->m_AmmoIDs.push_back(ammoIndex(state.section.c_str(),"ammo_class",cartridge));
    auto* object=smart_cast<CGameObject*>(level.Objects.Create(state.section.c_str()));
    R_ASSERT(object && object->net_Spawn(definition));F_entity_Destroy(definition);
    if(object->register_schedule())Engine.Sheduler.Unregister(object);
    auto* item=smart_cast<CInventoryItem*>(object);R_ASSERT(item);
    if (auto* weapon=smart_cast<CWeapon*>(item)) weapon->SetPresentationMisfire(state.jammed);
    if (auto* weapon=smart_cast<CWeaponMagazined*>(item)) {
        weapon->SetPresentationFireMode(state.fireMode);
        for (const auto& addon : state.attachments) {
            if (pSettings->r_clsid(addon.c_str(), "class") == CLSID_OBJECT_W_SCOPE)
                weapon->SetPresentationScope(addon.c_str());
        }
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
    if (!view.valid) {hasVitals=false;if (CurrentGameUI()) CurrentGameUI()->HideActorMenu();return;}
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
        // Clear placements first so an atomic server swap cannot encounter a
        // temporarily occupied native slot. Outfit precedes helmet and belt.
        for(auto& entry:items) if(!actor->inventory().InRuck(entry.second.object))
            actor->inventory().Ruck(entry.second.object,true);
        for(unsigned pass=0;pass<3;++pass) for(const auto& state:view.items) {
            auto* item=items.at(state.id).object;
            if(state.placement==1 && ((pass==0 && state.index==7)||(pass==1 && state.index!=7)))
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
            if (distance > 0.01f && level.ObjectSpace.RayPick(Device.vCameraPosition, ray.div(distance),
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
    if (!requestedContainer.empty()) dismissCorpse();
    return CurrentGameUI()->ShowActorMenu();
}
bool InventoryPresentation::menuOpen() const {return actor && CurrentGameUI() && CurrentGameUI()->GetActorMenu().IsShown();}
const InventoryItemState* InventoryPresentation::equippedWeapon() const {
    if (!inventory().valid || !inventory().alive) return nullptr;
    // Before the player selects a slot, use the primary rifle slot, then the
    // pistol slot. An explicitly selected empty slot has no weapon action.
    const InventoryItemState* selected = nullptr;
    for (const auto& state : inventory().items) {
        if (state.kind != 3 || state.placement != 1 || (state.index != 2 && state.index != 3))
            continue;
        if (selectedWeaponSlot == state.index || (!selectedWeaponSlot && (!selected || state.index == 3)))
            selected = &state;
    }
    return selected;
}
CInventoryItem* InventoryPresentation::hudWeapon(const CInventoryOwner* owner) const {
    if (!actor || static_cast<const CInventoryOwner*>(actor) != owner) return nullptr;
    const auto* selected = equippedWeapon();
    if (!selected) return nullptr;
    const auto item = items.find(selected->id);
    return item == items.end() ? nullptr : item->second.object;
}
bool InventoryPresentation::equippedWeaponAction(unsigned action, unsigned index) {
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
