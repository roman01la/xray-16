import { initializeShaderCompilerClient } from "./shader-compiler-client.mjs";
import { installNativeQueues } from "./native-queue.js";
import { validateNativeGPU } from "./native-selftest.js";
import { beginNativeUIList, drawNativeUI, endNativeUIList } from "./native-imgui.js";
import { clearNativeRects } from "./native-clear.js";
import { createNativeHandles, allocateHandle, loadNativeProgram, nativeUniformLocation, nativeSamplerParameter, deleteNativeObject } from "./native-runtime.js";
import { EngineFormat } from "./engine-formats.js";
import { OcclusionQueries } from "./occlusion.js";
import { specializeVertex } from "./vertex-conversion.js";
import { activeBindings } from "./reflection.mjs";
// GPU-only X-Ray renderer. The existing engine command ABI terminates here.
// Shader reflection comes from the shared compiler/cache; resources are owned by this renderer.
// Draws, uploads, queries, readback and presentation are submitted to WebGPU.
// Values match the engine D3D state enums (shared renderer state semantics).
const nativeCompare = [null, "never", "less", "equal", "less-equal", "greater", "not-equal", "greater-equal", "always"];
const nativeStencil = [null, "keep", "zero", "replace", "increment-clamp", "decrement-clamp", "invert", "increment-wrap", "decrement-wrap"];
const nativeFactor = [null, "zero", "one", "src", "one-minus-src", "src-alpha", "one-minus-src-alpha", "dst-alpha", "one-minus-dst-alpha", "dst", "one-minus-dst", "src-alpha-saturated"];
const nativeBlendOp = [null, "add", "subtract", "reverse-subtract", "min", "max"];
// Resource updates observe queued native bindings.
let installed = false,
  lastReport = 0,
  lastReportFrames = 0;
let phaseProfileEnabled = false;
let profileEnabled = false,
  benchmark = null;
const profile = { calls: 0, cpu: 0, mirror: 0, submits: 0 };
let telemetryChannel, telemetryAdapter;
let lastTelemetryPresent, maxFrameMs = 0;
const diagnostics = { streamSnapshots: 0, streamBufferAllocations: 0, renderPasses: 0, drawBatches: 0, nativeOnly: false, frames: 0, draws: 0, directDraws: 0, nativeTextureAllocations: 0, nativeTextureUploads: 0, nativeBufferUploads: 0, nativeQueries: 0, nativeTextureCopies: 0, nativeProgramSelections: 0, nativeVertexSelections: 0, nativePassRecords: 0, nativeClears: 0, nativePresents: 0, bindingBatches: 0, bindingRecords: 0, stateBatches: 0, stateRecords: 0, uniformBatches: 0, uniformRecords: 0, uniformBytesCopied: 0, uniformReuses: 0, preparedHits: 0, preparedMisses: 0, materialHits: 0, validationErrors: 0, lastError: "" };
const channel =
  typeof WorkerGlobalScope !== "undefined" &&
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("xray-webgpu")
    : null;
