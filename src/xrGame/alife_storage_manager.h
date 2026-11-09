////////////////////////////////////////////////////////////////////////////
//	Module 		: alife_storage_manager.h
//	Created 	: 25.12.2002
//  Modified 	: 12.05.2004
//	Author		: Dmitriy Iassenev
//	Description : ALife Simulator storage manager
////////////////////////////////////////////////////////////////////////////

#pragma once

#include "alife_simulator_base.h"

class NET_Packet;
class AlifeHostInterests;

class CALifeStorageManager : public virtual CALifeSimulatorBase
{
    friend class CALifeUpdatePredicate;

protected:
    typedef CALifeSimulatorBase inherited;

protected:
    string_path m_save_name;
    LPCSTR m_section;
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    void save_host_world(AlifeHostInterests& checkpoint);
    void poll_host_world(AlifeHostInterests& checkpoint);
#endif

private:
    void prepare_objects_for_save();
    void write_world_state(IWriter& stream);
    void load(void* buffer, const u32& buffer_size, LPCSTR file_name);

public:
    IC CALifeStorageManager(IPureServer* server, LPCSTR section);
    virtual ~CALifeStorageManager();
    bool load(LPCSTR save_name = 0);
    void save(LPCSTR save_name = 0, bool update_name = true);
    void save(NET_Packet& net_packet);
};

#include "alife_storage_manager_inline.h"
