#pragma once

namespace xray::render::RENDER_NAMESPACE
{
u32 GetFVFVertexSize(u32 FVF);
u32 GetDeclVertexSize(const VertexElement* decl, u32 Stream);
u32 GetDeclLength(const VertexElement* decl);

inline bool dcl_equal(const VertexElement* a, const VertexElement* b)
{
    // check sizes
    const auto a_size = GetDeclLength(a);
    const auto b_size = GetDeclLength(b);
    if (a_size != b_size)
        return false;
    return 0 == memcmp(a, b, a_size * sizeof(VertexElement));
}

struct SDeclaration;

void ConvertVertexDeclaration(const VertexElement* dxdecl, SDeclaration* decl);
void ConvertVertexDeclaration(const xr_vector<VertexElement>& declIn, xr_vector<InputElementDesc>& declOut);

#ifdef USE_OGL
void SetGLVertexPointer(SDeclaration* decl, u32 baseOffset = 0);
#   ifdef XR_PLATFORM_WEB
extern "C" {
bool InitializeNativeWebGPU();
GLuint CreateNativeWebGPUObject(u32 kind);
void DeleteNativeWebGPUObjects(u32 kind, u32 count, const GLuint* objects);
void SetNativeWebGPUSampler(GLuint sampler, GLenum parameter, float value);
int GetNativeWebGPUSampler(GLuint sampler, GLenum parameter);
GLuint CreateNativeWebGPUShader(GLenum type, const char* const* source, size_t count);
GLuint LinkNativeWebGPUProgram(GLuint vertex, GLuint fragment);
u32 NativeWebGPUVertexInputs(GLuint program);
int NativeWebGPUUniformCount(GLuint program);
void NativeWebGPUUniformInfo(GLuint program, u32 index, char* name, u32 capacity, int* size, GLenum* type);
int NativeWebGPUUniformLocation(GLuint program, const char* name);
u32 NativeWebGPUTextureLimit();
void BindNativeWebGPUFramebuffer(GLuint framebuffer);
u32 NativeWebGPUBufferSize(GLuint buffer);
void NativeWebGPUClearRects(GLuint texture, bool depthOnly, float r, float g, float b, float a, float depth, size_t count, const Irect* rects);
}
// Fixed six-word records. Enum values are shared with consumeStateBatch in backend.js.
enum class WebGPUState : u32
{
    StencilEnable, StencilFunc, StencilMask, StencilOps, DepthEnable, DepthFunc,
    DepthWrite, BlendEnable, BlendFactors, BlendOps, ColorMask, CullMode, Scissor, Viewport, DepthRange, Framebuffer, Attachment, DrawBuffers, AlphaToCoverage
};
void QueueWebGPUState(WebGPUState kind, u32 a = 0, u32 b = 0, u32 c = 0, u32 d = 0, u32 e = 0);

void QueueWebGPUUniform(GLuint program, GLuint location, u32 kind, const void* data, u32 words);
enum class WebGPUBinding : u32 { Texture, Sampler, ClearStage };
void QueueWebGPUBinding(WebGPUBinding kind, u32 stage, u32 targetOrObject, u32 objectOrMSAA = 0);
void QueueWebGPUViewport(int x, int y, int width, int height, float minDepth, float maxDepth);
void QueueWebGPUDrawBuffers(u32 count, const GLenum* buffers);
void ClearWebGPUTarget(GLuint texture, u32 mask, const Fcolor* color, float depth, u32 stencil);
void PresentWebGPU(GLuint framebuffer, u32 width, u32 height);
// Resource operations use explicit handles; uploads never depend on bound GLES state.
void CreateWebGPUTexture(GLuint* texture, GLenum target, u32 levels, GLenum format, u32 width, u32 height, u32 depth = 1, u32 samples = 1);
void UploadWebGPUTexture(GLuint texture, GLenum target, u32 level, u32 width, u32 height, u32 depth, GLenum format, GLenum type, bool compressed, const void* data, u32 size);
void DeleteWebGPUTextures(u32 count, const GLuint* textures);
void CreateWebGPUBuffer(GLuint* buffer, const void* data, u32 size);
void UploadWebGPUBuffer(GLuint buffer, const void* data, u32 size, u32 offset = 0, bool replace = true);
void UpdateWebGPUDetailRecords(GLuint buffer, const u32* descriptors, u32 slotCount, const void* visible, u32 visibleCount);
void GatherWebGPUDetailRanges(GLuint buffer, const u32* ranges, u32 rangeCount, u32 instanceCount, bool changed, bool partial);
void GatherWebGPUDetailSet(GLuint buffer, const u32* indices, u32 instanceCount, bool changed);
void DeleteWebGPUBuffer(GLuint buffer);
int WebGPUQuery(u32 operation, GLuint query = 0);
void SubmitWebGPUWork();
void CopyWebGPUTexture(GLuint source, GLuint destination, u32 width, u32 height);
// Ordered shared-memory draw records; resource mutations drain pending draws.
bool WebGPUDetailProfilingEnabled();
void SubmitWebGPUDetailDraw(SDeclaration* decl, GLuint vb, GLuint ib, u32 stride,
    GLuint program, GLuint instances, u32 instanceCount, u32 indexCount, u32 first, u32 baseVertex);
void SubmitWebGPUDraw(SDeclaration* decl, GLuint vb, GLuint ib, u32 stride,
    GLuint program, GLenum topology, bool indexed, u32 count, u32 first, u32 baseVertex, float tessellationLOD);
#   endif
#endif

namespace BufferUtils
{
HRESULT CreateConstantBuffer(ConstantBufferHandle* ppBuffer, u32 DataSize);
};

/**
 * Staging buffer abstraction provides a convenient way to upload vertex or index data into GPU memory.
 * It uses intermediate heap storage to handle host data which can be discarded or preserved for future
 * use in accordance to allocation policy.
 *
 * Two types of allocation available:
 * 1. Push once
 *    Such buffers can be mapped only for write and no data read back is available. Use this mode for cases
 *    when you have static geometry which you are going to upload only once and forget about it. To
 *    improve memory use the intermediate buffer will be discarded as soon as `Unmap()` called.
 * 2. Persistent
 *    In this case unmap operation doesn't discard heap storage content which can be accessed in order
 *    to read the data back. Mapping with read flag can be done multiple times but you won't be able to
 *    modify anything. The intermediate storage can be discarded explicitly to reclaim host memory.
 */

class VertexStagingBuffer
{
public:
    ~VertexStagingBuffer();

