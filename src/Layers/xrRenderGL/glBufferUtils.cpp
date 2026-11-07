#include "stdafx.h"
#include "Layers/xrRender/BufferUtils.h"

#include <FlexibleVertexFormat.h>
#ifdef XR_PLATFORM_WEB
#include <emscripten.h>
#endif

namespace xray::render::RENDER_NAMESPACE
{
#ifdef XR_PLATFORM_WEB
EM_JS(void, ValidateNativeWebGPUFramebuffer, (), { globalThis.__xrayWebGPU.validateNativeFramebuffer(); });
EM_JS(unsigned, NativeWebGPUBufferSize, (unsigned buffer), {
    return globalThis.__xrayWebGPU.info(globalThis.__xrayWebGPUHandles.buffers[buffer])?.size || 0;
});
EM_JS(void, NativeWebGPUClearRects, (unsigned texture, bool depthOnly, float r, float g, float b, float a, float depth, size_t count, const Irect* rects), {
    const start = Number(rects) / 4;
    const rectangles = [];
    for (let n = 0; n < Number(count); n++) rectangles.push(Array.from(HEAP32.subarray(start+n*4, start+n*4+4)));
    globalThis.__xrayWebGPU.clearNativeRects(globalThis.__xrayWebGPUHandles.textures[texture], depthOnly, [r,g,b,a], depth, rectangles);
});

EM_JS(bool, InitializeNativeWebGPU, (), {
    globalThis.__initializeNativeWebGPU(Module.canvas);
    return true;
});
EM_JS(unsigned, CreateNativeWebGPUObject, (unsigned kind), {
    return globalThis.__xrayWebGPU.createNativeObject(kind);
});
EM_JS(void, DeleteNativeWebGPUObjects, (unsigned kind, unsigned count, const unsigned* objects), {
    const start = Number(objects) / 4;
    for (let n = 0; n < count; n++) globalThis.__xrayWebGPU.deleteNativeObject(kind, HEAPU32[start+n]);
});
EM_JS(void, SetNativeWebGPUSampler, (unsigned sampler, unsigned parameter, float value), {
    globalThis.__xrayWebGPU.setNativeSampler(sampler, parameter, value);
});
EM_JS(int, GetNativeWebGPUSampler, (unsigned sampler, unsigned parameter), {
    return globalThis.__xrayWebGPU.info(globalThis.__xrayWebGPUHandles.samplers[sampler]).params?.get(parameter) || 0;
});
EM_JS(unsigned, CreateNativeWebGPUShader, (unsigned type, const char* const* source, size_t count), {
    let text = "";
    for (let n = 0; n < Number(count); n++) text += UTF8ToString(Number(HEAPU64[Number(source)/8+n]));
    return globalThis.__xrayWebGPU.createNativeShader(type, text);
});
EM_JS(unsigned, LinkNativeWebGPUProgram, (unsigned vertex, unsigned fragment), {
    return globalThis.__xrayWebGPU.linkNativeProgram(vertex, fragment);
});
EM_JS(int, NativeWebGPUUniformCount, (unsigned program), {
    return globalThis.__xrayWebGPUHandles.programs[program].meta.activeUniforms.length;
});
EM_JS(void, NativeWebGPUUniformInfo, (unsigned program, unsigned index, char* name, unsigned capacity, int* size, unsigned* type), {
    const u = globalThis.__xrayWebGPUHandles.programs[program].meta.activeUniforms[index];
    if (lengthBytesUTF8(u.name) >= capacity) throw Error("Native uniform name too long");
    stringToUTF8(u.name, Number(name), capacity);
    HEAP32[Number(size)/4] = u.size;
    HEAPU32[Number(type)/4] = u.type;
});
EM_JS(int, NativeWebGPUUniformLocation, (unsigned program, const char* name), {
    return globalThis.__xrayWebGPU.nativeUniformLocation(program, UTF8ToString(Number(name)));
});
EM_JS(unsigned, NativeWebGPUTextureLimit, (), { return globalThis.__xrayWebGPU.device.limits.maxTextureDimension2D; });
EM_JS(void, BindNativeWebGPUFramebuffer, (unsigned framebuffer), {
    const r = globalThis.__xrayWebGPU;
    r.flushNativeStates?.();
    r.fbo = r.readFbo = globalThis.__xrayWebGPUHandles.framebuffers[framebuffer];
});

enum
{
    LOCKFLAGS_FLUSH  = GL_MAP_WRITE_BIT | GL_MAP_INVALIDATE_BUFFER_BIT,
    LOCKFLAGS_APPEND = GL_MAP_WRITE_BIT | GL_MAP_INVALIDATE_RANGE_BIT,
};
#else
enum
{
    LOCKFLAGS_FLUSH  = GL_MAP_WRITE_BIT | GL_MAP_UNSYNCHRONIZED_BIT | GL_MAP_INVALIDATE_BUFFER_BIT,
    LOCKFLAGS_APPEND = GL_MAP_WRITE_BIT | GL_MAP_UNSYNCHRONIZED_BIT, // TODO: Implement buffer object appending using glBufferSubData
};
#endif

u32 GetFVFVertexSize(u32 FVF)
{
    return static_cast<u32>(::FVF::ComputeVertexSize(FVF));
}

u32 GetDeclVertexSize(const VertexElement* decl, u32 Stream)
{
    return static_cast<u32>(::FVF::ComputeVertexSize(decl, Stream));
}

u32 GetDeclLength(const VertexElement* decl)
{
    return static_cast<u32>(::FVF::GetDeclLength(decl));
}

static HRESULT CreateBuffer(GLuint* pBuffer, const void* pData, u32 dataSize, bool bDynamic, bool bIndexBuffer)
{
    const GLenum usage = bDynamic ? GL_DYNAMIC_DRAW : GL_STATIC_DRAW;
    const GLenum target = bIndexBuffer ? GL_ELEMENT_ARRAY_BUFFER : GL_ARRAY_BUFFER;

#ifdef XR_PLATFORM_WEB
    CreateWebGPUBuffer(pBuffer, pData, dataSize); return S_OK;
#endif
    glGenBuffers(1, pBuffer);
#ifdef XR_PLATFORM_WEB
    if (bIndexBuffer)
        g_boundDeclaration = nullptr;
#endif
    glBindBuffer(target, *pBuffer);
    CHK_GL(glBufferData(target, dataSize, pData, usage));
    return S_OK;
}

static inline HRESULT CreateVertexBuffer(VertexBufferHandle* pBuffer, const void* pData, u32 dataSize, bool bDynamic)
{
    return CreateBuffer(pBuffer, pData, dataSize, bDynamic, false);
}

static inline HRESULT CreateIndexBuffer(IndexBufferHandle* pBuffer, const void* pData, u32 dataSize, bool bDynamic)
{
    return CreateBuffer(static_cast<GLuint*>(pBuffer), pData, dataSize, bDynamic, true);
}

const GLsizei VertexSizeList[] =
{
    1, // D3DDECLTYPE_FLOAT1
    2, // D3DDECLTYPE_FLOAT2
    3, // D3DDECLTYPE_FLOAT3
    4, // D3DDECLTYPE_FLOAT4
    4, // D3DDECLTYPE_D3DCOLOR
    4, // D3DDECLTYPE_UBYTE4
    2, // D3DDECLTYPE_SHORT2
    4, // D3DDECLTYPE_SHORT4
    4, // D3DDECLTYPE_UBYTE4N
    2, // D3DDECLTYPE_SHORT2N
    4, // D3DDECLTYPE_SHORT4N
    2, // D3DDECLTYPE_USHORT2N
    4, // D3DDECLTYPE_USHORT4N
    1, // D3DDECLTYPE_UDEC3
    1, // D3DDECLTYPE_DEC3N
    2, // D3DDECLTYPE_FLOAT16_2
    4 // D3DDECLTYPE_FLOAT16_4
};

const GLenum VertexTypeList[] =
{
    GL_FLOAT, // D3DDECLTYPE_FLOAT1
    GL_FLOAT, // D3DDECLTYPE_FLOAT2
    GL_FLOAT, // D3DDECLTYPE_FLOAT3
    GL_FLOAT, // D3DDECLTYPE_FLOAT4
    GL_UNSIGNED_BYTE, // D3DDECLTYPE_D3DCOLOR
    GL_UNSIGNED_BYTE, // D3DDECLTYPE_UBYTE4
    GL_SHORT, // D3DDECLTYPE_SHORT2
    GL_SHORT, // D3DDECLTYPE_SHORT4
    GL_UNSIGNED_BYTE, // D3DDECLTYPE_UBYTE4N
    GL_SHORT, // D3DDECLTYPE_SHORT2N
    GL_SHORT, // D3DDECLTYPE_SHORT4N
    GL_UNSIGNED_SHORT, // D3DDECLTYPE_USHORT2N
    GL_UNSIGNED_SHORT, // D3DDECLTYPE_USHORT4N
    GL_INT_2_10_10_10_REV, // D3DDECLTYPE_UDEC3
    GL_INT_2_10_10_10_REV, // D3DDECLTYPE_DEC3N
    GL_HALF_FLOAT, // D3DDECLTYPE_FLOAT16_2
    GL_HALF_FLOAT // D3DDECLTYPE_FLOAT16_4
};

const GLboolean VertexNormalizedList[] =
{
    GL_FALSE, // D3DDECLTYPE_FLOAT1
    GL_FALSE, // D3DDECLTYPE_FLOAT2
    GL_FALSE, // D3DDECLTYPE_FLOAT3
    GL_FALSE, // D3DDECLTYPE_FLOAT4
    GL_TRUE, // D3DDECLTYPE_D3DCOLOR
    GL_FALSE, // D3DDECLTYPE_UBYTE4
    GL_FALSE, // D3DDECLTYPE_SHORT2
    GL_FALSE, // D3DDECLTYPE_SHORT4
    GL_TRUE, // D3DDECLTYPE_UBYTE4N
    GL_TRUE, // D3DDECLTYPE_SHORT2N
    GL_TRUE, // D3DDECLTYPE_SHORT4N
    GL_TRUE, // D3DDECLTYPE_USHORT2N
    GL_TRUE, // D3DDECLTYPE_USHORT4N
    GL_FALSE, // D3DDECLTYPE_UDEC3
    GL_TRUE, // D3DDECLTYPE_DEC3N
    GL_FALSE, // D3DDECLTYPE_FLOAT16_2
    GL_FALSE // D3DDECLTYPE_FLOAT16_4
};

const GLuint VertexUsageList[] =
{
    3, // D3DDECLUSAGE_POSITION
    ~0u, // D3DDECLUSAGE_BLENDWEIGHT
    ~0u, // D3DDECLUSAGE_BLENDINDICES
    5, // D3DDECLUSAGE_NORMAL
    ~0u, // D3DDECLUSAGE_PSIZE
    8, // D3DDECLUSAGE_TEXCOORD
    4, // D3DDECLUSAGE_TANGENT
    6, // D3DDECLUSAGE_BINORMAL
    ~0u, // D3DDECLUSAGE_TESSFACTOR
    3, // D3DDECLUSAGE_POSITIONT
    0, // D3DDECLUSAGE_COLOR
    7, // D3DDECLUSAGE_FOG
    ~0u, // D3DDECLUSAGE_DEPTH
    ~0u, // D3DDECLUSAGE_SAMPLE
};

template <typename F>
void IterVertexDeclaration(const VertexElement* dxdecl, F&& callback)
{
    // XXX: tamlin: use 'stride', or drop it.
    // GLsizei stride = GetDeclVertexSize(dxdecl, 0);
    for (int i = 0; i < MAXD3DDECLLENGTH; ++i)
    {
        const D3DVERTEXELEMENT9& desc = dxdecl[i];

        if (desc.Stream == 0xFF)
            break;

        GLuint location = VertexUsageList[desc.Usage];
        GLint size = VertexSizeList[desc.Type];
        GLenum type = VertexTypeList[desc.Type];
        GLboolean normalized = VertexNormalizedList[desc.Type];

        if (location == GLuint(~0u))
            continue; // Unsupported

        location += desc.UsageIndex;
        callback(location, size, type, normalized, desc.Offset, desc.Stream);
    }
}

#ifndef XR_PLATFORM_WEB
void SetVertexDeclaration(const VertexElement* dxdecl, u32 baseOffset)
{
    auto stride = GetDeclVertexSize(dxdecl, 0);
    IterVertexDeclaration(dxdecl,
    [&](GLuint location, GLint size, GLenum type, GLboolean normalized, intptr_t offset, GLuint /*stream*/)
    {
        CHK_GL(glVertexAttribPointer(
            location, size, type, normalized, stride, (void*)(offset + baseOffset)));
    });
}
#endif

#ifdef XR_PLATFORM_WEB
// Header: program, location, kind (0 vector, 1 Fmatrix, 2 integer, 3 sampler), word count.
// Payload is copied immediately, so temporary matrices and stack vectors are safe.
static u32 drawBatch[13 * 1024];
static u32 drawBatchWords = 0;
static u32 stateBatch[6144];
static u32 stateBatchWords = 0;
void QueueWebGPUState(WebGPUState kind, u32 a, u32 b, u32 c, u32 d, u32 e)
{
    if (stateBatchWords + 6 > std::size(stateBatch))
        EM_ASM({ globalThis.__xrayWebGPU.flushNativeStates(); });
    u32* dst = stateBatch + stateBatchWords;
    dst[0] = static_cast<u32>(kind); dst[1] = a; dst[2] = b;
    dst[3] = c; dst[4] = d; dst[5] = e;
    stateBatchWords += 6;
    return;
}

void QueueWebGPUViewport(int x, int y, int width, int height, float minDepth, float maxDepth)
{
    u32 minBits, maxBits;
    memcpy(&minBits, &minDepth, sizeof(u32));
    memcpy(&maxBits, &maxDepth, sizeof(u32));
    QueueWebGPUState(WebGPUState::Viewport, x, y, width, height);
    QueueWebGPUState(WebGPUState::DepthRange, minBits, maxBits);
    return;
}

void QueueWebGPUDrawBuffers(u32 count, const GLenum* buffers)
{
    R_ASSERT2(count <= 4, "Native WebGPU supports at most four draw buffers");
    return QueueWebGPUState(WebGPUState::DrawBuffers, count,
        count > 0 ? buffers[0] : 0, count > 1 ? buffers[1] : 0,
        count > 2 ? buffers[2] : 0, count > 3 ? buffers[3] : 0);
}

EM_JS(void, xrClearWebGPUTarget, (unsigned texture, unsigned mask, float r, float g, float b, float a, float depth, unsigned stencil), {
    globalThis.__xrayWebGPU.clearNativeTarget(globalThis.__xrayWebGPUHandles.textures[texture], mask, r, g, b, a, depth, stencil);
});
void ClearWebGPUTarget(GLuint texture, u32 mask, const Fcolor* color, float depth, u32 stencil)
{
    xrClearWebGPUTarget(texture, mask, color ? color->r : 0, color ? color->g : 0,
        color ? color->b : 0, color ? color->a : 0, depth, stencil);
    return;
}
EM_JS(void, xrPresentWebGPU, (unsigned framebuffer, unsigned width, unsigned height), {
    globalThis.__xrayWebGPU.presentNative(globalThis.__xrayWebGPUHandles.framebuffers[framebuffer], width, height);
});
void PresentWebGPU(GLuint framebuffer, u32 width, u32 height)
{
    xrPresentWebGPU(framebuffer, width, height);
    return;
}

EM_JS(int, xrCreateWebGPUTexture, (unsigned target, unsigned levels, unsigned format, unsigned width, unsigned height, unsigned depth), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    const id = globalThis.__xrayWebGPUHandles.getNewId(globalThis.__xrayWebGPUHandles.textures);
    const token = {kind: "Texture", name: id};
    globalThis.__xrayWebGPUHandles.textures[id] = token;
    r.allocateNativeTexture(token, target, levels, format, width, height, depth);
    return id;
});
void CreateWebGPUTexture(GLuint* texture, GLenum target, u32 levels, GLenum format, u32 width, u32 height, u32 depth)
{
    *texture = xrCreateWebGPUTexture(target, levels, format, width, height, depth);
    R_ASSERT(*texture != 0);
}
EM_JS(int, xrUploadWebGPUTexture, (unsigned texture, unsigned target, unsigned level, unsigned width, unsigned height, unsigned depth, unsigned format, unsigned type, bool compressed, const void* data, unsigned size), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    r.uploadNativeTexture(globalThis.__xrayWebGPUHandles.textures[texture], target, level, width, height, depth, format, type, compressed, HEAPU8.subarray(Number(data), Number(data) + size));
    return 1;
});
void UploadWebGPUTexture(GLuint texture, GLenum target, u32 level, u32 width, u32 height, u32 depth, GLenum format, GLenum type, bool compressed, const void* data, u32 size)
{
    xrUploadWebGPUTexture(texture, target, level, width, height, depth, format, type, compressed, data, size);
}
EM_JS(int, xrDeleteWebGPUTextures, (unsigned count, const unsigned* textures), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    const start = Number(textures) / 4;
    for (let n = 0; n < count; n++) {
        const id = HEAPU32[start + n];
        r.deleteNativeTexture(globalThis.__xrayWebGPUHandles.textures[id]);
        globalThis.__xrayWebGPUHandles.textures[id] = null;
    }
    return 1;
});
void DeleteWebGPUTextures(u32 count, const GLuint* textures) { xrDeleteWebGPUTextures(count, textures); }

