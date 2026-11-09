#include "stdafx.h"

#ifdef XR_PLATFORM_WEB
#include <emscripten.h>
#include <emscripten/html5.h>
#endif

#include "xrCore/xr_token.h"
#include "xr_input.h"

xr_vector<xr_token> vid_monitor_token;
xr_map<u32, xr_vector<xr_token>> vid_mode_token;

#ifdef XR_PLATFORM_WEB
namespace
{
// One atomic stores both dimensions so the renderer sees a consistent pair.
std::atomic<u64> browserViewportSize{};
SDL_Point browserDisplaySize{1280, 720};

SDL_Point BrowserRenderSize(u64 viewport)
{
    const int width = psDeviceMode.Width;
    const int height = psDeviceMode.Height;
    const auto viewportWidth = u32(viewport >> 32);
    const auto viewportHeight = u32(viewport);
    if (!viewportWidth || !viewportHeight)
        return {width, height};

    const double scale = std::min(double(width) / viewportWidth, double(height) / viewportHeight);
    // Keep a usable render target even while dragging the window nearly closed.
    return {std::max(256, int(std::lround(viewportWidth * scale))),
            std::max(192, int(std::lround(viewportHeight * scale)))};
}

void TrackBrowserViewport()
{
    static bool initialized = false;
    if (initialized)
        return;
    initialized = true;

    u32 display[2]{};
    MAIN_THREAD_EM_ASM({
        // Screen dimensions are in CSS pixels; the browser does not expose
        // the display's actual hardware modes.
        const dpr = window.devicePixelRatio || 1;
        const index = $1 / 4;
        HEAPU32[index] = Math.round((window.screen.width || window.innerWidth) * dpr);
        HEAPU32[index + 1] = Math.round((window.screen.height || window.innerHeight) * dpr);

        const root = document.documentElement;
        if (!root.classList.contains('game-only'))
            return;
        const viewportIndex = $0 / 8;
        let lastSize = 0n;
        let publishedSize = 0n;
        const measure = (initial = false) => {
            const width = window.innerWidth;
            const height = window.innerHeight;
            if (!width || !height)
                return;
            const size = BigInt(width) << 32n | BigInt(height);
            if (size !== publishedSize && (initial || size === lastSize)) {
                growMemViews();
                Atomics.store(HEAPU64, viewportIndex, size);
                publishedSize = size;
            }
            lastSize = size;
        };
        // Some viewport changes while the game has focus deliver no resize
        // event. Wait for two equal samples before resetting GPU targets.
        measure(true);
        setInterval(measure, 150);
    }, double(uintptr_t(&browserViewportSize)), double(uintptr_t(display)));
    if (display[0] >= 640 && display[1] >= 480)
    {
        const double scale = std::min(1.0, 4096.0 / std::max(display[0], display[1]));
        browserDisplaySize = {int(std::lround(display[0] * scale)), int(std::lround(display[1] * scale))};
    }
}
} // namespace

SDL_Point GetBrowserDisplaySize()
{
    TrackBrowserViewport();
    return browserDisplaySize;
}

void UpdateBrowserViewport(CRenderDevice& device)
{
    static u64 lastViewportSize = 0;
    const u64 viewport = browserViewportSize.load(std::memory_order_relaxed);
    if (viewport == lastViewportSize)
        return;
    lastViewportSize = viewport;
    const auto size = BrowserRenderSize(viewport);
    if (size.x != int(device.dwWidth) || size.y != int(device.dwHeight))
        device.Reset(false);
}
#endif

#ifndef XR_PLATFORM_WEB
void FillResolutionsForMonitor(const int monitorID)
{
    const int modeCount = SDL_GetNumDisplayModes(monitorID);
    R_ASSERT3(modeCount > 0, "Failed to find display modes", SDL_GetError());

    for (int i = modeCount - 1; i >= 0; --i)
    {
        SDL_DisplayMode mode;
        const int result = SDL_GetDisplayMode(monitorID, i, &mode);
        R_ASSERT3(result == 0, "Failed to find specified display mode", SDL_GetError());

        string256 buf;
        xr_sprintf(buf, sizeof(buf), "%ux%u (%dHz)", mode.w, mode.h, mode.refresh_rate);
        vid_mode_token[monitorID].emplace_back(xr_strdup(buf), i);
    }

    vid_mode_token[monitorID].emplace_back(nullptr, -1);
}
#endif

