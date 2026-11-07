#include "stdafx.h"

#include "dxImGuiRender.h"
#ifdef XR_PLATFORM_WEB
#include "BufferUtils.h"
#include <emscripten.h>
#endif

#if defined(USE_DX11)
#include <backends/imgui_impl_dx11.h>
#elif defined(USE_OGL) && !defined(XR_PLATFORM_WEB)
#include <backends/imgui_impl_opengl3.h>
#endif

namespace xray::render::RENDER_NAMESPACE
{
#ifdef XR_PLATFORM_WEB
EM_JS(void, BeginNativeImGuiList, (const void* vertices, unsigned vertexBytes, const void* indices, unsigned indexBytes, unsigned indexSize, float x, float y, float width, float height, float scaleX, float scaleY), {
    globalThis.__xrayWebGPU.beginNativeUIList(HEAPU8.subarray(Number(vertices), Number(vertices)+vertexBytes), HEAPU8.subarray(Number(indices), Number(indices)+indexBytes), indexSize, [x,y,width,height,scaleX,scaleY]);
});
EM_JS(void, DrawNativeImGui, (unsigned texture, unsigned count, unsigned first, unsigned base, int x, int y, int width, int height), {
    globalThis.__xrayWebGPU.drawNativeUI(globalThis.__xrayWebGPUHandles.textures[texture], count, first, base, [x,y,width,height]);
});
EM_JS(void, EndNativeImGuiList, (), { globalThis.__xrayWebGPU.endNativeUIList(); });
static void UpdateNativeImGuiTexture(ImTextureData* tex)
{
    if (tex->Status == ImTextureStatus_WantDestroy)
    {
        const GLuint id = static_cast<GLuint>(tex->TexID);
        DeleteWebGPUTextures(1, &id);
        tex->SetTexID(ImTextureID_Invalid);
        tex->SetStatus(ImTextureStatus_Destroyed);
    }
    else if (tex->Status == ImTextureStatus_WantCreate || tex->Status == ImTextureStatus_WantUpdates)
    {
        R_ASSERT(tex->Format == ImTextureFormat_RGBA32);
        GLuint id = static_cast<GLuint>(tex->TexID);
        if (tex->Status == ImTextureStatus_WantCreate)
            CreateWebGPUTexture(&id, GL_TEXTURE_2D, 1, GL_RGBA8, tex->Width, tex->Height);
        UploadWebGPUTexture(id, GL_TEXTURE_2D, 0, tex->Width, tex->Height, 1, GL_RGBA, GL_UNSIGNED_BYTE, false, tex->Pixels, tex->Width * tex->Height * 4);
        tex->SetTexID(id);
        tex->SetStatus(ImTextureStatus_OK);
    }
}
static void DestroyNativeImGuiTextures()
{
    for (auto* tex : ImGui::GetPlatformIO().Textures)
        if (tex->RefCount == 1 && tex->TexID != ImTextureID_Invalid)
        {
            tex->SetStatus(ImTextureStatus_WantDestroy);
            UpdateNativeImGuiTexture(tex);
        }
}
#endif

void dxImGuiRender::Copy(IImGuiRender& _in)
{
    *this = *dynamic_cast<dxImGuiRender*>(&_in);
}

void dxImGuiRender::SetState(ImDrawData* data)
{
    RCache.SetViewport({ 0.f, 0.f, data->DisplaySize.x, data->DisplaySize.y, 0.f, 1.f });

    // Setup shader and vertex buffers
    /*unsigned int stride = sizeof(ImDrawVert);
    unsigned int offset = 0;
    ctx->IASetInputLayout(bd->pInputLayout);
    ctx->IASetVertexBuffers(0, 1, &bd->pVB, &stride, &offset);
    ctx->IASetIndexBuffer(bd->pIB, sizeof(ImDrawIdx) == 2 ? DXGI_FORMAT_R16_UINT : DXGI_FORMAT_R32_UINT, 0);
    ctx->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ctx->VSSetShader(bd->pVertexShader, nullptr, 0);
    ctx->VSSetConstantBuffers(0, 1, &bd->pVertexConstantBuffer);
    ctx->PSSetShader(bd->pPixelShader, nullptr, 0);
    ctx->PSSetSamplers(0, 1, &bd->pFontSampler);
    ctx->GSSetShader(nullptr, nullptr, 0);
    ctx->HSSetShader(nullptr, nullptr, 0); // In theory we should backup and restore this as well.. very infrequently used..
    ctx->DSSetShader(nullptr, nullptr, 0); // In theory we should backup and restore this as well.. very infrequently used..
    ctx->CSSetShader(nullptr, nullptr, 0); // In theory we should backup and restore this as well.. very infrequently used..

    // Setup blend state
    const float blend_factor[4] = { 0.f, 0.f, 0.f, 0.f };
    ctx->OMSetBlendState(bd->pBlendState, blend_factor, 0xffffffff);
    ctx->OMSetDepthStencilState(bd->pDepthStencilState, 0);
    ctx->RSSetState(bd->pRasterizerState);*/
}

void dxImGuiRender::Frame()
{
#if defined(USE_DX11)
    ImGui_ImplDX11_NewFrame();
#elif defined(XR_PLATFORM_WEB)
    // Dynamic textures are uploaded with the draw data.
#elif defined(USE_OGL)
    ImGui_ImplOpenGL3_NewFrame();
#endif
}

void dxImGuiRender::Render(ImDrawData* data)
{
#ifdef XR_PLATFORM_WEB
    if (data->Textures)
        for (auto* tex : *data->Textures)
            if (tex->Status != ImTextureStatus_OK) UpdateNativeImGuiTexture(tex);
    if (data->DisplaySize.x <= 0 || data->DisplaySize.y <= 0) return;
    static_assert(sizeof(ImDrawVert) == 20);
    for (const ImDrawList* list : data->CmdLists)
    {
        BeginNativeImGuiList(list->VtxBuffer.Data, list->VtxBuffer.Size * sizeof(ImDrawVert),
            list->IdxBuffer.Data, list->IdxBuffer.Size * sizeof(ImDrawIdx), sizeof(ImDrawIdx),
            data->DisplayPos.x, data->DisplayPos.y, data->DisplaySize.x, data->DisplaySize.y,
            data->FramebufferScale.x, data->FramebufferScale.y);
        for (const ImDrawCmd& cmd : list->CmdBuffer)
        {
            if (cmd.UserCallback)
            {
                EndNativeImGuiList();
                if (cmd.UserCallback != ImDrawCallback_ResetRenderState) cmd.UserCallback(list, &cmd);
                continue;
            }
            const int x = _max(0, int((cmd.ClipRect.x - data->DisplayPos.x) * data->FramebufferScale.x));
            const int y = _max(0, int((cmd.ClipRect.y - data->DisplayPos.y) * data->FramebufferScale.y));
            const int right = _min(int(data->DisplaySize.x * data->FramebufferScale.x), int((cmd.ClipRect.z - data->DisplayPos.x) * data->FramebufferScale.x));
            const int bottom = _min(int(data->DisplaySize.y * data->FramebufferScale.y), int((cmd.ClipRect.w - data->DisplayPos.y) * data->FramebufferScale.y));
            if (right > x && bottom > y)
                DrawNativeImGui(static_cast<GLuint>(cmd.GetTexID()), cmd.ElemCount, cmd.IdxOffset, cmd.VtxOffset, x, y, right-x, bottom-y);
        }
        EndNativeImGuiList();
    }
    return;
#endif

#if defined(USE_DX11)
    ImGui_ImplDX11_RenderDrawData(data);
#elif defined(USE_OGL) && !defined(XR_PLATFORM_WEB)
    ImGui_ImplOpenGL3_RenderDrawData(data);
#endif
}

void dxImGuiRender::OnDeviceCreate(ImGuiContext* context)
{
    ImGui::SetAllocatorFunctions(
        [](size_t size, void* /*user_data*/)
        {
            return xr_malloc(size);
        },
        [](void* ptr, void* /*user_data*/)
        {
            xr_free(ptr);
        }
    );
    ImGui::SetCurrentContext(context);

    ImGuiIO& io = ImGui::GetIO();
    io.BackendRendererName = "xrRender";

#if defined(USE_DX11)
    ImGui_ImplDX11_Init(HW.pDevice, HW.get_context(CHW::IMM_CTX_ID));
#elif defined(XR_PLATFORM_WEB)
    io.BackendRendererName = "xrRender-WebGPU";
    io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures | ImGuiBackendFlags_RendererHasVtxOffset;
#elif defined(USE_OGL)
    ImGui_ImplOpenGL3_Init();
#endif
}
void dxImGuiRender::OnDeviceDestroy()
{
#if defined(USE_DX11)
    ImGui_ImplDX11_Shutdown();
#elif defined(XR_PLATFORM_WEB)
    DestroyNativeImGuiTextures();
    ImGui::GetIO().BackendRendererName = nullptr;
    ImGui::GetIO().BackendFlags &= ~(ImGuiBackendFlags_RendererHasTextures | ImGuiBackendFlags_RendererHasVtxOffset);
#elif defined(USE_OGL)
    ImGui_ImplOpenGL3_Shutdown();
#endif
}

void dxImGuiRender::OnDeviceResetBegin()
{
#if defined(USE_DX11)
    ImGui_ImplDX11_InvalidateDeviceObjects();
#elif defined(XR_PLATFORM_WEB)
    DestroyNativeImGuiTextures();
#elif defined(USE_OGL)
    ImGui_ImplOpenGL3_DestroyDeviceObjects();
#endif
}

void dxImGuiRender::OnDeviceResetEnd()
{
#if defined(USE_DX11)
    ImGui_ImplDX11_CreateDeviceObjects();
#elif defined(USE_OGL) && !defined(XR_PLATFORM_WEB)
    ImGui_ImplOpenGL3_CreateDeviceObjects();
#endif
}
} // namespace xray::render::RENDER_NAMESPACE
