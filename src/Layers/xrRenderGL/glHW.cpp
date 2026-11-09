// glHW.cpp: implementation of the OpenGL specialisation of CHW.
//////////////////////////////////////////////////////////////////////

#include "stdafx.h"
#include "Layers/xrRender/BufferUtils.h"
#pragma hdrstop

#include "glHW.h"
#include "xrEngine/XR_IOConsole.h"

namespace xray::render::RENDER_NAMESPACE
{
CHW HW;

void CALLBACK OnDebugCallback(GLenum /*source*/, GLenum /*type*/, GLuint id, GLenum severity, GLsizei /*length*/,
    const GLchar* message, const void* /*userParam*/)
{
    if (severity != GL_DEBUG_SEVERITY_NOTIFICATION)
        Log(message, id);
}

static_assert(std::is_same_v<decltype(&OnDebugCallback), GLDEBUGPROC>);

void UpdateVSync()
{
#ifdef XR_PLATFORM_WEB
    return; // presentation is paced by the browser
#endif
    if (psDeviceFlags.test(rsVSync))
    {
        // Try adaptive vsync first
        if (SDL_GL_SetSwapInterval(-1) == -1)
            SDL_GL_SetSwapInterval(1);
    }
    else
    {
        SDL_GL_SetSwapInterval(0);
    }
}

CHW::CHW()
{
    if (!ThisInstanceIsGlobal())
        return;

    Device.seqAppActivate.Add(this);
    Device.seqAppDeactivate.Add(this);
}

CHW::~CHW()
{
    if (!ThisInstanceIsGlobal())
        return;

    Device.seqAppActivate.Remove(this);
    Device.seqAppDeactivate.Remove(this);
}

void CHW::OnAppActivate()
{
    if (m_window)
    {
        SDL_RestoreWindow(m_window);
    }
}

void CHW::OnAppDeactivate()
{
    if (m_window)
    {
        if (psDeviceMode.WindowStyle == rsFullscreen || psDeviceMode.WindowStyle == rsFullscreenBorderless)
            SDL_MinimizeWindow(m_window);
    }
}

//////////////////////////////////////////////////////////////////////
// Construction/Destruction
//////////////////////////////////////////////////////////////////////
void CHW::CreateDevice(SDL_Window* hWnd)
{
    ZoneScoped;

    m_window = hWnd;

    R_ASSERT(m_window);

    // Choose the closest pixel format
    SDL_DisplayMode mode;
    SDL_GetWindowDisplayMode(m_window, &mode);
    mode.format = SDL_PIXELFORMAT_RGBA8888;
    // Apply the pixel format to the device context
    SDL_SetWindowDisplayMode(m_window, &mode);

    Caps.fTarget = D3DFMT_A8R8G8B8;
    Caps.fDepth = D3DFMT_D24S8;

    // Create the context
#ifdef XR_PLATFORM_WEB
    const int version = 1;
    R_ASSERT2(InitializeNativeWebGPU(), "Native WebGPU initialization failed");
    m_nativeContext = 1; // Engine context ownership marker, not a WebGL handle.
    AdapterName = "Native WebGPU";
    OpenGLVersionString = "WebGPU";
    ShadingVersion = "WGSL";
    TextureUploadUnit = 31;
    ComputeShadersSupported = false;
    UpdateViews();
    return;

#else
    m_context = SDL_GL_CreateContext(m_window);
    if (m_context == nullptr)
    {
        Log("! OpenGL: could not create drawing context:", SDL_GetError());
        return;
    }

    if (MakeContextCurrent(IRender::PrimaryContext) != 0)
    {
        Log("! OpenGL: could not make context current:", SDL_GetError());
        return;
    }

    int version;
    {
        ZoneScopedN("gladLoadGL");
        version = gladLoadGL(reinterpret_cast<GLADloadfunc>(SDL_GL_GetProcAddress));
    }
#endif
    if (version == 0)
    {
        Log("! OpenGL: could not initialize GLAD.");
        if (const auto err = SDL_GetError())
            Log("SDL Error:", err);
        return;
    }

    if (ThisInstanceIsGlobal())
    {
        UpdateVSync();

#ifdef DEBUG
        if (glDebugMessageCallback)
        {
            CHK_GL(glEnable(GL_DEBUG_OUTPUT));
            CHK_GL(glDebugMessageCallback((GLDEBUGPROC)OnDebugCallback, nullptr));
        }
#endif // DEBUG
    }

    int iMaxVTFUnits, iMaxCTIUnits;
    glGetIntegerv(GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS, &iMaxVTFUnits);
    glGetIntegerv(GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS, &iMaxCTIUnits);

    AdapterName = reinterpret_cast<pcstr>(glGetString(GL_RENDERER));
    OpenGLVersionString = reinterpret_cast<pcstr>(glGetString(GL_VERSION));
    ShadingVersion = reinterpret_cast<pcstr>(glGetString(GL_SHADING_LANGUAGE_VERSION));

    Msg("* GPU vendor: [%s] device: [%s]", glGetString(GL_VENDOR), AdapterName);
    Msg("* GPU OpenGL version: %s", OpenGLVersionString);
    Msg("* GPU OpenGL shading language version: %s", ShadingVersion);
    Msg("* GPU OpenGL VTF units: [%d] CTI units: [%d]", iMaxVTFUnits, iMaxCTIUnits);

#ifdef XR_PLATFORM_WEB
    TextureUploadUnit = u32(iMaxCTIUnits) - 1;
    R_ASSERT2(TextureUploadUnit >= CTexture::rstVertex + CTexture::mtMaxVertexShaderTextures,
        "too few texture units for a dedicated upload unit");
#endif

    ComputeShadersSupported = false; // XXX: Implement compute shaders support

    if (glGenFramebuffers && glBindFramebuffer)
        UpdateViews();
}

void CHW::DestroyDevice()
{
#ifdef XR_PLATFORM_WEB
    DeleteNativeWebGPUObjects(1, 1, &pFB);
#else
    CHK_GL(glDeleteFramebuffers(1, &pFB));
#endif
    pFB = 0;

#ifdef XR_PLATFORM_WEB
    // Native WebGPU owns the device and canvas context.
    m_nativeContext = 0;
    return;
#endif

    const auto context = SDL_GL_GetCurrentContext();
    if (context == m_context)
        SDL_GL_MakeCurrent(nullptr, nullptr);

    SDL_GL_DeleteContext(m_context);
    m_context = nullptr;
}

//////////////////////////////////////////////////////////////////////
// Resetting device
//////////////////////////////////////////////////////////////////////
void CHW::Reset()
{
    ZoneScoped;

#ifdef XR_PLATFORM_WEB
    DeleteNativeWebGPUObjects(1, 1, &pFB);
#else
    CHK_GL(glDeleteFramebuffers(1, &pFB));
#endif
    pFB = 0;
    UpdateViews();

    UpdateVSync();
}

void CHW::SetPrimaryAttributes(u32& windowFlags)
{
#ifdef XR_PLATFORM_WEB
    return; // WebGPU owns the canvas; SDL is used for input/window events
#endif
    windowFlags |= SDL_WINDOW_OPENGL;

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);

