// Private OGF/OMF animation code. Uses the viewer's bounded Reader and Chunk types.
using Vec3 = std::array<float, 3>;
using Quat = std::array<float, 4>;

struct Transform {
    std::array<Vec3, 3> axes{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}};
    Vec3 translation{};
};

Vec3 transform(const Transform& pose, const Vec3& point, bool translate) {
    Vec3 result = translate ? pose.translation : Vec3{};
    for (size_t axis = 0; axis < 3; ++axis)
        for (size_t component = 0; component < 3; ++component)
            result[component] += pose.axes[axis][component] * point[axis];
    return result;
}

Transform compose(const Transform& parent, const Transform& local) {
    return {{transform(parent, local.axes[0], false), transform(parent, local.axes[1], false),
             transform(parent, local.axes[2], false)}, transform(parent, local.translation, true)};
}

Transform inverse(const Transform& pose) {
    Transform result;
    for (size_t i = 0; i < 3; ++i)
        for (size_t j = 0; j < 3; ++j)
            result.axes[i][j] = pose.axes[j][i];
    const auto& p = pose.translation;
    result.translation = transform(result, {-p[0], -p[1], -p[2]}, false);
    return result;
}

Vec3 readVector(Reader& reader) {
    const Vec3 value{reader.f32(), reader.f32(), reader.f32()};
    for (float component : value)
        if (!std::isfinite(component) || std::abs(component) > 1e7f)
            throw std::runtime_error("Invalid OGF or OMF transform");
    return value;
}

Vec3 readTrackVector(Reader& reader, const Vec3& fallback, bool& repaired) {
    Vec3 value{reader.f32(), reader.f32(), reader.f32()};
    for (size_t axis = 0; axis < 3; ++axis) {
        if (!std::isfinite(value[axis]) || std::abs(value[axis]) > 1e7f) {
            value[axis] = fallback[axis];
            repaired = true;
        }
    }
    return value;
}

Transform bindTransform(const Vec3& euler, const Vec3& position) {
    // X-Ray setXYZi uses heading, pitch and bank in this order.
    const float h = -euler[1], p = -euler[0], b = -euler[2];
    const float ch = std::cos(h), sh = std::sin(h), cp = std::cos(p), sp = std::sin(p);
    const float cb = std::cos(b), sb = std::sin(b);
    Transform result;
    result.axes = {{{ch * cb - sp * sh * sb, -cp * sb, sp * ch * sb + sh * cb},
                    {sp * sh * cb + ch * sb, cp * cb, sh * sb - sp * ch * cb},
                    {-cp * sh, sp, cp * ch}}};
    result.translation = position;
    return result;
}

Transform motionTransform(const Quat& q, const Vec3& position) {
    const auto [x, y, z, w] = q;
    Transform result;
    result.axes = {{{1 - 2 * (y*y + z*z), 2 * (x*y - w*z), 2 * (x*z + w*y)},
                    {2 * (x*y + w*z), 1 - 2 * (x*x + z*z), 2 * (y*z - w*x)},
                    {2 * (x*z - w*y), 2 * (y*z + w*x), 1 - 2 * (x*x + y*y)}}};
    result.translation = position;
    return result;
}

struct Bone {
    std::string name;
    int parent = -1;
    Transform bindLocal;
    Transform inverseBind;
};

struct Skeleton {
    std::vector<Bone> bones;
    std::vector<size_t> order; // Parent before child, regardless of on-disk order.
};

std::string lowerAscii(std::string name) {
    for (char& c : name)
        if (c >= 'A' && c <= 'Z')
            c = static_cast<char>(c + 'a' - 'A');
    return name;
}

