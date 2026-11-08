#include "pch_script.h"
#include "EngineAdapter.h"
#include "InventoryPresentation.h"
#include "InventoryIntent.h"
#include "Level.h"
#include "UIGameCustom.h"
#include "HUDManager.h"
#include "HudSound.h"
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

EM_JS(void, zone_map_input, (float x, float z, float yaw, float pitch, int sprint, int jump, int crouch), {
    globalThis.zoneEngineInput?.({x,z,yaw,pitch,sprint:!!sprint,jump:!!jump,crouch:!!crouch});
});
EM_JS(void, zone_reload, (), {globalThis.zoneEngineReload?.();});
EM_JS(void, zone_respawn, (), {globalThis.zoneEngineRespawn?.();});
EM_JS(void, zone_view, (int firstPerson), {globalThis.zoneEngineView?.(!!firstPerson);});
EM_JS(int, zone_prediction, (float* out), {return globalThis.zoneEnginePrediction?.(out) ?? 0;});
EM_JS(int, zone_world_space, (), {return globalThis.zoneEngineWorldSpace?.()?1:0;});
EM_JS(void, zone_verify_asset, (int kind, const void* pointer, unsigned size), {
    globalThis.zoneEngineVerifyAsset?.(kind,pointer,size);
});
EM_JS(int, zone_content_status, (), {return globalThis.zoneEngineContentStatus?.() ?? -1;});
EM_JS(unsigned, zone_detonations, (void* effects, unsigned capacity), {
    return globalThis.zoneEngineDetonations?.(effects, capacity) ?? 0;
});
namespace zone {
namespace {
struct DetonationEffect {
    float position[3];
    char section[129];
};
static_assert(offsetof(DetonationEffect, section) == 12 && sizeof(DetonationEffect) == 144);
constexpr unsigned DetonationCapacity = 8;

// Presentation only: no CGameObject, AI, scheduler, inventory or local physics.
class Proxy final : public SpatialBase, public RenderableBase {
public:
    bool visible=true;
    Proxy() : SpatialBase(g_pGamePersistent->SpatialSpace) {
        renderable.visual = GEnv.Render->model_Create("actors\\stalker_neutral\\stalker_neutral_1");
        if (auto* animated = renderable.visual->dcast_PKinematicsAnimated()) {
            for (const char* name : {"norm_idle_0", "head_idle_0"}) {
                const auto motion = animated->ID_Cycle_Safe(name);
                if (motion.valid()) animated->PlayCycle(motion, FALSE);
                else Msg("! Zone proxy: missing idle motion %s", name);
            }
        }
        spatial.type = STYPE_RENDERABLE;
        spatial.sphere.set(Fvector().set(0, 1, 0), 2.f);
    }
    ~Proxy() override {spatial_unregister();}
    IRenderable* dcast_Renderable() override {return this;}
    void pose(const Fvector& position, float yaw, bool moving, bool crouch, bool dead) {
        from = renderable.xform.c;target = position;fromYaw = currentYaw;targetYaw = yaw;elapsed = 0;
        if (!registered || from.distance_to_sqr(target) > 400.f) {from = target;fromYaw = targetYaw;}
        if (moving != walking || crouch != crouched || dead != deadState) {
            const bool wasDead=deadState;deadState=dead;
            crouched=crouch;
            walking = moving;
            if (auto* animated = renderable.visual->dcast_PKinematicsAnimated()) {
                for (const char* name : {dead ? "norm_death_0" : crouch ? (moving?"cr_walk_fwd_0":"cr_idle_0") : (moving ? "norm_walk_fwd_0" : "norm_idle_0")}) {
                    auto motion = animated->ID_Cycle_Safe(name);
                    if (!motion.valid() && dead) motion=animated->ID_Cycle_Safe("norm_dead_stop_0");
                    if (!motion.valid() && dead) motion=animated->ID_Cycle_Safe("death_init");
                    if (!motion.valid() && crouch && !dead) motion=animated->ID_Cycle_Safe("cr_idle_1");
                    if (motion.valid()) {
                        if(dead||wasDead) {
                            animated->PlayCycle(BI_NONE,motion,FALSE);
                            if(dead)for(unsigned part=0;part<MAX_PARTS;++part)for(unsigned i=0;i<animated->LL_PartBlendsCount(part);++i){
                                auto* blend=animated->LL_PartBlend(part,i);blend->stop_at_end=true;blend->fall_at_end=false;
                            }
                        } else animated->PlayCycle(motion,TRUE);
                    }
                    else Msg("! Zone proxy: missing stance motion %s",name);
                }
            }
        }
    }
    void advance(float dt) {
        elapsed += dt;
        const float blend = std::min(1.f, elapsed * 15.f);
        Fvector position;position.lerp(from, target, blend);
        currentYaw = fromYaw + std::remainder(targetYaw - fromYaw, 6.2831853f) * blend;
        renderable.xform.setHPB(currentYaw, 0, 0);renderable.xform.c = position;
        if (auto* bones = renderable.visual->dcast_PKinematics()) {
            bones->CalculateBones_Invalidate();bones->CalculateBones(TRUE);
        }
        spatial.sphere.P = position;spatial.sphere.P.y += 1.f;
        if (!registered) {spatial_register();registered = true;} else spatial_move();
    }
    void predicted(const Fvector& position,float yaw) {
        renderable.xform.setHPB(yaw,0,0);renderable.xform.c=position;
        spatial.sphere.P=position;spatial.sphere.P.y+=1.f;spatial_move();
    }
    void renderable_Render(::u32 context, IRenderable* root) override {
        if(!visible)return;
        if (auto* bones = renderable.visual->dcast_PKinematics()) bones->CalculateBones(TRUE);
        GEnv.Render->add_Visual(context, root, renderable.visual, renderable.xform);
    }
private:
    bool registered = false, walking = false, crouched=false, deadState=false;
    Fvector from{}, target{};
    float fromYaw = 0, targetYaw = 0, currentYaw = 0, elapsed = 0;
};
class MapPreview final : public CLevel {
    std::map<std::uint32_t, std::unique_ptr<Proxy>> proxies;
    std::unique_ptr<InventoryPresentation> inventoryPresentation;
    std::map<std::string, std::unique_ptr<Proxy>> corpses;
    std::map<std::string, HUD_SOUND_COLLECTION_LAYERED> detonationSounds;
    float detonationCredit = DetonationCapacity;
    std::uint64_t corpseDiscoveryUpdates = 0;
    Fvector anchor{}, focus{};
    std::uint32_t applied = 0;
    float heading = 0, pitch=0;
    bool firstPerson=false;
    bool triggerHeld=false;
    bool worldSpace=false, contentReady=false, contentError=false;
    bool hasFrame = false, forward = false, back = false, left = false, right = false, sprint=false, jump=false, crouch=false;
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
    void playDetonations() {
        DetonationEffect effects[DetonationCapacity];
        const auto count = std::min(zone_detonations(effects, DetonationCapacity), DetonationCapacity);
        // A busy fight can generate effects faster than their particles expire.
        detonationCredit = std::min(float(DetonationCapacity), detonationCredit + 4.f * Device.fTimeDelta);
        for (unsigned i = 0; i < count && detonationCredit >= 1.f; ++i) {
            const auto& [coordinates, section] = effects[i];
            if (!pSettings->line_exist(section, "class") ||
                pSettings->r_clsid(section, "class") != CLSID_OBJECT_G_FAKE)
                continue;
            detonationCredit -= 1.f;
            Fvector position;
            position.set(coordinates[0], coordinates[1], coordinates[2]);
            if (pSettings->line_exist(section, "explode_particles")) {
                auto* particles = CParticlesObject::Create(pSettings->r_string(section, "explode_particles"), FALSE);
                if (particles->IsLooped()) {
                    CParticlesObject::Destroy(particles);
                } else {
                    particles->SetAutoRemove(true);
                    particles->play_at_pos(position);
                }
            }
            const auto [sound, inserted] = detonationSounds.try_emplace(section);
            if (inserted)
                sound->second.LoadSound(section, "snd_explode", "detonation", false, SOUND_TYPE_WEAPON_SHOOTING);
            sound->second.PlayOneShot("detonation", position);
        }
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
        float x = float(right)-float(left), z = float(forward)-float(back);
        if(firstPerson){const float side=x,front=z;x=side*std::cos(heading)+front*std::sin(heading);z=front*std::cos(heading)-side*std::sin(heading);}
        else if(x||z)heading=std::atan2(x,z);
        const float scale=std::max(1.f,std::sqrt(x*x+z*z));
        zone_map_input(x/scale,z/scale,heading,pitch,sprint,jump,crouch);
    }
    void fire() {
        const auto& frame = snapshot();
        if (!worldSpace || !contentReady || !frame.valid) return;
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
    void stopFire() {
        if (!triggerHeld) return;
        triggerHeld = false;
        zone_weapon_trigger_stop();
    }
    void input(int key, bool down) {
        if (inventoryPresentation) {
            if (down && GetBindedAction(key)==kINVENTORY) {
                stopFire();
                inventoryPresentation->toggle();
                forward=back=left=right=sprint=jump=crouch=false;updateInput();return;
            }
            if (inventoryPresentation->menuOpen()) {
                if (down) CurrentGameUI()->IR_UIOnKeyboardPress(key);
                else CurrentGameUI()->IR_UIOnKeyboardRelease(key);
                return;
            }
        }
        if(down && GetBindedAction(key)==kUSE) {if(inventoryPresentation)inventoryPresentation->pickup();return;}
        if (down && inventoryPresentation) {
            const auto binding = GetBindedAction(key);
            if (binding >= kQUICK_USE_1 && binding <= kQUICK_USE_4) {
                inventoryPresentation->useQuickItem(binding - kQUICK_USE_1);
                return;
            }
            if (binding == kUSE_BANDAGE || binding == kUSE_MEDKIT) {
                inventoryPresentation->useQuickItem(binding == kUSE_BANDAGE ? 4 : 5);
                return;
            }
            if (binding == kWPN_2 || binding == kWPN_3) {
                stopFire();
                inventoryPresentation->selectWeaponSlot(binding == kWPN_2 ? 2 : 3);
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
            zone_view(firstPerson);
            return;
        }
        if (down && key == SDL_SCANCODE_R && !inventory().valid) zone_reload();
        if(key==SDL_SCANCODE_RETURN&&down)zone_respawn();
        if (key == SDL_SCANCODE_W) forward = down;
        if (key == SDL_SCANCODE_S) back = down;
        if (key == SDL_SCANCODE_A) left = down;
        if (key == SDL_SCANCODE_D) right = down;
        if (key == SDL_SCANCODE_LSHIFT) sprint=down;
        if (key == SDL_SCANCODE_SPACE) jump=down;
        if (key == SDL_SCANCODE_LCTRL || key == SDL_SCANCODE_C) crouch=down;
        updateInput();
    }
public:
    bool net_Start(const char*, const char*) override {
        const int id = g_pGamePersistent->Level_ID("zaton", "1.0", true);
        R_ASSERT2(id >= 0, "Zaton map is unavailable");
        map_data.m_name = "zaton";
        R_ASSERT(IGame_Level::Load(id));
        worldSpace = zone_world_space()!=0;
        if (worldSpace) {
            IReader* geometry=FS.r_open("$level$","level.cform");
            R_ASSERT2(geometry,"Missing Zaton collision asset");
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
        Msg("* Zone map preview: Zaton loaded, anchor [%f,%f,%f], no local gameplay", anchor.x, anchor.y, anchor.z);
        return true;
    }
    bool Load_GameSpecific_Before() override {return true;}
    void net_Stop() override {stopFire();inventoryPresentation.reset();proxies.clear();corpses.clear();detonationSounds.clear();IGame_Level::net_Stop();}
    void OnFrame() override {
        if(worldSpace && !contentReady) {
            const int status=zone_content_status();
            if(status!=1) {if(status<0 && !contentError){Msg("! Zone content verification failed; actors disabled");contentError=true;}return;}
            contentReady=true;Msg("* Zone content verified: authoritative world coordinates enabled");
        }
        const auto& frame = snapshot();
        if (!frame.valid) {inventoryPresentation.reset();proxies.clear();corpses.clear();corpseDiscoveryUpdates = 0;hasFrame = false;return;}
        if (!hasFrame || applied != frame.tick) {
            std::map<std::uint32_t, bool> present;
            for (const auto& entity : frame.entities) {
                present[entity.id] = true;
                auto& proxy = proxies[entity.id];if (!proxy) {proxy = std::make_unique<Proxy>();Msg("* Zone proxy spawned: %u", entity.id);}
                Fvector position;position.set(worldSpace?entity.x:anchor.x+entity.x, entity.y, worldSpace?entity.z:anchor.z+entity.z);
                // Visual ground projection only. Rust still simulates a flat test
                // world; this must not be mistaken for server-side map collision.
                if(!worldSpace)position.y = floor(position.x, position.z);
                proxy->pose(position, entity.yaw, entity.vx * entity.vx + entity.vz * entity.vz > 0.01f, (entity.flags & 4)!=0, entity.health==0);
                if (entity.id == frame.playerId) focus = position;
            }
            for (auto i = proxies.begin(); i != proxies.end();) {
                if (!present.count(i->first)) {Msg("* Zone proxy removed: %u", i->first);i = proxies.erase(i);}else ++i;
            }
            applied = frame.tick;hasFrame = true;
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
        Fvector camera = focus,direction;
        if(firstPerson) {
            bool low=false;for(const auto& entity:frame.entities)if(entity.id==frame.playerId){low=(entity.flags&4)!=0;break;}
            camera.y+=low?0.95f:1.55f;
            direction.set(std::sin(heading)*std::cos(pitch),std::sin(pitch),std::cos(heading)*std::cos(pitch));
        } else {
            camera.y+=6.f;camera.z-=12.f;
            Fvector target=focus;target.y+=1.f;direction.sub(target,camera).normalize();
        }
        Cameras().Update(camera, direction, Fvector().set(0, 1, 0), 67.5f, 1.f, 500.f, 0);
        Cameras().ApplyDevice();
        if (worldSpace && contentReady)
            playDetonations();
        if (inventory().valid) {
            if (!inventoryPresentation) inventoryPresentation=std::make_unique<InventoryPresentation>(*this);
            float health=0.f;for(const auto& entity:frame.entities)if(entity.id==frame.playerId)health=float(entity.health)/100.f;
            inventoryPresentation->update(focus,health);
            inventoryPresentation->updateWorld([this](const std::array<float,3>& p) {return projectWorld(p);},firstPerson);
        }
        updateCorpses(frame);
    }
    void OnRender() override {
        GEnv.Render->BeforeWorldRender();IGame_Level::OnRender();GEnv.Render->AfterWorldRender();WorldRendered(true);
        // Match CLevel's post-world UI pass without invoking its local gameplay
        // rendering (bullets and native game rules).
        if (inventoryPresentation && !Device.IsAnselActive) HUD().RenderUI();
    }
    void IR_OnKeyboardPress(int key) override {input(key, true);}
    void IR_OnKeyboardRelease(int key) override {input(key, false);}
    void IR_OnKeyboardHold(int) override {}
    void IR_OnTextInput(pcstr) override {}
    void IR_OnMouseMove(int dx, int dy) override {
        if(inventoryPresentation && inventoryPresentation->menuOpen()) {CurrentGameUI()->IR_UIOnMouseMove(dx,dy);return;}
        if(!firstPerson)return;heading=std::remainder(heading+float(dx)*0.002f,6.2831853f);
        pitch=std::clamp(pitch-float(dy)*0.002f,-1.5f,1.5f);updateInput();
    }
    void IR_OnMousePress(int button) override {if(inventoryPresentation&&inventoryPresentation->menuOpen()){CurrentGameUI()->IR_UIOnKeyboardPress(button);return;}if(button==MOUSE_1&&firstPerson)fire();}
    void IR_OnMouseRelease(int button) override {
        if (button==MOUSE_1) stopFire();
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
    void IR_OnDeactivate() override {stopFire();forward = back = left = right = false;sprint=jump=crouch=false;zone_map_input(0, 0, heading,pitch,0,0,0);}
};
}
IGame_Level* createMapPreview() {return xr_new<MapPreview>();}
bool mapPreviewEnabled() {return strstr(Core.Params, "-zone_map_preview") != nullptr;}
}
