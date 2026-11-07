#pragma once
#ifdef XR_PLATFORM_WEB
#include "BufferUtils.h"
#endif

namespace xray::render::RENDER_NAMESPACE
{
//	Interface
#if defined(USE_DX11)
IC HRESULT CreateQuery(ID3DQuery** ppQuery);
IC HRESULT GetData(ID3DQuery* pQuery, void* pData, u32 DataSize);
IC HRESULT BeginQuery(ID3DQuery* pQuery);
IC HRESULT EndQuery(ID3DQuery* pQuery);
IC HRESULT ReleaseQuery(ID3DQuery *pQuery);
#elif defined(USE_OGL)
IC HRESULT CreateQuery(GLuint* pQuery, D3D_QUERY type);
IC HRESULT GetData(GLuint query, void* pData, u32 DataSize);
IC HRESULT BeginQuery(GLuint query);
IC HRESULT EndQuery(GLuint query);
IC HRESULT ReleaseQuery(GLuint pQuery);
#else
#   error No graphics API selected or enabled!
#endif

//	Implementation

#if defined(USE_DX11)

IC HRESULT CreateQuery(ID3DQuery** ppQuery, D3D_QUERY type)
{
    D3D_QUERY_DESC desc;
    desc.MiscFlags = 0;
    desc.Query = type;
    return HW.pDevice->CreateQuery(&desc, ppQuery);
}

IC HRESULT GetData(ID3DQuery* pQuery, void* pData, u32 DataSize)
{
    //	Use D3Dxx_ASYNC_GETDATA_DONOTFLUSH for prevent flushing
    return HW.get_context(CHW::IMM_CTX_ID)->GetData(pQuery, pData, DataSize, 0); // we can fetch data on imm only
}

IC HRESULT BeginQuery(ID3DQuery* pQuery)
{
    HW.get_context(CHW::IMM_CTX_ID)->Begin(pQuery);
    return S_OK;
}

IC HRESULT EndQuery(ID3DQuery* pQuery)
{
    HW.get_context(CHW::IMM_CTX_ID)->End(pQuery);
    return S_OK;
}

IC HRESULT ReleaseQuery(ID3DQuery* pQuery)
{
    _RELEASE(pQuery);
    return S_OK;
}

#elif defined(USE_OGL)

IC HRESULT CreateQuery(GLuint* pQuery, D3D_QUERY type)
{
    R_ASSERT(type == D3D_QUERY_OCCLUSION);
#ifdef XR_PLATFORM_WEB
    const int native = WebGPUQuery(0);
    *pQuery = native;
#else
    glGenQueries(1, pQuery);
#endif
    return S_OK;
}

#ifdef XR_PLATFORM_WEB
constexpr GLenum OCCLUSION_QUERY_TARGET = GL_ANY_SAMPLES_PASSED_CONSERVATIVE;

IC HRESULT GetData(GLuint query, void* pData, u32 DataSize)
{
    const int native = WebGPUQuery(1, query);
    if (native < 0) return S_FALSE;
    if (DataSize == sizeof(GLint64))
        *(GLint64*)pData = native ? std::numeric_limits<GLint64>::max() : 0;
    else
        *(GLint*)pData = native ? std::numeric_limits<GLint>::max() : 0;
    return S_OK;
}

#else
constexpr GLenum OCCLUSION_QUERY_TARGET = GL_SAMPLES_PASSED;

IC HRESULT GetData(GLuint query, void* pData, u32 DataSize)
{
    if (DataSize == sizeof(GLint64))
        CHK_GL(glGetQueryObjecti64v(query, GL_QUERY_RESULT, (GLint64*)pData));
    else
        CHK_GL(glGetQueryObjectiv(query, GL_QUERY_RESULT, (GLint*)pData));
    return S_OK;
}
#endif

IC HRESULT BeginQuery(GLuint query)
{
#ifdef XR_PLATFORM_WEB
    WebGPUQuery(2, query);
#else
    CHK_GL(glBeginQuery(OCCLUSION_QUERY_TARGET, query));
#endif
    return S_OK;
}

IC HRESULT EndQuery(GLuint query)
{
#ifdef XR_PLATFORM_WEB
    WebGPUQuery(3, query);
#else
    CHK_GL(glEndQuery(OCCLUSION_QUERY_TARGET));
#endif
    return S_OK;
}

IC HRESULT ReleaseQuery(GLuint query)
{
#ifdef XR_PLATFORM_WEB
    WebGPUQuery(4, query);
#else
    CHK_GL(glDeleteQueries(1, &query));
#endif
    return S_OK;
}

#else
#   error No graphics API selected or enabled!
#endif
} // namespace xray::render::RENDER_NAMESPACE
