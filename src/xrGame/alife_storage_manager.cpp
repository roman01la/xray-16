////////////////////////////////////////////////////////////////////////////
//	Module 		: alife_storage_manager.cpp
//	Created 	: 25.12.2002
//  Modified 	: 12.05.2004
//	Author		: Dmitriy Iassenev
//	Description : ALife Simulator storage manager
////////////////////////////////////////////////////////////////////////////

#include "StdAfx.h"
#include "alife_storage_manager.h"
#include "alife_simulator_header.h"
#include "alife_time_manager.h"
#include "alife_spawn_registry.h"
#include "alife_object_registry.h"
#include "alife_graph_registry.h"
#include "alife_group_registry.h"
#include "alife_registry_container.h"
#include "xrServer.h"
#include "Level.h"
#include "saved_game_wrapper.h"
#include "xrEngine/IGame_Persistent.h"
#include "autosave_manager.h"
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
#include "alife_simulator.h"
#include "ai_space.h"
#include <ctime>
#if XRAY_USE_LUAJIT
#include <lua.hpp>
#endif
#endif

using namespace ALife;

extern string_path g_last_saved_game;

namespace
{
void notifySaveHook(pcstr hook, pcstr saveName)
{
    luabind::functor<void> callback;
    if (GEnv.ScriptEngine->functor(hook, callback))
        callback(saveName);
}

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB) && XRAY_USE_LUAJIT
class ScopedCheckpointJitPause
{
public:
    explicit ScopedCheckpointJitPause(lua_State* state) : lua(state)
    {
        const int top = lua_gettop(lua);
        lua_pushliteral(lua, "jit");
        lua_rawget(lua, LUA_GLOBALSINDEX);
        if (lua_istable(lua, -1))
        {
            lua_pushliteral(lua, "status");
            lua_rawget(lua, -2);
            if (lua_iscfunction(lua, -1) && lua_pcall(lua, 0, 1, 0) == 0)
                restore = lua_isboolean(lua, -1) && lua_toboolean(lua, -1);
        }
        lua_settop(lua, top);

        // Save callbacks run in bursts. Keep new trace compilation off the
        // checkpoint path and keep previously compiled traces available.
        if (restore)
            restore = luaJIT_setmode(lua, 0, LUAJIT_MODE_ENGINE | LUAJIT_MODE_OFF) != 0;
    }

    ~ScopedCheckpointJitPause()
    {
        if (restore)
            luaJIT_setmode(lua, 0, LUAJIT_MODE_ENGINE | LUAJIT_MODE_ON);
    }

    ScopedCheckpointJitPause(const ScopedCheckpointJitPause&) = delete;
    ScopedCheckpointJitPause& operator=(const ScopedCheckpointJitPause&) = delete;

private:
    lua_State* lua;
    bool restore = false;
};
#endif
}

void CALifeStorageManager::write_world_state(IWriter& stream)
{
    header().save(stream);
    time_manager().save(stream);
    spawns().save(stream);
    objects().save(stream);
    registry().save(stream);
}

#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
void CALifeStorageManager::save_host_world(AlifeHostInterests& checkpoint)
{
    CTimer timer;
    timer.Start();
    timespec cpuStart{}, cpuEnd{};
    const bool measuredCpu = clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpuStart) == 0;
    Level().ClientSend();
    const auto exportMilliseconds = timer.GetElapsed_sec() * 1000.;
    {
#if XRAY_USE_LUAJIT
        ScopedCheckpointJitPause jitPause(GEnv.ScriptEngine->lua());
#endif
        Level().ClientSave();
    }
    const auto prepareMilliseconds = timer.GetElapsed_sec() * 1000.;
    string_path name, path;
    strconcat(sizeof(name), name, AlifeHostInterests::WorldSaveName, SAVE_EXTENSION);
    notifySaveHook("alife_storage_manager.CALifeStorageManager_before_save", name);
    auto snapshot = std::make_unique<CMemoryWriter>();
    const auto serializationStart = timer.GetElapsed_sec() * 1000.;
    write_world_state(*snapshot);
    const auto serializationMilliseconds = timer.GetElapsed_sec() * 1000. - serializationStart;
    checkpoint.writeWorldCheckpoint(*snapshot);
    FS.update_path(path, "$game_saves$", name);
    convert_path_separators(path);
    const auto bytes = snapshot->size();
    checkpoint.startWorldCheckpoint(path, std::move(snapshot));
    const auto cpuMilliseconds = measuredCpu && clock_gettime(CLOCK_THREAD_CPUTIME_ID, &cpuEnd) == 0 ?
        (cpuEnd.tv_sec - cpuStart.tv_sec) * 1000. + (cpuEnd.tv_nsec - cpuStart.tv_nsec) / 1.e6 : -1.;
    Msg("* A-Life checkpoint capture took %.2f ms (%zu bytes, prepare %.2f ms, serialize %.2f ms, "
        "client export %.2f ms, thread CPU %.2f ms)", timer.GetElapsed_sec() * 1000., bytes,
        prepareMilliseconds, serializationMilliseconds, exportMilliseconds, cpuMilliseconds);
}

