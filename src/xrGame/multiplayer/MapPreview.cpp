#include "pch_script.h"
#include "EngineAdapter.h"
#include "Level.h"
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

EM_JS(void, zone_map_input, (float x, float z, float yaw, int sprint, int jump, int crouch), {
    globalThis.zoneEngineInput?.({x,z,yaw,sprint:!!sprint,jump:!!jump,crouch:!!crouch});
});
EM_JS(void, zone_reload, (), {globalThis.zoneEngineReload?.();});
EM_JS(void, zone_respawn, (), {globalThis.zoneEngineRespawn?.();});
EM_JS(void, zone_map_fire, (unsigned tick,float yaw,float pitch), {globalThis.zoneEngineFire?.({tick,yaw,pitch});});
EM_JS(void, zone_view, (int firstPerson), {globalThis.zoneEngineView?.(!!firstPerson);});
EM_JS(int, zone_prediction, (float* out), {return globalThis.zoneEnginePrediction?.(out) ?? 0;});
EM_JS(int, zone_world_space, (), {return globalThis.zoneEngineWorldSpace?.()?1:0;});
EM_JS(void, zone_verify_asset, (int kind, const void* pointer, unsigned size), {
    globalThis.zoneEngineVerifyAsset?.(kind,pointer,size);
});
EM_JS(int, zone_content_status, (), {return globalThis.zoneEngineContentStatus?.() ?? -1;});
namespace zone {
namespace {
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
    Fvector anchor{}, focus{};
    std::uint32_t applied = 0;
    float heading = 0, pitch=0;
    bool firstPerson=false;
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
    void updateInput() {
        float x = float(right)-float(left), z = float(forward)-float(back);
        if(firstPerson){const float side=x,front=z;x=side*std::cos(heading)+front*std::sin(heading);z=front*std::cos(heading)-side*std::sin(heading);}
        else if(x||z)heading=std::atan2(x,z);
        const float scale=std::max(1.f,std::sqrt(x*x+z*z));
        zone_map_input(x/scale,z/scale,heading,sprint,jump,crouch);
    }
    void fire() {const auto& frame=snapshot();if(worldSpace&&contentReady&&frame.valid)zone_map_fire(frame.tick,heading,pitch);}
    void input(int key, bool down) {
        if(key==SDL_SCANCODE_V&&down){firstPerson=!firstPerson;zone_view(firstPerson);}
        if(key==SDL_SCANCODE_F&&down)fire();
        if(key==SDL_SCANCODE_R&&down)zone_reload();
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
    void net_Stop() override {proxies.clear();IGame_Level::net_Stop();}
    void OnFrame() override {
        if(worldSpace && !contentReady) {
            const int status=zone_content_status();
            if(status!=1) {if(status<0 && !contentError){Msg("! Zone content verification failed; actors disabled");contentError=true;}return;}
            contentReady=true;Msg("* Zone content verified: authoritative world coordinates enabled");
        }
        const auto& frame = snapshot();
        if (!frame.valid) {proxies.clear();hasFrame = false;return;}
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
    }
    void OnRender() override {
        GEnv.Render->BeforeWorldRender();IGame_Level::OnRender();GEnv.Render->AfterWorldRender();WorldRendered(true);
    }
    void IR_OnKeyboardPress(int key) override {input(key, true);}
    void IR_OnKeyboardRelease(int key) override {input(key, false);}
    void IR_OnKeyboardHold(int) override {}
    void IR_OnTextInput(pcstr) override {}
    void IR_OnMouseMove(int dx, int dy) override {
        if(!firstPerson)return;heading=std::remainder(heading+float(dx)*0.002f,6.2831853f);
        pitch=std::clamp(pitch-float(dy)*0.002f,-1.5f,1.5f);updateInput();
    }
    void IR_OnMousePress(int button) override {if(button==MOUSE_1&&firstPerson)fire();}
    void IR_OnMouseRelease(int) override {}
    void IR_OnMouseHold(int) override {}
    void IR_OnMouseWheel(float, float) override {}
    // The map presenter has no native gameplay state for CLevel input handlers.
    void IR_OnControllerPress(int, const ControllerAxisState&) override {}
    void IR_OnControllerRelease(int, const ControllerAxisState&) override {}
    void IR_OnControllerHold(int, const ControllerAxisState&) override {}
    void IR_OnControllerAttitudeChange(Fvector) override {}
    void IR_OnActivate() override {}
    void IR_OnDeactivate() override {forward = back = left = right = false;sprint=jump=crouch=false;zone_map_input(0, 0, heading,0,0,0);}
};
}
IGame_Level* createMapPreview() {return xr_new<MapPreview>();}
bool mapPreviewEnabled() {return strstr(Core.Params, "-zone_map_preview") != nullptr;}
}