EM_JS(int, xrCreateWebGPUBuffer, (const void* data, unsigned size), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    const id = globalThis.__xrayWebGPUHandles.getNewId(globalThis.__xrayWebGPUHandles.buffers);
    const token = {kind: "Buffer", name: id};
    globalThis.__xrayWebGPUHandles.buffers[id] = token;
    r.uploadNativeBuffer(token, data ? HEAPU8.subarray(Number(data), Number(data) + size) : size, 0, true);
    return id;
});
void CreateWebGPUBuffer(GLuint* buffer, const void* data, u32 size)
{
    *buffer = xrCreateWebGPUBuffer(data, size);
    R_ASSERT(*buffer != 0);
}
EM_JS(int, xrUploadWebGPUBuffer, (unsigned buffer, const void* data, unsigned size, unsigned offset, bool replace), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    r.uploadNativeBuffer(globalThis.__xrayWebGPUHandles.buffers[buffer], data ? HEAPU8.subarray(Number(data), Number(data) + size) : size, offset, replace);
    return 1;
});
void UploadWebGPUBuffer(GLuint buffer, const void* data, u32 size, u32 offset, bool replace)
{
    xrUploadWebGPUBuffer(buffer, data, size, offset, replace);
}
EM_JS(int, xrDeleteWebGPUBuffer, (unsigned buffer), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    r.deleteNativeBuffer(globalThis.__xrayWebGPUHandles.buffers[buffer]);
    globalThis.__xrayWebGPUHandles.buffers[buffer] = null;
    return 1;
});
void DeleteWebGPUBuffer(GLuint buffer) { xrDeleteWebGPUBuffer(buffer); }
EM_JS(int, xrWebGPUQuery, (unsigned operation, unsigned query), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    if (operation === 0) {
        const id = globalThis.__xrayWebGPUHandles.getNewId(globalThis.__xrayWebGPUHandles.queries);
        globalThis.__xrayWebGPUHandles.queries[id] = {kind: "Query", name: id};
        return id;
    }
    const token = globalThis.__xrayWebGPUHandles.queries[query];
    if (operation === 1) return r.nativeQueryResult(token);
    if (operation === 2) r.beginNativeQuery(token);
    if (operation === 3) r.endNativeQuery();
    if (operation === 4) {
        r.flushNativeDraws?.();
        if (token) token.deleted = true;
        globalThis.__xrayWebGPUHandles.queries[query] = null;
    }
    return 0;
});
int WebGPUQuery(u32 operation, GLuint query) { return xrWebGPUQuery(operation, query); }
EM_JS(int, xrSubmitWebGPUWork, (), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    r.flushNativeDraws?.();
    r.flush();
    return 1;
});
void SubmitWebGPUWork() { xrSubmitWebGPUWork(); }
EM_JS(int, xrCopyWebGPUTexture, (unsigned source, unsigned destination, unsigned width, unsigned height), {
    const r = globalThis.__xrayWebGPU;
    if (!r) throw Error("Native WebGPU is not initialized");
    r.copyNativeTexture(globalThis.__xrayWebGPUHandles.textures[source], globalThis.__xrayWebGPUHandles.textures[destination], width, height);
    return 1;
});
void CopyWebGPUTexture(GLuint source, GLuint destination, u32 width, u32 height)
{
    xrCopyWebGPUTexture(source, destination, width, height);
}