void CALifeStorageManager::poll_host_world(AlifeHostInterests& checkpoint)
{
    if (!checkpoint.pollWorldCheckpoint())
        return;
    string_path name;
    strconcat(sizeof(name), name, AlifeHostInterests::WorldSaveName, SAVE_EXTENSION);
    xr_strcpy(g_last_saved_game, AlifeHostInterests::WorldSaveName);
    notifySaveHook("alife_storage_manager.CALifeStorageManager_save", name);
}
#endif

CALifeStorageManager::~CALifeStorageManager() {}
void CALifeStorageManager::save(LPCSTR save_name_no_check, bool update_name)
{
    pcstr gameSaveExtension = SAVE_EXTENSION;
    if (ShadowOfChernobylMode || ClearSkyMode)
        gameSaveExtension = SAVE_EXTENSION_LEGACY;

    LPCSTR game_saves_path = FS.get_path("$game_saves$")->m_Path;

    string_path save_name;
    strncpy_s(save_name, sizeof(save_name), save_name_no_check,
        sizeof(save_name) - 5 - xr_strlen(gameSaveExtension) - xr_strlen(game_saves_path));

    xr_strcpy(g_last_saved_game, save_name);

    string_path saveBackup;
    xr_strcpy(saveBackup, m_save_name);
    if (save_name[0])
    {
        strconcat(sizeof(m_save_name), m_save_name, save_name, gameSaveExtension);
    }
    else
    {
        if (!xr_strlen(m_save_name))
        {
            Log("There is no file name specified!");
            return;
        }
    }

    notifySaveHook("alife_storage_manager.CALifeStorageManager_before_save", m_save_name);
    u32 source_count;
    u32 dest_count;
    void* dest_data;
    {
        CMemoryWriter stream;
        write_world_state(stream);
        source_count = stream.tell();
        dest_count = rtc_csize(source_count);
        dest_data = xr_malloc(dest_count);
        dest_count = rtc_compress(dest_data, dest_count, stream.pointer(), source_count);
    }

    string_path temp;
    FS.update_path(temp, "$game_saves$", m_save_name);
    IWriter* writer = FS.w_open(temp);
    const bool saved = writer && writer->valid();
    if (saved)
    {
        writer->w_u32(u32(-1));
        writer->w_u32(ALIFE_VERSION);
        writer->w_u32(source_count);
        writer->w(dest_data, dest_count);
    }
    FS.w_close(writer);
    xr_free(dest_data);
    if (!saved)
    {
        Msg("! Could not save the campaign to '%s'", temp);
        xr_strcpy(m_save_name, saveBackup);
        return;
    }
#ifdef DEBUG
    Msg("* Game %s is successfully saved to file '%s' (%d bytes compressed to %d)", m_save_name, temp, source_count,
        dest_count + 4);
#else // DEBUG
    Msg("* Game %s is successfully saved to file '%s'", m_save_name, temp);
#endif // DEBUG

    notifySaveHook("alife_storage_manager.CALifeStorageManager_save", m_save_name);
    if (!update_name)
        xr_strcpy(m_save_name, saveBackup);
}

