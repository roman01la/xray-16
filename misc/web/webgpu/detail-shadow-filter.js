// Conservative per-cascade GPU compaction of grass sun-shadow instances.
// Main-pass detail draws register per-batch mesh bounds and wind amplitude.
// Each sun cascade — identified by explicit engine metadata (nativeShadowCascade),
// never by attachment shape — runs one compute pass that tests transformed
// instance bounds against the cascade's four XY clip planes; light depth stays
// deliberately unbounded so casters outside the camera view still shadow.
// Survivors are compacted into per-cascade outputs consumed through
// drawIndexedIndirect. Rows are copied exactly, including lighting; only
// instance order changes, which these depth/alpha-tested draws tolerate.
// Oversized batches, unreadable uniforms and unreadable mesh buffers stay on
// the original direct-draw path.
export const filterWGSL = `
struct Params { matrix:mat4x4<f32>, center:vec4<f32>, extent:vec4<f32>, wind:vec4<f32>, count:vec4<u32> }
@group(0) @binding(0) var<storage,read> source:array<vec4<f32>>;
@group(0) @binding(1) var<storage,read_write> output:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read_write> args:array<atomic<u32>>;
@group(0) @binding(3) var<uniform> p:Params;
var<workgroup> survivors:atomic<u32>;
var<workgroup> base:u32;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3<u32>,@builtin(local_invocation_index) lane:u32) {
 if(lane==0u){atomicStore(&survivors,0u);} workgroupBarrier();
 let i=gid.x;var keep=false;var a=vec4<f32>(0);var b=a;var c=a;
 if(i<p.count.x){
  a=source[i*4u];b=source[i*4u+1u];c=source[i*4u+2u];
  let center=vec3(dot(a,vec4(p.center.xyz,1)),dot(b,vec4(p.center.xyz,1)),dot(c,vec4(p.center.xyz,1)));
  let height=dot(abs(b.xyz),abs(p.center.xyz)+p.extent.xyz);
  let extent=vec3(dot(abs(a.xyz),p.extent.xyz),dot(abs(b.xyz),p.extent.xyz),dot(abs(c.xyz),p.extent.xyz))+vec3(height*p.wind.x+0.05,0.05,height*p.wind.x+0.05);
  let m=transpose(p.matrix);let planes=array<vec4<f32>,4>(m[3]+m[0],m[3]-m[0],m[3]+m[1],m[3]-m[1]);
  keep=true;
  for(var j=0u;j<4u;j++){if(dot(planes[j],vec4(center,1))+dot(abs(planes[j].xyz),extent)<0){keep=false;}}
 }
 var local=0u;if(keep){local=atomicAdd(&survivors,1u);}workgroupBarrier();
 if(lane==0u){base=atomicAdd(&args[p.count.y*5u+1u],atomicLoad(&survivors));}workgroupBarrier();
 if(keep){let dst=(base+local)*4u;output[dst]=a;output[dst+1u]=b;output[dst+2u]=c;output[dst+3u]=source[i*4u+3u];}
}`;

export function readUniform(p, name) {
  const u = p.uniforms?.find(u => u.name === name);
  if (!u) return null;
  return new Float32Array((p.uniformBlocks?.[u.group || 0] || p).uniformData.buffer, u.offset, u.type === 'mat4' ? 16 : 4);
}

// Immutable per-mesh object-space bounds plus the packed sway-height fraction
// used to scale the wind displacement envelope.
export function meshBounds(r, g, count, first, base) {
  const pos = g.attrs.get(3), tc = g.attrs.get(8), v = r.info(pos.buffer).cpu, ix = r.info(g.element).cpu;
  if (!v || !ix || pos.stride !== 20 || tc.offset !== 12) return null;
  const view = new DataView(v.buffer, v.byteOffset, v.byteLength), indices = new DataView(ix.buffer, ix.byteOffset, ix.byteLength);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let fraction = 0;
  for (let j = 0; j < count; j++) {
    const at = (indices.getUint16((first + j) * 2, true) + base) * pos.stride + pos.offset;
    for (let k = 0; k < 3; k++) { const x = view.getFloat32(at + k * 4, true); min[k] = Math.min(min[k], x); max[k] = Math.max(max[k], x); }
    fraction = Math.max(fraction, Math.abs(view.getInt16(at + 16, true) / 16384));
  }
  return {center: min.map((v, k) => (v + max[k]) / 2), extent: min.map((v, k) => (max[k] - v) / 2), fraction};
}

