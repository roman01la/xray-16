#pragma once
#include <cstring>
#include <unordered_map>
#include <vector>

namespace xray
{
// Thread-local, bounded, and keyed only for lookup: stale keys are never dereferenced.
// Compare the actual matrices so manual bone changes and pointer reuse are safe.
template<class Matrix, class Row> class BonePaletteCache
{
    struct Palette { std::vector<Matrix> source; std::vector<Row> rows; };
    std::unordered_map<const void*, Palette> palettes;
public:
    size_t packedBones = 0, reusedBones = 0;
    template<class GetMatrix> const Row* get(const void* key, size_t count, GetMatrix getMatrix)
    {
        if (!palettes.count(key) && palettes.size() >= 128) palettes.clear();
        auto& p = palettes[key];
        const size_t old = p.source.size();
        p.source.resize(count); p.rows.resize(count * 3);
        for (size_t n = 0; n < count; ++n)
        {
            const Matrix& m = getMatrix(n);
            if (n < old && std::memcmp(&p.source[n], &m, sizeof(Matrix)) == 0)
            { ++reusedBones; continue; }
            std::memcpy(&p.source[n], &m, sizeof(Matrix));
            p.rows[n*3+0].set(m._11, m._21, m._31, m._41);
            p.rows[n*3+1].set(m._12, m._22, m._32, m._42);
            p.rows[n*3+2].set(m._13, m._23, m._33, m._43);
            ++packedBones;
        }
        return p.rows.data();
    }
};
}
