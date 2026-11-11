#include "stdafx.h"
#include "Layers/xrRender/light.h"
#include "Layers/xrRender/FBasicVisual.h"

namespace xray::render::RENDER_NAMESPACE
{
smapvis::smapvis()
{
    invalidate();
    frame_sleep = 0;
}
smapvis::~smapvis()
{
#ifndef XR_PLATFORM_WEB
    flushoccq();
#endif
    invalidate();
}
void smapvis::invalidate()
{
#ifdef XR_PLATFORM_WEB
    if (query_pending)
    {
        RImplementation.occq_cancel(testQ_id, query_generation);
        query_pending = false;
    }
#endif
    state = state_counting;
    testQ_V = 0;
    frame_sleep = Device.dwFrame + ps_r__LightSleepFrames;
    invisible.clear();
}
void smapvis::begin()
{
#ifdef XR_PLATFORM_WEB
    if (query_pending && query_generation != RImplementation.occq_generation()) invalidate();
#endif
    auto& dsgraph = RImplementation.get_context(id);
    dsgraph.clear_Counters();
    switch (state)
    {
    case state_counting:
        // do nothing -> we just prepare for testing process
        break;
    case state_working:
#ifdef XR_PLATFORM_WEB
        if (query_pending) { mark(); break; }
#endif
        // mark already known to be invisible visuals, set breakpoint
        testQ_V = 0;
        testQ_id = 0;
        mark();
        dsgraph.set_Feedback(this, test_current);
        break;
    case state_usingTC:
        // just mark
        mark();
        break;
    }
}
void smapvis::end()
{
    auto& dsgraph = RImplementation.get_context(id);

    // Gather stats
    u32 ts, td;
    dsgraph.get_Counters(ts, td);
    RImplementation.Stats.ic_total += ts;
    dsgraph.set_Feedback(0, 0);

    switch (state)
    {
    case state_counting:
        // switch to 'working'
        if (sleep())
        {
            test_count = ts;
            test_current = 0;
            state = state_working;
        }
        break;
    case state_working:
        // feedback should be called at this time -> clear feedback
        // issue query
#ifdef XR_PLATFORM_WEB
        if (query_pending) break;
#endif
        if (testQ_V)
        {
            RImplementation.occq_begin(testQ_id);
            dsgraph.marker += 1;
            dsgraph.insert_static(testQ_V);
            dsgraph.render_graph(0);
            RImplementation.occq_end(testQ_id);
#ifdef XR_PLATFORM_WEB
            query_pending = true;
            query_generation = RImplementation.occq_generation();
#endif
            testQ_frame = Device.dwFrame + 1; // get result on next frame
        }
        break;
    case state_usingTC:
        // nothing to do
        break;
    }
}

void smapvis::flushoccq()
{
    // the tough part
#ifdef XR_PLATFORM_WEB
    if (query_pending && query_generation != RImplementation.occq_generation()) { invalidate(); return; }
    if (!query_pending || Device.dwFrame < testQ_frame) return;
    if (Device.dwFrame - testQ_frame > 120) { invalidate(); return; }
#else
    if (testQ_frame != Device.dwFrame) return;
#endif
    if ((state != state_working) || (!testQ_V))
        return;
#ifdef XR_PLATFORM_WEB
    bool ready = false;
    const auto fragments = RImplementation.occq_get(testQ_id, &ready);
    if (!ready) return;
    query_pending = false;
#else
    const auto fragments = RImplementation.occq_get(testQ_id);
#endif
    if (0 == fragments)
    {
        // this is invisible shadow-caster, register it
        // next time we will not get this caster, so 'test_current' remains the same
        invisible.push_back(testQ_V);
        test_count--;
    }
    else
    {
        // this is visible shadow-caster, advance testing
        test_current++;
    }

    testQ_V = 0;

    if (test_current == test_count)
    {
        // we are at the end of list
        if (state == state_working)
            state = state_usingTC;
    }
}
void smapvis::resetoccq()
{
    if (testQ_frame == (Device.dwFrame + 1))
        testQ_frame--;
    flushoccq();
}

void smapvis::mark()
{
    auto& dsgraph = RImplementation.get_context(id);
    RImplementation.Stats.ic_culled += invisible.size();
    u32 marker = dsgraph.marker + 1; // we are called befor marker increment
    for (u32 it = 0; it < invisible.size(); it++)
        invisible[it]->vis.marker[id] = marker; // this effectively disables processing
}

void smapvis::rfeedback_static(dxRender_Visual* V)
{
    testQ_V = V;
    auto& dsgraph = RImplementation.get_context(id);
    dsgraph.set_Feedback(0, 0);
}
} // namespace xray::render::RENDER_NAMESPACE
