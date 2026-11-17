const vertex = `#version 300 es
layout(location=0) in vec3 position;
layout(location=2) in vec2 uv;
uniform vec3 center;
uniform mat3 camera;
uniform vec3 scale;
out vec2 texcoord;
void main() {
  gl_Position = vec4((camera * (position - center)) * scale, 1.0);
  texcoord = uv;
}`;

const fragment = `#version 300 es
precision mediump float;
in vec2 texcoord;
uniform sampler2D surface;
uniform bool alphaTest;
void main() {
  if (alphaTest && texture(surface, texcoord).a < 0.12) discard;
}`;

const resolution = 1536;
const unit = values => {
  const magnitude = Math.hypot(...values) || 1;
  return values.map(x => x / magnitude);
};
const cross = ([a, b, c], [x, y, z]) => [b * z - c * y, c * x - a * z, a * y - b * x];

export function createSunShadow(gl, link) {
  const program = link(vertex, fragment);
  const u = Object.fromEntries(['center', 'camera', 'scale', 'surface', 'alphaTest']
    .map(name => [name, gl.getUniformLocation(program, name)]));
  const depth = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, depth);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, resolution, resolution);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  const ready = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  let previousMesh, previousSignature, shadow;
  return {
    texture: depth,
    update(meshes, view, weather, fallback) {
      if (!ready || !weather || view.zoom < 2 || weather.sunDirection[1] <= 0.025 ||
          Math.max(...weather.sunColor) < 0.035) return null;
      // Cache focus and solar angle so tree sway and particles don't redraw the
      // entire shadow depth pass while the camera and sun are stationary.
      const extent = Math.max(24, Math.round(view.radius / view.zoom * 1.6 / 8) * 8);
      const center = view.center.map(x => Math.round(x / (extent / 8)) * (extent / 8));
      const sun = unit(weather.sunDirection.map(x => Math.round(x * 180) / 180));
      const signature = [extent, ...center, ...sun].join(',');
      const firstMesh = meshes[0];
      if (previousMesh === firstMesh && previousSignature === signature) return shadow;
      previousMesh = firstMesh;
      previousSignature = signature;
      const right = unit(cross(Math.abs(sun[1]) > 0.98 ? [1, 0, 0] : [0, 1, 0], sun));
      const up = cross(sun, right);
      const camera = right.flatMap((x, i) => [x, up[i], sun[i]]);
      const scale = [1 / extent, 1 / extent, -0.9 / view.radius];
      shadow = {camera, center, scale};

      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.viewport(0, 0, resolution, resolution);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.useProgram(program);
      gl.uniform3fv(u.center, center);
      gl.uniformMatrix3fv(u.camera, false, camera);
      gl.uniform3fv(u.scale, scale);
      gl.uniform1i(u.surface, 0);
      gl.activeTexture(gl.TEXTURE0);
      for (const mesh of meshes) {
        if (mesh.water || mesh.distortion) continue;
        gl.bindVertexArray(mesh.vao);
        gl.bindTexture(gl.TEXTURE_2D, mesh.texture ?? fallback);
        gl.uniform1i(u.alphaTest, /^flora[\\/](?:leaf|grass)/i.test(mesh.shader) || /aref|alpha_test/i.test(mesh.shader));
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.triangleBuffer);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return shadow;
    },
  };
}
