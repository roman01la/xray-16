#include "stdafx.h"
#include "WebGPUFluidVolume.h"

#ifdef XR_PLATFORM_WEB
#include "Layers/xrRender/FHierrarhyVisual.h"
#include "xrCore/FMesh.hpp"
#include "xrCore/xr_token.h"
#include "xrEngine/xr_object.h"
#include "xrEngine/IPhysicsShell.h"
#include "xrEngine/IObjectPhysicsCollision.h"
#include "xrEngine/IPhysicsGeometry.h"
#include <emscripten.h>

namespace xray::render::RENDER_NAMESPACE
{
namespace
{
constexpr u32 GridSize = 70;
const xr_token simulationTypes[] = {{"Fog", 0}, {"Fire", 1}, {nullptr, 0}};
const xr_token emitterTypes[] = {{"SimpleGaussian", 0}, {"SimpleDraught", 1}, {nullptr, 0}};
xr_vector<std::pair<FHierrarhyVisual*, WebGPUFluidVolume*>> volumes;

EM_JS(unsigned, CreateWebFluid, (const char* profile, const float* transform, const float* worldToGrid,
    const float* gridToWorld, const float* settings, const float* emitters, unsigned emitterCount,
    const float* obstacles, unsigned obstacleCount, unsigned fireTexture), {
    const r = globalThis.__xrayWebGPU;
    if (!r?.createFluidVolume) throw Error("WebGPU fluid backend is unavailable");
    const read = (p, n) => Array.from(HEAPF32.subarray(Number(p)/4, Number(p)/4+n));
    const s = read(settings, 5), emitterData = read(emitters, emitterCount*16), staticData = read(obstacles, obstacleCount*16);
    const config = {profile:UTF8ToString(Number(profile)),size:[70,70,70],transform:read(transform,16),
        worldToGrid:read(worldToGrid,16),gridToWorld:read(gridToWorld,16),
        settings:{type:s[0] ? 'Fire':'Fog',hemi:s[1],confinement:s[2],decay:s[3],gravity:s[4]},
        emitters:[],obstacles:[],fireTexture:fireTexture ? globalThis.__xrayWebGPUHandles.textures[fireTexture] : null};
    for(let i=0;i<emitterCount;i++) {
        const e=emitterData.slice(i*16,i*16+16);
        config.emitters.push({type:e[0] ? 'SimpleDraught':'SimpleGaussian',position:e.slice(1,4),radius:e[4],sigma:e[5],
            flowVelocity:e.slice(6,9),density:e[9],saturation:e[10],applyDensity:!!e[11],applyImpulse:!!e[12],
            draught:{period:e[13],phase:e[14],amplitude:e[15]}});
    }
    for(let i=0;i<obstacleCount;i++)config.obstacles.push({gridToObstacle:staticData.slice(i*16,i*16+16)});
    return r.createFluidVolume(config);
});

EM_JS(void, DestroyWebFluid, (unsigned handle), {
    globalThis.__xrayWebGPU?.destroyFluidVolume?.(handle);
});

EM_JS(void, RenderWebFluid, (unsigned handle, unsigned frameId, const float* data, unsigned depthTexture,
    const float* obstacles, unsigned obstacleCount, unsigned fireTexture), {
    const read=(p,n)=>Array.from(HEAPF32.subarray(Number(p)/4,Number(p)/4+n));
    const v=read(data,40),raw=read(obstacles,obstacleCount*28),dynamic=[];
    for(let i=0;i<obstacleCount;i++) {
        const o=raw.slice(i*28,i*28+28);
        dynamic.push({gridToObstacle:o.slice(0,16),massCenterWorld:o.slice(16,19),
            angularVelocityWorld:o.slice(20,23),translationVelocityWorld:o.slice(24,27)});
    }
    globalThis.__xrayWebGPU.renderFluidVolume(handle,{frameId,eyeWorld:v.slice(0,3),timeSeconds:v[3],
        inverseView:v.slice(4,20),projection:v.slice(20,36),lightColor:v.slice(36,39),timestep:v[39],
        depthTexture:globalThis.__xrayWebGPUHandles.textures[depthTexture],
        fireTexture:fireTexture ? globalThis.__xrayWebGPUHandles.textures[fireTexture] : null,obstacles:dynamic});
});
}

WebGPUFluidVolume::~WebGPUFluidVolume() { Release(); }

void WebGPUFluidVolume::Load(LPCSTR, IReader* data, u32)
{
    // Same format and sorting as dx113DFluidVolume/dx113DFluidData.
    data->r_string(m_profile);
    data->r(&m_transform, sizeof(m_transform));
    const u32 count = data->r_u32();
    R_ASSERT2(count <= static_cast<u32>(data->elapsed()/sizeof(Fmatrix)), "Truncated fluid obstacles");
    xr_vector<Fmatrix> worldObstacles(count);
    if (count) data->r(worldObstacles.data(), count*sizeof(Fmatrix));

    Fmatrix scale, translate, translateScale, inverse;
    scale.scale(1.f, -1.f, 1.f);
    translate.translate(.5f, -.5f, .5f);
    translateScale.mul(scale, translate);
    inverse.invert(m_transform);
    m_worldToGrid.mul(translateScale, inverse);
    m_gridToWorld.invert(m_worldToGrid);
    m_staticObstacles.resize(count);
    for (u32 i=0; i<count; ++i)
    {
        inverse.invert(worldObstacles[i]);
        m_staticObstacles[i].mul(inverse, m_gridToWorld);
    }
    ParseProfile();
    shader.create("fluid3d_stub", "water\\water_ryaska1");
    Type = MT_3DFLUIDVOLUME;
    vis.box.vMin.set(-.5f, -.5f, -.5f);
    vis.box.vMax.set(.5f, .5f, .5f);
    vis.box.xform(m_transform);
    vis.box.getcenter(vis.sphere.P);
    vis.sphere.R = vis.box.getradius();
    Register();
}

void WebGPUFluidVolume::ParseProfile()
{
    string_path filename;
    FS.update_path(filename, "$game_config$", m_profile.c_str());
    CInifile ini(filename, TRUE, TRUE, FALSE);
    Msg("Reading WebGPU fog volume config: %s", filename);
    // Defaults and optional properties match dx113DFluidData::ParseProfile.
    m_settings[0] = ini.line_exist("volume", "Type") ? float(ini.r_token("volume", "Type", simulationTypes)) : 0.f;
    m_settings[1] = ini.line_exist("volume", "Hemi") ? ini.r_float("volume", "Hemi") : .2f;
    m_settings[2] = ini.line_exist("volume", "ConfinementScale") ? ini.r_float("volume", "ConfinementScale") : .06f;
    m_settings[3] = ini.line_exist("volume", "Decay") ? ini.r_float("volume", "Decay") : .994f;
    m_settings[4] = ini.line_exist("volume", "GravityBuoyancy") ? ini.r_float("volume", "GravityBuoyancy") : 0.f;
    R_ASSERT(m_settings[0] == 0.f || m_settings[0] == 1.f);
    const u32 count = ini.r_u32("volume", "EmittersNum");
    R_ASSERT2(count <= 4096, "Invalid fluid emitter count");
    m_emitters.assign(count*16, 0.f);
    for (u32 i=0; i<count; ++i)
    {
        string32 section;
        xr_sprintf(section, "emitter%02d", i);
        float* e = m_emitters.data()+i*16;
        e[0] = float(ini.r_token(section, "Type", emitterTypes));
        R_ASSERT(e[0] == 0.f || e[0] == 1.f);
        Fvector position;
        if (ini.line_exist(section, "Position")) position=ini.r_fvector3(section,"Position");
        else
        {
            m_worldToGrid.transform_tiny(position, ini.r_fvector3(section,"WorldPosition"));
            // Stock emitters use dim-1, whereas obstacle velocities use dim.
            position.mul(float(GridSize-1));
        }
        e[1]=position.x; e[2]=position.y; e[3]=position.z;
        e[4]=ini.r_float(section,"Radius"); e[5]=ini.r_float(section,"Sigma");
        R_ASSERT(e[5]>0.f);
        Fvector velocity=ini.r_fvector3(section,"FlowDirection");
        velocity.mul(ini.r_float(section,"FlowSpeed"));
        e[6]=velocity.x; e[7]=velocity.y; e[8]=velocity.z;
        e[9]=ini.r_float(section,"Density");
        // Stock vector-resized CEmitter is zero-initialized; ParseProfile never
        // assigns m_fSaturation. Do not substitute the manager's separate .78.
        e[10]=0.f;
        e[11]=ini.r_bool(section,"ApplyDensity") ? 1.f:0.f;
        e[12]=ini.r_bool(section,"ApplyImpulse") ? 1.f:0.f;
        if (e[0] == 1.f)
        {
            e[13]=ini.r_float(section,"DraughtPeriod"); e[14]=ini.r_float(section,"DraughtPhase");
            e[15]=ini.r_float(section,"DraughtAmp"); R_ASSERT(e[13]>.0001f);
        }
    }
    if (m_settings[0] == 1.f)
    {
        m_fireTexture.create("internal\\internal_fireTransferFunction");
        m_fireTexture->Load();
    }
}

void WebGPUFluidVolume::Register()
{
    static_assert(sizeof(Fmatrix)==16*sizeof(float));
    static_assert(sizeof(Obstacle)==28*sizeof(float));
    m_handle=CreateWebFluid(m_profile.c_str(),reinterpret_cast<float*>(&m_transform),
        reinterpret_cast<float*>(&m_worldToGrid),reinterpret_cast<float*>(&m_gridToWorld),m_settings,
        m_emitters.data(),u32(m_emitters.size()/16),reinterpret_cast<float*>(m_staticObstacles.data()),
        u32(m_staticObstacles.size()),m_fireTexture ? m_fireTexture->surface_get():0);
    R_ASSERT2(m_handle, "WebGPU fluid registration failed");
}

void WebGPUFluidVolume::AddPhysicsElement(const IPhysicsElement& element, float timestep)
{
    const float velocityScale=6.f/(timestep*60.f);
    Fvector angular,linear;
    element.get_AngularVel(angular); element.get_LinearVel(linear);
    angular.mul(velocityScale); linear.mul(velocityScale);
    for (u16 i=0; i<element.numberOfGeoms(); ++i)
    {
        const IPhysicsGeometry* geometry=element.geometry(i);
        if (!geometry->collide_fluids()) continue;
        Fmatrix world,scale,box,inverse;
        Fvector size;
        geometry->get_Box(world,size);
        if (size.x<=EPS_S || size.y<=EPS_S || size.z<=EPS_S) continue;
        scale.scale(size); box.mul(world,scale); inverse.invert(box);
        Obstacle obstacle;
        obstacle.gridToObstacle.mul(inverse,m_gridToWorld);
        obstacle.massCenter=element.mass_Center(); obstacle.angularVelocity=angular; obstacle.translationVelocity=linear;
        m_dynamicObstacles.push_back(obstacle);
    }
}

void WebGPUFluidVolume::GatherObstacles(float timestep)
{
    m_dynamicObstacles.clear(); m_spatials.clear();
    Fvector center,size; vis.box.getcenter(center); vis.box.getradius(size);
    g_pGamePersistent->SpatialSpace.q_box(m_spatials,0,STYPE_RENDERABLE,center,size);
    for (ISpatial* spatial:m_spatials)
    {
        IGameObject* object=spatial->dcast_GameObject();
        if (!object) continue;
        const IObjectPhysicsCollision* collision=object->physics_collision();
        if (!collision) continue;
        if (const IPhysicsShell* shell=collision->physics_shell())
            for (u16 i=0;i<shell->get_ElementsNumber();++i) AddPhysicsElement(shell->Element(i),timestep);
        else if (const IPhysicsElement* element=collision->physics_character()) AddPhysicsElement(*element,timestep);
    }
}

Fvector WebGPUFluidVolume::CalculateLighting()
{
    // Stock dx113DFluidRenderer::CalculateLighting, including dynamic lights.
    Fvector result;
    const auto& environment=g_pGamePersistent->Environment().CurrentEnv;
    result.set(environment.hemi_color.x,environment.hemi_color.y,environment.hemi_color.z);
    result.mul(m_settings[1]); result.add(environment.ambient);
    Fvector center,size;vis.box.getcenter(center);vis.box.getradius(size);
    m_spatials.clear();g_pGamePersistent->SpatialSpace.q_box(m_spatials,0,STYPE_LIGHTSOURCE,center,size);
    for (ISpatial* spatial:m_spatials)
    {
        light* source=static_cast<light*>(spatial->dcast_Light());
        if (!source || source->flags.bStatic) continue;
        const float distance=source->position.distance_to(m_transform.c);
        if (distance>=source->range+_max(size.x,_max(size.y,size.z))) continue;
        const float attenuation=clampr(1.f-distance/(source->range+EPS),0.f,1.f)*2.f;
        result.x+=source->color.r*attenuation;result.y+=source->color.g*attenuation;result.z+=source->color.b*attenuation;
    }
    return result;
}

void WebGPUFluidVolume::Render(CBackend& cmd_list,float,bool)
{
    if (!m_handle) return;
    struct Frame {Fvector eye;float time;Fmatrix inverseView;Fmatrix projection;Fvector light;float timestep;} frame;
    static_assert(sizeof(Frame)==40*sizeof(float));
    frame.eye=Device.vCameraPosition;frame.time=Device.fTimeGlobal;frame.timestep=2.f;
    frame.inverseView.invert(cmd_list.xforms.m_v);frame.projection=cmd_list.xforms.m_p;
    GatherObstacles(frame.timestep);frame.light=CalculateLighting();
    RenderWebFluid(m_handle,Device.dwFrame,reinterpret_cast<float*>(&frame),
        RImplementation.Target->rt_Position->pTexture->surface_get(),
        reinterpret_cast<float*>(m_dynamicObstacles.data()),u32(m_dynamicObstacles.size()),
        m_fireTexture ? m_fireTexture->surface_get():0);
}

void WebGPUFluidVolume::Copy(dxRender_Visual* source)
{
    Release();dxRender_Visual::Copy(source);
    const auto& volume=*static_cast<WebGPUFluidVolume*>(source);
    m_profile=volume.m_profile;m_transform=volume.m_transform;m_worldToGrid=volume.m_worldToGrid;
    m_gridToWorld=volume.m_gridToWorld;std::copy(std::begin(volume.m_settings),std::end(volume.m_settings),m_settings);
    m_emitters=volume.m_emitters;m_staticObstacles=volume.m_staticObstacles;m_fireTexture=volume.m_fireTexture;
    Register();
}

void WebGPUFluidVolume::Release()
{
    if (m_handle) {DestroyWebFluid(m_handle);m_handle=0;}
    m_fireTexture.destroy();dxRender_Visual::Release();
}

void RegisterWebFluidVolume(FHierrarhyVisual* parent,WebGPUFluidVolume* volume) {volumes.emplace_back(parent,volume);}
void UnloadWebFluidVolumes()
{
    // Linked level hierarchy nodes do not own their children. Remove our
    // attachments before context/sector teardown, then free each GPU handle.
    for (const auto& entry:volumes)
    {
        auto& children=entry.first->children;
        children.erase(std::remove(children.begin(),children.end(),entry.second),children.end());
        auto* volume=entry.second;volume->Release();xr_delete(volume);
    }
    volumes.clear();
}
}
#endif