static u32 bindingBatch[4096];
static u32 bindingBatchWords = 0;
void QueueWebGPUBinding(WebGPUBinding kind, u32 stage, u32 targetOrObject, u32 objectOrMSAA)
{
    if (bindingBatchWords + 4 > std::size(bindingBatch))
        EM_ASM({ globalThis.__xrayWebGPU.flushNativeBindings(); });
    u32* dst = bindingBatch + bindingBatchWords;
    dst[0] = static_cast<u32>(kind); dst[1] = stage;
    dst[2] = targetOrObject; dst[3] = objectOrMSAA;
    bindingBatchWords += 4;
    return;
}

static u32 uniformBatch[65536];
static u32 uniformBatchWords = 0;
static void FlushWebGPUUniformBatch()
{
    EM_ASM({ globalThis.__xrayWebGPU?.flushNativeUniforms?.(); });
}
void QueueWebGPUUniform(GLuint program, GLuint location, u32 kind, const void* data, u32 words)
{
    if (location == GLuint(-1)) return;
    if (words > std::size(uniformBatch) - 4)
    {
        FlushWebGPUUniformBatch();
        EM_ASM({
            const data = new Uint32Array($4 + 4);
            data.set([$0, $1, $2, $4]);
            data.set(HEAPU32.subarray(Number($3)/4, Number($3)/4+$4), 4);
            globalThis.__xrayWebGPU.consumeUniformBatch(data, new Float32Array(data.buffer), new Int32Array(data.buffer), 0, data.length, globalThis.__xrayWebGPUHandles.programs);
        }, program, location, kind, data, words);
        return;
    }
    if (uniformBatchWords + words + 4 > std::size(uniformBatch)) FlushWebGPUUniformBatch();
    u32* dst = uniformBatch + uniformBatchWords;
    dst[0] = program; dst[1] = location; dst[2] = kind; dst[3] = words;
    memcpy(dst + 4, data, words * sizeof(u32));
    uniformBatchWords += words + 4;
    return;
}
// Declaration registration is cold-path work. Each entry is five uint32s;
// no GL attribute calls or Wasm memory reads are needed during submission.
static void RegisterWebGPUDeclaration(const VertexElement* dxdecl, SDeclaration* decl)
{
    u32 attributes[MAXD3DDECLLENGTH * 5];
    u32 count = 0;
    IterVertexDeclaration(dxdecl,
        [&](GLuint location, GLint size, GLenum type, GLboolean normalized, GLuint offset, GLuint stream)
        {
            VERIFY(stream == 0);
            u32* a = attributes + count++ * 5;
            a[0] = location; a[1] = size; a[2] = type; a[3] = normalized; a[4] = offset;
        });
    EM_ASM({
        const renderer = globalThis.__xrayWebGPU;
        if (!renderer) throw Error("Native WebGPU is not initialized");
        {
            renderer.registerDeclaration(globalThis.__xrayWebGPUHandles.vaos[$0], HEAPU32.subarray(Number($1) / 4, Number($1) / 4 + $2 * 5));
            if (!renderer.flushNativeUniforms) {
                renderer.preparedEnabled = renderer.stateBatchEnabled = renderer.bindingBatchEnabled = renderer.passBatchEnabled = true;
                renderer.configureNativeQueues(() => ({words:HEAPU32, floats:HEAPF32, ints:HEAP32}),
                    [$3,$4,$5,$6,$7,$8,$9,$10], globalThis.__xrayWebGPUHandles);
            }
        }
    }, decl->dcl, attributes, count, uniformBatch, &uniformBatchWords, stateBatch, &stateBatchWords, bindingBatch, &bindingBatchWords, drawBatch, &drawBatchWords);
}

