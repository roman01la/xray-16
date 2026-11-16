#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
using Bytes = std::span<const uint8_t>;
constexpr size_t maxFileBytes = 64 * 1024 * 1024;

enum ChunkId : uint32_t {
    Header = 1, Material = 2, Vertices = 3, Indices = 4,
    SlideWindows = 6, Children = 9, ChildLinks = 10, Bones = 13,
    MotionTracks = 14, MotionParams = 15, BoneIK = 16, MotionRefs = 19, MotionRefs2 = 24
};

class Reader {
public:
    explicit Reader(Bytes bytes) : bytes_(bytes) {}
    size_t remaining() const { return bytes_.size(); }
    Bytes bytes() const { return bytes_; }

    Bytes take(size_t size) {
        if (size > remaining())
            throw std::runtime_error("Truncated OGF data");
        const auto value = bytes_.first(size);
        bytes_ = bytes_.subspan(size);
        return value;
    }

    uint8_t u8() { return take(1)[0]; }
    uint16_t u16() {
        const auto s = take(2);
        return static_cast<uint16_t>(s[0] | (s[1] << 8));
    }
    uint32_t u32() {
        const auto s = take(4);
        return uint32_t(s[0]) | (uint32_t(s[1]) << 8) |
            (uint32_t(s[2]) << 16) | (uint32_t(s[3]) << 24);
    }
    float f32() { return std::bit_cast<float>(u32()); }
    void skipLine() {
        const auto end = std::find_if(bytes_.begin(), bytes_.end(),
            [](uint8_t c) { return c == '\r' || c == '\n'; });
        if (end == bytes_.end()) throw std::runtime_error("Unterminated OMF motion mark");
        const auto newline = take(static_cast<size_t>(end - bytes_.begin()) + 1).back();
        if (newline == '\r' && remaining() && bytes_.front() == '\n') take(1);
    }

    std::string string() {
        const auto end = std::find(bytes_.begin(), bytes_.end(), uint8_t{0});
        if (end == bytes_.end())
            throw std::runtime_error("Unterminated OGF material name");
        const auto length = static_cast<size_t>(end - bytes_.begin());
        if (length > 4096)
            throw std::runtime_error("Invalid OGF material name");
        const auto data = take(length + 1);
        return std::string(reinterpret_cast<const char*>(data.data()), length);
    }

private:
    Bytes bytes_;
};

struct Chunk {
    uint32_t id;
    Bytes data;

    Reader reader() const {
        if (id & 0x80000000)
            throw std::runtime_error("Compressed OGF chunks are unsupported");
        return Reader(data);
    }
};

Chunk nextChunk(Reader& reader) {
    const auto id = reader.u32();
    const auto size = reader.u32();
    return {id, reader.take(size)};
}

#include "animation.hpp"

struct Vertex {
    float position[3];
    float normal[3];
    float uv[2];
};
static_assert(sizeof(Vertex) == 8 * sizeof(float));

struct Skin {
    std::array<uint32_t, 4> bones{};
    std::array<float, 4> weights{};
    unsigned count = 0;
};

struct Mesh {
    std::vector<Vertex> vertices;
    std::vector<Vertex> posed;
    std::vector<Skin> skin;
    std::vector<uint16_t> indices;
    std::string texture;
    std::string shader;
};

#include "level.hpp"

struct Model {
    std::vector<Mesh> meshes;
    Skeleton skeleton;
    std::vector<std::string> references;
    std::vector<MotionSource> sources;
    std::vector<std::pair<size_t, size_t>> clips;
    std::string animationError;
    uint32_t boneCount = 0;

    void addMotions(Bytes data) {
        auto source = readMotions(data, skeleton);
        sources.reserve(sources.size() + 1);
        clips.reserve(clips.size() + source.clips.size());
        for (size_t i = 0; i < source.clips.size(); ++i)
            clips.emplace_back(sources.size(), i);
        sources.push_back(std::move(source));
    }
};

struct VertexLayout {
    size_t stride;
    size_t position;
    size_t normal;
    size_t uv;
    unsigned links;
};

VertexLayout vertexLayout(uint32_t format, size_t count, size_t size) {
    constexpr uint32_t socSkinFormat = 0x12071980;
    constexpr uint32_t staticFormat = 0x112; // D3DFVF_XYZ | D3DFVF_NORMAL | D3DFVF_TEX1
    switch (format) {
    case staticFormat: return {32, 0, 12, 24, 0};
    case socSkinFormat:
    case 1:
        // Older 1-link files omit the tangent and bitangent.
        return size == count * 36 ? VertexLayout{36, 0, 12, 24, 1} : VertexLayout{60, 0, 12, 48, 1};
    case 2 * socSkinFormat:
    case 2: return {64, 4, 16, 56, 2};
    case 4 * socSkinFormat:
    case 3: return {70, 6, 18, 62, 3};
    case 5 * socSkinFormat:
    case 4: return {76, 8, 20, 68, 4};
    default: throw std::runtime_error("Unsupported OGF vertex layout: " + std::to_string(format));
    }
}