const STALE_FRAMES = 512;

export class DetailShadowFilter {
  constructor(renderer) {
    this.r = renderer;
    this.entries = new Map();
    this.bundles = [];
    this.frame = -1;
    this.cascade = 0;
    this.jobs = null;
    this.metrics = {compacts: 0, jobs: 0, fallbacks: 0};
  }
  beginFrame(frame) {
    if (this.frame === frame) return;
    this.frame = frame;
    this.cascade = 0;
    this.jobs = null;
    if (frame % STALE_FRAMES === 0) this.purge(frame);
  }
  // Main-pass detail draw: remember this batch's mesh bounds, draw range and
  // current wind amplitude for the cascades rendered later in the same frame.
  captureMain(p, g, count, instances, first, base) {
    let e = this.entries.get(g);
    if (!e) {
      const box = meshBounds(this.r, g, count, first, base);
      if (!box) return;
      e = {g, box};
      this.entries.set(g, e);
    }
    Object.assign(e, {frame: this.frame, count, instances, first, base});
    const wind = readUniform(p, 'dir2D');
    e.wind = wind ? Math.hypot(wind[0], wind[2]) * e.box.fraction * 1.01 : 0;
  }
  // Cascade detail draw: compact all registered batches once per cascade, then
  // hand each draw its indirect arguments and compacted instance buffer.
  cascadeJob(p, g, cascade) {
    if (cascade !== this.cascade) {
      this.cascade = cascade;
      const matrix = readUniform(p, 'm_WVP');
      const jobs = matrix ? [...this.entries.values()].filter(e => e.frame === this.frame) : [];
      this.jobs = jobs.length ? this.compact(this.bundles[cascade - 1] ??= {}, jobs, matrix) : null;
      if (this.jobs) this.metrics.compacts++;
    }
    const job = this.jobs?.get(g) ?? null;
    if (job) this.metrics.jobs++; else this.metrics.fallbacks++;
    return job;
  }
  compact(bundle, jobs, matrix) {
    const r = this.r, d = r.device;
    if (!this.pipeline) this.pipeline = d.createComputePipeline({layout: 'auto',
      compute: {module: d.createShaderModule({code: filterWGSL, label: 'X-Ray grass shadow compaction'}), entryPoint: 'main'}});
    const valid = jobs.filter(e => e.instances * 64 <= d.limits.maxStorageBufferBindingSize);
    if (!valid.length) return null;
    const bytes = Math.ceil(valid.length * 20 / 256) * 256;
    if (!bundle.args || bundle.args.size < bytes) {
      if (bundle.args) r.retired.push(bundle.args);
      bundle.args = d.createBuffer({size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC});
      bundle.groups = new Map();
    }
    bundle.jobCount = valid.length;
    bundle.outputs ??= new Map();
    const indirect = new Uint32Array(valid.length * 5), params = new Uint8Array(valid.length * 256);
    const groups = [], result = new Map();
    for (let slot = 0; slot < valid.length; slot++) {
      const e = valid[slot], input = r.info(e.g.attrs.get(12).buffer).gpu;
      let output = bundle.outputs.get(e.g);
      if (!output || output.size < e.instances * 64) {
        if (output) r.retired.push(output);
        output = d.createBuffer({size: 2 ** Math.ceil(Math.log2(e.instances * 64)), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE});
        bundle.outputs.set(e.g, output);
        bundle.groups.delete(e.g);
      }
      indirect.set([e.count, 0, e.first, e.base, 0], slot * 5);
      const floats = new Float32Array(params.buffer, slot * 256, 28), words = new Uint32Array(params.buffer, slot * 256 + 112, 4);
      floats.set(matrix); floats.set(e.box.center, 16); floats.set(e.box.extent, 20); floats[24] = e.wind;
      words.set([e.instances, slot, 0, 0]);
      groups.push({e, input, output, slot});
      result.set(e.g, {output, args: bundle.args, slot});
    }
    if (!bundle.params || bundle.params.size < params.length) {
      if (bundle.params) r.retired.push(bundle.params);
      bundle.params = d.createBuffer({size: params.length, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST});
      bundle.groups = new Map();
    }
    // Each cascade owns these buffers; do not overwrite while earlier encoded
    // commands still read them.
    if (bundle.encoder === r.encoder && r.encoder) r.flush();
    d.queue.writeBuffer(bundle.args, 0, indirect);
    d.queue.writeBuffer(bundle.params, 0, params);
    r.endPass();
    const pass = r.enc().beginComputePass();
    pass.setPipeline(this.pipeline);
    for (const {e, input, output, slot} of groups) {
      let saved = bundle.groups.get(e.g);
      if (!saved || saved.input !== input || saved.slot !== slot) {
        saved = {input, slot, group: this.r.device.createBindGroup({layout: this.pipeline.getBindGroupLayout(0), entries: [
          {binding: 0, resource: {buffer: input}},
          {binding: 1, resource: {buffer: output}},
          {binding: 2, resource: {buffer: bundle.args}},
          {binding: 3, resource: {buffer: bundle.params, offset: slot * 256, size: 128}}]})};
        bundle.groups.set(e.g, saved);
      }
      pass.setBindGroup(0, saved.group);
      pass.dispatchWorkgroups(Math.ceil(e.instances / 64));
    }
    pass.end();
    bundle.encoder = r.encoder;
    return result;
  }
  // Level travel keeps the renderer alive while batches disappear; drop entries
  // and their per-cascade outputs once they stop appearing in main passes.
  purge(frame) {
    for (const [g, e] of this.entries) {
      if (frame - e.frame <= STALE_FRAMES) continue;
      this.entries.delete(g);
      for (const bundle of this.bundles) {
        if (!bundle) continue; // Earlier cascades may have no renderable casters.
        const output = bundle.outputs?.get(g);
        if (!output) continue;
        this.r.retired.push(output);
        bundle.outputs.delete(g);
        bundle.groups?.delete(g);
      }
    }
  }
  release() {
    for (const bundle of this.bundles) {
      if (!bundle) continue;
      if (bundle.args) this.r.retired.push(bundle.args);
      if (bundle.params) this.r.retired.push(bundle.params);
      for (const output of bundle.outputs?.values() ?? []) this.r.retired.push(output);
    }
    this.bundles = [];
    this.entries.clear();
    this.jobs = null;
    this.cascade = 0;
  }
  // Diagnostic-only readback of the last compacted indirect arguments.
  async counts() {
    const used = this.bundles.filter(b => b.args);
    if (!used.length) return null;
    this.r.endPass();
    const copies = used.map(bundle => {
      const staging = this.r.device.createBuffer({size: bundle.args.size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
      this.r.enc().copyBufferToBuffer(bundle.args, 0, staging, 0, staging.size);
      return {staging, jobCount: bundle.jobCount};
    });
    this.r.flush();
    const result = [];
    for (const {staging, jobCount} of copies) {
      await staging.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(staging.getMappedRange());
      let draws = 0, instances = 0, triangles = 0;
      for (let i = 0; i < jobCount * 5; i += 5) {
        if (!words[i + 1]) continue;
        draws++;
        instances += words[i + 1];
        triangles += words[i] * words[i + 1] / 3;
      }
      result.push({draws, instances, triangles});
      staging.unmap();
      staging.destroy();
    }
    return result;
  }
}
