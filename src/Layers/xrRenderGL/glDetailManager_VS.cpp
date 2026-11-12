#include "stdafx.h"
#include "Layers/xrRender/DetailManager.h"
#include "xrEngine/IGame_Persistent.h"
#include "xrEngine/Environment.h"
#include "Layers/xrRender/BufferUtils.h"
#ifdef XR_PLATFORM_WEB
#include <emscripten.h>
#endif

namespace xray::render::RENDER_NAMESPACE
{
namespace detail_manager
{
extern const int quant;
//extern const int c_hdr;
}

void CDetailManager::hw_Load_Shaders()
{
    // Create shader to access constant storage
    ref_shader S;
    S.create("details" DELIMITER "set");
    R_constant_table& T0 = *S->E[0]->passes[0]->constants;
    R_constant_table& T1 = *S->E[1]->passes[0]->constants;
    hwc_consts = T0.get("consts");
    hwc_wave = T0.get("wave");
    hwc_wind = T0.get("dir2D");
    hwc_array = T0.get("array");
    hwc_s_consts = T1.get("consts");
    hwc_s_xform = T1.get("xform");
    hwc_s_array = T1.get("array");
}

void CDetailManager::hw_Render(CBackend& cmd_list)
{
    using namespace detail_manager;

    // Render-prepare
    //	Update timer
    //	Can't use Device.fTimeDelta since it is smoothed! Don't know why, but smoothed value looks more choppy!
    float fDelta = Device.fTimeGlobal - m_global_time_old;
    if (fDelta < 0 || fDelta > 1)
        fDelta = 0.03f;
    m_global_time_old = Device.fTimeGlobal;

    m_time_rot_1 += PI_MUL_2 * fDelta / swing_current.rot1;
    m_time_rot_2 += PI_MUL_2 * fDelta / swing_current.rot2;
    m_time_pos += fDelta * swing_current.speed;

    //float		tm_rot1		= (PI_MUL_2*Device.fTimeGlobal/swing_current.rot1);
    //float		tm_rot2		= (PI_MUL_2*Device.fTimeGlobal/swing_current.rot2);
    float tm_rot1 = m_time_rot_1;
    float tm_rot2 = m_time_rot_2;

    Fvector4 dir1, dir2;
    dir1.set(_sin(tm_rot1), 0, _cos(tm_rot1), 0).normalize().mul(swing_current.amp1);
    dir2.set(_sin(tm_rot2), 0, _cos(tm_rot2), 0).normalize().mul(swing_current.amp2);

    // Setup geometry and DMA
    cmd_list.set_Geometry(hw_Geom);

#ifdef XR_PLATFORM_WEB
    // The calc task that writes these statistics was joined before Render.
    web_profileDetails = WebGPUDetailProfilingEnabled();
    if (web_grassStats.dispatches >= 100)
    {
        if (web_profileDetails)
            Msg("WEB_GRASS dispatches=%u eyeMoves=%u eyeMaxDelta=%.9f refreshed=%u skipped=%u"
                " scaleChanges=%u classChanges=%u refreshMs=%.3f still=%u wave1=%u wave2=%u",
                web_grassStats.dispatches, web_grassStats.eyeMoves, sqrtf(web_grassStats.eyeMaxDeltaSq),
                web_grassStats.refreshed, web_grassStats.skipped,
                web_grassStats.scaleChanges, web_grassStats.classChanges, web_grassStats.refreshMs,
                web_classInstances[0], web_classInstances[1], web_classInstances[2]);
        web_grassStats = {};
    }
    web_classInstances[0] = web_classInstances[1] = web_classInstances[2] = 0;

    // Prepare every material before the first consuming draw so gathers can
    // share a compute pass. Each batch retains its original draw order.
    {
        webPrepareOnly=true;
        const Fvector4 unused{};
        hw_Render_dump(cmd_list,unused,unused,unused,1,0);
        hw_Render_dump(cmd_list,unused,unused,unused,2,0);
        hw_Render_dump(cmd_list,unused,unused,unused,0,1);
        webPrepareOnly=false;
    }
#endif
    // Wave0
    float scale = 1.f / float(quant);
    Fvector4 wave;
    Fvector4 consts;
    consts.set(scale, scale, ps_r__Detail_l_aniso, ps_r__Detail_l_ambient);
    //wave.set				(1.f/5.f,		1.f/7.f,	1.f/3.f,	Device.fTimeGlobal*swing_current.speed);
    wave.set(1.f / 5.f, 1.f / 7.f, 1.f / 3.f, m_time_pos);
    //RCache.set_c			(&*hwc_consts,	scale,		scale,		ps_r__Detail_l_aniso,	ps_r__Detail_l_ambient);				// consts
    //RCache.set_c			(&*hwc_wave,	wave.div(PI_MUL_2));	// wave
    //RCache.set_c			(&*hwc_wind,	dir1);																					// wind-dir
    //hw_Render_dump			(&*hwc_array,	1, 0, c_hdr );
    hw_Render_dump(cmd_list, consts, wave.div(PI_MUL_2), dir1, 1, 0);

    // Wave1
    //wave.set				(1.f/3.f,		1.f/7.f,	1.f/5.f,	Device.fTimeGlobal*swing_current.speed);
    wave.set(1.f / 3.f, 1.f / 7.f, 1.f / 5.f, m_time_pos);
    //RCache.set_c			(&*hwc_wave,	wave.div(PI_MUL_2));	// wave
    //RCache.set_c			(&*hwc_wind,	dir2);																					// wind-dir
    //hw_Render_dump			(&*hwc_array,	2, 0, c_hdr );
    hw_Render_dump(cmd_list, consts, wave.div(PI_MUL_2), dir2, 2, 0);

    // Still
    consts.set(scale, scale, scale, 1.f);
    //RCache.set_c			(&*hwc_s_consts,scale,		scale,		scale,				1.f);
    //RCache.set_c			(&*hwc_s_xform,	Device.mFullTransform);
    //hw_Render_dump			(&*hwc_s_array,	0, 1, c_hdr );
    hw_Render_dump(cmd_list, consts, wave.div(PI_MUL_2), dir2, 0, 1);
}

void CDetailManager::hw_Render_dump(CBackend& cmd_list, const Fvector4& consts, const Fvector4& wave, const Fvector4& wind, u32 var_id,
                                    u32 lod_id)
{
    static shared_str strConsts("consts");
    static shared_str strWave("wave");
    static shared_str strDir2D("dir2D");
    static shared_str strArray("array");
    static shared_str strXForm("xform");

    RImplementation.BasicStats.DetailCount = 0;
#ifdef XR_PLATFORM_WEB
    const bool profileDetails = WebGPUDetailProfilingEnabled();
    double preparationMs = 0.0, submissionMs = 0.0;
    u32 packedInstances = 0, reusedBatches = 0, changedBatches = 0, membershipChanges = 0, contentChanges = 0;
#endif

    // Matrices and offsets
    u32 vOffset = 0;
    u32 iOffset = 0;

    vis_list& list = m_visibles [var_id];

    const auto& desc = g_pGamePersistent->Environment().CurrentEnv;
    Fvector c_sun, c_ambient, c_hemi;
    c_sun.set(desc.sun_color.x, desc.sun_color.y, desc.sun_color.z);
    c_sun.mul(.5f);
    c_ambient.set(desc.ambient.x, desc.ambient.y, desc.ambient.z);
    c_hemi.set(desc.hemi_color.x, desc.hemi_color.y, desc.hemi_color.z);

    // Iterate
    for (u32 O = 0; O < objects.size(); O++)
    {
        CDetail& Object = *objects [O];
        xr_vector<SlotItemVec*>& vis = list [O];
        if (!vis.empty())
        {
#ifdef XR_PLATFORM_WEB
            auto& batches = hw_instances[var_id];
            if (batches.size() < objects.size()) batches.resize(objects.size());
            auto& batch = batches[O];
            const double preparationStart = profileDetails ? emscripten_get_now() : 0.0;
            u32 instanceCount = batch.prepared.count;
            const u64 producerVersion = web_visibleState[var_id][O].version;
            const bool sameProducer = batch.producerVersion==producerVersion && batch.prepared.storage==hw_storageGeneration;
            const auto packRows = [&](SlotItemVec& items)
            {
                if (items.packedRevision == items.revision)
                    return;

                items.rows.resize(items.size() * 4);
                Fvector4* row = items.rows.data();
                for (const auto* instance : items)
                {
                    const float scale = instance->scale_calculated;
                    const Fmatrix& M = instance->mRotY;
                    (row++)->set(M._11 * scale, M._21 * scale, M._31 * scale, M._41);
                    (row++)->set(M._12 * scale, M._22 * scale, M._32 * scale, M._42);
                    (row++)->set(M._13 * scale, M._23 * scale, M._33 * scale, M._43);
                    (row++)->set(instance->c_sun, instance->c_sun, instance->c_sun, instance->c_hemi);
                }
                packedInstances += static_cast<u32>(items.size());
                items.packedRevision = items.revision;
            };

            if (ShadowOfChernobylMode && (!batch.buffer || !sameProducer))
            {
                // Keep instancing, but bypass the persistent GPU slot cache
                // and its compute gather for the SoC detail data.
                web_detailUploadRows.clear();
                for (auto* items : vis)
                {
                    packRows(*items);
                    web_detailUploadRows.insert(web_detailUploadRows.end(), items->rows.begin(), items->rows.end());
                }
                const auto bytes = static_cast<u32>(web_detailUploadRows.size() * sizeof(Fvector4));
                if (batch.buffer)
                    UploadWebGPUBuffer(batch.buffer, web_detailUploadRows.data(), bytes);
                else
                    CreateWebGPUBuffer(&batch.buffer, web_detailUploadRows.data(), bytes);
                instanceCount = static_cast<u32>(web_detailUploadRows.size() / 4);
                batch.prepared = {Device.dwFrame, hw_storageGeneration, instanceCount, web_visibilityGeneration};
                batch.producerVersion = producerVersion;
                ++changedBatches;
            }
            else if (!ShadowOfChernobylMode &&
                (!batch.buffer || (!sameProducer && !batch.prepared.matches(Device.dwFrame, web_visibilityGeneration, hw_storageGeneration))))
            {
                batch.descriptors.clear();
                batch.dirtySlots.clear();
                batch.dirtyRanges.clear();
                batch.dirtySignatureOffsets.clear();
                bool indicesChanged = batch.signature.size() != vis.size() * 3;
                batch.signature.resize(vis.size() * 3);
                u32 destination = 0, signatureOffset = 0;
                for (auto* items : vis)
                {
                    const u32 first = destination;
                    destination += static_cast<u32>(items->size());
                    items->visibleFrame = Device.dwFrame;
                    if (items->storageGeneration != hw_storageGeneration)
                    {
                        items->storageGeneration = hw_storageGeneration;
                        items->storageIndex = u32(-1);
                        items->uploadedRevision = u64(-1);
                    }
                    const u32 currentSignature = signatureOffset;
                    signatureOffset += 3;
                    indicesChanged |= xray::detail_cache::updateSignatureEntry(batch.signature.data() + currentSignature, *items);
                    if (!xray::detail_cache::needsUpload(*items))
                        continue;
                    packRows(*items);
                    batch.descriptors.push_back(static_cast<u32>(reinterpret_cast<uintptr_t>(items)));
                    batch.descriptors.push_back(static_cast<u32>(items->revision));
                    batch.descriptors.push_back(static_cast<u32>(items->revision >> 32));
                    batch.descriptors.push_back(static_cast<u32>(items->size()));
                    batch.descriptors.push_back(static_cast<u32>(reinterpret_cast<uintptr_t>(items->rows.data())));
                    batch.descriptors.push_back(static_cast<u32>(reinterpret_cast<uintptr_t>(&items->storageIndex)));
                    batch.descriptors.push_back(static_cast<u32>(reinterpret_cast<uintptr_t>(&items->visibleFrame)));
                    batch.dirtySlots.push_back(items);
                    batch.dirtySignatureOffsets.push_back(currentSignature);
                    batch.dirtyRanges.insert(batch.dirtyRanges.end(), {0, static_cast<u32>(items->size()), first, 0});
                }
                if (!batch.buffer) CreateWebGPUBuffer(&batch.buffer, nullptr, 0);
                const bool changed = !batch.dirtySlots.empty();
                if (changed)
                {
                    UpdateWebGPUDetailRecords(batch.buffer, batch.descriptors.data(), static_cast<u32>(batch.dirtySlots.size()), vis.data(), static_cast<u32>(vis.size()));
                    for (u32 i = 0; i < batch.dirtySlots.size(); ++i)
                    {
                        auto* items = batch.dirtySlots[i];
                        items->uploadedRevision = items->revision;
                        batch.dirtyRanges[i * 4] = items->storageIndex;
                        // Upload can allocate or relocate this source range. Other
                        // visible ranges are protected from eviction by the upload.
                        indicesChanged |= xray::detail_cache::updateSignatureEntry(
                            batch.signature.data() + batch.dirtySignatureOffsets[i], *items);
                    }
                }
                instanceCount = destination;
                if (indicesChanged)
                {
                    batch.indices.resize(vis.size()*4);
                    u32* range = batch.indices.data();
                    u32 first = 0;
                    for (const auto* items : vis)
                    {
                        *range++ = items->storageIndex;
                        *range++ = static_cast<u32>(items->size());
                        *range++ = first;
                        *range++ = 0;
                        first += static_cast<u32>(items->size());
                    }
                }
                if (indicesChanged)
                    GatherWebGPUDetailRanges(batch.buffer, batch.indices.data(), static_cast<u32>(vis.size()), instanceCount, true, false);
                else if (changed)
                    // Membership is unchanged: retain all unaffected output records.
                    GatherWebGPUDetailRanges(batch.buffer, batch.dirtyRanges.data(), static_cast<u32>(batch.dirtySlots.size()), instanceCount, true, true);
                changedBatches += changed || indicesChanged;
                reusedBatches += !changed && !indicesChanged;
                membershipChanges += indicesChanged;
                contentChanges += changed;
                batch.prepared = {Device.dwFrame, hw_storageGeneration, instanceCount, web_visibilityGeneration};
                batch.producerVersion=producerVersion;
            }
            else
                ++reusedBatches;
            if (profileDetails) preparationMs += emscripten_get_now() - preparationStart;
            if (!webPrepareOnly) web_classInstances[var_id] += instanceCount;
#endif
#ifdef XR_PLATFORM_WEB
            if (!webPrepareOnly)
#endif
            for (u32 iPass = 0; iPass < Object.shader->E[lod_id]->passes.size(); ++iPass)
            {
                // Setup matrices + colors (and flush it as necessary)
                //RCache.set_Element				(Object.shader->E[lod_id]);
                cmd_list.set_Element(Object.shader->E[lod_id], iPass);
                cmd_list.apply_lmaterial();

                //	This could be cached in the corresponding consatant buffer
                //	as it is done for DX9
                cmd_list.set_c(strConsts, consts);
                cmd_list.set_c(strWave, wave);
                cmd_list.set_c(strDir2D, wind);
                cmd_list.set_c(strXForm, Device.mFullTransform);

#ifdef XR_PLATFORM_WEB
                if (instanceCount)
                {
                    const double submissionStart = profileDetails ? emscripten_get_now() : 0.0;
                    cmd_list.RenderDetails(batch.buffer, instanceCount, vOffset, Object.number_vertices,
                        iOffset, Object.number_indices / 3);
                    if (profileDetails) submissionMs += emscripten_get_now() - submissionStart;
                    RImplementation.BasicStats.DetailCount += instanceCount;
                    cmd_list.stat.r.s_details.add(instanceCount * Object.number_vertices);
                }
#else
                ref_constant constArray = cmd_list.get_c(strArray);
                VERIFY(constArray);

                //u32			c_base				= x_array->vs.index;
                //Fvector4*	c_storage			= RCache.get_ConstantCache_Vertex().get_array_f().access(c_base);
                // TODO: OGL: Implement a constants buffer.
                /*Fvector4*	c_storage=0;
                //	Map constants to memory directly
                {
                    void*	pVData;
                    RCache.get_ConstantDirect( strArray,
                        hw_BatchSize*sizeof(Fvector4)*4,
                        &pVData, 0, 0);
                    c_storage = (Fvector4*) pVData;
                }
                VERIFY(c_storage);*/

#ifdef XR_PLATFORM_WEB
                // Upload one contiguous instance array per draw instead of crossing
                // the Wasm/JavaScript boundary for each of its four-vector rows.
                static thread_local xr_vector<Fvector4> instanceRows;
                instanceRows.resize(hw_BatchSize * 4);
#endif
                u32 dwBatch = 0;

                for (auto items : vis)
                {
                    for (auto& instance : *items)
                    {
                        u32 base = dwBatch * 4;

                        // Build matrix ( 3x4 matrix, last row - color )
                        float scale = instance->scale_calculated;
                        Fmatrix& M = instance->mRotY;
#ifdef XR_PLATFORM_WEB
                        instanceRows[base + 0].set(M._11 * scale, M._21 * scale, M._31 * scale, M._41);
                        instanceRows[base + 1].set(M._12 * scale, M._22 * scale, M._32 * scale, M._42);
                        instanceRows[base + 2].set(M._13 * scale, M._23 * scale, M._33 * scale, M._43);
                        instanceRows[base + 3].set(instance->c_sun, instance->c_sun, instance->c_sun, instance->c_hemi);
#else
                        cmd_list.set_ca(&*constArray, base + 0, M._11 * scale, M._21 * scale, M._31 * scale, M._41);
                        cmd_list.set_ca(&*constArray, base + 1, M._12 * scale, M._22 * scale, M._32 * scale, M._42);
                        cmd_list.set_ca(&*constArray, base + 2, M._13 * scale, M._23 * scale, M._33 * scale, M._43);

                        // Build color
                        // R2 only needs hemisphere
                        float h = instance->c_hemi;
                        float s = instance->c_sun;
                        cmd_list.set_ca(&*constArray, base + 3, s, s, s, h);
#endif
                        dwBatch ++;
                        if (dwBatch == hw_BatchSize)
                        {
                            // flush
                            RImplementation.BasicStats.DetailCount += dwBatch;
                            u32 dwCNT_verts = dwBatch * Object.number_vertices;
                            u32 dwCNT_prims = dwBatch * Object.number_indices / 3;
                            //RCache.get_ConstantCache_Vertex().b_dirty				=	TRUE;
                            //RCache.get_ConstantCache_Vertex().get_array_f().dirty	(c_base,c_base+dwBatch*4);
#ifdef XR_PLATFORM_WEB
                            cmd_list.set_ca(&*constArray, 0, instanceRows.data(), dwBatch * 4);
#endif
                            cmd_list.Render(D3DPT_TRIANGLELIST, vOffset, 0, dwCNT_verts, iOffset, dwCNT_prims);
                            cmd_list.stat.r.s_details.add(dwCNT_verts);

                            // restart
                            dwBatch = 0;

                            //	Remap constants to memory directly (just in case anything goes wrong)
                            /*{
                                void*	pVData;
                                RCache.get_ConstantDirect( strArray,
                                    hw_BatchSize*sizeof(Fvector4)*4,
                                    &pVData, 0, 0);
                                c_storage = (Fvector4*) pVData;
                            }
                            VERIFY(c_storage);*/
                        }
                    }
                }
                // flush if nessecary
                if (dwBatch)
                {
                    RImplementation.BasicStats.DetailCount += dwBatch;
                    u32 dwCNT_verts = dwBatch * Object.number_vertices;
                    u32 dwCNT_prims = dwBatch * Object.number_indices / 3;
                    //RCache.get_ConstantCache_Vertex().b_dirty				=	TRUE;
                    //RCache.get_ConstantCache_Vertex().get_array_f().dirty	(c_base,c_base+dwBatch*4);
#ifdef XR_PLATFORM_WEB
                    cmd_list.set_ca(&*constArray, 0, instanceRows.data(), dwBatch * 4);
#endif
                    cmd_list.Render(D3DPT_TRIANGLELIST, vOffset, 0, dwCNT_verts, iOffset, dwCNT_prims);
                    cmd_list.stat.r.s_details.add(dwCNT_verts);
                }
#endif
            }
        }
        vOffset += hw_BatchSize * Object.number_vertices;
        iOffset += hw_BatchSize * Object.number_indices;
    }
#ifdef XR_PLATFORM_WEB
    if (profileDetails) EM_ASM({ globalThis.__xrayWebGPU.recordDetailTimings($0, $1, $2, $3, $4, $5, $6); },
        preparationMs, submissionMs, packedInstances, reusedBatches, changedBatches, membershipChanges, contentChanges);
#endif
}
} // namespace xray::render::RENDER_NAMESPACE
