#include <vorbis/vorbisfile.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

namespace
{
using Word = std::uint32_t;
constexpr std::size_t CommentBytes = 24;

struct Input
{
    std::vector<unsigned char> data;
    std::size_t position{};
};

constexpr ov_callbacks callbacks{
    [](void* output, std::size_t size, std::size_t count, void* context) -> std::size_t {
        auto& input = *static_cast<Input*>(context);
        if (!size)
            return 0;
        const std::size_t blocks = std::min(count, (input.data.size() - input.position) / size);
        std::memcpy(output, input.data.data() + input.position, blocks * size);
        input.position += blocks * size;
        return blocks;
    },
    [](void* context, ogg_int64_t offset, int whence) -> int {
        auto& input = *static_cast<Input*>(context);
        const auto size = static_cast<ogg_int64_t>(input.data.size());
        const auto base = whence == SEEK_CUR ? static_cast<ogg_int64_t>(input.position) : whence == SEEK_END ? size : 0;
        if (offset < -base || offset > size - base)
            return -1;
        input.position = static_cast<std::size_t>(base + offset);
        return 0;
    },
    nullptr,
    [](void* context) -> long { return static_cast<long>(static_cast<Input*>(context)->position); },
};

Word read_word(const unsigned char* bytes)
{
    return Word(bytes[0]) | Word(bytes[1]) << 8 | Word(bytes[2]) << 16 | Word(bytes[3]) << 24;
}

bool write_word(Word value)
{
    const unsigned char bytes[]{static_cast<unsigned char>(value), static_cast<unsigned char>(value >> 8),
        static_cast<unsigned char>(value >> 16), static_cast<unsigned char>(value >> 24)};
    return std::fwrite(bytes, 1, sizeof(bytes), stdout) == sizeof(bytes);
}
}

int main()
{
    std::array<unsigned char, 12> key;
    Input input;
    while (const auto count = std::fread(key.data(), 1, key.size(), stdin))
    {
        if (count != key.size())
            return 1;
        const Word size = read_word(key.data() + 4);
        if (!size || size > 32 * 1024 * 1024)
            return 1;
        input.data.resize(size);
        input.position = 0;
        if (std::fread(input.data.data(), 1, size, stdin) != size)
            return 1;

        OggVorbis_File vorbis;
        if (ov_open_callbacks(&input, &vorbis, nullptr, 0, callbacks) != 0)
            continue;
        const auto* info = ov_info(&vorbis, -1);
        const auto frames = ov_pcm_total(&vorbis, -1);
        const auto* comments = ov_comment(&vorbis, -1);
        const int length = comments && comments->comments ? comments->comment_lengths[0] : 0;
        const auto* comment = length > 0 ? reinterpret_cast<const unsigned char*>(comments->user_comments[0]) : nullptr;
        const Word version = length >= 4 ? read_word(comment) : 0;
        const int minLength = version == 1 ? 16 : version == 2 ? 20 : version == 3 ? 24 : 4;
        const bool usable = ov_streams(&vorbis) == 1 && info && info->rate > 0 && info->rate <= 384000 &&
            info->channels > 0 && info->channels <= 8 && frames > 0 && frames <= UINT32_MAX / (info->channels * 4) &&
            ((!comments || !comments->comments) || length >= minLength);
        if (usable)
        {
            std::array<unsigned char, CommentBytes> bytes{};
            const auto commentSize = std::min<int>(length, bytes.size());
            if (commentSize)
                std::memcpy(bytes.data(), comment, commentSize);
            if (std::fwrite(key.data(), 1, key.size(), stdout) != key.size() || !write_word(info->rate) ||
                !write_word(info->channels) || !write_word(frames) || !write_word(commentSize) ||
                std::fwrite(bytes.data(), 1, bytes.size(), stdout) != bytes.size())
            {
                ov_clear(&vorbis);
                return 1;
            }
        }
        ov_clear(&vorbis);
    }
    return std::ferror(stdin) || std::fflush(stdout) != 0;
}
