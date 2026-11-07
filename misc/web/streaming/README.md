# Coarse archive streaming

The optional streaming path mounts original game archives read-only at `/stream`.
It does not import the complete installation into OPFS. X-Ray's existing archive
`pread` calls fetch the required **16 MiB chunks** through a dedicated WasmFS
proxy worker. Browser UI stays responsive while a synchronous engine read waits.
A cold miss can still pause the game thread; predictive prefetch is future work.

The pack retains the game's archive groups: configuration/shared resources,
level data, localization and patches. This is archive-level grouping with coarse
payload subdivisions, not one HTTP request per texture, model or sound. The
existing archives are not repacked semantically per level; shared assets can
still require several chunks. Multiplayer-only archives and bonus media are
excluded from this single-player pack.

Small archive headers, compressed file tables, and texture-description (`.thm`)
metadata are extracted as bootstrap chunks. Texture metadata is bundled once per
archive, because the renderer scans every texture description at startup. This
avoids downloading unrelated texture payloads or issuing one request per `.thm`. The local
CoP installation has 12 archives totaling 4,732,313,205 bytes, and 675,897 bytes of
archive-header/file-table bootstrap bytes before hash deduplication; texture
metadata bundles add 414,111 bytes (2,738 entries including patch overrides),
for 1,090,008 bootstrap bytes total before deduplication. These are packaging measurements,
not a measured playable-scene download budget.

## Prepare and launch

```sh
node misc/web/tools/pack-streaming.mjs /path/to/owned/cop /private/site/packs/cop-v1
```

Host `pack.json`, descriptor JSON and `chunks/` on the same origin as the game.
Use an **immutable versioned directory** for each pack; never overwrite a pack
while clients are running. Game content is not included in the repository.
The packer compiles a small host helper from the existing engine LzHuf decoder
(`c++` or `CXX` is required) to inspect compressed archive tables.
The engine must be rebuilt with the streaming WasmFS library, and normal staging
copies `streaming.js` and `chunk-reader.mjs` beside `xr_3da.js`.

Open `/webgpu/?stream=/packs/cop-v1/pack.json`. This opts into a separate
`stream-cop` OPFS root; imported games and their saves remain untouched. The
launcher syncs the small engine overrides first, generates
`fsgame.streaming.ltx` and `stream.mount`, then starts the engine. Starting a new
game or loading a save requests only the archive chunks those reads need.

For isolated preview staging, `webgpu/stage.mjs` supports
`XRAY_WEB_DIST_INPUT` and `XRAY_WEB_OUTPUT` absolute directory overrides. The
input directory needs the raw engine JS/WASM, current page files,
`chunk-reader.mjs` and `engine_data.json`. The output's `../engine` must resolve
to the staged engine assets. These overrides avoid changing production files.

## Cache and failures

Each chunk filename is its SHA-256. Downloads and persisted cache hits are
verified before use. CacheStorage retains validated bytes across reloads; a
64 MiB LRU bounds the hot JS byte cache. Cache eviction or quota exhaustion falls
back to network access. Concurrent reads share chunk downloads. Corrupt cache
entries are discarded; corrupt/missing network responses fail the engine read
with EIO, never provide zero-filled replacement content. There is no silent
whole-installation or whole-archive fallback.

The cache is persistent on a best-effort basis and can grow to the chunks visited
by the player. A chunk-cache management UI and adaptive prefetch are not yet
implemented. Saves use OPFS independently of CacheStorage.

## Verification

`node --test misc/web/tests/streaming.test.mjs` checks on-demand reads, cross-chunk
boundaries, EOF, bootstrap-only reads, bounded RAM, coalescing, cache corruption,
missing chunks, invalid manifests, quota failure and save-path preservation.
A real Chrome wasm64/pthread WasmFS probe also reads across a 16 MiB boundary
(`pread`: 3 bytes `ABB`, errno 0). This proves the synchronous C++ to async worker
filesystem bridge. Actual full-game startup and download measurements must be
recorded separately before claiming playable-scene streaming validation.

The implementation reuses Emscripten 7.0.0's `FetchBackend` C++ proxy architecture
and overrides its JS operations. It avoids the stock backend's whole-file
fallback and unbounded RAM cache. Reference: local toolchain
`system/lib/wasmfs/backends/fetch_backend.cpp` and
`system/lib/wasmfs/proxied_async_js_impl_backend.h`.

Reproduce the standalone browser probe:

```sh
EMXX=/path/to/em++ node misc/web/streaming/build-probe.mjs /tmp/stream-probe
node misc/web/serve.mjs /tmp/stream-probe 8093
```

Open `http://localhost:8093/`; expected result is `STREAM_PROBE PASS`, `ABB`,
archive size 33,554,437 bytes. The five-byte third payload chunk is not read.

## Full-game verification (2026-11-07)

The optimized experimental wasm64/WebGPU engine booted in Chrome through this
backend on an isolated localhost preview. A new `pack-v2` URL provided a fresh
game-chunk cache namespace; engine overrides/shaders were already available from
an earlier preview. The original single-player deployment was not replaced.

Measured server response bodies for game pack metadata/chunks:

| Checkpoint | Downloaded game data | Total installed archive data |
| --- | ---: | ---: |
| Main menu | 269,944,242 bytes | 4,732,313,205 bytes |
| New game in Zaton; movement and pause/resume verified | 2,512,422,871 bytes | 4,732,313,205 bytes |

About 47% of game archive bytes were not downloaded at the playable checkpoint.
This excludes engine WASM/JS, shader binaries and engine override downloads; it
is not a measured first-visit total or an internet-bandwidth startup benchmark.
The `.thm` scan reported 36 ms with bundled metadata, versus 12,554 ms in the
preceding unbundled local run. Other level/movie/resource chunks remained absent
from the HTTP log. The test tab was closed after validation, retaining the
existing single-player game tab.

The initial playable download is still large. Original archives mix resources,
so 16 MiB reads can fetch unused neighbours. Content-aware regrouping and
prefetching are further work; synchronous cold filesystem reads can currently
stall the game while the requested chunk downloads. Cross-level travel,
long sessions, and constrained-network conditions have not been validated.
