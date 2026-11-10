#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <iterator>

namespace BrowserVideoModes
{
struct Size
{
    unsigned width;
    unsigned height;
};

inline constexpr std::size_t maxPresets = 9;

struct AspectFamily
{
    double aspect;
    std::array<Size, maxPresets> presets;
};

inline constexpr AspectFamily families[] = {
    { 5.0 / 4, {{{640, 512}, {800, 640}, {960, 768}, {1280, 1024}, {1600, 1280}, {2560, 2048}}} },
    { 4.0 / 3, {{{640, 480}, {800, 600}, {1024, 768}, {1152, 864}, {1280, 960}, {1600, 1200}, {2048, 1536}, {2880, 2160}}} },
    { 3.0 / 2, {{{720, 480}, {1080, 720}, {1200, 800}, {1440, 960}, {1620, 1080}, {1920, 1280}, {2160, 1440}, {2880, 1920}, {3240, 2160}}} },
    { 16.0 / 10, {{{768, 480}, {960, 600}, {1152, 720}, {1280, 800}, {1440, 900}, {1680, 1050}, {1920, 1200}, {2560, 1600}, {3840, 2400}}} },
    { 16.0 / 9, {{{854, 480}, {960, 540}, {1280, 720}, {1600, 900}, {1920, 1080}, {2560, 1440}, {3200, 1800}, {3840, 2160}}} },
    { 64.0 / 27, {{{1280, 540}, {1720, 720}, {2560, 1080}, {3440, 1440}, {3840, 1600}}} },
    { 32.0 / 9, {{{1920, 540}, {2560, 720}, {3200, 900}, {3840, 1080}}} },
};

inline constexpr bool IsSupported(Size mode)
{
    return mode.width >= 640 && mode.height >= 480 && mode.width <= 4096 && mode.height <= 4096;
}

struct ModeList
{
    // The exact display size and the active custom size can add one entry each.
    std::array<Size, maxPresets + 2> sizes{};
    std::size_t count = 0;
};

inline ModeList ForDisplay(Size display, Size current = {})
{
    const bool portrait = display.width < display.height;
    const auto aspect = double(std::max(display.width, display.height)) / std::min(display.width, display.height);
    const auto distance = [aspect](const AspectFamily& family)
    {
        return std::abs(aspect / family.aspect - 1.0);
    };
    const auto family = std::min_element(std::begin(families), std::end(families),
        [&distance](const AspectFamily& a, const AspectFamily& b) { return distance(a) < distance(b); });

    ModeList modes;
    for (auto mode : family->presets)
    {
        if (portrait)
            std::swap(mode.width, mode.height);
        if (IsSupported(mode) && mode.width <= display.width && mode.height < display.height)
            modes.sizes[modes.count++] = mode;
    }
    modes.sizes[modes.count++] = display;

    // Keep a saved or console-selected size selectable in its height tier.
    if (IsSupported(current))
    {
        const auto end = modes.sizes.begin() + modes.count;
        const auto tier = std::find_if(modes.sizes.begin(), end,
            [current](Size mode) { return mode.height == current.height; });
        *tier = current;
        if (tier == end)
            ++modes.count;
    }

    std::sort(modes.sizes.begin(), modes.sizes.begin() + modes.count,
        [](Size a, Size b) { return a.height < b.height; });
    return modes;
}

inline Size DefaultForDisplay(Size display)
{
    const auto modes = ForDisplay(display);
    auto selected = modes.sizes.front();
    for (std::size_t i = 1; i < modes.count && modes.sizes[i].height <= 1080; ++i)
        selected = modes.sizes[i];
    return selected;
}
}
