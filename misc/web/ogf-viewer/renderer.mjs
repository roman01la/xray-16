import {decodeDds, readDds} from './dds.mjs';

const vertexSource = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec2 uv;
uniform vec3 center;
uniform mat3 camera;
uniform vec3 scale;
out vec3 viewNormal;
out vec2 texcoord;
void main() {
  vec3 p = camera * (position - center);
  gl_Position = vec4(p * scale, 1.0);
  viewNormal = camera * normal;
  texcoord = uv;
}`;

const fragmentSource = `#version 300 es
precision highp float;
in vec3 viewNormal;
in vec2 texcoord;
uniform sampler2D surface;
uniform bool wireframe;
uniform bool alphaTest;
out vec4 color;
void main() {
  if (wireframe) {
    color = vec4(0.85, 0.72, 0.48, 1.0);
    return;
  }
  vec4 sampleColor = texture(surface, texcoord);
  if (alphaTest && sampleColor.a < 0.12) discard;
  vec3 n = viewNormal / max(length(viewNormal), 0.001);
  float key = max(dot(n, normalize(vec3(-0.45, 0.7, 0.75))), 0.0);
  float fill = max(dot(n, normalize(vec3(0.7, 0.2, -0.5))), 0.0);
  color = vec4(sampleColor.rgb * (0.56 + 0.44 * key + 0.19 * fill), 1.0);
}`;

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {alpha: true, antialias: true});
  if (!gl) throw new Error('WebGL 2 is required to display the model.');
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
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
  const uniforms = Object.fromEntries(['center', 'camera', 'scale', 'surface', 'wireframe', 'alphaTest']
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

  const fallback = texture({width: 1, height: 1, pixels: new Uint8Array([169, 174, 158, 255])});
  const upload = (target, data, usage = gl.STATIC_DRAW) => {
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, usage);
    return buffer;
  };
  function createMesh(vertices, indices, isMap) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vertexBuffer = upload(gl.ARRAY_BUFFER, vertices, isMap ? gl.STATIC_DRAW : gl.DYNAMIC_DRAW);
    for (const [location, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 2, 24]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 32, offset);
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
    return {vao, vertexBuffer, triangleBuffer, lineBuffer, count: indices.length};
  }

  function draw(meshes, view) {
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
    if (!meshes.length) return;

    const sinYaw = Math.sin(view.yaw), cosYaw = Math.cos(view.yaw);
    const sinPitch = Math.sin(view.pitch), cosPitch = Math.cos(view.pitch);
    const scale = view.zoom * 0.96 / view.radius;
    const ratio = width / height;
    gl.useProgram(program);
    gl.enable(gl.DEPTH_TEST);
    gl.uniform3fv(uniforms.center, view.center);
    gl.uniformMatrix3fv(uniforms.camera, false, [
      cosYaw, -sinYaw * sinPitch, sinYaw * cosPitch,
      0, cosPitch, sinPitch,
      -sinYaw, -cosYaw * sinPitch, cosYaw * cosPitch,
    ]);
    gl.uniform3f(uniforms.scale, scale / Math.max(1, ratio), scale * Math.min(1, ratio), -0.92 / view.radius);
    gl.uniform1i(uniforms.surface, 0);
    gl.uniform1i(uniforms.wireframe, view.wireframe);
    gl.activeTexture(gl.TEXTURE0);
    for (const mesh of meshes) {
      gl.bindVertexArray(mesh.vao);
      gl.bindTexture(gl.TEXTURE_2D, mesh.texture ?? fallback);
      // X-Ray's opaque model shaders can use the diffuse alpha for gloss.
      const foliage = view.isMap && /^flora[\\/](?:leaf|grass)/i.test(mesh.shader);
      gl.uniform1i(uniforms.alphaTest, foliage || /aref|alpha_test/i.test(mesh.shader));
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, view.wireframe ? mesh.lineBuffer : mesh.triangleBuffer);
      gl.drawElements(view.wireframe ? gl.LINES : gl.TRIANGLES,
        mesh.count * (view.wireframe ? 2 : 1), gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  return {
    draw, texture, mapTexture, maxTextureSize, createMesh,
    updateMesh(mesh, vertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertexBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
    },
    deleteTexture(handle) { gl.deleteTexture(handle); },
    deleteMesh(mesh) {
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.vertexBuffer);
      gl.deleteBuffer(mesh.triangleBuffer);
      gl.deleteBuffer(mesh.lineBuffer);
    },
  };
}
