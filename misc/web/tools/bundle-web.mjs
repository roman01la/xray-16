import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = resolve(import.meta.dirname,'../../..');
const entryPoints = [
  'game-ui.mjs',
  'singleplayer-ui.mjs',
  'xr_3da.js',
  'ingest-worker.js',
  'shader-compiler-client.mjs',
  'shader-compiler-worker.mjs',
  'release-cache.mjs',
  'audio-worklet.mjs',
];
const webOverrides = new Set([
  'game-ui.mjs','singleplayer-ui.mjs','compatibility.mjs','analytics-client.mjs',
  'analytics-movement.mjs','crash-reporter.mjs','release-cache.mjs','opfs-store.mjs',
]);

export async function bundleWeb(frontend, output) {
  frontend = resolve(frontend);
  output = resolve(output);
  await mkdir(output,{recursive:true});
  const reports = [];
  // This client owns the page's compiler worker and MessagePorts. Its module
  // identity must be shared by the page and Emscripten loader.
  const external = [
    './shader-compiler-client.mjs','./compiler-wasm/shaderc.mjs',
    './xr_3da.js','./singleplayer-ui.mjs','./release-cache.mjs',
    './shader-capture.mjs','node:*',
  ];
  for (const entry of entryPoints) {
    const result = await build({
      entryPoints:[join(frontend,entry)],
      outfile:join(output,entry),
      bundle:true,
      format:'esm',
      platform:'browser',
      target:'es2022',
      minify:true,
      keepNames:true,
      sourcemap:'external',
      sourcesContent:true,
      metafile:true,
      external,
      plugins:[{
        name:'browser-release-sources',
        setup(builder) {
          builder.onLoad({filter:/\.(?:mjs|js)$/},async args => {
            const file = basename(args.path);
            const path = dirname(args.path) === frontend && webOverrides.has(file)
              ? join(repo,'server/web',file) : args.path;
            let contents = await readFile(path,'utf8');
            if (file === 'xr_3da.js') {
              // Make this generated URL import visible to the bundler. The
              // surrounding installed-mode ChunkReader initialization is kept.
              contents = contents.replace(/import\(new URL\("\.\/chunk-reader\.mjs",\s*import\.meta\.url\)\.href\)/g,
                'import("./chunk-reader.mjs")');
            }
            return {contents,loader:'js',resolveDir:dirname(args.path)};
          });
        },
      }],
    });
    reports.push({entry,inputs:result.metafile.inputs,outputs:result.metafile.outputs});
  }
  await mkdir(join(output,'compiler-wasm'),{recursive:true});
  await copyFile(join(frontend,'compiler-wasm/shaderc.mjs'),join(output,'compiler-wasm/shaderc.mjs'));
  await writeFile(join(output,'bundle-report.json'),JSON.stringify({entries:entryPoints,reports},null,2));
  return [...entryPoints,'compiler-wasm/shaderc.mjs'];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [frontend,output] = process.argv.slice(2);
  if (!frontend || !output) throw Error('Usage: bundle-web.mjs FRONTEND OUTPUT');
  console.log(JSON.stringify({files:await bundleWeb(frontend,output)}));
}
