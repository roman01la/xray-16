# GPU-only WebGPU backend

The browser build renders through WebGPU only. GPU resources are owned directly by the renderer; shader compilation and reflection share an offline/native and browser/WASM implementation. The C++ renderer submits prepared draw, uniform, binding and resource records
to native WebGPU modules. Startup, shader reflection, resource ownership, queries,
synchronization, copies/readback, partial clears and ImGui use this native path.
The production package contains only the native renderer. The desktop renderer is separate.

## Run

The hosted game uses the same native WebGPU engine for single player and
multiplayer. The render target follows the browser viewport's aspect ratio
within the resolution selected in video settings. Add `diagnostics=1`
to the query for the GPU adapter, FPS, resolution, and CPU/GPU timing.
[Build and run from the repository](../README.md)

The guide also covers the separate local developer launcher. In that launcher,
`?debug=1&autostart=0` shows manual launch, save backup, and renderer tools.
`?save=<name>` loads an existing local checkpoint and requires that save in the
current browser origin.

The normal build includes **537 same-origin WGSL/reflection JSON artifacts** in
`shaders/`, plus a page-owned shader compiler worker. The worker starts and initializes
shaderc 2026.1 and Naga 26 WASM before engine startup, then parks in its event loop.
All engine pthreads connect through transferred message ports; only a pthread waits
for shader replies, so the page remains responsive. No local compiler server is needed.

A single cache path serves both offline and runtime shaders. It checks memory
and Cache Storage, fetches indexed packaged files, and compiles misses in WASM.
Both producers use `compiler-core.mjs`, reflection and uniform packing, the same v3
source SHA-256 key and JSON schema. Both are persisted at the same shader URL in
`SHADER_CACHE_VERSION`. No origin marker is stored in the artifact. Updating the
compiler/reflection/uniform ABI requires a cache namespace bump. A failed cache write
keeps the shader usable in memory, with a diagnostic warning; invalid cached artifacts
are discarded and recreated. Generated shaders survive reloads unless browser storage
is evicted. Compilation errors remain explicit rather than rendering incorrectly.

First-use compilation can pause the engine and should normally happen during level
loading. The worker does not poll or do per-frame work. Browser GPU pipeline compilation
still happens after WGSL translation. This fallback removes dependency on exhaustive
prepackaging, but does not certify arbitrary mods or untested rendering features.

Engine assets are SHA-256 verified, including same-size updates. Failed or corrupt
HTTP responses are rejected before writing. Game imports check the required archive
folders and available space, and compare existing files in chunks before skipping.
These structural checks do not certify every game edition or modified installation.

### Building and validating the compiler

The checked-in sidecar artifacts are staged automatically. To rebuild them from pinned
sources, run from the repository root with Rust
`wasm32-unknown-unknown` and the Emscripten SDK installed at
`../.tools/emsdk` as expected by the rebuild script.

```sh
bash misc/web/webgpu/compiler-wasm/build.sh
node misc/web/webgpu/verify-sidecar.mjs
```

The second command checks the actual WASM chain against packaged offline
artifacts. Pass private capture JSON files as positional arguments for the
current corpus. Older artifacts use `.cache/webgpu-shaders` by default or the
directory selected with `--legacy-cache`. The verifier reports separately when
it reconstructs old request envelopes. `compiler-wasm/LICENSES.txt` bundles licenses.
The modules are approximately 4.23 MiB (shaderc) and 0.61 MiB (Naga), uncompressed.

For the browser regression page, build the standalone developer launcher, then
restage with `XRAY_SIDECAR_TEST=1 node misc/web/webgpu/stage.mjs`. Open
`/webgpu/sidecar-test.html` on the local server. Run the cold test, reload, then run
the persistence test. It exercises the real parked compiler, pthread-style synchronous reply, common
persistent cache and browser WGSL compilation using the renderer's shader flags. Normal
staging removes these test-only files. Debug game pages expose `#webgpu-compiler` counters.

The optional Node offline compiler still requires `glslc` and naga-cli 26 at
`.tools/naga/bin/naga`; `package-shaders.mjs` promotes its outputs to `shaders/`.
Serve the release with HTTPS (or localhost), COOP `same-origin`, COEP
`require-corp`, and WASM MIME `application/wasm`.
Include `engine/` as actual files when packaging the staging symlink. Game archives
and user saves are not part of the distribution.

## Offline shader coverage