channel?.addEventListener("message", ({ data }) => {
  if (data.command === "native-selftest" && globalThis.__xrayWebGPU) validateNativeGPU(globalThis.__xrayWebGPU)
    .then(nativeSelfTest => channel.postMessage({nativeSelfTest}))
    .catch(error => channel.postMessage({nativeSelfTest:{passed:false,error:String(error.stack||error)}}));
  if (data.command === "profile") {
    phaseProfileEnabled = !!data.enabled;
    profileEnabled = !!data.enabled && !data.phasesOnly;
  }
  if (data.command === "benchmark") {
    profileEnabled = phaseProfileEnabled = false;
    benchmark = {
      id: data.id,
      duration: data.durationMs || 30000,
      start: 0,
      last: 0,
      times: [],
    };
  }
});
export async function installWebGPUBackend(shaderCompilerPort, gpuDiagnosticsChannel) {
  if (
    installed ||
    typeof WorkerGlobalScope === "undefined" ||
    globalThis.name !== "em-pthread"
  )
    return;
  installed = true;
  await initializeShaderCompilerClient(shaderCompilerPort);
  addEventListener("error", event => channel?.postMessage({lastError: event.error?.stack || event.message}));
  addEventListener("unhandledrejection", event => channel?.postMessage({lastError: String(event.reason?.stack || event.reason)}));
  channel?.postMessage({ status: "requesting GPU adapter" });
  if (!navigator.gpu) throw Error("WebGPU is unavailable in this worker");
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw Error("No WebGPU adapter");
  const features = [
    "texture-compression-bc",
    "texture-compression-bc-sliced-3d",
    "float32-filterable",
    "timestamp-query",
  ].filter((f) => adapter.features.has(f));
  channel?.postMessage({ status: "requesting GPU device" });
  const device = await adapter.requestDevice({
    requiredFeatures: features,
    requiredLimits: {
      maxVertexBuffers: Math.min(16, adapter.limits.maxVertexBuffers),
      maxVertexAttributes: Math.min(16, adapter.limits.maxVertexAttributes),
      maxBufferSize: Math.min(1 << 29, adapter.limits.maxBufferSize),
      maxStorageBufferBindingSize: Math.min(
        1 << 27,
        adapter.limits.maxStorageBufferBindingSize,
      ),
    },
  });
  channel?.postMessage({ status: "GPU device ready" });
  device.addEventListener("uncapturederror", (e) => {
    diagnostics.validationErrors++;
    diagnostics.lastError = e.error.message;
    channel?.postMessage(diagnostics);
    console.error("[WebGPU validation]", e.error.message);
  });
  device.lost.then((info) => {
    channel?.postMessage({ status: "GPU device lost: " + info.message });
    console.error("[WebGPU device lost]", info.message);
  });
  const getContext = OffscreenCanvas.prototype.getContext;
  OffscreenCanvas.prototype.getContext = function(type, options) {
    if (!["webgpu", "2d", "bitmaprenderer"].includes(type))
      throw Error("Unsupported canvas context in native renderer: " + type);
    return getContext.call(this, type, options);
  };
  globalThis.__initializeNativeWebGPU = canvas => {
    if (globalThis.__xrayWebGPU) return globalThis.__xrayWebGPU;
    if (gpuDiagnosticsChannel) {
      telemetryChannel = new BroadcastChannel(gpuDiagnosticsChannel.name);
      if (gpuDiagnosticsChannel.detailed) {
        const info = adapter.info;
        telemetryAdapter = {
          vendor: info?.vendor, architecture: info?.architecture, device: info?.device,
          fallback: info?.isFallbackAdapter ?? adapter.isFallbackAdapter,
        };
      }
    }
    const renderer = new GPUFrontend(canvas, device, canvas.getContext("webgpu"));
    renderer.nativeOnly = diagnostics.nativeOnly = true;
    renderer.handles = globalThis.__xrayWebGPUHandles = createNativeHandles();
    globalThis.__xrayWebGPU = renderer;
    return renderer;
  };

}
const align = (v, n = 4) => Math.ceil(v / n) * n;
export class GPUFrontend {
  constructor(canvas, device, context) {
    Object.assign(this, { canvas, device, context });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    this.objects = new WeakMap();
    this.programs = new WeakMap();
    this.locations = new WeakMap();
    this.ids = new WeakMap();
    this.nextId = 1;
    this.bufferGeneration = 0;
    this.resourceGeneration = 0;
    this.textures = Array.from({ length: 32 }, () => new Map());
    this.samplers = Array(32).fill(null);
    this.defaultVAO = { attrs: new Map(), element: null };
    this.vao = this.defaultVAO;
    this.fbo = null;
    this.readFbo = null;
    this.program = null;
    this.state = {
      depthTest: false,
      depthWrite: true,
      depthFunc: "less",
      blend: false,
      blendSrc: "one",
      blendDst: "zero",
      blendSrcA: "one",
      blendDstA: "zero",
      blendOp: "add",
      blendOpA: "add",
      cull: false,
      cullFace: "back",
      frontFace: "ccw",
      stencil: false,
      stencilFront: {},
      stencilBack: {},
      stencilMask: 255,
      stencilRef: 0,
      colorMask: 15,
      scissor: false,
      viewport: [0, 0, canvas.width, canvas.height],
      scissorRect: [0, 0, canvas.width, canvas.height],
      depthRange: [0, 1],
      clearColor: [0, 0, 0, 0],
      clearDepth: 1,
      clearStencil: 0,
      blendColor: [0, 0, 0, 0],
      polygonOffset: false,
      bias: 0,
      slope: 0,
    };
    this.occlusion = new OcclusionQueries(device);
    if (device.features.has("timestamp-query")) {
      this.timer = {
        set: device.createQuerySet({ type: "timestamp", count: 2 }),
        resolve: device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
        read: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        busy: false, active: false, ms: 0,
      };
    }
    this.encoder = null;
    this.pass = null;
    this.passKey = "";
    this.pipelineCache = new Map();
    this.samplerCache = new Map();
    this.preparedEnabled = true;
    this.uniformEpoch = 0;
    this.uniformOffset = 0;
    this.uniformBuffer = device.createBuffer({
      label: "X-Ray uniform arena",
      size: 32 << 20,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.uniformStaging = new Uint8Array(this.uniformBuffer.size);
    this.uniformUploaded = 0;
    this.retired = [];
    this.streamPool = new Map();
    this.streamRetired = [];

  }
  configureNativeQueues(heap, pointers, handles) { installNativeQueues(this, heap, pointers, handles, () => diagnostics.drawBatches++); }
  // Engine CStatTimer results are decaying peaks, not additive per-frame averages.
  // They are gathered only while the engine rs_stats overlay is enabled.
  recordSubsystemTimings(objectsMs, aiThinkMs, aiVisionMs, luaGCms, activeObjects, totalObjects) {
    this.subsystemStats = { objectsMs, aiThinkMs, aiVisionMs, luaGCms, activeObjects, totalObjects };
  }
  recordEngineTimings(simulation, render, wait, vsync, limitMs) {
    if (!phaseProfileEnabled && !telemetryAdapter) return;
    const e = (this.engineProfile ??= { count: 0, simulation: 0, render: 0, wait: 0 });
    e.count++; e.simulation += simulation; e.render += render; e.wait += wait;
    if (telemetryAdapter) this.framePacing = {vsync: !!vsync, limitMs};
  }
  id(o) {
    if (!o) return 0;
    if (!this.ids.has(o)) this.ids.set(o, this.nextId++);
    return this.ids.get(o);
  }
  info(o) {
    if (!o) return null;
    if (!this.objects.has(o)) this.objects.set(o, {});
    return this.objects.get(o);
  }
  endPass() {
    if (this.pass) {
      this.occlusion.suspend(this.pass);
      this.pass.end();
      this.pass = null;
      this.passKey = "";
    }
  }
  flush() {
    this.endPass();
    if (this.encoder) {
      if (this.uniformOffset > this.uniformUploaded) {
        this.device.queue.writeBuffer(
          this.uniformBuffer,
          this.uniformUploaded,
          this.uniformStaging.subarray(
            this.uniformUploaded,
            this.uniformOffset,
          ),
        );
        this.uniformUploaded = this.uniformOffset;
      }
      profile.submits++;
      this.device.queue.submit([this.encoder.finish()]);
      for (const buffer of this.retired) buffer.destroy();
      this.retired.length = 0;
      for (const slot of this.streamRetired) {
        const free = this.streamPool.get(slot.size) || [];
        if (free.length < 256 && (this.streamPoolBytes || 0) + slot.size <= 64*1024*1024) {
          free.push(slot); this.streamPool.set(slot.size, free); this.streamPoolBytes=(this.streamPoolBytes || 0)+slot.size;
        }
        else slot.gpu.destroy();
      }
      this.streamRetired.length = 0;
      this.encoder = null;
    }
  }
  enc() {
    return (this.encoder ??= this.device.createCommandEncoder());
  }
  // Slots are recycled only after their last consuming command buffer is submitted.
  // queue.writeBuffer snapshots CPU bytes, and later writes follow that submission.
  streamSnapshot(i, bytes) {
    this.streamPool ??= new Map(); this.streamRetired ??= [];
    if (i.streamSlot) this.streamRetired.push(i.streamSlot);
    else if (i.gpu) this.retired.push(i.gpu);
    const size = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, bytes.length))));
    const free = this.streamPool.get(size);
    if (!free?.length) diagnostics.streamBufferAllocations++;
    else this.streamPoolBytes=(this.streamPoolBytes || 0)-size;
    const slot = free?.pop() || {size, gpu: this.device.createBuffer({size,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})};
    if (!free?.length) this.streamPool.delete(size);
    i.streamSlot = slot; i.gpu = slot.gpu;
    if (bytes.length) this.device.queue.writeBuffer(i.gpu, 0, bytes);
    diagnostics.streamSnapshots++;
  }
  bufferData(a, i) {
    if (!i) throw Error("Missing native buffer storage");
    const data = a[1];
    if (typeof data === "number") {
      if (i.gpu && i.size === align(data)) { i.highWater = 0; return; }
      if (i.streamSlot) this.streamRetired.push(i.streamSlot);
      else if(i.gpu) this.retired.push(i.gpu);
      i.streamSlot = null;
      i.size = align(data); i.highWater = 0; i.cpu = new Uint8Array(i.size);
      i.gpu = this.device.createBuffer({size: Math.max(4,i.size),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
      return;
    }
    const source = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer,
      data.byteOffset + (a[3] || 0) * (data.BYTES_PER_ELEMENT || 1),
      (a[4] ?? data.length - (a[3] || 0)) * (data.BYTES_PER_ELEMENT || 1));
    const size = align(source.length), dynamic = !!i.gpu;
    if (!i.cpu || i.cpu.length < size) i.cpu = new Uint8Array(size);
    i.cpu.set(source); i.cpu.fill(0,source.length,size); i.size = size; i.highWater = size;
    if (dynamic) this.streamSnapshot(i, i.cpu.subarray(0,size));
    else {
      i.gpu = this.device.createBuffer({size: Math.max(4,size),
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
      if (size) this.device.queue.writeBuffer(i.gpu,0,i.cpu.subarray(0,size));
    }
  }
  bufferSubData(a, i) {
    if (!i?.gpu) throw Error("Missing native sub-buffer storage");
    const data = a[2], offset = a[3] || 0, count = a[4] ?? data.length-offset;
    const bytes = new Uint8Array(data.buffer ?? data,(data.byteOffset || 0)+offset*(data.BYTES_PER_ELEMENT || 1),count*(data.BYTES_PER_ELEMENT || 1));
    i.cpu.set(bytes,a[1]);
    i.highWater = Math.max(i.highWater || 0,align(a[1]+bytes.length));
    this.streamSnapshot(i,i.cpu.subarray(0,i.highWater));
  }
  formatFor(f) {
    const g = EngineFormat;
    const formats = new Map([
      [g.RGBA8, "rgba8unorm"],
      [g.RGBA, "rgba8unorm"],
      [g.RGB8, "rgba8unorm"],
      [g.RGB565, "rgba8unorm"],
      [g.RGB, "rgba8unorm"],
      [g.SRGB8_ALPHA8, "rgba8unorm-srgb"],
      [g.R8, "r8unorm"],
      [g.RG8, "rg8unorm"],
      [g.RGBA16F, "rgba16float"],
      [g.RGBA32F, "rgba32float"],
      [g.R16F, "r16float"],
      [g.R32F, "r32float"],
      [g.RG16F, "rg16float"],
      [g.RG32F, "rg32float"],
      [g.DEPTH_COMPONENT16, "depth16unorm"],
      [g.DEPTH_COMPONENT24, "depth24plus"],
      [g.DEPTH_COMPONENT32F, "depth32float"],
      [g.DEPTH24_STENCIL8, "depth24plus-stencil8"],
      [g.DEPTH32F_STENCIL8, "depth32float-stencil8"],
      [0x83f0, "bc1-rgba-unorm"],
      [0x83f1, "bc1-rgba-unorm"],
      [0x83f2, "bc2-rgba-unorm"],
      [0x83f3, "bc3-rgba-unorm"],
      [0x8dbb, "bc4-r-unorm"],
      [0x8dbd, "bc5-rg-unorm"],
    ]);
    const v = formats.get(f);
    if (!v)
      throw Error("Unsupported WebGPU texture format 0x" + f.toString(16));
    return v;
  }
  allocateTexture(a, is3, i) {
    this.textureStorageGeneration = (this.textureStorageGeneration || 0) + 1;
    const g = EngineFormat;
    if (!i) return;
    this.flush();
    i.gpu?.destroy();
    i.format = this.formatFor(a[2]);
    i.width = a[3];
    i.height = a[4];
    i.depth = is3 ? a[5] : a[0] === g.TEXTURE_CUBE_MAP ? 6 : 1;
    i.mips = a[1];
    i.dimension = a[0] === g.TEXTURE_3D ? "3d" : "2d";
    i.compressed = i.format.startsWith("bc");
    i.block = i.compressed ? 4 : 1;
    i.blockBytes =
      i.format.startsWith("bc1") || i.format.startsWith("bc4") ? 8 : 16;
    const renderable = !i.compressed && i.dimension === "2d";
    i.gpu = this.device.createTexture({
      label: "X-Ray " + i.format,
      size: [i.width, i.height, i.depth],
      mipLevelCount: i.mips,
      dimension: i.dimension,
      format: i.format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC |
        (renderable ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
    });
    i.views = new Map();
    i.sampledViews = null;
    this.resourceGeneration++;
  }
  uploadTexture(a, is3, compressed, i) {
    const g = EngineFormat;
    if (!i?.gpu) return;
    this.flush();
    const [target, level, x, y] = a;
    const z = is3
      ? a[4]
      : target >= g.TEXTURE_CUBE_MAP_POSITIVE_X &&
          target <= g.TEXTURE_CUBE_MAP_NEGATIVE_Z
        ? target - g.TEXTURE_CUBE_MAP_POSITIVE_X
        : 0;
    const w = a[is3 ? 5 : 4],
      h = a[is3 ? 6 : 5],
      depth = is3 ? a[7] : 1;
    const dataIndex = compressed ? (is3 ? 9 : 7) : is3 ? 10 : 8;
    let src = a[dataIndex];
    if (!src) return;
    const off = a[dataIndex + 1] ?? 0;
    src = new Uint8Array(
      src.buffer ?? src,
      (src.byteOffset ?? 0) + off * (src.BYTES_PER_ELEMENT ?? 1),
      (src.byteLength ?? src.length) - off * (src.BYTES_PER_ELEMENT ?? 1),
    );
    let bpp = 4;
    if (!compressed) {
      const fmt = a[is3 ? 8 : 6],
        type = a[is3 ? 9 : 7];
      let components =
        fmt === g.RED ? 1 : fmt === g.RG ? 2 : fmt === g.RGB ? 3 : 4;
      const unit =
        type === g.FLOAT
          ? 4
          : type === g.HALF_FLOAT || type === g.UNSIGNED_SHORT
            ? 2
            : 1;
      bpp = components * unit;
      if (type === g.UNSIGNED_SHORT_5_6_5) {
        const packed = new DataView(src.buffer, src.byteOffset, src.byteLength);
        const expanded = new Uint8Array(w * h * depth * 4);
        for (let p = 0; p < w * h * depth; p++) {
          const v = packed.getUint16(p * 2, true);
          expanded.set(
            [
              Math.round(((v >> 11) * 255) / 31),
              Math.round((((v >> 5) & 63) * 255) / 63),
              Math.round(((v & 31) * 255) / 31),
              255,
            ],
            p * 4,
          );
        }
        src = expanded;
        bpp = 4;
      } else if (components === 3 && i.format.startsWith("rgba8")) {
        const expanded = new Uint8Array(w * h * depth * 4);
        for (let p = 0; p < w * h * depth; p++) {
          expanded.set(src.subarray(p * 3, p * 3 + 3), p * 4);
          expanded[p * 4 + 3] = 255;
        }
        src = expanded;
        bpp = 4;
      }
    }
    const block = compressed ? 4 : 1;
    const row = Math.ceil(w / block) * (compressed ? i.blockBytes : bpp);
    const rows = Math.ceil(h / block);
    const padded = align(row, 256);
    const bytes = new Uint8Array(padded * rows * depth);
    for (let d = 0; d < depth; d++)
      for (let r = 0; r < rows; r++)
        bytes.set(
          src.subarray((d * rows + r) * row, (d * rows + r + 1) * row),
          (d * rows + r) * padded,
        );
    this.device.queue.writeTexture(
      { texture: i.gpu, mipLevel: level, origin: [x, y, z] },
      bytes,
      { bytesPerRow: padded, rowsPerImage: rows },
      {
        width: compressed ? align(w, 4) : w,
        height: compressed ? align(h, 4) : h,
        depthOrArrayLayers: depth,
      },
    );
  }
  link(program) {
    const meta = program.meta;
    meta.activeSamplerIndices = meta.samplers.map((_,n)=>n).filter(n=>meta.activeBindings.includes(1+n*2));
    meta.activeBindingSet = new Set(meta.activeBindings);
    const vertexBindings = new Set(activeBindings(meta.stages.vert)),
      fragmentBindings = new Set(activeBindings(meta.stages.frag));
    const layouts = meta.activeBindings.map((binding) => {
      const visibility =
        (vertexBindings.has(binding) ? GPUShaderStage.VERTEX : 0) |
        (fragmentBindings.has(binding) ? GPUShaderStage.FRAGMENT : 0);
      if (binding === 0)
        return {
          binding,
          visibility,
          buffer: {
            type: "uniform",
            hasDynamicOffset: true,
            minBindingSize: meta.uniformBytes,
          },
        };
      const sm = meta.samplers[Math.floor((binding - 1) / 2)];
      if (binding % 2 === 0)
        return {
          binding,
          visibility,
          sampler: {
            type: sm.type.includes("Shadow") ? "comparison" : "filtering",
          },
        };
      return {
        binding,
        visibility,
        texture: {
          sampleType: sm.type.includes("Shadow")
            ? "depth"
            : meta.activeBindings.includes(binding + 1)
              ? "float"
              : "unfilterable-float",
          viewDimension: sm.type.includes("Cube")
            ? "cube"
            : sm.type.includes("3D")
              ? "3d"
              : "2d",
        },
      };
    });
    meta.bindGroupLayout = this.device.createBindGroupLayout({
      entries: layouts,
    });
    meta.extraUniformLayouts = (meta.uniformGroups || []).slice(1).map(group => this.device.createBindGroupLayout({entries:[{
      binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,
      buffer:{type:"uniform",hasDynamicOffset:true,minBindingSize:group.bytes}}]}));
    meta.pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [meta.bindGroupLayout, ...meta.extraUniformLayouts],
    });
    meta.bindGroups = new Map();
    meta.nativeLocations = new Map();
    meta.uniformVersion = 0;
    meta.uniformAllocation = null;
    meta.materialTrie = null;
    meta.lastMaterial = null;
    meta.values = new Map();
    meta.uniformData = new Uint8Array(meta.uniformBytes);
    meta.uniformView = new DataView(meta.uniformData.buffer);
    meta.uniformBlocks = [meta, ...(meta.uniformGroups || []).slice(1).map((group,index) => ({
      uniformData:new Uint8Array(group.bytes),uniformVersion:0,uniformAllocation:null,
      bindGroup:this.device.createBindGroup({layout:meta.extraUniformLayouts[index],entries:[{
        binding:0,resource:{buffer:this.uniformBuffer,offset:0,size:group.bytes}}]})
    }))];
    meta.uniformByName = new Map(meta.uniforms.map((u) => [u.name, u]));
    meta.modules = {
      vert: this.device.createShaderModule({
        label: meta.key + " vert",
        code: "diagnostic(off, derivative_uniformity);\n" + meta.stages.vert,
      }),
      frag: this.device.createShaderModule({
        label: meta.key + " frag",
        code: "diagnostic(off, derivative_uniformity);\n" + meta.stages.frag,
      }),
    };
    this.programs.set(program, meta);
    console.log("[WebGPU shader]", meta.key.slice(0, 12));
  }
  resolveUniform(loc) {
    if (!loc) return null;
    if (!loc.resolved) {
      const p = this.programs.get(loc.program);
      if (!p) return;
      loc.resolved = true;
      loc.meta = p;
      const match = /^(.*?)(?:\[(\d+)\])?$/.exec(loc.name);
      const u = p.uniformByName.get(match[1]);
      if (u) {
        const first = Number(match[2] || 0);
        loc.uniform = u;
        loc.offsets = [];
        for (let n = first; n < u.count; n++)
          for (let c = 0; c < u.columns; c++)
            for (let r = 0; r < u.rows; r++)
              loc.offsets.push((u.offset + n * u.stride + c * 16 + r * 4) / 4);
        const View = u.type.startsWith("i") || u.type.startsWith("b")
          ? Int32Array : u.type.startsWith("u") ? Uint32Array : Float32Array;
        loc.block = p.uniformBlocks?.[u.group || 0] || p;
        loc.view = new View(loc.block.uniformData.buffer);
      }
    }
    return loc;
  }
  consumeUniformBatch(words, floats, ints, start, length, programs) {
    const end = start + length;
    diagnostics.uniformBatches++;
    while (start < end) {
      if (start + 4 > end) throw Error("Truncated uniform batch header");
      const program = programs[words[start]], location = words[start+1], kind = words[start+2], count = words[start+3];
      start += 4;
      if (start + count > end) throw Error("Truncated uniform batch payload");
      const p = this.programs.get(program);
      if (!p) throw Error("Unlinked batched uniform program");
      const locations = (p.nativeLocations ??= new Map());
      let loc = locations.get(location);
      if (!loc) {
        const token = program.uniformLocsById[location];
        const name = typeof token === "object" ? token?.name
          : program.uniformArrayNamesById[location] + (token > 0 ? `[${token}]` : "");
        if (!name) throw Error("Unknown batched uniform location");
        loc = this.resolveUniform({program, name});
        if (!loc || (!loc.uniform && kind !== 3)) throw Error("Batched uniform not reflected: " + name);
        locations.set(location, loc);
      }
      if (kind === 3) {
        if (count !== 1) throw Error("Invalid batched sampler");
        const unit = ints[start];
        if (p.values.get(loc.name)?.[0] !== unit) {
          p.values.set(loc.name, [unit]);
          this.resourceGeneration++;
        }
        diagnostics.uniformRecords++; start += count;
        continue;
      }
      const u = loc.uniform, offsets = loc.offsets, dst = loc.view;
      const source = kind === 2 ? ints : floats;
      const n = Math.min(offsets.length, kind === 1 ? u.columns * u.rows : count);
      if (kind === 1 && count !== 16) throw Error("Invalid batched Fmatrix");
      let dirty = false;
      for (let i = 0; i < n; i++) {
        // Fmatrix already contains the column-major values consumed by WGSL;
        // rectangular matrices omit the fourth row of each input column.
        const value = source[start + (kind === 1 ? Math.floor(i / u.rows) * 4 + i % u.rows : i)];
        if (dst[offsets[i]] !== value) { dst[offsets[i]] = value; dirty = true; }
      }
      if (dirty) {const block=loc.block || p; block.uniformVersion = (block.uniformVersion || 0) + 1;}
      diagnostics.uniformRecords++;
      start += count;
    }
  }
  setUniform(name, a) {
    const loc = this.resolveUniform(this.locations.get(a[0]));
    if (!loc) return;
    const u = loc.uniform;
    // Only sampler uniforms need a separate value for resource selection.
    if (!u) {
      if (loc.meta.values.get(loc.name)?.[0] !== a[1]) this.resourceGeneration++;
      loc.meta.values.set(loc.name, [a[1]]);
      return;
    }
    const block=loc.block || loc.meta;
    block.uniformVersion = (block.uniformVersion || 0) + 1;
    const dst = loc.view, offsets = loc.offsets;
    if (name === "uniform4f") {
      dst[offsets[0]] = a[1]; dst[offsets[1]] = a[2];
      dst[offsets[2]] = a[3]; dst[offsets[3]] = a[4];
      return;
    }
    const matrix = name.startsWith("uniformMatrix"), start = matrix ? 2 : 1;
    const v = a[start];
    const vector = ArrayBuffer.isView(v) || Array.isArray(v);
    const data = vector ? v : a;
    const from = vector ? (a[start + 1] ?? 0) : start;
    const count = Math.min(offsets.length,
      vector ? (a[start + 2] ?? (v.length - from)) : a.length - start);
    if (matrix && a[1]) {
      const size = u.columns * u.rows;
      for (let i = 0; i < count; i++) {
        const base = Math.floor(i / size) * size;
        const c = Math.floor((i % size) / u.rows), r = i % u.rows;
        dst[offsets[i]] = data[from + base + r * u.columns + c];
      }
    } else {
      for (let i = 0; i < count; i++) dst[offsets[i]] = data[from + i];
    }
  }
  compare(n) {
    return (
      new Map([
        [512, "never"],
        [513, "less"],
        [514, "equal"],
        [515, "less-equal"],
        [516, "greater"],
        [517, "not-equal"],
        [518, "greater-equal"],
        [519, "always"],
      ]).get(n) || "always"
    );
  }
  factor(n) {
    return (
      new Map([
        [0, "zero"],
        [1, "one"],
        [768, "src"],
        [769, "one-minus-src"],
        [770, "src-alpha"],
        [771, "one-minus-src-alpha"],
        [772, "dst-alpha"],
        [773, "one-minus-dst-alpha"],
        [774, "dst"],
        [775, "one-minus-dst"],
        [776, "src-alpha-saturated"],
        [32769, "constant"],
        [32770, "one-minus-constant"],
        [32771, "constant"],
        [32772, "one-minus-constant"],
      ]).get(n) || "one"
    );
  }
  operation(n) {
    return (
      new Map([
        [32774, "add"],
        [32778, "subtract"],
        [32779, "reverse-subtract"],
        [32775, "min"],
        [32776, "max"],
      ]).get(n) || "add"
    );
  }
  stencilOp(n) {
    return (
      new Map([
        [7680, "keep"],
        [0, "zero"],
        [7681, "replace"],
        [7682, "increment-clamp"],
        [7683, "decrement-clamp"],
        [5386, "invert"],
        [34055, "increment-wrap"],
        [34056, "decrement-wrap"],
      ]).get(n) || "keep"
    );
  }
  view(texture, level = 0, layer = 0, dimension = "2d", sampled = false) {
    const i = this.info(texture);
    if (!i?.gpu) throw Error("WebGPU texture not allocated");
    if (sampled && level === 0 && layer === 0 && i.sampledViews?.[dimension])
      return i.sampledViews[dimension];
    const key = [level, layer, dimension, sampled].join(":");
    if (!i.views.has(key))
      i.views.set(
        key,
        i.gpu.createView({
          dimension,
          baseMipLevel: level,
          mipLevelCount: sampled ? i.mips - level : 1,
          ...(i.dimension === "3d"
            ? {}
            : {
                baseArrayLayer: layer,
                arrayLayerCount: dimension === "cube" ? 6 : 1,
              }),
          ...(i.format.includes("depth") && sampled
            ? { aspect: "depth-only" }
            : {}),
        }),
      );
    const result = i.views.get(key);
    if (sampled && level === 0 && layer === 0)
      (i.sampledViews ??= {})[dimension] = result;
    return result;
  }
  attachments() {
    const g = EngineFormat;
    if (!this.fbo)
      throw Error(
        "Direct default-framebuffer rendering is not implemented; X-Ray presents via blit",
      );
    const i = this.info(this.fbo),
      a = i.attachments ?? new Map();
    if (i.cachedAttachments && i.cachedAttachments.storageGeneration === (this.textureStorageGeneration || 0)) return i.cachedAttachments;
    const draw = i.drawBuffers ?? [g.COLOR_ATTACHMENT0];
    const colors = draw.map((n) =>
      n === g.NONE || !a.get(n)?.texture ? null : a.get(n),
    );
    const depth = [
      a.get(g.DEPTH_STENCIL_ATTACHMENT),
      a.get(g.DEPTH_ATTACHMENT),
    ].find((a) => a?.texture);
    const key = colors.map(a => a ? `${this.id(a.texture)}:${a.level}:${a.layer}` : "-").join(",")
      + "|" + (depth ? `${this.id(depth.texture)}:${depth.level}:${depth.layer}` : "0");
    const formats = colors.map(c => c ? this.info(c.texture).format : "-").join(",")
      + "|" + (depth ? this.info(depth.texture).format : "-");
    const compatibilities = (this.targetCompatibilities ??= new Map());
    let compatibility = compatibilities.get(formats);
    if (!compatibility) compatibilities.set(formats, compatibility = {formats});
    return (i.cachedAttachments = { colors, depth, key, compatibility,
      storageGeneration: this.textureStorageGeneration || 0 });
  }
  validateNativeFramebuffer() {
    this.flushNativeStates?.();
    const f = this.info(this.fbo);
    if (!f) throw Error("Native framebuffer is not bound");
    const {colors, depth} = this.attachments();
    const attachments = [...colors, depth].filter(a => a?.texture);
    if (!attachments.length) throw Error("Native framebuffer has no attachments");
    let extent;
    for (const a of attachments) {
      const i = this.info(a.texture);
      if (!i?.gpu || a.texture.deleted) throw Error("Native framebuffer has an invalid attachment");
      const level = a.level || 0;
      if (level < 0 || level >= i.mips) throw Error("Native framebuffer mip level is out of range");
      const size = [Math.max(1, i.width >> level), Math.max(1, i.height >> level)];
      if (extent && (size[0] !== extent[0] || size[1] !== extent[1]))
        throw Error("Native framebuffer attachment sizes differ");
      extent = size;
    }
    return true;
  }
  begin(clear = 0) {
    const { colors, depth, key } = this.attachments();
    const g = EngineFormat,
      s = this.state;
    if (this.pass && this.passKey === key && !clear) return this.pass;
    this.endPass();
    const colorAttachments = colors.map((a) =>
      a
        ? {
            view: this.view(a.texture, a.level, a.layer),
            loadOp: clear & g.COLOR_BUFFER_BIT ? "clear" : "load",
            storeOp: "store",
            clearValue: s.clearColor,
          }
        : null,
    );
    const desc = { colorAttachments, occlusionQuerySet: this.occlusion.set };
    if (depth) {
      const t = this.info(depth.texture);
      desc.depthStencilAttachment = {
        view: this.view(depth.texture, depth.level, depth.layer),
        depthLoadOp: clear & g.DEPTH_BUFFER_BIT ? "clear" : "load",
        depthStoreOp: "store",
        depthClearValue: s.clearDepth,
      };
      if (t.format.includes("stencil"))
        Object.assign(desc.depthStencilAttachment, {
          stencilLoadOp: clear & g.STENCIL_BUFFER_BIT ? "clear" : "load",
          stencilStoreOp: "store",
          stencilClearValue: s.clearStencil,
        });
    }
    const sampleGPU = telemetryAdapter && diagnostics.frames % 16 === 0;
    if ((profileEnabled || sampleGPU) && this.timer && !this.timer.busy && !this.timer.active) {
      this.timer.active = true;
      desc.timestampWrites = { querySet: this.timer.set, beginningOfPassWriteIndex: 0 };
    }
    diagnostics.renderPasses++;
    this.pass = this.enc().beginRenderPass(desc);
    this.passKey = key;
    this.passState = { vertices: [] };
    this.occlusion.resume(this.pass);
    return this.pass;
  }
  beginNativeUIList(...args) { beginNativeUIList(this, ...args); }
  drawNativeUI(...args) { drawNativeUI(this, ...args); }
  endNativeUIList() { endNativeUIList(this); }
  clearNativeRects(...args) { clearNativeRects(this, ...args); }
  createNativeObject(kind) {
    return allocateHandle(this.handles, ["vaos","framebuffers","samplers","shaders","programs"][kind]);
  }
  deleteNativeObject(kind, id) { deleteNativeObject(this, this.handles, ["vaos","framebuffers","samplers","shaders","programs"][kind], id); }
  setNativeSampler(id, parameter, value) { nativeSamplerParameter(this, this.handles.samplers[id], parameter, value); }
  createNativeShader(type, source) { return allocateHandle(this.handles,"shaders",{type,source}); }
  linkNativeProgram(vertex, fragment) { return loadNativeProgram(this,this.handles,vertex,fragment); }
  nativeUniformLocation(program, name) { return nativeUniformLocation(this.handles.programs[program],name); }
  allocateNativeTexture(token, target, levels, format, width, height, depth) {
    this.flushNativeDraws?.();
    const info = this.info(token);
    info.target = target;
    info.params = new Map([[EngineFormat.TEXTURE_BASE_LEVEL, 0], [EngineFormat.TEXTURE_MAX_LEVEL, levels - 1]]);
    this.allocateTexture([target, levels, format, width, height, depth], target === EngineFormat.TEXTURE_3D || target === EngineFormat.TEXTURE_2D_ARRAY, info);
    diagnostics.nativeTextureAllocations++;
  }
  uploadNativeTexture(token, target, level, width, height, depth, format, type, compressed, bytes) {
    this.flushNativeDraws?.();
    this.flush();
    const is3 = target === EngineFormat.TEXTURE_3D || target === EngineFormat.TEXTURE_2D_ARRAY;
    const args = is3 ? [target, level, 0, 0, 0, width, height, depth, format] : [target, level, 0, 0, width, height, format];
    if (!compressed) args.push(type);
    args.push(bytes);
    this.uploadTexture(args, is3, compressed, this.info(token));
    diagnostics.nativeTextureUploads++;
  }
  deleteNativeTexture(token) {
    this.flushNativeDraws?.();
    if (!token) return;
    this.flushNativeBindings?.();
    this.flushNativeStates?.();
    for (const bindings of this.textures)
      for (const [target, bound] of bindings)
        if (bound === token) bindings.set(target, null);
    this.flush();
    this.info(token)?.gpu?.destroy();
    token.deleted = true;
    this.resourceGeneration++;
  }
  uploadNativeBuffer(token, data, offset = 0, replace = true) {
    this.flushNativeDraws?.();
    if (!token || token.deleted) throw Error("Invalid native buffer");
    if (replace) this.bufferData([0, data], this.info(token));
    else {
      if (typeof data === "number") throw Error("Sub-buffer upload requires bytes");
      this.bufferSubData([0, offset, data], this.info(token));
    }
    diagnostics.nativeBufferUploads++;
  }
  deleteNativeBuffer(token) {
    this.flushNativeDraws?.();
    if (!token) return;
    this.flush();
    const info = this.info(token);
    info?.gpu?.destroy();
    if (this.vao.element === token) this.vao.element = null;
    token.deleted = true;
    this.bufferGeneration++;
  }
  beginNativeQuery(token) {
    if (!token || token.deleted) throw Error("Invalid native query");
    this.flushNativeStates?.();
    this.occlusion.begin(this.begin(), token);
    diagnostics.nativeQueries++;
  }
  endNativeQuery() { this.flushNativeDraws?.(); this.occlusion.end(this.pass); }
  nativeQueryResult(token) {
    if (!token || token.deleted) throw Error("Invalid native query");
    return token.available ? (token.result ? 1 : 0) : -1;
  }
  copyNativeTexture(source, destination, width, height) {
    this.flushNativeStates?.();
    this.flushNativeBindings?.();
    const src = this.info(source), dst = this.info(destination);
    if (!src?.gpu || !dst?.gpu) throw Error("Missing native copy texture");
    this.endPass();
    this.enc().copyTextureToTexture({texture: src.gpu}, {texture: dst.gpu}, [width, height, 1]);
    diagnostics.nativeTextureCopies++;
  }
  selectNativeProgram(program) {
    this.program = program;
    diagnostics.nativeProgramSelections++;
  }
  selectNativeVertexArray(vertexArray) {
    this.vaoObject = vertexArray;
    this.vao = vertexArray
      ? (this.info(vertexArray).vao ??= {attrs: new Map(), element: null})
      : this.defaultVAO;
    diagnostics.nativeVertexSelections++;
  }
  setNativeAttachment(framebuffer, attachment, texture, level = 0, layer = 0) {
    const f = this.info(framebuffer);
    if (!f) throw Error("Native attachment requires a framebuffer");
    const attachments = (f.attachments ??= new Map());
    const previous = attachments.get(attachment);
    if (previous?.texture === texture && previous.level === level && previous.layer === layer) return;
    attachments.set(attachment, {texture, level, layer});
    f.cachedAttachments = null;
  }
  clearNativeTarget(texture, mask, r, g, b, a, depth, stencil) {
    this.flushNativeStates?.();
    const s = this.state;
    if (mask & EngineFormat.COLOR_BUFFER_BIT) {
      this.setNativeAttachment(this.fbo, EngineFormat.COLOR_ATTACHMENT0, texture);
      if (s.colorMask !== 15) this.pipelineStateKey = null;
      s.colorMask = 15;

      s.clearColor = [r,g,b,a];
    } else {
      this.setNativeAttachment(this.fbo, EngineFormat.DEPTH_STENCIL_ATTACHMENT, texture);
      if (!s.depthWrite) this.pipelineStateKey = null;
      s.depthWrite = true;
      s.clearDepth = depth;
      if (mask & EngineFormat.STENCIL_BUFFER_BIT) {
        if (s.stencilMask !== 0xffffffff) this.pipelineStateKey = null;
        s.stencilMask = 0xffffffff;
        s.clearStencil = stencil;
      }
    }
    diagnostics.nativeClears++;
    this.begin(mask);
  }
  presentNative(framebuffer, width, height) {
    this.flushNativeBindings?.();
    this.flushNativeStates?.();
    this.flushNativeUniforms?.();
    this.readFbo = framebuffer;
    this.fbo = null;
    diagnostics.nativePresents++;
    this.blit([0,0,width,height,0,0,width,height,EngineFormat.COLOR_BUFFER_BIT,EngineFormat.NEAREST]);
  }
  clear(mask) {
    this.flushNativeStates?.();
    this.begin(mask);
  }
  vertexFormat(a) {
    const g = EngineFormat;
    const t = a.type === g.FLOAT ? "float32"
      : a.type === g.UNSIGNED_BYTE ? (a.normalized ? "unorm8" : "uint8")
      : a.type === g.BYTE ? (a.normalized ? "snorm8" : "sint8")
      : a.type === g.SHORT ? (a.normalized ? "snorm16" : "sint16")
      : a.type === g.UNSIGNED_SHORT ? (a.normalized ? "unorm16" : "uint16")
      : a.type === g.INT ? "sint32"
      : a.type === g.UNSIGNED_INT ? "uint32"
      : a.type === g.HALF_FLOAT ? "float16" : null;
    if (!t) throw Error("Unsupported vertex component " + a.type);
    const n =
      t.endsWith("8") || t.endsWith("16") ? (a.size <= 2 ? 2 : 4) : a.size;
    return t + (n === 1 ? "" : "x" + n);
  }
  registerDeclaration(token, packed) {
    const attributes = [];
    for (let i = 0; i < packed.length; i += 5)
      attributes.push({ location: packed[i], size: packed[i+1], type: packed[i+2],
        normalized: !!packed[i+3], offset: packed[i+4], enabled: true, divisor: 0 });
    (this.directDeclarations ??= new WeakMap()).set(token, { attributes, geometries: new WeakMap() });
  }
  // One typed engine call; no EngineFormat draw wrapper, proxy dispatch, VAO binding or
  // attribute-pointer emulation. Resource tokens retain allocation identity.
  submitDraw(declaration, vertexBuffer, indexBuffer, stride, program, primitive, indexed, count, first, baseVertex) {
    const d = this.directDeclarations?.get(declaration);
    if (!d) throw Error("Unregistered direct draw declaration");
    if (!vertexBuffer || (indexed && !indexBuffer)) throw Error("Missing direct draw buffer");
    let strides = d.geometries.get(vertexBuffer);
    if (!strides) d.geometries.set(vertexBuffer, strides = new Map());
    let geometry = strides.get(stride);
    if (!geometry) {
      geometry = { attrs: new Map(d.attributes.map(a => [a.location, {...a, stride, buffer: vertexBuffer}])) };
      strides.set(stride, geometry);
    }
    // Consumed synchronously; changing the index buffer does not change layout.
    geometry.element = indexBuffer;
    const start = profileEnabled ? performance.now() : 0;
    diagnostics.directDraws++;
    this.encodeDraw(this.programs.get(program), geometry, primitive, indexed ? "uint16" : undefined,
      count, 1, first, baseVertex, 0);
    if (profileEnabled) profile.directSubmissionMs = (profile.directSubmissionMs || 0) + performance.now() - start;
    return true;
  }

  consumeBindingBatch(words, start, length, textures, samplers) {
    if (length % 4 || start < 0 || start + length > words.length)
      throw Error("Invalid native binding batch");
    for (const end = start + length; start < end; start += 4) {
      const kind = words[start], stage = words[start+1], targetOrId = words[start+2], id = words[start+3];
      const bindings = this.textures[stage];
      if (!bindings) throw Error("Invalid native texture unit " + stage);
      if (kind === 0) {
        const token = id ? textures[id] : null;
        if (id && !token) throw Error("Missing native texture " + id);
        if (bindings.get(targetOrId) !== token) this.resourceGeneration++;
        bindings.set(targetOrId, token);
        if (token) this.info(token).target = targetOrId;
      } else if (kind === 1) {
        const token = targetOrId ? samplers[targetOrId] : null;
        if (targetOrId && !token) throw Error("Missing native sampler " + targetOrId);
        if (this.samplers[stage] !== token) this.resourceGeneration++;
        this.samplers[stage] = token;
      } else if (kind === 2) {
        for (const target of [EngineFormat.TEXTURE_2D, EngineFormat.TEXTURE_3D, EngineFormat.TEXTURE_CUBE_MAP]) {
          if (bindings.get(target) !== null) this.resourceGeneration++;
          bindings.set(target, null);
        }
        if (id) {
          if (bindings.get(EngineFormat.TEXTURE_2D_MULTISAMPLE) !== null) this.resourceGeneration++;
          bindings.set(EngineFormat.TEXTURE_2D_MULTISAMPLE, null);
        }
      } else throw Error("Unknown native binding record: " + kind);
    }
    diagnostics.bindingBatches++;
    diagnostics.bindingRecords += length / 4;
  }
  consumeStateBatch(words, start, length, floats, framebuffers, textures) {
    if (length % 6 || start < 0 || start + length > words.length)
      throw Error("Invalid native render-state batch");
    const s = this.state;
    let pipelineDirty = false;
    const set = (object, key, value) => {
      if (object[key] !== value) { object[key] = value; pipelineDirty = true; }
    };
    for (const end = start + length; start < end; start += 6) {
      const kind = words[start], a = words[start + 1], b = words[start + 2],
        c = words[start + 3], d = words[start + 4], e = words[start + 5];
      switch (kind) {
        case 0: set(s, "stencil", !!a); break;
        case 1:
          set(s.stencilFront, "compare", nativeCompare[a] || "always");
          set(s.stencilBack, "compare", nativeCompare[a] || "always");
          set(s, "stencilReadMask", c);
          s.stencilRef = b;
          break;
        case 2: set(s, "stencilMask", a); break;
        case 3:
          for (const face of [s.stencilFront, s.stencilBack]) {
            set(face, "failOp", nativeStencil[a] || "keep");
            set(face, "depthFailOp", nativeStencil[b] || "keep");
            set(face, "passOp", nativeStencil[c] || "keep");
          }
          break;
        case 4: set(s, "depthTest", !!a); break;
        case 5: set(s, "depthFunc", nativeCompare[a] || "always"); break;
        case 6: set(s, "depthWrite", !!a); break;
        case 7: set(s, "blend", !!a); break;
        case 8:
          set(s, "blendSrc", nativeFactor[a] || "one");
          set(s, "blendDst", nativeFactor[b] || "one");
          set(s, "blendSrcA", nativeFactor[c] || "one");
          set(s, "blendDstA", nativeFactor[d] || "one");
          break;
        case 9:
          set(s, "blendOp", nativeBlendOp[a] || "add");
          set(s, "blendOpA", nativeBlendOp[b] || "add");
          break;
        case 10: set(s, "colorMask", a & 15); break;
        case 11:
          set(s, "cull", a !== 1);
          if (a !== 1) set(s, "cullFace", a === 2 ? "back" : a === 3 ? "front" : "both");
          break;
        case 12:
          s.scissor = !!a;
          if (a) s.scissorRect = [b | 0, c | 0, d | 0, e | 0];
          break;
        case 13: {
          const v = s.viewport;
          if (!v || v[0] !== (a|0) || v[1] !== (b|0) || v[2] !== (c|0) || v[3] !== (d|0))
            s.viewport = [a|0, b|0, c|0, d|0];
          break;
        }
        case 14: {
          floats ??= new Float32Array(words.buffer, words.byteOffset, words.length);
          const min = floats[start+1], max = floats[start+2], range = s.depthRange;
          if (!range || range[0] !== min || range[1] !== max) s.depthRange = [min, max];
          break;
        }
        case 15: {
          const token = b ? framebuffers?.[b] : null;
          if (b && !token) throw Error("Missing native framebuffer " + b);
          if (a !== EngineFormat.READ_FRAMEBUFFER) this.fbo = token;
          if (a !== EngineFormat.DRAW_FRAMEBUFFER) this.readFbo = token;
          diagnostics.nativePassRecords++;
          break;
        }
        case 16: {
          const token = b ? textures?.[b] : null;
          if (b && !token) throw Error("Missing native attachment " + b);
          this.setNativeAttachment(this.fbo, a, token, c, d);
          diagnostics.nativePassRecords++;
          break;
        }
        case 17: {
          if (a > 4) throw Error("Invalid native draw-buffer count");
          const f = this.info(this.fbo);
          if (!f) throw Error("Native draw buffers require a framebuffer");
          const previous = f.drawBuffers;
          let changed = !previous || previous.length !== a;
          for (let i = 0; i < a; i++) if (previous?.[i] !== words[start+2+i]) changed = true;
          if (changed) {
            f.drawBuffers = Array.from(words.subarray(start+2,start+2+a));
            f.cachedAttachments = null;
          }
          diagnostics.nativePassRecords++;
          break;
        }
        default: throw Error("Unknown native render-state record: " + kind);
      }
    }
    if (pipelineDirty) this.pipelineStateKey = null;
    diagnostics.stateBatches++;
    diagnostics.stateRecords += length / 6;
  }
  allocateUniformBlock(p) {
    const epoch = this.uniformEpoch || 0, version = p.uniformVersion || 0;
    const allocation = p.uniformAllocation;
    if (this.preparedEnabled !== false && allocation?.epoch === epoch && allocation.version === version) {
      diagnostics.uniformReuses++;
      return allocation.offset;
    }
    const bytes = p.uniformData, size = align(bytes.length, 256);
    if (this.uniformOffset + size > this.uniformBuffer.size) {
      this.flush();
      this.uniformOffset = this.uniformUploaded = 0;
      this.uniformEpoch = epoch + 1;
    }
    const offset = this.uniformOffset;
    this.uniformStaging.set(bytes, offset);
    this.uniformOffset += size;
    p.uniformAllocation = {epoch: this.uniformEpoch || 0, version, offset};
    diagnostics.uniformBytesCopied += bytes.length;
    return offset;
  }
  materialHandle(p, entries) {
    let node = (p.materialTrie ??= {children: new WeakMap()});
    for (const entry of entries) {
      const resource = entry.resource.buffer || entry.resource;
      let child = node.children.get(resource);
      if (!child) node.children.set(resource, child = {children: new WeakMap()});
      node = child;
    }
    if (node.handle) { diagnostics.materialHits++; return node.handle; }
    return (node.handle = {group: this.device.createBindGroup({layout: p.bindGroupLayout, entries})});
  }
  encodeDraw(p, geometry, primitive, indexFormat, count, instances, first, baseVertex, firstInstance) {
    let drawMark = profileEnabled ? performance.now() : 0;
    diagnostics.draws++;
    const g = EngineFormat, s = this.state;
    if (!p) throw Error("No converted WebGPU program");
    if (s.cull && s.cullFace === "both") return;
    if (!count || !instances) return;
    const indexed = indexFormat !== undefined;
    const topology = primitive === g.TRIANGLES ? "triangle-list"
      : primitive === g.TRIANGLE_STRIP ? "triangle-strip"
      : primitive === g.LINES ? "line-list"
      : primitive === g.LINE_STRIP ? "line-strip"
      : primitive === g.POINTS ? "point-list" : null;
    if (!topology) throw Error("Unsupported primitive topology " + primitive);
    const layouts = (geometry.layouts ??= new WeakMap());
    let layout = layouts.get(p);
    // A dynamic allocation must invalidate only layouts using that buffer.
    // Other VAOs can retain their immutable descriptions and pipeline lookups.
    if (layout) layout.generation = this.bufferGeneration;
    if (!layout || layout.revision !== (geometry.revision || 0)
        || layout.generation !== this.bufferGeneration) {
      const vertexBuffers = [],
        bindings = [],
        dependencies = [],
        conversions = [];
      if (profileEnabled) profile.layoutRebuilds = (profile.layoutRebuilds || 0) + 1;
      for (const at of p.attributes) {
        const v = geometry.attrs.get(at.location);
        if (!v?.enabled)
          throw Error("Constant vertex attributes not implemented: " + at.name);
        let format = this.vertexFormat(v);
        const bytes =
          (v.type === g.FLOAT || v.type === g.INT || v.type === g.UNSIGNED_INT
            ? 4
            : v.type === g.BYTE || v.type === g.UNSIGNED_BYTE
              ? 1
              : 2) * v.size;
        const stride = v.stride || bytes;
        const base = Math.floor(v.offset / stride) * stride;
        if (
          ![
            g.INT,
            g.INT_VEC2,
            g.INT_VEC3,
            g.INT_VEC4,
            g.UNSIGNED_INT,
            g.UNSIGNED_INT_VEC2,
            g.UNSIGNED_INT_VEC3,
            g.UNSIGNED_INT_VEC4,
          ].includes(at.type) &&
          !v.integer &&
          !v.normalized &&
          v.type !== g.FLOAT &&
          v.type !== g.HALF_FLOAT
        ) {
          conversions.push({
            location: at.location,
            scalar: [g.UNSIGNED_BYTE, g.UNSIGNED_SHORT, g.UNSIGNED_INT].includes(
              v.type,
            )
              ? "u32"
              : "i32",
          });
        }
        vertexBuffers.push({
          arrayStride: stride,
          stepMode: v.divisor ? "instance" : "vertex",
          attributes: [
            { shaderLocation: at.location, offset: v.offset - base, format },
          ],
        });
        const info = this.info(v.buffer);
        dependencies.push({ info, gpu: info.gpu });
        bindings.push({ buffer: info.gpu, info, offset: base });
      }
      const merged = new Map();
      for (let n = 0; n < bindings.length; n++) {
        const b = bindings[n],
          v = vertexBuffers[n],
          key = [this.id(b.info || b.buffer), b.offset, v.arrayStride, v.stepMode].join(
            ":",
          );
        if (merged.has(key))
          merged.get(key).layout.attributes.push(...v.attributes);
        else merged.set(key, { binding: b, layout: v });
      }
      vertexBuffers.length = 0;
      bindings.length = 0;
      for (const { binding, layout } of merged.values()) {
        bindings.push(binding);
        vertexBuffers.push(layout);
      }
      layout = { vertexBuffers, bindings, conversions, dependencies,
        revision: geometry.revision || 0, generation: this.bufferGeneration,
        key: JSON.stringify(vertexBuffers) };
      layouts.set(p, layout);
    }
    if (profileEnabled) {
      const now = performance.now();
      profile.drawVertexLayoutMs = (profile.drawVertexLayoutMs || 0) + now - drawMark;
      drawMark = now;
    }
    const { vertexBuffers, bindings, conversions } = layout;
    const target = this.attachments();
    const { colors, depth } = target;
    // Cache immutable pipeline descriptions before allocating their nested objects.
    this.pipelineStateKey ??= JSON.stringify([
      s.colorMask, s.blend, s.blendSrc, s.blendDst, s.blendOp,
      s.blendSrcA, s.blendDstA, s.blendOpA, s.frontFace, s.cull, s.cullFace,
      s.depthTest, s.depthWrite, s.depthFunc, s.stencil, s.stencilFront,
      s.stencilBack, s.stencilReadMask, s.stencilMask, s.polygonOffset, s.bias, s.slope]);
    let record, preparedKinds;
    const drawKind = primitive * 3 + (indexFormat === "uint16" ? 1 : indexFormat === "uint32" ? 2 : 0);
    if (this.preparedEnabled !== false) {
      if (this.pipelineTokenKey !== this.pipelineStateKey) {
        const tokens = (this.pipelineTokens ??= new Map());
        let token = tokens.get(this.pipelineStateKey);
        if (!token) tokens.set(this.pipelineStateKey, token = {});
        this.pipelineToken = token;
        this.pipelineTokenKey = this.pipelineStateKey;
      }
      const states = (layout.preparedRecords ??= new WeakMap());
      let targets = states.get(this.pipelineToken);
      if (!targets) states.set(this.pipelineToken, targets = new WeakMap());
      preparedKinds = targets.get(target.compatibility);
      if (!preparedKinds) targets.set(target.compatibility, preparedKinds = new Map());
      record = preparedKinds.get(drawKind);
      if (record) diagnostics.preparedHits++; else diagnostics.preparedMisses++;
    }
    let pipe = record?.pipeline;
    if (!pipe) {
      const localKey = this.pipelineStateKey + "|" + topology + ":" + indexFormat + "|" + target.compatibility.formats;
      const localPipelines = (layout.pipelines ??= new Map());
      pipe = localPipelines.get(localKey);
      if (!pipe) {
        const key = p.key + "|" + layout.key + "|" + localKey;
        pipe = this.pipelineCache.get(key);
        if (!pipe) {
          const targets = colors.map((c, index) =>
            c
              ? {
                  format: this.info(c.texture).format,
                  writeMask: p.outputs.includes(index) ? s.colorMask : 0,
                  ...(s.blend
                    ? {
                        blend: {
                          color: {
                            srcFactor: s.blendSrc,
                            dstFactor: s.blendDst,
                            operation: s.blendOp,
                          },
                          alpha: {
                            srcFactor: s.blendSrcA,
                            dstFactor: s.blendDstA,
                            operation: s.blendOpA,
                          },
                        },
                      }
                    : {}),
                }
              : null,
          );
          const primitive = {
            topology,
            frontFace: s.frontFace === "ccw" ? "cw" : "ccw",
            cullMode: s.cull ? s.cullFace : "none",
            ...(topology.endsWith("strip") && indexed
              ? { stripIndexFormat: indexFormat }
              : {}),
          };
          const ds = depth
            ? {
                format: this.info(depth.texture).format,
                depthWriteEnabled: s.depthTest && s.depthWrite,
                depthCompare: s.depthTest ? s.depthFunc : "always",
                ...(s.stencil
                  ? {
                      stencilFront: s.stencilFront,
                      stencilBack: s.stencilBack,
                      stencilReadMask: (s.stencilReadMask ?? 255) >>> 0,
                      stencilWriteMask: s.stencilMask >>> 0,
                    }
                  : {}),
                depthBias: s.polygonOffset ? Math.round(s.bias) : 0,
                depthBiasSlopeScale: s.polygonOffset ? s.slope : 0,
              }
            : undefined;
          let vertexModule = p.modules.vert;
          if (conversions.length) {
            const conversionKey = JSON.stringify(conversions);
            p.vertexVariants ??= new Map();
            vertexModule = p.vertexVariants.get(conversionKey);
            if (!vertexModule) {
              vertexModule = this.device.createShaderModule({
                label: p.key + " vertex conversion",
                code:
                  "diagnostic(off, derivative_uniformity);\n" +
                  specializeVertex(p.stages.vert, conversions),
              });
              p.vertexVariants.set(conversionKey, vertexModule);
            }
          }
          pipe = this.device.createRenderPipeline({
            label: "X-Ray " + p.key.slice(0, 8),
            layout: p.pipelineLayout,
            vertex: {
              module: vertexModule,
              entryPoint: "main",
              buffers: vertexBuffers,
            },
            fragment: { module: p.modules.frag, entryPoint: "main", targets },
            primitive,
            ...(ds ? { depthStencil: ds } : {}),
          });
          this.pipelineCache.set(key, pipe);
        }
        localPipelines.set(localKey, pipe);
      }
      record = {pipeline: pipe, bindings, hasUniform: p.activeBindings.includes(0)};
      preparedKinds?.set(drawKind, record);
    }
    if (profileEnabled) {
      const now = performance.now();
      profile.drawPipelineMs = (profile.drawPipelineMs || 0) + now - drawMark;
      drawMark = now;
    }
    const bytes = p.uniformData;
    const hasUniform = p.activeBindings.includes(0);
    const needed = (p.uniformBlocks || [p]).reduce((n,block)=>n+align(block.uniformData.length,256),0);
    if(this.uniformOffset+needed>this.uniformBuffer.size){
      this.flush(); this.uniformOffset=this.uniformUploaded=0; this.uniformEpoch=(this.uniformEpoch || 0)+1;
    }
    const uniformBase = hasUniform ? this.allocateUniformBlock(p) : 0;
    record.extraUniforms ??= [];
    for(let i=1;i<(p.uniformBlocks?.length || 0);i++) {
      const block=p.uniformBlocks[i];
      record.extraUniforms[i-1]={group:block.bindGroup,offset:this.allocateUniformBlock(block)};
    }
    if (profileEnabled) {
      const now = performance.now();
      profile.drawUniformCopyMs = (profile.drawUniformCopyMs || 0) + now - drawMark;
      drawMark = now;
    }
    let material = p.lastResourceGeneration === this.resourceGeneration ? p.lastMaterial : null;
    let group = material?.group;
    if (group) diagnostics.materialHits++;
    if (!group) {
      const entries = hasUniform ? [{binding: 0, resource: {
        buffer: this.uniformBuffer, offset: 0, size: bytes.length,
      }}] : [];
      for (const n of p.activeSamplerIndices || p.samplers.map((_,n)=>n)) {
        const sm = p.samplers[n];
        if (!p.activeBindings.includes(1 + n * 2)) continue;
        const unit = p.values.get(sm.name)?.[0] ?? 0;
        const target = sm.type.includes("Cube")
          ? g.TEXTURE_CUBE_MAP
          : sm.type.includes("3D")
            ? g.TEXTURE_3D
            : g.TEXTURE_2D;
        let tex = this.textures[unit].get(target);
        if (!tex) {
          this.fallbackTextures ??= new Map();
          if (!this.fallbackTextures.has(target)) {
            const token = {},
              dimension = target === g.TEXTURE_3D ? "3d" : "2d",
              depth = target === g.TEXTURE_CUBE_MAP ? 6 : 1;
            Object.assign(this.info(token), {
              gpu: this.device.createTexture({
                label: "EngineFormat incomplete texture black",
                size: [1, 1, depth],
                dimension,
                format: "rgba8unorm",
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
              }),
              width: 1,
              height: 1,
              depth,
              mips: 1,
              dimension,
              format: "rgba8unorm",
              views: new Map(),
            });
            this.fallbackTextures.set(target, token);
          }
          tex = this.fallbackTextures.get(target);
        }
        const ti = this.info(tex);
        const owner = this.info(this.samplers[unit]) || ti;
        const samplerKind = sm.type.includes("Shadow")
          ? "comparison"
          : "filtering";
        let sampler = owner.gpuSamplers?.[samplerKind];
        if (!sampler) {
          const params = owner.params || new Map();
          const wrap = (v) =>
            v === g.CLAMP_TO_EDGE
              ? "clamp-to-edge"
              : v === g.MIRRORED_REPEAT
                ? "mirror-repeat"
                : "repeat";
          const min = params.get(g.TEXTURE_MIN_FILTER) ?? g.NEAREST_MIPMAP_LINEAR;
          const mag = params.get(g.TEXTURE_MAG_FILTER) ?? g.LINEAR;
          const desc = {
            addressModeU: wrap(params.get(g.TEXTURE_WRAP_S)),
            addressModeV: wrap(params.get(g.TEXTURE_WRAP_T)),
            addressModeW: wrap(params.get(g.TEXTURE_WRAP_R)),
            magFilter: mag === g.NEAREST ? "nearest" : "linear",
            minFilter: [
              g.NEAREST,
              g.NEAREST_MIPMAP_NEAREST,
              g.NEAREST_MIPMAP_LINEAR,
            ].includes(min)
              ? "nearest"
              : "linear",
            mipmapFilter: [
              g.LINEAR_MIPMAP_LINEAR,
              g.NEAREST_MIPMAP_LINEAR,
            ].includes(min)
              ? "linear"
              : "nearest",
            lodMaxClamp: [g.LINEAR, g.NEAREST].includes(min) ? 0 : 32,
            ...(sm.type.includes("Shadow")
              ? {
                  compare: this.compare(
                    params.get(g.TEXTURE_COMPARE_FUNC) ?? g.LEQUAL,
                  ),
                }
              : {}),
          };
          const sk = JSON.stringify(desc);
          if (!this.samplerCache.has(sk))
            this.samplerCache.set(sk, this.device.createSampler(desc));
          sampler = this.samplerCache.get(sk);
          (owner.gpuSamplers ??= {})[samplerKind] = sampler;
        }
        entries.push(
          {
            binding: 1 + n * 2,
            resource: this.view(
              tex,
              0,
              0,
              sm.type.includes("Cube")
                ? "cube"
                : sm.type.includes("3D")
                  ? "3d"
                  : "2d",
              true,
            ),
          },
          { binding: 2 + n * 2, resource: sampler },
        );
      }
      const activeEntries = entries.filter((e) =>
        p.activeBindingSet ? p.activeBindingSet.has(e.binding) : p.activeBindings.includes(e.binding),
      );
      if (this.preparedEnabled !== false) {
        material = this.materialHandle(p, activeEntries);
        group = material.group;
      } else {
        const groupKey = activeEntries
          .map((e) => e.binding + ":" + this.id(e.resource.buffer || e.resource))
          .join(",");
        group = p.bindGroups.get(groupKey);
        if (!group) {
          group = this.device.createBindGroup({
            layout: p.bindGroupLayout,
            entries: activeEntries,
          });
          if (p.bindGroups.size > 4096) p.bindGroups.clear();
          p.bindGroups.set(groupKey, group);
        }

        material = {group};
      }

      p.lastResourceGeneration = this.resourceGeneration;
      p.lastGroup = group;
      p.lastMaterial = material;
    }

    if (profileEnabled) {
      const now = performance.now();
      profile.drawResourcesMs = (profile.drawResourcesMs || 0) + now - drawMark;
      drawMark = now;
    }
    record.material = material;
    this.encodePreparedDraw(record, geometry, indexFormat, count, instances, first, baseVertex, firstInstance, uniformBase);
    if (profileEnabled) profile.drawEncodingMs = (profile.drawEncodingMs || 0) + performance.now() - drawMark;
  }
  encodePreparedDraw(record, geometry, indexFormat, count, instances, first, baseVertex, firstInstance, uniformBase) {
    const s = this.state, bindings = record.bindings, indexed = indexFormat !== undefined;
    const {colors, depth} = this.attachments();
    const pass = this.begin();
    const cached = this.passState;
    if (cached.pipeline !== record.pipeline) {
      pass.setPipeline(record.pipeline);
      cached.pipeline = record.pipeline;
    }
    if (cached.material !== record.material || cached.uniformBase !== uniformBase) {
      pass.setBindGroup(0, record.material.group, record.hasUniform ? [uniformBase] : []);
      cached.material = record.material; cached.uniformBase = uniformBase;
    }
    if(record.extraUniforms?.length) {
      cached.extraUniforms ??= [];
      for(let i=0;i<record.extraUniforms.length;i++) {
        const next=record.extraUniforms[i],old=cached.extraUniforms[i];
        if(old?.group!==next.group || old.offset!==next.offset) {
          pass.setBindGroup(i+1,next.group,[next.offset]); cached.extraUniforms[i]=next;
        }
      }
    }
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i], buffer = b.info?.gpu || b.buffer, old = cached.vertices[i];
      if (!old || old.buffer !== buffer || old.offset !== b.offset) {
        pass.setVertexBuffer(i, buffer, b.offset);
        cached.vertices[i] = {buffer, offset:b.offset};
      }
    }
    // State commands replace these arrays; retain references instead of building
    // and hashing viewport/scissor strings for every draw.
    if (cached.viewport !== s.viewport || cached.depthRange !== s.depthRange) {
      pass.setViewport(...s.viewport, ...s.depthRange);
      cached.viewport = s.viewport;
      cached.depthRange = s.depthRange;
    }
    const attachment = this.info((colors.find(Boolean) || depth).texture);
    const rect = s.scissor ? s.scissorRect : null;
    const sx = rect ? Math.max(0, rect[0]) : 0;
    const sy = rect ? Math.max(0, rect[1]) : 0;
    const sw = rect ? Math.max(0, rect[2]) : attachment.width;
    const sh = rect ? Math.max(0, rect[3]) : attachment.height;
    if (cached.sx !== sx || cached.sy !== sy || cached.sw !== sw || cached.sh !== sh) {
      pass.setScissorRect(sx, sy, sw, sh);
      cached.sx = sx; cached.sy = sy; cached.sw = sw; cached.sh = sh;
    }
    if (cached.stencil !== s.stencilRef) {
      pass.setStencilReference(s.stencilRef >>> 0); cached.stencil = s.stencilRef;
    }
    if (cached.blend !== s.blendColor) {
      pass.setBlendConstant(s.blendColor); cached.blend = s.blendColor;
    }
    if (indexed) {
      const b = this.info(geometry.element);
      if (cached.index !== b.gpu || cached.indexFormat !== indexFormat) {
        pass.setIndexBuffer(b.gpu, indexFormat);
        cached.index = b.gpu; cached.indexFormat = indexFormat;
      }
      pass.drawIndexed(
        count,
        instances,
        first, baseVertex, firstInstance,
      );
    } else pass.draw(count, instances, first, firstInstance);
  }
  async captureScreenshot(path) {
    let readback;
    try {
      const source = this.lastPresented;
      if (!source) throw Error("No presented WebGPU frame");
      const info = this.info(source.texture),
        row = align(info.width * 4, 256);
      if (
        ![
          "rgba8unorm",
          "bgra8unorm",
          "rgba8unorm-srgb",
          "bgra8unorm-srgb",
        ].includes(info.format)
      )
        throw Error("Unsupported capture format " + info.format);
      readback = this.device.createBuffer({
        size: row * info.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      this.endPass();
      this.enc().copyTextureToBuffer(
        {
          texture: info.gpu,
          mipLevel: source.level,
          origin: [0, 0, source.layer],
        },
        { buffer: readback, bytesPerRow: row },
        [info.width, info.height, 1],
      );
      this.flush();
      await readback.mapAsync(GPUMapMode.READ);
      const src = new Uint8Array(readback.getMappedRange()),
        rgba = new Uint8ClampedArray(info.width * info.height * 4);
      for (let y = 0; y < info.height; y++)
        rgba.set(
          src.subarray(
            (info.height - 1 - y) * row,
            (info.height - 1 - y) * row + info.width * 4,
          ),
          y * info.width * 4,
        );
      if (info.format.startsWith("bgra"))
        for (let i = 0; i < rgba.length; i += 4)
          [rgba[i], rgba[i + 2]] = [rgba[i + 2], rgba[i]];
      readback.unmap();
      readback.destroy();
      readback = null;
      const canvas = new OffscreenCanvas(info.width, info.height);
      canvas
        .getContext("2d")
        .putImageData(new ImageData(rgba, info.width, info.height), 0, 0);
      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 1,
      });
      let dir = await navigator.storage.getDirectory();
      const parts = path
        .replaceAll("\\", "/")
        .replace(/^\/?opfs\//, "")
        .split("/")
        .filter(Boolean);
      const name = parts.pop();
      for (const part of parts)
        dir = await dir.getDirectoryHandle(part, { create: true });
      const file = await dir.getFileHandle(name, { create: true });
      const stream = await file.createWritable();
      await stream.write(blob);
      await stream.close();
      channel?.postMessage({
        capture: {
          path,
          bytes: blob.size,
          width: info.width,
          height: info.height,
        },
      });
    } catch (error) {
      channel?.postMessage({
        ...diagnostics,
        lastError: "Screenshot: " + error.message,
      });
    } finally {
      if (readback) {
        if (readback.mapState === "mapped") readback.unmap();
        readback.destroy();
      }
    }
  }
  blit(a) {
    const g = EngineFormat;
    if (!(a[8] & g.COLOR_BUFFER_BIT))
      throw Error("Depth/stencil blit not implemented");
    const f = this.info(this.readFbo),
      src = f?.attachments?.get(g.COLOR_ATTACHMENT0);
    if (!src) throw Error("No source framebuffer for WebGPU blit");
    this.endPass();
    if (this.fbo) {
      const dst = this.info(this.fbo).attachments.get(g.COLOR_ATTACHMENT0);
      const si = this.info(src.texture),
        di = this.info(dst.texture);
      if (si.format !== di.format)
        throw Error("Format conversion blit not implemented");
      this.enc().copyTextureToTexture(
        { texture: si.gpu, mipLevel: src.level },
        { texture: di.gpu, mipLevel: dst.level },
        [Math.abs(a[2] - a[0]), Math.abs(a[3] - a[1]), 1],
      );
      return;
    }
    this.lastPresented = src;
    if (!this.presentPipeline) {
      // The engine target and canvas can have different pixel dimensions.
      // NDC Y points up, so the interpolated UV also flips the engine image.
      const code = `
        @group(0) @binding(0) var image: texture_2d<f32>;
        struct PresentVertex {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        }
        @vertex fn vs(@builtin(vertex_index) index: u32) -> PresentVertex {
          let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
          let p = positions[index];
          return PresentVertex(vec4f(p, 0, 1), p * 0.5 + vec2f(0.5));
        }
        @fragment fn fs(vertex: PresentVertex) -> @location(0) vec4f {
          let size = textureDimensions(image);
          let pixel = clamp(vec2i(vertex.uv * vec2f(size)), vec2i(0), vec2i(size) - vec2i(1));
          return textureLoad(image, pixel, 0);
        }`;
      const mod = this.device.createShaderModule({ code });
      this.presentPipeline = this.device.createRenderPipeline({
        layout: "auto",
        vertex: { module: mod, entryPoint: "vs" },
        fragment: {
          module: mod,
          entryPoint: "fs",
          targets: [{ format: this.format }],
        },
        primitive: { topology: "triangle-list" },
      });
    }
    const pass = this.enc().beginRenderPass({
      ...(this.timer?.active ? { timestampWrites: { querySet: this.timer.set, endOfPassWriteIndex: 1 } } : {}),
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(this.presentPipeline);
    const presentView = this.view(src.texture, src.level, src.layer);
    const groups = this.presentGroups ??= new WeakMap();
    let presentGroup = groups.get(presentView);
    if (!presentGroup) { presentGroup = this.device.createBindGroup({
      layout:this.presentPipeline.getBindGroupLayout(0), entries:[{binding:0,resource:presentView}]});
      groups.set(presentView,presentGroup); }
    pass.setBindGroup(0,presentGroup);
    pass.draw(3);
    pass.end();
    const readQueries = this.occlusion.resolve(this.enc());
    const timer = this.timer?.active ? this.timer : null;
    if (timer) {
      this.enc().resolveQuerySet(timer.set, 0, 2, timer.resolve, 0);
      this.enc().copyBufferToBuffer(timer.resolve, 0, timer.read, 0, 16);
      timer.active = false; timer.busy = true;
    }
    this.flush();
    if (timer) timer.read.mapAsync(GPUMapMode.READ).then(() => {
      const times = new BigUint64Array(timer.read.getMappedRange());
      timer.ms = Number(times[1] - times[0]) / 1e6;
      timer.read.unmap();
    }).catch(error => console.error("GPU timing", error)).finally(() => { timer.busy = false; });
    if (readQueries)
      readQueries().catch((error) =>
        console.error("Occlusion readback", error),
      );
    this.uniformOffset = this.uniformUploaded = 0;
    this.uniformEpoch = (this.uniformEpoch || 0) + 1;
    diagnostics.frames++;
    const now = performance.now();
    if (telemetryAdapter) {
      if (lastTelemetryPresent !== undefined)
        maxFrameMs = Math.max(maxFrameMs, now - lastTelemetryPresent);
      lastTelemetryPresent = now;
    }
    if (benchmark) {
      if (!benchmark.start) {
        benchmark.start = benchmark.last = now;
        benchmark.directStart = diagnostics.directDraws;
        benchmark.work = Object.fromEntries(["streamSnapshots", "streamBufferAllocations", "renderPasses", "drawBatches", "nativeTextureAllocations", "nativeTextureUploads", "nativeBufferUploads", "nativeQueries", "nativeTextureCopies", "nativeProgramSelections", "nativeVertexSelections", "nativePassRecords", "nativeClears", "nativePresents", "bindingBatches", "bindingRecords", "stateBatches", "stateRecords", "uniformBatches", "uniformRecords", "uniformBytesCopied", "uniformReuses", "preparedHits", "preparedMisses", "materialHits"].map(k => [k, diagnostics[k]]));
      } else {
        benchmark.times.push(now - benchmark.last);
        benchmark.last = now;
        if (now - benchmark.start >= benchmark.duration) {
          const sorted = [...benchmark.times].sort((a, b) => a - b),
            q = (p) => sorted[Math.floor((sorted.length - 1) * p)];
          channel?.postMessage({
            benchmark: {
              id: benchmark.id,
              frames: sorted.length,
              durationMs: now - benchmark.start,
              directDraws: diagnostics.directDraws - benchmark.directStart,
              work: Object.fromEntries(Object.entries(benchmark.work).map(([k,v]) => [k, diagnostics[k]-v])),
              fps: (sorted.length * 1000) / (now - benchmark.start),
              medianMs: q(0.5),
              p95Ms: q(0.95),
              p99Ms: q(0.99),
              validationErrors: diagnostics.validationErrors,
            },
          });
          benchmark = null;
        }
      }
    }
    if (now - lastReport > 1000) {
      diagnostics.fps =
        (1000 * (diagnostics.frames - lastReportFrames)) / (now - lastReport);
      diagnostics.profile = Object.fromEntries(
        Object.entries(profile).map(([k, v]) => [
          k,
          v / (diagnostics.frames - lastReportFrames),
        ]),
      );
      diagnostics.profile.fps = diagnostics.fps;
      diagnostics.profile.mode = profileEnabled ? "detailed" : phaseProfileEnabled ? "phases" : "off";
      if (profileEnabled && this.timer) diagnostics.profile.gpuMs = this.timer.ms;
      if (profileEnabled && this.subsystemStats) diagnostics.subsystems = this.subsystemStats;
      if (this.engineProfile?.count) {
        const e = this.engineProfile;
        diagnostics.profile.engineSimulationMs = e.simulation / e.count;
        diagnostics.profile.engineRenderMs = e.render / e.count;
        diagnostics.profile.engineWaitMs = e.wait / e.count;
        this.engineProfile = null;
      }
      for (const k in profile) profile[k] = 0;
      diagnostics.passBatchEnabled = this.passBatchEnabled;
      diagnostics.bindingBatchEnabled = this.bindingBatchEnabled;
      diagnostics.stateBatchEnabled = this.stateBatchEnabled;
      diagnostics.preparedEnabled = this.preparedEnabled;
      diagnostics.directDrawsEnabled = true;
      channel?.postMessage(diagnostics);
      telemetryChannel?.postMessage(telemetryAdapter ? {
        adapter: telemetryAdapter, fps: diagnostics.fps, frames: diagnostics.frames,
        timeMs: performance.timeOrigin + now, maxFrameMs,
        width: this.canvas.width, height: this.canvas.height, pacing: this.framePacing,
        simulationMs: diagnostics.profile.engineSimulationMs, renderMs: diagnostics.profile.engineRenderMs,
        waitMs: diagnostics.profile.engineWaitMs, gpuMs: this.timer?.ms || null,
        validationErrors: diagnostics.validationErrors,
      } : {fps: diagnostics.fps});
      maxFrameMs = 0;
      lastReport = now;
      lastReportFrames = diagnostics.frames;
    }
  }
}

// EngineFormat transpose uploads arrive in row-major order, including rectangular matrices.
export function transposeMatrices(data, columns, rows) {
  const copy = data.slice();
  for (let base = 0; base < data.length; base += columns * rows)
    for (let c = 0; c < columns; c++)
      for (let r = 0; r < rows; r++)
        data[base + c * rows + r] = copy[base + r * columns + c];
  return data;
}
