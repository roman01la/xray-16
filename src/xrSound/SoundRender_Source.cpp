#include "stdafx.h"

#include "SoundRender_Core.h"
#include "SoundRender_Source.h"

#include <vorbis/vorbisfile.h>

#ifdef XR_PLATFORM_WEB
#include <array>
#include <cstring>
#include <tuple>
#endif

CSoundRender_Source::~CSoundRender_Source() { unload(); }

namespace
{
#ifdef XR_PLATFORM_WEB
struct PackedSoundMetadata
{
    u32 crc, size, offset;
    u32 rate, channels, frames, commentSize;
    std::array<u8, 24> comment;

    auto key() const { return std::tie(crc, size, offset); }
};
static_assert(sizeof(PackedSoundMetadata) == 52);

const auto& packed_sound_metadata()
{
    static const auto data = [] {
        xr_vector<PackedSoundMetadata> entries;
        IReader* file = FS.r_open("$game_config$", "browser_sound_metadata.bin");
        if (!file)
            return entries;
        if (file->length() >= 8 && std::memcmp(file->pointer(), "XSA1", 4) == 0)
        {
            file->advance(4);
            const u32 count = file->r_u32();
            if (count && count <= 100000 && file->elapsed() == count * sizeof(PackedSoundMetadata))
            {
                entries.resize(count);
                file->r(entries.data(), count * sizeof(PackedSoundMetadata));
                const auto unordered = std::adjacent_find(entries.begin(), entries.end(),
                    [](const auto& a, const auto& b) { return a.key() >= b.key(); });
                if (unordered != entries.end())
                    entries.clear();
            }
        }
        FS.r_close(file);
        Msg("* Browser sound metadata: %zu archive entries", entries.size());
        return entries;
    }();
    return data;
}

const PackedSoundMetadata* find_packed_sound_metadata(pcstr path)
{
    const auto& entries = packed_sound_metadata();
    if (entries.empty())
        return nullptr;
    const auto* asset = FS.GetFileDesc(path);
    if (!asset || asset->vfs == size_t(-1) || asset->size_real != asset->size_compressed)
        return nullptr;
    const auto key = std::tie(asset->crc, asset->size_real, asset->ptr);
    const auto item = std::lower_bound(entries.begin(), entries.end(), key,
        [](const auto& entry, const auto& value) { return entry.key() < value; });
    if (item == entries.end() || item->key() != key || !item->rate || item->rate > 384000 ||
        !item->channels || item->channels > 8 || !item->frames || item->frames > UINT32_MAX / (item->channels * 4) ||
        item->commentSize > item->comment.size())
        return nullptr;
    if (item->commentSize)
    {
        IReader comment(const_cast<u8*>(item->comment.data()), item->commentSize);
        if (comment.length() < 4)
            return nullptr;
        const u32 version = comment.r_u32();
        if ((version == 1 && comment.length() < 16) || (version == 2 && comment.length() < 20) ||
            (version == OGG_COMMENT_VERSION && comment.length() < 24))
            return nullptr;
    }
    return &*item;
}
#endif

bool ov_can_continue_read(long res)
{
    switch (res)
    {
    case 0:
        return false;
    // info
    case OV_HOLE:
        Msg("Vorbisfile encoutered missing or corrupt data in the bitstream. Recovery is normally automatic and this "
            "return code is for informational purposes only.");
        return true;
    case OV_EBADLINK:
        Msg("The given link exists in the Vorbis data stream, but is not decipherable due to garbage or corruption.");
        return true;
    // error
    case OV_FALSE: Msg("Not true, or no data available"); return false;
    case OV_EREAD: Msg("Read error while fetching compressed data for decode"); return false;
    case OV_EFAULT: Msg("Internal inconsistency in decode state. Continuing is likely not possible."); return false;
    case OV_EIMPL: Msg("Feature not implemented"); return false;
    case OV_EINVAL:
        Msg("Either an invalid argument, or incompletely initialized argument passed to libvorbisfile call");
        return false;
    case OV_ENOTVORBIS: Msg("The given file/data was not recognized as Ogg Vorbis data."); return false;
    case OV_EBADHEADER:
        Msg("The file/data is apparently an Ogg Vorbis stream, but contains a corrupted or undecipherable header.");
        return false;
    case OV_EVERSION: Msg("The bitstream format revision of the given stream is not supported."); return false;
    case OV_ENOSEEK: Msg("The given stream is not seekable"); return false;
    }
    return false;
}
}

