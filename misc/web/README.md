# Call of Pripyat in the browser

The web port runs the Call of Pripyat 1.6.02 engine as wasm64 with pthreads and
renders through native WebGPU in a worker. The hosted game uses one optimized
engine build for both modes. **New Game** and **Load Game** use the original
single-player simulation. The multiplayer menu item connects to the authoritative
Rust server over WebRTC. [Hosted game](https://stalker-online.xyz/)

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

Multiplayer saves are stored on the server. Use **Controls & save** in multiplayer to copy the save key
or restore it in another browser. Anyone with that key can access the character.

The hosted game installs the full archive pack before the first launch. It
checks for updates before later launches and downloads changed content by hash.
Typical payload chunks are 16 MiB. [Archive installation and caching](streaming/README.md)

## Build and run the unified game locally

Use Emscripten SDK 7.0.0, CMake, Ninja, Node.js 24, Rust 1.93.1 with the
`wasm32-unknown-unknown` target, and a host C++ compiler for the archive packer.
Packed builds also require the host `vorbisfile` development library and
`pkg-config` to build the game's sound metadata index during staging.
Activate the SDK with its `emsdk_env.sh` script. From the repository root:

```sh
git submodule update --init --recursive
rustup target add --toolchain 1.93.1 wasm32-unknown-unknown
emcmake cmake --preset web-multiplayer-release
cmake --build --preset web-multiplayer-release --parallel 6
cargo +1.93.1 build --release --locked --target wasm32-unknown-unknown \
  --manifest-path server/prediction/Cargo.toml
node misc/web/tools/build_dist.mjs
node misc/web/tools/pack-streaming.mjs /path/to/owned/cop /private/cop-pack
node misc/web/multiplayer/stage-game.mjs \
  build/web-multiplayer-release/artifacts ../unified-preview /private/cop-pack
node misc/web/multiplayer/serve-preview.mjs ../unified-preview
```

Replace the example pack paths with your game installation and a writable output
directory outside it. Open <http://localhost:8086/engine-preview/?stream=/pack/pack.json>.
Single player can start from this page once the assets load. To use multiplayer,
run the Rust server alongside the preview. The local server and collision setup
are documented separately. [Multiplayer server](../../server/README.md)

The shader compiler worker and its WASM modules are included in the stage. It
uses packaged shaders where available and compiles missing variants locally into
the same persistent cache. [WebGPU renderer and shader tools](webgpu/README.md)

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
unified game. [Unified deployment](../../server/deploy/FLY.md)

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