void SubmitWebGPUDraw(SDeclaration* decl, GLuint vb, GLuint ib, u32 stride,
    GLuint program, GLenum topology, bool indexed, u32 count, u32 first, u32 baseVertex)
{
    if (drawBatchWords + 13 > std::size(drawBatch))
        EM_ASM({ globalThis.__xrayWebGPU.flushNativeDraws(); });
    u32* dst = drawBatch + drawBatchWords;
    dst[0] = decl->dcl; dst[1] = vb; dst[2] = ib; dst[3] = stride;
    dst[4] = program; dst[5] = topology; dst[6] = indexed; dst[7] = count;
    dst[8] = first; dst[9] = baseVertex;
    dst[10] = uniformBatchWords; dst[11] = stateBatchWords; dst[12] = bindingBatchWords;
    drawBatchWords += 13;
}

#endif

void ConvertVertexDeclaration(const VertexElement* dxdecl, SDeclaration* decl)
{
    RCache.set_Format(decl);
#ifdef XR_PLATFORM_WEB
    RegisterWebGPUDeclaration(dxdecl, decl);
    return;
#endif
    IterVertexDeclaration(dxdecl,
    [](GLuint location, GLint size, GLenum type, GLboolean normalized, GLuint offset, GLuint stream)
    {
        CHK_GL(glEnableVertexAttribArray(location));
        if (SupportsArbVertexAttribBinding())
        {
            CHK_GL(glVertexAttribFormat(location, size, type, normalized, offset));
            CHK_GL(glVertexAttribBinding(location, stream));
        }
    });
}

