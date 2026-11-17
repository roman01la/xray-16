const vertex = `#version 300 es
out vec2 coord;
void main() {
  coord = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(coord, 0.99, 1.0);
}`;

const skyFragment = `#version 300 es
precision highp float;
in vec2 coord;
uniform mat3 camera;
uniform float aspect;
uniform float time;
uniform float blend;
uniform vec2 rotation;
uniform float cloudRotation;
uniform vec2 wind;
uniform vec3 skyColor;
uniform vec3 fogColor;
uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec4 cloudColor;
uniform float shafts;
uniform float flash;
uniform samplerCube skyA;
uniform samplerCube skyB;
uniform sampler2D cloudA;
uniform sampler2D cloudB;
out vec4 color;

vec3 rotateSky(vec3 direction, float angle) {
  float c = cos(angle), s = sin(angle);
  direction.xz = mat2(c, s, -s, c) * direction.xz;
  return direction;
}

void main() {
  vec3 ray = transpose(camera) * normalize(vec3(coord.x * aspect * 0.65, coord.y * 0.65, -1.0));
  vec3 rayA = rotateSky(ray, rotation.x);
  vec3 rayB = rotateSky(ray, rotation.y);
  vec3 sky = mix(texture(skyA, rayA).rgb, texture(skyB, rayB).rgb, blend) * skyColor;
  vec3 cloudRay = rotateSky(ray, cloudRotation);
  vec2 uv = cloudRay.xz / max(0.08, ray.y) * 0.13 + wind * time * 0.0026;
  vec4 clouds = mix(texture(cloudA, uv), texture(cloudB, uv), blend);
  sky = mix(sky, clouds.rgb * cloudColor.rgb, clouds.a * cloudColor.a * smoothstep(0.01, 0.23, ray.y));
  float sun = max(0.0, dot(ray, sunDirection));
  sky += (smoothstep(0.99965, 0.9999, sun) + pow(sun, 56.0) * (0.13 + 0.55 * shafts)) * sunColor;
  sky = mix(fogColor, sky, smoothstep(-0.25, 0.12, ray.y));
  if (flash > 0.01) {
    float x = -0.15 + floor(coord.y * 21.0) * 0.005;
    x += sin(floor(coord.y * 30.0) * 2.41) * 0.039;
    float bolt = (1.0 - smoothstep(0.004, 0.011, abs(coord.x - x))) * smoothstep(-0.13, 0.25, coord.y);
    sky += vec3(0.38, 0.44, 0.56) * flash + bolt * vec3(0.85, 0.9, 1.0) * flash;
  }
  color = vec4(clamp(sky, 0.0, 1.0), 1.0);
}`;

const rainFragment = `#version 300 es
precision highp float;
in vec2 coord;
uniform float aspect;
uniform float time;
uniform float amount;
uniform float wind;
uniform vec3 tint;
out vec4 color;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float drops(vec2 p, float scale, float speed) {
  p.x += p.y * wind;
  p *= vec2(scale * aspect, scale * 0.28);
  p.y += time * speed;
  float seed = hash(floor(p));
  vec2 f = fract(p);
  float width = 1.0 - smoothstep(0.018, 0.060, abs(f.x - seed));
  float stem = smoothstep(0.08, 0.28, f.y) * (1.0 - smoothstep(0.64, 1.0, f.y));
  return step(seed, amount) * width * stem;
}
void main() {
  vec2 uv = coord * 0.5 + 0.5;
  float streak = drops(uv, 106.0, 5.5) * 0.19 + drops(uv + 17.1, 68.0, 3.8) * 0.32;
  color = vec4(tint, streak);
}`;

export function createEnvironmentRenderer(gl, link) {
  const sky = link(vertex, skyFragment), rain = link(vertex, rainFragment);
  function locations(program, names) {
    return Object.fromEntries(names.map(name => [name, gl.getUniformLocation(program, name)]));
  }
  const s = locations(sky, ['camera', 'aspect', 'time', 'blend', 'rotation', 'cloudRotation', 'wind',
    'skyColor', 'fogColor', 'sunDirection', 'sunColor', 'cloudColor', 'shafts', 'flash', 'skyA', 'skyB', 'cloudA', 'cloudB']);
  const r = locations(rain, ['aspect', 'time', 'amount', 'wind', 'tint']);
  const emptySky = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, emptySky);
  for (let i = 0; i < 6; i++)
    gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, gl.RGBA, 1, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([174, 188, 202, 255]));

  function fullScreen() {
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }
  return {
    emptySky,
    sky(state, camera, aspect, emptyCloud) {
      gl.useProgram(sky);
      gl.uniformMatrix3fv(s.camera, false, camera);
      gl.uniform1f(s.aspect, aspect);
      gl.uniform1f(s.time, state.elapsed);
      gl.uniform1f(s.blend, state.blend);
      gl.uniform2f(s.rotation, state.a.skyRotation * Math.PI / 180, state.b.skyRotation * Math.PI / 180);
      gl.uniform1f(s.cloudRotation, state.cloudRotation);
      gl.uniform2f(s.wind, Math.sin(state.windDirection) * state.wind, Math.cos(state.windDirection) * state.wind);
      gl.uniform3fv(s.skyColor, state.skyColor);
      gl.uniform3fv(s.fogColor, state.fogColor);
      gl.uniform3fv(s.sunDirection, state.sunDirection);
      gl.uniform3fv(s.sunColor, state.sunColor);
      gl.uniform4fv(s.cloudColor, state.cloudColor);
      gl.uniform1f(s.shafts, state.shafts);
      gl.uniform1f(s.flash, state.flash);
      for (let i = 0; i < 2; i++) {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, state.skies[i] ?? state.skies[1-i] ?? emptySky);
        gl.activeTexture(gl.TEXTURE2 + i);
        gl.bindTexture(gl.TEXTURE_2D, state.clouds[i] ?? state.clouds[1-i] ?? emptyCloud);
      }
      gl.uniform1i(s.skyA, 0); gl.uniform1i(s.skyB, 1);
      gl.uniform1i(s.cloudA, 2); gl.uniform1i(s.cloudB, 3);
      gl.activeTexture(gl.TEXTURE0);
      fullScreen();
    },
    rain(state, camera, aspect) {
      if (state.rain < 0.015) return;
      gl.useProgram(rain);
      gl.uniform1f(r.aspect, aspect);
      gl.uniform1f(r.time, state.elapsed);
      gl.uniform1f(r.amount, state.rain);
      const crosswind = Math.sin(state.windDirection) * camera[0] + Math.cos(state.windDirection) * camera[6];
      gl.uniform1f(r.wind, crosswind * state.wind * 0.04);
      gl.uniform3fv(r.tint, state.rainColor.map(x => Math.min(1, x + state.flash * 0.2)));
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      fullScreen();
      gl.disable(gl.BLEND);
    },
  };
}
