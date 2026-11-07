import test from "node:test";
import assert from "node:assert/strict";
import { compile } from "./compiler.mjs";

test("engine shader arrays, multiple declarations and sampler bindings survive conversion", async () => {
  const request = {
    attributes: [{ name: "position", location: 0 }],
    sources: {
      vert: `#version 300 es
precision highp float;
in vec3 position;
out vec2 uv;
uniform vec4 bones[256 - 22];
uniform vec4 scale, bias;
void main(){ uv=position.xy; gl_Position=vec4(position,1.0)*scale+bias+bones[1]; }`,
      frag: `#version 300 es
precision highp float;
in vec2 uv;
out vec4 color;
uniform sampler2D surface;
void main(){ color=texture(surface,uv); }`,
    },
  };
  const result = await compile(request);
  assert.equal(result.uniforms.find((u) => u.name === "bones").count, 234);
  assert.deepEqual(
    result.uniforms.map((u) => u.name),
    ["bones", "scale", "bias"],
  );
  assert.equal(result.uniforms[1].offset, 234 * 16);
  assert.deepEqual(result.activeBindings.sort(), [0, 1, 2]);
  assert.match(result.stages.vert, /@vertex/);
  assert.match(result.stages.frag, /@fragment/);
  assert.deepEqual(await compile(request), result);
});