#ifndef XR_PLATFORM_WEB
void SetGLVertexPointer(SDeclaration* decl, u32 baseOffset)
{
    SetVertexDeclaration(decl->dcl_code.data(), baseOffset);
}

#endif

//-----------------------------------------------------------------------------
VertexStagingBuffer::~VertexStagingBuffer()
{
    Destroy();
}

void VertexStagingBuffer::Create(size_t size, bool allowReadBack /*= false*/)
{
    m_Size = size;
    m_AllowReadBack = allowReadBack;

    m_HostBuffer = xr_alloc<u8>(size);
    AddRef();
}

bool VertexStagingBuffer::IsValid() const
{
    return !!m_DeviceBuffer;
}

void* VertexStagingBuffer::Map(
    size_t offset /*= 0*/,
    size_t size /*= 0*/,
    bool read /*= false*/)
{
    VERIFY2(m_HostBuffer, "Buffer wasn't created or already discarded");
    VERIFY2(!read || m_AllowReadBack, "Can't read from write only buffer");
    VERIFY2((size + offset) <= m_Size, "Map region is too large");

    return static_cast<u8*>(m_HostBuffer) + offset;
}

void VertexStagingBuffer::Unmap(bool doFlush /*= false*/)
{
    if (!doFlush)
    {
        /* Do nothing*/
        return;
    }

    VERIFY2(!m_DeviceBuffer, "Attempting to upload buffer twice");
    VERIFY(m_HostBuffer && m_Size);

    // Upload data to the device
    CreateVertexBuffer(&m_DeviceBuffer, m_HostBuffer, m_Size, false);

    if (!m_AllowReadBack)
    {
        // Cache buffer isn't required anymore. Free host memory
        DiscardHostBuffer();
    }
}

