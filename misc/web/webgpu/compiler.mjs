import { compileProgram } from "./compiler-core.mjs";
import { packUniforms } from "./pack-uniforms.mjs";
import { shaderKey } from "./shader-key.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createWasmToolchain } from "./wasm-toolchain.mjs";
import { resolve, join } from "node:path";
let toolchain;
const workspace = resolve(process.env.XRAY_WORKSPACE || ".");
const cache = join(workspace, ".cache/webgpu-shaders");
export async function compile(request) {
  const dir = join(cache, shaderKey(request));
  await mkdir(dir, {recursive:true});
  await writeFile(join(dir,"request.json"), JSON.stringify(request));
  try { return packUniforms(JSON.parse(await readFile(join(dir,"result.json"),"utf8"))); } catch {}
  // Offline and runtime compilation must use the same gather-capable translator.
  toolchain ||= createWasmToolchain({nagaBytes: await readFile(new URL("./compiler-wasm/naga.wasm", import.meta.url))});
  const result = await compileProgram(request, await toolchain);
  await writeFile(join(dir,"result.json"),JSON.stringify(result));
  return result;
}
