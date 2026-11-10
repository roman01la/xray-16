#pragma once

#ifdef XR_PLATFORM_WEB
#include "Layers/xrRender/FBasicVisual.h"

class IPhysicsElement;

namespace xray::render::RENDER_NAMESPACE
{
class FHierrarhyVisual;

// Browser adapter for the original version-3 fluid visual. Placement, profiles,
// visibility and physics remain engine-owned; the GPU backend owns simulation.
class WebGPUFluidVolume final : public dxRender_Visual
{
public:
    WebGPUFluidVolume() = default;
    ~WebGPUFluidVolume() override;
    void Load(LPCSTR name, IReader* data, u32 flags) override;
    void Render(CBackend& cmd_list, float lod, bool use_fast_geo) override;
    void Copy(dxRender_Visual* source) override;
    void Release() override;

private:
    struct Obstacle
    {
        Fmatrix gridToObstacle;
        Fvector massCenter;
        float pad0{};
        Fvector angularVelocity;
        float pad1{};
        Fvector translationVelocity;
        float pad2{};
    };
    void ParseProfile();
    void Register();
    void GatherObstacles(float timestep);
    void AddPhysicsElement(const IPhysicsElement& element, float timestep);
    Fvector CalculateLighting();

    u32 m_handle{};
    xr_string m_profile;
    Fmatrix m_transform;
    Fmatrix m_worldToGrid;
    Fmatrix m_gridToWorld;
    float m_settings[5]{};
    xr_vector<float> m_emitters;
    xr_vector<Fmatrix> m_staticObstacles;
    xr_vector<Obstacle> m_dynamicObstacles;
    xr_vector<ISpatial*> m_spatials;
    ref_texture m_fireTexture;
};

void RegisterWebFluidVolume(FHierrarhyVisual* parent, WebGPUFluidVolume* volume);
void UnloadWebFluidVolumes();
}
#endif
