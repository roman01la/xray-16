# Browser archive installation

Both modes install the full hosted game pack before starting the engine. The
first launch needs about 4.73 GB of game archive data. Later launches check the
new release at startup and download only missing or changed chunks. The launch
screen shows verified bytes and download progress. A failed download retains
verified chunks for the next attempt.

X-Ray mounts the installed original archives read-only at `/stream`. The
WasmFS proxy worker reads byte ranges from verified **16 MiB chunks** in
local CacheStorage. The pack includes campaign resources, levels,
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
Unified staging with a pack also uses the host `vorbisfile` development
library via `pkg-config`. It reads the pack's verified Ogg ranges offline and
stages a compact metadata index with the engine overrides. The browser loads
the index at engine startup. Spawn-time sound discovery can then use the
original sample rate, channel count, frame count, and sound properties without
reading or parsing the Ogg file. Loose files and archive entries without a
matching CRC, size, and offset still use the regular Vorbis reader. Actual
playback continues to decode Ogg audio when needed. Browser NPC sound
collections enumerate numbered variants from the mounted filesystem table.
This preserves the unnumbered sound first, followed by the existing numbered
variants in numeric order, including loose overrides and gaps in numbering.
The engine must be rebuilt with the streaming WasmFS library, and normal staging
copies `streaming.js` and `chunk-reader.mjs` beside `xr_3da.js`.

The unified local preview opens at `/engine-preview/?stream=/pack/pack.json`.
The hosted entry supplies the pack URL automatically. The standalone developer
launcher can use `/webgpu/?stream=/packs/cop-v1/pack.json` with that pack mounted
under the local server root. [Build and stage the game](../README.md)

Streamed single player uses the `stream-cop` OPFS root, separate from any imported
game and its saves. For either game mode, the ingest worker syncs engine
overrides, downloads and verifies the pack, and creates the release-specific
mount file. The launcher receives progress messages and waits for the completed
mount before starting the engine. The parked shader worker initializes the
compiler and caches all packaged programs at startup. Shader variants absent
from the package compile locally during play.

For isolated preview staging, `webgpu/stage.mjs` supports
`XRAY_WEB_DIST_INPUT` and `XRAY_WEB_OUTPUT` absolute directory overrides. The
input directory needs the raw engine JS/WASM, current page files,
`chunk-reader.mjs` and `engine_data.json`. The output's `../engine` must resolve
to the staged engine assets. These overrides avoid changing production files.

## Cache and failures

Each chunk filename is its SHA-256. Startup verifies the size and digest of
cached and downloaded bytes before mounting the pack, including bootstrap
chunks. A warm launch still reads and hashes the installed chunks locally.
Runtime reads use pinned archive descriptors and slice just the requested bytes
from CacheStorage blobs. The archive worker keeps up to 64 recent blob handles
and retains compact bootstrap bundles of at most 256 KiB with their handles.
The installer verifies SHA-256 during startup. Missing or truncated data
fails the read and asks the player to reload and repair the installation.
The engine also keeps a bounded 1 MiB cache of decoded `.ltx` entries up to
16 KiB from the immutable archive mount. Each caller receives a private
reader copy. Loose configs use the normal file path and see edits immediately.

Startup requires enough browser storage for the full pack. Quota and integrity
errors stop launch with a retry message. Verified writes survive a retry, and
save data is stored separately in OPFS. The browser controls storage persistence
and may reclaim data under pressure.

## Verification

`node --test misc/web/tests/streaming.test.mjs misc/web/webgpu/shader-cache.test.mjs`
checks startup installation, incremental updates and rollback, retry after a
partial download, quota errors, archive boundaries, and local-only archive and
shader reads after startup. Playback coverage checks exact blob ranges across
chunk boundaries and bootstrap bundles without hashing or downloading again.

An isolated Chrome run against the locally staged pack installed 319 distinct
chunks totaling 4,733,401,387 bytes. A second startup in the multiplayer root
reused the full pack with zero chunk GETs. One cache-only read from each of the
12 archives also made zero chunk GETs. The parked compiler initialized with all
537 packaged shader programs. A full-game loopback test blocked all pack requests from the page itself. On a
new Chrome profile, the ingest worker installed all 319 chunks before single
player entered Zaton. On the same profile, multiplayer reached world negotiation
without downloading a chunk.
A second loopback test used the optimized game in Chrome 156 with three
eight-NPC spawn waves in Zaton. Each run spawned all 24 NPCs and made zero
runtime chunk requests. Installed range reads reduced gameplay archive p99
from 16.49 ms to 0.66 ms, frame p99 from 24.64 ms to 13.57 ms, and the longest
spawn frame from 2,003 ms to 677 ms. A follow-up build skipped redundant
browser filesystem checks for paths already in lowercase ASCII. In that run,
archive p99 was 1.66 ms, frame p99 was 16.42 ms, and the longest spawn frame was
634 ms. The packed sound metadata index covered 17,801 Ogg files (13,342 unique
archive keys, 678 KiB). A sample of 70 files across five original archives matched
libvorbisfile's direct parsing. With the index, the same test performed 694
gameplay archive reads, down from 3,605. The three largest spawn frames measured
181, 134, and 144 ms in spawn order, down from 634, 240, and 370 ms. Gameplay frame
p99 was 16.10 ms. The mounted-table variant lookup brought the three spawn
frames to 110, 117, and 123 ms and gameplay frame p99 to 15.50 ms. A separate
parity run matched the original existence probes for at least 1,100 stock
sound collection queries and exercised loose files, gaps, and numeric order.
Per-NPC timers in a separate profile attributed 51–57 ms per eight-NPC wave
to Lua sound-theme initialization. The synchronous archive reads in those
frames took 2–5 ms. The first wave loaded ten Lua modules, and the later
waves made no script archive reads. The browser batches consecutive sound
variant discovery in the exact stock `sound_theme` script. It preserves the
unnumbered base file's priority and stops numbered discovery at the first
missing variant, starting at 1. Loose and other script revisions still use
their own Lua code. Sound files are resolved from the mounted filesystem,
including loose assets. The follow-up profile measured sound-theme time at
50, 43, and 39 ms across the waves, down from 57, 51, and 53 ms. The plain
timing run measured spawn frames at 153, 108, and 109 ms. Its first wave
spent 25.6 ms in the same 21 archive reads that took 5.6 ms in the preceding
run. Another run checked at least 13,500 stock lookup calls against the
original probes. A loose script override also reached all 24 NPCs using
its original code.

The subsequent profile compared a single mounted-table sound lookup and the
small INI cache against the previous profiled build. The three gaps were
97, 97, and 111 ms, compared with 119, 101, and 98 ms. Gameplay frame p99
moved from 16.15 to 17.23 ms. The exact stock trade
entry went from 24 archive reads to one, with worker read time falling from
13.87 ms to 0.32 ms. The two later spawn gaps made zero archive reads. Lua
GC varied across waves and sampled at about 3, 19, and 17 ms in the newer run.
Native spawn work sampled at about 20, 30, and 35 ms. The sound lookup matched
at least 13,500 stock calls but showed no separate CPU improvement in this
pair. The cache verification also confirmed independent archived readers and
immediate visibility of edits to loose files.

A real Chrome wasm64/pthread WasmFS probe also reads across a 16 MiB boundary
(`pread`: 3 bytes `ABB`, errno 0). This proves the synchronous C++ to async worker
filesystem bridge.

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
