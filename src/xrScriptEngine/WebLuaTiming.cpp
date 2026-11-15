#include "WebLuaTiming.hpp"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <emscripten.h>
#include <lua.hpp>

namespace
{
std::atomic<bool> timingEnabled{false};
std::atomic<std::uint64_t> callNanoseconds{0};
std::atomic<std::uint64_t> gcNanoseconds{0};

struct LuaTimingState
{
    double callStart = -1;
    double gcStart = -1;
    double gcDuringCall = 0;
};

thread_local LuaTimingState luaTiming;

void AddTime(std::atomic<std::uint64_t>& counter, double milliseconds)
{
    counter.fetch_add(static_cast<std::uint64_t>(std::max(0.0, milliseconds) * 1000000.0),
        std::memory_order_relaxed);
}

void FinishGarbageCollection()
{
    const double elapsed = emscripten_get_now() - luaTiming.gcStart;
    luaTiming.gcStart = -1;
    AddTime(gcNanoseconds, elapsed);
    if (luaTiming.callStart >= 0)
        luaTiming.gcDuringCall += elapsed;
}

template <typename Call>
int TimeProtectedLuaCall(Call call)
{
    if (!timingEnabled.load(std::memory_order_relaxed))
        return call();

    const bool alreadyCollecting = luaTiming.gcStart >= 0;
    const bool outerCall = luaTiming.callStart < 0 && !alreadyCollecting;
    if (outerCall)
    {
        luaTiming.callStart = emscripten_get_now();
        luaTiming.gcDuringCall = 0;
    }

    const int result = call();

    // A Lua finalizer can longjmp past the GC wrapper into this protected call.
    if (!alreadyCollecting && luaTiming.gcStart >= 0)
        FinishGarbageCollection();

    if (outerCall)
    {
        AddTime(callNanoseconds, emscripten_get_now() - luaTiming.callStart - luaTiming.gcDuringCall);
        luaTiming.callStart = -1;
    }
    return result;
}

void TimeGarbageCollection(void (*collect)(lua_State*), lua_State* state)
{
    if (!timingEnabled.load(std::memory_order_relaxed) || luaTiming.gcStart >= 0)
    {
        collect(state);
        return;
    }
    luaTiming.gcStart = emscripten_get_now();
    collect(state);
    FinishGarbageCollection();
}
}

void SetWebLuaTimingEnabled(bool enabled)
{
    timingEnabled.store(enabled, std::memory_order_relaxed);
}

WebLuaTiming TakeWebLuaTiming()
{
    return {callNanoseconds.exchange(0, std::memory_order_relaxed) / 1000000.0,
        gcNanoseconds.exchange(0, std::memory_order_relaxed) / 1000000.0};
}

extern "C" int __real_lua_pcall(lua_State* state, int nargs, int nresults, int errorHandler);
extern "C" int __real_lua_resume(lua_State* state, int nargs);
extern "C" void __real_luaC_step(lua_State* state);
extern "C" void __real_luaC_fullgc(lua_State* state);

extern "C" int __wrap_lua_pcall(lua_State* state, int nargs, int nresults, int errorHandler)
{
    return TimeProtectedLuaCall([&] { return __real_lua_pcall(state, nargs, nresults, errorHandler); });
}

extern "C" int __wrap_lua_resume(lua_State* state, int nargs)
{
    return TimeProtectedLuaCall([&] { return __real_lua_resume(state, nargs); });
}

extern "C" void __wrap_luaC_step(lua_State* state)
{
    TimeGarbageCollection(__real_luaC_step, state);
}

extern "C" void __wrap_luaC_fullgc(lua_State* state)
{
    TimeGarbageCollection(__real_luaC_fullgc, state);
}
