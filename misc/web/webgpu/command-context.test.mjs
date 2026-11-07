import test from "node:test";
import assert from "node:assert/strict";
import { createCommandContext } from "./command-context.js";
import { EngineFormat } from "./engine-formats.js";
import { specializeVertex } from "./vertex-conversion.js";

test("GPU command ABI never invents Emscripten state properties", () => {
  const context = createCommandContext(
    { width: 1280, height: 720 },
    { limits: {} },
  );
  assert.equal(context.currentPixelUnpackBufferBinding, 0);
  assert.equal(context.currentPixelPackBufferBinding, 0);
  assert.equal(context.nonexistentEngineState, undefined);
  assert.equal(context.commit, undefined);
  assert.equal(context.createBuffer().kind, "Buffer");
  assert.equal(context.getExtension("WEBGL_lose_context"), null);
});
test("UI state round-trips through the GPU command ABI", () => {
  const context = createCommandContext(
    { width: 1280, height: 720 },
    { limits: {} },
  );
  context.frontend = {};
  context.enable(EngineFormat.BLEND);
  context.blendFuncSeparate(
    EngineFormat.SRC_ALPHA,
    EngineFormat.ONE_MINUS_SRC_ALPHA,
    EngineFormat.ONE,
    EngineFormat.ZERO,
  );
  context.colorMask(true, false, true, false);
  assert.equal(context.isEnabled(EngineFormat.BLEND), true);
  assert.equal(context.getParameter(EngineFormat.BLEND_SRC_RGB), EngineFormat.SRC_ALPHA);
  assert.equal(context.getParameter(EngineFormat.BLEND_SRC_ALPHA), EngineFormat.ONE);
  assert.deepEqual(context.getParameter(EngineFormat.COLOR_WRITEMASK), [
    true,
    false,
    true,
    false,
  ]);
  context.disable(EngineFormat.BLEND);
  assert.equal(context.isEnabled(EngineFormat.BLEND), false);
});
test("integer vertex conversion happens in WGSL without expanding vertex buffers", () => {
  const source =
    "@vertex\nfn main(@location(8) uv: vec2<f32>, @location(3) pos: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(pos.xy + uv, pos.z, 1.0); }";
  const result = specializeVertex(source, [{ location: 8, scalar: "i32" }]);
  assert.match(result, /@location\(8\) uv: vec2<i32>/);
  assert.match(result, /pos\.xy \+ vec2<f32>\(uv\)/);
  assert.match(result, /@location\(3\) pos: vec3<f32>/);
});