The shader key represents a complete native vertex/fragment request, including
expanded source and ordered engine defines. Use the stock asset inventory to
choose scenarios, then capture the exact requests from the renderer. The
inventory includes all five campaign material tables, model and embedded
visual material references, particle materials, texture metadata, graphics
presets, environment configs, and renderer source entry points.

```sh
mkdir -p "$private"
node misc/web/webgpu/shader-inventory.mjs "$owned_game" --output "$private/inventory.json"
XRAY_SHADER_CAPTURE=1 node misc/web/multiplayer/stage-game.mjs "$engine" "$private/stage" "$pack"
node misc/web/webgpu/shader-sweep.mjs "$private/stage" "$campaign_config" "$private/sweep"
node misc/web/webgpu/shader-sweep.mjs "$private/stage" "$campaign_config" "$private/stock" --singleplayer
node misc/web/webgpu/shader-coverage.mjs "$private/sweep/captures/"*.json "$private/stock/captures/"*.json \
  --report "$private/coverage.json" --replay "$private/replayed"
```

The sweep uses optimized unified artifacts, a separate Chrome profile and local
preview and Rust server ports. Build `server/target/release/zone-server` first.
The campaign config supplies each region's collision manifest and spawn anchor.
Use `--maps zaton,jupiter` or `--presets Default,Extreme` for shorter runs.
`--port` sets the preview port, the Rust HTTP port follows it, and `--udp`
sets the Rust UDP port. Set `XRAY_CHROME` or `XRAY_ZONE_SERVER` to use alternate
local binaries. `--singleplayer` starts the original Zaton campaign, lets
A-Life initialize, and opens the inventory and PDA. It defaults to the Default
preset and does not start the Rust server. The runner retains failed startup
rows and partial traces alongside successful rows. Check the captured options
to confirm what each preset actually enabled.

Use `--scenario` with a private stock route to seed renderer settings, load a
checkpoint, or run game-console and Lua phases with exact log assertions. The
config argument is unused for these single-player runs. The example Jupiter
route expects a compatible `online-stash.scop` next to a local copy of the
JSON. Each phase uses an isolated profile and the normal engine script loader.

```sh
node misc/web/webgpu/shader-sweep.mjs "$private/stage" unused "$private/compact" \
  --scenario misc/web/webgpu/scenarios/zaton-compact.json --pipeline-probe --fresh-shader-cache
node misc/web/webgpu/shader-sweep.mjs "$private/stage" unused "$private/ssr" \
  --scenario misc/web/webgpu/scenarios/zaton-ssr.json --pipeline-probe --fresh-shader-cache
```

`--fresh-shader-cache` clears the shader cache at the start of the run, keeping
the isolated profile's installed game data. `--pipeline-probe` adds counts to
the staged developer backend. It measures draw-pipeline cache entries, unique
program keys used by those entries, and vertex conversion module creations.
Presentation and the separate ImGui backend have their own pipeline paths.

For a manual route, open a capture-enabled stage with
`?shaderCapture=unique-run-id&shaderMap=zaton&shaderPreset=default&shaderScenario=inventory`
alongside the usual launcher query options. After the route, export the run in
the browser console using the local capture module.

```js
const trace = await (await import('./shader-capture.mjs')).readShaderCapture('unique-run-id');
const link = document.createElement('a');
link.download = 'unique-run-id.json';
link.href = URL.createObjectURL(new Blob([JSON.stringify(trace)], {type:'application/json'}));
link.click();
```

The capture records package membership even when an exact request is fulfilled
from cache. Capture files contain expanded shader sources and stay local.
`--report` omits the source text. `--replay` compiles successful missing requests
using the shipped shaderc/Naga WASM and writes validated artifacts to a separate
directory. Merge reviewed artifacts with the current package in a scratch
directory. Restage with `XRAY_SHADER_CAPTURE=1 XRAY_SHADER_PACKAGE="$merged"`,
repeat the corresponding rows with a new browser profile, and use
`--package "$merged" --check` to verify package coverage. Ordinary staging uses
the checked-in artifacts and omits the capture module.

The first sweep exercised every combination of the five campaign maps and
five built-in presets, plus the stock Default Zaton A-Life, inventory and PDA
route. It recorded 505 distinct native program requests. The original pack
was missing 348 map-preview keys and another 41 from the stock route. The
first expanded pack contained 926 programs. Its retest reached gameplay in
all 26 scenarios with zero runtime compiles and zero WebGPU validation errors.
Minimum and Low exposed a shaderc preprocessing failure when quality settings
were disabled. The shared compiler now treats the diagnosed numeric quality
tests as zero while preserving GLSL ES preprocessing and the original request
key.

