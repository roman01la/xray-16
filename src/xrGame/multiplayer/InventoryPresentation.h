#pragma once
#include "InventoryState.h"
#include "WorldItemsState.h"
#include <functional>
#include "xrCore/_matrix.h"
#include "xrCore/_vector3d.h"
#include "xrSound/Sound.h"
#include <array>
#include <cstddef>
#include <map>
#include <optional>
#include <string>
class CLevel;
class CActor;
class CInventoryItem;
class CInventoryOwner;
class CGameObject;
class CHudItem;
class CWeapon;
class CCustomDetector;
namespace zone {
struct DetectorHint {
    float tier, working, period, pitch, bearing, count;
    std::array<std::array<float, 3>, 32> points;
    std::array<std::array<char, 65>, 32> labels;
};
static_assert(offsetof(DetectorHint, labels) == (6 + 32 * 3) * sizeof(float));
struct SurvivalVitals {
    float power, satiety, thirst, bleeding, radiation;
    float carriedWeight, carryLimit, walkLimit;
    std::uint32_t boosterIcons;
};
static_assert(sizeof(SurvivalVitals) == 36);
const SurvivalVitals* inventoryVitals();
const SurvivalVitals* inventoryVitals(const CInventoryOwner* owner);
CInventoryItem* inventoryHudWeapon(const CInventoryOwner* owner);
// Native menu/item presentation; never runs the native actor simulation.
class InventoryPresentation {
public:
    explicit InventoryPresentation(CLevel& level);
    ~InventoryPresentation();
    void update(const Fvector& position, float health);
    void updateWeaponHud(const Fmatrix& camera, bool firstPerson, const DetectorHint* detector);
    CWeapon* hudFirearm() const;
    void setWeaponAim(bool aiming);
    void updateWorld(const std::function<Fvector(const std::array<float,3>&)>& project, bool firstPerson);
    bool pickup();
    const char* containerUseTip() const;
    bool storeItem(const CInventoryItem* item);
    bool takeCorpseItem(const CInventoryItem* item);
    void corpseItems(std::vector<CInventoryItem*>& out) const;
    bool toggle();
    bool menuOpen() const;
    void selectWeaponSlot(unsigned slot);
    void cancelDeferredWeaponAction() { deferredWeaponAction.reset(); }
    const InventoryItemState* equippedWeapon() const;
    const InventoryItemState* equippedKnife() const;
    const InventoryItemState* equippedThrowable() const;
    CInventoryItem* hudWeapon(const CInventoryOwner* owner) const;
    bool useQuickItem(unsigned index);
    const SurvivalVitals* vitals() const {return hasVitals ? &currentVitals : nullptr;}
    const SurvivalVitals* vitals(const CInventoryOwner* owner) const;
    bool equippedWeaponAction(unsigned action, unsigned index = 0);
    bool move(CInventoryItem* item, unsigned action, unsigned index = 0);
    bool attach(const CInventoryItem* weapon, const CInventoryItem* addon);
    bool detach(const CInventoryItem* weapon, unsigned slot);
    int beltCell(const CInventoryItem* item) const;
private:
    const InventoryItemState* equippedHudItem() const;
    const InventoryItemState* hudItemInSlot(int slot) const;
    void detachWeaponHud();
    void detachDetectorHud();
    void updateDetectorHud(const Fmatrix& camera, bool firstPerson, CHudItem* primary, const DetectorHint* hint);
    void stopReloadSounds();
    const char* grenadeHudMotion(CHudItem& hud, unsigned cue, bool& playIdle);
    void updateCorpseMenu();
    void dismissCorpse();
    void start(const Fvector& position);
    void remove(CInventoryItem* item);
    void destroy(CGameObject& object);
    void updateStorageBox(const WorldStorageLocation* storage);
    CInventoryItem* spawn(const InventoryItemState& state, unsigned short id, const Fvector& position, bool carried = true);
    unsigned short allocateId();
    struct Item {CInventoryItem* object; std::uint32_t revision; unsigned short id;};
    CLevel& level;
    CActor* actor = nullptr;
    CHudItem* presentedWeapon = nullptr;
    CCustomDetector* presentedDetector = nullptr;
    std::optional<std::uint32_t> detectorMotionEnd;
    bool detectorStowing = false;
    bool detectorResumeFast = false;
    float detectorBeepTime = 0;
    HUD_SOUND_COLLECTION detectorSound;
    std::string presentedWeaponId;
    std::optional<std::uint32_t> weaponMotionEnd;
    std::optional<bool> knifeRecovery;
    enum class GrenadeStage { Pin, Ready, Throw };
    std::optional<GrenadeStage> grenadeStage;
    bool grenadeReleased = false;
    struct DeferredWeaponAction {
        std::uint32_t life;
        std::string item;
        unsigned action, index;
    };
    std::optional<DeferredWeaponAction> deferredWeaponAction;
    bool weaponAimIdleDirty = false;
    std::array<ref_sound, 9> reloadSounds;
    CGameObject* storageBox = nullptr;
    std::map<std::string, Item> items;
    std::map<std::string, Item> looseItems;
    std::map<std::string, Item> corpseLoot;
    std::string pickupId, targetedContainer, requestedContainer;
    bool targetingStorage = false;
    std::uint64_t corpseUpdates = 0;
    bool corpseMenuShown = false;
    std::uint64_t worldUpdates = 0, worldInventoryUpdates = 0;
    std::uint64_t updates = 0;
    unsigned short nextId = 2;
    bool applied = false;
    bool hasVitals = false;
    SurvivalVitals currentVitals{};
};
enum InventoryWeaponAction : unsigned {
    InventoryReload = 5,
    InventoryUnload = 6,
    InventoryNextAmmo = 7,
    InventoryConsume = 9,
    InventoryFireMode = 10,
    InventoryLauncherMode = 13
};
bool inventoryMenuAction(CInventoryItem* item, unsigned action, unsigned index = 0);
bool inventoryAttach(const CInventoryItem* weapon, const CInventoryItem* addon);
bool inventoryDetach(const CInventoryItem* weapon, unsigned slot);
void inventoryBatchBegin();
void inventoryBatchEnd();
int inventoryBeltCell(const CInventoryItem* item);
void inventoryCorpseItems(std::vector<CInventoryItem*>& out);
bool inventoryTakeCorpseItem(const CInventoryItem* item);
const char* inventoryContainerUseTip();
bool inventoryStoreItem(const CInventoryItem* item);
}