    void Create(size_t size, bool allowReadBack = false);
    bool IsValid() const;
    void* Map(size_t offset = 0, size_t size = 0, bool read = false);
    void Unmap(bool doFlush = false);
    VertexBufferHandle GetBufferHandle() const;
    void DiscardHostBuffer();

    void AddRef()
    {
        ++m_RefCounter;
    }

    u32 Release()
    {
        VERIFY2(m_RefCounter, "Attempt to release unused object");
        --m_RefCounter;
        if (m_RefCounter == 0)
            Destroy();
        return m_RefCounter;
    }

    operator VertexBufferHandle() const
    {
        return m_DeviceBuffer;
    }

    bool operator==(VertexBufferHandle other) const
    {
        return other == m_DeviceBuffer;
    }
    bool operator==(const VertexStagingBuffer& other) const
    {
        return other.m_DeviceBuffer == m_DeviceBuffer;
    }

    size_t GetSystemMemoryUsage() const;
    size_t GetVideoMemoryUsage() const;

private:
    void Destroy();

    VertexBufferHandle m_DeviceBuffer{};
    HostBufferHandle m_HostBuffer{};
    size_t m_Size{};
    u32 m_RefCounter{};
    bool m_AllowReadBack{}; // specifies whether host will want to have the data back (e.g. skinning code)
};

class IndexStagingBuffer
{
public:
    ~IndexStagingBuffer();

