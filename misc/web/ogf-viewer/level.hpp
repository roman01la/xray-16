// Static level geometry shared by the trilogy's PC level archives.
constexpr size_t maxLevelBytes = 256 * 1024 * 1024;
constexpr size_t maxBatchVertices = 65536;

struct LevelElement {
    size_t offset = 0;
    uint8_t type = 17; // D3DDECLTYPE_UNUSED
};

struct LevelVertices {
    Bytes data;
    size_t count = 0;
    size_t stride = 0;
    LevelElement position, normal, tangent, binormal, uv;
};

struct LevelWindow {
    size_t offset, indices, vertices;
};

Bytes levelChunk(Bytes data, uint32_t id) {
    Reader source(data);
    while (source.remaining()) {
        const auto chunk = nextChunk(source);
        if ((chunk.id & 0x7fffffff) == id) return chunk.reader().bytes();
    }
    return {};
}

std::vector<LevelVertices> levelVertexBuffers(Reader source) {
    constexpr std::array<size_t, 17> sizes{4, 8, 12, 16, 4, 4, 4, 8, 4, 4, 8, 4, 8, 4, 4, 4, 8};
    const auto count = source.u32();
    if (count > source.remaining() / 12) throw std::runtime_error("Invalid level vertex buffers");
    std::vector<LevelVertices> buffers;
    buffers.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        LevelVertices buffer;
        while (true) {
            const auto stream = source.u16();
            const auto offset = source.u16();
            const auto type = source.u8();
            source.u8(); // Method
            const auto usage = source.u8();
            const auto index = source.u8();
            if (stream == 255 && type == 17) break;
            if (stream || type >= sizes.size()) throw std::runtime_error("Unsupported level vertex declaration");
            buffer.stride = std::max(buffer.stride, offset + sizes[type]);
            if (index != 0) continue;
            switch (usage) {
            case 0: buffer.position = {offset, type}; break;
            case 3: buffer.normal = {offset, type}; break;
            case 5: buffer.uv = {offset, type}; break;
            case 6: buffer.tangent = {offset, type}; break;
            case 7: buffer.binormal = {offset, type}; break;
            }
        }
        buffer.count = source.u32();
        if (!buffer.stride || buffer.count > source.remaining() / buffer.stride)
            throw std::runtime_error("Invalid level vertex buffer size");
        buffer.data = source.take(buffer.count * buffer.stride);
        buffers.push_back(buffer);
    }
    return buffers;
}

std::vector<Bytes> levelIndexBuffers(Reader source) {
    const auto count = source.u32();
    if (count > source.remaining() / 4) throw std::runtime_error("Invalid level index buffers");
    std::vector<Bytes> buffers;
    buffers.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        const auto indices = source.u32();
        if (indices > source.remaining() / 2) throw std::runtime_error("Invalid level index buffer size");
        buffers.push_back(source.take(size_t(indices) * 2));
    }
    return buffers;
}

LevelWindow levelWindow(Reader& source) {
    source.take(16); // Reserved
    const auto count = source.u32();
    if (count > source.remaining() / 8) throw std::runtime_error("Invalid level slide windows");
    if (!count) return {};
    // The first window holds the highest detail range.
    const auto offset = source.u32();
    const auto triangles = source.u16();
    const auto vertices = source.u16();
    source.take(size_t(count - 1) * 8);
    return {offset, size_t(triangles) * 3, vertices};
}

Vertex decodeLevelVertex(const LevelVertices& buffer, size_t index, const std::array<float, 16>* transform) {
    const auto bytes = buffer.data.subspan(index * buffer.stride, buffer.stride);
    Vertex vertex = {};
    Reader position(bytes.subspan(buffer.position.offset));
    for (auto& x : vertex.position) x = position.f32();
    vertex.normal[1] = 1;
    if (buffer.normal.type == 4) {
        const auto color = bytes.subspan(buffer.normal.offset, 4);
        for (size_t axis = 0; axis < 3; ++axis)
            vertex.normal[axis] = color[2 - axis] * (2.f / 255.f) - 1.f;
    } else if (buffer.normal.type == 2) {
        Reader normal(bytes.subspan(buffer.normal.offset));
        for (auto& x : vertex.normal) x = normal.f32();
    }
    Reader uv(bytes.subspan(buffer.uv.offset));
    if (buffer.uv.type == 1 || buffer.uv.type == 2 || buffer.uv.type == 3) {
        for (auto& x : vertex.uv) x = uv.f32();
    } else if (buffer.uv.type == 6 || buffer.uv.type == 7) {
        const float scale = transform ? 1.f / 2048.f : 1.f / 1024.f;
        const std::array fractions{buffer.tangent, buffer.binormal};
        for (size_t axis = 0; axis < 2; ++axis) {
            const auto element = fractions[axis];
            const float fraction = !transform && element.type == 4 ? bytes[element.offset + 3] / 255.f : 0.f;
            vertex.uv[axis] = (std::bit_cast<int16_t>(uv.u16()) + fraction) * scale;
        }
    }
    if (transform) {
        const auto& matrix = *transform;
        const auto local = vertex;
        for (size_t axis = 0; axis < 3; ++axis) {
            vertex.position[axis] = matrix[12 + axis];
            vertex.normal[axis] = 0;
            for (size_t source = 0; source < 3; ++source) {
                vertex.position[axis] += matrix[source * 4 + axis] * local.position[source];
                vertex.normal[axis] += matrix[source * 4 + axis] * local.normal[source];
            }
        }
    }
    return vertex;
}