void FillImGuiMonitorData(const int monitorID)
{
    ImGuiPlatformIO& platform_io = ImGui::GetPlatformIO();

    // Warning: the validity of monitor DPI information on Windows
    // depends on the application DPI awareness settings,
    // which generally needs to be set in the manifest or at runtime.
    ImGuiPlatformMonitor monitor;
    SDL_Rect r;
    SDL_GetDisplayBounds(monitorID, &r);
    monitor.MainPos = monitor.WorkPos = ImVec2((float)r.x, (float)r.y);
    monitor.MainSize = monitor.WorkSize = ImVec2((float)r.w, (float)r.h);

    SDL_GetDisplayUsableBounds(monitorID, &r);
    monitor.WorkPos = ImVec2((float)r.x, (float)r.y);
    monitor.WorkSize = ImVec2((float)r.w, (float)r.h);

    // FIXME-VIEWPORT: On MacOS SDL reports actual monitor DPI scale, ignoring OS configuration. We may want to set
    //  DpiScale to cocoa_window.backingScaleFactor here.
    float dpi = 0.0f;
    if (!SDL_GetDisplayDPI(monitorID, &dpi, nullptr, nullptr))
        monitor.DpiScale = dpi / 96.0f;

    monitor.PlatformHandle = (void*)(intptr_t)monitorID;
    platform_io.Monitors.push_back(monitor);
}

void CRenderDevice::FillVideoModes()
{
    ZoneScoped;

    const int displayCount = SDL_GetNumVideoDisplays();
    R_ASSERT3(displayCount > 0, "Failed to find display", SDL_GetError());

    for (int i = 0; i < displayCount; ++i)
    {
        string256 buf;
        xr_sprintf(buf, "%d. %s", i, SDL_GetDisplayName(i));
        vid_monitor_token.emplace_back(xr_strdup(buf), i);

#ifndef XR_PLATFORM_WEB
        FillResolutionsForMonitor(i);
#endif
        FillImGuiMonitorData(i);
    }
    vid_monitor_token.emplace_back(nullptr, -1);
}

void CRenderDevice::CleanupVideoModes()
{
    ZoneScoped;

    for (auto& [monitor_id, tokens] : vid_mode_token)
    {
        for (auto& token : tokens)
        {
            auto tokenName = const_cast<pstr>(token.name);
            xr_free(tokenName);
        }
        tokens.clear();
    }
    vid_mode_token.clear();

    for (auto& token : vid_monitor_token)
    {
        pstr tokenName = const_cast<pstr>(token.name);
        xr_free(tokenName);
    }
    vid_monitor_token.clear();

    ImGui::GetPlatformIO().Monitors.resize(0);
}

void CRenderDevice::SetWindowDraggable(bool draggable)
{
    // Only draggable if resizable too
    const bool windowed = psDeviceMode.WindowStyle == rsWindowed || psDeviceMode.WindowStyle == rsWindowedBorderless;
    const bool resizable = SDL_GetWindowFlags(Device.m_sdlWnd) & SDL_WINDOW_RESIZABLE;
    m_allowWindowDrag = draggable && windowed && resizable;

    SDL_SetWindowOpacity(Device.m_sdlWnd, m_allowWindowDrag ? 0.95f : 1.0f);
}