VertexBufferHandle VertexStagingBuffer::GetBufferHandle() const
{
    return m_DeviceBuffer;
}

void VertexStagingBuffer::Destroy()
{
    DiscardHostBuffer();
    m_Size = 0;

    if (m_DeviceBuffer)
    {
#ifdef XR_PLATFORM_WEB

#endif
#ifdef XR_PLATFORM_WEB
        DeleteWebGPUBuffer(m_DeviceBuffer);
#else
            glDeleteBuffers(1, &m_DeviceBuffer);
#endif
        m_DeviceBuffer = 0;
    }
}

void VertexStagingBuffer::DiscardHostBuffer()
{
    if (m_HostBuffer)
        xr_free(m_HostBuffer);
}

size_t VertexStagingBuffer::GetSystemMemoryUsage() const
{
    return m_HostBuffer ? m_Size : 0;
}

size_t VertexStagingBuffer::GetVideoMemoryUsage() const
{
#ifdef XR_PLATFORM_WEB
    return NativeWebGPUBufferSize(m_DeviceBuffer);
#endif
    if (!m_DeviceBuffer)
        return 0;

    GLint bufferSize;
    glBindBuffer(GL_ARRAY_BUFFER, m_DeviceBuffer);
    CHK_GL(glGetBufferParameteriv(GL_ARRAY_BUFFER, GL_BUFFER_SIZE, &bufferSize));
    return bufferSize;
}