Skeleton readSkeleton(Reader names, const Chunk* ikChunk) {
    const auto count = names.u32();
    if (!count || count > 512 || !ikChunk)
        throw std::runtime_error("Model has no supported bind transforms");
    Skeleton skeleton;
    auto ik = ikChunk->reader();
    std::vector<std::string> parents;
    std::unordered_map<std::string, size_t> ids;
    for (uint32_t i = 0; i < count; ++i) {
        Bone bone;
        bone.name = lowerAscii(names.string());
        if (bone.name.empty() || !ids.emplace(bone.name, i).second)
            throw std::runtime_error("Invalid OGF bone names");
        parents.push_back(lowerAscii(names.string()));
        names.take(60); // Fobb.
        const auto version = ik.u32();
        ik.string(); // Bone game material.
        ik.take(112); // SBoneShape.
        ik.take(version == 0 ? 72 : 76); // SJointIKData including versioned friction.
        const auto rotation = readVector(ik);
        const auto translation = readVector(ik);
        bone.bindLocal = bindTransform(rotation, translation);
        ik.take(16); // Mass and its center.
        skeleton.bones.push_back(std::move(bone));
    }

    for (size_t i = 0; i < count; ++i) {
        if (parents[i].empty()) continue;
        const auto parent = ids.find(parents[i]);
        if (parent == ids.end()) throw std::runtime_error("OGF bone parent is missing");
        skeleton.bones[i].parent = static_cast<int>(parent->second);
    }
    std::vector<uint8_t> state(count);
    std::vector<Transform> world(count);
    const auto visit = [&](auto&& self, size_t id) -> void {
        if (state[id] == 2) return;
        if (state[id] == 1) throw std::runtime_error("Cyclic OGF bone hierarchy");
        state[id] = 1;
        auto& bone = skeleton.bones[id];
        world[id] = bone.bindLocal;
        if (bone.parent >= 0) {
            self(self, bone.parent);
            world[id] = compose(world[bone.parent], bone.bindLocal);
        }
        bone.inverseBind = inverse(world[id]);
        state[id] = 2;
        skeleton.order.push_back(id);
    };
    for (size_t i = 0; i < count; ++i) visit(visit, i);
    return skeleton;
}

constexpr uint8_t animatedTranslation = 1;
constexpr uint8_t constantRotation = 2;
constexpr uint8_t wideTranslation = 4;
constexpr float animationFps = 30;

struct Clip {
    size_t dataOffset;
    size_t dataSize;
    std::string name;
    uint32_t frames;
    float speed = 1;
    bool stopAtEnd = false;

    float duration() const { return frames / (animationFps * speed); }
};

struct MotionSource {
    std::vector<uint8_t> data;
    std::vector<size_t> trackBones;
    std::vector<Clip> clips;
};

struct MotionDefinition {
    float speed;
    bool stopAtEnd;
};

MotionSource readMotions(Bytes source, const Skeleton& skeleton) {
    Reader file(source);
    Chunk params{}, motions{};
    while (file.remaining()) {
        auto chunk = nextChunk(file);
        if ((chunk.id & 0x7fffffff) == 14) motions = chunk;
        if ((chunk.id & 0x7fffffff) == 15) params = chunk;
    }
    if (!params.id || !motions.id) throw std::runtime_error("OMF is missing its parameters or clip data");
    auto info = params.reader();
    const auto version = info.u16(), parts = info.u16();
    if (version > 4 || parts > 512) throw std::runtime_error("Unsupported OMF parameters");

    MotionSource result;
    result.trackBones.resize(skeleton.bones.size(), SIZE_MAX);
    std::unordered_map<std::string, size_t> ids;
    for (size_t i = 0; i < skeleton.bones.size(); ++i) ids.emplace(skeleton.bones[i].name, i);
    std::vector<bool> seen(ids.size());
    for (uint16_t part = 0; part < parts; ++part) {
        info.string();
        const auto count = info.u16();
        for (uint16_t i = 0; i < count; ++i) {
            const auto bone = ids.find(lowerAscii(info.string()));
            const auto track = info.u32();
            if (bone == ids.end() || track >= result.trackBones.size() ||
                result.trackBones[track] != SIZE_MAX || seen[bone->second])
                throw std::runtime_error("OMF skeleton does not match this model");
            result.trackBones[track] = bone->second;
            seen[bone->second] = true;
        }
    }
    if (std::find(seen.begin(), seen.end(), false) != seen.end())
        throw std::runtime_error("OMF is missing bones required by this model");

    const auto definitionCount = info.u16();
    std::unordered_map<std::string, MotionDefinition> definitions;
    for (uint16_t i = 0; i < definitionCount; ++i) {
        auto name = lowerAscii(info.string());
        const auto flags = info.u32();
        info.take(4); // Bone/partition and motion ID.
        const auto speed = info.f32();
        info.take(12); // Power, accrue and falloff.
        definitions.emplace(std::move(name), MotionDefinition{
            std::isfinite(speed) && speed >= .01f ? std::min(speed, 100.f) : 1.f, (flags & 2) != 0});
        if (version >= 4) {
            const auto marks = info.u32();
            if (marks > info.remaining() / 5) throw std::runtime_error("Invalid OMF motion marks");
            for (uint32_t mark = 0; mark < marks; ++mark) {
                info.skipLine();
                const auto intervals = info.u32();
                if (intervals > info.remaining() / 8) throw std::runtime_error("Invalid OMF motion intervals");
                info.take(intervals * 8);
            }
        }
    }

    auto clips = motions.reader();
    if (!clips.remaining()) throw std::runtime_error("Empty OMF clip table");
    const auto countChunk = nextChunk(clips);
    if (countChunk.id != 0) throw std::runtime_error("Missing OMF clip count");
    const auto count = countChunk.reader().u32();
    if (count > 16383 || count > clips.remaining() / 13)
        throw std::runtime_error("Invalid OMF clip count");
    for (uint32_t i = 0; i < count; ++i) {
        const auto chunk = nextChunk(clips);
        if (chunk.id != i + 1) throw std::runtime_error("Invalid OMF clip index");
        auto clipReader = chunk.reader();
        auto name = clipReader.string();
        const auto frames = clipReader.u32();
        if (!frames || frames > 1000000) throw std::runtime_error("Invalid OMF frame count");
        Clip clip{size_t(chunk.data.data() - source.data()) + chunk.data.size() - clipReader.remaining(),
            clipReader.remaining(), std::move(name), frames};
        if (const auto it = definitions.find(lowerAscii(clip.name)); it != definitions.end()) {
            clip.speed = it->second.speed;
            clip.stopAtEnd = it->second.stopAtEnd;
        }
        result.clips.push_back(std::move(clip));
    }
    result.data.assign(source.begin(), source.end());
    return result;
}

