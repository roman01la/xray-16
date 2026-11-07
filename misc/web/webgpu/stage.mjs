// Stage the production native renderer beside the wasm64 engine.
import {
  readFile,
  readdir,
  writeFile,
  copyFile,
  mkdir,
  symlink,
  rm,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
const source = dirname(fileURLToPath(import.meta.url));
const dist = process.env.XRAY_WEB_DIST_INPUT ? resolve(process.env.XRAY_WEB_DIST_INPUT) : resolve(source, "../dist");
const capture = process.env.XRAY_SHADER_CAPTURE === "1";
const output = process.env.XRAY_WEB_OUTPUT ? resolve(process.env.XRAY_WEB_OUTPUT) : join(dist, capture ? "webgpu-dev" : "webgpu");
await mkdir(output, { recursive: true });
for (const obsolete of ["command-context.js", "gl-constants.js"])
  await rm(join(output, obsolete), {force:true});
for (const file of [
  "xr_3da.wasm",
  "ingest-worker.js",
  "engine_data.json",
  "storage-manager.js",
  "save-format.js",
  "streaming.js",
  "chunk-reader.mjs",
])
  await copyFile(join(dist, file), join(output, file));
for (const file of [
  "backend.js",
  "native-runtime.js",
  "shader-compiler-client.mjs",
  "shader-compiler-worker.mjs",
  "shader-cache.mjs",
  "compiler-core.mjs",
  "wasm-toolchain.mjs",
  "pack-uniforms.mjs",
  "native-queue.js",
  "native-clear.js",
  "native-imgui.js",
  "native-selftest.js",
  "shader-key.js",
  "engine-formats.js",
  "reflection.mjs",
  "vertex-conversion.js",
  "occlusion.js",
])
  await copyFile(join(source, file), join(output, file));
await mkdir(join(output, "compiler-wasm"), {recursive:true});
for (const name of ["shaderc.mjs", "shaderc.wasm", "naga.wasm", "LICENSES.txt"])
  await copyFile(join(source,"compiler-wasm",name),join(output,"compiler-wasm",name));
try {
  await symlink("../engine", join(output, "engine"));
} catch (e) {
  if (e.code !== "EEXIST") throw e;
}
let loader = await readFile(join(dist, "xr_3da.js"), "utf8");
loader = loader.replace(/\bGL\b/g, "CanvasTransferRegistry").replace(/softFullscreenResizeWebGLRenderTarget/g, "resizeFullscreenCanvas");
const hook = "wasmModule=msgData.wasmModule;createWasm();";
if (!loader.includes(hook))
  throw Error(
    "Emscripten worker loader changed; inspect startup hook before staging",
  );
loader =
  "import {installWebGPUBackend} from './backend.js';\nimport {createShaderCompilerPort} from './shader-compiler-client.mjs';\n" +
  loader
    .replace(
      "self.onmessage=function handleMessage(e)",
      "self.onmessage=async function handleMessage(e)",
    )
    .replace(
      hook,
      "wasmModule=msgData.wasmModule;await installWebGPUBackend(msgData.shaderCompilerPort);createWasm();",
    );
const workerLoad = 'worker.postMessage({cmd:1,handlers,wasmMemory,wasmModule})';
if (!loader.includes(workerLoad)) throw Error('Emscripten worker transfer hook changed');
loader = loader.replace(workerLoad, 'const shaderCompilerPort=createShaderCompilerPort();worker.postMessage({cmd:1,handlers,wasmMemory,wasmModule,shaderCompilerPort},[shaderCompilerPort])');
await writeFile(join(output, "xr_3da.js"), loader);
let main =
  "import {startShaderCompiler} from './shader-compiler-client.mjs';\nawait startShaderCompiler();\nglobalThis.XRAY_WEBGPU = true;\n" +
  (await readFile(join(dist, "main.js"), "utf8"));
main = main.replace(
  "// Existing OPFS data",
  `const savedCheckpoint = new URLSearchParams(location.search).get('save');
if (savedCheckpoint && /^[a-z0-9_-]+$/.test(savedCheckpoint)) $('extra-args').value = \`-start server(\${savedCheckpoint}/single/alife/load) client(localhost)\`;
// Existing OPFS data`,
);
main += "\n" + (await readFile(join(source, "page-diagnostics.js"), "utf8"));
await writeFile(join(output, "main.js"), main);
let html = await readFile(join(dist, "index.html"), "utf8");
html = html
  .replace(/<title>[^<]*<\/title>/, "<title>OpenXRay WebGPU</title>")
  .replace(
    '<div id="toolbar">',
    '<div id="toolbar"><strong>WebGPU · GPU-only</strong>',
  );
await writeFile(join(output, "index.html"), html);
console.log("Staged native WebGPU build:", output);

// Offline artifacts and runtime results share the browser shader cache.
const shaderSource = join(source, "shaders");
await mkdir(join(output, "shaders"), { recursive: true });
let shaderCount = 0;
for (const name of await readdir(shaderSource)) {
  if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
  await copyFile(join(shaderSource, name), join(output, "shaders", name));
  shaderCount++;
}
await writeFile(
  join(output, "shader-manifest.json"),
  JSON.stringify({ version: 3, shaderCount }),
);
console.log("Packaged shader programs:", shaderCount);
if (capture) {
  const page = join(output, "index.html");
  await writeFile(page, (await readFile(page, "utf8")).replace("WebGPU · GPU-only", "WebGPU · Developer capture"));
}

for (const file of ['sidecar-test.html','sidecar-test-worker.mjs','sidecar-test-request.json']) {
  if (process.env.XRAY_SIDECAR_TEST === '1') await copyFile(join(source,file),join(output,file));
  else await rm(join(output,file),{force:true});
}
