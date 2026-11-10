#pragma once

#include "Sound.h"

// A non-null emitter identifies a live positional loop. One-shots pass null.
using SoundPlaybackObserver = void (*)(const char*, const CSound_params&, const void* emitter);
XRSOUND_API void set_sound_playback_observer(SoundPlaybackObserver observer);
