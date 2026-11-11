# Call of Pripyat in the browser

The web port runs the Call of Pripyat 1.6.02 engine as wasm64 with pthreads and
renders through native WebGPU in a worker. **New Game** and **Load Game** use the
original single-player simulation. [Hosted game](https://stalker-online.xyz/)

The web build has been tested in desktop Chrome. Browsers need worker WebGPU,
BC texture compression (including sliced 3D), wasm64, shared memory, and Origin
Private File System (OPFS) support. Browser sound uses AudioWorklet with bounded
shared-memory PCM queues. Click or press a key if the browser asks for an
interaction to enable audio. The engine starts with 2 GB of WASM memory.
Serve over HTTPS or localhost with COOP `same-origin`, COEP
`require-corp`, and the `application/wasm` MIME type.

## Display, controls, and saves

The game renders at the browser viewport's aspect ratio. The resolution in
video settings limits the size of the render target. For example, a 1920×1080
preset renders at 1440×1080 in a 4:3 browser window. The browser scales that
frame to fit the viewport as the window or display scaling changes.

New browser profiles use a 60 FPS limit and VSync. Change either in **Options →
Video → Advanced**. The FPS limit offers 30, 60, 100, and 120. With VSync on,
the browser presents on display refreshes, so a 60 Hz display can show up to
60 FPS even with a higher limit. Menus also respect the separate menu FPS limit.

Escape opens the game menu and F1–F4 use the quick slots. If the browser uses
Escape to release the mouse, press it again. Add `diagnostics=1` to the page query
for the selected GPU adapter, FPS, render size, CPU and GPU timings, and WebGPU
validation errors.

Grass sun shadows render into the near and middle sun cascades by default on the
web build (`r2_sun_details_cascades 2`); the far cascade is skipped because its
shadow-map texels are coarser than a grass blade. Set `r2_sun_details_cascades 3`
in the console for the original all-cascade behavior.

Single-player saves stay in the current browser origin. The startup overlay's
**Download Saves** exports a JSON backup. **Import Saves** opens an engine-free
restore screen: choose that backup, then **Return to Game** and use **Load game**.
Import validates the whole backup before writing, preserves existing saves and
thumbnails with matching names (case-insensitive), and rolls back new files if a
write fails. Close other game tabs before importing. Interrupted imports recover
before the next game session. New backups include file checksums; older
`openxray-saves-v1` backups remain supported with structural validation. Import
does not prove compatibility with another engine/mod version. Original file
modification dates are not carried by this backup format.

The hosted game installs the full archive pack before the first launch. It
checks for updates before later launches and downloads changed content by hash.
Typical payload chunks are 16 MiB. [Archive installation and caching](streaming/README.md)

## Build and run the game locally

Use Emscripten SDK 7.0.0, CMake, Ninja, Node.js 24, a host C++ compiler,
`pkg-config`, `lzo2`, and `vorbisfile`. Activate the SDK with `emsdk_env.sh`.
From the repository root:

```sh
git submodule update --init --recursive
emcmake cmake --preset web-release
cmake --build --preset web-release --parallel 6
node misc/web/tools/pack-streaming.mjs /path/to/owned/cop /private/cop-pack
node misc/web/tools/stage-game.mjs bin/wasm64/Release ../browser-preview /private/cop-pack
node misc/web/serve.mjs ../browser-preview 8086
```

Open <http://localhost:8086/engine-preview/?stream=/pack/pack.json>.
The shader compiler worker and its WASM modules are included in the stage. It
uses packaged shaders where available and compiles missing variants into the
same persistent cache. [WebGPU renderer and shader tools](webgpu/README.md)

Publishing uses immutable engine releases and shared compressed game chunks.
[Cloudflare deployment](../../server/cloudflare/README.md)

## Standalone developer launcher

The single-player-only developer launcher remains useful for testing local
folder imports and the renderer's detailed profiling tools. Build and stage
it from the repository root using the same Emscripten SDK:

```sh
emcmake cmake --preset web-release
cmake --build --preset web-release --parallel 6
node misc/web/tools/build_dist.mjs
node misc/web/webgpu/stage.mjs
node misc/web/serve.mjs misc/web/dist 8081
```

Open <http://localhost:8081/webgpu/?debug=1&autostart=0> to import your CoP folder,
manage save backups, or launch manually. The game-only developer view is at
<http://localhost:8081/webgpu/>. This launcher is separate from the hosted
hosted game. [Cloudflare deployment](../../server/cloudflare/README.md)

## Automatic FPS limit

Fresh browser settings default to **Auto** (`rs_fps_limit 0`), with VSync enabled.
Auto follows the browser's presentation cadence instead of imposing the previous
60 FPS gameplay cap. With VSync disabled, the measured display rate supplies the
cap (60 FPS until timing samples are ready). Measurements follow the visible tab;
they estimate browser presentation timing, not a guaranteed physical monitor mode.
Menus retain their independent 60 FPS limit.

The FPS dropdown also offers 30, 60, 100 and 120, and retains saved custom values.
Saved numeric limits are not overwritten, including previously saved defaults:
there is no historical flag distinguishing an explicitly chosen 60 from an old
saved default. Existing players can select Auto once to opt in; zero persists in
user.ltx and stays automatic across launches and monitor changes.

## Single-player release verification

The 2026-11-11 single-player-only release passed an optimized engine build and
40 browser storage/loading/compatibility/analytics regression tests. A private
headless Chrome profile installed the full pack and started a fresh campaign,
reached the end of synchronization, and rendered with VSync on and zero WebGPU
validation errors. The staged release contains 46 JavaScript modules (539,176
raw bytes), with no custom replication modules or prediction WASM sidecar.

Manual regression coverage still includes existing-save loading/saving, equipment,
consumables, combat, NPC interactions, level travel, and Auto/custom FPS selection
across monitors. Original engine networking classes remain where part of X-Ray;
no custom gameplay service or browser network adapter is built or shipped.
