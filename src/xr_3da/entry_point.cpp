#include "stdafx.h"

#include "xrEngine/x_ray.h"
#include "xrGame/xrGame.h"
#include "Include/xrRender/xrRender.h"

#if !defined(XR_PLATFORM_WINDOWS)
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <getopt.h>
#endif

#if defined(XR_PLATFORM_WEB)
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <utime.h>
#include "../../misc/web/streaming/mount.h"
#endif

#if defined(XR_PLATFORM_WEB)
static void RestoreBrowserSaveTimes()
{
    const int size = MAIN_THREAD_EM_ASM_INT({
        return Module['xraySaveTimes']?.length || 0;
    });
    if (size <= 0)
        return;

    std::string entries(size, '\0');
    MAIN_THREAD_EM_ASM({
        growMemViews();
        HEAPU8.set(Module['xraySaveTimes'], $0);
        delete Module['xraySaveTimes'];
    }, double(uintptr_t(entries.data())));

    // Seed the mount's stat data before the engine indexes the files. New
    // writes update stat normally, and a reload reads the OPFS times again.
    const char* end = entries.data() + entries.size();
    for (const char* entry = entries.data(); entry < end;)
    {
        const char* next = std::strchr(entry, '\0') + 1;
        char* path = nullptr;
        const time_t seconds = std::strtoll(entry, &path, 10);
        if (seconds > 0 && *path == '\t')
        {
            const utimbuf times{seconds, seconds};
            utime(path + 1, &times);
        }
        entry = next;
    }
}
#endif

// Always request high performance GPU
extern "C"
{
// https://docs.nvidia.com/gameworks/content/technologies/desktop/optimus.htm
XR_EXPORT u32 NvOptimusEnablement = 0x00000001; // NVIDIA Optimus

// https://gpuopen.com/amdpowerxpressrequesthighperformance/
XR_EXPORT u32 AmdPowerXpressRequestHighPerformance = 0x00000001; // PowerXpress or Hybrid Graphics
}

std::array<RendererModule*, 2> s_render_modules =
{
#ifdef XR_PLATFORM_WINDOWS
    xray::render::render_r4::GetRendererModule(),
#endif
    xray::render::render_gl::GetRendererModule(),
};

struct tracy_raii
{
    ~tracy_raii()
    {
#ifdef TRACY_ENABLE
        tracy::GetProfiler().RequestShutdown();
        while (!tracy::GetProfiler().HasShutdownFinished())
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
#endif
    }
};

static bool has_flag(pcstr commandLine, pcstr flag)
{
    const auto length = strlen(flag);
    for (auto* found = strstr(commandLine, flag); found; found = strstr(found + length, flag))
    {
        if ((found == commandLine || found[-1] == ' ') && (found[length] == '\0' || found[length] == ' '))
            return true;
    }
    return false;
}

int entry_point(pcstr commandLine)
{
    tracy_raii raii;
    auto* game = has_flag(commandLine, "-nogame") ? nullptr : &xrGame;

#if defined(XR_PLATFORM_WEB)
    auto* app = xr_new<CApplication>(commandLine, game, s_render_modules);
    return app->Run();
#else
    CApplication app{ commandLine, game, s_render_modules };

    return app.Run();
#endif
}

#if defined(XR_PLATFORM_WINDOWS)
int StackoverflowFilter(const int exceptionCode)
{
    if (exceptionCode == EXCEPTION_STACK_OVERFLOW)
        return EXCEPTION_EXECUTE_HANDLER;
    return EXCEPTION_CONTINUE_SEARCH;
}

int APIENTRY WinMain(HINSTANCE inst, HINSTANCE prevInst, char* commandLine, int cmdShow)
{
    int result = 0;
    // BugTrap can't handle stack overflow exception, so handle it here
    __try
    {
        result = entry_point(commandLine);
    }
    __except (StackoverflowFilter(GetExceptionCode()))
    {
        _resetstkoflw();
        FATAL("stack overflow");
    }

    return result;
}
#else
int main(int argc, char *argv[])
{
    int result = EXIT_FAILURE;

#if defined(XR_PLATFORM_WEB)
    wasmfs_create_directory("/opfs", 0777, wasmfs_create_opfs_backend());
    RestoreBrowserSaveTimes();
    for (int i = 1; i < argc; ++i)
        if (strcmp(argv[i], "-stream_mount") == 0)
        {
            if (i + 1 >= argc || !mountStreamedArchives(argv[++i]))
            {
                fprintf(stderr, "Cannot mount streamed game archives\n");
                return EXIT_FAILURE;
            }
        }
    setvbuf(stdout, nullptr, _IOLBF, 0); // engine log lines reach the page as they are written
#endif

    try
    {
        char* commandLine = nullptr;
        int i;
        if(argc > 1)
        {
            size_t sum = 1;
            for(i = 1; i < argc; ++i)
                sum += strlen(argv[i]) + 1;

            commandLine = (char*)xr_malloc(sum);
            ZeroMemory(commandLine, sum);

            for(i = 1; i < argc; ++i)
            {
                strcat(commandLine, argv[i]);
                strcat(commandLine, " ");
            }

            result = entry_point(commandLine);

            xr_free(commandLine);
        }
        else
            result = entry_point("");
    }
    catch (const std::overflow_error& e)
    {
        _resetstkoflw();
        FATAL_F("stack overflow: %s", e.what());
    }
    catch (const std::runtime_error& e)
    {
        FATAL_F("runtime error: %s", e.what());
    }
    catch (const std::exception& e)
    {
        FATAL_F("exception: %s", e.what());
    }
    catch (...)
    {
    // this executes if f() throws std::string or int or any other unrelated type
    }

#if defined(XR_PLATFORM_WEB)
    if (result == 0)
        emscripten_exit_with_live_runtime();
#endif

    return result;
}
#endif
