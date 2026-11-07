# SDL provides input/window/audio integration only. Its Emscripten port forces
# WebGL procedure lookup on, so build the pinned source without GL render drivers.
include(FetchContent)
set(SDL_SHARED OFF CACHE BOOL "" FORCE)
set(SDL_STATIC ON CACHE BOOL "" FORCE)
set(SDL_TEST OFF CACHE BOOL "" FORCE)
set(SDL_OPENGL OFF CACHE BOOL "" FORCE)
set(SDL_OPENGLES OFF CACHE BOOL "" FORCE)
set(SDL_VULKAN OFF CACHE BOOL "" FORCE)
set(SDL_RENDER OFF CACHE BOOL "" FORCE)
set(SDL_INSTALL OFF CACHE BOOL "" FORCE)
set(SDL_PTHREADS ON CACHE BOOL "" FORCE)
set(SDL_ASSEMBLY OFF CACHE BOOL "" FORCE)
set(_native_sdl_cached "${XRAY_SOURCE_DIR}/.cache/emscripten-7.0.0/ports/sdl2/SDL-release-2.32.10")
if(EXISTS "${_native_sdl_cached}/CMakeLists.txt")
    FetchContent_Declare(native_sdl SOURCE_DIR "${_native_sdl_cached}")
else()
    FetchContent_Declare(native_sdl
        URL https://github.com/libsdl-org/SDL/archive/release-2.32.10.zip
        URL_HASH SHA512=001738b610b42a8f8badfd6af3402f0a1a8601034adef0b8c702dd2b1951dc1b71b733a6779d97499b6f7314d226ec0c8dcffeb753f35a5c51e995ca20bdd459
        DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
endif()
FetchContent_MakeAvailable(native_sdl)
set_target_properties(SDL2-static PROPERTIES UNITY_BUILD OFF)
# A few engine headers include SDL before their target's dependency interfaces.
include_directories(SYSTEM "${native_sdl_SOURCE_DIR}/include" "${native_sdl_BINARY_DIR}/include")
