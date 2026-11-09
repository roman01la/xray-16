#include "stdafx.h"

#include "SoundRender_Web.h"
#include "SoundRender_Emitter.h"
#include "SoundRender_Source.h"
#include "SoundRender_Target.h"

#include <cstdlib>
#include <cstring>

extern "C" int xray_audio_worklet_start(void* shared, u32 voices);
extern "C" void xray_audio_worklet_stop(void* shared);

namespace
{
// Shared layout for misc/web/page/audio-worklet.mjs. Index and parameter
// words use atomics. PCM is published by Write and kept alive through Read.
enum HeaderWord : u32
{
    Running, ListenerSequence, MasterGain, ListenerX, ListenerY, ListenerZ,
    ForwardX, ForwardY, ForwardZ, RightX, RightY, RightZ, Version, RenderedFrames, MixedFrames,
    HeaderWords = 16,
};

enum VoiceWord : u32
{
    VoiceSequence, Generation, Active, StartFrame, Rate, Channels, PositionX,
    PositionY, PositionZ, Gain, Pitch, Reference, MaxDistance, Rolloff, Relative,
    Read, Write, VoiceWords = 20,
};

constexpr u32 FrameCapacity = 32768;
constexpr u32 ChannelsPerFrame = 2;
constexpr u32 SamplesPerVoice = FrameCapacity * ChannelsPerFrame;

static_assert(sizeof(float) == sizeof(u32));
static_assert(__atomic_always_lock_free(sizeof(u32), nullptr));
static_assert(Version == 12 && RenderedFrames == 13 && MixedFrames == 14 && HeaderWords == 16);
static_assert(Relative == 14 && Read == 15 && Write == 16 && VoiceWords == 20);

u32 load(u32& word) { return __atomic_load_n(&word, __ATOMIC_SEQ_CST); }
void store(u32& word, u32 value) { __atomic_store_n(&word, value, __ATOMIC_SEQ_CST); }
void store_float(u32& word, float value)
{
    u32 bits;
    std::memcpy(&bits, &value, sizeof(bits));
    store(word, bits);
}

class WebSoundTarget final : public CSoundRender_Target
{
    using inherited = CSoundRender_Target;
    u32* m_voice;
    float* m_pcm;
    Fvector m_position{};
    float m_gain{};
    float m_pitch{1.f};
    float m_reference{};
    float m_maxDistance{};
    float m_rolloff{};
    u32 m_generation{};
    u32 m_firstFrame{};
    u32 m_rate{};
    u32 m_channels{};
    u32 m_blockFrames{};
    bool m_relative{};
    bool m_floatPcm{};
    bool m_rewind{};

    void publish(bool playing, bool reset)
    {
        if (reset)
        {
            ++m_generation;
            m_firstFrame = load(m_voice[Write]);
        }
        const u32 seq = load(m_voice[VoiceSequence]);
        store(m_voice[VoiceSequence], seq + 1);
        store(m_voice[Generation], m_generation);
        store(m_voice[Active], playing);
        store(m_voice[StartFrame], m_firstFrame);
        store(m_voice[Rate], m_rate);
        store(m_voice[Channels], m_channels);
        store_float(m_voice[PositionX], m_position.x);
        store_float(m_voice[PositionY], m_position.y);
        store_float(m_voice[PositionZ], m_position.z);
        store_float(m_voice[Gain], m_gain);
        store_float(m_voice[Pitch], m_pitch);
        store_float(m_voice[Reference], m_reference);
        store_float(m_voice[MaxDistance], m_maxDistance);
        store_float(m_voice[Rolloff], m_rolloff);
        store(m_voice[Relative], m_relative);
        store(m_voice[VoiceSequence], seq + 2);
    }

    template <typename Sample>
    void copy_pcm(const u8* data, u32 first)
    {
        for (u32 frame = 0; frame < m_blockFrames; ++frame)
        {
            const u32 dest = ((first + frame) & (FrameCapacity - 1)) * ChannelsPerFrame;
            for (u32 channel = 0; channel < m_channels; ++channel)
            {
                Sample value;
                std::memcpy(&value, data + (frame * m_channels + channel) * sizeof(Sample), sizeof(Sample));
                if constexpr (std::is_same_v<Sample, float>)
                    m_pcm[dest + channel] = value;
                else
                    m_pcm[dest + channel] = value / 32768.f;
            }
        }
    }

