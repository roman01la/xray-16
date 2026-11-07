# GPU-only WebGPU backend

The browser build renders through WebGPU only. GPU resources are owned directly by the renderer; shader compilation and reflection share an offline/native and browser/WASM implementation. The C++ renderer submits prepared draw, uniform, binding and resource records
to native WebGPU modules. Startup, shader reflection, resource ownership, queries,
synchronization, copies/readback, partial clears and ImGui use this native path.
The production package contains only the native renderer. The desktop renderer is separate.

## Run

From the enclosing workspace:

```sh
bash build-browser.sh          # when rebuilding the engine
zsh build-webgpu.sh            # stage dist/webgpu
zsh serve-browser.sh           # localhost:8081, if not already running
```

Open http://localhost:8081/webgpu/?save=browser-fresh-start for the clean checkpoint
created on this installation, or http://localhost:8081/webgpu/ for the menu. Press a key when loading
finishes. Both pages share the original game's OPFS storage. The root page `/` redirects to `/webgpu/`, preserving query parameters.

Requirements: a desktop browser supporting wasm64, pthreads, worker WebGPU, BC
texture compression (including sliced 3D), and sufficient memory/storage for the
original Call of Pripyat 1.6.02 files. The engine starts with 2 GB WASM memory.

The normal build includes **537 same-origin WGSL/reflection JSON artifacts** in
`shaders/`, plus a page-owned shader compiler worker. The worker starts and initializes
shaderc 2026.1 and Naga 26 WASM before engine startup, then parks in its event loop.
All engine pthreads connect through transferred message ports; only a pthread waits
for shader replies, so the page remains responsive. No local compiler server is needed.

A single cache path handles both compilation times: in-memory lookup, persistent
Cache Storage lookup, packaged JSON fetch, then WASM compilation on a miss. Both
producers use `compiler-core.mjs`, reflection and uniform packing, the same v3
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

The default view shows only the game, fitted to the viewport at its original aspect
ratio. Add `&debug=1` to a save URL to show the launcher and diagnostics.
`?autostart=0` opens the launcher without starting the engine. First-time visitors
without imported game data also see the setup controls. The Saves dialog
can prepare/download a backup, import a backup before launch, and request browser
storage persistence. Imports preserve existing filenames. If the browser declines
persistence, keep a downloaded backup. Moving to another origin requires importing
game files and the save backup again. Fullscreen and Restart are in the toolbar.

Engine assets are SHA-256 verified, including same-size updates. Failed or corrupt
HTTP responses are rejected before writing. Game imports check the required archive
folders and available space, and compare existing files in chunks before skipping.
These structural checks do not certify every game edition or modified installation.

### Building and validating the compiler

The checked-in sidecar artifacts are staged automatically. To rebuild them from pinned
sources (Emscripten and Rust with `wasm32-unknown-unknown` required):

```sh
bash xray-16-wasm/misc/web/webgpu/compiler-wasm/build.sh
node xray-16-wasm/misc/web/webgpu/verify-sidecar.mjs
```

The second command uses the workspace's captured shader inputs. It checks the actual
WASM chain against all packaged offline artifacts and reports separately when old
request envelopes must be reconstructed. `compiler-wasm/LICENSES.txt` bundles licenses.
The modules are approximately 4.23 MiB (shaderc) and 0.61 MiB (Naga), uncompressed.

For the browser regression page, stage with `XRAY_SIDECAR_TEST=1 zsh build-webgpu.sh`
and open `/webgpu/sidecar-test.html`. Run the cold test, reload, then run the persistence
test. It exercises the real parked compiler, pthread-style synchronous reply, common
persistent cache and browser WGSL compilation using the renderer's shader flags. Normal
staging removes these test-only files. Debug game pages expose `#webgpu-compiler` counters.

The optional Node offline compiler still requires `glslc` and naga-cli 26 at
`.tools/naga/bin/naga`; `package-shaders.mjs` promotes its outputs to `shaders/`.
`XRAY_SHADER_CAPTURE=1` stages a separate `/webgpu-dev/` page, but it now uses the same
portable worker instead of a localhost service. Serve the release with HTTPS (or
localhost), COOP `same-origin`, COEP `require-corp`, and WASM MIME `application/wasm`.
Include `engine/` as actual files when packaging the staging symlink. Game archives
and user saves are not part of the distribution.

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

## Strict native build (2026-11-07)

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

## Runtime naming cleanup (2026-11-07)

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

## Parked shader compiler verification (2026-11-07)

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
