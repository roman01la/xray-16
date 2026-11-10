////////////////////////////////////////////////////////////////////////////
//	Module 		: alife_switch_manager.h
//	Created 	: 25.12.2002
//  Modified 	: 12.05.2004
//	Author		: Dmitriy Iassenev
//	Description : ALife Simulator switch manager
////////////////////////////////////////////////////////////////////////////

#pragma once
#include "alife_simulator_base.h"
#include "alife_host_interests.h"
#include "alife_host_targets.h"

class CLevel;
struct SHit;

// XXX: WTF is this? CALifeSwitchManager IS-A CRandom??? I think NOT! CRandom should be aggregated, NOT inherited from!
class CALifeSwitchManager : public virtual CALifeSimulatorBase, CRandom
{
protected:
    typedef CALifeSimulatorBase inherited;
    typedef ALife::OBJECT_VECTOR OBJECT_VECTOR;

protected:
    float m_switch_distance;
    float m_switch_factor;
    float m_online_distance;
    float m_offline_distance;

private:
    OBJECT_VECTOR m_saved_chidren;
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    std::unique_ptr<AlifeHostInterests> m_hostInterests;
    std::unique_ptr<AlifeHostTargets> m_hostTargets;
#endif

protected:
    bool synchronize_location(CSE_ALifeDynamicObject* object);
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    void open_host_interests();
    AlifeHostInterests& host_interests() const { return *m_hostInterests; }
    bool host_corpses_settled() const { return !m_hostTargets || !m_hostTargets->hasUnsettledCorpses(); }
#endif

public:
    void try_switch_online(CSE_ALifeDynamicObject* object);
    void try_switch_offline(CSE_ALifeDynamicObject* object);
    void switch_online(CSE_ALifeDynamicObject* object);
    void switch_offline(CSE_ALifeDynamicObject* object);
    void remove_online(CSE_ALifeDynamicObject* object, bool update_registries = true);
    void add_online(CSE_ALifeDynamicObject* object, bool update_registries = true);

public:
    IC CALifeSwitchManager(IPureServer* server, LPCSTR section);
    virtual ~CALifeSwitchManager();
    void switch_object(CSE_ALifeDynamicObject* object);
    static bool host_interests_requested();
#if defined(XR_PLATFORM_POSIX) && !defined(XR_PLATFORM_WEB)
    void poll_host_interests() const;
    void advance_host_interests(CLevel& level) const;
    bool recover_host_world(IReader& source) const { return host_interests().restoreWorldCheckpoint(source); }
    bool host_hit_capacity() const;
    void report_host_hit(u16 target, const SHit& hit) const;
    void report_host_death(CSE_Abstract& entity);
    void publish_host_npcs(CLevel& level) const;
#endif
    bool uses_host_interests() const noexcept;
    bool near_switch_interest(const Fvector& position, float distance) const;
    std::size_t host_interest_count() const noexcept;
    IC float online_distance() const noexcept;
    IC float offline_distance() const noexcept;
    IC float switch_distance() const noexcept;
    IC void set_switch_distance(float switch_distance) noexcept;
    IC void set_switch_factor(float switch_factor) noexcept;
};

#include "alife_switch_manager_inline.h"