void CRenderDevice::UpdateWindowProps()
{
    ZoneScoped;

#ifdef XR_PLATFORM_WEB
    SelectResolution(true);
    SDL_SetWindowSize(m_sdlWnd, dwWidth, dwHeight);
    emscripten_set_canvas_element_size("#canvas", dwWidth, dwHeight);
    MAIN_THREAD_EM_ASM({
        // The DOM canvas is a placeholder for the worker's render canvas.
        Module['canvas'].style.setProperty('--game-aspect', String($0 / $1));
    }, dwWidth, dwHeight);
#else
    const bool windowed = psDeviceMode.WindowStyle != rsFullscreen;
    SelectResolution(windowed);

    // Changing monitor, unset fullscreen for the previous monitor
    // and move the window to the new monitor
    if (SDL_GetWindowDisplayIndex(m_sdlWnd) != static_cast<int>(psDeviceMode.Monitor))
    {
        SDL_SetWindowFullscreen(m_sdlWnd, SDL_DISABLE);

        SDL_Rect rect;
        SDL_GetDisplayBounds(psDeviceMode.Monitor, &rect);
        SDL_SetWindowPosition(m_sdlWnd, rect.x, rect.y);
    }

    if (psDeviceMode.WindowStyle != rsFullscreenBorderless)
        SDL_SetWindowSize(m_sdlWnd, psDeviceMode.Width, psDeviceMode.Height);
    else
    {
        SDL_DisplayMode current;
        SDL_GetCurrentDisplayMode(psDeviceMode.Monitor, &current);

        SDL_SetWindowSize(m_sdlWnd, current.w, current.h);
    }

    if (windowed)
    {
        const bool drawBorders = psDeviceMode.WindowStyle == rsWindowed;
        const bool useDesktopFullscreen = b_is_Ready && psDeviceMode.WindowStyle == rsFullscreenBorderless;

        SDL_SetWindowBordered(m_sdlWnd, drawBorders ? SDL_TRUE : SDL_FALSE);
        SDL_SetWindowResizable(m_sdlWnd, !useDesktopFullscreen ? SDL_TRUE : SDL_FALSE);
        SDL_SetWindowFullscreen(m_sdlWnd, useDesktopFullscreen ? SDL_WINDOW_FULLSCREEN_DESKTOP : SDL_DISABLE);
    }
    else if (b_is_Ready)
    {
        SDL_SetWindowResizable(m_sdlWnd, SDL_FALSE);
        SDL_SetWindowFullscreen(m_sdlWnd, SDL_WINDOW_FULLSCREEN);

        SDL_DisplayMode mode;
        SDL_GetWindowDisplayMode(m_sdlWnd, &mode);
        mode.w = psDeviceMode.Width;
        mode.h = psDeviceMode.Height;
        mode.refresh_rate = psDeviceMode.RefreshRate;
        SDL_SetWindowDisplayMode(m_sdlWnd, &mode);
    }
#endif

    SDL_PumpEvents();
    UpdateWindowRects();

    ImGuiIO& io = ImGui::GetIO();

#ifdef XR_PLATFORM_WEB
    io.DisplaySize = { static_cast<float>(dwWidth), static_cast<float>(dwHeight) };
#else
    io.DisplaySize = { static_cast<float>(psDeviceMode.Width), static_cast<float>(psDeviceMode.Height) };
#endif
    io.DisplayFramebufferScale = ImVec2{ float(dwWidth) / m_rcWindowClient.w, float(dwHeight) / m_rcWindowClient.h };
}

void CRenderDevice::UpdateWindowRects()
{
    m_rcWindowClient.x = 0;
    m_rcWindowClient.y = 0;
    SDL_GetWindowSize(m_sdlWnd, &m_rcWindowClient.w, &m_rcWindowClient.h);

    SDL_GetWindowPosition(m_sdlWnd, &m_rcWindowBounds.x, &m_rcWindowBounds.y);
    SDL_GetWindowSize(m_sdlWnd, &m_rcWindowBounds.w, &m_rcWindowBounds.h);

    int top = 0, left = 0, bottom = 0, right = 0;
    SDL_GetWindowBordersSize(m_sdlWnd, &top, &left, &bottom, &right);
    m_rcWindowBounds.x -= left;
    m_rcWindowBounds.y -= top;
    m_rcWindowBounds.w += right;
    m_rcWindowBounds.h += bottom;
}

