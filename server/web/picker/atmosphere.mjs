// The overlay is composed in wallpaper coordinates so effects and foliage
// follow the same center/cover crop as the photographic background.
const wallpaperAspect = 1672 / 941;
const frameInterval = 1000 / 30;
const common = /* wgsl */ `
struct Scene {
  cover: vec2f,
  seconds: f32,
  soc: f32,
}
@group(0) @binding(0) var<uniform> scene: Scene;

fn hash(p: vec2f) -> f32 {
  let v = fract(p * vec2f(0.1031, 0.11369));
  return fract((v.x + v.y) * (v.x + dot(v, v.yx + 19.19)) * 37.73);
}
fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1, 0)), w.x),
             mix(hash(i + vec2f(0, 1)), hash(i + vec2f(1, 1)), w.x), w.y);
}
fn cloud(p: vec2f) -> f32 {
  return noise(p) * 0.57 + noise(p * 2.07 + 11.7) * 0.28 +
         noise(p * 4.19 - 8.2) * 0.15;
}
fn color(rgb: vec3f, alpha: f32) -> vec4f {
  return vec4f(rgb * alpha, alpha);
}
fn over(top: vec4f, bottom: vec4f) -> vec4f {
  return top + bottom * (1.0 - top.a);
}
`;
const air = common + /* wgsl */ `
struct Screen {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}
@vertex fn screen(@builtin(vertex_index) vertex: u32) -> Screen {
  let p = vec2f(f32((vertex << 1u) & 2u), f32(vertex & 2u));
  return Screen(vec4f(p * vec2f(2, -2) + vec2f(-1, 1), 0, 1), p);
}
fn marsh(uv: vec2f, t: f32) -> vec4f {
  // The waterline starts below the ship deck and fades into both banks.
  let low = smoothstep(0.49, 0.64, uv.y) * (1.0 - smoothstep(0.77, 0.94, uv.y));
  let channel = smoothstep(0.18, 0.39, uv.x) * (1.0 - smoothstep(0.75, 1.02, uv.x));
  let ribbons = cloud(uv * vec2f(6, 27) - vec2f(t * 0.19, t * 0.027));
  let wisps = cloud(uv * vec2f(11, 53) - vec2f(t * 0.28, 3.0));
  let mist = low * (0.24 + 0.76 * channel) *
    (smoothstep(0.30, 0.81, ribbons) * 0.22 + smoothstep(0.46, 0.87, wisps) * 0.085);
  let reflection = smoothstep(0.76, 0.85, uv.y) * (1.0 - smoothstep(0.95, 1.0, uv.y))
    * smoothstep(0.28, 0.42, uv.x) * (1.0 - smoothstep(0.59, 0.72, uv.x));
  let glints = smoothstep(0.79, 1.0, sin(uv.y * 355.0 + noise(vec2f(uv.x * 14.0, t * 0.18)) * 4.0 - t * 0.9))
    * noise(vec2f(uv.x * 18.0 - t * 0.36, uv.y * 9.0)) * reflection * 0.035;
  return over(color(vec3f(0.56, 0.61, 0.59), glints), color(vec3f(0.48, 0.52, 0.50), mist));
}
fn roadside(uv: vec2f, t: f32) -> vec4f {
  // Thin rain reads against the darker rail embankment and roadside trees.
  let mistMask = smoothstep(0.48, 0.64, uv.y) * (1.0 - smoothstep(0.71, 0.91, uv.y));
  let mist = cloud(uv * vec2f(9, 30) + vec2f(t * 0.24, -t * 0.04));
  let streakUV = vec2f(uv.x + uv.y * 0.13, uv.y) * vec2f(145, 18);
  let column = floor(streakUV.x);
  let speed = mix(6.0, 11.0, hash(vec2f(column, 2.0)));
  let drops = vec2f(streakUV.x, streakUV.y - t * speed);
  let cell = floor(drops);
  let seed = hash(cell);
  let pos = fract(drops);
  let offset = mix(0.18, 0.82, hash(cell + 13.1));
  let strand = (1.0 - smoothstep(0.012, 0.12, abs(pos.x - offset))) *
    smoothstep(0.24, 0.42, pos.y) * (1.0 - smoothstep(0.52, 0.91, pos.y));
  let rain = strand * smoothstep(0.74, 0.96, seed) *
    smoothstep(0.12, 0.42, uv.y) * (1.0 - smoothstep(0.95, 1.06, uv.y)) * 0.14;
  return over(color(vec3f(0.66, 0.70, 0.70), rain),
              color(vec3f(0.49, 0.51, 0.49), mistMask * smoothstep(0.30, 0.81, mist) * 0.14));
}
@fragment fn weather(in: Screen) -> @location(0) vec4f {
  let uv = (in.uv - 0.5) * scene.cover + 0.5;
  if (scene.soc <= 0.0) { return marsh(uv, scene.seconds); }
  if (scene.soc >= 1.0) { return roadside(uv, scene.seconds); }
  return mix(marsh(uv, scene.seconds), roadside(uv, scene.seconds), scene.soc);
}
`;
const plants = common + /* wgsl */ `
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var filtering: sampler;

struct Leaf {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) shade: f32,
  @location(2) opacity: f32,
}
@vertex fn sway(@location(0) local: vec3f, @location(1) uv: vec2f,
               @location(2) placement: vec4f, @location(3) material: vec2f) -> Leaf {
  let h = max(0.0, local.y);
  let angle = placement.w;
  let x = local.x * cos(angle) - local.z * sin(angle);
  let z = local.x * sin(angle) + local.z * cos(angle);
  let t = scene.seconds;
  let gust = sin(t * 1.4 + placement.x * 11.0) * 0.059 +
             sin(t * 2.8 + placement.y * 18.0) * 0.023;
  let bend = h * h * (gust + mix(0.07, -0.08, material.x));
  let point = placement.xy + vec2f((x + bend) * ${1 / wallpaperAspect}, -h + z * 0.13) * placement.z;
  let screen = (point - 0.5) / scene.cover + 0.5;
  let weight = mix(1.0 - scene.soc, scene.soc, material.x);
  let shade = material.y * mix(0.67, 1.09, clamp(h, 0.0, 1.0));
  return Leaf(vec4f(screen * vec2f(2, -2) + vec2f(-1, 1), 0, 1), uv, shade, weight);
}
@fragment fn leaf(in: Leaf) -> @location(0) vec4f {
  let texel = textureSample(atlas, filtering, in.uv);
  let alpha = smoothstep(0.15, 0.82, texel.a) * in.opacity * 0.82;
  let luminance = dot(texel.rgb, vec3f(0.26, 0.60, 0.14));
  let dusk = mix(texel.rgb, vec3f(1.06, 0.98, 0.85) * luminance, 0.47);
  return color(dusk * in.shade, alpha);
}
`;

