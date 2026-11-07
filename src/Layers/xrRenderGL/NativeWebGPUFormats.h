#pragma once
#include <cstdint>
// Legacy numeric identifiers used by the engine resource wire format. No GL loader.
using GLvoid = void;
using GLenum = unsigned int; using GLuint = unsigned int; using GLint = int;
using GLsizei = int; using GLboolean = unsigned char; using GLbitfield = unsigned int;
using GLushort = unsigned short; using GLubyte = unsigned char; using GLbyte = signed char;
using GLshort = short; using GLfloat = float; using GLdouble = double; using GLclampf = float; using GLchar = char;
using GLsizeiptr = intptr_t; using GLintptr = intptr_t; using GLint64 = int64_t;
using GLuint64 = uint64_t; using GLsync = void*;
using GLDEBUGPROC = void (*)(GLenum, GLenum, GLuint, GLenum, GLsizei, const GLchar*, const void*);

#define GL_ACTIVE_UNIFORMS 0x8B86
#define GL_ACTIVE_UNIFORM_MAX_LENGTH 0x8B87
#define GL_ALREADY_SIGNALED 0x911A
#define GL_ALWAYS 0x0207
#define GL_ANY_SAMPLES_PASSED_CONSERVATIVE 0x8D6A
#define GL_ARRAY_BUFFER 0x8892
#define GL_BACK 0x0405
#define GL_BGRA 0x80E1
#define GL_BLEND 0x0BE2
#define GL_BLUE 0x1905
#define GL_BOOL 0x8B56
#define GL_BOOL_VEC2 0x8B57
#define GL_BOOL_VEC3 0x8B58
#define GL_BOOL_VEC4 0x8B59
#define GL_BUFFER_SIZE 0x8764
#define GL_CLAMP_TO_BORDER 0x812D
#define GL_CLAMP_TO_EDGE 0x812F
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_COLOR_ATTACHMENT1 0x8CE1
#define GL_COLOR_ATTACHMENT2 0x8CE2
#define GL_COLOR_BUFFER_BIT 0x00004000
#define GL_COMPARE_REF_TO_TEXTURE 0x884E
#define GL_COMPILE_STATUS 0x8B81
#define GL_COMPUTE_SHADER 0x91B9
#define GL_CONDITION_SATISFIED 0x911C
#define GL_COPY_READ_BUFFER 0x8F36
#define GL_COPY_WRITE_BUFFER 0x8F37
#define GL_CULL_FACE 0x0B44
#define GL_DEBUG_OUTPUT 0x92E0
#define GL_DEBUG_SEVERITY_NOTIFICATION 0x826B
#define GL_DEBUG_SOURCE_APPLICATION 0x824A
#define GL_DECR 0x1E03
#define GL_DECR_WRAP 0x8508
#define GL_DEPTH24_STENCIL8 0x88F0
#define GL_DEPTH_BUFFER_BIT 0x00000100
#define GL_DEPTH_COMPONENT16 0x81A5
#define GL_DEPTH_COMPONENT32F 0x8CAC
#define GL_DEPTH_STENCIL_ATTACHMENT 0x821A
#define GL_DEPTH_TEST 0x0B71
#define GL_DRAW_FRAMEBUFFER 0x8CA9
#define GL_DST_ALPHA 0x0304
#define GL_DST_COLOR 0x0306
#define GL_DYNAMIC_DRAW 0x88E8
#define GL_ELEMENT_ARRAY_BUFFER 0x8893
#define GL_EQUAL 0x0202
#define GL_FALSE 0
#define GL_FILL 0x1B02
#define GL_FLOAT 0x1406
#define GL_FLOAT_MAT2 0x8B5A
#define GL_FLOAT_MAT3 0x8B5B
#define GL_FLOAT_MAT4 0x8B5C
#define GL_FLOAT_MAT4x2 0x8B69
#define GL_FLOAT_MAT4x3 0x8B6A
#define GL_FLOAT_VEC2 0x8B50
#define GL_FLOAT_VEC3 0x8B51
#define GL_FLOAT_VEC4 0x8B52
#define GL_FRAGMENT_SHADER 0x8B30
#define GL_FRAGMENT_SHADER_BIT 0x00000002
#define GL_FRAMEBUFFER 0x8D40
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_FRONT 0x0404
#define GL_FRONT_AND_BACK 0x0408
#define GL_FUNC_ADD 0x8006
#define GL_FUNC_REVERSE_SUBTRACT 0x800B
#define GL_FUNC_SUBTRACT 0x800A
#define GL_GEOMETRY_SHADER 0x8DD9
#define GL_GEOMETRY_SHADER_BIT 0x00000004
#define GL_GEQUAL 0x0206
#define GL_GREATER 0x0204
#define GL_HALF_FLOAT 0x140B
#define GL_INCR 0x1E02
#define GL_INCR_WRAP 0x8507
#define GL_INFO_LOG_LENGTH 0x8B84
#define GL_INT 0x1404
#define GL_INT_2_10_10_10_REV 0x8D9F
#define GL_INT_VEC2 0x8B53
#define GL_INT_VEC3 0x8B54
#define GL_INT_VEC4 0x8B55
#define GL_INVERT 0x150A
#define GL_KEEP 0x1E00
#define GL_LEQUAL 0x0203
#define GL_LESS 0x0201
#define GL_LINE 0x1B01
#define GL_LINES 0x0001
#define GL_LINE_STRIP 0x0003
#define GL_LINK_STATUS 0x8B82
#define GL_MAP_INVALIDATE_BUFFER_BIT 0x0008
#define GL_MAP_INVALIDATE_RANGE_BIT 0x0004
#define GL_MAP_UNSYNCHRONIZED_BIT 0x0020
#define GL_MAP_WRITE_BIT 0x0002
#define GL_MAX 0x8008
#define GL_MAX_COMBINED_TEXTURE_IMAGE_UNITS 0x8B4D
#define GL_MAX_FRAMEBUFFER_HEIGHT 0x9316
#define GL_MAX_FRAMEBUFFER_WIDTH 0x9315
#define GL_MAX_TEXTURE_SIZE 0x0D33
#define GL_MAX_VERTEX_TEXTURE_IMAGE_UNITS 0x8B4C
#define GL_MIN 0x8007
#define GL_MIRRORED_REPEAT 0x8370
#define GL_NEAREST 0x2600
#define GL_NEVER 0x0200
#define GL_NONE 0
#define GL_NOTEQUAL 0x0205
#define GL_NO_ERROR 0
#define GL_ONE 1
#define GL_ONE_MINUS_DST_ALPHA 0x0305
#define GL_ONE_MINUS_DST_COLOR 0x0307
#define GL_ONE_MINUS_SRC_ALPHA 0x0303
#define GL_ONE_MINUS_SRC_COLOR 0x0301
#define GL_PIXEL_UNPACK_BUFFER 0x88EC
#define GL_POINT 0x1B00
#define GL_POINTS 0x0000
#define GL_PROGRAM 0x82E2
#define GL_PROGRAM_BINARY_LENGTH 0x8741
#define GL_PROGRAM_BINARY_RETRIEVABLE_HINT 0x8257
#define GL_PROGRAM_PIPELINE 0x82E4
#define GL_PROGRAM_SEPARABLE 0x8258
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867
#define GL_R16F 0x822D
#define GL_R32F 0x822E
#define GL_R8 0x8229
#define GL_READ_FRAMEBUFFER 0x8CA8
#define GL_RENDERER 0x1F01
#define GL_REPEAT 0x2901
#define GL_REPLACE 0x1E01
#define GL_RG 0x8227
#define GL_RG16 0x822C
#define GL_RG16F 0x822F
#define GL_RG32F 0x8230
#define GL_RG8 0x822B
#define GL_RGB 0x1907
#define GL_RGB32F 0x8815
#define GL_RGBA 0x1908
#define GL_RGBA16 0x805B
#define GL_RGBA16F 0x881A
#define GL_RGBA32F 0x8814
#define GL_RGBA8 0x8058
#define GL_SAMPLER_1D 0x8B5D
#define GL_SAMPLER_2D 0x8B5E
#define GL_SAMPLER_2D_MULTISAMPLE 0x9108
#define GL_SAMPLER_2D_SHADOW 0x8B62
#define GL_SAMPLER_3D 0x8B5F
#define GL_SAMPLER_CUBE 0x8B60
#define GL_SAMPLES_PASSED 0x8914
#define GL_SCISSOR_TEST 0x0C11
#define GL_SHADER_SOURCE_LENGTH 0x8B88
#define GL_SHADING_LANGUAGE_VERSION 0x8B8C
#define GL_SHORT 0x1402
#define GL_SRC_ALPHA 0x0302
#define GL_SRC_ALPHA_SATURATE 0x0308
#define GL_SRC_COLOR 0x0300
#define GL_STATIC_DRAW 0x88E4
#define GL_STENCIL_BUFFER_BIT 0x00000400
#define GL_STENCIL_TEST 0x0B90
#define GL_STREAM_DRAW 0x88E0
#define GL_SYNC_FLUSH_COMMANDS_BIT 0x00000001
#define GL_SYNC_GPU_COMMANDS_COMPLETE 0x9117
#define GL_TESS_CONTROL_SHADER 0x8E88
#define GL_TESS_EVALUATION_SHADER 0x8E87
#define GL_TEXTURE0 0x84C0
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE_2D_MULTISAMPLE 0x9100
#define GL_TEXTURE_3D 0x806F
#define GL_TEXTURE_BASE_LEVEL 0x813C
#define GL_TEXTURE_BORDER_COLOR 0x1004
#define GL_TEXTURE_COMPARE_FUNC 0x884D
#define GL_TEXTURE_COMPARE_MODE 0x884C
#define GL_TEXTURE_CUBE_MAP 0x8513
#define GL_TEXTURE_CUBE_MAP_POSITIVE_X 0x8515
#define GL_TEXTURE_HEIGHT 0x1001
#define GL_TEXTURE_LOD_BIAS 0x8501
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_TEXTURE_MAX_ANISOTROPY 0x84FE
#define GL_TEXTURE_MAX_LEVEL 0x813D
#define GL_TEXTURE_MAX_LOD 0x813B
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MIN_LOD 0x813A
#define GL_TEXTURE_SWIZZLE_RGBA 0x8E46
#define GL_TEXTURE_WIDTH 0x1000
#define GL_TEXTURE_WRAP_R 0x8072
#define GL_TEXTURE_WRAP_S 0x2802
#define GL_TEXTURE_WRAP_T 0x2803
#define GL_TIMEOUT_EXPIRED 0x911B
#define GL_TRIANGLES 0x0004
#define GL_TRIANGLE_FAN 0x0006
#define GL_TRIANGLE_STRIP 0x0005
#define GL_TRUE 1
#define GL_UNSIGNED_BYTE 0x1401
#define GL_UNSIGNED_SHORT 0x1403
#define GL_VENDOR 0x1F00
#define GL_VERSION 0x1F02
#define GL_VERTEX_SHADER 0x8B31
#define GL_VERTEX_SHADER_BIT 0x00000001
#define GL_WAIT_FAILED 0x911D
#define GL_WRITE_ONLY 0x88B9
#define GL_ZERO 0
#define GL_ARB_separate_shader_objects 1
// Compile-time poison declarations let shared desktop code parse without GLAD.
// No definitions or loader exist; any emitted GLES call fails compilation/linking.
__attribute__((error("GLES forbidden in browser: glActiveTexture"))) void glActiveTexture(GLenum texture);
__attribute__((error("GLES forbidden in browser: glAttachShader"))) void glAttachShader(GLuint program, GLuint shader);
__attribute__((error("GLES forbidden in browser: glBeginQuery"))) void glBeginQuery(GLenum target, GLuint id);
__attribute__((error("GLES forbidden in browser: glBindBuffer"))) void glBindBuffer(GLenum target, GLuint buffer);
__attribute__((error("GLES forbidden in browser: glBindFragDataLocation"))) void glBindFragDataLocation(GLuint program, GLuint color, const GLchar * name);
__attribute__((error("GLES forbidden in browser: glBindFramebuffer"))) void glBindFramebuffer(GLenum target, GLuint framebuffer);
__attribute__((error("GLES forbidden in browser: glBindProgramPipeline"))) void glBindProgramPipeline(GLuint pipeline);
__attribute__((error("GLES forbidden in browser: glBindSampler"))) void glBindSampler(GLuint unit, GLuint sampler);
__attribute__((error("GLES forbidden in browser: glBindTexture"))) void glBindTexture(GLenum target, GLuint texture);
__attribute__((error("GLES forbidden in browser: glBindVertexArray"))) void glBindVertexArray(GLuint array);
__attribute__((error("GLES forbidden in browser: glBindVertexBuffer"))) void glBindVertexBuffer(GLuint bindingindex, GLuint buffer, GLintptr offset, GLsizei stride);
__attribute__((error("GLES forbidden in browser: glBlendEquationSeparate"))) void glBlendEquationSeparate(GLenum modeRGB, GLenum modeAlpha);
__attribute__((error("GLES forbidden in browser: glBlendFuncSeparate"))) void glBlendFuncSeparate(GLenum sfactorRGB, GLenum dfactorRGB, GLenum sfactorAlpha, GLenum dfactorAlpha);
__attribute__((error("GLES forbidden in browser: glBlitFramebuffer"))) void glBlitFramebuffer(GLint srcX0, GLint srcY0, GLint srcX1, GLint srcY1, GLint dstX0, GLint dstY0, GLint dstX1, GLint dstY1, GLbitfield mask, GLenum filter);
__attribute__((error("GLES forbidden in browser: glBufferData"))) void glBufferData(GLenum target, GLsizeiptr size, const void * data, GLenum usage);
__attribute__((error("GLES forbidden in browser: glBufferSubData"))) void glBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, const void * data);
__attribute__((error("GLES forbidden in browser: glCheckFramebufferStatus"))) GLenum glCheckFramebufferStatus(GLenum target);
__attribute__((error("GLES forbidden in browser: glClear"))) void glClear(GLbitfield mask);
__attribute__((error("GLES forbidden in browser: glClearColor"))) void glClearColor(GLfloat red, GLfloat green, GLfloat blue, GLfloat alpha);
__attribute__((error("GLES forbidden in browser: glClearDepthf"))) void glClearDepthf(GLfloat d);
__attribute__((error("GLES forbidden in browser: glClearStencil"))) void glClearStencil(GLint s);
__attribute__((error("GLES forbidden in browser: glClientWaitSync"))) GLenum glClientWaitSync(GLsync sync, GLbitfield flags, GLuint64 timeout);
__attribute__((error("GLES forbidden in browser: glColorMask"))) void glColorMask(GLboolean red, GLboolean green, GLboolean blue, GLboolean alpha);
__attribute__((error("GLES forbidden in browser: glCompileShader"))) void glCompileShader(GLuint shader);
__attribute__((error("GLES forbidden in browser: glCompressedTexSubImage2D"))) void glCompressedTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLsizei imageSize, const void * data);
__attribute__((error("GLES forbidden in browser: glCompressedTexSubImage3D"))) void glCompressedTexSubImage3D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLint zoffset, GLsizei width, GLsizei height, GLsizei depth, GLenum format, GLsizei imageSize, const void * data);
__attribute__((error("GLES forbidden in browser: glCopyTexSubImage2D"))) void glCopyTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLint x, GLint y, GLsizei width, GLsizei height);
__attribute__((error("GLES forbidden in browser: glCreateProgram"))) GLuint glCreateProgram(void);
__attribute__((error("GLES forbidden in browser: glCreateShader"))) GLuint glCreateShader(GLenum type);
__attribute__((error("GLES forbidden in browser: glCullFace"))) void glCullFace(GLenum mode);
__attribute__((error("GLES forbidden in browser: glDebugMessageCallback"))) void glDebugMessageCallback(GLDEBUGPROC callback, const void * userParam);
__attribute__((error("GLES forbidden in browser: glDeleteBuffers"))) void glDeleteBuffers(GLsizei n, const GLuint * buffers);
__attribute__((error("GLES forbidden in browser: glDeleteFramebuffers"))) void glDeleteFramebuffers(GLsizei n, const GLuint * framebuffers);
__attribute__((error("GLES forbidden in browser: glDeleteProgram"))) void glDeleteProgram(GLuint program);
__attribute__((error("GLES forbidden in browser: glDeleteProgramPipelines"))) void glDeleteProgramPipelines(GLsizei n, const GLuint * pipelines);
__attribute__((error("GLES forbidden in browser: glDeleteQueries"))) void glDeleteQueries(GLsizei n, const GLuint * ids);
__attribute__((error("GLES forbidden in browser: glDeleteSamplers"))) void glDeleteSamplers(GLsizei count, const GLuint * samplers);
__attribute__((error("GLES forbidden in browser: glDeleteShader"))) void glDeleteShader(GLuint shader);
__attribute__((error("GLES forbidden in browser: glDeleteSync"))) void glDeleteSync(GLsync sync);
__attribute__((error("GLES forbidden in browser: glDeleteTextures"))) void glDeleteTextures(GLsizei n, const GLuint * textures);
__attribute__((error("GLES forbidden in browser: glDeleteVertexArrays"))) void glDeleteVertexArrays(GLsizei n, const GLuint * arrays);
__attribute__((error("GLES forbidden in browser: glDepthFunc"))) void glDepthFunc(GLenum func);
__attribute__((error("GLES forbidden in browser: glDepthMask"))) void glDepthMask(GLboolean flag);
__attribute__((error("GLES forbidden in browser: glDepthRangef"))) void glDepthRangef(GLfloat n, GLfloat f);
__attribute__((error("GLES forbidden in browser: glDetachShader"))) void glDetachShader(GLuint program, GLuint shader);
__attribute__((error("GLES forbidden in browser: glDisable"))) void glDisable(GLenum cap);
__attribute__((error("GLES forbidden in browser: glDrawArrays"))) void glDrawArrays(GLenum mode, GLint first, GLsizei count);
__attribute__((error("GLES forbidden in browser: glDrawBuffer"))) void glDrawBuffer(GLenum buf);
__attribute__((error("GLES forbidden in browser: glDrawBuffers"))) void glDrawBuffers(GLsizei n, const GLenum * bufs);
__attribute__((error("GLES forbidden in browser: glDrawElements"))) void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void * indices);
__attribute__((error("GLES forbidden in browser: glDrawElementsBaseVertex"))) void glDrawElementsBaseVertex(GLenum mode, GLsizei count, GLenum type, const void * indices, GLint basevertex);
__attribute__((error("GLES forbidden in browser: glEnable"))) void glEnable(GLenum cap);
__attribute__((error("GLES forbidden in browser: glEnableVertexAttribArray"))) void glEnableVertexAttribArray(GLuint index);
__attribute__((error("GLES forbidden in browser: glEndQuery"))) void glEndQuery(GLenum target);
__attribute__((error("GLES forbidden in browser: glFenceSync"))) GLsync glFenceSync(GLenum condition, GLbitfield flags);
__attribute__((error("GLES forbidden in browser: glFramebufferTexture2D"))) void glFramebufferTexture2D(GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level);
__attribute__((error("GLES forbidden in browser: glGenBuffers"))) void glGenBuffers(GLsizei n, GLuint * buffers);
__attribute__((error("GLES forbidden in browser: glGenFramebuffers"))) void glGenFramebuffers(GLsizei n, GLuint * framebuffers);
__attribute__((error("GLES forbidden in browser: glGenProgramPipelines"))) void glGenProgramPipelines(GLsizei n, GLuint * pipelines);
__attribute__((error("GLES forbidden in browser: glGenQueries"))) void glGenQueries(GLsizei n, GLuint * ids);
__attribute__((error("GLES forbidden in browser: glGenSamplers"))) void glGenSamplers(GLsizei count, GLuint * samplers);
__attribute__((error("GLES forbidden in browser: glGenTextures"))) void glGenTextures(GLsizei n, GLuint * textures);
__attribute__((error("GLES forbidden in browser: glGenVertexArrays"))) void glGenVertexArrays(GLsizei n, GLuint * arrays);
__attribute__((error("GLES forbidden in browser: glGenerateMipmap"))) void glGenerateMipmap(GLenum target);
__attribute__((error("GLES forbidden in browser: glGetActiveUniform"))) void glGetActiveUniform(GLuint program, GLuint index, GLsizei bufSize, GLsizei * length, GLint * size, GLenum * type, GLchar * name);
__attribute__((error("GLES forbidden in browser: glGetBufferParameteriv"))) void glGetBufferParameteriv(GLenum target, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetError"))) GLenum glGetError(void);
__attribute__((error("GLES forbidden in browser: glGetIntegerv"))) void glGetIntegerv(GLenum pname, GLint * data);
__attribute__((error("GLES forbidden in browser: glGetObjectLabel"))) void glGetObjectLabel(GLenum identifier, GLuint name, GLsizei bufSize, GLsizei * length, GLchar * label);
__attribute__((error("GLES forbidden in browser: glGetProgramBinary"))) void glGetProgramBinary(GLuint program, GLsizei bufSize, GLsizei * length, GLenum * binaryFormat, void * binary);
__attribute__((error("GLES forbidden in browser: glGetProgramInfoLog"))) void glGetProgramInfoLog(GLuint program, GLsizei bufSize, GLsizei * length, GLchar * infoLog);
__attribute__((error("GLES forbidden in browser: glGetProgramiv"))) void glGetProgramiv(GLuint program, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetQueryObjecti64v"))) void glGetQueryObjecti64v(GLuint id, GLenum pname, GLint64 * params);
__attribute__((error("GLES forbidden in browser: glGetQueryObjectiv"))) void glGetQueryObjectiv(GLuint id, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetQueryObjectuiv"))) void glGetQueryObjectuiv(GLuint id, GLenum pname, GLuint * params);
__attribute__((error("GLES forbidden in browser: glGetSamplerParameteriv"))) void glGetSamplerParameteriv(GLuint sampler, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetShaderInfoLog"))) void glGetShaderInfoLog(GLuint shader, GLsizei bufSize, GLsizei * length, GLchar * infoLog);
__attribute__((error("GLES forbidden in browser: glGetShaderSource"))) void glGetShaderSource(GLuint shader, GLsizei bufSize, GLsizei * length, GLchar * source);
__attribute__((error("GLES forbidden in browser: glGetShaderiv"))) void glGetShaderiv(GLuint shader, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetString"))) const GLubyte * glGetString(GLenum name);
__attribute__((error("GLES forbidden in browser: glGetTexLevelParameteriv"))) void glGetTexLevelParameteriv(GLenum target, GLint level, GLenum pname, GLint * params);
__attribute__((error("GLES forbidden in browser: glGetUniformLocation"))) GLint glGetUniformLocation(GLuint program, const GLchar * name);
__attribute__((error("GLES forbidden in browser: glLinkProgram"))) void glLinkProgram(GLuint program);
__attribute__((error("GLES forbidden in browser: glMapBuffer"))) void * glMapBuffer(GLenum target, GLenum access);
__attribute__((error("GLES forbidden in browser: glMapBufferRange"))) void * glMapBufferRange(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access);
__attribute__((error("GLES forbidden in browser: glObjectLabel"))) void glObjectLabel(GLenum identifier, GLuint name, GLsizei length, const GLchar * label);
__attribute__((error("GLES forbidden in browser: glPolygonMode"))) void glPolygonMode(GLenum face, GLenum mode);
__attribute__((error("GLES forbidden in browser: glPopDebugGroup"))) void glPopDebugGroup(void);
__attribute__((error("GLES forbidden in browser: glProgramBinary"))) void glProgramBinary(GLuint program, GLenum binaryFormat, const void * binary, GLsizei length);
__attribute__((error("GLES forbidden in browser: glProgramParameteri"))) void glProgramParameteri(GLuint program, GLenum pname, GLint value);
__attribute__((error("GLES forbidden in browser: glProgramUniform1f"))) void glProgramUniform1f(GLuint program, GLint location, GLfloat v0);
__attribute__((error("GLES forbidden in browser: glProgramUniform1i"))) void glProgramUniform1i(GLuint program, GLint location, GLint v0);
__attribute__((error("GLES forbidden in browser: glProgramUniform2f"))) void glProgramUniform2f(GLuint program, GLint location, GLfloat v0, GLfloat v1);
__attribute__((error("GLES forbidden in browser: glProgramUniform2fv"))) void glProgramUniform2fv(GLuint program, GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glProgramUniform3f"))) void glProgramUniform3f(GLuint program, GLint location, GLfloat v0, GLfloat v1, GLfloat v2);
__attribute__((error("GLES forbidden in browser: glProgramUniform3fv"))) void glProgramUniform3fv(GLuint program, GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glProgramUniform4f"))) void glProgramUniform4f(GLuint program, GLint location, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3);
__attribute__((error("GLES forbidden in browser: glProgramUniform4fv"))) void glProgramUniform4fv(GLuint program, GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glProgramUniformMatrix4fv"))) void glProgramUniformMatrix4fv(GLuint program, GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glProgramUniformMatrix4x2fv"))) void glProgramUniformMatrix4x2fv(GLuint program, GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glProgramUniformMatrix4x3fv"))) void glProgramUniformMatrix4x3fv(GLuint program, GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glPushDebugGroup"))) void glPushDebugGroup(GLenum source, GLuint id, GLsizei length, const GLchar * message);
__attribute__((error("GLES forbidden in browser: glReadBuffer"))) void glReadBuffer(GLenum src);
__attribute__((error("GLES forbidden in browser: glReadPixels"))) void glReadPixels(GLint x, GLint y, GLsizei width, GLsizei height, GLenum format, GLenum type, void * pixels);
__attribute__((error("GLES forbidden in browser: glSamplerParameterIuiv"))) void glSamplerParameterIuiv(GLuint sampler, GLenum pname, const GLuint * param);
__attribute__((error("GLES forbidden in browser: glSamplerParameterf"))) void glSamplerParameterf(GLuint sampler, GLenum pname, GLfloat param);
__attribute__((error("GLES forbidden in browser: glScissor"))) void glScissor(GLint x, GLint y, GLsizei width, GLsizei height);
__attribute__((error("GLES forbidden in browser: glShaderSource"))) void glShaderSource(GLuint shader, GLsizei count, const GLchar *const* string, const GLint * length);
__attribute__((error("GLES forbidden in browser: glStencilFunc"))) void glStencilFunc(GLenum func, GLint ref, GLuint mask);
__attribute__((error("GLES forbidden in browser: glStencilMask"))) void glStencilMask(GLuint mask);
__attribute__((error("GLES forbidden in browser: glStencilOp"))) void glStencilOp(GLenum fail, GLenum zfail, GLenum zpass);
__attribute__((error("GLES forbidden in browser: glTexImage2DMultisample"))) void glTexImage2DMultisample(GLenum target, GLsizei samples, GLenum internalformat, GLsizei width, GLsizei height, GLboolean fixedsamplelocations);
__attribute__((error("GLES forbidden in browser: glTexParameteri"))) void glTexParameteri(GLenum target, GLenum pname, GLint param);
__attribute__((error("GLES forbidden in browser: glTexParameteriv"))) void glTexParameteriv(GLenum target, GLenum pname, const GLint * params);
__attribute__((error("GLES forbidden in browser: glTexStorage2D"))) void glTexStorage2D(GLenum target, GLsizei levels, GLenum internalformat, GLsizei width, GLsizei height);
__attribute__((error("GLES forbidden in browser: glTexStorage3D"))) void glTexStorage3D(GLenum target, GLsizei levels, GLenum internalformat, GLsizei width, GLsizei height, GLsizei depth);
__attribute__((error("GLES forbidden in browser: glTexSubImage2D"))) void glTexSubImage2D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLsizei width, GLsizei height, GLenum format, GLenum type, const void * pixels);
__attribute__((error("GLES forbidden in browser: glTexSubImage3D"))) void glTexSubImage3D(GLenum target, GLint level, GLint xoffset, GLint yoffset, GLint zoffset, GLsizei width, GLsizei height, GLsizei depth, GLenum format, GLenum type, const void * pixels);
__attribute__((error("GLES forbidden in browser: glUniform1f"))) void glUniform1f(GLint location, GLfloat v0);
__attribute__((error("GLES forbidden in browser: glUniform1i"))) void glUniform1i(GLint location, GLint v0);
__attribute__((error("GLES forbidden in browser: glUniform2f"))) void glUniform2f(GLint location, GLfloat v0, GLfloat v1);
__attribute__((error("GLES forbidden in browser: glUniform2fv"))) void glUniform2fv(GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUniform3f"))) void glUniform3f(GLint location, GLfloat v0, GLfloat v1, GLfloat v2);
__attribute__((error("GLES forbidden in browser: glUniform3fv"))) void glUniform3fv(GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUniform4f"))) void glUniform4f(GLint location, GLfloat v0, GLfloat v1, GLfloat v2, GLfloat v3);
__attribute__((error("GLES forbidden in browser: glUniform4fv"))) void glUniform4fv(GLint location, GLsizei count, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUniformMatrix4fv"))) void glUniformMatrix4fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUniformMatrix4x2fv"))) void glUniformMatrix4x2fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUniformMatrix4x3fv"))) void glUniformMatrix4x3fv(GLint location, GLsizei count, GLboolean transpose, const GLfloat * value);
__attribute__((error("GLES forbidden in browser: glUnmapBuffer"))) GLboolean glUnmapBuffer(GLenum target);
__attribute__((error("GLES forbidden in browser: glUseProgram"))) void glUseProgram(GLuint program);
__attribute__((error("GLES forbidden in browser: glUseProgramStages"))) void glUseProgramStages(GLuint pipeline, GLbitfield stages, GLuint program);
__attribute__((error("GLES forbidden in browser: glValidateProgramPipeline"))) void glValidateProgramPipeline(GLuint pipeline);
__attribute__((error("GLES forbidden in browser: glVertexAttribBinding"))) void glVertexAttribBinding(GLuint attribindex, GLuint bindingindex);
__attribute__((error("GLES forbidden in browser: glVertexAttribFormat"))) void glVertexAttribFormat(GLuint attribindex, GLint size, GLenum type, GLboolean normalized, GLuint relativeoffset);
__attribute__((error("GLES forbidden in browser: glVertexAttribPointer"))) void glVertexAttribPointer(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void * pointer);
__attribute__((error("GLES forbidden in browser: glViewport"))) void glViewport(GLint x, GLint y, GLsizei width, GLsizei height);
