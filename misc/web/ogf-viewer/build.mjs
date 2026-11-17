import {execFileSync} from 'node:child_process';
import {copyFile, mkdir, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const output = resolve(process.argv[2] ?? 'build/ogf-viewer');
const source = import.meta.dirname;
if (output === source) throw new Error('Choose a separate build output directory.');
await mkdir(output, {recursive: true});
const lzo = process.env.XRAY_VIEWER_LZO;
const lzoObject = join(output, 'minilzo.o');
const exports = ['malloc', 'free', 'ogf_load', 'ogf_load_level', 'ogf_release_level', 'ogf_error', 'ogf_mesh_count',
  'ogf_bone_count', 'ogf_vertex_count', 'ogf_index_count', 'ogf_vertices',
  'ogf_indices', 'ogf_wind_weights', 'ogf_texture', 'ogf_shader', 'ogf_reference_count', 'ogf_reference',
  'ogf_animation_error', 'ogf_add_motions', 'ogf_clip_count', 'ogf_clip_name',
  'ogf_clip_duration', 'ogf_clip_loops', 'ogf_select_clip', 'ogf_pose', 'ogf_posed_vertices'];

if (lzo) {
  exports.push('lzo1x_decompress_safe');
  execFileSync(process.env.EMCC ?? 'emcc', [
    '-O3', '-c', resolve(lzo, 'minilzo/minilzo.c'), '-I' + resolve(lzo, 'include/lzo'), '-o', lzoObject,
  ], {stdio: 'inherit'});
}

execFileSync(process.env.EMXX ?? 'em++', [
  join(source, 'ogf.cpp'), ...(lzo ? [lzoObject] : []), '-std=c++20', '-O3', '-fwasm-exceptions', '--no-entry',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sALLOW_MEMORY_GROWTH=1',
  '-sEXPORTED_FUNCTIONS=' + JSON.stringify(exports.map(name => '_' + name)),
  '-sEXPORTED_RUNTIME_METHODS=["UTF8ToString","HEAPU8"]',
  '-o', join(output, 'ogf.mjs'),
], {stdio: 'inherit'});

if (lzo) await rm(lzoObject);

for (const file of ['index.html', 'viewer.css', 'viewer.mjs', 'dds.mjs', 'renderer.mjs', 'viewer-source.mjs',
  'particle-library.mjs', 'particle-runtime.mjs', 'particle-renderer.mjs', 'xray-binary.mjs', 'environment-runtime.mjs', 'environment-renderer.mjs', 'sun-shadow.mjs',
  'grass-viewer.mjs', 'grass-worker.mjs', 'grass-data.mjs'])
  await copyFile(join(source, file), join(output, file));

console.log(output);
