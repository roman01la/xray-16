/*
 ** Copyright (c) 2013-2018 The Khronos Group Inc.
 **
 ** Permission is hereby granted, free of charge, to any person obtaining a
 ** copy of this software and/or associated documentation files (the
 ** "Materials"), to deal in the Materials without restriction, including
 ** without limitation the rights to use, copy, modify, merge, publish,
 ** distribute, sublicense, and/or sell copies of the Materials, and to
 ** permit persons to whom the Materials are furnished to do so, subject to
 ** the following conditions:
 **
 ** The above copyright notice and this permission notice shall be included
 ** in all copies or substantial portions of the Materials.
 **
 ** THE MATERIALS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 ** EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 ** MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 ** IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 ** CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 ** TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 ** MATERIALS OR THE USE OR OTHER DEALINGS IN THE MATERIALS.
 */
// Test-only reference interpreter. Excluded from the production package.
const referenceMethods = [
  "createTexture",
  "activeTexture",
  "attachShader",
  "beginQuery",
  "beginTransformFeedback",
  "bindAttribLocation",
  "bindBuffer",
  "bindBufferBase",
  "bindBufferRange",
  "bindFramebuffer",
  "bindRenderbuffer",
  "bindSampler",
  "bindTexture",
  "bindTransformFeedback",
  "bindVertexArray",
  "blendColor",
  "blendEquation",
  "blendEquationSeparate",
  "blendFunc",
  "blendFuncSeparate",
  "blitFramebuffer",
  "bufferData",
  "bufferSubData",
  "checkFramebufferStatus",
  "clear",
  "clearBufferfi",
  "clearBufferfv",
  "clearBufferiv",
  "clearBufferuiv",
  "clearColor",
  "clearDepth",
  "clearStencil",
  "clientWaitSync",
  "colorMask",
  "commit",
  "compileShader",
  "compressedTexImage2D",
  "compressedTexImage3D",
  "compressedTexSubImage2D",
  "compressedTexSubImage3D",
  "copyBufferSubData",
  "copyTexImage2D",
  "copyTexSubImage2D",
  "copyTexSubImage3D",
  "createBuffer",
  "createFramebuffer",
  "createProgram",
  "createQuery",
  "createRenderbuffer",
  "createSampler",
  "createShader",
  "createTransformFeedback",
  "createVertexArray",
  "cullFace",
  "deleteBuffer",
  "deleteFramebuffer",
  "deleteProgram",
  "deleteQuery",
  "deleteRenderbuffer",
  "deleteSampler",
  "deleteShader",
  "deleteSync",
  "deleteTexture",
  "deleteTransformFeedback",
  "deleteVertexArray",
  "depthFunc",
  "depthMask",
  "depthRange",
  "detachShader",
  "disable",
  "disableVertexAttribArray",
  "drawArrays",
  "drawArraysInstanced",
  "drawBuffers",
  "drawElements",
  "drawElementsInstanced",
  "enable",
  "enableVertexAttribArray",
  "endQuery",
  "endTransformFeedback",
  "fenceSync",
  "finish",
  "flush",
  "framebufferRenderbuffer",
  "framebufferTexture2D",
  "framebufferTextureLayer",
  "frontFace",
  "generateMipmap",
  "getActiveAttrib",
  "getActiveUniform",
  "getActiveUniformBlockName",
  "getActiveUniformBlockParameter",
  "getActiveUniforms",
  "getAttachedShaders",
  "getAttribLocation",
  "getBufferParameter",
  "getContextAttributes",
  "getError",
  "getExtension",
  "getFragDataLocation",
  "getFramebufferAttachmentParameter",
  "getIndexedParameter",
  "getInternalformatParameter",
  "getParameter",
  "getProgramInfoLog",
  "getProgramParameter",
  "getQuery",
  "getQueryParameter",
  "getRenderbufferParameter",
  "getSamplerParameter",
  "getShaderInfoLog",
  "getShaderParameter",
  "getShaderPrecisionFormat",
  "getShaderSource",
  "getSupportedExtensions",
  "getSyncParameter",
  "getTexParameter",
  "getTransformFeedbackVarying",
  "getUniform",
  "getUniformBlockIndex",
  "getUniformIndices",
  "getUniformLocation",
  "getVertexAttrib",
  "getVertexAttribOffset",
  "hint",
  "invalidateFramebuffer",
  "invalidateSubFramebuffer",
  "isBuffer",
  "isContextLost",
  "isEnabled",
  "isFramebuffer",
  "isProgram",
  "isQuery",
  "isRenderbuffer",
  "isSampler",
  "isShader",
  "isSync",
  "isTexture",
  "isTransformFeedback",
  "isVertexArray",
  "lineWidth",
  "linkProgram",
  "pauseTransformFeedback",
  "pixelStorei",
  "polygonOffset",
  "readBuffer",
  "readPixels",
  "renderbufferStorage",
  "renderbufferStorageMultisample",
  "resumeTransformFeedback",
  "sampleCoverage",
  "samplerParameterf",
  "samplerParameteri",
  "scissor",
  "shaderSource",
  "stencilFunc",
  "stencilFuncSeparate",
  "stencilMask",
  "stencilMaskSeparate",
  "stencilOp",
  "stencilOpSeparate",
  "texImage2D",
  "texImage3D",
  "texParameterf",
  "texParameteri",
  "texStorage2D",
  "texStorage3D",
  "texSubImage2D",
  "texSubImage3D",
  "transformFeedbackVaryings",
  "uniform1f",
  "uniform1fv",
  "uniform1i",
  "uniform1iv",
  "uniform1ui",
  "uniform1uiv",
  "uniform2f",
  "uniform2fv",
  "uniform2i",
  "uniform2iv",
  "uniform2ui",
  "uniform2uiv",
  "uniform3f",
  "uniform3fv",
  "uniform3i",
  "uniform3iv",
  "uniform3ui",
  "uniform3uiv",
  "uniform4f",
  "uniform4fv",
  "uniform4i",
  "uniform4iv",
  "uniform4ui",
  "uniform4uiv",
  "uniformBlockBinding",
  "uniformMatrix2fv",
  "uniformMatrix2x3fv",
  "uniformMatrix2x4fv",
  "uniformMatrix3fv",
  "uniformMatrix3x2fv",
  "uniformMatrix3x4fv",
  "uniformMatrix4fv",
  "uniformMatrix4x2fv",
  "uniformMatrix4x3fv",
  "useProgram",
  "validateProgram",
  "vertexAttrib1f",
  "vertexAttrib2f",
  "vertexAttrib3f",
  "vertexAttrib4f",
  "vertexAttribDivisor",
  "vertexAttribI4i",
  "vertexAttribI4ui",
  "vertexAttribIPointer",
  "vertexAttribPointer",
  "viewport",
  "waitSync",
];