//-----------------------------------------------------------------------------
IndexStagingBuffer::~IndexStagingBuffer()
{
    Destroy();
}

void IndexStagingBuffer::Create(size_t size, bool allowReadBack /*= false*/, bool /*managed = true*/)
{
    m_Size = size;
    m_AllowReadBack = allowReadBack;

    m_HostBuffer = xr_alloc<u8>(size);
    AddRef();
}

bool IndexStagingBuffer::IsValid() const
{
    return !!m_DeviceBuffer;
}

void* IndexStagingBuffer::Map(
    size_t offset /*= 0*/,
    size_t size /*= 0*/,
    bool read /*= false*/)
{
    VERIFY2(m_HostBuffer, "Buffer wasn't created or already discarded");
    VERIFY2(!read || m_AllowReadBack, "Can't read from write only buffer");
    VERIFY2((size + offset) <= m_Size, "Map region is too large");

    return static_cast<u8*>(m_HostBuffer) + offset;
}

void IndexStagingBuffer::Unmap(bool doFlush /*= false*/)
{
    if (!doFlush)
    {
        /* Do nothing*/
        return;
    }

    VERIFY2(!m_DeviceBuffer, "Attempting to upload buffer twice");
    VERIFY(m_HostBuffer && m_Size);

    // Upload data to the device
    CreateIndexBuffer(&m_DeviceBuffer, m_HostBuffer, m_Size, false);

    if (!m_AllowReadBack)
    {
        // Cache buffer isn't required anymore. Free host memory
        DiscardHostBuffer();
    }
}

IndexBufferHandle IndexStagingBuffer::GetBufferHandle() const
{
    return m_DeviceBuffer;
}

void IndexStagingBuffer::Destroy()
{
    DiscardHostBuffer();
    m_Size = 0;

    if (m_DeviceBuffer)
    {
#ifdef XR_PLATFORM_WEB

#endif
#ifdef XR_PLATFORM_WEB
        DeleteWebGPUBuffer(m_DeviceBuffer);
#else
            glDeleteBuffers(1, &m_DeviceBuffer);
#endif
        m_DeviceBuffer = 0;
    }
}

void IndexStagingBuffer::DiscardHostBuffer()
{
    if (m_HostBuffer)
        xr_free(m_HostBuffer);
}

size_t IndexStagingBuffer::GetSystemMemoryUsage() const
{
    return m_HostBuffer ? m_Size : 0;
}

size_t IndexStagingBuffer::GetVideoMemoryUsage() const
{
#ifdef XR_PLATFORM_WEB
    return NativeWebGPUBufferSize(m_DeviceBuffer);
#endif
    if (!m_DeviceBuffer)
        return 0;

    GLint bufferSize;
#ifdef XR_PLATFORM_WEB
    glBindBuffer(GL_COPY_READ_BUFFER, m_DeviceBuffer);
    CHK_GL(glGetBufferParameteriv(GL_COPY_READ_BUFFER, GL_BUFFER_SIZE, &bufferSize));
#else
    glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, m_DeviceBuffer);
    CHK_GL(glGetBufferParameteriv(GL_ELEMENT_ARRAY_BUFFER, GL_BUFFER_SIZE, &bufferSize));
#endif
    return bufferSize;
}

//-----------------------------------------------------------------------------
VertexStreamBuffer::~VertexStreamBuffer()
{
    Destroy();
}

void VertexStreamBuffer::Create(size_t size)
{
    CreateVertexBuffer(&m_DeviceBuffer, nullptr, size, true);
#ifdef XR_PLATFORM_WEB

    m_HostBuffer.resize(size);
#endif
    AddRef();
}

void VertexStreamBuffer::Destroy()
{
    if (m_DeviceBuffer == 0)
        return;

#ifdef XR_PLATFORM_WEB


#endif
#ifdef XR_PLATFORM_WEB
    DeleteWebGPUBuffer(m_DeviceBuffer);
#else
    glDeleteBuffers(1, &m_DeviceBuffer);
#endif
    m_DeviceBuffer = 0;
}

#ifdef XR_PLATFORM_WEB
void* VertexStreamBuffer::Map(size_t offset, size_t size, bool flush /*= false*/)
{
    VERIFY(m_DeviceBuffer);
    VERIFY(offset == 0 && size <= m_HostBuffer.size());
    UNUSED(flush);
    m_MappedOffset = offset;
    m_MappedSize = size;
    return m_HostBuffer.data() + offset;
}

void VertexStreamBuffer::Unmap()
{
    Unmap(m_MappedSize);
}

