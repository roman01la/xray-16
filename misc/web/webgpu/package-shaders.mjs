import { packUniforms } from "./pack-uniforms.mjs";
// Promote successfully captured programs into the portable source distribution.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const source = dirname(fileURLToPath(import.meta.url));
const cache = resolve(source, "../../../../.cache/webgpu-shaders");
const output = join(source, "shaders");
await mkdir(output, { recursive: true });
let count = 0;
for (const key of (await readdir(cache)).sort()) {
  if (!/^[a-f0-9]{64}$/.test(key)) continue;
  let bytes;
  try {
    bytes = await readFile(join(cache, key, "result.json"));
  } catch (e) {
    if (e.code === "ENOENT") continue;
    throw e;
  }
  const result = JSON.parse(bytes);
  if (!result.activeUniforms || !result.stages) continue;
  await writeFile(join(output, key + ".json"), JSON.stringify(packUniforms(result)));
  count++;
}
console.log("Packaged", count, "shader programs into", output);
