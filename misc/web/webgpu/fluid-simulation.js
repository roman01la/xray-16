import { fluidKernelSource, fluidKernelBindings } from './fluid-kernels.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const caches = new WeakMap();
function deviceCache(device) {
  let cache = caches.get(device);
  if (cache) return cache;
  const module = device.createShaderModule({ label: 'X-Ray fluid solver', code: fluidKernelSource });
  const pipelines = Object.fromEntries(Object.keys(fluidKernelBindings).map(entryPoint => [entryPoint,
    device.createComputePipeline({ label: `Fluid ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } })]));
  cache = { pipelines, sampler: device.createSampler({ minFilter: 'linear', magFilter: 'linear' }), scratch: new Map() };
  caches.set(device, cache);
  return cache;
}
export function prepareFluidSimulation(device) { deviceCache(device); }

function field(device, size, label) {
  const texture = device.createTexture({ label, size, dimension: '3d', format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
  return { texture, view: texture.createView() };
}
function buffer(device, values, usage, label) {
  const result = device.createBuffer({ label, size: Math.max(16, values.byteLength), usage, mappedAtCreation: true });
  new Uint8Array(result.getMappedRange()).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  result.unmap();
  return result;
}
function boxesData(boxes) {
  const data = new Float32Array(Math.max(1, boxes.length) * 28);
  boxes.forEach((box, i) => {
    const o = i * 28;
    data.set(box.gridToObstacle, o);
    data.set(box.massCenterWorld || [0, 0, 0], o + 16);
    data.set(box.angularVelocityWorld || [0, 0, 0], o + 20);
    data.set(box.translationVelocityWorld || [0, 0, 0], o + 24);
  });
  return data;
}
function emittersData(emitters) {
  const data = new Float32Array(Math.max(1, emitters.length) * 16);
  emitters.forEach((e, i) => {
    const o = i * 16;
    data.set(e.position, o); data[o + 3] = e.radius;
    data.set(e.flowVelocity || [0, 0, 0], o + 4); data[o + 7] = e.density || 0;
    data.set([e.sigma || 0, +!!e.applyDensity, +!!e.applyImpulse, +(e.type === 'SimpleDraught' || e.type === 'Draught')], o + 8);
    data.set([e.draught?.period || 0, e.draught?.phase || 0, e.draught?.amplitude || 0, e.saturation || 0], o + 12);
  });
  return data;
}

// Persistent fields belong to volumes; intermediate fields are shared across
// sequential updates of equally sized grids, just as in X-Ray's fluid manager.
export class FluidSimulation {
  constructor(device, config) {
    this.device = device; this.config = config; this.size = config.size || [70, 70, 70];
    if (this.size.length !== 3 || this.size.some(n => !Number.isInteger(n) || n < 4 || n > device.limits.maxTextureDimension3D))
      throw new Error('Invalid fluid grid dimensions');
    this.cache = deviceCache(device);
    const key = this.size.join('x');
    let scratch = this.cache.scratch.get(key);
    if (!scratch) {
      scratch = { refs: 0, fields: Array.from({ length: 8 }, (_, i) => field(device, this.size, `Fluid scratch ${i}`)) };
      this.cache.scratch.set(key, scratch);
    }
    scratch.refs++; this.scratch = scratch;
    this.velocity = field(device, this.size, 'Fluid persistent velocity');
    this.density = field(device, this.size, 'Fluid persistent density');
    this.pressure = field(device, this.size, 'Fluid persistent pressure');
    this.staticObstacles = field(device, this.size, 'Fluid static obstacles');
    this.emitters = buffer(device, emittersData(config.emitters || []), GPUBufferUsage.STORAGE, 'Fluid emitters');
    this.staticBoxes = buffer(device, boxesData(config.obstacles || []), GPUBufferUsage.STORAGE, 'Fluid static boxes');
    this.pendingBuffers = []; this.initialized = false; this.lastFrame = -1;
  }
  parameters(frame, { direction = 1, count = 0, staticPass = false } = {}) {
    const bytes = new ArrayBuffer(192), u = new Uint32Array(bytes), f = new Float32Array(bytes);
    u.set([...this.size, this.config.emitters?.length || 0]);
    u.set([count, +(this.config.settings?.type === 'Fire'), +staticPass, 0], 4);
    f.set([frame.timestep ?? 2, this.config.settings?.decay ?? .994, this.config.settings?.confinement ?? .06,
      this.config.settings?.gravity ?? 0], 8);
    f.set([frame.timeSeconds || 0, direction, 0, 0], 12);
    f.set(this.config.gridToWorld || identity, 16); f.set(this.config.worldToGrid || identity, 32);
    const result = buffer(this.device, new Uint8Array(bytes), GPUBufferUsage.UNIFORM, 'Fluid step parameters');
    this.pendingBuffers.push(result); return result;
  }
  dispatch(encoder, name, params, output, fields = {}, boxes = this.staticBoxes) {
    const pipeline = this.cache.pipelines[name];
    const resources = { 0: { buffer: params }, 1: this.cache.sampler,
      2: (fields.velocity || this.velocity).view, 3: (fields.density || this.density).view,
      4: (fields.auxiliary || this.pressure).view, 5: (fields.divergence || this.pressure).view,
      6: (fields.obstacles || this.staticObstacles).view, 7: output.view,
      8: { buffer: this.emitters }, 9: { buffer: boxes } };
    const bindGroup = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: fluidKernelBindings[name].map(binding => ({ binding, resource: resources[binding] })) });
    const pass = encoder.beginComputePass({ label: `Fluid ${name}` });
    pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(...this.size.map(n => Math.ceil(n / 4))); pass.end();
  }
  update(encoder, frame) {
    if (frame.frameId !== undefined && frame.frameId === this.lastFrame) return false;
    this.lastFrame = frame.frameId;
    const [forward, reverse, corrected, velA, velB, curl, div, pressure] = this.scratch.fields;
    if (!this.initialized) {
      // Separate input avoids binding a storage-write texture as a sampled input.
      const params = this.parameters(frame, { staticPass: true, count: this.config.obstacles?.length || 0 });
      this.dispatch(encoder, 'obstacle', params, this.staticObstacles, { obstacles: forward });
      this.initialized = true;
    }
    const dynamic = frame.obstacles || [];
    const boxes = buffer(this.device, boxesData(dynamic), GPUBufferUsage.STORAGE, 'Fluid moving boxes');
    this.pendingBuffers.push(boxes);
    const params = this.parameters(frame, { count: dynamic.length });
    const backwards = this.parameters(frame, { direction: -1 });
    if (!this.dynamicObstacles) this.dynamicObstacles = field(this.device, this.size, 'Fluid current obstacles');
    const obstacles = this.dynamicObstacles;
    this.dispatch(encoder, 'obstacle', params, obstacles, {}, boxes);
    this.dispatch(encoder, 'advect', params, forward, { obstacles });
    this.dispatch(encoder, 'advect', backwards, reverse, { obstacles, density: forward });
    this.dispatch(encoder, 'correct', params, corrected, { obstacles, auxiliary: reverse });
    this.dispatch(encoder, 'advect_velocity', params, velA);
    this.dispatch(encoder, 'curl', params, curl, { velocity: velA });
    this.dispatch(encoder, 'confine', params, velB, { velocity: velA, auxiliary: curl });
    this.dispatch(encoder, 'emit_density', params, this.density, { obstacles, density: corrected });
    this.dispatch(encoder, 'emit_velocity', params, velA, { obstacles, velocity: velB });
    this.dispatch(encoder, 'divergence_field', params, div, { obstacles, velocity: velA });
    let source = this.pressure, destination = pressure;
    for (let i = 0; i < 6; i++) {
      this.dispatch(encoder, 'jacobi', params, destination, { obstacles, auxiliary: source, divergence: div });
      [source, destination] = [destination, source];
    }
    this.dispatch(encoder, 'project', params, this.velocity, { obstacles, velocity: velA, auxiliary: source });
    return true;
  }
  // Call only after the encoder containing these updates has been submitted.
  submitted() {
    const pending = this.pendingBuffers.splice(0);
    this.device.queue.onSubmittedWorkDone().then(() => pending.forEach(b => b.destroy()));
  }
  destroy() {
    for (const f of [this.velocity, this.density, this.pressure, this.staticObstacles, this.dynamicObstacles]) f?.texture.destroy();
    this.emitters.destroy(); this.staticBoxes.destroy(); this.pendingBuffers.splice(0).forEach(b => b.destroy());
    if (--this.scratch.refs === 0) {
      this.scratch.fields.forEach(f => f.texture.destroy()); this.cache.scratch.delete(this.size.join('x'));
    }
  }
}
