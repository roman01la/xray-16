import {decodeDds, decodeDdsCube, readDds} from './dds.mjs';
import {createParticleRenderer, createSceneTexture} from './particle-renderer.mjs';
import {createEnvironmentRenderer} from './environment-renderer.mjs';
import {createSunShadow} from './sun-shadow.mjs';

const vertexSource = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
layout(location=3) in float windWeight;
layout(location=4) in vec4 instanceTransform;
layout(location=5) in vec3 instanceParams;
uniform bool grass;
out float groundLight;
uniform vec2 treeWind;
uniform vec4 treeWave;
uniform vec3 center;
uniform mat3 camera;
uniform vec3 scale;
out vec3 viewNormal;
out vec2 texcoord;
out vec3 effectPosition;
void main() {
  vec3 world = position;
  float sway = windWeight;
  groundLight = 1.0;
  if (grass) {
    float c = instanceParams.x, s = instanceParams.y;
    world.xz = mat2(c, s, -s, c) * world.xz;
    world = world * instanceTransform.w + instanceTransform.xyz;
    sway *= instanceTransform.w * 3.2;
    groundLight = instanceParams.z;
  }
  float wave = 1.41421356 * fract(dot(world, treeWave.xyz) + treeWave.w) - 0.70710678;
  world.xz += treeWind * sway * (wave * wave + 0.5);
  vec3 p = camera * (world - center);
  gl_Position = vec4(p * scale, 1.0);
  viewNormal = camera * normal;
  texcoord = uv;
  effectPosition = world;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 viewNormal;
in vec2 texcoord;
in vec3 effectPosition;
in float groundLight;
uniform vec3 effectLightPosition;
uniform vec3 effectLightColor;
uniform float effectLightRange;
uniform sampler2D surface;
uniform bool wireframe;
uniform bool alphaTest;
uniform bool distortion;
uniform sampler2D scene;
uniform vec2 resolution;
uniform int terrainMode;
uniform float terrainScale;
uniform bool terrainHasBase;
uniform sampler2D terrainMask;
uniform sampler2D terrainLayers[4];
uniform bool weather;
uniform bool liquid;
uniform vec3 cameraCenter;
uniform vec3 worldSun;
uniform vec3 sunLight;
uniform vec3 ambientLight;
uniform vec3 hemiLight;
uniform vec3 fogColor;
uniform vec3 waterSkyColor;
uniform vec4 atmos;
uniform float waterIntensity;
uniform samplerCube waterSkyA;
uniform samplerCube waterSkyB;
uniform sampler2D waterNormal;
uniform sampler2D waterDepth;
uniform bool hasWaterDepth;
uniform vec2 waterSkyRotation;
uniform float waterSkyBlend;
uniform vec2 waterWind;
uniform float waterDepthScale;
uniform mat3 weatherCamera;
uniform bool shadowEnabled;
uniform highp sampler2DShadow sunDepth;
uniform vec3 shadowCenter;
uniform mat3 shadowCamera;
uniform vec3 shadowScale;
out vec4 color;
vec3 rotateSky(vec3 ray, float angle) {
  float c = cos(angle), s = sin(angle);
  ray.xz = mat2(c, s, -s, c) * ray.xz;
  return ray;
}

vec4 shadeWater(vec4 base) {
  vec2 p = effectPosition.xz;
  vec2 drift = waterWind * atmos.w;
  vec2 coarse = texture(waterNormal, p * 0.16 + drift).rg - 0.5;
  vec2 fine = texture(waterNormal, mat2(0.8, 0.6, -0.6, 0.8) * p * 0.37 - drift.yx * 0.73).rg - 0.5;
  vec3 normal = normalize(vec3(coarse.x * 1.4 + fine.x, 1.0, coarse.y * 1.4 + fine.y));
  vec3 look = transpose(weatherCamera) * vec3(0.0, 0.0, -1.0);
  float facing = clamp(dot(-look, normal), 0.0, 1.0);
  float fresnel = pow(1.0 - facing, 5.0);

  vec3 reflectedRay = reflect(look, normal);
  vec3 reflected = mix(texture(waterSkyA, rotateSky(reflectedRay, waterSkyRotation.x)).rgb,
    texture(waterSkyB, rotateSky(reflectedRay, waterSkyRotation.y)).rgb, waterSkyBlend) * waterSkyColor;
  float sunGlint = pow(max(0.0, dot(reflectedRay, worldSun)), 120.0);
  vec3 tint = max(0.3, waterIntensity) * mix(vec3(0.060, 0.108, 0.103), base.rgb, 0.55);
  vec3 water = mix(tint, reflected + sunGlint * sunLight * 0.7, 0.13 + 0.76 * fresnel);
  // The authored base alpha carries surface material such as duckweed.
  water = mix(water, base.rgb * waterSkyColor, base.a * 0.72);

  float opacity = 0.90;
  if (hasWaterDepth) {
    float sceneDepth = texelFetch(waterDepth, ivec2(gl_FragCoord.xy), 0).r;
    if (sceneDepth < 1.0) {
      float depth = max(0.0, (sceneDepth - gl_FragCoord.z) * waterDepthScale);
      float shore = smoothstep(0.015, 0.35, depth);
      float absorption = 1.0 - exp(-depth * 1.9);
      opacity = shore * (0.24 + 0.66 * absorption);
    }
  }
  opacity = mix(opacity, 1.0, fresnel * opacity * 0.8);
  float fog = weather ? smoothstep(atmos.x, atmos.y, distance(effectPosition, cameraCenter)) : 0.0;
  return vec4(mix(water, fogColor, fog * 0.88), opacity);
}

void main() {
  if (wireframe) {
    color = vec4(0.85, 0.72, 0.48, 1.0);
    return;
  }
  vec4 sampleColor = texture(surface, texcoord);
  if (liquid) {
    color = shadeWater(sampleColor);
    return;
  }
  if (distortion) {
    vec2 offset = (sampleColor.rg - vec2(0.5)) * 0.025;
    vec4 background = texture(scene, gl_FragCoord.xy / resolution + offset);
    if (background.a > 0.75) color = vec4(background.rgb / background.a, 0.65);
    else color = vec4(0.65, 0.73, 0.77, min(0.13, length(offset) * 8.0));
    return;
  }
  if (terrainMode != 0) {
    vec2 tiled = texcoord * terrainScale;
    vec3 detail = texture(terrainLayers[0], tiled).rgb;
    if (terrainMode == 2) {
      vec4 weight = texture(terrainMask, texcoord);
      float sum = dot(weight, vec4(1.0));
      if (sum > 0.001) {
        detail = (detail * weight.r +
          texture(terrainLayers[1], tiled).rgb * weight.g +
          texture(terrainLayers[2], tiled).rgb * weight.b +
          texture(terrainLayers[3], tiled).rgb * weight.a) / sum;
      }
    }
    sampleColor = vec4(terrainHasBase ? 2.0 * sampleColor.rgb * detail : detail, 1.0);
  }
  if (alphaTest && sampleColor.a < 0.12) discard;
  vec3 n = viewNormal / max(length(viewNormal), 0.001);
  float key = max(dot(n, normalize(vec3(-0.45, 0.7, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.7, 0.2, -0.5))), 0.0);
  float light = max(0.0, 1.0 - distance(effectPosition, effectLightPosition) / max(0.001, effectLightRange));
  vec3 lighting = vec3(0.56 + 0.44 * key + 0.19 * fill);
  if (weather) {
    vec3 worldNormal = transpose(weatherCamera) * n;
    float diffuseSun = max(0.0, dot(worldNormal, worldSun));
    if (shadowEnabled && diffuseSun > 0.0) {
      vec3 shadow = ((shadowCamera * (effectPosition - shadowCenter)) * shadowScale) * 0.5 + 0.5;
      if (all(greaterThan(shadow, vec3(0.0))) && all(lessThan(shadow, vec3(1.0)))) {
        shadow.z -= mix(0.0005, 0.00016, diffuseSun);
        diffuseSun *= mix(0.26, 1.0, texture(sunDepth, shadow));
      }
    }
    lighting = vec3(0.065) + ambientLight * 1.65 + hemiLight * (0.45 + 0.39 * max(0.0, worldNormal.y)) +
      sunLight * diffuseSun * 0.92;
    sampleColor.rgb *= 1.0 - atmos.z * 0.18;
  }
  vec3 lit = sampleColor.rgb * groundLight * (lighting + effectLightColor * light * light);
  float fog = weather ? smoothstep(atmos.x, atmos.y, distance(effectPosition, cameraCenter)) : 0.0;
  color = vec4(mix(lit, fogColor, fog * 0.88), 1.0);
}`;

const pickFragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec2 texcoord;
uniform sampler2D surface;
uniform bool alphaTest;
out vec4 color;
void main() {
  if (alphaTest && texture(surface, texcoord).a < 0.12) discard;
  uint depth = uint(gl_FragCoord.z * 16777215.0);
  color = vec4(vec3(float(depth >> 16u), float((depth >> 8u) & 255u), float(depth & 255u)) / 255.0, 1.0);
}`;

function cameraMatrix(view) {
  const sinYaw = Math.sin(view.yaw), cosYaw = Math.cos(view.yaw);
  const sinPitch = Math.sin(view.pitch), cosPitch = Math.cos(view.pitch);
  return [
    cosYaw, -sinYaw * sinPitch, sinYaw * cosPitch,
    0, cosPitch, sinPitch,
    -sinYaw, -cosYaw * sinPitch, cosYaw * cosPitch,
  ];
}

function orthographicScale(view, ratio) {
  const scale = view.zoom * 0.96 / view.radius;
  return [scale / Math.max(1, ratio), scale * Math.min(1, ratio), -0.92 / view.radius];
}

function alphaTest(mesh, isMap) {
  // X-Ray's opaque model shaders can use the diffuse alpha for gloss.
  return mesh.grass || (isMap && /^flora[\\/](?:leaf|grass)/i.test(mesh.shader)) ||
    /aref|alpha_test/i.test(mesh.shader);
}

function cutawayCover(mesh) {
  // Some interiors have a separate no-sun shell outside the playable space.
  return /^prop[\\/]prop_fake_nosun$/i.test(mesh.name);
}

function intersectsViewRay(mesh, center, direction, maxDepth) {
  let near = -maxDepth, far = maxDepth;
  for (let axis = 0; axis < 3; axis++) {
    const low = mesh.lower[axis] - center[axis], high = mesh.upper[axis] - center[axis];
    if (Math.abs(direction[axis]) < 1e-8) {
      if (low > 0 || high < 0) return false;
      continue;
    }
    const a = low / direction[axis], b = high / direction[axis];
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return true;
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {alpha: true, antialias: true, stencil: true});
  if (!gl) throw new Error('WebGL 2 is required to display the model.');
  const depthFormat = gl.getParameter(gl.DEPTH_BITS) === 32
    ? [gl.DEPTH32F_STENCIL8, gl.FLOAT_32_UNSIGNED_INT_24_8_REV]
    : [gl.DEPTH24_STENCIL8, gl.UNSIGNED_INT_24_8];
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  function link(vertexSource, fragmentSource) {
    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    return program;
  }

  const program = link(vertexSource, fragmentSource);
  const environment = createEnvironmentRenderer(gl, link);
  const sunShadow = createSunShadow(gl, link);
  const sceneTexture = createSceneTexture(gl);
  const drawParticles = createParticleRenderer(gl, link, sceneTexture);
  const uniforms = Object.fromEntries(['center', 'camera', 'scale', 'surface', 'wireframe', 'alphaTest',
    'effectLightPosition', 'effectLightColor', 'effectLightRange', 'distortion', 'scene', 'resolution', 'terrainMode',
    'terrainScale', 'terrainHasBase', 'terrainMask', 'terrainLayers[0]', 'treeWind', 'treeWave', 'weather',
    'liquid', 'cameraCenter', 'worldSun', 'sunLight', 'ambientLight', 'hemiLight', 'fogColor', 'waterSkyColor',
    'atmos', 'waterIntensity', 'waterSkyA', 'waterSkyB', 'waterSkyRotation', 'waterSkyBlend',
    'waterDepth', 'hasWaterDepth', 'waterDepthScale', 'waterNormal', 'waterWind', 'weatherCamera', 'sunDepth', 'shadowCenter', 'shadowCamera',
    'shadowScale', 'shadowEnabled', 'grass']
    .map(name => [name, gl.getUniformLocation(program, name)]));

  function texture(image) {
    const handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.width, image.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, image.pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
    return handle;
  }
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
  const anisotropic = gl.getExtension('EXT_texture_filter_anisotropic');
  const maxAnisotropy = anisotropic ? gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  const compressedFormats = s3tc && {
    DXT1: s3tc.COMPRESSED_RGBA_S3TC_DXT1_EXT,
    DXT3: s3tc.COMPRESSED_RGBA_S3TC_DXT3_EXT,
    DXT5: s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT,
  };

  function mapTexture(buffer) {
    const {format, width, height, blockSize, mipCount} = readDds(buffer, maxTextureSize);
    const internalFormat = compressedFormats?.[format];
    // Keep the authored mip chain in GPU memory as DXT blocks where supported.
    // Power-of-two dimensions satisfy S3TC block alignment at every mip level.
    if (!internalFormat || mipCount < 2 || (width & (width - 1)) || (height & (height - 1)))
      return texture(decodeDds(buffer, maxTextureSize));

    const mips = [];
    let offset = 128;
    for (let level = 0; level < mipCount; level++) {
      const w = Math.max(1, width >> level), h = Math.max(1, height >> level);
      const length = Math.ceil(w / 4) * Math.ceil(h / 4) * blockSize;
      if (offset + length > buffer.byteLength) break;
      mips.push({w, h, data: new Uint8Array(buffer, offset, length)});
      offset += length;
    }
    if (mips.length < 2) return texture(decodeDds(buffer, maxTextureSize));

    const handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    for (const [level, {w, h, data}] of mips.entries())
      gl.compressedTexImage2D(gl.TEXTURE_2D, level, internalFormat, w, h, 0, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, mips.length - 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return handle;
  }

  function skyTexture(bytes) {
    const faces = decodeDdsCube(bytes);
    const handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, handle);
    for (const [i, {width, height, pixels}] of faces.entries())
      gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    return handle;
  }
  function terrainTexture(bytes) {
    const handle = mapTexture(bytes);
    if (anisotropic)
      gl.texParameterf(gl.TEXTURE_2D, anisotropic.TEXTURE_MAX_ANISOTROPY_EXT, maxAnisotropy);
    return handle;
  }
  const emptyCloud = texture({width: 1, height: 1, pixels: new Uint8Array([0, 0, 0, 0])});
  const detailFallback = texture({width: 1, height: 1, pixels: new Uint8Array([128, 128, 128, 255])});
  const waterBaseFallback = texture({width: 1, height: 1, pixels: new Uint8Array([31, 48, 45, 0])});
  const fallback = texture({width: 1, height: 1, pixels: new Uint8Array([169, 174, 158, 255])});
  const upload = (target, data, usage = gl.STATIC_DRAW) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, usage);
    return buffer;
  };
  function createMesh(vertices, indices, isMap, windWeights) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertexBuffer = upload(gl.ARRAY_BUFFER, vertices, isMap ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
    for (const [location, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
    }
    let windBuffer = null;
    if (windWeights) {
      windBuffer = upload(gl.ARRAY_BUFFER, windWeights);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 4, 0);
    }
    const triangleBuffer = upload(gl.ELEMENT_ARRAY_BUFFER, indices);
    let lineBuffer = null;
    if (!isMap) {
      const lines = new Uint16Array(indices.length * 2);
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        lines.set([a, b, b, c, c, a], i * 2);
      }
      lineBuffer = upload(gl.ELEMENT_ARRAY_BUFFER, lines);
    }
    gl.bindVertexArray(null);
    return {vao, vertexBuffer, windBuffer, triangleBuffer, lineBuffer, count: indices.length};
  }

  function updateGrassInstances(mesh, data) {
    mesh.instances = data.length / 7;
    if (!mesh.instances) return;
    gl.bindVertexArray(mesh.vao);
    if (!mesh.instanceBuffer) {
      mesh.instanceBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceBuffer);
      for (const [location, size, offset] of [[4, 4, 0], [5, 3, 16]]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, 28, offset);
        gl.vertexAttribDivisor(location, 1);
      }
    } else gl.bindBuffer(gl.ARRAY_BUFFER, mesh.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);
  }

  let pick;
  function createPickingBuffer() {
    const program = link(vertexSource, pickFragmentSource);
    const uniforms = Object.fromEntries(['center', 'camera', 'scale', 'surface', 'alphaTest', 'grass',
      'treeWind', 'treeWave'].map(name => [name, gl.getUniformLocation(program, name)]));
    const framebuffer = gl.createFramebuffer();
    const color = gl.createTexture(), depth = gl.createRenderbuffer();
    gl.bindTexture(gl.TEXTURE_2D, color);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 1, 1);
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    return {program, framebuffer, uniforms, pixel: new Uint8Array(4)};
  }

  function setCutaway(mode) {
    if (mode) {
      gl.cullFace(mode === 'front' ? gl.FRONT : gl.BACK);
      gl.enable(gl.CULL_FACE);
    } else {
      gl.disable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
    }
  }

  function orbitTarget(meshes, view, weather) {
    gl.activeTexture(gl.TEXTURE0);
    pick ??= createPickingBuffer();
    const {program, framebuffer, uniforms, pixel} = pick;
    const camera = cameraMatrix(view);
    const scale = orthographicScale(view, canvas.width / canvas.height);
    const direction = [camera[2], camera[5], camera[8]];
    // Zoom the picking viewport to cover just the center pixel of the view.
    const pixelScale = [scale[0] * canvas.width, scale[1] * canvas.height, scale[2]];
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(0, 0, 1, 1);
    gl.disable(gl.DITHER);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(program);
    gl.uniform3fv(uniforms.center, view.center);
    gl.uniformMatrix3fv(uniforms.camera, false, camera);
    gl.uniform3fv(uniforms.scale, pixelScale);
    gl.uniform1i(uniforms.surface, 0);
    gl.uniform1i(uniforms.grass, false);
    setTreeWind(uniforms, weather);
    if (view.cutaway) setCutaway(view.cutaway);
    for (const mesh of meshes) {
      if (mesh.water || mesh.distortion || (view.cutaway && cutawayCover(mesh))) continue;
      if (!intersectsViewRay(mesh, view.center, direction, -1 / scale[2])) continue;
      gl.bindVertexArray(mesh.vao);
      gl.bindTexture(gl.TEXTURE_2D, mesh.texture ?? fallback);
      gl.uniform1i(uniforms.alphaTest, alphaTest(mesh, true));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.triangleBuffer);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (view.cutaway) setCutaway('');
    gl.enable(gl.DITHER);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!pixel[3]) return null;
    const depth = (pixel[0] * 65536 + pixel[1] * 256 + pixel[2]) / 16777215;
    const offset = (depth * 2 - 1) / scale[2];
    return view.center.map((coord, axis) => coord + direction[axis] * offset);
  }

  function setTreeWind(uniforms, weather) {
    if (weather) {
      const windAngle = weather.elapsed * 2 * Math.PI / Math.max(1, weather.treeRotation);
      const amplitude = weather.treeAmplitude + Math.min(0.18, weather.wind * 0.0045);
      gl.uniform2f(uniforms.treeWind, Math.sin(windAngle) * weather.treeAmplitude + Math.sin(weather.windDirection) * amplitude,
        Math.cos(windAngle) * weather.treeAmplitude + Math.cos(weather.windDirection) * amplitude);
      gl.uniform4fv(uniforms.treeWave, [...weather.treeWave.map(x => x / (2 * Math.PI)), weather.elapsed * weather.treeSpeed / (2 * Math.PI)]);
    } else {
      gl.uniform2f(uniforms.treeWind, 0, 0);
      gl.uniform4f(uniforms.treeWave, 0, 0, 0, 0);
    }
  }

  let waterDepth;
  let waterDepthSupported = true;
  function captureWaterDepth(width, height) {
    if (!waterDepthSupported) return false;
    const initialize = !waterDepth;
    waterDepth ??= {framebuffer: gl.createFramebuffer(), texture: gl.createTexture(), width: 0, height: 0};
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, waterDepth.texture);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, waterDepth.framebuffer);
    if (width !== waterDepth.width || height !== waterDepth.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, depthFormat[0], width, height, 0, gl.DEPTH_STENCIL, depthFormat[1], null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, waterDepth.texture, 0);
      gl.drawBuffers([gl.NONE]);
      waterDepth.width = width;
      waterDepth.height = height;
    }
    // Resolve the opaque depth while the default framebuffer remains the read target.
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    if (initialize && gl.getError() !== gl.NO_ERROR) {
      waterDepthSupported = false;
      gl.deleteFramebuffer(waterDepth.framebuffer);
      gl.deleteTexture(waterDepth.texture);
      waterDepth = undefined;
    }
    return waterDepthSupported;
  }

  function draw(meshes, view, particles, light, weather, grass) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!meshes.length && !particles?.buffers.size) return;

    const ratio = width / height;
    const camera = cameraMatrix(view);
    const projection = orthographicScale(view, ratio);
    const shadow = view.cutaway ? null : sunShadow.update(meshes, view, weather, fallback);
    gl.viewport(0, 0, width, height);
    if (weather) environment.sky(weather, camera, ratio, emptyCloud);
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.uniform3fv(uniforms.center, view.center);
    gl.uniformMatrix3fv(uniforms.camera, false, camera);
    gl.uniform3fv(uniforms.scale, projection);
    gl.uniform1i(uniforms.surface, 0);
    gl.uniform1i(uniforms.scene, 1);
    gl.uniform2f(uniforms.resolution, width, height);
    gl.uniform1i(uniforms.terrainMask, 2);
    gl.uniform1iv(uniforms['terrainLayers[0]'], [3, 4, 5, 6]);
    sceneTexture.bind();
    gl.uniform3fv(uniforms.effectLightColor, light?.color ?? [0, 0, 0]);
    gl.uniform3fv(uniforms.effectLightPosition, light?.position ?? [0, 0, 0]);
    gl.uniform1f(uniforms.effectLightRange, light?.range ?? 0);
    gl.uniform1i(uniforms.wireframe, view.wireframe);
    gl.uniform1i(uniforms.weather, Boolean(weather));
    gl.uniform1i(uniforms.waterSkyA, 7);
    gl.uniform1i(uniforms.waterSkyB, 9);
    gl.uniform1i(uniforms.waterDepth, 10);
    gl.uniform1i(uniforms.waterNormal, 11);
    gl.uniform1i(uniforms.sunDepth, 8);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, sunShadow.texture);
    gl.uniform1i(uniforms.shadowEnabled, Boolean(shadow));
    if (shadow) {
      gl.uniformMatrix3fv(uniforms.shadowCamera, false, shadow.camera);
      gl.uniform3fv(uniforms.shadowCenter, shadow.center);
      gl.uniform3fv(uniforms.shadowScale, shadow.scale);
    }
    gl.uniformMatrix3fv(uniforms.weatherCamera, false, camera);
    gl.uniform3fv(uniforms.cameraCenter, view.center);
    setTreeWind(uniforms, weather);
    if (weather) {
      gl.uniform3fv(uniforms.sunLight, weather.sunColor.map(x => x + weather.flash * 0.8));
      gl.uniform3fv(uniforms.worldSun, weather.sunDirection);
      gl.uniform3fv(uniforms.fogColor, weather.fogColor);
      gl.uniform3fv(uniforms.ambientLight, weather.ambientColor);
      gl.uniform3fv(uniforms.hemiLight, weather.hemiColor.slice(0, 3));
      gl.uniform3fv(uniforms.waterSkyColor, weather.skyColor);
      const fogFar = Math.max(1, Math.min(weather.fogDistance, weather.far), view.radius / (view.zoom * 2));
      const fogNear = (1 - Math.min(0.98, weather.fogDensity)) * 0.85 * fogFar;
      gl.uniform4f(uniforms.atmos, fogNear, fogFar, weather.rain, weather.elapsed);
      gl.uniform1f(uniforms.waterIntensity, weather.water);
    }
    gl.activeTexture(gl.TEXTURE0);
    let boundTerrain;
    function drawMesh(mesh) {
      const terrain = mesh.terrain;
      if (terrain !== boundTerrain) {
        gl.uniform1i(uniforms.terrainMode, terrain ? (terrain.mask ? 2 : 1) : 0);
        if (terrain) {
          gl.uniform1f(uniforms.terrainScale, terrain.scale);
          gl.uniform1i(uniforms.terrainHasBase, Boolean(mesh.texture));
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, terrain.mask ?? detailFallback);
          for (let i = 0; i < 4; i++) {
            gl.activeTexture(gl.TEXTURE3 + i);
            gl.bindTexture(gl.TEXTURE_2D, terrain.layers[i] ?? detailFallback);
          }
          gl.activeTexture(gl.TEXTURE0);
        }
        boundTerrain = terrain;
      }
      gl.bindVertexArray(mesh.vao);
      gl.bindTexture(gl.TEXTURE_2D, mesh.texture ?? (mesh.water ? waterBaseFallback : fallback));
      gl.uniform1i(uniforms.alphaTest, alphaTest(mesh, view.isMap));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, view.wireframe ? mesh.lineBuffer : mesh.triangleBuffer);
      if (mesh.grass) {
        gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, mesh.instances);
        return;
      }
      gl.drawElements(view.wireframe ? gl.LINES : gl.TRIANGLES,
        mesh.count * (view.wireframe ? 2 : 1), gl.UNSIGNED_SHORT, 0);
    }
    gl.uniform1i(uniforms.distortion, false);
    gl.uniform1i(uniforms.terrainMode, 0);
    gl.uniform1i(uniforms.liquid, false);
    gl.uniform1i(uniforms.grass, false);
    let distortions, water;
    if (view.cutaway) setCutaway(view.cutaway);
    for (const mesh of meshes) {
      if (view.cutaway && cutawayCover(mesh)) continue;
      if (mesh.water && !view.wireframe) {
        (water ??= []).push(mesh);
      } else if (mesh.distortion && !view.wireframe) (distortions ??= []).push(mesh);
      else drawMesh(mesh);
    }
    if (view.cutaway) setCutaway('');
    if (grass?.length) {
      gl.uniform1i(uniforms.grass, true);
      for (const mesh of grass) if (mesh.instances && mesh.texture) drawMesh(mesh);
      gl.uniform1i(uniforms.grass, false);
    }
    if (water) {
      gl.uniform1i(uniforms.hasWaterDepth, captureWaterDepth(width, height));
      gl.uniform1f(uniforms.waterDepthScale, 2 * Math.max(0.05, Math.abs(camera[5])) / -projection[2]);
      gl.activeTexture(gl.TEXTURE11);
      gl.bindTexture(gl.TEXTURE_2D, water[0].waterNormal ?? detailFallback);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, weather?.skies[0] ?? weather?.skies[1] ?? environment.emptySky);
      gl.activeTexture(gl.TEXTURE9);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, weather?.skies[1] ?? weather?.skies[0] ?? environment.emptySky);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(uniforms.waterSkyBlend, weather?.blend ?? 0);
      gl.uniform2f(uniforms.waterSkyRotation, (weather?.a.skyRotation ?? 0) * Math.PI / 180,
        (weather?.b.skyRotation ?? 0) * Math.PI / 180);
      const angle = weather?.windDirection ?? 0;
      const wind = (weather?.windVelocity ?? 0) * 0.001;
      gl.uniform2f(uniforms.waterWind, 0.038 + Math.sin(angle) * wind, 0.017 + Math.cos(angle) * wind);
      if (!weather) {
        gl.uniform3f(uniforms.worldSun, 0, -1, 0);
        gl.uniform3f(uniforms.sunLight, 0, 0, 0);
        gl.uniform3f(uniforms.waterSkyColor, 0.8, 0.8, 0.8);
        gl.uniform1f(uniforms.waterIntensity, 1);
        gl.uniform4f(uniforms.atmos, 0, 1, 0, 0);
      }
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(uniforms.liquid, true);
      for (const mesh of water) drawMesh(mesh);
      gl.uniform1i(uniforms.liquid, false);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    if (distortions) {
      sceneTexture.capture(width, height);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(uniforms.distortion, true);
      for (const mesh of distortions) if (mesh.texture) drawMesh(mesh);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    drawParticles(particles, view.center, camera, projection, width, height);
    if (weather) environment.rain(weather, camera, ratio);
  }

  return {
    draw, orbitTarget, texture, mapTexture, terrainTexture, skyTexture, createMesh, updateGrassInstances,
    updateMesh(mesh, vertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    },
    deleteTexture(handle) { gl.deleteTexture(handle); },
    deleteMesh(mesh) {
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.vertexBuffer);
      gl.deleteBuffer(mesh.windBuffer);
      gl.deleteBuffer(mesh.triangleBuffer);
      gl.deleteBuffer(mesh.lineBuffer);
      if (mesh.instanceBuffer) gl.deleteBuffer(mesh.instanceBuffer);
    },
  };
}
