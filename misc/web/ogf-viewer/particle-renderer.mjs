const vertexShader = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 sizeAngle;
layout(location=2) in vec4 tint;
layout(location=3) in vec4 frame;
uniform vec3 center;
uniform mat3 camera;
uniform vec3 scale;
out vec4 color;
out vec2 uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 p = (corner - 0.5) * sizeAngle.xy;
  float s = sin(sizeAngle.z), c = cos(sizeAngle.z);
  vec3 offset = vec3(mat2(c, s, -s, c) * p, 0.0);
  gl_Position = vec4((camera * (position - center) + offset) * scale, 1.0);
  uv = frame.xy + vec2(corner.x, 1.0 - corner.y) * frame.zw;
  color = tint;
}`;

const fragmentShader = `#version 300 es
precision highp float;
uniform sampler2D sprite;
uniform sampler2D background;
uniform vec2 resolution;
uniform int mode;
in vec4 color;
in vec2 uv;
out vec4 outputColor;
void main() {
  vec4 texel = texture(sprite, uv);
  if (mode == 3) {
    vec2 point = gl_FragCoord.xy / resolution;
    vec2 warp = (texel.rg - vec2(0.5)) * color.a * texel.a * 0.04;
    vec4 scene = texture(background, point + warp);
    if (scene.a > 0.75) outputColor = vec4(scene.rgb / scene.a, clamp(texel.a * color.a, 0.0, 1.0));
    else outputColor = vec4(0.59, 0.74, 0.78, min(0.18, length(warp) * 6.0));
    return;
  }
  outputColor = texel * color;
  if (mode == 1 || mode == 2) {
    outputColor.rgb *= mode == 1 ? color.a : outputColor.a;
    outputColor.a = max(outputColor.r, max(outputColor.g, outputColor.b));
  }
}`;

export function createSceneTexture(gl) {
  const snapshot = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, snapshot);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const option of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, option, gl.CLAMP_TO_EDGE);
  for (const option of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, option, gl.LINEAR);
  let snapshotWidth = 1, snapshotHeight = 1;

  return {
    bind() {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, snapshot);
      gl.activeTexture(gl.TEXTURE0);
    },
    capture(width, height) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, snapshot);
      if (snapshotWidth !== width || snapshotHeight !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        snapshotWidth = width;
        snapshotHeight = height;
      }
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
      gl.activeTexture(gl.TEXTURE0);
    },
  };
}

export function createParticleRenderer(gl, link, sceneTexture) {
  const program = link(vertexShader, fragmentShader);
  const uniform = Object.fromEntries(['center', 'camera', 'scale', 'sprite', 'background', 'resolution', 'mode']
    .map(name => [name, gl.getUniformLocation(program, name)]));
  const buffer = gl.createBuffer(), vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  for (const [location, size, offset] of [[0, 3, 0], [1, 3, 12], [2, 4, 24], [3, 4, 40]]) {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 56, offset);
    gl.vertexAttribDivisor(location, 1);
  }
  gl.bindVertexArray(null);
  return function drawParticles(particles, center, camera, scale, width, height) {
    if (!particles?.buffers.size) return;
    const batches = [];
    for (const [definition, data] of particles.buffers) {
      if (!data.length) continue;
      const {base, distort} = particles.textures.get(definition) ?? {};
      if (base) {
        const mode = /[\\/]alpha_add$/.test(definition.shader) ? 2 :
          /[\\/](?:add|xadd)$/.test(definition.shader) ? 1 : 0;
        batches.push({data, handle: base, mode});
      }
      if (distort) batches.push({data, handle: distort, mode: 3});
    }
    if (!batches.length) return;
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.uniform3fv(uniform.center, center);
    gl.uniformMatrix3fv(uniform.camera, false, camera);
    gl.uniform3fv(uniform.scale, scale);
    gl.uniform2f(uniform.resolution, width, height);
    gl.uniform1i(uniform.sprite, 0);
    gl.uniform1i(uniform.background, 1);

    sceneTexture.bind();
    batches.sort((a, b) => a.mode - b.mode);
    let captured = false;
    for (const {data, handle, mode} of batches) {
      if (mode === 3 && !captured) {
        sceneTexture.capture(width, height);
        captured = true;
      }
      const additive = mode === 1 || mode === 2;
      gl.blendFuncSeparate(additive ? gl.ONE : gl.SRC_ALPHA, additive ? gl.ONE : gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(uniform.mode, mode);
      gl.bindTexture(gl.TEXTURE_2D, handle);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.length / 14);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  };
}
