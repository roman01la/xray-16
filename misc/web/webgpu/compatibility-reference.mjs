// Test-only reference for equivalence checks against the removed GLES facade.
// Not imported by the renderer or included in the browser distribution.
import { GPUFrontend } from './backend.js';
import { EngineFormat } from './engine-formats.js';
import { frontendOnlyCommands } from './command-context.js';
const profileEnabled=false, profile={}, diagnostics={glesCompatibilityCalls:0,legacyDraws:0};
const pipelineStateCommands = new Set(`enable disable depthMask depthFunc colorMask blendFunc blendFuncSeparate blendEquation blendEquationSeparate cullFace frontFace polygonOffset stencilFunc stencilFuncSeparate stencilOp stencilOpSeparate stencilMask`.split(" "));
const passBatchBarriers = new Set(`bindFramebuffer framebufferTexture2D framebufferTextureLayer drawBuffers readBuffer blitFramebuffer copyTexSubImage2D readPixels checkFramebufferStatus getFramebufferAttachmentParameter deleteFramebuffer deleteTexture beginQuery`.split(" "));
const stateBatchBarriers = new Set([...pipelineStateCommands, ...passBatchBarriers, "scissor", "viewport", "depthRange", "getParameter", "isEnabled"]);
const bindingBatchBarriers = new Set(`activeTexture bindTexture bindSampler samplerParameteri samplerParameterf texParameteri texParameterf texStorage2D texStorage3D texImage2D texImage3D texSubImage2D texSubImage3D compressedTexImage2D compressedTexImage3D compressedTexSubImage2D compressedTexSubImage3D copyTexImage2D copyTexSubImage2D copyTexSubImage3D generateMipmap getParameter getTexParameter getSamplerParameter deleteTexture deleteSampler`.split(" "));
export class CompatibilityReference extends GPUFrontend {
  attr(n) {
    if (!this.vao.attrs.has(n))
      this.vao.attrs.set(n, { enabled: false, divisor: 0 });
    return this.vao.attrs.get(n);
  }
  textureInfo(target) {
    const g = EngineFormat;
    return this.info(
      this.textures[this.activeUnit].get(
        target >= g.TEXTURE_CUBE_MAP_POSITIVE_X &&
          target <= g.TEXTURE_CUBE_MAP_NEGATIVE_Z
          ? g.TEXTURE_CUBE_MAP
          : target,
      ),
    );
  }
  image2D(a) {
    if (a.length < 9) throw Error("DOM image upload not supported in worker");
    const g = EngineFormat,
      i = this.textureInfo(a[0]);
    if (!i.gpu) this.allocateTexture([a[0], 1, a[2], a[3], a[4]], false);
    if (a[8])
      this.uploadTexture(
        [a[0], a[1], 0, 0, a[3], a[4], a[6], a[7], a[8]],
        false,
        false,
      );
  }
  bufferData(a, i = this.info(this.boundBuffers.get(a[0]))) { return super.bufferData(a, i); }
  bufferSubData(a, i = this.info(this.boundBuffers.get(a[0]))) { return super.bufferSubData(a, i); }
  allocateTexture(a, is3, i = this.textureInfo(a[0])) { return super.allocateTexture(a, is3, i); }
  uploadTexture(a, is3, compressed, i = this.textureInfo(a[0])) { return super.uploadTexture(a, is3, compressed, i); }
  consumeBindingBatch(words, start, length, textures, samplers) {
    super.consumeBindingBatch(words, start, length, textures, samplers);
    // Only the old test interpreter has implicit active-unit semantics.
    for (let n = start; n < start + length; n += 4)
      if (words[n] !== 1) this.activeUnit = words[n+1];
  }
  call(name, a) {
    diagnostics.glesCompatibilityCalls++;
    if (this.nativeOnly) throw Error("GLES compatibility call in native-only renderer: " + name);
    if (bindingBatchBarriers.has(name)) this.flushNativeBindings?.();
    if (stateBatchBarriers.has(name)) this.flushNativeStates?.();
    const g = this.gl;
    if (
      name === "drawElements" ||
      name === "drawArrays" ||
      name === "drawElementsInstancedBaseVertexBaseInstanceWEBGL" ||
      name === "drawElementsInstanced" ||
      name === "drawArraysInstanced"
    )
      return this.draw(name, a);
    if (name.startsWith("uniform")) {
      this.flushNativeUniforms?.();
      if (a[0]) this.setUniform(name, a);
      return;
    }
    if (name === "copyTexSubImage2D") {
      this.endPass();
      const src = this.info(this.readFbo)?.attachments?.get(
          g.COLOR_ATTACHMENT0,
        ),
        dst = this.textureInfo(a[0]);
      if (!src || !dst?.gpu) throw Error("Missing framebuffer copy texture");
      this.enc().copyTextureToTexture(
        {
          texture: this.info(src.texture).gpu,
          mipLevel: src.level,
          origin: [a[4], a[5], src.layer],
        },
        { texture: dst.gpu, mipLevel: a[1], origin: [a[2], a[3], 0] },
        [a[6], a[7], 1],
      );
      return;
    }
    if (name === "generateMipmap") {
      if (this.textureInfo(a[0])?.mips > 1)
        throw Error("Multi-level mip generation not implemented");
      return;
    }
    if (name === "drawRangeElements")
      return this.draw("drawElements", [a[0], a[3], a[4], a[5]]);
    if (name === "clear") return this.clear(a[0]);
    if (name === "blitFramebuffer") return this.blit(a);
    if (name === "flush" || name === "finish") {
      this.flush();
      return;
    }
    if (name === "getQueryParameter")
      return a[1] === g.QUERY_RESULT_AVAILABLE
        ? !!a[0].available
        : a[0].result || 0;
    if (name === "beginQuery") {
      this.occlusion.begin(this.begin(), a[1]);
      return;
    }
    if (name === "endQuery") {
      this.occlusion.end(this.pass);
      return;
    }
    if (name === "getExtension") {
      if (a[0] === "WEBGL_draw_instanced_base_vertex_base_instance")
        return (this.baseVertexExtension ??= {
          drawElementsInstancedBaseVertexBaseInstanceWEBGL: (...args) =>
            this.proxy.drawElementsInstancedBaseVertexBaseInstanceWEBGL(...args),
        });
      return g.getExtension(a[0]);
    }
    if (name === "getParameter" && a[0] === g.RENDERER)
      return "X-Ray GPU-only WebGPU renderer";
    if (name === "getParameter" && a[0] === g.VENDOR) return "WebGPU";
    // Preserve EngineFormat compilation/reflection; GPU objects are independent of these mirror objects.
    const tGL = profileEnabled ? performance.now() : 0;
    let result = frontendOnlyCommands.has(name) ? undefined : g[name](...a);
    if (profileEnabled) profile.mirror += performance.now() - tGL;
    const s = this.state;
    if (pipelineStateCommands.has(name)) this.pipelineStateKey = null;
    switch (name) {
      case "activeTexture":
        this.activeUnit = a[0] - g.TEXTURE0;
        break;
      case "bindTexture":
        if (this.textures[this.activeUnit].get(a[0]) !== a[1]) this.resourceGeneration++;
        this.textures[this.activeUnit].set(a[0], a[1]);
        if (a[1]) this.info(a[1]).target = a[0];
        break;
      case "bindSampler":
        if (this.samplers[a[0]] !== a[1]) this.resourceGeneration++;
        this.samplers[a[0]] = a[1];
        break;
      case "samplerParameteri":
      case "samplerParameterf": {
        const i = this.info(a[0]);
        (i.params ??= new Map()).set(a[1], a[2]);
        i.gpuSamplers = null;
        this.resourceGeneration++;
        break;
      }
      case "texParameteri":
      case "texParameterf": {
        const i = this.textureInfo(a[0]);
        if (i) {
          (i.params ??= new Map()).set(a[1], a[2]);
          i.gpuSamplers = null;
          this.resourceGeneration++;
        }
        break;
      }
      case "bindBuffer":
        this.boundBuffers.set(a[0], a[1]);
        if (a[0] === g.ELEMENT_ARRAY_BUFFER) this.vao.element = a[1];
        break;
      case "bufferData":
        this.bufferData(a);
        break;
      case "bufferSubData":
        this.bufferSubData(a);
        break;
      case "bindVertexArray":
        this.vaoObject = a[0];
        this.vao = a[0]
          ? (this.info(a[0]).vao ??= { attrs: new Map(), element: null })
          : this.defaultVAO;
        this.boundBuffers.set(g.ELEMENT_ARRAY_BUFFER, this.vao.element);
        break;
      case "enableVertexAttribArray":
        this.vao.revision = (this.vao.revision || 0) + 1;
        this.attr(a[0]).enabled = true;
        break;
      case "disableVertexAttribArray":
        this.vao.revision = (this.vao.revision || 0) + 1;
        this.attr(a[0]).enabled = false;
        break;
      case "vertexAttribPointer":
      case "vertexAttribIPointer": {
        this.vao.revision = (this.vao.revision || 0) + 1;
        const integer = name === "vertexAttribIPointer";
        Object.assign(this.attr(a[0]), {
          size: a[1],
          type: a[2],
          normalized: integer ? false : a[3],
          stride: a[integer ? 3 : 4],
          offset: a[integer ? 4 : 5],
          buffer: this.boundBuffers.get(g.ARRAY_BUFFER),
          integer,
        });
        break;
      }
      case "vertexAttribDivisor":
        this.vao.revision = (this.vao.revision || 0) + 1;
        this.attr(a[0]).divisor = a[1];
        break;
      case "bindFramebuffer":
        if (a[0] !== g.READ_FRAMEBUFFER) this.fbo = a[1];
        if (a[0] !== g.DRAW_FRAMEBUFFER) this.readFbo = a[1];
        break;
      case "framebufferTexture2D": {
        const f = this.info(
          a[0] === g.READ_FRAMEBUFFER ? this.readFbo : this.fbo,
        );
        f.cachedAttachments = null;
        (f.attachments ??= new Map()).set(a[1], {
          texture: a[3],
          level: a[4],
          layer:
            a[2] >= g.TEXTURE_CUBE_MAP_POSITIVE_X &&
            a[2] <= g.TEXTURE_CUBE_MAP_NEGATIVE_Z
              ? a[2] - g.TEXTURE_CUBE_MAP_POSITIVE_X
              : 0,
        });
        break;
      }
      case "framebufferTextureLayer": {
        const f = this.info(this.fbo);
        f.cachedAttachments = null;
        (f.attachments ??= new Map()).set(a[1], {
          texture: a[2],
          level: a[3],
          layer: a[4],
        });
        break;
      }
      case "drawBuffers":
        if (this.fbo) {
          this.info(this.fbo).drawBuffers = [...a[0]];
          this.info(this.fbo).cachedAttachments = null;
        }
        break;
      case "texStorage2D":
      case "texStorage3D":
        this.allocateTexture(a, name === "texStorage3D");
        break;
      case "texImage2D":
        this.image2D(a);
        break;
      case "texSubImage2D":
        this.uploadTexture(a, false, false);
        break;
      case "texSubImage3D":
        this.uploadTexture(a, true, false);
        break;
      case "compressedTexSubImage2D":
        this.uploadTexture(a, false, true);
        break;
      case "compressedTexSubImage3D":
        this.uploadTexture(a, true, true);
        break;
      case "linkProgram":
        if (g.getProgramParameter(a[0], g.LINK_STATUS)) this.link(a[0]);
        break;
      case "useProgram":
        this.program = a[0];
        break;
      case "getUniformLocation":
        if (result) this.locations.set(result, { program: a[0], name: a[1] });
        break;
      case "enable":
      case "disable": {
        const v = name === "enable";
        const k = new Map([
          [g.DEPTH_TEST, "depthTest"],
          [g.BLEND, "blend"],
          [g.CULL_FACE, "cull"],
          [g.STENCIL_TEST, "stencil"],
          [g.SCISSOR_TEST, "scissor"],
          [g.POLYGON_OFFSET_FILL, "polygonOffset"],
        ]).get(a[0]);
        if (k) s[k] = v;
        break;
      }
      case "depthMask":
        s.depthWrite = a[0];
        break;
      case "depthFunc":
        s.depthFunc = this.compare(a[0]);
        break;
      case "depthRange":
        s.depthRange = [...a];
        break;
      case "colorMask":
        s.colorMask = a.reduce((m, v, i) => m | (v ? 1 << i : 0), 0);
        break;
      case "blendFunc":
        s.blendSrc = s.blendSrcA = this.factor(a[0]);
        s.blendDst = s.blendDstA = this.factor(a[1]);
        break;
      case "blendFuncSeparate":
        [s.blendSrc, s.blendDst, s.blendSrcA, s.blendDstA] = a.map((x) =>
          this.factor(x),
        );
        break;
      case "blendEquation":
        s.blendOp = s.blendOpA = this.operation(a[0]);
        break;
      case "blendEquationSeparate":
        [s.blendOp, s.blendOpA] = a.map((x) => this.operation(x));
        break;
      case "blendColor":
        s.blendColor = [...a];
        break;
      case "cullFace":
        s.cullFace =
          a[0] === g.FRONT ? "front" : a[0] === g.BACK ? "back" : "both";
        break;
      case "frontFace":
        s.frontFace = a[0] === g.CCW ? "ccw" : "cw";
        break;
      case "viewport":
        s.viewport = [...a];
        break;
      case "scissor":
        s.scissorRect = [...a];
        break;
      case "clearColor":
        s.clearColor = [...a];
        break;
      case "clearDepth":
        s.clearDepth = a[0];
        break;
      case "clearStencil":
        s.clearStencil = a[0];
        break;
      case "polygonOffset":
        [s.slope, s.bias] = a;
        break;
      case "stencilFunc":
        s.stencilFront.compare = s.stencilBack.compare = this.compare(a[0]);
        s.stencilRef = a[1];
        s.stencilReadMask = a[2];
        break;
      case "stencilFuncSeparate": {
        const list =
          a[0] === g.FRONT
            ? [s.stencilFront]
            : a[0] === g.BACK
              ? [s.stencilBack]
              : [s.stencilFront, s.stencilBack];
        for (const f of list) f.compare = this.compare(a[1]);
        s.stencilRef = a[2];
        s.stencilReadMask = a[3];
        break;
      }
      case "stencilOp":
        for (const f of [s.stencilFront, s.stencilBack])
          Object.assign(f, {
            failOp: this.stencilOp(a[0]),
            depthFailOp: this.stencilOp(a[1]),
            passOp: this.stencilOp(a[2]),
          });
        break;
      case "stencilOpSeparate": {
        const list =
          a[0] === g.FRONT
            ? [s.stencilFront]
            : a[0] === g.BACK
              ? [s.stencilBack]
              : [s.stencilFront, s.stencilBack];
        for (const f of list)
          Object.assign(f, {
            failOp: this.stencilOp(a[1]),
            depthFailOp: this.stencilOp(a[2]),
            passOp: this.stencilOp(a[3]),
          });
        break;
      }
      case "stencilMask":
        s.stencilMask = a[0];
        break;
      case "deleteFramebuffer":
        if (this.fbo === a[0]) this.fbo = null;
        if (this.readFbo === a[0]) this.readFbo = null;
        break;
      case "deleteSampler":
        for (let unit = 0; unit < this.samplers.length; unit++)
          if (this.samplers[unit] === a[0]) { this.samplers[unit] = null; this.resourceGeneration++; }
        break;
      case "deleteTexture":
        for (const bindings of this.textures)
          for (const [target, token] of bindings)
            if (token === a[0]) { bindings.set(target, null); this.resourceGeneration++; }
        // fall through: submit earlier draws before destroying their resource.
      case "deleteBuffer":
        this.flush();
        this.info(a[0])?.gpu?.destroy();
        break;
    }
    if (name.startsWith("uniform") && a[0]) this.setUniform(name, a);
    return result;
  }
  draw(name, a) {
    this.flushNativeBindings?.();
    this.flushNativeStates?.();
    this.flushNativeUniforms?.();
    diagnostics.legacyDraws++;
    const indexed = name.includes("Elements");
    const indexFormat = indexed ? (a[2] === EngineFormat.UNSIGNED_INT ? "uint32" : "uint16") : undefined;
    const base = name === "drawElementsInstancedBaseVertexBaseInstanceWEBGL";
    return this.encodeDraw(this.programs.get(this.program), this.vao, a[0], indexFormat,
      a[indexed ? 1 : 2], name.includes("Instanced") ? a[indexed ? 4 : 3] : 1,
      indexed ? Number(a[3]) / (indexFormat === "uint32" ? 4 : 2) : a[1], base ? a[5] : 0, base ? a[6] : 0);
  }
}
