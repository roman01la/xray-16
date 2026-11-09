#include "pch_script.h"
#include "EngineAdapter.h"
#include "Appearance.h"
#include "Actor_Flags.h"
#include "InventoryPresentation.h"
#include "InventoryIntent.h"
#include "Level.h"
#include "UIGameCustom.h"
#include "HUDManager.h"
#include "HudSound.h"
#include "Weapon.h"
#include "ParticlesObject.h"
#include "clsid_game.h"
#include "xrEngine/xr_level_controller.h"
#include "xrEngine/CameraManager.h"
#include "xrEngine/Environment.h"
#include "xrEngine/Render.h"
#include "xrEngine/IRenderable.h"
#include "xrEngine/xr_input.h"
#include "Include/xrRender/RenderVisual.h"
#include "Include/xrRender/Kinematics.h"
#include "Include/xrRender/KinematicsAnimated.h"
#include <emscripten.h>
#include <map>
#include <memory>
#include <string>
#include <string_view>

EM_JS(void, zone_map_input, (float x, float z, float yaw, float pitch, int sprint, int jump, int crouch, int walk, int aiming), {
    globalThis.zoneEngineInput?.({x,z,yaw,pitch,sprint:!!sprint,jump:!!jump,crouch:!!crouch,walk:!!walk,aiming:!!aiming});
});
EM_JS(void, zone_reload, (), {globalThis.zoneEngineReload?.();});
EM_JS(int, zone_grenades_poll, (void* output, unsigned capacity), {
    return globalThis.zoneEngineGrenadesPoll?.(output,capacity) ?? -1;
});
EM_JS(void, zone_use_travel, (), {globalThis.zoneEngineUseTravel?.();});
EM_JS(void, zone_toggle_detector, (unsigned life), {globalThis.zoneEngineToggleDetector?.(life);});
EM_JS(bool, zone_detector_hint, (unsigned life, void* output, int aiming), {return !!globalThis.zoneEngineDetectorHint?.(life,output,!!aiming);});
EM_JS(bool, zone_aim_allowed, (unsigned life), {return !!globalThis.zoneEngineAimAllowed?.(life);});
EM_JS(void, zone_respawn, (), {globalThis.zoneEngineRespawn?.();});
EM_JS(void, zone_view, (int firstPerson, int crosshair), {globalThis.zoneEngineView?.(!!firstPerson,!!crosshair);});
extern ENGINE_API float g_fov;
extern BOOL b_toggle_weapon_aim;
EM_JS(int, zone_prediction, (float* out), {return globalThis.zoneEnginePrediction?.(out) ?? 0;});
EM_JS(int, zone_world_space, (), {return globalThis.zoneEngineWorldSpace?.()?1:0;});
EM_JS(void, zone_verify_asset, (int kind, const void* pointer, unsigned size), {
    globalThis.zoneEngineVerifyAsset?.(kind,pointer,size);
});
EM_JS(int, zone_content_status, (), {return globalThis.zoneEngineContentStatus?.() ?? -1;});
EM_JS(int, zone_appearance_poll, (void* out, unsigned capacity), {
    return globalThis.zoneEngineAppearancePoll?.(out, capacity) ?? 0;
});
EM_JS(unsigned, zone_detonations, (void* effects, unsigned capacity), {
    return globalThis.zoneEngineDetonations?.(effects, capacity) ?? 0;
});
EM_JS(unsigned, zone_gunshots, (void* effects, unsigned capacity), {
    return globalThis.zoneEngineGunshots?.(effects, capacity) ?? 0;
});
namespace zone {
namespace {
struct DetonationEffect {
    float position[3];
    char section[129];
};
struct GunshotEffect {
    float position[3];
    std::uint32_t sound;
    std::uint32_t shooter;
    char section[129];
};
struct GrenadeFrame {
    std::uint32_t id;
    float position[3];
    char section[33];
};
static_assert(offsetof(GrenadeFrame, section) == 16 && sizeof(GrenadeFrame) == 52);
constexpr unsigned GrenadeCapacity = 8;
static_assert(offsetof(DetonationEffect, section) == 12 && sizeof(DetonationEffect) == 144);
constexpr unsigned DetonationCapacity = 8;
static_assert(offsetof(GunshotEffect, section) == 20 && sizeof(GunshotEffect) == 152);
constexpr unsigned GunshotCapacity = 8;
constexpr unsigned KnifeSlash = 3, KnifeStab = 4;
constexpr const char* DefaultProxyVisual = "actors\\stalker_neutral\\stalker_neutral_1";

bool handGrenadeClass(CLASS_ID cls) {
    return cls == xray::make_clsid("G_F1_S  ") || cls == xray::make_clsid("G_RGD5_S");
}

struct ParticleDeleter {
    void operator()(CParticlesObject* particle) const { CParticlesObject::Destroy(particle); }
};
struct TimedParticle {
    std::unique_ptr<CParticlesObject, ParticleDeleter> particle;
    float remaining;
};
struct BlowoutLight {
    ref_light light;
    Fvector color;
    float range;
    float duration;
    float remaining;
};

IRenderVisual* loadProxyVisual(const char* model) {
    if (!model || !*model) return nullptr;
    std::string name(model);
    if (!strext(model)) name += ".ogf";
    string_path path;
    if (!FS.exist(path, "$level$", name.c_str()) && !FS.exist(path, "$game_meshes$", name.c_str())) return nullptr;
    return GEnv.Render->model_Create(model);
}

IRenderVisual* equipmentVisual(const std::string& section, LPCSTR field) {
    if (section.empty() || !pSettings->line_exist(section.c_str(), field)) return nullptr;
    return loadProxyVisual(pSettings->r_string(section.c_str(), field));
}

IRenderVisual* playerVisual(const std::string& outfit) {
    auto* visual = outfit.empty() ? equipmentVisual("actor", "visual") : equipmentVisual(outfit, "actor_visual");
    if (visual && visual->dcast_PKinematics()) return visual;
    GEnv.Render->model_Delete(visual);
    return outfit.empty() ? GEnv.Render->model_Create(DefaultProxyVisual) : playerVisual({});
}

void playMuzzleParticle(pcstr effect, const Fmatrix& muzzle) {
    if (!effect || !*effect) return;
    auto* particle = CParticlesObject::Create(effect, FALSE);
    particle->SetXFORM(muzzle);
    particle->Play(false);
    if (particle->IsLooped()) {
        particle->Stop(TRUE);
        particle->PSI_SetLifeTime(1.f);
    }
    particle->SetAutoRemove(true);
}

// Presentation only: no CGameObject, AI, scheduler, inventory or local physics.
class Proxy final : public SpatialBase, public RenderableBase {
public:
    bool visible=true;
    explicit Proxy(const std::string& model = {}) : SpatialBase(g_pGamePersistent->SpatialSpace), npcModel(model) {
        if (nativeNpc()) loadNpcModel();
        else {
            renderable.visual = npcModel.empty() ? playerVisual({}) : GEnv.Render->model_Create(DefaultProxyVisual);
            resetSkeleton();
        }
        spatial.type = STYPE_RENDERABLE;
        spatial.sphere.set(Fvector().set(0, 1, 0), 2.f);
    }
    ~Proxy() override {
        spatial_unregister();
        GEnv.Render->model_Delete(helmet);
        GEnv.Render->model_Delete(weapon);
    }
    IRenderable* dcast_Renderable() override {return this;}
    void setAppearance(const EquipmentAppearance& appearance) {
        if (!npcModel.empty()) {
            if (!appearance.visual.empty() && npcModel != appearance.visual) {
                npcModel = appearance.visual;
                loadNpcModel();
            }
            return;
        }
        if (outfitSection != appearance.outfit) {
            outfitSection = appearance.outfit;
            GEnv.Render->model_Delete(renderable.visual);
            renderable.visual = playerVisual(outfitSection);
            resetSkeleton();
        }
        if (helmetSection != appearance.helmet) {
            helmetSection = appearance.helmet;
            GEnv.Render->model_Delete(helmet);
            helmet = equipmentVisual(helmetSection, "visual");
        }
        const bool weaponChanged = weaponSection != appearance.weapon;
        if (weaponChanged) {
            weaponSection = appearance.weapon;
            firingTime = 0.f;
            finishKnifeMotion();
            GEnv.Render->model_Delete(weapon);
            weapon = equipmentVisual(weaponSection, "visual");
            if (weapon) {
                const auto* section = weaponSection.c_str();
                weaponOffset.identity();
                if (pSettings->line_exist(section, "position") && pSettings->line_exist(section, "orientation")) {
                    Fvector angles = pSettings->r_fvector3(section, "orientation");
                    angles.mul(PI / 180.f);
                    weaponOffset.setHPB(angles.x, angles.y, angles.z);
                    weaponOffset.translate_over(pSettings->r_fvector3(section, "position"));
                }
                const auto cls = pSettings->r_clsid(section, "class");
                oneHand = handGrenadeClass(cls) || cls == CLSID_IITEM_BOLT ||
                    pSettings->read_if_exists<s32>(section, "hand_dependence", 2) == 1;
            }
            animationSlot = weapon ? pSettings->read_if_exists<s32>(weaponSection.c_str(), "animation_slot", 0) : 0;
            if (animationSlot < 0 || animationSlot > 13) animationSlot = 0;
            animateTorso();
        }
        if (weaponChanged || weaponAddons != appearance.weaponAddons) {
            weaponAddons = appearance.weaponAddons;
            updateWeaponAddonBones();
        }
    }
    void pose(const Fvector& position, float yaw, bool moving, bool crouch, bool dead) {
        from = renderable.xform.c;target = position;fromYaw = currentYaw;targetYaw = yaw;elapsed = 0;
        if (!registered || from.distance_to_sqr(target) > 400.f) {from = target;fromYaw = targetYaw;}
        if (moving != walking || crouch != crouched || dead != deadState) {
            const bool wasDead=deadState;deadState=dead;
            crouched=crouch;
            walking = moving;
            if (!nativeNpc()) {
                if (deadState) {
                    firingTime = 0.f;
                    knifeStab.reset();
                }
                animate(wasDead);
                animateTorso();
            }
        }
    }
    void applyNpcMotion(std::uint32_t id, std::uint16_t timeMs) {
        if (!nativeNpc() || !renderable.visual || id == noMotion || (id == npcMotion && timeMs == npcTimeMs)) return;
        auto* animated = renderable.visual->dcast_PKinematicsAnimated();
        if (!animated) return;
        const MotionID motion(static_cast<u16>(id >> 16), static_cast<u16>(id));
        if (motion.slot >= animated->LL_MotionsSlotCount() || motion.idx >= animated->LL_MotionsSlot(motion.slot).motion_defs()->size()) return;
        if (id != npcMotion) {
            animated->PlayCycle(BI_NONE, motion, FALSE);
            if (npcMotion == noMotion) Msg("* Zone NPC motion ready: %s", npcModel.c_str());
        }
        npcMotion = id;
        npcTimeMs = timeMs;
        for (::u32 part = 0; part < MAX_PARTS; ++part)
            for (::u32 i = 0; i < animated->LL_PartBlendsCount(part); ++i) {
                auto* blend = animated->LL_PartBlend(part, i);
                if (blend && blend->channel == 0 && blend->motionID == motion)
                    blend->timeCurrent = std::min(timeMs * .001f, blend->timeTotal);
            }
    }
    void advance(float dt) {
        if (!renderable.visual) return;
        if (firingTime > 0.f) {
            firingTime = std::max(0.f, firingTime - dt);
            if (firingTime == 0.f) {
                finishKnifeMotion();
                animateTorso();
            }
        }
        elapsed += dt;
        const float blend = std::min(1.f, elapsed * 15.f);
        Fvector position;position.lerp(from, target, blend);
        currentYaw = fromYaw + std::remainder(targetYaw - fromYaw, 6.2831853f) * blend;
        // Player input uses atan2(x, z); native NPC poses already use X-Ray HPB.
        renderable.xform.setHPB(npcModel.empty() ? -currentYaw : currentYaw, 0, 0);
        renderable.xform.c = position;
        if (auto* bones = renderable.visual->dcast_PKinematics()) {
            bones->CalculateBones_Invalidate();bones->CalculateBones(TRUE);
        }
        updateEquipmentPose();
        spatial.sphere.P = position;spatial.sphere.P.y += 1.f;
        if (!registered) {spatial_register();registered = true;} else spatial_move();
    }
    void predicted(const Fvector& position,float yaw) {
        renderable.xform.setHPB(-yaw,0,0);renderable.xform.c=position;
        updateEquipmentPose();
        spatial.sphere.P=position;spatial.sphere.P.y+=1.f;spatial_move();
    }
    void playConfirmedShot(const GunshotEffect& shot, const Fvector& origin) {
        if (!npcModel.empty() || !visible || deadState || weaponSection != shot.section
            || renderable.xform.c.distance_to_sqr(origin) > 36.f) return;
        if (shot.sound == KnifeSlash || shot.sound == KnifeStab) {
            knifeStab = shot.sound == KnifeStab;
            firingTime = 0.15f;
            firingTime = std::max(firingTime, animateTorso());
            return;
        }
        if (!weaponPose) return;
        const bool startMotion = firingTime == 0.f;
        firingTime = std::max(firingTime, shotDuration);
        if (startMotion && animationSlot) {
            // Start the stock firing cycle. A burst extends it without resetting
            // the torso every time a round arrives.
            firingTime = 0.15f;
            shotDuration = std::max(firingTime, animateTorso());
            firingTime = shotDuration;
        }
        if (!pSettings->line_exist(shot.section, "fire_point")) return;
        const bool launcher = shot.sound == 2, suppressed = shot.sound == 1;
        auto point = pSettings->r_fvector3(shot.section, "fire_point");
        if (launcher) point = pSettings->read_if_exists<Fvector>(shot.section, "fire_point2", point);
        Fmatrix muzzle = weaponTransform;
        weaponTransform.transform_tiny(muzzle.c, point);
        const auto* flame = pSettings->read_if_exists<pcstr>(shot.section,
            launcher ? "grenade_flame_particles" : suppressed ? "silencer_flame_particles" : "flame_particles", nullptr);
        const auto* smoke = launcher ? nullptr : pSettings->read_if_exists<pcstr>(shot.section,
            suppressed ? "silencer_smoke_particles" : "smoke_particles", nullptr);
        playMuzzleParticle(flame, muzzle);
        playMuzzleParticle(smoke, muzzle);
        if (strstr(Core.Params, "-zone-observer-shot-probe"))
            Msg("* Zone observer muzzle: shooter=%u %s mode=%u pos=(%.3f,%.3f,%.3f) flame=%s smoke=%s",
                shot.shooter, shot.section, shot.sound, VPUSH(muzzle.c), flame && *flame ? flame : "-", smoke && *smoke ? smoke : "-");
    }
    void renderable_Render(::u32 context, IRenderable* root) override {
        if (!visible || !renderable.visual) return;
        if (auto* bones = renderable.visual->dcast_PKinematics()) bones->CalculateBones(TRUE);
        GEnv.Render->add_Visual(context, root, renderable.visual, renderable.xform);
        if (helmetPose) GEnv.Render->add_Visual(context, root, helmet, helmetTransform);
        if (weaponPose && !deadState) GEnv.Render->add_Visual(context, root, weapon, weaponTransform);
    }
private:
    void updateWeaponAddonBones() {
        auto* bones = weapon ? weapon->dcast_PKinematics() : nullptr;
        if (!bones) return;
        unsigned visibleMask = 0;
        const auto apply = [&](const char* name, unsigned flag) {
            const auto bone = bones->LL_BoneID(name);
            if (bone == BI_NONE) return;
            const bool show = (weaponAddons & flag) != 0;
            if (!!bones->LL_GetBoneVisible(bone) != show)
                bones->LL_SetBoneVisible(bone, show, TRUE);
            if (bones->LL_GetBoneVisible(bone))
                visibleMask |= flag;
        };
        apply("wpn_scope", 1);
        apply("wpn_launcher", 2);
        apply("wpn_grenade_launcher", 2);
        apply("wpn_silencer", 4);
        bones->CalculateBones_Invalidate();
        bones->CalculateBones(TRUE);
        if (strstr(Core.Params, "-zone-observer-shot-probe"))
            Msg("* Zone observer addons: %s mask=%u bones=%u", weaponSection.c_str(), unsigned(weaponAddons), visibleMask);
    }
    bool nativeNpc() const { return !npcModel.empty() && npcModel != "stalker"; }
    void loadNpcModel() {
        GEnv.Render->model_Delete(renderable.visual);
        renderable.visual = nativeNpc() ? loadProxyVisual(npcModel.c_str()) : GEnv.Render->model_Create(DefaultProxyVisual);
        npcMotion = noMotion;
        if (!renderable.visual) Msg("! Zone NPC model unavailable: %s", npcModel.c_str());
        else if (nativeNpc()) Msg("* Zone NPC model ready: %s", npcModel.c_str());
        else resetSkeleton();
    }
    void resetSkeleton() {
        if (auto* bones = renderable.visual->dcast_PKinematics()) {
            head = bones->LL_BoneID("bip01_head");
            right = bones->LL_BoneID(pSettings->r_string("actor", "weapon_bone0"));
            left = bones->LL_BoneID(pSettings->r_string("actor", "weapon_bone1"));
            finger = bones->LL_BoneID(pSettings->r_string("actor", "weapon_bone2"));
        } else { head = right = left = finger = BI_NONE; }
        animateHead();
        animate(false);
        animateTorso();
    }
    void animateHead() {
        if (auto* animated = renderable.visual->dcast_PKinematicsAnimated()) {
            const auto motion = animated->ID_Cycle_Safe("head_idle_0");
            if (motion.valid()) animated->PlayCycle(motion, FALSE);
        }
    }
    void finishKnifeMotion() {
        if (!knifeStab) return;
        knifeStab.reset();
        if (!renderable.visual || deadState) return;
        animate(false);
        animateHead();
    }
    float animateTorso() {
        if (!npcModel.empty() || !renderable.visual || deadState) return 0.f;
        auto* animated = renderable.visual->dcast_PKinematicsAnimated();
        if (!animated) return 0.f;
        const bool firing = firingTime > 0.f && animationSlot != 0;
        string64 name;
        const auto* posture = crouched ? "cr" : "norm";
        auto motion = MotionID();
        if (firing && knifeStab && !walking) {
            xr_sprintf(name, "%s_all_%d_attack_%d", posture, animationSlot, *knifeStab ? 1 : 0);
            motion = animated->ID_Cycle_Safe(name);
        }
        const bool wholeBody = motion.valid();
        if (!wholeBody) {
            const bool slash = knifeStab && !*knifeStab;
            const auto* cycle = firing ? (slash ? "attack_0" : "attack_1")
                : animationSlot ? (walking ? "aim_2" : "aim_1") : "aim_0";
            xr_sprintf(name, "%s_torso_%d_%s", posture, animationSlot, cycle);
            motion = animated->ID_Cycle_Safe(name);
            if (!motion.valid() || animated->LL_GetMotionDef(motion)->bone_or_part >= MAX_PARTS) return 0.f;
        }
        bool played;
        if (wholeBody) {
            // The all-partitions overload starts a blend on each part and returns no single blend.
            animated->PlayCycle(BI_NONE, motion, TRUE);
            played = true;
        } else {
            played = animated->PlayCycle(motion, TRUE) != nullptr;
        }
        if (firing && played && strstr(Core.Params, "-zone-observer-shot-probe"))
            Msg("* Zone observer torso: %s %s", weaponSection.c_str(), name);
        return firing && played ? animated->get_animation_length(motion) : 0.f;
    }
    void animate(bool wasDead) {
        auto* animated = renderable.visual->dcast_PKinematicsAnimated();
        if (!animated) return;
        const auto* name = deadState ? "norm_death_0" : crouched ? (walking ? "cr_walk_fwd_0" : "cr_idle_0")
                                                              : (walking ? "norm_walk_fwd_0" : "norm_idle_0");
        auto motion = animated->ID_Cycle_Safe(name);
        if (!motion.valid() && deadState) motion = animated->ID_Cycle_Safe("norm_dead_stop_0");
        if (!motion.valid() && deadState) motion = animated->ID_Cycle_Safe("death_init");
        if (!motion.valid() && crouched && !deadState) motion = animated->ID_Cycle_Safe("cr_idle_1");
        if (!motion.valid()) return;
        if (deadState || wasDead) {
            animated->PlayCycle(BI_NONE, motion, FALSE);
            if (deadState) for (unsigned part = 0; part < MAX_PARTS; ++part)
                for (unsigned i = 0; i < animated->LL_PartBlendsCount(part); ++i) {
                    auto* blend = animated->LL_PartBlend(part, i);
                    blend->stop_at_end = true;
                    blend->fall_at_end = false;
                }
        } else animated->PlayCycle(motion, TRUE);
    }
    void updateEquipmentPose() {
        helmetPose = weaponPose = false;
        if (!helmet && !weapon) return;
        auto* bones = renderable.visual->dcast_PKinematics();
        if (!bones) return;
        if (helmet && head != BI_NONE) {
            // The stock helmet is a world mesh. Keep it upright at the head anchor.
            helmetTransform = renderable.xform;
            renderable.xform.transform_tiny(helmetTransform.c, bones->LL_GetTransform(head).c);
            helmetPose = true;
        }
        const auto support = oneHand ? finger : left;
        if (!weapon || right == BI_NONE || support == BI_NONE) return;
        // Match CWeapon::UpdateXForm's hand basis and authored model offset.
        const auto& grip = bones->LL_GetTransform(right);
        Fvector forward, side, up;
        forward.sub(bones->LL_GetTransform(support).c, grip.c);
        if (fis_zero(forward.magnitude())) return;
        forward.normalize();
        side.crossproduct(grip.j, forward);
        if (fis_zero(side.magnitude())) return;
        up.crossproduct(forward, side).normalize();
        Fmatrix transform;
        transform.set(side, up, forward, grip.c);
        transform.mulA_43(renderable.xform);
        weaponTransform.mul_43(transform, weaponOffset);
        weaponPose = true;
    }
    bool registered = false, walking = false, crouched=false, deadState=false;
    IRenderVisual* helmet = nullptr;
    IRenderVisual* weapon = nullptr;
    std::string outfitSection, helmetSection, weaponSection, npcModel;
    std::uint8_t weaponAddons = 0;
    std::uint32_t npcMotion = noMotion;
    std::uint16_t npcTimeMs = 0;
    u16 head = BI_NONE, left = BI_NONE, right = BI_NONE, finger = BI_NONE;
    bool oneHand = false, helmetPose = false, weaponPose = false;
    s32 animationSlot = 0;
    std::optional<bool> knifeStab;
    float firingTime = 0.f, shotDuration = 0.f;
    Fmatrix helmetTransform{}, weaponTransform{}, weaponOffset{};
    Fvector from{}, target{};
    float fromYaw = 0, targetYaw = 0, currentYaw = 0, elapsed = 0;
};
class GrenadeVisual final : public SpatialBase, public RenderableBase {
public:
    GrenadeVisual(std::uint32_t id, const char* section, const Fvector& position)
        : SpatialBase(g_pGamePersistent->SpatialSpace) {
        renderable.visual = equipmentVisual(section, "visual");
        renderable.xform.identity();
        renderable.xform.c = target = position;
        spatial.type = STYPE_RENDERABLE;
        spatial.sphere.set(position, 0.3f);
        if (renderable.visual) {
            spatial_register();
            if (strstr(Core.Params, "-zone-projectile-probe")) {
                renderProbe = id;
                Msg("* Zone projectile model: %u %s %s", id, section, pSettings->r_string(section, "visual"));
            }
        }
    }
    ~GrenadeVisual() override { if (renderable.visual) spatial_unregister(); }
    IRenderable* dcast_Renderable() override { return this; }
    void update(const Fvector& position) { target = position; }
    void advance(float dt) {
        if (!renderable.visual) return;
        Fvector position;
        position.lerp(renderable.xform.c, target, std::min(1.f, 12.f * dt));
        renderable.xform.c = spatial.sphere.P = position;
        spatial_move();
    }
    void renderable_Render(::u32 context, IRenderable* root) override {
        if (!renderable.visual) return;
        if (auto* bones = renderable.visual->dcast_PKinematics()) bones->CalculateBones(TRUE);
        GEnv.Render->add_Visual(context, root, renderable.visual, renderable.xform);
        if (renderProbe) {
            Msg("* Zone projectile drawn: %u", renderProbe);
            renderProbe = 0;
        }
    }
private:
    Fvector target{};
    std::uint32_t renderProbe = 0;
};
class MapPreview final : public CLevel {
    std::map<std::uint32_t, std::unique_ptr<Proxy>> proxies;
    std::map<std::uint32_t, std::unique_ptr<GrenadeVisual>> flyingGrenades;
    AppearanceState appearance;
    std::vector<unsigned char> appearanceBytes = std::vector<unsigned char>(maxAppearanceBytes);
    std::unique_ptr<InventoryPresentation> inventoryPresentation;
    std::map<std::string, std::unique_ptr<Proxy>> corpses;
    std::map<std::string, HUD_SOUND_COLLECTION_LAYERED> detonationSounds;
    std::map<std::pair<std::string, unsigned>, HUD_SOUND_COLLECTION_LAYERED> gunshotSounds;
    DetectorHint detectorHint{};
    std::vector<TimedParticle> detonationParticles;
    std::vector<BlowoutLight> blowoutLights;
    float detonationCredit = DetonationCapacity;
    float gunshotCredit = GunshotCapacity;
    std::uint64_t corpseDiscoveryUpdates = 0;
    Fvector anchor{}, focus{};
    std::uint32_t applied = 0;
    float heading = 0, pitch=0;
    bool firstPerson=false, crosshair=false;
    bool triggerHeld=false;
    std::string primedThrow;
    std::string aimedItem;
    bool aimedLauncher = false;
    bool worldSpace=false, contentReady=false, contentError=false;
    bool hasFrame = false, forward = false, back = false, left = false, right = false, sprint=false, jump=false, crouch=false;
    bool walk = false;
    float floor(float x, float z) {
        const auto& bounds = ObjectSpace.GetBoundingVolume();
        Fvector start;start.set(x, bounds.vMax.y + 10.f, z);
        Fvector down;down.set(0, -1, 0);
        collide::rq_result hit;
        return ObjectSpace.RayPick(start, down, bounds.vMax.y - bounds.vMin.y + 20.f,
            collide::rqtStatic, hit, nullptr) ? start.y - hit.range : bounds.vMin.y;
    }
    Fvector projectWorld(const std::array<float, 3>& p) {
        Fvector position;
        position.set(worldSpace ? p[0] : anchor.x + p[0], p[1], worldSpace ? p[2] : anchor.z + p[2]);
        if (!worldSpace) position.y = floor(position.x, position.z);
        position.y += 0.05f;
        return position;
    }
    bool startBlowoutLight(const char* section, Fvector position) {
        if (blowoutLights.size() >= DetonationCapacity || !pSettings->r_bool(section, "blowout_light"))
            return false;
        const float duration = pSettings->r_float(section, "light_time");
        const float range = pSettings->r_float(section, "light_range");
        if (!(duration > 0.f && duration <= 30.f && range > 0.f && std::isfinite(range)))
            return false;
        const Fvector color = pSettings->r_fvector3(section, "light_color");
        position.y += pSettings->r_float(section, "light_height");
        ref_light light = GEnv.Render->light_create();
        light->set_shadow(true);
        light->set_position(position);
        light->set_color(color.x, color.y, color.z);
        light->set_range(range);
        light->set_active(true);
        blowoutLights.push_back({light, color, range, duration, duration});
        return true;
    }
    void playDetonations() {
        for (auto& flash : blowoutLights) {
            flash.remaining -= Device.fTimeDelta;
            if (flash.remaining <= 0.f) continue;
            // Same brightness and radius falloff as CCustomZone::UpdateBlowoutLight.
            const float scale = std::pow(flash.remaining / flash.duration + EPS_L, 0.15f);
            flash.light->set_color(flash.color.x * scale, flash.color.y * scale, flash.color.z * scale);
            flash.light->set_range(flash.range * scale);
        }
        blowoutLights.erase(std::remove_if(blowoutLights.begin(), blowoutLights.end(),
            [](const auto& flash) { return flash.remaining <= 0.f; }), blowoutLights.end());
        for (auto& effect : detonationParticles) effect.remaining -= Device.fTimeDelta;
        detonationParticles.erase(std::remove_if(detonationParticles.begin(), detonationParticles.end(),
            [](const auto& effect) { return effect.remaining <= 0.f; }), detonationParticles.end());
        DetonationEffect effects[DetonationCapacity];
        const auto count = std::min(zone_detonations(effects, DetonationCapacity), DetonationCapacity);
        // A busy fight can generate effects faster than their particles expire.
        detonationCredit = std::min(float(DetonationCapacity), detonationCredit + 4.f * Device.fTimeDelta);
        for (unsigned i = 0; i < count && detonationCredit >= 1.f; ++i) {
            const auto& [coordinates, section] = effects[i];
            if (!pSettings->line_exist(section, "class")) continue;
            const auto cls = pSettings->r_clsid(section, "class");
            const std::string_view name(section);
            const bool electra = cls == xray::make_clsid("ZS_MBALD") &&
                (name == "zone_mine_electric_weak" || name == "zone_mine_electric_average" || name == "zone_mine_electric_strong");
            if (!electra && cls != CLSID_OBJECT_G_FAKE && !handGrenadeClass(cls)) continue;
            detonationCredit -= 1.f;
            Fvector position;
            position.set(coordinates[0], coordinates[1], coordinates[2]);
            const auto* particleKey = electra ? "blowout_particles" : "explode_particles";
            const char* startedParticles = nullptr;
            if (pSettings->line_exist(section, particleKey)) {
                const char* name = pSettings->r_string(section, particleKey);
                auto* particles = CParticlesObject::Create(name, FALSE);
                if (particles->IsLooped()) {
                    const float duration = pSettings->read_if_exists<float>(section, "explode_duration", 0.f);
                    std::unique_ptr<CParticlesObject, ParticleDeleter> lifetime(particles);
                    if (duration > 0.f && duration <= 30.f && detonationParticles.size() < 24) {
                        particles->play_at_pos(position);
                        detonationParticles.push_back({std::move(lifetime), duration});
                        startedParticles = name;
                    }
                } else {
                    particles->SetAutoRemove(true);
                    particles->play_at_pos(position);
                    startedParticles = name;
                }
            }
            const auto [sound, inserted] = detonationSounds.try_emplace(section);
            if (inserted)
                sound->second.LoadSound(section, electra ? "blowout_sound" : "snd_explode", "detonation", false, SOUND_TYPE_WEAPON_SHOOTING);
            const bool played = sound->second.PlayOneShot("detonation", position);
            const bool lit = electra && startBlowoutLight(section, position);
            if (strstr(Core.Params, "-zone-projectile-probe"))
                Msg("* Zone detonation: %s particles=%s positional_sound=%d light=%d at [%.3f,%.3f,%.3f]",
                    section, startedParticles ? startedParticles : "none", played, lit, position.x, position.y, position.z);
        }
    }