struct Track {
    Bytes rotations;
    Bytes translations;
    Vec3 scale{};
    Vec3 origin{};
    uint8_t flags;
};

std::vector<Track> readTracks(const MotionSource& source, const Clip& clip, const Skeleton& skeleton, bool& repaired) {
    Reader reader(Bytes(source.data).subspan(clip.dataOffset, clip.dataSize));
    std::vector<Track> tracks(source.trackBones.size());
    for (size_t bone : source.trackBones) {
        auto& track = tracks[bone];
        track.flags = reader.u8();
        const bool constant = track.flags & constantRotation;
        if (!constant) reader.take(4); // Rotation CRC.
        track.rotations = reader.take((constant ? 1 : clip.frames) * 8);
        if (track.flags & animatedTranslation) {
            reader.take(4); // Translation CRC.
            track.translations = reader.take(clip.frames * (track.flags & wideTranslation ? 6 : 3));
            track.scale = readTrackVector(reader, {}, repaired);
        }
        track.origin = readTrackVector(reader, skeleton.bones[bone].bindLocal.translation, repaired);
    }
    if (reader.remaining()) throw std::runtime_error("Unexpected bytes after OMF tracks");
    return tracks;
}

Quat readRotation(const Track& track, uint32_t frame) {
    Reader reader(track.rotations.subspan(track.flags & constantRotation ? 0 : frame * 8));
    Quat q;
    for (float& component : q) component = std::bit_cast<int16_t>(reader.u16()) / 32767.f;
    float norm = 0;
    for (float component : q) norm += component * component;
    if (norm < 1e-8f) return {0, 0, 0, 1};
    for (float& component : q) component /= std::sqrt(norm);
    return q;
}

Quat interpolateRotation(Quat a, Quat b, float fraction) {
    float dot = 0;
    for (size_t i = 0; i < 4; ++i) dot += a[i] * b[i];
    if (dot < 0) {
        for (float& component : b) component = -component;
        dot = -dot;
    }
    float weightA = 1 - fraction, weightB = fraction;
    if (dot < .9995f) {
        const float angle = std::acos(dot), denominator = std::sin(angle);
        weightA = std::sin(weightA * angle) / denominator;
        weightB = std::sin(weightB * angle) / denominator;
    }
    Quat result;
    float norm = 0;
    for (size_t i = 0; i < 4; ++i) {
        result[i] = a[i] * weightA + b[i] * weightB;
        norm += result[i] * result[i];
    }
    for (float& component : result) component /= std::sqrt(norm);
    return result;
}

Vec3 readTranslation(const Track& track, uint32_t frame) {
    auto translation = track.origin;
    if (track.translations.empty()) return translation;
    const bool wide = (track.flags & wideTranslation) != 0;
    Reader reader(track.translations.subspan(frame * (wide ? 6 : 3)));
    for (size_t i = 0; i < 3; ++i) {
        const int key = wide ? std::bit_cast<int16_t>(reader.u16()) : std::bit_cast<int8_t>(reader.u8());
        translation[i] += key * track.scale[i];
    }
    return translation;
}