void VertexStreamBuffer::Unmap(size_t writtenSize)
{
    VERIFY(m_DeviceBuffer && writtenSize <= m_MappedSize);
    if (writtenSize == 0)
        return;
    UploadWebGPUBuffer(m_DeviceBuffer, m_HostBuffer.data() + m_MappedOffset, writtenSize); return;
    glBindBuffer(GL_ARRAY_BUFFER, m_DeviceBuffer);
    CHK_GL(glBufferData(GL_ARRAY_BUFFER, writtenSize, m_HostBuffer.data() + m_MappedOffset, GL_STREAM_DRAW));
}
#else
void* VertexStreamBuffer::Map(size_t offset, size_t size, bool flush /*= false*/)
{
    VERIFY(m_DeviceBuffer);
    glBindBuffer(GL_ARRAY_BUFFER, m_DeviceBuffer);

    void *pData = nullptr;
    const auto flags = flush ? LOCKFLAGS_FLUSH : LOCKFLAGS_APPEND;
    CHK_GL(pData = (void*)glMapBufferRange(
        GL_ARRAY_BUFFER,
        offset,
        size,
        flags));

    return pData;
}

void VertexStreamBuffer::Unmap()
{
    VERIFY(m_DeviceBuffer);
    glBindBuffer(GL_ARRAY_BUFFER, m_DeviceBuffer);
    CHK_GL(glUnmapBuffer(GL_ARRAY_BUFFER));
}
#endif

bool VertexStreamBuffer::IsValid() const
{
    return !!m_DeviceBuffer;
}

//-----------------------------------------------------------------------------
IndexStreamBuffer::~IndexStreamBuffer()
{
    Destroy();
}

void IndexStreamBuffer::Create(size_t size)
{
    CreateIndexBuffer(&m_DeviceBuffer, nullptr, size, true);
#ifdef XR_PLATFORM_WEB
    m_HostBuffer.resize(size);
#endif
    AddRef();
}

void IndexStreamBuffer::Destroy()
{
    if (m_DeviceBuffer == 0)
        return;

#ifdef XR_PLATFORM_WEB

#endif
#ifdef XR_PLATFORM_WEB
    DeleteWebGPUBuffer(m_DeviceBuffer);
#else
    glDeleteBuffers(1, &m_DeviceBuffer);
#endif
    m_DeviceBuffer = 0;
}

#ifdef XR_PLATFORM_WEB
constexpr GLenum INDEX_UPLOAD_TARGET = GL_COPY_WRITE_BUFFER;
#else
constexpr GLenum INDEX_UPLOAD_TARGET = GL_ELEMENT_ARRAY_BUFFER;
#endif

#ifdef XR_PLATFORM_WEB
void* IndexStreamBuffer::Map(size_t offset, size_t size, bool flush /*= false*/)
{
    VERIFY(m_DeviceBuffer);
    VERIFY(offset + size <= m_HostBuffer.size());
    if (flush) UploadWebGPUBuffer(m_DeviceBuffer, nullptr, m_HostBuffer.size());
    m_MappedOffset = offset;
    m_MappedSize = size;
    return m_HostBuffer.data() + offset;
}

void IndexStreamBuffer::Unmap()
{
    Unmap(m_MappedSize);
}

void IndexStreamBuffer::Unmap(size_t writtenSize)
{
    VERIFY(m_DeviceBuffer && writtenSize <= m_MappedSize);
    if (writtenSize == 0)
        return;
    UploadWebGPUBuffer(m_DeviceBuffer, m_HostBuffer.data() + m_MappedOffset, writtenSize, m_MappedOffset, false); return;
    glBindBuffer(INDEX_UPLOAD_TARGET, m_DeviceBuffer);
    CHK_GL(glBufferSubData(INDEX_UPLOAD_TARGET, m_MappedOffset, writtenSize, m_HostBuffer.data() + m_MappedOffset));
}
#else
void* IndexStreamBuffer::Map(size_t offset, size_t size, bool flush /*= false*/)
{
    VERIFY(m_DeviceBuffer);
    glBindBuffer(INDEX_UPLOAD_TARGET, m_DeviceBuffer);

    void *pData = nullptr;
    const auto flags = flush ? LOCKFLAGS_FLUSH : LOCKFLAGS_APPEND;
    CHK_GL(pData = (void*)glMapBufferRange(
        INDEX_UPLOAD_TARGET,
        offset,
        size,
        flags));

    return pData;
}

void IndexStreamBuffer::Unmap()
{
    VERIFY(m_DeviceBuffer);
    glBindBuffer(INDEX_UPLOAD_TARGET, m_DeviceBuffer);
    CHK_GL(glUnmapBuffer(INDEX_UPLOAD_TARGET));
}
#endif

bool IndexStreamBuffer::IsValid() const
{
    return !!m_DeviceBuffer;
}
} // namespace xray::render::RENDER_NAMESPACE