    void playGunshots(std::uint32_t localPlayer) {
        GunshotEffect effects[GunshotCapacity];
        const auto count = std::min(zone_gunshots(effects, GunshotCapacity), GunshotCapacity);
        gunshotCredit = std::min(float(GunshotCapacity), gunshotCredit + 24.f * Device.fTimeDelta);
        for (unsigned i = 0; i < count && gunshotCredit >= 1.f; ++i) {
            const auto& [coordinates, mode, shooter, section] = effects[i];
            const bool knife = mode == KnifeSlash || mode == KnifeStab;
            if ((!knife && mode > 2) || !pSettings->line_exist(section, "snd_shoot")) continue;
            const auto [sound, inserted] = gunshotSounds.try_emplace(std::make_pair(std::string(section), mode));
            if (inserted) {
                const auto* key = mode == 2 ? "snd_shoot_grenade" : "snd_shoot";
                if (mode == 1 && pSettings->line_exist(section, "snd_silncer_shot"))
                    key = "snd_silncer_shot";
                sound->second.LoadSound(section, key, "gunshot", false, SOUND_TYPE_WEAPON_SHOOTING);
            }
            Fvector position;
            position.set(coordinates[0], coordinates[1], coordinates[2]);
            const bool hudSound = knife && firstPerson && shooter == localPlayer;
            const bool played = sound->second.PlayOneShot("gunshot", position, hudSound);
            if (knife && strstr(Core.Params, "-zone-observer-shot-probe"))
                Msg("* Zone knife sound: shooter=%u mode=%u positional=%d played=%d", shooter, mode, !hudSound, played);
            if (auto proxy = proxies.find(shooter); proxy != proxies.end())
                proxy->second->playConfirmedShot(effects[i], position);
            gunshotCredit -= 1.f;
        }
    }