The second sweep added 318 exact programs to bring the package to 1,244.
All four single-player routes retested from an empty shader cache with zero
runtime compiles and zero WebGPU validation errors.

| Route | Offline programs requested | Draw pipelines | Programs used by those pipelines | Vertex conversion modules |
| --- | ---: | ---: | ---: | ---: |
| Zaton 1024 shadows, Ultra SSAO, low reflections, soft effects off | 148 | 75 | 62 | 23 |
| Zaton 3072 shadows, Ultra reflections with half depth and jitter | 148 | 73 | 61 | 23 |
| Jupiter checkpoint, late-game gear, weather and effects | 177 | 109 | 89 | 30 |
| Stock Zaton to Pripyat transition | 154 | 85 | 78 | 32 |

The Jupiter script confirmed the Gauss, G36, RPG-7 and elite detector visuals,
three active stock particle effects, thunder at 23:00, clear weather at noon,
and an active emission. The Pripyat route confirmed the map asset load and
stock synchronization. Two runs from its transition-generated autosave counted
1,512–1,513 online objects, 537–538 visual references and 157 distinct model
names, including a Monolith visual. Both runs loaded the same 148 programs
from the 1,244-program pack with an empty shader cache and zero WebGPU
validation errors. This census covers the models online around the checkpoint.

To reproduce it, run `scenarios/pripyat-travel.json` and open the same private
browser profile on the same preview origin to export the transition autosave.
The browser stores it under `stream-cop/_appdata_/savedgames`. In the browser
console, export it under the filename expected by the census fixture.

```js
let saves = await navigator.storage.getDirectory();
for (const part of ['stream-cop', '_appdata_', 'savedgames'])
  saves = await saves.getDirectoryHandle(part);
const name = (await Array.fromAsync(saves.keys())).find(key => / - autosave\.scop$/i.test(key));
const link = document.createElement('a');
link.download = 'pripyat-transition.scop';
link.href = URL.createObjectURL(await (await saves.getFileHandle(name)).getFile());
link.click();
```

Copy `scenarios/pripyat-model-census.json` next to the exported checkpoint and
run it in a separate capture stage and private profile.

```sh
node misc/web/webgpu/shader-sweep.mjs "$private/census-stage" unused "$private/census" \
  --scenario "$private/pripyat-model-census.json" --stock-game "$owned_game" \
  --pipeline-probe --fresh-shader-cache
```

The census attaches a one-shot Lua probe to the private stage's copy of the
original actor update script. It reads the visual names after the stock scene
starts and avoids the console input restriction in this checkpoint. Keep the
instrumented stage and browser profile separate from regular gameplay.

Map preview constructs static level materials and initializes renderer and
particle programs. The stock route covers the models loaded at the start of
Zaton under Default settings. Individual assets, weather and effect
combinations, and custom settings beyond these routes remain potential runtime
compiler requests. WebGPU pipelines also depend on draw state and attachment
formats. The probe reports the pipelines encountered during the run.

## Implementation

- Native WebGPU submission and resource frontend, with cached shader reflection.
- Native WebGPU render passes, pipelines, buffers, textures and presentation.
- Batched uniform and geometry uploads, dynamic uniform offsets, reusable bind
  groups and samplers, and ordered copies instead of per-update queue submissions.
- Compact integer vertex attributes converted in WGSL instead of expanding on CPU.
- Real asynchronous GPU occlusion queries with conservative pending results.
- Native GPU screenshot readback, JPEG encoding and OPFS persistence, connected to
  the engine's normal screenshot command.

The toolbar reports FPS, submitted frames, draws and validation errors. Its
“Benchmark 30 s” button measures presentation intervals with per-call profiling
disabled. Unsupported operations fail explicitly.

## Historical validation

### Strict native build (2026-11-07)

The browser renderer now requires native WebGPU entry points. Missing native
initialization fails explicitly instead of taking a GLES fallback. Debug render
passes validate native attachment existence, lifetime, mip bounds and dimensions;
`CHK_GL` no longer queries GL errors on the browser target. All 23 renderer unity
translation units also compile at `-O0 -DDEBUG -UNDEBUG`, with no undefined GLES
symbols. Desktop OpenGL paths remain available in desktop builds.

