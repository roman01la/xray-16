import { compileProgram } from "./compiler-core.mjs";
import { packUniforms } from "./pack-uniforms.mjs";
import { shaderKey } from "./shader-key.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
const run = promisify(execFile);
const workspace = resolve(process.env.XRAY_WORKSPACE || ".");
const cache = join(workspace, ".cache/webgpu-shaders");
const naga = join(workspace, ".tools/naga/bin/naga");
export async function compile(request) {
  const dir = join(cache, shaderKey(request));
  await mkdir(dir, {recursive:true});
  await writeFile(join(dir,"request.json"), JSON.stringify(request));
  try { return packUniforms(JSON.parse(await readFile(join(dir,"result.json"),"utf8"))); } catch {}
  const result = await compileProgram(request, {
    async preprocess(source, stage) {
      const path = join(dir, stage+".input");
      await writeFile(path, source);
      return (await run("glslc", ["-E", "-fshader-stage="+stage, path], {maxBuffer:8<<20})).stdout;
    },
    async translate(source, stage) {
      const path = join(dir, stage+".glsl");
      await writeFile(path, source);
      await run("glslc", ["-fshader-stage="+stage,"--target-env=vulkan1.1","-O",path,"-o",join(dir,stage+".spv")], {maxBuffer:8<<20});
      await run(naga,["--keep-coordinate-space",join(dir,stage+".spv"),join(dir,stage+".wgsl")], {maxBuffer:8<<20});
      return readFile(join(dir,stage+".wgsl"),"utf8");
    }
  });
  await writeFile(join(dir,"result.json"),JSON.stringify(result));
  return result;
}