    void submit(bool reset)
    {
        const bool supported = m_blockFrames && m_blockFrames <= FrameCapacity && m_channels >= 1 && m_channels <= 2;
        publish(supported, reset);
        m_rewind = false;
        if (!supported)
            return;

        u32 write = load(m_voice[Write]);
        const u32 read = load(m_voice[Read]);
        const u32 target = std::min(FrameCapacity, m_blockFrames * sdef_target_count_submit);
        // A suspended context does not consume the queue. Cap the amount of
        // decoded PCM per voice and allow the virtual emitter to continue.
        while (write - read <= target - m_blockFrames)
        {
            const auto [data, size] = m_pEmitter->obtain_block();
            const u32 stride = m_channels * (m_floatPcm ? sizeof(float) : sizeof(s16));
            R_ASSERT(size >= m_blockFrames * stride);
            if (m_floatPcm)
                copy_pcm<float>(data, write);
            else
                copy_pcm<s16>(data, write);
            write += m_blockFrames;
            store(m_voice[Write], write);
        }
    }

public:
    WebSoundTarget(u32* voice, float* pcm) : m_voice(voice), m_pcm(pcm) {}

    bool _initialize() override { return true; }
    void _destroy() override { publish(false, true); }
    void _restart() override { m_rewind = true; }

    void start(CSoundRender_Emitter* emitter) override
    {
        inherited::start(emitter);
        const auto& info = emitter->source()->data_info();
        m_channels = info.channels;
        m_rate = info.samplesPerSec;
        m_floatPcm = info.format == SoundFormat::Float32;
        m_blockFrames = info.blockAlign ? info.bytesPerBuffer / info.blockAlign : 0;
    }

    void render() override { inherited::render(); submit(true); }
    void update() override { inherited::update(); submit(m_rewind); }
    void rewind() override { inherited::rewind(); m_rewind = true; }
    void stop() override { publish(false, true); inherited::stop(); }

    void fill_parameters() override
    {
        inherited::fill_parameters();
        const auto& src = m_pEmitter->p_source;
        m_position = src.position;
        m_gain = std::clamp(m_pEmitter->smooth_volume, EPS_S, 1.f);
        const float frequency = src.freq * (m_pEmitter->bIgnoringTimeFactor ? 1.f : psSoundTimeFactor);
        m_pitch = std::clamp(frequency, EPS_L, 100.f);
        m_reference = src.min_distance;
        m_maxDistance = src.max_distance;
        m_rolloff = psSoundRolloff;
        m_relative = m_pEmitter->b2D;
    }
};
}

void CSoundRender_Web::_initialize_devices_list()
{
    auto& devices = Parent.GetDevicesList();
    devices.emplace_back(xr_strdup("Browser AudioWorklet"), 0);
    devices.emplace_back(nullptr, -1);
    snd_device_id = 0;
    bPresent = true;
}

void CSoundRender_Web::_initialize()
{
    const u32 voices = std::clamp(psSoundTargets, 4, 256);
    const size_t words = HeaderWords + voices * (VoiceWords + SamplesPerVoice);
    // The browser owns the allocation after accepting startup. It releases
    // the memory only after AudioContext.close() stops the rendering thread.
    m_shared = static_cast<u32*>(std::calloc(words, sizeof(u32)));
    R_ASSERT(m_shared);
    store(m_shared[Running], 1);
    store(m_shared[Version], 1);
    store_float(m_shared[MasterGain], 1.f);
    store_float(m_shared[ForwardZ], 1.f);
    store_float(m_shared[RightX], 1.f);
    if (!xray_audio_worklet_start(m_shared, voices))
    {
        std::free(m_shared);
        m_shared = nullptr;
        bPresent = false;
        return;
    }

    supports_float_pcm = psSoundFlags.test(ss_UseFloat32);
    inherited::_initialize();
    auto* pcm = reinterpret_cast<float*>(m_shared + HeaderWords + voices * VoiceWords);
    for (u32 i = 0; i < voices; ++i)
        s_targets.emplace_back(xr_new<WebSoundTarget>(m_shared + HeaderWords + i * VoiceWords, pcm + i * SamplesPerVoice));
}

void CSoundRender_Web::_clear()
{
    if (m_shared)
        store(m_shared[Running], 0);
    inherited::_clear();
    for (auto& target : s_targets)
        xr_delete(target);
    s_targets.clear();
    if (m_shared)
    {
        xray_audio_worklet_stop(m_shared);
        m_shared = nullptr;
    }
}

void CSoundRender_Web::set_master_volume(float gain)
{
    if (m_shared)
        store_float(m_shared[MasterGain], gain);
}

void CSoundRender_Web::update_listener(const Fvector& position, const Fvector& direction,
    const Fvector& up, const Fvector& right, float dt)
{
    inherited::update_listener(position, direction, up, right, dt);
    const u32 seq = load(m_shared[ListenerSequence]);
    store(m_shared[ListenerSequence], seq + 1);
    store_float(m_shared[ListenerX], position.x);
    store_float(m_shared[ListenerY], position.y);
    store_float(m_shared[ListenerZ], position.z);
    store_float(m_shared[ForwardX], direction.x);
    store_float(m_shared[ForwardY], direction.y);
    store_float(m_shared[ForwardZ], direction.z);
    store_float(m_shared[RightX], right.x);
    store_float(m_shared[RightY], right.y);
    store_float(m_shared[RightZ], right.z);
    store(m_shared[ListenerSequence], seq + 2);
}