    SDL_GL_SetAttribute(SDL_GL_RED_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE, 8);
    SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE, 8);

    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);
    SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
    SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE, 8);

    if (!strstr(Core.Params, "-no_gl_context"))
    {
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 4);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 1);
    }
}

IRender::RenderContext CHW::GetCurrentContext() const
{
#ifdef XR_PLATFORM_WEB
    if (m_nativeContext)
        return IRender::PrimaryContext;
    return IRender::NoContext;
#else
    const auto context = SDL_GL_GetCurrentContext();
    if (context == m_context)
        return IRender::PrimaryContext;
    return IRender::NoContext;
#endif
}

int CHW::MakeContextCurrent(IRender::RenderContext context) const
{
    switch (context)
    {
#ifdef XR_PLATFORM_WEB
    case IRender::NoContext:
        return 0;

    case IRender::PrimaryContext:
        return m_nativeContext ? 0 : -1;
#else
    case IRender::NoContext:
        return SDL_GL_MakeCurrent(nullptr, nullptr);

    case IRender::PrimaryContext:
        return SDL_GL_MakeCurrent(m_window, m_context);
#endif

    default:
        NODEFAULT;
    }
    return -1;
}

void CHW::UpdateViews()
{
#ifdef XR_PLATFORM_WEB
    pFB = CreateNativeWebGPUObject(1);
    BindNativeWebGPUFramebuffer(pFB);
#else
    glGenFramebuffers(1, &pFB);
    CHK_GL(glBindFramebuffer(GL_FRAMEBUFFER, pFB));
#endif

    BackBufferCount = 1;
}

void CHW::BeginScene() { }
void CHW::EndScene() { }

void CHW::Present()
{
#if 0 // kept for historical reasons
    RImplementation.Target->phase_flip();
#else
#ifdef XR_PLATFORM_WEB
    PresentWebGPU(pFB, Device.dwWidth, Device.dwHeight);
#else
    {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, pFB);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
    glBlitFramebuffer(
        0, 0, Device.dwWidth, Device.dwHeight,
        0, 0, Device.dwWidth, Device.dwHeight,
        GL_COLOR_BUFFER_BIT, GL_NEAREST);
    }
#endif
#endif

#ifndef XR_PLATFORM_WEB
    SDL_GL_SwapWindow(m_window); // on the web the frame is presented when the loop callback returns
#endif
    CurrentBackBuffer = (CurrentBackBuffer + 1) % BackBufferCount;
}

DeviceState CHW::GetDeviceState() const
{
    //  TODO: OGL: Implement GetDeviceState
    return DeviceState::Normal;
}

std::pair<u32, u32> CHW::GetSurfaceSize()
{
#ifdef XR_PLATFORM_WEB
    return {Device.dwWidth, Device.dwHeight};
#else
    return
    {
        psDeviceMode.Width,
        psDeviceMode.Height
    };
#endif
}

bool CHW::ThisInstanceIsGlobal() const
{
    return this == &HW;
}

void CHW::BeginPixEvent(pcstr name) const
{
#ifndef XR_PLATFORM_WEB
    if (glPushDebugGroup)
        glPushDebugGroup(GL_DEBUG_SOURCE_APPLICATION, 0, -1, name);
#endif
}

void CHW::EndPixEvent() const
{
#ifndef XR_PLATFORM_WEB
    if (glPushDebugGroup)
        glPopDebugGroup();
#endif
}
} // namespace xray::render::RENDER_NAMESPACE

#ifdef XR_PLATFORM_WEB
namespace xray::render::RENDER_NAMESPACE
{
texture_upload_unit::texture_upload_unit(GLenum target) : target(target)
{
    // Uploads use explicit native texture handles.
}

texture_upload_unit::~texture_upload_unit()
{
    // No binding state to restore.
}
} // namespace xray::render::RENDER_NAMESPACE
#endif