The browser target excludes GLAD and builds pinned SDL 2.32.10 with OpenGL,
OpenGL ES and SDL rendering disabled. Emscripten's WebGL version flags and SDL
port dependency are removed. `native-canvas-library.js` retains the SDK's
OffscreenCanvas transfer/resize/fullscreen behavior without GL viewport hooks.
The upstream canvas-transfer identifier is renamed `CanvasTransferRegistry` in the staged loader.
The generated engine loader has no GLES/WebGL entry points or GL context
references. Verify this after rebuilding with:

```sh
node misc/web/tools/audit_native_loader.mjs
```

The native backend no longer maintains duplicate GL query state, enabled-cap
sets, current-program mirrors or implicit buffer/texture upload bindings. Native
uploads take explicit resource handles. `EngineFormat` identifiers retain the numeric values of the
engine/package ABI; they do not imply a graphics context or function dispatch.
Legacy implicit-state methods exist only in the unstaged test reference.

Validation: 38 automated tests pass. GPU readback checks pass all three checks
(48 pixels), including native attachment validation, partial color/depth clears
and ImGui drawing. The generated loader is 168,683 bytes. Browser wireframe and
MSAA remain unsupported.

Single-tab 720p Extreme Skadovsk benchmark, profiling off, battery 99% on AC:
**112.49 FPS**, 3,375 frames in 30 seconds; median 8.555 ms, p95 11.415 ms,
p99 14.975 ms, zero legacy draws and zero validation errors. This is 7.58%
above the saved charged 104.56 FPS sample, subject to scene/run variation.
No feature-disabled control was rerun. Raw evidence is in the workspace's
`strict-webgpu-benchmark.json` and `strict-webgpu-artifact-audit.json`.

### Runtime naming cleanup (2026-11-07)

`engine-formats.js` exports `EngineFormat`, a reduced table of numeric package
identifiers. Shader reflection uses `shaderValueType`. The staged SDK canvas
registry is named `CanvasTransferRegistry`; it owns only canvas transfer records.
Obsolete compatibility buttons, dispatch methods and always-zero counters have
been removed. `MIGRATION-HISTORY.md` archives measurements of superseded builds.
The current runtime module audit rejects obsolete graphics API names; explicit
references remain in the isolated SDK adapter, dependency audit, shared desktop
source and offline shader tooling where they describe actual responsibilities.

The cleanup rerun passed 38 tests and all 48 GPU readback pixels, with zero
validation errors. Single-tab 720p Extreme Skadovsk measured 107.32 FPS over
30 seconds (median 8.99 ms, p95 12.10 ms, p99 14.94 ms), versus the previous
112.49 FPS single sample. This naming cleanup is not claimed as a speedup.
The same Release `-O3 -DNDEBUG` engine was used. Low-overhead phase samples
measured rendering at 6.4–7.6 ms and simulation at 2.4–2.9 ms. The workspace's
`webgpu-whole-renderer-review.json` records prioritized follow-up opportunities,
code locations, evidence and measurement caveats; those optimizations are not
part of the naming cleanup.

### Parked shader compiler verification (2026-11-07)

- All 537 programs reproduce their offline packed WGSL/reflection with the WASM
  compiler. 361 retain exact original request envelopes/keys; 176 older captures
  reconstruct active attribute bindings and compare all fields except the old key.
- 48 automated tests pass, including actual WASM compilation, recovery after a
  compiler error, cache deduplication, corrupt artifacts and storage failures.
- Browser integration: one packaged and one runtime-generated program use identical
  cached artifacts; after page reload both are cache hits, with zero compilation
  and no browser GPU shader errors.
- With packaged shaders temporarily unavailable, Jupiter rendered after compiling
  176 programs in-browser. An in-engine transition to Skadovsk compiled one more.
  All 64 native GPU readback checks passed. Packaged assets were then restored.
- A fresh Skadovsk load reused 148 persisted artifacts with zero package fetches,
  zero compilation and zero errors. The 30-second production benchmark at 720p
  Extreme on AC power averaged **117.54 FPS** (median 8.30 ms, p95 10.78 ms,
  p99 12.89 ms), with zero GPU validation errors and unchanged compiler counters.
  This is consistent with 117.05 FPS before the compiler sidecar was integrated.

The five renderer optimizations remain active: pooled streaming buffers, draw-record
program/layout handles, packed object/frame/material uniforms, ordered cross-boundary
draw batching, and reused presentation/ImGui resources. This run recorded zero new
streaming allocations, zero native program/vertex selector calls, one prepared draw
cache miss, and about 949 KB of uniform uploads per frame. Cross-level validation
covers Jupiter to Skadovsk; it does not certify every game scene or modification.
