#pragma once
// Engine capabilities, independent of the browser graphics API.
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsArbGetProgramBinary() { return false; }
#else
inline bool SupportsArbGetProgramBinary() { return GLAD_GL_ARB_get_program_binary; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsArbSeparateShaderObjects() { return false; }
#else
inline bool SupportsArbSeparateShaderObjects() { return GLAD_GL_ARB_separate_shader_objects; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsArbTextureFilterAnisotropic() { return false; }
#else
inline bool SupportsArbTextureFilterAnisotropic() { return GLAD_GL_ARB_texture_filter_anisotropic; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsArbTextureFloat() { return false; }
#else
inline bool SupportsArbTextureFloat() { return GLAD_GL_ARB_texture_float; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsArbVertexAttribBinding() { return false; }
#else
inline bool SupportsArbVertexAttribBinding() { return GLAD_GL_ARB_vertex_attrib_binding; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsEsVersion30() { return true; }
#else
inline bool SupportsEsVersion30() { return GLAD_GL_ES_VERSION_3_0; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsExtTextureFilterAnisotropic() { return true; }
#else
inline bool SupportsExtTextureFilterAnisotropic() { return GLAD_GL_EXT_texture_filter_anisotropic; }
#endif
#ifdef XR_PLATFORM_WEB
inline constexpr bool SupportsVersion30() { return false; }
#else
inline bool SupportsVersion30() { return GLAD_GL_VERSION_3_0; }
#endif