    void Create(size_t size, bool allowReadBack = false, bool managed = true);
    bool IsValid() const;
    void* Map(size_t offset = 0, size_t size = 0, bool read = false);
    void Unmap(bool doFlush = false);
    IndexBufferHandle GetBufferHandle() const;
    void DiscardHostBuffer();

    void AddRef()
    {
        ++m_RefCounter;
    }

    u32 Release()
    {
        VERIFY2(m_RefCounter, "Attempt to release unused object");
        --m_RefCounter;
        if (m_RefCounter == 0)
            Destroy();
        return m_RefCounter;
    }

    operator IndexBufferHandle() const
    {
        return m_DeviceBuffer;
    }

    bool operator==(IndexBufferHandle other) const
    {
        return other == m_DeviceBuffer;
    }
    bool operator==(const IndexStagingBuffer& other) const
    {
        return other.m_DeviceBuffer == m_DeviceBuffer;
    }

    size_t GetSystemMemoryUsage() const;
    size_t GetVideoMemoryUsage() const;

private:
    void Destroy();

    IndexBufferHandle m_DeviceBuffer{};
    HostBufferHandle m_HostBuffer{};
    size_t m_Size{};
    u32 m_RefCounter{};
    bool m_AllowReadBack{}; // specifies whether host will want to have the data back (e.g. skinning code)
};

/**
 * Stream buffer is another abstraction for mutable GPU data. It uses mapping to provide access
 * to its content. The buffer data is considered to be write only.
 *
 * There are two modes of mapping available:
 * 1. Append (default)
 *    All previous data kept untouched but can't be overwritten.
 * 2. Flush
 *    Previous buffer content is discarded.
 */
class VertexStreamBuffer
{
public:
    ~VertexStreamBuffer();

    void Create(size_t size);

    void* Map(size_t offset, size_t size, bool flush = false);
    void Unmap();
#ifdef XR_PLATFORM_WEB
    void Unmap(size_t writtenSize);
#endif
    bool IsValid() const;

    void AddRef()
    {
        ++m_RefCounter;
    }

    u32 Release()
    {
        VERIFY2(m_RefCounter, "Attempt to release unused object");
        --m_RefCounter;
        if (m_RefCounter == 0)
        {
            Destroy();
        }
        return m_RefCounter;
    }

    operator VertexBufferHandle() const
    {
        return m_DeviceBuffer;
    }

private:
    void Destroy();

    VertexBufferHandle m_DeviceBuffer{};
    u32 m_RefCounter{};
#ifdef XR_PLATFORM_WEB
    xr_vector<u8> m_HostBuffer;
    size_t m_MappedOffset{};
    size_t m_MappedSize{};
#endif
};

class IndexStreamBuffer
{
public:
    ~IndexStreamBuffer();

    void Create(size_t size);

    void* Map(size_t offset, size_t size, bool flush = false);
    void Unmap();
#ifdef XR_PLATFORM_WEB
    void Unmap(size_t writtenSize);
#endif
    bool IsValid() const;

    void AddRef()
    {
        ++m_RefCounter;
    }

    u32 Release()
    {
        VERIFY2(m_RefCounter, "Attempt to release unused object");
        --m_RefCounter;
        if (m_RefCounter == 0)
        {
            Destroy();
        }
        return m_RefCounter;
    }

    operator IndexBufferHandle() const
    {
        return m_DeviceBuffer;
    }

private:
    void Destroy();

    IndexBufferHandle m_DeviceBuffer{};
    u32 m_RefCounter{};
#ifdef XR_PLATFORM_WEB
    xr_vector<u8> m_HostBuffer;
    size_t m_MappedOffset{};
    size_t m_MappedSize{};
#endif
};
} // namespace xray::render::RENDER_NAMESPACE

#ifdef XR_PLATFORM_WEB
extern "C" void ValidateNativeWebGPUFramebuffer();
#endif