void CRenderDevice::SelectResolution(const bool windowed)
{
#ifdef XR_PLATFORM_WEB
    psDeviceMode.Monitor = 0;
    psDeviceMode.WindowStyle = rsWindowedBorderless;
    psDeviceMode.RefreshRate = 0;
    const auto display = GetBrowserDisplaySize();
    if (psDeviceMode.Width == 0 || psDeviceMode.Height == 0)
    {
        // Start at up to 1080 lines, in the display's aspect ratio.
        psDeviceMode.Height = std::max(480, std::min(1080, display.y));
        psDeviceMode.Width = std::max(640, int(std::lround(double(display.x) * psDeviceMode.Height / display.y)));
    }
    const auto size = BrowserRenderSize(browserViewportSize.load(std::memory_order_relaxed));
    dwWidth = size.x;
    dwHeight = size.y;
    return;
#endif

    // Dedicated server hardcoded resolution
    // XXX: to be removed
    if (GEnv.isDedicatedServer || IsHeadlessAlifeHost())
    {
        psDeviceMode.Width = 640;
        psDeviceMode.Height = 480;
    }
    else if (psDeviceMode.Width == 0 && psDeviceMode.Height == 0 && psDeviceMode.RefreshRate == 0)
    {
        SDL_DisplayMode current;
        SDL_GetCurrentDisplayMode(psDeviceMode.Monitor, &current);
        psDeviceMode.Width = current.w;
        psDeviceMode.Height = current.h;
        psDeviceMode.RefreshRate = current.refresh_rate;
    }
    else if (!windowed) // check if safe for fullscreen
    {
        string256 buf;
        xr_sprintf(buf, "%ux%u (%dHz)", psDeviceMode.Width, psDeviceMode.Height, psDeviceMode.RefreshRate);

        auto modes = vid_mode_token[psDeviceMode.Monitor];
        const auto it = std::find_if(modes.begin(), modes.end(), [&buf](const xr_token& token)
        {
            return token.name && xr_strcmp(token.name, buf) == 0;
        });

        if (it == modes.end()) // not found
        {
            SDL_DisplayMode current =
            {
                SDL_PIXELFORMAT_UNKNOWN,
                (int)psDeviceMode.Width,
                (int)psDeviceMode.Height,
                (int)psDeviceMode.RefreshRate,
                nullptr
            };

            SDL_DisplayMode closest; // try closest or fallback to desktop mode
            if (!SDL_GetClosestDisplayMode(psDeviceMode.Monitor, &current, &closest))
            {
                SDL_GetCurrentDisplayMode(psDeviceMode.Monitor, &closest);
            }

            psDeviceMode.Width = closest.w;
            psDeviceMode.Height = closest.h;
            psDeviceMode.RefreshRate = closest.refresh_rate;
        }
    }

    dwWidth = psDeviceMode.Width;
    dwHeight = psDeviceMode.Height;
}

SDL_Window* CRenderDevice::GetApplicationWindow()
{
    return m_sdlWnd;
}

void CRenderDevice::OnErrorDialog(bool beforeDialog)
{
    const bool restore = !beforeDialog;
    const bool needUpdateInput = pInput && pInput->IsExclusiveMode();

    if (restore)
        UpdateWindowProps();
#ifndef XR_PLATFORM_WEB
    else
        SDL_SetWindowFullscreen(m_sdlWnd, SDL_FALSE);
#endif

    if (needUpdateInput)
        pInput->GrabInput(restore);
}

void CRenderDevice::OnFatalError()
{
    // make it sure window will hide in any way
    SDL_SetWindowFullscreen(m_sdlWnd, SDL_FALSE);
    SDL_SetWindowAlwaysOnTop(m_sdlWnd, SDL_FALSE);
    SDL_ShowWindow(m_sdlWnd);
    SDL_MinimizeWindow(m_sdlWnd);
    SDL_HideWindow(m_sdlWnd);
}
