import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const path = process.argv[2] ?? new URL('../dist/webgpu/xr_3da.js', import.meta.url);
const source = readFileSync(path, 'utf8');
const report = {
  loaderBytes: Buffer.byteLength(source),
  glesEntryPoints: [...new Set(source.match(/\b_gl[A-Z]\w*/g) ?? [])],
  webglEntryPoints: [...new Set(source.match(/\b_emscripten_webgl\w*/g) ?? [])],
  glContextReferences: (source.match(/GLctx/g) ?? []).length,
  remainingGLProperties: [...new Set([...source.matchAll(/\bGL\.(\w+)/g)].map(m => m[1]))].sort(),
};
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.glesEntryPoints, []);
assert.deepEqual(report.webglEntryPoints, []);
assert.equal(report.glContextReferences, 0);
assert.deepEqual(report.remainingGLProperties, []);
assert.match(source, /CanvasTransferRegistry\.offscreenCanvases/);
assert.doesNotMatch(source, /WebGL|OpenGL/);
// Check the staged runtime surface as well as the SDK-generated loader.
const runtimeRoot = new URL('../dist/webgpu/', import.meta.url);
for (const name of ['backend.js', 'main.js', 'native-runtime.js', 'native-clear.js',
  'native-imgui.js', 'native-queue.js', 'native-selftest.js', 'engine-formats.js', 'reflection.mjs',
  'vertex-conversion.js', 'occlusion.js']) {
  assert.doesNotMatch(readFileSync(new URL(name, runtimeRoot), 'utf8'), /\b(?:OpenGL|WebGL|GLES|GL)\b/i, name);
}
