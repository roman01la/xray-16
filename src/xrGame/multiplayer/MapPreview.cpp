#include "pch_script.h"
#include "EngineAdapter.h"
#include "NpcPresentation.h"
#include "xrCore/Animation/Bone.hpp"
#include "Appearance.h"
#include "Actor_Flags.h"
#include "Actor.h"
#include "CharacterPhysicsSupport.h"
#include "PHMovementControl.h"
#include "InventoryPresentation.h"
#include "InventoryIntent.h"
#include "Level.h"
#include "game_cl_base.h"
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
#include <deque>
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
EM_JS(unsigned, zone_native_sequence, (), {return globalThis.zoneNativeInputSequence?.() ?? 0;});
EM_JS(unsigned, zone_native_motion_flags, (), {return globalThis.zoneNativeMotionFlags?.() ?? 3;});
EM_JS(float, zone_native_motion_scale, (), {return globalThis.zoneNativeMotionScale?.() ?? 1;});
EM_JS(int, zone_world_space, (), {return globalThis.zoneEngineWorldSpace?.()?1:0;});
EM_JS(void, zone_verify_asset, (int kind, const void* pointer, unsigned size), {
    globalThis.zoneEngineVerifyAsset?.(kind,pointer,size);
});
EM_JS(int, zone_content_status, (), {return globalThis.zoneEngineContentStatus?.() ?? -1;});
EM_JS(unsigned, zone_npc_media_poll, (void* output, unsigned capacity), {
    return globalThis.zoneEngineNpcMediaPoll?.(output, capacity) ?? 0;
});
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
    enum class Gait { Idle, Walk, Run, Sprint };
    struct NpcPose {
        Fvector position;
        float yaw;
        double tick;
        std::uint32_t motion;
        std::uint16_t motionTimeMs;
        std::uint16_t health;
    };
    struct AuthoredPose {
        double tick;
        std::vector<unsigned char> bytes;
    };
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
                npcPoses.clear();
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
    void pose(const Fvector& position, float yaw, float speed, bool crouch, bool dead) {
        from = renderable.xform.c;target = position;fromYaw = currentYaw;targetYaw = yaw;elapsed = 0;
        if (!registered || from.distance_to_sqr(target) > 400.f) {from = target;fromYaw = targetYaw;}
        const auto nextGait = speed < 0.1f ? Gait::Idle
            : crouch || speed < 3.f ? Gait::Walk
            : speed < 5.f ? Gait::Run : Gait::Sprint;
        if (nextGait != gait || crouch != crouched || dead != deadState) {
            const bool wasDead=deadState;deadState=dead;
            crouched=crouch;
            gait = nextGait;
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
    void settleLootBody()
    {
        if (!renderable.visual) return;
        if (auto* animated = renderable.visual->dcast_PKinematicsAnimated())
            holdDeathPose(*animated, true);
    }
    void queueAuthoredPose(const unsigned char* bytes, std::size_t size, double tick)
    {
        if (!nativeNpc() || !renderable.visual || size < npcPoseHeader ||
            u32(bytes) != npcModelKey(npcModel) || bytes[4] > 1 || (bytes[7] & ~npcWeaponFlags))
            return;
        auto* skeleton = PKinematics(renderable.visual);
        const unsigned count = bytes[5], weaponLength = bytes[6];
        const auto expected = npcPoseHeader + npcBoneBytes * count +
            (weaponLength ? npcBoneBytes + weaponLength : 0) + (bytes[7] & npcShot ? npcShotBytes : 0);
        if (!skeleton || count != skeleton->LL_BoneCount() || !count || count > npcMaxBones ||
            weaponLength > 127 || size != expected || (!weaponLength && bytes[7]) ||
            (npcDeadConfirmed && bytes[4] == 0))
            return;
        const Fvector position{f32(bytes + 16), f32(bytes + 20), f32(bytes + 24)};
        if (!_valid(position) || (!authoredPoses.empty() && tick <= authoredPoses.back().tick))
            return;
        if (bytes[4] && !npcDeadConfirmed)
            npcDeadConfirmed = true;
        if (bytes[4] && !authoredPoses.empty() && authoredPoses.back().bytes[4] == 0)
            authoredPoses.clear();
        authoredPoses.push_back({tick, {bytes, bytes + size}});
        if (authoredPoses.size() > 6) authoredPoses.pop_front();
    }
    bool hasNativeBody() const { return nativeNpc() && deadState && authoredBodyReady; }
    void queueNpcPose(const Fvector& position, const Entity& entity, double tick) {
        if (!nativeNpc()) {
            pose(position, entity.yaw, std::hypot(entity.vx, entity.vz),
                (entity.flags & 4) != 0, entity.health == 0);
            return;
        }
        if (entity.health == 0) npcDeadConfirmed = true;
        // Death is authoritative immediately. Never replay an older live pose
        // after a zero-health snapshot or show a death animation on AOI entry.
        if (entity.health == 0 && !npcPoses.empty() && npcPoses.back().health != 0)
            npcPoses.clear();
        if (!npcPoses.empty()) {
            const auto& last = npcPoses.back();
            const float distance = last.position.distance_to_sqr(position);
            if (distance == 0.f && last.yaw == entity.yaw &&
                last.motion == entity.motion && last.motionTimeMs == entity.motionTimeMs && last.health == entity.health)
                return; // The relay can repeat the same native sample.
            if (distance > 400.f) npcPoses.clear();
        }
        npcPoses.push_back({position, entity.yaw, tick, entity.motion, entity.motionTimeMs, entity.health});
        if (npcPoses.size() > 8) npcPoses.pop_front();
    }
    void applyNpcMotion(std::uint32_t id, std::uint16_t timeMs) {
        if (!nativeNpc() || !renderable.visual || id == noMotion || (id == npcMotion && timeMs == npcTimeMs)) return;
        auto* animated = renderable.visual->dcast_PKinematicsAnimated();
        if (!animated) return;
        const MotionID motion(static_cast<u16>(id >> 16), static_cast<u16>(id));
        if (motion.slot >= animated->LL_MotionsSlotCount() || motion.idx >= animated->LL_MotionsSlot(motion.slot).motion_defs()->size()) return;
        const bool changed = id != npcMotion;
        if (changed) {
            animated->PlayCycle(BI_NONE, motion, FALSE);
            if (npcMotion == noMotion) Msg("* Zone NPC motion ready: %s", npcModel.c_str());
        }
        npcMotion = id;
        npcTimeMs = timeMs;
        for (::u32 part = 0; part < MAX_PARTS; ++part)
            for (::u32 i = 0; i < animated->LL_PartBlendsCount(part); ++i) {
                auto* blend = animated->LL_PartBlend(part, i);
                if (!blend || blend->channel != 0 || blend->motionID != motion || blend->timeTotal <= 0.f)
                    continue;
                const float phase = std::min(timeMs * .001f, blend->timeTotal);
                if (changed) {
                    blend->timeCurrent = phase;
                } else if (blend->stop_at_end) {
                    blend->timeCurrent = std::min(blend->timeCurrent + 0.03f,
                        std::max(blend->timeCurrent, phase));
                } else {
                    const float error = std::remainder(phase - blend->timeCurrent, blend->timeTotal);
                    blend->timeCurrent = std::clamp(blend->timeCurrent +
                        std::clamp(error * 0.25f, -0.03f, 0.03f), 0.f, blend->timeTotal);
                }
            }
    }
    void advance(float dt, double npcTick = 0.) {
        if (!renderable.visual) return;
        if (firingTime > 0.f) {
            firingTime = std::max(0.f, firingTime - dt);
            if (firingTime == 0.f) {
                finishKnifeMotion();
                animateTorso();
            }
        }
        elapsed += dt;
        if (!authoredPoses.empty()) {
            advanceAuthoredPose(npcTick);
            return;
        }
        Fvector position;
        if (npcPoses.empty()) {
            const float blend = std::min(1.f, elapsed * 15.f);
            position.lerp(from, target, blend);
            currentYaw = fromYaw + std::remainder(targetYaw - fromYaw, 6.2831853f) * blend;
        } else {
            while (npcPoses.size() > 1 && npcPoses[1].tick <= npcTick) npcPoses.pop_front();
            const auto& start = npcPoses.front();
            const auto& end = npcPoses.size() > 1 ? npcPoses[1] : start;
            const float blend = end.tick > start.tick
                ? static_cast<float>(std::clamp((npcTick - start.tick) / (end.tick - start.tick), 0., 1.))
                : 0.f;
            position.lerp(start.position, end.position, blend);
            currentYaw = start.yaw + std::remainder(end.yaw - start.yaw, 6.2831853f) * blend;
            deadState = start.health == 0;
            if (!deadState) {
                npcHitTime = std::max(0.f, npcHitTime - dt);
                if (npcHitTime == 0.f) applyNpcMotion(start.motion, start.motionTimeMs);
                if (npcHealth && start.health < *npcHealth) playNpcHit();
            }
            npcHealth = start.health;
        }
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
        if (nativeNpc() && ((npcDeadConfirmed && !authoredBodyReady) ||
            (authoredPoses.empty() && npcMotion == noMotion && npcHitTime <= 0.f)))
            return;
        if (auto* bones = renderable.visual->dcast_PKinematics()) bones->CalculateBones(TRUE);
        GEnv.Render->add_Visual(context, root, renderable.visual, renderable.xform);
        if (helmetPose) GEnv.Render->add_Visual(context, root, helmet, helmetTransform);
        if (weaponPose && !deadState) GEnv.Render->add_Visual(context, root, weapon, weaponTransform);
    }
private:
    void advanceAuthoredPose(double tick)
    {
        while (authoredPoses.size() > 1 && authoredPoses[1].tick <= tick)
            authoredPoses.pop_front();
        const auto& start = authoredPoses.front();
        const auto& end = authoredPoses.size() > 1 ? authoredPoses[1] : start;
        const auto* a = start.bytes.data();
        const auto* b = end.bytes.data();
        const float blend = end.tick > start.tick
            ? static_cast<float>(std::clamp((tick - start.tick) / (end.tick - start.tick), 0., 1.))
            : 0.f;
        auto* skeleton = PKinematics(renderable.visual);
        if (!skeleton) return;
        const auto mix = [blend](const Fmatrix& from, const Fmatrix& to) {
            Fquaternion first, second, rotation;
            rotation.slerp(first.set(from), second.set(to), blend);
            Fmatrix result;
            result.rotation(rotation);
            result.c.lerp(from.c, to.c, blend);
            return result;
        };
        const auto root = [](const unsigned char* p) {
            Fmatrix result;
            result.rotation(readNpcRotation(p + 28));
            result.c.set(f32(p + 16), f32(p + 20), f32(p + 24));
            return result;
        };
        const auto mask = std::uint64_t(u32(a + 8)) | (std::uint64_t(u32(a + 12)) << 32);
        const auto nextMask = std::uint64_t(u32(b + 8)) | (std::uint64_t(u32(b + 12)) << 32);
        for (u16 bone = 0; bone < a[5]; ++bone) {
            if (!(mask & (std::uint64_t{1} << bone))) continue;
            const auto offset = npcPoseHeader + bone * npcBoneBytes;
            auto& pose = authoredBones[bone];
            pose = readNpcBone(a + offset);
            if (blend > 0.f && (nextMask & (std::uint64_t{1} << bone)))
                pose = mix(pose, readNpcBone(b + offset));
            if (!authoredCallbacks[bone]) {
                skeleton->LL_GetBoneInstance(bone).set_callback(bctCustom,
                    [](CBoneInstance* instance) {
                        instance->mTransform.set(*static_cast<const Fmatrix*>(instance->callback_param()));
                    }, &pose, TRUE);
                authoredCallbacks[bone] = true;
            }
        }
        if (skeleton->LL_GetBonesVisible() != mask) skeleton->LL_SetBonesVisible(mask);
        renderable.xform = mix(root(a), root(b));
        deadState = a[4] != 0;
        authoredBodyReady = deadState;
        const auto weaponAt = npcPoseHeader + a[5] * npcBoneBytes;
        const auto* weaponSectionBytes = a + weaponAt + (a[6] ? npcBoneBytes : 0);
        const std::string_view section(reinterpret_cast<const char*>(weaponSectionBytes), a[6]);
        const bool weaponChanged = section != authoredWeapon;
        if (weaponChanged) {
            authoredWeapon = section;
            GEnv.Render->model_Delete(weapon);
            weapon = equipmentVisual(authoredWeapon, "visual");
        }
        const auto addons = a[7] & (npcScope | npcLauncher | npcSilencer);
        if (weaponChanged || addons != weaponAddons) {
            weaponAddons = addons;
            updateWeaponAddonBones();
        }
        weaponPose = weapon && !deadState;
        if (weaponPose) {
            auto attachment = readNpcBone(a + weaponAt);
            if (a[6] == b[6] && blend > 0.f &&
                std::memcmp(a + weaponAt + npcBoneBytes, b + weaponAt + npcBoneBytes, a[6]) == 0)
                attachment = mix(attachment, readNpcBone(b + weaponAt));
            weaponTransform.mul_43(renderable.xform, attachment);
            if (a[7] & npcShot)
                playAuthoredShot(weaponSectionBytes + a[6], root(a), a[7]);
        }
        skeleton->CalculateBones_Invalidate();
        skeleton->CalculateBones(TRUE);
        spatial.sphere.P = renderable.xform.c;
        spatial.sphere.P.y += 1.f;
        if (!registered) {spatial_register();registered = true;} else spatial_move();
    }
    void playAuthoredShot(const unsigned char* shot, const Fmatrix& shotRoot, unsigned flags)
    {
        const auto time = u32(shot);
        if (time == authoredShot) return;
        authoredShot = time;
        Fmatrix muzzle;
        muzzle.mul_43(shotRoot, readNpcBone(shot + 4));
        const auto* const section = authoredWeapon.c_str();
        const bool launcher = (flags & npcShotLauncher) != 0;
        const bool silenced = (flags & npcSilencer) != 0;
        const auto* flame = pSettings->read_if_exists<pcstr>(section, launcher ? "grenade_flame_particles" :
            silenced ? "silencer_flame_particles" : "flame_particles", nullptr);
        const auto* smoke = launcher ? nullptr : pSettings->read_if_exists<pcstr>(section,
            silenced ? "silencer_smoke_particles" : "smoke_particles", nullptr);
        playMuzzleParticle(flame, muzzle);
        playMuzzleParticle(smoke, muzzle);
    }
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
    void playNpcHit() {
        auto* animated = renderable.visual->dcast_PKinematicsAnimated();
        if (!animated) return;
        if (animated->PlayFX_Safe("norm_damage_0", 1.f)) return;
        const auto motion = animated->ID_Cycle_Safe("norm_damage_0");
        if (!motion.valid()) return;
        animated->PlayCycle(BI_NONE, motion, FALSE);
        npcHitTime = animated->get_animation_length(motion);
        npcMotion = noMotion;
    }
    static void holdDeathPose(IKinematicsAnimated& animated, bool settled = false) {
        for (unsigned part = 0; part < MAX_PARTS; ++part)
            for (unsigned i = 0; i < animated.LL_PartBlendsCount(part); ++i) {
                auto* blend = animated.LL_PartBlend(part, i);
                blend->stop_at_end = true;
                blend->fall_at_end = false;
                if (settled) {
                    blend->timeCurrent = std::max(0.f, blend->timeTotal - 1.f / 30.f);
                    blend->playing = false;
                }
            }
    }
    void loadNpcModel() {
        GEnv.Render->model_Delete(renderable.visual);
        renderable.visual = nativeNpc() ? loadProxyVisual(npcModel.c_str()) : GEnv.Render->model_Create(DefaultProxyVisual);
        npcMotion = noMotion;
        npcHealth.reset();
        npcHitTime = 0.f;
        deadState = npcDeadConfirmed = authoredBodyReady = false;
        authoredPoses.clear();
        authoredCallbacks.fill(false);
        authoredWeapon.clear();
        authoredShot = 0;
        GEnv.Render->model_Delete(weapon);
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
        if (firing && knifeStab && gait == Gait::Idle) {
            xr_sprintf(name, "%s_all_%d_attack_%d", posture, animationSlot, *knifeStab ? 1 : 0);
            motion = animated->ID_Cycle_Safe(name);
        }
        const bool wholeBody = motion.valid();
        if (!wholeBody) {
            const bool slash = knifeStab && !*knifeStab;
            const auto* cycle = firing ? (slash ? "attack_0" : "attack_1")
                : animationSlot ? (gait != Gait::Idle ? "aim_2" : "aim_1") : "aim_0";
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
        const auto* name = deadState ? "norm_death_0"
            : crouched ? (gait == Gait::Idle ? "cr_idle_0" : "cr_walk_fwd_0")
            : gait == Gait::Sprint ? "norm_escape_00"
            : gait == Gait::Run ? "norm_run_fwd_0"
            : gait == Gait::Walk ? "norm_walk_fwd_0" : "norm_idle_0";
        auto motion = animated->ID_Cycle_Safe(name);
        if (!motion.valid() && deadState) motion = animated->ID_Cycle_Safe("norm_dead_stop_0");
        if (!motion.valid() && deadState) motion = animated->ID_Cycle_Safe("death_init");
        if (!motion.valid() && crouched && !deadState) motion = animated->ID_Cycle_Safe("cr_idle_1");
        if (!motion.valid() && !deadState && gait == Gait::Sprint) motion = animated->ID_Cycle_Safe("norm_run_fwd_0");
        if (!motion.valid() && !deadState && gait != Gait::Idle) motion = animated->ID_Cycle_Safe("norm_walk_fwd_0");
        if (!motion.valid()) return;
        if (deadState || wasDead) {
            animated->PlayCycle(BI_NONE, motion, FALSE);
            if (deadState) holdDeathPose(*animated);
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
    bool registered = false, crouched=false, deadState=false;
    Gait gait = Gait::Idle;
    std::deque<NpcPose> npcPoses;
    std::optional<std::uint16_t> npcHealth;
    float npcHitTime = 0.f;
    bool npcDeadConfirmed = false, authoredBodyReady = false;
    std::deque<AuthoredPose> authoredPoses;
    std::array<Fmatrix, npcMaxBones> authoredBones;
    std::array<bool, npcMaxBones> authoredCallbacks{};
    std::string authoredWeapon;
    std::uint32_t authoredShot = 0;
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
    std::map<std::string, std::uint32_t> corpseActors;
    std::map<std::uint32_t, std::unique_ptr<Proxy>> retiredNpcCorpses;
    std::array<unsigned char, 64 * (8 + 8 + npcPoseCapacity + 8 + 151) + 8 + 152 + 32 * (8 + 159)> npcMediaBytes{};
    struct WorldWeather {
        std::uint32_t tick;
        std::uint32_t received;
        std::uint64_t gameTime;
        float seconds, factor, effectRemaining;
        std::string cycle, effect;
    };
    std::optional<WorldWeather> worldWeather;
    std::optional<std::uint32_t> appliedWorldClock;
    bool appliedWorldWeather = false;
    std::map<std::string, ref_sound> nativeSounds;
    struct NativeSoundLoop { ref_sound sound; std::uint32_t seen, tick; };
    std::map<std::uint32_t, NativeSoundLoop> nativeSoundLoops;
    std::map<std::pair<std::string, unsigned>, HUD_SOUND_COLLECTION_LAYERED> gunshotSounds;
    DetectorHint detectorHint{};
    std::vector<TimedParticle> detonationParticles;
    std::vector<BlowoutLight> blowoutLights;
    float detonationCredit = DetonationCapacity;
    float gunshotCredit = GunshotCapacity;
    std::uint64_t corpseDiscoveryUpdates = 0;
    Fvector anchor{}, focus{};
    std::uint32_t applied = 0;
    std::uint32_t npcBaseTick = 0;
    double npcRenderTick = 0.;
    float heading = 0, pitch=0;
    struct PredictedPose { std::uint32_t sequence; Fvector position; };
    std::deque<PredictedPose> nativeHistory;
    Fvector nativeCorrection{}, lastAuthorityPosition{}, lastPredictedPosition{};
    std::uint32_t nativeAck = 0, nativeLife = 0, nativeAckTime = 0;
    bool nativeMovement = false, nativeReady = false, nativeLow = false;
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

    void receiveWorldWeather(const unsigned char* packet, const SnapshotState& frame)
    {
        const auto tick = u32(packet);
        const auto age = static_cast<std::int32_t>(frame.tick - tick);
        if (age < 0 || age > 60 || (worldWeather && !newer(tick, worldWeather->tick))) return;
        const auto name = [](const unsigned char* bytes) -> std::optional<std::string> {
            const auto* end = std::find(bytes, bytes + 64, 0);
            if (end == bytes + 64) return {};
            std::string value(reinterpret_cast<const char*>(bytes), end - bytes);
            if (value.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-") != value.npos)
                return {};
            return value;
        };
        auto cycle = name(packet + 16), effect = name(packet + 80);
        const float seconds = f32(packet + 4), factor = f32(packet + 8), remaining = f32(packet + 12);
        const auto gameTime = std::uint64_t(u32(packet + 144)) | (std::uint64_t(u32(packet + 148)) << 32);
        if (!cycle || cycle->empty() || !effect || !(seconds >= 0.f && seconds < 86400.f) ||
            !(factor >= 0.f && factor <= 1000.f) || !(remaining >= 0.f && remaining <= 86400.f) ||
            gameTime >= 1000000000000000ULL)
            return;
        const float elapsed = age * factor / 30.f;
        worldWeather = WorldWeather{tick, Device.dwTimeGlobal,
            gameTime + static_cast<std::uint64_t>(elapsed * 1000.f), seconds + elapsed, factor,
            remaining - elapsed, std::move(*cycle), std::move(*effect)};
    }

    void advanceWorldWeather()
    {
        if (!worldWeather) return;
        const auto& weather = *worldWeather;
        auto& environment = g_pGamePersistent->Environment();
        const auto milliseconds = Device.dwTimeGlobal - weather.received;
        const float elapsed = milliseconds * .001f * weather.factor;
        if (game && appliedWorldClock != weather.tick) {
            const auto time = weather.gameTime + static_cast<std::uint64_t>(double(milliseconds) * weather.factor);
            game->SetGameTimeFactor(time, weather.factor);
            game->SetEnvironmentGameTimeFactor(time, weather.factor);
            appliedWorldClock = weather.tick;
        }
        const float seconds = std::fmod(weather.seconds + elapsed, 86400.f);
        const float remaining = weather.effectRemaining - elapsed;
        const bool active = !weather.effect.empty() && remaining > 0.f;
        const float difference = std::remainder(seconds - environment.GetGameTime(), 86400.f);
        const bool jump = !appliedWorldWeather || std::abs(difference) > std::max(60.f, weather.factor * 2.f);
        if (environment.IsWFXPlaying() && (jump || !active || environment.GetWeather() != weather.effect.c_str()))
            environment.StopWFX();
        if (jump || difference >= 0.f)
            environment.SetGameTime(seconds, weather.factor);
        if (jump || environment.GetWeatherCycle() != weather.cycle.c_str())
            environment.SetWeather(weather.cycle.c_str(), !environment.IsWFXPlaying());
        if (active && !environment.IsWFXPlaying())
            environment.StartWeatherFXFromTime(weather.effect.c_str(), remaining);
        appliedWorldWeather = true;
    }

    void applyNativeSound(const unsigned char* packet, std::size_t size, std::uint32_t loop = 0,
        std::uint32_t tick = 0)
    {
        std::string name(reinterpret_cast<const char*>(packet + 24), size - 24);
        if (name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-\\/ ") != name.npos ||
            name.find("..") != name.npos || name.front() == '/' || name.front() == '\\')
            return;
        std::replace(name.begin(), name.end(), '/', '\\');
        Fvector position{f32(packet), f32(packet + 4), f32(packet + 8)};
        float volume = f32(packet + 12), frequency = f32(packet + 16);
        const float range = f32(packet + 20);
        if (!_valid(position) || !(volume >= 0.f && volume <= 4.f) ||
            !(frequency >= .1f && frequency <= 4.f) || !(range >= 1.f && range <= 100.f))
            return;
        const auto exists = [&] {
            string_path path;
            const auto file = name + ".ogg";
            return FS.exist(path, "$level$", file.c_str()) || FS.exist(path, "$game_sounds$", file.c_str());
        };
        if (loop) {
            auto sound = nativeSoundLoops.find(loop);
            if (sound == nativeSoundLoops.end()) {
                if (nativeSoundLoops.size() >= 48 || !exists()) return;
                sound = nativeSoundLoops.try_emplace(loop).first;
                sound->second.sound.create(name.c_str(), st_Effect, sg_SourceType);
            } else if (!newer(tick, sound->second.tick)) return;
            auto& state = sound->second;
            state.seen = Device.dwTimeGlobal;
            state.tick = tick;
            if (!state.sound._feedback())
                state.sound.play_at_pos(nullptr, position, sm_Looped);
            state.sound.set_position(position);
            state.sound.set_volume(volume);
            state.sound.set_frequency(frequency);
            if (const auto* params = state.sound.get_params())
                state.sound.set_range(std::min(params->min_distance, range), range);
            return;
        }
        auto sound = nativeSounds.find(name);
        if (sound == nativeSounds.end()) {
            if (!exists()) return;
            if (nativeSounds.size() >= 128) nativeSounds.erase(nativeSounds.begin());
            sound = nativeSounds.try_emplace(name).first;
            sound->second.create(name.c_str(), st_Effect, sg_SourceType);
        }
        sound->second.play_no_feedback(nullptr, 0, 0.f, &position, &volume, &frequency);
    }

    void consumeNpcMedia(const SnapshotState& frame)
    {
        const auto length = zone_npc_media_poll(npcMediaBytes.data(), npcMediaBytes.size());
        if (length > npcMediaBytes.size()) return;
        for (std::size_t offset = 0; offset + 8 <= length;) {
            const auto type = u32(npcMediaBytes.data() + offset);
            const auto size = u32(npcMediaBytes.data() + offset + 4);
            offset += 8;
            if (size > length - offset) break;
            const auto* packet = npcMediaBytes.data() + offset;
            offset += size;
            if (type == 35 && size == 152) {
                receiveWorldWeather(packet, frame);
            } else if (type == 33 && size >= 8 + npcPoseHeader) {
                const auto id = u32(packet), tick = u32(packet + 4);
                auto proxy = proxies.find(id);
                if (proxy != proxies.end() && std::abs(double(static_cast<std::int32_t>(frame.tick - tick))) <= 60.)
                    proxy->second->queueAuthoredPose(packet + 8, size - 8, static_cast<std::int32_t>(tick - npcBaseTick));
            } else if (type == 34 && size >= 25 && size <= 151) {
                applyNativeSound(packet, size);
            } else if (type == 36 && size >= 33 && size <= 159 && u32(packet) &&
                frame.tick - u32(packet + 4) <= 20) {
                applyNativeSound(packet + 8, size - 8, u32(packet), u32(packet + 4));
            }
        }
        for (auto loop = nativeSoundLoops.begin(); loop != nativeSoundLoops.end();)
            if (Device.dwTimeGlobal - loop->second.seen > 750)
                loop = nativeSoundLoops.erase(loop);
            else
                ++loop;
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
            corpseActors.clear();
            corpseDiscoveryUpdates = 0;
            return;
        }
        if (corpseDiscoveryUpdates != discovery.updates) {
            std::map<std::string, std::unique_ptr<Proxy>> next;
            std::map<std::string, std::uint32_t> links;
            for (const auto& body : discovery.corpses) {
                auto existing = corpses.find(body.source);
                if (existing != corpses.end()) {
                    next.emplace(body.source, std::move(existing->second));
                    if (auto linked = corpseActors.find(body.source); linked != corpseActors.end())
                        links.emplace(body.source, linked->second);
                } else {
                    auto proxy = std::make_unique<Proxy>();
                    proxy->pose(projectWorld(body.position), 0.f, 0.f, false, true);
                    proxy->settleLootBody();
                    next.emplace(body.source, std::move(proxy));
                }
            }
            corpses = std::move(next);
            corpseActors = std::move(links);
            corpseDiscoveryUpdates = discovery.updates;
        }
        for (auto& [source, corpse] : corpses) {
            corpse->advance(Device.fTimeDelta, npcRenderTick);
            corpse->visible = true;
            auto linked = corpseActors.find(source);
            if (linked == corpseActors.end()) {
                const auto& anchor = corpse->renderable.xform.c;
                float closest = 1.5f;
                std::uint32_t match = 0;
                const auto consider = [&](std::uint32_t id, const Proxy& proxy) {
                    if (!proxy.hasNativeBody() || std::any_of(corpseActors.begin(), corpseActors.end(),
                        [id](const auto& item) { return item.second == id; }))
                        return;
                    const auto& position = proxy.renderable.xform.c;
                    const float distance = std::hypot(position.x - anchor.x, position.z - anchor.z);
                    if (distance < closest && std::abs(position.y - anchor.y) < 2.f) {
                        closest = distance;
                        match = id;
                    }
                };
                for (const auto& [id, actor] : proxies) consider(id, *actor);
                for (const auto& [id, actor] : retiredNpcCorpses) consider(id, *actor);
                if (match) linked = corpseActors.emplace(source, match).first;
            }
            if (linked != corpseActors.end()) {
                if (!corpse->hasNativeBody()) {
                    if (auto retired = retiredNpcCorpses.find(linked->second); retired != retiredNpcCorpses.end()) {
                        corpse = std::move(retired->second);
                        corpse->visible = true;
                        retiredNpcCorpses.erase(retired);
                    }
                }
                if (auto actor = proxies.find(linked->second); actor != proxies.end()) {
                    if (corpse->hasNativeBody()) actor->second->visible = false;
                    else corpse->visible = false;
                }
                continue;
            }
            for (const auto& entity : frame.entities) {
                if (entity.kind != 1 || entity.health != 0 || (firstPerson && entity.id == frame.playerId)) continue;
                const auto player = proxies.find(entity.id);
                if (player != proxies.end() &&
                    player->second->renderable.xform.c.distance_to_sqr(corpse->renderable.xform.c) < 0.09f) {
                    corpse->visible = false;
                    break;
                }
            }
        }
    }
    void updateNativePlayer(const SnapshotState& frame, const Entity& self, bool newFrame)
    {
        auto* actor = inventoryPresentation->movementActor();
        if (!actor || self.health == 0 || !inventory().alive) {
            if (actor && nativeReady) actor->character_physics_support()->movement()->DestroyCharacter();
            nativeReady = false;
            nativeHistory.clear();
            return;
        }
        const Fvector authority{self.x, self.y, self.z};
        const Fvector velocity{self.vx, self.vy, self.vz};
        const bool reset = !nativeReady || nativeLife != inventory().life ||
            (newFrame && authority.distance_to_sqr(lastAuthorityPosition) > 64.f &&
                authority.distance_to_sqr(lastPredictedPosition) > 64.f);
        if (reset) {
            actor->resetZoneMovement(authority, velocity, (self.flags & 4) != 0);
            nativeReady = true;
            nativeLife = inventory().life;
            nativeHistory.clear();
            nativeCorrection.set(0, 0, 0);
            nativeAck = frame.ack;
            nativeAckTime = Device.dwTimeGlobal;
        }
        Fvector position, actualVelocity;
        const auto flags = actor->sampleZoneMovement(position, actualVelocity);
        nativeLow = (flags & 4) != 0;
        if (newFrame) {
            lastAuthorityPosition = authority;
            if (newer(frame.ack, nativeAck)) {
                nativeAck = frame.ack;
                nativeAckTime = Device.dwTimeGlobal;
                while (!nativeHistory.empty() && newer(frame.ack, nativeHistory.front().sequence))
                    nativeHistory.pop_front();
                if (!nativeHistory.empty() && nativeHistory.front().sequence == frame.ack) {
                    nativeCorrection.sub(authority, nativeHistory.front().position);
                    if (nativeCorrection.square_magnitude() < .0064f)
                        nativeCorrection.set(0, 0, 0);
                }
            }
        }
        // Keep the stock controller running through short gaps in host updates.
        // An extended outage releases movement input without resetting physics every frame.
        const bool predict = Device.dwTimeGlobal - nativeAckTime <= 1000;
        const auto sequence = zone_native_sequence();
        if (sequence && (nativeHistory.empty() || newer(sequence, nativeHistory.back().sequence))) {
            nativeHistory.push_back({sequence, position});
            if (nativeHistory.size() > 32) nativeHistory.pop_front();
        }
        if (nativeCorrection.square_magnitude() > 0.f) {
            Fvector adjustment = nativeCorrection;
            adjustment.mul(1.f - std::exp(-Device.fTimeDelta / .18f));
            const auto length = adjustment.magnitude();
            if (length > .08f) adjustment.mul(.08f / length);
            position.add(adjustment);
            auto* movement = actor->character_physics_support()->movement();
            Fvector physicalPosition;
            movement->GetCharacterPosition(physicalPosition);
            movement->SetPosition(physicalPosition.add(adjustment));
            nativeCorrection.sub(adjustment);
            for (auto& sample : nativeHistory) sample.position.add(adjustment);
            if (nativeCorrection.square_magnitude() < .0001f)
                nativeCorrection.set(0, 0, 0);
        }
        const auto motion = zone_native_motion_flags();
        const bool aiming = !aimedItem.empty();
        const bool walking = walk || (aiming && !crouch);
        std::uint32_t controls = ((predict ? crouch : nativeLow) ? 16u : 0u) | (walking ? 128u : 0u);
        if (predict && (motion & 2)) {
            controls |= firstPerson
                ? (forward && !back ? 1u : back && !forward ? 2u : 0u)
                    | (left && !right ? 4u : right && !left ? 8u : 0u)
                : (forward != back || left != right ? 1u : 0u);
            if (jump && !aiming) controls |= 32u;
            if (sprint && !walking && !aiming && (motion & 1)) controls |= 64u;
        }
        actor->driveZoneMovement(controls, heading, zone_native_motion_scale(), Device.fTimeDelta);
        focus = position;
        lastPredictedPosition = position;
        actor->updateZoneActorPose(position, heading, pitch, Device.fTimeDelta);
        actor->UpdateAnimation();
        actor->CStepManager::update(firstPerson);
        if (auto local = proxies.find(frame.playerId); local != proxies.end())
            local->second->predicted(position, heading);
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
        firstPerson = worldSpace;
        nativeMovement = worldSpace && strstr(Core.Params, "-zone-native-player");
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
    void net_Stop() override {stopFire();inventoryPresentation.reset();proxies.clear();flyingGrenades.clear();appearance.clear();corpses.clear();corpseActors.clear();retiredNpcCorpses.clear();detonationParticles.clear();blowoutLights.clear();detonationSounds.clear();gunshotSounds.clear();nativeSounds.clear();nativeSoundLoops.clear();worldWeather.reset();appliedWorldClock.reset();appliedWorldWeather=false;IGame_Level::net_Stop();}
    void OnFrame() override {
        if(worldSpace && !contentReady) {
            const int status=zone_content_status();
            if(status!=1) {if(status<0 && !contentError){Msg("! Zone content verification failed; actors disabled");contentError=true;}return;}
            contentReady=true;Msg("* Zone content verified: authoritative world coordinates enabled");
        }
        const auto& frame = snapshot();
        if (!frame.valid) {stopFire();inventoryPresentation.reset();proxies.clear();flyingGrenades.clear();appearance.clear();corpses.clear();corpseActors.clear();retiredNpcCorpses.clear();detonationParticles.clear();blowoutLights.clear();nativeSoundLoops.clear();corpseDiscoveryUpdates = 0;hasFrame = false;nativeReady = false;nativeHistory.clear();return;}
        constexpr double npcDelayTicks = 6.; // Buffer two native host updates at 10 Hz.
        if (!hasFrame) {
            npcBaseTick = frame.tick;
            npcRenderTick = -npcDelayTicks;
        }
        const auto latestNpcTick = static_cast<double>(frame.tick - npcBaseTick);
        const double phaseError = latestNpcTick - npcDelayTicks - npcRenderTick;
        if (std::abs(phaseError) > 30.) npcRenderTick = latestNpcTick - npcDelayTicks;
        npcRenderTick = std::min(latestNpcTick,
            npcRenderTick + Device.fTimeDelta * 30. * std::clamp(1. + phaseError * .025, .85, 1.15));
        const auto appearanceSize = zone_appearance_poll(appearanceBytes.data(), appearanceBytes.size());
        if (appearanceSize > 0 && appearance.apply(appearanceBytes.data(), appearanceSize)) {
            for (auto& entry : proxies) entry.second->setAppearance(appearance.get(entry.first));
        }
        const bool newFrame = !hasFrame || applied != frame.tick;
        if (newFrame) {
            std::map<std::uint32_t, bool> present;
            for (const auto& entity : frame.entities) {
                const auto& look = appearance.get(entity.id);
                if (entity.kind == 2 && look.visual.empty() && !proxies.count(entity.id)) continue;
                present[entity.id] = true;
                auto& proxy = proxies[entity.id];
                if (!proxy && entity.kind == 2 && entity.health == 0) {
                    if (auto retired = retiredNpcCorpses.find(entity.id); retired != retiredNpcCorpses.end()) {
                        proxy = std::move(retired->second);
                        retiredNpcCorpses.erase(retired);
                    }
                }
                if (!proxy) {
                    proxy = std::make_unique<Proxy>(look.visual);
                    proxy->setAppearance(look);
                    Msg("* Zone proxy spawned: %u", entity.id);
                }
                Fvector position;position.set(worldSpace?entity.x:anchor.x+entity.x, entity.y, worldSpace?entity.z:anchor.z+entity.z);
                // Visual ground projection only. Rust still simulates a flat test
                // world; this must not be mistaken for server-side map collision.
                if(!worldSpace)position.y = floor(position.x, position.z);
                if (entity.kind == 2) proxy->queueNpcPose(position, entity, latestNpcTick);
                else proxy->pose(position, entity.yaw, std::hypot(entity.vx, entity.vz),
                    (entity.flags & 4)!=0, entity.health==0);
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
                if (present.count(i->first)) { ++i; continue; }
                if (i->second->hasNativeBody()) {
                    i->second->visible = false;
                    if (retiredNpcCorpses.size() >= 128) retiredNpcCorpses.erase(retiredNpcCorpses.begin());
                    retiredNpcCorpses.insert_or_assign(i->first, std::move(i->second));
                }
                i = proxies.erase(i);
            }
            const bool firstFrame = !hasFrame;
            applied = frame.tick;hasFrame = true;
            if (firstFrame) updateInput();
        }
        consumeNpcMedia(frame);
        advanceWorldWeather();
        for (auto& entry : proxies) {entry.second->visible=!firstPerson||entry.first!=frame.playerId;entry.second->advance(Device.fTimeDelta,npcRenderTick);}
        if (auto local = proxies.find(frame.playerId); local != proxies.end()) {
            float predicted[4];
            if(worldSpace && !nativeMovement && zone_prediction(predicted)) {
                Fvector position;position.set(predicted[0],predicted[1],predicted[2]);
                local->second->predicted(position,predicted[3]);
            }
            focus = local->second->renderable.xform.c;
        }
        if (inventory().valid) {
            if (!inventoryPresentation) inventoryPresentation=std::make_unique<InventoryPresentation>(*this);
            const auto self = std::find_if(frame.entities.begin(), frame.entities.end(),
                [&](const auto& entity) { return entity.id == frame.playerId; });
            inventoryPresentation->update(focus, self == frame.entities.end() ? 0.f : float(self->health) / 100.f);
            if (nativeMovement && self != frame.entities.end())
                updateNativePlayer(frame, *self, newFrame);
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
            if (nativeMovement && nativeReady) low = nativeLow;
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