// Historical command semantics retained for migration regression tests.
import { shaderKey } from "./shader-key.js";
import { EngineFormat } from "./engine-formats.js";
const methods = new Set(referenceMethods);
const stateCommands = new Set(
  `activeTexture bindTexture bindSampler samplerParameteri samplerParameterf texParameteri texParameterf bindBuffer bufferData bufferSubData bindVertexArray enableVertexAttribArray disableVertexAttribArray vertexAttribPointer vertexAttribIPointer vertexAttribDivisor bindFramebuffer framebufferTexture2D framebufferTextureLayer drawBuffers texStorage2D texStorage3D texImage2D texSubImage2D texSubImage3D compressedTexSubImage2D compressedTexSubImage3D useProgram enable disable depthMask depthFunc depthRange colorMask blendFunc blendFuncSeparate blendEquation blendEquationSeparate blendColor cullFace frontFace viewport scissor clearColor clearDepth clearStencil polygonOffset stencilFunc stencilFuncSeparate stencilOp stencilOpSeparate stencilMask pixelStorei readBuffer hint invalidateFramebuffer invalidateSubFramebuffer lineWidth sampleCoverage`.split(
    " ",
  ),
);
// These commands are fully represented by GPUFrontend state. Avoid a second
// proxy dispatch for them; only query-visible state needs the facade update.
export const frontendOnlyCommands = new Set([...stateCommands].filter(name =>
  !["enable", "disable", "blendFunc", "blendFuncSeparate", "blendEquation",
    "blendEquationSeparate", "colorMask", "pixelStorei"].includes(name)));
const extensions = [
  "WEBGL_compressed_texture_s3tc",
  "EXT_texture_compression_rgtc",
  "EXT_color_buffer_float",
  "OES_texture_float_linear",
  "EXT_float_blend",
  "EXT_texture_filter_anisotropic",
];

