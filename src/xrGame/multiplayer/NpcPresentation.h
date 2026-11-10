#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <string_view>

namespace zone {
constexpr unsigned npcPoseHeader = 32;
constexpr unsigned npcBoneBytes = 10;
constexpr unsigned npcMaxBones = 64;
constexpr unsigned npcScope = 1, npcLauncher = 2, npcSilencer = 4;
constexpr unsigned npcShot = 8, npcShotLauncher = 16, npcWeaponFlags = 31;
constexpr unsigned npcShotBytes = 4 + npcBoneBytes;
constexpr unsigned npcPoseCapacity = npcPoseHeader + npcMaxBones * npcBoneBytes + npcBoneBytes + 127 + npcShotBytes;

inline std::uint32_t npcModelKey(std::string_view model)
{
    std::uint32_t hash = 2166136261u;
    for (const unsigned char ch : model)
        hash = (hash ^ ch) * 16777619u;
    return hash;
}

inline bool packNpcRotation(unsigned char* out, const Fmatrix& matrix)
{
    if (!_valid(matrix))
        return false;
    Fquaternion q;
    q.set(matrix);
    const float length = std::sqrt(q.magnitude());
    if (!std::isfinite(length) || length < .001f)
        return false;
    const float axes[] = {q.x, q.y, q.z, q.w};
    for (unsigned i = 0; i < std::size(axes); ++i)
        out[i] = static_cast<unsigned char>(std::lround(axes[i] * 127.f / length));
    return true;
}

inline bool packNpcBone(unsigned char* out, const Fmatrix& matrix)
{
    const float axes[] = {matrix.c.x, matrix.c.y, matrix.c.z};
    for (unsigned i = 0; i < std::size(axes); ++i)
    {
        if (!std::isfinite(axes[i]) || std::abs(axes[i]) > 32.f)
            return false;
        const auto mm = static_cast<std::uint16_t>(std::lround(axes[i] * 1000.f));
        out[2 * i] = static_cast<unsigned char>(mm);
        out[2 * i + 1] = static_cast<unsigned char>(mm >> 8);
    }
    return packNpcRotation(out + 6, matrix);
}

inline Fquaternion readNpcRotation(const unsigned char* data)
{
    Fquaternion q;
    q.set(static_cast<std::int8_t>(data[3]), static_cast<std::int8_t>(data[0]),
        static_cast<std::int8_t>(data[1]), static_cast<std::int8_t>(data[2]));
    if (q.magnitude() > 0.f)
        q.normalize();
    else
        q.identity();
    return q;
}

inline Fmatrix readNpcBone(const unsigned char* data)
{
    const auto axis = [data](unsigned i) {
        return static_cast<std::int16_t>(data[i] | (std::uint16_t(data[i + 1]) << 8)) * .001f;
    };
    Fmatrix matrix;
    matrix.rotation(readNpcRotation(data + 6));
    matrix.c.set(axis(0), axis(2), axis(4));
    return matrix;
}
}
