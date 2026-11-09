#pragma once

#include "SoundRender_Core.h"

class CSoundRender_Web final : public CSoundRender_Core
{
    using inherited = CSoundRender_Core;
    u32* m_shared{};

    void update_listener(const Fvector& position, const Fvector& direction,
        const Fvector& up, const Fvector& right, float dt) override;

public:
    explicit CSoundRender_Web(CSoundManager& parent) : inherited(parent) {}
    void _initialize_devices_list() override;
    void _initialize() override;
    void _clear() override;
    void set_master_volume(float gain) override;
};
