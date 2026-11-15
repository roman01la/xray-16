#pragma once

struct WebLuaTiming
{
    double callsMs;
    double garbageCollectionMs;
};

void SetWebLuaTimingEnabled(bool enabled);
WebLuaTiming TakeWebLuaTiming();