std::vector<Mesh> readLevel(Bytes level, Bytes geometry) {
    Reader shaderChunk(levelChunk(level, 2));
    const auto shaderCount = shaderChunk.u32();
    if (shaderCount > shaderChunk.remaining()) throw std::runtime_error("Invalid level material table");
    std::vector<std::pair<std::string, std::string>> materials;
    materials.reserve(shaderCount);
    for (size_t i = 0; i < shaderCount; ++i) {
        const auto entry = shaderChunk.string();
        const auto split = entry.find('/');
        const auto start = split == std::string::npos ? entry.size() : split + 1;
        const auto comma = entry.find(',', start);
        materials.emplace_back(entry.substr(0, split), entry.substr(start, comma - start));
    }
    const auto vertices = levelVertexBuffers(Reader(levelChunk(geometry, 9)));
    const auto indices = levelIndexBuffers(Reader(levelChunk(geometry, 10)));
    std::vector<LevelWindow> treeWindows;
    Reader windows(levelChunk(geometry, 11));
    if (windows.remaining()) {
        const auto count = windows.u32();
        if (count > windows.remaining() / 20) throw std::runtime_error("Invalid level tree window count");
        treeWindows.reserve(count);
        for (size_t i = 0; i < count; ++i) treeWindows.push_back(levelWindow(windows));
    }

    std::vector<Mesh> meshes;
    std::vector<size_t> batches(materials.size(), SIZE_MAX);
    Reader visuals(levelChunk(level, 3));
    while (visuals.remaining()) {
        const auto visual = nextChunk(visuals).reader().bytes();
        Reader header(levelChunk(visual, 1));
        if (header.u8() != 4) throw std::runtime_error("Unsupported level visual version");
        const auto type = header.u8();
        const auto material = header.u16();
        const bool tree = type == 7 || type == 11;
        if (type != 0 && type != 2 && !tree) continue; // Hierarchies and alternate LOD billboards.
        if (material >= materials.size()) throw std::runtime_error("Invalid level visual material");
        const auto& [shader, texture] = materials[material];
        if (shader.starts_with("effects\\") || shader.starts_with("water")) continue;

        Reader container(levelChunk(visual, 21));
        const auto vb = container.u32(), vertexBase = container.u32();
        size_t vertexCount = container.u32();
        const auto ib = container.u32();
        size_t indexBase = container.u32(), indexCount = container.u32();
        LevelWindow window{};
        if (type == 2) {
            Reader local(levelChunk(visual, 6));
            window = levelWindow(local);
        } else if (type == 11) {
            Reader global(levelChunk(visual, 20));
            const auto id = global.u32();
            if (id >= treeWindows.size()) throw std::runtime_error("Invalid level tree slide window");
            window = treeWindows[id];
        }
        if (window.indices) {
            if (window.offset + window.indices > indexCount || window.vertices > vertexCount)
                throw std::runtime_error("Level slide window exceeds its visual range");
            indexBase += window.offset;
            indexCount = window.indices;
            vertexCount = window.vertices;
        }
        if (!vertexCount || !indexCount) continue;
        if (vb >= vertices.size() || ib >= indices.size() || vertexCount > maxBatchVertices ||
            size_t(vertexBase) + vertexCount > vertices[vb].count ||
            indexBase + indexCount > indices[ib].size() / 2 || indexCount % 3)
            throw std::runtime_error("Invalid level geometry range");
        if (vertices[vb].position.type != 2 && vertices[vb].position.type != 3)
            throw std::runtime_error("Unsupported level vertex position");

        std::array<float, 16> matrix{};
        if (tree) {
            Reader placement(levelChunk(visual, 12));
            for (auto& value : matrix) value = placement.f32();
        }
        auto& batch = batches[material];
        if (batch == SIZE_MAX || meshes[batch].vertices.size() + vertexCount > maxBatchVertices) {
            batch = meshes.size();
            meshes.emplace_back();
            meshes.back().texture = texture;
            meshes.back().shader = shader;
        }
        auto& mesh = meshes[batch];
        const auto base = mesh.vertices.size();
        for (size_t i = 0; i < vertexCount; ++i)
            mesh.vertices.push_back(decodeLevelVertex(vertices[vb], vertexBase + i, tree ? &matrix : nullptr));
        Reader elements(indices[ib].subspan(indexBase * 2, indexCount * 2));
        for (size_t i = 0; i < indexCount; ++i) {
            const auto index = elements.u16();
            if (index >= vertexCount) throw std::runtime_error("Level index exceeds its visual vertex range");
            mesh.indices.push_back(static_cast<uint16_t>(base + index));
        }
    }
    if (meshes.empty()) throw std::runtime_error("This map has no static geometry to display");
    return meshes;
}