void CALifeStorageManager::load(void* buffer, const u32& buffer_size, LPCSTR file_name)
{
    IReader source(buffer, buffer_size);
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    if (CALifeSwitchManager::host_interests_requested())
    {
        if (!ai().alife().recover_host_world(source))
        {
            Log("! The native A-Life checkpoint does not match its world fence");
            FlushLog();
            std::exit(EXIT_FAILURE);
        }
        source.seek(0);
    }
#endif

	//Alundaio: So we can get the fname to make our own custom save states
    luabind::functor<void> funct;
    if (GEnv.ScriptEngine->functor("alife_storage_manager.CALifeStorageManager_load", funct))
        funct(file_name);
	//-Alundaio

    header().load(source);
    time_manager().load(source);
    spawns().load(source, file_name);
    graph().on_load();
    objects().load(source);

    VERIFY(can_register_objects());
    can_register_objects(false);

    for (auto& object : objects().objects())
    {
        ALife::_OBJECT_ID id = object.second->ID;
        object.second->ID = server().PerformIDgen(id);
        VERIFY(id == object.second->ID);
        register_object(object.second, false);
    }

    registry().load(source);

    can_register_objects(true);

    for (auto& object : objects().objects())
        object.second->on_register();

    if (!g_pGameLevel)
        return;

    Level().autosave_manager().on_game_loaded();

	//Neloreck: For consistency with before/after save callbacks.
    luabind::functor<void> funct2;
    if (GEnv.ScriptEngine->functor("alife_storage_manager.CALifeStorageManager_after_load", funct2))
        funct2(file_name);
	//-Neloreck
}

bool CALifeStorageManager::load(LPCSTR save_name_no_check)
{
    pcstr gameSaveExtension = SAVE_EXTENSION;
    if (ShadowOfChernobylMode || ClearSkyMode)
        gameSaveExtension = SAVE_EXTENSION_LEGACY;

    LPCSTR game_saves_path = FS.get_path("$game_saves$")->m_Path;

    string_path save_name;
    strncpy_s(save_name, sizeof(save_name), save_name_no_check,
        sizeof(save_name) - 5 - xr_strlen(gameSaveExtension) - xr_strlen(game_saves_path));

    CTimer timer;
    timer.Start();

    string_path saveBackup;
    xr_strcpy(saveBackup, m_save_name);
    if (!save_name[0])
    {
        if (!xr_strlen(m_save_name))
        {
            Log("There is no file name specified!");
            return false;
        }
    }
    else
    {
        strconcat(sizeof(m_save_name), m_save_name, save_name, gameSaveExtension);
    }
    string_path file_name;
    FS.update_path(file_name, "$game_saves$", m_save_name);

    xr_strcpy(g_last_saved_game, save_name);
    xrDebug::SetBugReportFile(file_name);

    IReader* stream = FS.r_open(file_name);
    if (!stream)
    {
        Msg("* Cannot open saved game %s", file_name);
        xr_strcpy(m_save_name, saveBackup);
        return false;
    }

    constexpr pcstr mismatch = "Saved game version mismatch or saved game is corrupted";
    const bool gameSaveIsValid = CSavedGameWrapper::valid_saved_game(*stream);
    VERIFY3(gameSaveIsValid, mismatch, file_name);

    if (!gameSaveIsValid)
    {
        Msg("! %s [%s]", mismatch, file_name);

        xr_strcpy(m_save_name, saveBackup);
        return false;
    }

    string512 temp;
#ifdef XR_PLATFORM_WEB
    const auto browserLabel = StringTable().BrowserSaveLabel(save_name);
    strconcat(temp, StringTable().translate("st_loading_saved_game").c_str(), " \"", browserLabel.c_str(), "\"");
#else
    strconcat(temp, StringTable().translate("st_loading_saved_game").c_str(),
        " \"", save_name, gameSaveExtension, "\"");
#endif

    g_pGamePersistent->LoadTitle(temp);

    unload();
    reload(m_section);

    const u32 source_count = stream->r_u32();
    void* source_data = xr_malloc(source_count);
    rtc_decompress(source_data, source_count, stream->pointer(), stream->length() - 3 * sizeof(u32));
    FS.r_close(stream);
    load(source_data, source_count, file_name);
    xr_free(source_data);

    groups().on_after_game_load();

    VERIFY(graph().actor());

    Msg("* Game %s is successfully loaded from file '%s' (%.3fs)", save_name, file_name, timer.GetElapsed_sec());

    return (true);
}

void CALifeStorageManager::save(NET_Packet& net_packet)
{
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    if (CALifeSwitchManager::host_interests_requested())
        return;
#endif
    prepare_objects_for_save();

    shared_str game_name;
    net_packet.r_stringZ(game_name);
    save(game_name.c_str(), !!net_packet.r_u8());
}

void CALifeStorageManager::prepare_objects_for_save()
{
    Level().ClientSend();
    Level().ClientSave();
}