void CSoundRender_Source::decompress(void* dest, u32 byte_offset, u32 size, OggVorbis_File* ovf) const
{
    ZoneScoped;

    // seek
    const auto sample_offset = ogg_int64_t(byte_offset / m_data_info.blockAlign);
    const u32 cur_pos = u32(ov_pcm_tell(ovf));
    if (cur_pos != sample_offset)
        ov_pcm_seek(ovf, sample_offset);

    // decompress
    if (m_data_info.format == SoundFormat::Float32)
        i_decompress(ovf, static_cast<float*>(dest), size);
    else
        i_decompress(ovf, static_cast<char*>(dest), size);
}

void CSoundRender_Source::i_decompress(OggVorbis_File* ovf, char* _dest, u32 size) const
{
    long TotalRet = 0;

    // Read loop
    while (TotalRet < static_cast<long>(size))
    {
        const auto ret = ov_read(ovf, _dest + TotalRet, size - TotalRet, 0, 2, 1, nullptr);
        if (ret <= 0 && !ov_can_continue_read(ret))
            break;
        TotalRet += ret;
    }
}

void CSoundRender_Source::i_decompress(OggVorbis_File* ovf, float* _dest, u32 size) const
{
    s32 left = s32(size / m_data_info.blockAlign);
    while (left)
    {
        float** pcm;
        long samples = ov_read_float(ovf, &pcm, left, nullptr);

        if (samples <= 0 && !ov_can_continue_read(samples))
            break;

        if (samples > left)
            samples = left;

        for (long j = 0; j < samples; j++)
            for (long i = 0; i < m_data_info.channels; i++)
                *_dest++ = clampr(pcm[i][j], -1.0f, 1.0f);

        left -= samples;
    }
}

constexpr ov_callbacks g_ov_callbacks =
{
    // read
    [](void* ptr, size_t size, size_t nmemb, void* datasource) -> size_t
    {
        auto* file = static_cast<IReader*>(datasource);
        const size_t exist_block = _max(0ul, iFloor(file->elapsed() / (float)size));
        const size_t read_block = std::min(exist_block, nmemb);
        file->r(ptr, read_block * size);
        return read_block;
    },
    // seek
    [](void* datasource, ogg_int64_t offset, int whence) -> int
    {
        //SEEK_SET 0 File beginning
        //SEEK_CUR 1 Current file pointer position
        //SEEK_END 2 End-of-file
        switch (whence)
        {
        case SEEK_SET: ((IReader*)datasource)->seek((int)offset); break;
        case SEEK_CUR: ((IReader*)datasource)->advance((int)offset); break;
        case SEEK_END: ((IReader*)datasource)->seek((int)offset + ((IReader*)datasource)->length()); break;
        }
        return 0;
    },
    // close
    [](void* datasource) -> int
    {
        auto* file = static_cast<IReader*>(datasource);
        FS.r_close(file);
        return 0;
    },
    // tell
    [](void* datasource) -> long
    {
        const auto file = static_cast<IReader*>(datasource);
        return static_cast<long>(file->tell());
    },
};

OggVorbis_File* CSoundRender_Source::open() const
{
    const auto file = FS.r_open(pname.c_str());
    R_ASSERT3(file && file->length(), "Can't open wave file:", pname.c_str());

    const auto ovf = xr_new<OggVorbis_File>();
    ov_open_callbacks(file, ovf, nullptr, 0, g_ov_callbacks);

    return ovf;
}

void CSoundRender_Source::close(OggVorbis_File*& ovf) const
{
    ov_clear(ovf);
    xr_delete(ovf);
}