// Anchor, height, rotation, and exposure are in the source wallpaper's frame.
const vegetation = {
  cop: { texture: 'reeds.webp', scene: 0, placements: [
    [0.018, 1.011, 0.200, 0.53, 0.72], [0.056, 0.989, 0.144, 1.22, 0.75],
    [0.100, 0.969, 0.113, 2.01, 0.82], [0.169, 0.942, 0.072, 0.42, 0.76],
    [0.817, 0.919, 0.080, 1.62, 0.73], [0.878, 0.967, 0.112, 0.74, 0.78],
    [0.958, 0.988, 0.163, 2.16, 0.71], [1.004, 1.015, 0.210, 0.37, 0.72],
  ] },
  soc: { texture: 'brush.webp', scene: 1, placements: [
    [0.041, 0.990, 0.162, 0.87, 0.70], [0.128, 0.967, 0.118, 1.67, 0.73],
    [0.207, 0.957, 0.089, 0.33, 0.80], [0.271, 0.965, 0.063, 2.14, 0.73],
    [0.747, 0.971, 0.070, 1.00, 0.79], [0.826, 0.974, 0.112, 1.61, 0.77],
    [0.915, 0.987, 0.154, 0.65, 0.67], [0.981, 1.012, 0.185, 2.43, 0.69],
  ] },
};
const blend = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
};

function upload(device, data, usage) {
  const buffer = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
  new data.constructor(buffer.getMappedRange()).set(data);
  buffer.unmap();
  return buffer;
}