    void updateFlyingGrenades() {
        GrenadeFrame records[GrenadeCapacity];
        const int count = zone_grenades_poll(records, GrenadeCapacity);
        if (count >= 0 && static_cast<unsigned>(count) <= GrenadeCapacity) {
            for (auto it = flyingGrenades.begin(); it != flyingGrenades.end();) {
                if (std::none_of(records, records + count, [id=it->first](const auto& record){return record.id == id;}))
                    it = flyingGrenades.erase(it);
                else ++it;
            }
            for (int i = 0; i < count; ++i) {
                const auto& record = records[i];
                Fvector position;position.set(record.position[0], record.position[1], record.position[2]);
                auto& visual = flyingGrenades[record.id];
                if (visual) visual->update(position);
                else visual = std::make_unique<GrenadeVisual>(record.id, record.section, position);
            }
        }
        for (const auto& entry : flyingGrenades) entry.second->advance(Device.fTimeDelta);
    }
    void updateCorpses(const SnapshotState& frame) {
        const auto& discovery = worldItems();
        const auto& carried = inventory();
        if (!discovery.state.valid || !carried.valid || !carried.alive || carried.life != discovery.state.life) {
            corpses.clear();
            corpseDiscoveryUpdates = 0;
            return;
        }
        if (corpseDiscoveryUpdates != discovery.updates) {
            std::map<std::string, std::unique_ptr<Proxy>> next;
            for (const auto& body : discovery.corpses) {
                auto existing = corpses.find(body.source);
                if (existing != corpses.end()) {
                    next.emplace(body.source, std::move(existing->second));
                    continue;
                }
                auto proxy = std::make_unique<Proxy>();
                proxy->pose(projectWorld(body.position), 0.f, false, false, true);
                next.emplace(body.source, std::move(proxy));
            }
            corpses = std::move(next);
            corpseDiscoveryUpdates = discovery.updates;
        }
        // The player replica already renders the body before respawn.
        for (auto& entry : corpses) {
            auto& proxy = *entry.second;
            proxy.advance(Device.fTimeDelta);
            proxy.visible = true;
            for (const auto& entity : frame.entities) {
                if (entity.health != 0 || (firstPerson && entity.id == frame.playerId)) continue;
                const auto liveProxy = proxies.find(entity.id);
                if (liveProxy != proxies.end() &&
                    liveProxy->second->renderable.xform.c.distance_to_sqr(proxy.renderable.xform.c) < 0.09f) {
                    proxy.visible = false;
                    break;
                }
            }
        }
    }
    void updateInput() {
        if (!hasFrame) return;
        float x = float(right)-float(left), z = float(forward)-float(back);
        if(firstPerson){const float side=x,front=z;x=side*std::cos(heading)+front*std::sin(heading);z=front*std::cos(heading)-side*std::sin(heading);}
        else if(x||z)heading=std::atan2(x,z);
        const float scale=std::max(1.f,std::sqrt(x*x+z*z));
        const bool aiming = !aimedItem.empty();
        zone_map_input(x/scale,z/scale,heading,pitch,sprint && !aiming,jump && !aiming,
            crouch,walk || (aiming && !crouch),aiming);
    }
    void fire() {
        const auto& frame = snapshot();
        if (!worldSpace || !contentReady || !frame.valid) return;
        if (const auto* knife = inventoryPresentation ? inventoryPresentation->equippedKnife() : nullptr) {
            zone_knife(false, frame.tick, heading, pitch, knife->id.c_str());
            return;
        }
        if (const auto* throwable = inventoryPresentation ? inventoryPresentation->equippedThrowable() : nullptr) {
            if (primedThrow.empty()) zone_weapon_fire(frame.tick, heading, pitch, throwable->id.c_str());
            return;
        }
        const auto* weapon = inventoryPresentation ? inventoryPresentation->equippedWeapon() : nullptr;
        if (inventory().valid && !weapon) return;
        if (!weapon) {zone_weapon_fire(frame.tick, heading, pitch, nullptr);return;}
        if (weapon->launcherMode) {
            if (weapon->launcherCartridges.empty())
                inventoryPresentation->equippedWeaponAction(InventoryReload);
            else
                zone_weapon_fire(frame.tick, heading, pitch, weapon->id.c_str());
            return;
        }
        if (!triggerHeld) {
            triggerHeld = true;
            zone_weapon_trigger_start(frame.tick, heading, pitch, weapon->id.c_str());
        }
    }
    void finishThrow(unsigned phase) {
        if (primedThrow.empty()) return;
        zone_grenade(phase, snapshot().tick, heading, pitch, primedThrow.c_str());
        primedThrow.clear();
    }
    void stopAim() {
        if (aimedItem.empty()) return;
        aimedItem.clear();
        updateInput();
    }
    void alternateFire(bool down) {
        if (!down) {
            finishThrow(1);
            if (!b_toggle_weapon_aim) stopAim();
            return;
        }
        const auto& frame = snapshot();
        if (!firstPerson || !worldSpace || !contentReady || !frame.valid || !primedThrow.empty()) return;
        if (const auto* knife = inventoryPresentation ? inventoryPresentation->equippedKnife() : nullptr) {
            zone_knife(true, frame.tick, heading, pitch, knife->id.c_str());
            return;
        }
        if (const auto* throwable = inventoryPresentation ? inventoryPresentation->equippedThrowable() : nullptr) {
            primedThrow = throwable->id;
            zone_grenade(0, frame.tick, heading, pitch, primedThrow.c_str());
            return;
        }
        if (!aimedItem.empty()) {
            if (b_toggle_weapon_aim) stopAim();
            return;
        }
        const auto* equipped = inventoryPresentation ? inventoryPresentation->equippedWeapon() : nullptr;
        const auto* weapon = equipped ? inventoryPresentation->hudFirearm() : nullptr;
        if (weapon && weapon->IsZoomEnabled() && zone_aim_allowed(inventory().life)) {
            aimedItem = equipped->id;
            aimedLauncher = equipped->launcherMode;
            updateInput();
        }
    }
    void stopFire(bool cancelThrow = true) {
        if (triggerHeld) {
            triggerHeld = false;
            zone_weapon_trigger_stop();
        }
        if (cancelThrow) {
            finishThrow(2);
            stopAim();
        }
    }
    void input(int key, bool down) {
        const auto binding = GetBindedAction(key);
        if (inventoryPresentation) {
            if (down && binding == kINVENTORY) {
                stopFire();
                inventoryPresentation->toggle();
                forward=back=left=right=sprint=jump=crouch=walk=false;updateInput();return;
            }
            if (inventoryPresentation->menuOpen()) {
                if (down) CurrentGameUI()->IR_UIOnKeyboardPress(key);
                else CurrentGameUI()->IR_UIOnKeyboardRelease(key);
                return;
            }
        }
        if (binding == kWPN_ZOOM) {alternateFire(down);return;}
        if (down && binding == kUSE) {
            if (inventoryPresentation && !inventoryPresentation->pickup()) zone_use_travel();
            return;
        }
        if (down && inventoryPresentation) {
            if (binding == kDETECTOR) {
                stopFire(false);
                finishThrow(2);
                zone_toggle_detector(inventory().life);
                return;
            }
            if (binding >= kQUICK_USE_1 && binding <= kQUICK_USE_4) {
                inventoryPresentation->useQuickItem(binding - kQUICK_USE_1);
                return;
            }
            if (binding == kUSE_BANDAGE || binding == kUSE_MEDKIT) {
                inventoryPresentation->useQuickItem(binding == kUSE_BANDAGE ? 4 : 5);
                return;
            }
            if ((binding >= kWPN_1 && binding <= kWPN_4) || binding == kWPN_6) {
                stopFire();
                const auto slot = binding - kWPN_1 + 1;
                inventoryPresentation->selectWeaponSlot(slot);
                return;
            }
            if (binding == kWPN_RELOAD || binding == kWPN_NEXT) {
                stopFire();
                inventoryPresentation->equippedWeaponAction(binding == kWPN_RELOAD ? InventoryReload : InventoryNextAmmo);
                return;
            }
            if (binding == kWPN_FIREMODE_NEXT || binding == kWPN_FIREMODE_PREV) {
                stopFire();
                inventoryPresentation->equippedWeaponAction(InventoryFireMode,
                    binding == kWPN_FIREMODE_NEXT ? 1 : 0);
                return;
            }
            if (binding == kWPN_FUNC) {
                stopFire();
                if (const auto* weapon = inventoryPresentation->equippedWeapon())
                    inventoryPresentation->equippedWeaponAction(InventoryLauncherMode, !weapon->launcherMode);
                return;
            }
        }
        if (down && key == SDL_SCANCODE_J) {
            stopFire();
            firstPerson = !firstPerson;
            crosshair = firstPerson;
            zone_view(firstPerson, crosshair);
            return;
        }
        if (down && binding == kWPN_RELOAD && !inventory().valid) zone_reload();
        if (down && key == SDL_SCANCODE_RETURN) zone_respawn();
        switch (binding) {
        case kFWD: forward = down; break;
        case kBACK: back = down; break;
        case kL_STRAFE: left = down; break;
        case kR_STRAFE: right = down; break;
        case kACCEL: walk = down; break;
        case kSPRINT_TOGGLE: if (down) sprint = !sprint; break;
        case kJUMP: jump = down; break;
        case kCROUCH:
            if (!psActorFlags.test(AF_CROUCH_TOGGLE)) { crouch = down; break; }
            [[fallthrough]];
        case kCROUCH_TOGGLE: if (down) crouch = !crouch; break;
        default: return;
        }
        if (!forward || back || left || right || walk || crouch) sprint = false;
        updateInput();
    }
public:
    bool net_Start(const char* serverOptions, const char*) override {
        const std::string_view options(serverOptions);
        const std::string level(options.substr(0, options.find('/')));
        const int id = g_pGamePersistent->Level_ID(level.c_str(), "1.0", true);
        R_ASSERT2(id >= 0, level.c_str());
        map_data.m_name = level.c_str();
        R_ASSERT(IGame_Level::Load(id));
        worldSpace = zone_world_space()!=0;
        if (worldSpace) {
            IReader* geometry=FS.r_open("$level$","level.cform");
            R_ASSERT2(geometry,"Missing campaign collision asset");
            zone_verify_asset(0,geometry->pointer(),geometry->length());FS.r_close(geometry);
            IReader* materials=FS.r_open("$game_data$","gamemtl.xr");
            R_ASSERT2(materials,"Missing game materials");
            zone_verify_asset(1,materials->pointer(),materials->length());FS.r_close(materials);
        }
        GEnv.Render->DeferredLoad(FALSE);
        GEnv.Render->ResourcesDeferredUpload();
        const auto& bounds = ObjectSpace.GetBoundingVolume();
        anchor.add(bounds.vMin, bounds.vMax).mul(0.5f);anchor.y = floor(anchor.x, anchor.z);
        focus = anchor;
        g_pGamePersistent->Environment().SetGameTime(12.f * 3600.f, 1.f);
        Msg("* Zone map preview: %s loaded, anchor [%f,%f,%f], no local gameplay", level.c_str(), anchor.x, anchor.y, anchor.z);
        return true;
    }
    bool Load_GameSpecific_Before() override {return true;}
    void net_Stop() override {stopFire();inventoryPresentation.reset();proxies.clear();flyingGrenades.clear();appearance.clear();corpses.clear();detonationParticles.clear();blowoutLights.clear();detonationSounds.clear();gunshotSounds.clear();IGame_Level::net_Stop();}
    void OnFrame() override {
        if(worldSpace && !contentReady) {
            const int status=zone_content_status();
            if(status!=1) {if(status<0 && !contentError){Msg("! Zone content verification failed; actors disabled");contentError=true;}return;}
            contentReady=true;Msg("* Zone content verified: authoritative world coordinates enabled");
        }
        const auto& frame = snapshot();
        if (!frame.valid) {stopFire();inventoryPresentation.reset();proxies.clear();flyingGrenades.clear();appearance.clear();corpses.clear();detonationParticles.clear();blowoutLights.clear();corpseDiscoveryUpdates = 0;hasFrame = false;return;}
        const auto appearanceSize = zone_appearance_poll(appearanceBytes.data(), appearanceBytes.size());
        if (appearanceSize > 0 && appearance.apply(appearanceBytes.data(), appearanceSize)) {
            for (auto& entry : proxies) entry.second->setAppearance(appearance.get(entry.first));
        }
        if (!hasFrame || applied != frame.tick) {
            std::map<std::uint32_t, bool> present;
            for (const auto& entity : frame.entities) {
                const auto& look = appearance.get(entity.id);
                if (entity.kind == 2 && look.visual.empty() && !proxies.count(entity.id)) continue;
                present[entity.id] = true;
                auto& proxy = proxies[entity.id];
                if (!proxy) {
                    proxy = std::make_unique<Proxy>(look.visual);
                    proxy->setAppearance(look);
                    Msg("* Zone proxy spawned: %u", entity.id);
                }
                Fvector position;position.set(worldSpace?entity.x:anchor.x+entity.x, entity.y, worldSpace?entity.z:anchor.z+entity.z);
                // Visual ground projection only. Rust still simulates a flat test
                // world; this must not be mistaken for server-side map collision.
                if(!worldSpace)position.y = floor(position.x, position.z);
                proxy->pose(position, entity.yaw, entity.vx * entity.vx + entity.vz * entity.vz > 0.01f, (entity.flags & 4)!=0, entity.health==0);
                if (entity.kind == 2) proxy->applyNpcMotion(entity.motion, entity.motionTimeMs);
                if (entity.id == frame.playerId) {
                    focus = position;
                    if (!hasFrame) {
                        heading = std::remainder(entity.yaw, 6.2831853f);
                        pitch = 0;
                        crouch = (entity.flags & 4) != 0;
                    }
                }
            }
            for (auto i = proxies.begin(); i != proxies.end();) {
                if (!present.count(i->first)) {Msg("* Zone proxy removed: %u", i->first);i = proxies.erase(i);}else ++i;
            }
            const bool firstFrame = !hasFrame;
            applied = frame.tick;hasFrame = true;
            if (firstFrame) updateInput();
        }
        for (auto& entry : proxies) {entry.second->visible=!firstPerson||entry.first!=frame.playerId;entry.second->advance(Device.fTimeDelta);}
        if (auto local = proxies.find(frame.playerId); local != proxies.end()) {
            float predicted[4];
            if(worldSpace && zone_prediction(predicted)) {
                Fvector position;position.set(predicted[0],predicted[1],predicted[2]);
                local->second->predicted(position,predicted[3]);
            }
            focus = local->second->renderable.xform.c;
        }
        if (inventory().valid) {
            if (!inventoryPresentation) inventoryPresentation=std::make_unique<InventoryPresentation>(*this);
            float health=0.f;for(const auto& entity:frame.entities)if(entity.id==frame.playerId)health=float(entity.health)/100.f;
            inventoryPresentation->update(focus,health);
            if (!aimedItem.empty()) {
                const auto* equipped = inventoryPresentation->equippedWeapon();
                if (!equipped || equipped->id != aimedItem || equipped->launcherMode != aimedLauncher
                    || inventoryPresentation->menuOpen() || !zone_aim_allowed(inventory().life))
                    stopAim();
            }
            inventoryPresentation->setWeaponAim(!aimedItem.empty());
        }
        auto* weapon = inventoryPresentation ? inventoryPresentation->hudFirearm() : nullptr;
        const bool aiming = firstPerson && weapon && weapon->IsZoomed();
        const bool showCrosshair = firstPerson && (!aiming || !weapon->ZoomHideCrosshair());
        if (crosshair != showCrosshair) {
            crosshair = showCrosshair;
            zone_view(firstPerson, crosshair);
        }
        Fvector camera = focus,direction;
        if(firstPerson) {
            bool low=false;for(const auto& entity:frame.entities)if(entity.id==frame.playerId){low=(entity.flags&4)!=0;break;}
            camera.y+=low?0.95f:1.55f;
            direction.set(std::sin(heading)*std::cos(pitch),std::sin(pitch),std::cos(heading)*std::cos(pitch));
        } else {
            camera.y+=6.f;camera.z-=12.f;
            Fvector target=focus;target.y+=1.f;direction.sub(target,camera).normalize();
        }
        const float fov = aiming && (!weapon->ZoomTexture() || !weapon->IsRotatingToZoom())
            ? weapon->GetZoomFactor() * 0.75f : g_fov;
        Cameras().Update(camera, direction, Fvector().set(0, 1, 0), fov, 1.f, 500.f, 0);
        Cameras().ApplyDevice();
        if (worldSpace && contentReady) {
            updateFlyingGrenades();
            playDetonations();
            playGunshots(frame.playerId);
        }
        if (inventory().valid) {
            if (!primedThrow.empty()) {
                const auto* equipped = inventoryPresentation->equippedThrowable();
                if (!equipped || equipped->id != primedThrow) finishThrow(2);
            }
            Fmatrix hudCamera;
            Cameras().camera_Matrix(hudCamera);
            inventoryPresentation->updateWorld([this](const std::array<float,3>& p) {return projectWorld(p);},firstPerson);
            const bool detecting = firstPerson && inventory().alive && !inventoryPresentation->menuOpen()
                && zone_detector_hint(inventory().life, &detectorHint, aiming);
            inventoryPresentation->updateWeaponHud(hudCamera, firstPerson, detecting ? &detectorHint : nullptr);
        }
        updateCorpses(frame);
    }
    void OnRender() override {
        GEnv.Render->BeforeWorldRender();IGame_Level::OnRender();GEnv.Render->AfterWorldRender();WorldRendered(true);
        // Match CLevel's post-world UI pass without invoking its local gameplay
        // rendering (bullets and native game rules).
        if (inventoryPresentation && !Device.IsAnselActive) {
            HUD().RenderUI();
            auto* weapon = inventoryPresentation->hudFirearm();
            if (firstPerson && weapon && weapon->IsZoomed() && weapon->ZoomTexture() && !weapon->IsRotatingToZoom())
                weapon->render_item_ui();
        }
    }
    void IR_OnKeyboardPress(int key) override {input(key, true);}
    void IR_OnKeyboardRelease(int key) override {input(key, false);}
    void IR_OnKeyboardHold(int) override {}
    void IR_OnTextInput(pcstr) override {}
    void IR_OnMouseMove(int dx, int dy) override {
        if(inventoryPresentation && inventoryPresentation->menuOpen()) {CurrentGameUI()->IR_UIOnMouseMove(dx,dy);return;}
        if(!firstPerson || !hasFrame)return;heading=std::remainder(heading+float(dx)*0.002f,6.2831853f);
        pitch=std::clamp(pitch-float(dy)*0.002f,-1.5f,1.5f);updateInput();
    }
    void IR_OnMousePress(int button) override {
        if(inventoryPresentation&&inventoryPresentation->menuOpen()){CurrentGameUI()->IR_UIOnKeyboardPress(button);return;}
        if(GetBindedAction(button)==kWPN_ZOOM)alternateFire(true);
        else if(button==MOUSE_1&&firstPerson)fire();
    }
    void IR_OnMouseRelease(int button) override {
        if (button==MOUSE_1) stopFire(false);
        if (GetBindedAction(button)==kWPN_ZOOM) alternateFire(false);
        if(inventoryPresentation&&inventoryPresentation->menuOpen())CurrentGameUI()->IR_UIOnKeyboardRelease(button);
    }
    void IR_OnMouseHold(int) override {}
    void IR_OnMouseWheel(float x, float y) override {if(inventoryPresentation&&inventoryPresentation->menuOpen())CurrentGameUI()->IR_UIOnMouseWheel(x,y);}
    // The map presenter has no native gameplay state for CLevel input handlers.
    void IR_OnControllerPress(int, const ControllerAxisState&) override {}
    void IR_OnControllerRelease(int, const ControllerAxisState&) override {}
    void IR_OnControllerHold(int, const ControllerAxisState&) override {}
    void IR_OnControllerAttitudeChange(Fvector) override {}
    void IR_OnActivate() override {}
    void IR_OnDeactivate() override {
        stopFire();
        if (inventoryPresentation) inventoryPresentation->cancelDeferredWeaponAction();
        forward = back = left = right = false;
        sprint = jump = crouch = walk = false;
        updateInput();
    }
};
}
IGame_Level* createMapPreview() {return xr_new<MapPreview>();}
bool mapPreviewEnabled() {return strstr(Core.Params, "-zone_map_preview") != nullptr;}
}