bool CSoundRender_Source::LoadWave(pcstr pName)
{
    ZoneScoped;

    pname = pName;
#ifdef XR_PLATFORM_WEB
    if (const auto* packed = find_packed_sound_metadata(pName))
        return set_metadata(packed->rate, u16(packed->channels), packed->frames,
            packed->commentSize ? packed->comment.data() : nullptr, packed->commentSize);
#endif

    // Load file into memory and parse the original Vorbis metadata.
    OggVorbis_File ovf;
    {
        IReader* wave = FS.r_open(pname.c_str());
        R_ASSERT3(wave && wave->length(), "Can't open wave file:", pname.c_str());
        ov_open_callbacks(wave, &ovf, nullptr, 0, g_ov_callbacks);
    }

    const vorbis_info* ovi = ov_info(&ovf, -1);

    // verify
    R_ASSERT3_CURE(ovi, "Invalid source info:", pName,
    {
        ov_clear(&ovf);
        return false;
    });

    const vorbis_comment* ovm = ov_comment(&ovf, -1);
    const bool valid = set_metadata(ovi->rate, u16(ovi->channels), ov_pcm_total(&ovf, -1),
        ovm->comments ? ovm->user_comments[0] : nullptr, ovm->comments ? ovm->comment_lengths[0] : 0);
    ov_clear(&ovf);
    return valid;
}

#ifdef XR_PLATFORM_WEB
void CSoundRender_Source::InitializePackedMetadata()
{
    (void)packed_sound_metadata();
}
#endif

bool CSoundRender_Source::set_metadata(u32 rate, u16 channels, s64 frames, const void* comment, size_t commentSize)
{
    m_data_info = {};

    m_data_info.samplesPerSec = rate;
    m_data_info.channels = channels;

    if (SoundRender->supports_float_pcm)
    {
        m_data_info.format = SoundFormat::Float32;
        m_data_info.bitsPerSample = 32;
    }
    else
    {
        m_data_info.format = SoundFormat::PCM;
        m_data_info.bitsPerSample = 16;
    }

    m_data_info.blockAlign = m_data_info.bitsPerSample / 8 * m_data_info.channels;
    m_data_info.avgBytesPerSec = m_data_info.samplesPerSec * m_data_info.blockAlign;
    m_data_info.bytesPerBuffer = sdef_target_block * m_data_info.avgBytesPerSec / 1000;

    dwBytesTotal = u32(frames * m_data_info.blockAlign);
    fTimeTotal = dwBytesTotal / float(m_data_info.avgBytesPerSec);

    m_info = {};

    if (comment)
    {
        IReader F(const_cast<void*>(comment), commentSize);
        const u32 vers = F.r_u32();
        if (vers == 0x0001)
        {
            m_info.minDist = F.r_float();
            m_info.maxDist = F.r_float();
            m_info.baseVolume = 1.f;
            m_info.gameType = F.r_u32();
            m_info.maxAIDist = m_info.maxDist;
        }
        else if (vers == 0x0002)
        {
            m_info.minDist = F.r_float();
            m_info.maxDist = F.r_float();
            m_info.baseVolume = F.r_float();
            m_info.gameType = F.r_u32();
            m_info.maxAIDist = m_info.maxDist;
        }
        else if (vers == OGG_COMMENT_VERSION)
        {
            m_info.minDist = F.r_float();
            m_info.maxDist = F.r_float();
            m_info.baseVolume = F.r_float();
            m_info.gameType = F.r_u32();
            m_info.maxAIDist = F.r_float();
        }
        else
        {
#ifndef MASTER_GOLD
            Log("! Invalid ogg-comment version, file: ", pname.c_str());
#endif
        }
    }
    else
    {
#ifndef MASTER_GOLD
        Log("! Missing ogg-comment, file: ", pname.c_str());
#endif
    }

    R_ASSERT3_CURE(m_info.maxAIDist >= 0.1f && m_info.maxDist >= 0.1f, "Invalid max distance.", pname.c_str(),
        { return false; });
    return true;
}

bool CSoundRender_Source::load(pcstr name)
{
    string_path fn, N;
    xr_strcpy(N, name);
#ifdef XR_PLATFORM_WINDOWS
    xr_strlwr(N);
#endif

    if (strext(N))
        *strext(N) = 0;

    fname = N;

    strconcat(fn, N, ".ogg");
    if (!FS.exist("$level$", fn))
        FS.update_path(fn, "$game_sounds$", fn);

#ifndef MASTER_GOLD
    if (!FS.exist(fn))
    {
        Msg("~ %s: Can't find sound '%s'", __FUNCTION__, name);
#   ifdef _EDITOR
        FS.update_path(fn, "$game_sounds$", "$no_sound.ogg");
#   endif
    }
#endif

    if (FS.exist(fn))
    {
        if (LoadWave(fn))
            return true;
    }

    return false;
}

void CSoundRender_Source::unload()
{
    fTimeTotal = 0.0f;
    dwBytesTotal = 0;
}