async function plantMesh(device, pipeline, uniform, sampler, model, { texture, scene, placements }, signal) {
  const response = await fetch(new URL(texture, import.meta.url), { signal });
  if (!response.ok) throw Error('Could not load picker vegetation texture');
  const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none' });
  try {
    signal.throwIfAborted();
    const atlas = device.createTexture({
      size: [image.width, image.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image }, { texture: atlas }, [image.width, image.height]);
    return {
      vertices: upload(device, Float32Array.from(model.vertices), GPUBufferUsage.VERTEX),
      indices: upload(device, Uint16Array.from(model.indices), GPUBufferUsage.INDEX),
      instances: upload(device, Float32Array.from(placements.flatMap(([x, y, h, angle, shade]) =>
        [x, y, h, angle, scene, shade])), GPUBufferUsage.VERTEX),
      indexCount: model.indices.length,
      instanceCount: placements.length,
      bindGroup: device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniform } },
          { binding: 1, resource: atlas.createView() },
          { binding: 2, resource: sampler },
        ],
      }),
    };
  } finally {
    image.close();
  }
}

export async function startAtmosphere(canvas, socBackdrop, signal) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
  if (!adapter || signal.aborted) return;
  const context = canvas.getContext('webgpu');
  if (!context) return;
  const device = await adapter.requestDevice();
  if (signal.aborted) { device.destroy(); return; }

  let frame, disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    signal.removeEventListener('abort', dispose);
    canvas.hidden = true;
    context.unconfigure();
    device.destroy();
  };
  signal.addEventListener('abort', dispose, { once: true });
  device.lost.then(dispose);

  try {
    const format = navigator.gpu.getPreferredCanvasFormat();
    const fog = device.createShaderModule({ code: air });
    const foliage = device.createShaderModule({ code: plants });
    const weatherPipeline = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: fog, entryPoint: 'screen' },
      fragment: { module: fog, entryPoint: 'weather', targets: [{ format }] },
    });
    const plantPipeline = device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: foliage, entryPoint: 'sway', buffers: [
        { arrayStride: 20, attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x2' },
        ] },
        { arrayStride: 24, stepMode: 'instance', attributes: [
          { shaderLocation: 2, offset: 0, format: 'float32x4' },
          { shaderLocation: 3, offset: 16, format: 'float32x2' },
        ] },
      ] },
      fragment: { module: foliage, entryPoint: 'leaf', targets: [{ format, blend }] },
    });
    const vegetationData = fetch(new URL('vegetation.json', import.meta.url), { signal })
      .then(response => {
        if (!response.ok) throw Error('Could not load picker vegetation meshes');
        return response.json();
      });
    const [weather, plant, models] = await Promise.all([weatherPipeline, plantPipeline, vegetationData]);
    if (disposed) return;
    const data = new Float32Array(4);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const meshes = await Promise.all(Object.entries(vegetation).map(async ([game, style]) =>
      plantMesh(device, plant, uniform, sampler, models[game], style, signal)));
    if (disposed) return;
    const weatherBindGroup = device.createBindGroup({
      layout: weather.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    context.configure({ device, format, alphaMode: 'premultiplied' });
    canvas.hidden = false;

    let last = -Infinity;
    const started = performance.now();
    const draw = now => {
      if (disposed) return;
      frame = requestAnimationFrame(draw);
      if (now - last < frameInterval - 1) return;
      last = now;

      const w = innerWidth, h = innerHeight;
      if (!w || !h) return;
      const density = Math.min(0.9, 1120 / w, 640 / h);
      const width = Math.max(1, Math.round(w * density));
      const height = Math.max(1, Math.round(h * density));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;

      data[0] = Math.min(1, w / h / wallpaperAspect);
      data[1] = Math.min(1, h / w * wallpaperAspect);
      data[2] = (now - started) * 0.001;
      data[3] = Number(getComputedStyle(socBackdrop).opacity);
      device.queue.writeBuffer(uniform, 0, data);

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{
        view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
        clearValue: [0, 0, 0, 0],
      }] });
      pass.setPipeline(weather);
      pass.setBindGroup(0, weatherBindGroup);
      pass.draw(3);
      pass.setPipeline(plant);
      for (const [i, mesh] of meshes.entries()) {
        if ((i === 0 && data[3] >= 1) || (i === 1 && data[3] <= 0)) continue;
        pass.setBindGroup(0, mesh.bindGroup);
        pass.setVertexBuffer(0, mesh.vertices);
        pass.setVertexBuffer(1, mesh.instances);
        pass.setIndexBuffer(mesh.indices, 'uint16');
        pass.drawIndexed(mesh.indexCount, mesh.instanceCount);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    };
    frame = requestAnimationFrame(draw);
  } catch (error) {
    dispose();
    throw error;
  }
}