Skin readSkin(Bytes record, const VertexLayout& layout) {
    Skin skin;
    skin.count = layout.links;
    if (skin.count == 1) {
        skin.bones[0] = Reader(record.last(4)).u32();
        skin.weights[0] = 1;
    } else {
        Reader bones(record);
        for (unsigned i = 0; i < skin.count; ++i) skin.bones[i] = bones.u16();
        Reader weights(record.subspan(layout.position + 48));
        if (skin.count == 2) {
            skin.weights[1] = weights.f32();
            skin.weights[0] = 1 - skin.weights[1];
        } else {
            float rest = 1;
            for (unsigned i = 0; i + 1 < skin.count; ++i) {
                skin.weights[i] = weights.f32();
                rest -= skin.weights[i];
            }
            skin.weights[skin.count - 1] = rest;
        }
    }
    return skin;
}

void readVertices(Mesh& mesh, Reader reader) {
    const auto format = reader.u32();
    const auto count = reader.u32();
    if (!count || count > 65536)
        throw std::runtime_error("Invalid OGF vertex count");
    const auto layout = vertexLayout(format, count, reader.remaining());
    if (reader.remaining() != count * layout.stride)
        throw std::runtime_error("OGF vertex data does not match its layout");
    mesh.vertices.reserve(count);
    if (layout.links) mesh.skin.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
        const auto record = reader.take(layout.stride);
        Vertex vertex{};
        Reader position(record.subspan(layout.position));
        Reader normal(record.subspan(layout.normal));
        Reader uv(record.subspan(layout.uv));
        for (float& component : vertex.position)
            component = position.f32();
        for (float& component : vertex.normal)
            component = normal.f32();
        for (float& component : vertex.uv)
            component = uv.f32();
        for (const auto components : {std::span<const float>(vertex.position),
                 std::span<const float>(vertex.normal), std::span<const float>(vertex.uv)}) {
            if (!std::all_of(components.begin(), components.end(), [](float value) { return std::isfinite(value); }))
                throw std::runtime_error("Invalid floating-point value in OGF vertex");
        }
        mesh.vertices.push_back(vertex);
        if (layout.links) mesh.skin.push_back(readSkin(record, layout));
    }
}

void readIndices(Mesh& mesh, Reader reader, const Chunk* slideWindows) {
    const auto count = reader.u32();
    if (!count || count % 3 || count != reader.remaining() / 2 || reader.remaining() % 2)
        throw std::runtime_error("Invalid OGF index count");

    uint32_t first = 0;
    uint32_t length = count;
    auto vertices = mesh.vertices.size();
    if (slideWindows) {
        auto lod = slideWindows->reader();
        lod.take(16); // Reserved fields.
        const auto windowCount = lod.u32();
        if (!windowCount || windowCount > lod.remaining() / 8)
            throw std::runtime_error("Invalid OGF LOD windows");
        // The first window is the full-detail triangle list.
        first = lod.u32();
        length = uint32_t(lod.u16()) * 3;
        vertices = lod.u16();
        if (!length || !vertices || vertices > mesh.vertices.size() || first > count || length > count - first)
            throw std::runtime_error("OGF LOD window points outside its mesh");
    }

    reader.take(first * 2);
    mesh.indices.reserve(length);
    for (uint32_t i = 0; i < length; ++i) {
        const auto index = reader.u16();
        if (index >= vertices)
            throw std::runtime_error("OGF triangle references a missing vertex");
        mesh.indices.push_back(index);
    }
    mesh.vertices.resize(vertices);
    if (!mesh.skin.empty()) mesh.skin.resize(vertices);
}