export function createCommandContext(canvas, device) {
  const functions = new Map(),
    queries = new Map();
  const target = {
    ...EngineFormat,
    canvas,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    frontend: null,
    stateQueries: queries,
    currentPixelPackBufferBinding: 0,
    currentPixelUnpackBufferBinding: 0,
    currentProgram: null,
    commit: undefined,
    dibvbi: null,
    disjointTimerQueryExt: null,
    extClipControl: null,
    extPolygonOffsetClamp: null,
    webglPolygonMode: null,
  };
  const object = (kind, extra = {}) => ({ kind, ...extra });
  function invoke(name, a) {
    const f = target.frontend;
    if (stateCommands.has(name)) {
      if (name === "enable" || name === "disable") {
        f.enabledCaps ??= new Set();
        if (name === "enable") f.enabledCaps.add(a[0]);
        else f.enabledCaps.delete(a[0]);
      }
      if (name === "blendFunc" || name === "blendFuncSeparate") {
        queries.set(EngineFormat.BLEND_SRC_RGB, a[0]);
        queries.set(EngineFormat.BLEND_DST_RGB, a[1]);
        queries.set(EngineFormat.BLEND_SRC_ALPHA, a[2] ?? a[0]);
        queries.set(EngineFormat.BLEND_DST_ALPHA, a[3] ?? a[1]);
      }
      if (name === "blendEquation" || name === "blendEquationSeparate") {
        queries.set(EngineFormat.BLEND_EQUATION_RGB, a[0]);
        queries.set(EngineFormat.BLEND_EQUATION_ALPHA, a[1] ?? a[0]);
      }
      if (name === "colorMask") queries.set(EngineFormat.COLOR_WRITEMASK, [...a]);
      if (name === "pixelStorei") queries.set(a[0], a[1]);
      return;
    }
    if (name.startsWith("uniform")) return;
    if (
      name.startsWith("create") &&
      !["createShader", "createProgram"].includes(name)
    )
      return object(name.slice(6));
    if (name.startsWith("delete")) {
      if (a[0]) a[0].deleted = true;
      return;
    }
    switch (name) {
      case "fenceSync": {
        f.flush();
        const sync = object("Sync", { signaled: false });
        device.queue.onSubmittedWorkDone().then(() => (sync.signaled = true));
        return sync;
      }
      case "clientWaitSync":
        if (a[1] & EngineFormat.SYNC_FLUSH_COMMANDS_BIT) f.flush();
        return a[0].signaled ? EngineFormat.ALREADY_SIGNALED : EngineFormat.TIMEOUT_EXPIRED;
      case "waitSync":
        return; // one ordered WebGPU queue; GPU waits are implicit
      case "getSyncParameter":
        return a[1] === EngineFormat.SYNC_STATUS
          ? a[0].signaled
            ? EngineFormat.SIGNALED
            : EngineFormat.UNSIGNALED
          : a[1] === EngineFormat.SYNC_CONDITION
            ? EngineFormat.SYNC_GPU_COMMANDS_COMPLETE
            : a[1] === EngineFormat.OBJECT_TYPE
              ? EngineFormat.SYNC_FENCE
              : 0;
      case "isContextLost":
        return false;
      case "getContextAttributes":
        return { alpha: false, depth: true, stencil: true, antialias: false };
      case "getError":
        return 0;
      case "getSupportedExtensions":
        return extensions;
      case "getExtension":
        return extensions.includes(a[0])
          ? {
              ...EngineFormat,
              MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
              TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
            }
          : null;
      case "getShaderPrecisionFormat":
        return { rangeMin: 127, rangeMax: 127, precision: 23 };
      case "createShader":
        return object("Shader", { type: a[0], source: "", compiled: false });
      case "shaderSource":
        a[0].source = a[1];
        return;
      case "compileShader":
        a[0].compiled = true;
        return; // compilation/link validation occurs together in the compiler service
      case "getShaderSource":
        return a[0].source;
      case "getShaderInfoLog":
        return a[0].log || "";
      case "getShaderParameter":
        return a[1] === EngineFormat.SHADER_TYPE
          ? a[0].type
          : a[1] === EngineFormat.DELETE_STATUS
            ? !!a[0].deleted
            : a[0].compiled;
      case "createProgram":
        return object("Program", {
          shaders: [],
          bindings: new Map(),
          linked: false,
        });
      case "attachShader":
        a[0].shaders.push(a[1]);
        return;
      case "detachShader":
        a[0].shaders = a[0].shaders.filter((s) => s !== a[1]);
        return;
      case "bindAttribLocation":
        a[0].bindings.set(a[2], a[1]);
        return;
      case "getAttachedShaders":
        return a[0].shaders;
      case "linkProgram": {
        const p = a[0],
          sources = Object.fromEntries(
            p.shaders.map((s) => [
              s.type === EngineFormat.VERTEX_SHADER ? "vert" : "frag",
              s.source,
            ]),
          );
        const request = {
          sources,
          attributes: [...p.bindings].map(([name, location]) => ({
            name,
            location,
          })),
        };
        const key = shaderKey(request);
        const xhr = new XMLHttpRequest();
        xhr.open(
          "GET",
          new URL("./shaders/" + key + ".json", import.meta.url),
          false,
        );
        xhr.send();
        p.linked = xhr.status === 200;
        if (p.linked) p.meta = JSON.parse(xhr.responseText);
        else {
          p.log =
            "Missing packaged shader " +
            key +
            ". This game/settings combination is not included in this build.";
          throw Error(p.log);
        }
        return;
      }
      case "validateProgram":
        return;
      case "getProgramInfoLog":
        return a[0].log || "";
      case "getProgramParameter": {
        const p = a[0];
        switch (a[1]) {
          case EngineFormat.LINK_STATUS:
          case EngineFormat.VALIDATE_STATUS:
            return p.linked;
          case EngineFormat.DELETE_STATUS:
            return !!p.deleted;
          case EngineFormat.ATTACHED_SHADERS:
            return p.shaders.length;
          case EngineFormat.ACTIVE_ATTRIBUTES:
            return p.meta?.attributes.length || 0;
          case EngineFormat.ACTIVE_UNIFORMS:
            return p.meta?.activeUniforms.length || 0;
          case EngineFormat.ACTIVE_UNIFORM_BLOCKS:
            return 0;
          default:
            throw Error("Unsupported program query " + a[1]);
        }
      }
      case "getActiveAttrib":
        return a[0].meta.attributes[a[1]];
      case "getAttribLocation":
        return (
          a[0].meta.attributes.find((x) => x.name === a[1])?.location ?? -1
        );
      case "getActiveUniform":
        return a[0].meta.activeUniforms[a[1]];
      case "getUniformLocation": {
        const base = a[1].replace(/\[\d+\]$/, "");
        return a[0].meta.activeUniforms.some(
          (u) => u.name.replace(/\[0\]$/, "") === base,
        )
          ? object("Uniform", { program: a[0], name: a[1] })
          : null;
      }
      case "getFragDataLocation":
        return Number(a[1].match(/\d+$/)?.[0] || 0);
      case "checkFramebufferStatus":
        return EngineFormat.FRAMEBUFFER_COMPLETE;
      case "getBufferParameter":
        return f.info(f.boundBuffers.get(a[0]))?.size || 0;
      case "getTexParameter":
        return f.textureInfo(a[0])?.params?.get(a[1]) ?? 0;
      case "getSamplerParameter":
        return f.info(a[0])?.params?.get(a[1]) ?? 0;
      case "isEnabled":
        return f.enabledCaps?.has(a[0]) || false;
      case "getParameter": {
        if (queries.has(a[0])) return queries.get(a[0]);
        const limits = device.limits;
        const values = {
          [EngineFormat.VERSION]: "WebGL 2.0 ABI on WebGPU",
          [EngineFormat.SHADING_LANGUAGE_VERSION]:
            "WebGL GLSL ES 3.00 (offline WGSL translation)",
          [EngineFormat.VENDOR]: "WebGPU",
          [EngineFormat.RENDERER]: "X-Ray GPU-only WebGPU",
          [EngineFormat.MAX_TEXTURE_SIZE]: limits.maxTextureDimension2D,
          [EngineFormat.MAX_CUBE_MAP_TEXTURE_SIZE]: limits.maxTextureDimension2D,
          [EngineFormat.MAX_3D_TEXTURE_SIZE]: limits.maxTextureDimension3D,
          [EngineFormat.MAX_ARRAY_TEXTURE_LAYERS]: limits.maxTextureArrayLayers,
          [EngineFormat.MAX_VERTEX_ATTRIBS]: 16,
          [EngineFormat.MAX_VERTEX_UNIFORM_VECTORS]: 1024,
          [EngineFormat.MAX_FRAGMENT_UNIFORM_VECTORS]: 1024,
          [EngineFormat.MAX_VERTEX_UNIFORM_COMPONENTS]: 4096,
          [EngineFormat.MAX_FRAGMENT_UNIFORM_COMPONENTS]: 4096,
          [EngineFormat.MAX_VARYING_VECTORS]: 16,
          [EngineFormat.MAX_VARYING_COMPONENTS]: 64,
          [EngineFormat.MAX_VERTEX_TEXTURE_IMAGE_UNITS]: 16,
          [EngineFormat.MAX_TEXTURE_IMAGE_UNITS]: 16,
          [EngineFormat.MAX_COMBINED_TEXTURE_IMAGE_UNITS]: 32,
          [EngineFormat.MAX_DRAW_BUFFERS]: 8,
          [EngineFormat.MAX_COLOR_ATTACHMENTS]: 8,
          [EngineFormat.MAX_RENDERBUFFER_SIZE]: limits.maxTextureDimension2D,
          [EngineFormat.MAX_SAMPLES]: 1,
          [EngineFormat.SAMPLES]: 0,
          [EngineFormat.SAMPLE_BUFFERS]: 0,
          [EngineFormat.RED_BITS]: 8,
          [EngineFormat.GREEN_BITS]: 8,
          [EngineFormat.BLUE_BITS]: 8,
          [EngineFormat.ALPHA_BITS]: 8,
          [EngineFormat.DEPTH_BITS]: 24,
          [EngineFormat.STENCIL_BITS]: 8,
          [EngineFormat.COMPRESSED_TEXTURE_FORMATS]: new Uint32Array([
            0x83f0, 0x83f1, 0x83f2, 0x83f3, 0x8dbb, 0x8dbd,
          ]),
          [EngineFormat.ALIASED_LINE_WIDTH_RANGE]: new Float32Array([1, 1]),
          [EngineFormat.ALIASED_POINT_SIZE_RANGE]: new Float32Array([1, 1]),
          [EngineFormat.MAX_VIEWPORT_DIMS]: new Int32Array([
            limits.maxTextureDimension2D,
            limits.maxTextureDimension2D,
          ]),
          [EngineFormat.VIEWPORT]: new Int32Array(
            f?.state.viewport || [0, 0, canvas.width, canvas.height],
          ),
          [EngineFormat.SCISSOR_BOX]: new Int32Array(
            f?.state.scissorRect || [0, 0, canvas.width, canvas.height],
          ),
          [EngineFormat.VERTEX_ARRAY_BINDING]: f?.vaoObject,
          [EngineFormat.SAMPLER_BINDING]: f?.samplers[f.activeUnit],
          [EngineFormat.BLEND_SRC_RGB]: EngineFormat.ONE,
          [EngineFormat.BLEND_SRC_ALPHA]: EngineFormat.ONE,
          [EngineFormat.BLEND_DST_RGB]: EngineFormat.ZERO,
          [EngineFormat.BLEND_DST_ALPHA]: EngineFormat.ZERO,
          [EngineFormat.BLEND_EQUATION_RGB]: EngineFormat.FUNC_ADD,
          [EngineFormat.BLEND_EQUATION_ALPHA]: EngineFormat.FUNC_ADD,
          [EngineFormat.COLOR_WRITEMASK]: [true, true, true, true],
          [EngineFormat.DEPTH_WRITEMASK]: f?.state.depthWrite,
          [EngineFormat.DEPTH_CLEAR_VALUE]: f?.state.clearDepth,
          [EngineFormat.ACTIVE_TEXTURE]: EngineFormat.TEXTURE0 + (f?.activeUnit || 0),
          [EngineFormat.CURRENT_PROGRAM]: f?.program,
          [EngineFormat.FRAMEBUFFER_BINDING]: f?.fbo,
          [EngineFormat.READ_FRAMEBUFFER_BINDING]: f?.readFbo,
          [EngineFormat.PIXEL_PACK_BUFFER_BINDING]: f?.boundBuffers.get(
            EngineFormat.PIXEL_PACK_BUFFER,
          ),
          [EngineFormat.PIXEL_UNPACK_BUFFER_BINDING]: f?.boundBuffers.get(
            EngineFormat.PIXEL_UNPACK_BUFFER,
          ),
          [EngineFormat.ARRAY_BUFFER_BINDING]: f?.boundBuffers.get(EngineFormat.ARRAY_BUFFER),
          [EngineFormat.ELEMENT_ARRAY_BUFFER_BINDING]: f?.vao.element,
          [EngineFormat.TEXTURE_BINDING_2D]: f?.textures[f.activeUnit].get(EngineFormat.TEXTURE_2D),
          [EngineFormat.TEXTURE_BINDING_CUBE_MAP]: f?.textures[f.activeUnit].get(
            EngineFormat.TEXTURE_CUBE_MAP,
          ),
          [EngineFormat.UNPACK_ALIGNMENT]: 4,
          [EngineFormat.PACK_ALIGNMENT]: 4,
          [0x84ff]: 16,
        };
        if (a[0] in values) return values[a[0]] ?? null;
        throw Error(
          "Unsupported renderer capability query 0x" + a[0].toString(16),
        );
      }
      default:
        if (name.startsWith("is")) return !!a[0] && !a[0].deleted;
        throw Error("Unimplemented engine rendering command " + name);
    }
  }
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (typeof key !== "string" || !methods.has(key)) return undefined;
      if (!functions.has(key))
        functions.set(key, (...args) => invoke(key, args));
      return functions.get(key);
    },
  });
}

