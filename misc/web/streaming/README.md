# Browser archive installation

Both modes install the full hosted game pack before starting the engine. The
first launch needs about 4.73 GB of game archive data. Later launches check the
new release at startup and download only missing or changed chunks. The launch
screen shows verified bytes and download progress. A failed download retains
verified chunks for the next attempt.

X-Ray mounts the installed original archives read-only at `/stream`. The
WasmFS proxy worker reads **16 MiB chunks** from local CacheStorage, with a
64 MiB in-memory LRU. The pack includes campaign resources, levels,
localization, and patches. It omits the stock multiplayer-only archives and
bonus media. Single player and the custom multiplayer mode share the archive
cache while keeping their own settings and saves.

Small archive headers, compressed file tables, and texture-description (`.thm`)
metadata are extracted as bootstrap chunks. Texture metadata is bundled once per
archive, because the renderer scans every texture description at startup. This
avoids downloading unrelated texture payloads or issuing one request per `.thm`. The local
CoP installation has 12 archives totaling 4,732,313,205 bytes, and 675,897 bytes of
archive-header/file-table bootstrap bytes before hash deduplication; texture
metadata bundles add 414,111 bytes (2,738 entries including patch overrides),
for 1,090,008 bootstrap bytes total before deduplication. These are packaging measurements,
independent of the engine and shader downloads.

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

The unified local preview opens at `/engine-preview/?stream=/pack/pack.json`.
The hosted entry supplies the pack URL automatically. The standalone developer
launcher can use `/webgpu/?stream=/packs/cop-v1/pack.json` with that pack mounted
under the local server root. [Build and stage the game](../README.md)

Streamed single player uses the `stream-cop` OPFS root, separate from any imported
game and its saves. The launcher syncs the small engine overrides first, generates
`fsgame.streaming.ltx` and a release-specific mount file after all archive chunks
and descriptors are installed. The engine starts once this finishes. The parked
shader worker also initializes the compiler and caches all packaged programs at
startup. Shader variants absent from the package compile locally during play.

For isolated preview staging, `webgpu/stage.mjs` supports
`XRAY_WEB_DIST_INPUT` and `XRAY_WEB_OUTPUT` absolute directory overrides. The
input directory needs the raw engine JS/WASM, current page files,
`chunk-reader.mjs` and `engine_data.json`. The output's `../engine` must resolve
to the staged engine assets. These overrides avoid changing production files.

## Cache and failures

Each chunk filename is its SHA-256. Startup verifies the size and digest of
cached and downloaded bytes before mounting the pack, including bootstrap
chunks. A warm launch still reads and hashes the installed chunks locally.
Runtime reads use pinned archive descriptors and verified chunks from
CacheStorage. If the browser evicts or damages data while the game is running,
the read fails and the loading screen asks the player to reload and repair it.

Startup requires enough browser storage for the full pack. Quota and integrity
errors stop launch with a retry message. Verified writes survive a retry, and
save data is stored separately in OPFS. The browser controls storage persistence
and may reclaim data under pressure.

## Verification

`node --test misc/web/tests/streaming.test.mjs misc/web/webgpu/shader-cache.test.mjs`
checks startup installation, incremental updates and rollback, retry after a
partial download, quota errors, archive boundaries, and local-only archive and
shader reads after startup.

An isolated Chrome run against the locally staged pack installed 319 distinct
chunks totaling 4,733,401,387 bytes. A second startup in the multiplayer root
reused the full pack with zero chunk GETs. One cache-only read from each of the
12 archives also made zero chunk GETs. The parked compiler initialized with all
537 packaged shader programs. The browser probe used localhost and measured
storage and transfer behavior separately from rendered playability.
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

## Historical on-demand verification (2026-11-07)

Before complete startup installation, the optimized experimental wasm64/WebGPU
engine booted in Chrome with on-demand streaming on an isolated localhost preview. A new `pack-v2` URL provided a fresh
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


## Granular updates and rollback

Game chunk identity is now `(origin, SHA-256)`, independent of the pack's release
URL. Persistent entries use a synthetic `/.xray-cache/game-chunks/<hash>.bin`
CacheStorage key; that URL is never sent to the server. Each requested hash still
comes from the selected release's archive descriptor. Thus a v2 descriptor can
reuse a verified v1 chunk without substituting v1 metadata or mixing releases.
Payload chunks and bundled bootstrap metadata both use this path. Legacy cache
entries keyed by full `/packs/v1/chunks/...` URLs are located once, verified and
promoted without downloading their bytes again. Cached and downloaded bytes
must match both the expected length and hash.

| Component | Update behavior |
| --- | --- |
| Game archive data and metadata bundles | Install every required hash absent from the verified cache at startup. Unchanged hashes survive release-directory changes and rollback. |
| Engine override files | Existing OPFS sync compares size and SHA-256 per manifest entry. Unchanged files are not downloaded; changed files are replaced individually. The current complete override set is about 1.95 MB. |
| Offline/runtime shader programs | Install packaged variants at startup. Offline and runtime results share stable origin-local shader-key entries across releases. Incompatible compiler, reflection, or packing ABI changes invalidate those programs. |
| Engine and shader-compiler JS/WASM | Whole-file browser requests; no binary-delta patching. Updating the engine does not invalidate cached game chunks. Production HTTP caching can reuse unchanged URLs, but the local development server deliberately sends `no-store`. |
| Saves and user configuration | Independent OPFS data; chunk/shader cache reuse and eviction do not erase saves. Existing `fsgame.ltx` is preserved by engine asset sync. |

Publish each pack and matching engine files to new immutable versioned paths.
Upload all chunks/descriptors before switching the entry URL. Keep previous
release directories available for running sessions and rollback; never edit a
live descriptor in place. Clients stay on their chosen release until a reload;
there is no hot engine/content update inside a running session. Keep the same
origin across releases to retain browser storage. A new domain, cleared storage,
browser eviction, or quota failures can require re-downloading missing chunks.
Do not invalidate the whole game cache as part of a normal deployment.

A changed byte inside a payload chunk downloads that complete chunk (normally
16 MiB), not the entire archive. These are fixed-offset chunks: repacking an
archive so byte offsets shift can change many subsequent hashes even if most
logical resources are unchanged. Content-defined chunking, semantic repacking,
and binary deltas are not implemented. Preserve archive layout where practical
and prefer separate patch archives for updates; unchanged archives then retain
all their chunk identities.

Verification includes v1 → v2 → v1 rollback, changed-chunk-only transfer, legacy
URL migration, corruption recovery, and shader reuse across release paths.
The real Chrome CacheStorage probe downloaded **16,777,221 bytes** for v1,
**5 bytes** for the changed v2 tail, and **0 bytes** on rollback. Each release's
small descriptor was still fetched separately. These are controlled fixture
measurements, not a prediction of update size for an arbitrarily repacked game.

```sh
node misc/web/streaming/build-update-probe.mjs /tmp/xray-update-probe
node misc/web/serve.mjs /tmp/xray-update-probe 8094
# Open http://localhost:8094/; expect PASS and the three download counts above.
```

The earlier full-game cold-cache measurements in this document predate this
cross-version cache identity change. Changing only the pack URL no longer creates
a cold game-data cache; use a separate origin/profile for a future cold-load test.