void readVisual(Model& model, Reader source, unsigned depth = 0) {
    if (depth > 16)
        throw std::runtime_error("OGF model hierarchy is too deep");

    const auto visual = source.bytes();
    std::vector<Chunk> chunks;
    while (source.remaining()) {
        if (chunks.size() == 256)
            throw std::runtime_error("Too many OGF chunks in one visual");
        chunks.push_back(nextChunk(source));
    }
    const auto find = [&](ChunkId id) -> const Chunk* {
        const auto chunk = std::find_if(chunks.begin(), chunks.end(),
            [=](const Chunk& candidate) { return (candidate.id & 0x7fffffff) == id; });
        return chunk == chunks.end() ? nullptr : &*chunk;
    };

    const auto* headerChunk = find(Header);
    if (!headerChunk)
        throw std::runtime_error("Missing OGF header");
    auto header = headerChunk->reader();
    const auto version = header.u8();
    if (version != 4)
        throw std::runtime_error("This viewer supports OGF v4; this file is v" + std::to_string(version));
    header.take(43);
    if (depth == 0) {
        if (const auto* bones = find(Bones)) {
            model.boneCount = bones->reader().u32();
            try {
                model.skeleton = readSkeleton(bones->reader(), find(BoneIK));
                if (const auto* refs = find(MotionRefs)) {
                    auto names = refs->reader().string();
                    size_t start = 0;
                    while (start < names.size()) {
                        const auto end = names.find(',', start);
                        model.references.push_back(names.substr(start, end - start));
                        if (end == std::string::npos) break;
                        start = end + 1;
                    }
                } else if (const auto* refs = find(MotionRefs2)) {
                    auto names = refs->reader();
                    const auto count = names.u32();
                    if (count > 512 || count > names.remaining())
                        throw std::runtime_error("Invalid OGF motion references");
                    for (uint32_t i = 0; i < count; ++i) model.references.push_back(names.string());
                } else if (find(MotionTracks) && find(MotionParams)) {
                    model.addMotions(visual);
                }
            } catch (const std::exception& exception) {
                model.animationError = exception.what();
            }
        }
    }

    const auto* vertices = find(Vertices);
    const auto* indices = find(Indices);
    if (vertices && indices) {
        if (model.meshes.size() >= 1024)
            throw std::runtime_error("Too many OGF mesh parts");
        Mesh mesh;
        if (const auto* material = find(Material)) {
            auto names = material->reader();
            mesh.texture = names.string();
            mesh.shader = names.string();
        }
        readVertices(mesh, vertices->reader());
        readIndices(mesh, indices->reader(), find(SlideWindows));
        model.meshes.push_back(std::move(mesh));
    } else if (vertices || indices || (!find(Children) && !find(ChildLinks))) {
        throw std::runtime_error("This OGF visual does not contain inline mesh geometry");
    }

    if (const auto* children = find(Children)) {
        auto list = children->reader();
        while (list.remaining())
            readVisual(model, nextChunk(list).reader(), depth + 1);
    }
    if (find(ChildLinks))
        throw std::runtime_error("OGF files that link to external level geometry are unsupported");
}

Model model;
std::string error;
size_t activeClip = SIZE_MAX;
std::vector<Track> tracks;
std::vector<Transform> worldTransforms;
std::vector<Transform> skinTransforms;

void skinMesh(Mesh& mesh) {
    if (mesh.skin.empty()) return;
    mesh.posed.resize(mesh.vertices.size());
    for (size_t i = 0; i < mesh.vertices.size(); ++i) {
        const auto& vertex = mesh.vertices[i];
        const auto& skin = mesh.skin[i];
        auto& posed = mesh.posed[i];
        posed = vertex;
        Vec3 position{}, normal{};
        float total = 0;
        for (unsigned link = 0; link < skin.count; ++link) {
            const auto bone = skin.bones[link];
            const auto weight = skin.weights[link];
            if (bone >= skinTransforms.size() || !std::isfinite(weight) || weight <= 0) continue;
            const auto& matrix = skinTransforms[bone];
            const auto p = transform(matrix, {vertex.position[0], vertex.position[1], vertex.position[2]}, true);
            const auto n = transform(matrix, {vertex.normal[0], vertex.normal[1], vertex.normal[2]}, false);
            for (size_t axis = 0; axis < 3; ++axis) {
                position[axis] += weight * p[axis];
                normal[axis] += weight * n[axis];
            }
            total += weight;
        }
        if (total <= 0) continue;
        for (size_t axis = 0; axis < 3; ++axis) {
            posed.position[axis] = position[axis] / total;
            posed.normal[axis] = normal[axis] / total;
        }
    }
}

const Clip& clipAt(size_t id) {
    const auto [source, index] = model.clips[id];
    return model.sources[source].clips[index];
}
} // namespace

extern "C" {
int ogf_load(const uint8_t* data, size_t size) {
    error.clear();
    activeClip = SIZE_MAX;
    tracks.clear();
    model = {};
    try {
        if (!data || size < 8 || size > maxFileBytes)
            throw std::runtime_error("Choose an OGF file up to 64 MiB");
        Model loaded;
        readVisual(loaded, Reader(Bytes(data, size)));
        if (loaded.meshes.empty())
            throw std::runtime_error("This OGF has no mesh parts to display");
        model = std::move(loaded);
        return 1;
    } catch (const std::exception& exception) {
        error = exception.what();
        return 0;
    }
}

int ogf_load_level(const uint8_t* level, size_t levelSize, const uint8_t* geometry, size_t geometrySize) {
    error.clear();
    activeClip = SIZE_MAX;
    tracks.clear();
    model = {};
    try {
        if (!level || !geometry || levelSize > maxLevelBytes || geometrySize > maxLevelBytes)
            throw std::runtime_error("Map files exceed the viewer’s 256 MiB limit");
        model.meshes = readLevel(Bytes(level, levelSize), Bytes(geometry, geometrySize));
        return 1;
    } catch (const std::exception& exception) {
        error = exception.what();
        return 0;
    }
}

void ogf_release_level() { model.meshes.clear(); }

const char* ogf_error() { return error.c_str(); }
uint32_t ogf_mesh_count() { return static_cast<uint32_t>(model.meshes.size()); }
uint32_t ogf_bone_count() { return model.boneCount; }
uint32_t ogf_vertex_count(uint32_t mesh) { return static_cast<uint32_t>(model.meshes[mesh].vertices.size()); }
uint32_t ogf_index_count(uint32_t mesh) { return static_cast<uint32_t>(model.meshes[mesh].indices.size()); }
const Vertex* ogf_vertices(uint32_t mesh) { return model.meshes[mesh].vertices.data(); }
const uint16_t* ogf_indices(uint32_t mesh) { return model.meshes[mesh].indices.data(); }
const char* ogf_texture(uint32_t mesh) { return model.meshes[mesh].texture.c_str(); }
const char* ogf_shader(uint32_t mesh) { return model.meshes[mesh].shader.c_str(); }
const char* ogf_animation_error() { return model.animationError.c_str(); }
uint32_t ogf_reference_count() { return static_cast<uint32_t>(model.references.size()); }
const char* ogf_reference(uint32_t id) { return model.references[id].c_str(); }
uint32_t ogf_clip_count() { return static_cast<uint32_t>(model.clips.size()); }
const char* ogf_clip_name(uint32_t id) { return clipAt(id).name.c_str(); }
float ogf_clip_duration(uint32_t id) { return clipAt(id).duration(); }
int ogf_clip_loops(uint32_t id) { return !clipAt(id).stopAtEnd; }
const Vertex* ogf_posed_vertices(uint32_t mesh) {
    const auto& part = model.meshes[mesh];
    return part.posed.empty() ? part.vertices.data() : part.posed.data();
}

int ogf_add_motions(const uint8_t* data, size_t size) {
    try {
        if (!data || size > maxFileBytes || model.skeleton.bones.empty())
            throw std::runtime_error("OMF cannot be loaded for this model");
        model.addMotions(Bytes(data, size));
        return 1;
    } catch (const std::exception& exception) {
        error = exception.what();
        return 0;
    }
}

int ogf_select_clip(uint32_t id) {
    try {
        if (id >= model.clips.size()) throw std::runtime_error("Unknown animation");
        const auto [source, index] = model.clips[id];
        bool repaired = false;
        tracks = readTracks(model.sources[source], model.sources[source].clips[index], model.skeleton, repaired);
        worldTransforms.resize(tracks.size());
        skinTransforms.resize(tracks.size());
        activeClip = id;
        error = repaired ? "Invalid translation values in this clip were replaced with bind-pose values." : "";
        return 1;
    } catch (const std::exception& exception) {
        error = exception.what();
        return 0;
    }
}

int ogf_pose(float seconds, int looping, int inPlace) {
    if (activeClip >= model.clips.size() || !std::isfinite(seconds)) return 0;
    const auto& clip = clipAt(activeClip);
    const float frameTime = std::clamp(seconds, 0.f, clip.duration()) * clip.speed * animationFps;
    const auto frame = std::min(static_cast<uint32_t>(frameTime), clip.frames - 1);
    const auto next = frame + 1 < clip.frames ? frame + 1 : (looping ? 0 : frame);
    const float delta = std::min(frameTime - frame, 1.f);

    for (size_t id : model.skeleton.order) {
        const auto& bone = model.skeleton.bones[id];
        const auto& track = tracks[id];
        auto rotation = readRotation(track, frame);
        if (!(track.flags & constantRotation))
            rotation = interpolateRotation(rotation, readRotation(track, next), delta);
        auto translation = readTranslation(track, frame);
        if (track.flags & animatedTranslation) {
            const auto end = readTranslation(track, next);
            for (size_t axis = 0; axis < 3; ++axis)
                translation[axis] += delta * (end[axis] - translation[axis]);
        }
        if (inPlace && bone.parent < 0) {
            const auto start = readTranslation(track, 0);
            translation[0] = start[0];
            translation[2] = start[2];
        }
        const auto local = motionTransform(rotation, translation);
        worldTransforms[id] = bone.parent < 0 ? local : compose(worldTransforms[bone.parent], local);
        skinTransforms[id] = compose(worldTransforms[id], bone.inverseBind);
    }
    for (auto& mesh : model.meshes) skinMesh(mesh);
    return 1;
}
}
