# Terrain-view rendering profile, 2026-11-09

Source: `/Users/romanliutikov/Downloads/Trace-20261109T183025.json.gz`.
The capture is about 22.1 seconds, from local release
`42c9b4d55927d0e2829a4f0620314ad707543e536e771d0e4587b859e43064d6`.
The user reported max graphics, approximately 50 ms rendering while looking
across terrain and 2 ms while looking down. No settings were changed and no
interactive gameplay reproduction was performed for this investigation.

## Finding

The strongest measured bottleneck is CPU-side detail/grass submission, including
uniform preparation and conversion. The engine worker is continuously occupied
in the expensive interval. This is not simply evidence of a slow GPU or a
resolution problem. Looking away from the large visible detail population removes
almost all of this CPU work.

The recording has no screenshots or camera-direction markers. The intervals
below are expensive and inexpensive intervals in the trace, not independently
verified camera labels. Its older release predates the framebuffer-restoration
fix, but the capture itself shows sustained detail costs, not that exception.

| Trace interval | 1–9 seconds | 14–21 seconds |
| --- | ---: | ---: |
| Substantive engine callbacks (>0.5 ms) | 145 | 405 |
| Callback median | 54.23 ms | 3.43 ms |
| Callback p95 | 58.53 ms | 7.38 ms |
| Detail renderer inclusive sampled time | 5.212 s | 0.023 s |
| Detail renderer exclusive sampled time | 2.896 s | 0.022 s |
| Uniform conversion exclusive sampled time | 1.859 s | 0.034 s |
| Engine-worker idle sampled time | 0.006 s | 4.935 s |

These callbacks include engine work beyond rendering. They are not a separate
GPU duration or the diagnostics panel's exact frame counter. CPU profile sample
intervals were reconstructed by sorting each profile's cumulative time-delta
sample timestamps and charging the interval to the sampled leaf. Inclusive time
includes descendants. Do not add the uniform or draw-encoding times to inclusive
detail time: much of that work is already included.

Across the entire capture, `CDetailManager::hw_Render_dump` accounts for 7.451 s
inclusive and 4.160 s exclusive. `consumeUniformBatch` accounts for 2.671 s
exclusive, of which 2.469 s (92%) occurs under the detail renderer. The JavaScript
samples concentrate on `backend.js:617–621`, the per-component source lookup,
comparison and store loop. `encodeDraw` accounts for another 0.517 s exclusive
and 1.711 s inclusive across all rendering.

The page's UI thread is mostly idle. Audio-worklet work is small. Recorded major
and minor JS GC durations on the engine worker total about 25 ms across the full
capture, so GC does not explain the sustained 50 ms rendering interval. The
other engine workers spend most sampled time in `_do_futex_wait`; these are
waiting threads, not evidence that all those cores are computing continuously.

## Symbol verification

The recording names WASM functions by index and the local build has changed.
The exact recorded WASM is retained at
`mechanics-test/local-preview-repair.SACkGnZv/stage/engine-preview/xr_3da.wasm`
relative to the workspace parent.

Recorded function 5266 matches current function 5265,
`CDetailManager::hw_Render_dump`. Both bodies are 7,517 bytes and differ in only
six bytes, all function-call index operands reduced by one. This establishes the
match without applying a stale symbol map to a different binary. Recorded
function 12793 exactly matches current 12792, `TaskManager::ExecuteOneTask`.
Current matching symbols are archived beside the native-collision local release.

WASM sampling gives only the function entry location, so the exclusive detail
time cannot be split reliably among its inlined transform construction,
per-row uniform shadow updates, copies and bookkeeping from this trace alone.

## What “Rendering” measures

`src/xrEngine/device.cpp:401–464` brackets `DoRender()` using
`emscripten_get_now()`. The reported rendering value is CPU wall time, including
engine submission and JavaScript/WebGPU calls. It excludes the subsequently
measured parallel-task wait. `backend.js:214–219` accumulates those values and
`backend.js:1884–1889` publishes an average over the reporting interval.

A separate GPU timestamp-query measurement exists in `backend.js`, from the
first timed render pass through presentation. The trace does not contain those
resolved `gpuMs` diagnostic values. Chrome `GPUTask` slices are GPU-process
service work and cannot substitute for GPU hardware timestamps. The evidence
supports a major CPU bottleneck, but does not establish GPU frame cost or prove
that GPU work would remain below the target after CPU optimization.

## Why detail submission is expensive

- `src/Layers/xrRenderGL/glDetailManager_VS.cpp:88–230` rebuilds three transform
  rows and one lighting row for every visible detail instance, inside each
  object's shader-pass loop. It does this for each invocation, including the
  supported scene/shadow detail passes.
- `src/Layers/xrRender/DetailManager_VS.cpp:45–49` caps batches at 64 instances
  using the old uniform-register budget. The geometry is duplicated per batch
  slot, rather than using native WebGPU instance records.
- `src/Layers/xrRenderGL/glr_constants_cache.h:284–295` updates the uniform
  shadow separately for every four-component row, then unconditionally queues
  the entire array. The shadow comparisons do not avoid that array upload.
- `src/Layers/xrRenderGL/glBufferUtils.cpp:424–446` copies it into the uniform
  command queue. `backend.js:581–625` walks and compares every component again,
  followed by uniform-arena allocation/copy and draw submission.

The existing contiguous WASM-to-JavaScript array command already avoids one
boundary crossing per row. The remaining costs are inside that bulk command and
inside the detail producer, not a remaining WebGL translation call.

## Recommended changes, in order

1. Add a validated contiguous-array path to uniform ingestion. For tightly packed
   float4 arrays such as detail `array`, use a typed-array bulk copy and one block
   version update instead of the scalar reflection-offset loop. Retain the
   generic path for padded layouts, rectangular matrices and integer uniforms.
   A producer flag or dedicated array command can identify an intentional
   replacement without testing every scalar for equality. This directly targets
   the measured JavaScript hotspot and preserves visual quality.
2. Batch or invalidate uniform-shadow ranges for these replacements rather than
   comparing/copying every row individually before an unconditional upload.
   Preserve coherence with scalar writes to overlapping locations. Cache the
   packed detail transforms/lighting per visibility generation or frame so
   multiple passes can reuse them. Keep pass-specific matrices and wind separate.
   The trace identifies the enclosing WASM hotspot but does not quantify each
   individual inlined operation, so measure this part after implementation.
3. Replace the 64-instance uniform-array scheme with a native WebGPU instance
   buffer and instance-index shader path. Reuse static geometry and packed
   instance data across appropriate passes. Preserve the same detail population,
   wind, lighting and visibility behavior. This is the larger improvement and
   requires shader variants and careful visual verification, not merely raising
   the batch cap past the shader's declared capacity.
4. Add detail instance/draw counts and detail preparation/submission timings to
   diagnostics alongside GPU timestamp results. Compare against this captured
   baseline without rerunning a disabled-changes control. Check a high-detail
   terrain view, close ground view, shadow passes and camera motion.

The initial investigation did not modify rendering. The implementation below
now addresses the full plan. No in-game FPS gain is claimed without a new scene
measurement.

## Implemented follow-up

- `detail-instancing.js` derives a versioned instanced WGSL variant from each
  loaded detail program. The four stock transform/lighting rows arrive through
  vertex attributes 12–15 with instance stepping. Wind, lighting, alpha and
  shadow equations remain in the original shader. Cached offline programs and
  runtime-compiled programs take the same deterministic path. The shader cache
  input is unchanged, while the GPU pipeline key gains `:detail-instances-v1`.
- Browser detail geometry now contains one copy of each mesh. One native indexed
  instance draw replaces the sequence of 61/64-instance uniform-array draws.
  Counts, indices, base vertices and shader passes remain engine-owned.
- `CDetailManager` packs transform and lighting rows once per completed visibility
  generation. Each object/wind-class buffer is reused across subsequent passes
  until `UpdateVisibleM()` advances the revision. Original per-pass wind and
  view matrices are still updated. Level unload destroys all instance buffers.
- Native detail submission drains queued draws and all three state streams before
  the direct draw. Replacing a used buffer goes through the existing streamed
  snapshot pool, so later uploads cannot overwrite earlier unsubmitted draws.
- Remaining vec4 uniform arrays use an explicit bulk-replacement record. Tight
  reflected vec4 layouts copy through `TypedArray.set` and advance their block
  version once. Padded/matrix layouts retain scalar handling. Native array
  replacement invalidates overlapping scalar shadow entries without allocating
  or copying a second shadow for every row.
- Diagnostics now reports `detailPreparationMs`, `detailSubmissionMs`,
  `detailPackedInstances` and `detailReusedBatches` per frame, plus cumulative
  `detailDraws`, `detailInstances` and `uniformBulkBytes`. The staged runtime
  explicitly includes the new shader-variant module.

Validation completed:

- All 58 WebGPU unit/regression tests passed, including every packaged detail
  variant, large instance counts, scalar/array overlap and layout preservation.
- Isolated headless Chrome exercised real WebGPU instancing with 130 instances
  per draw, checked 520 pixels across two buffer replacements before submission,
  and validated actual pipelines for all 16 packaged detail shader variants.
  The fixture is `detail-instancing-gpu.mjs`, deliberately excluded from releases.
- Optimized browser/WASM and native X-Ray builds passed. The native desktop detail
  path retains its existing geometry and rendering behavior.

Manual checks still pending: the original max-graphics terrain view versus the
close-ground view, camera motion at the detail visibility boundary, animated and
static grass, sun/shadow passes, level travel/reload and graphics reset. Compare
against the supplied trace's 54.23 ms expensive-frame median using the new detail
and GPU diagnostics. No user gameplay tab was controlled and no production
release was deployed by this task. The regression fixture establishes rendering
correctness for the covered cases, not an in-game FPS measurement.

## Follow-up: instancing trace and cache correction (19:13 capture)

`Trace-20261109T191340.json.gz` records release
`b6bc9bf56bffcaddb7a266f6518fb5184368cae8542b1480ac8ad414cdc0dce2`.
This is the published instancing build, not a stale client. Exact WASM and
symbols remain archived in `mechanics-test/detail-instancing-release.66xozs1n`.
Its detail renderer is function 5267 according to that matching symbol map.

The user still observes approximately 20 FPS. The new trace supports that:
its 10–18 second interval has 166 substantive engine callbacks, median 50.36 ms,
p95 55.13 ms, occupying 7.97 seconds of that eight-second interval. This is
sustained engine work rather than evidence of a 20 FPS limiter. The old expensive
1–9 second interval's median was 54.23 ms. Camera/scene intervals are not precisely
matched, so this is not a controlled FPS improvement measurement.

| Sampled CPU time across full capture | Before (~22.1 s) | Instancing (~21.7 s) |
| --- | ---: | ---: |
| Detail renderer inclusive | 7.451 s | 10.564 s |
| Detail renderer exclusive | 4.160 s | 6.831 s |
| Uniform conversion exclusive | 2.671 s | 0.280 s |
| WebGPU `writeBuffer` exclusive | not separately reported | 3.353 s |

Inclusive values overlap descendants; do not sum these columns. The new capture
spends longer in the expensive view, making full-capture totals unsuitable as
speedup ratios. Nevertheless the hotspot changed: scalar uniform conversion was
removed, while detail record preparation and buffer upload now dominate. Native
instancing is active. CPU `writeBuffer` time can include browser/driver work and
backpressure; it is not a resolved GPU hardware duration. GPU timing values were
not recorded, so this does not rule out a subsequent GPU bottleneck.

A verified invalidation defect explains unnecessary work: `UpdateVisibleM`
unconditionally incremented the instance revision each frame. Thus packed data
was reusable between passes, but never between unchanged frames. Rendering also
appended four vector records separately per visible instance.

The correction now advances the revision only when the exact ordered visible
lists change, a recalculated instance scale/class changes, or slot decompression
replaces source transforms/lighting. Decompression generation covers pooled
pointer reuse; no hash equality is assumed. The only current writes to source
transform, sun/hemi and original wind class are in decompression. Future writers
must also invalidate this generation. Wind animation remains per-pass shader
state and does not require repacking instance records. Repacking resizes once
and writes contiguous records directly. Existing stream-snapshot buffer lifetime
protection remains intact.

Validation: all 59 renderer tests pass, including a C++ harness compiling the
actual production mutation/publication blocks. It asserts 100 unchanged frames
produce zero additional uploads, scale changes, class changes with unchanged
scale, culling, list reorder and pooled-content replacement each invalidate, and
subsequent passes reuse. Optimized browser build completed 27/27 steps; native
engine/game build completed 184/184. No interactive gameplay was driven, and no
post-correction FPS result is claimed.

Remaining limitation: invalidation is global. Real camera movement, a changed
visible slot, or decompression of an invisible slot can rebuild all visible
batches. The next measured optimization, if necessary, is per-object/wind-class
content generations and selective uploads; persistent per-slot instance storage
would be a larger redesign. The current correction specifically removes proven
unnecessary work on unchanged data without reducing visibility, density, wind,
lighting or shadow quality.

## Follow-up: 19:34 capture and selective invalidation

`Trace-20261109T193428.json.gz` is 26.1 seconds and explicitly records release
`0e543b811c294750d302bcf1819ce3a0fd6b4b0346409227f8181d319d2e5886`, matching
`mechanics-test/detail-cache-release.2xgtbukk` and its archived symbol map.
The mapped detail function is 5269. The cache correction was loaded.

During seconds 10–18, 191 substantive engine callbacks occupy 7.926 seconds,
median 42.46 ms and p95 48.95 ms (previous recording: 50.36/55.13 ms). This is
consistent with the user's approximately 25 FPS, but still CPU saturated.
Intervals are not camera-matched controlled benchmarks. In that interval,
detail preparation has 2.862 s exclusive sampled time and `writeBuffer` 1.757 s;
these are disjoint leaf samples. Full-capture detail time is 8.081 s exclusive,
13.694 s inclusive. Upload time is 5.084 s exclusive, 4.847 s (95.3%) nested
under detail rendering. Engine futex wait is only 0.217 s across the capture.

522 of 523 substantive callbacks during seconds 1–24 contain sampled detail
uploads. Thus the running scene still causes uploads essentially every frame.
The trace cannot establish that any specific frame's visible data was unchanged:
it does not capture the revision-change causes or packed/reused counters. Code
inspection shows the broad invalidation mechanism: a change to any slot,
instance scale/class, or visible-list order dirties every object/class batch.
The previous regression proves unchanged-data reuse, but this recording shows
that global reuse is ineffective in the actual scene. GPU hardware timestamps
are still absent; neither a frame cap nor audio/Lua work explains this profile.

Selective invalidation now replaces the global generation. Each slot's three
render classes owns a content revision. A scale/class change dirties only the
old/new affected class; a decompressed slot dirties its own three lists, covering
pooled transforms and sun/hemi values. Each object/class batch stores the exact
ordered slot identities and revisions consumed by its buffer. It repacks only
when those identities or revisions differ. Removed/reappearing lists, changes
inside an existing list and pool reuse remain observable without hashes.

Diagnostics includes `detailChangedBatches`, `detailMembershipChanges`, and
`detailContentChanges`, alongside `detailReusedBatches` and packed-instance/time
counters. Membership and content reasons can overlap in one batch. They count
batch rebuild causes, not individual slots. The new production helper regression
covers 90 independent batches: one scale change rebuilds one, one class move
two, and one pooled slot replacement three, retaining the unchanged majority;
it also checks unchanged frames, repeated passes, culling, order and reappearance.

Remaining limit: changes to any slot within an object/class still repack that
whole batch. A moving camera can change many batches. This step does not promise
a particular FPS, and does not implement persistent per-slot GPU storage or
GPU indirection. Those would be the next architectural options if the new
counters show most batches legitimately changing each frame.

Validation for selective invalidation: 59 renderer tests passed; optimized browser
build completed 27/27 steps and native engine/game build 184/184, both exit zero.
`git diff --check` passed. No post-change gameplay FPS measurement was performed.

## Hardware headless measurement and incremental slot-span uploads

The user authorized direct gameplay performance testing. An isolated Chrome
profile was used, leaving the user's Chrome untouched. Release
`af398c825b16dffbf73d7e9036c3b813ca0cfd34579926b671f766fdc3303eb5` was published
locally and tested with the real Apple `metal-3` adapter (`isFallbackAdapter=false`),
1920×1080, vsync off and the engine's 501 FPS limit. A stock new game was started;
only the camera was rotated using stock arrow-key look controls. Pointer lock is
unavailable in this headless session. Screenshots verified the rendered scene.

A critical configuration distinction: the stock Extreme preset actually selects
49 detail radius, 0.2 density, height 1, geometry LOD 1, and sun details off. That
lighter configuration reached approximately 185 FPS and is **not** comparable to
the user's maximum-slider report. The demanding measurement explicitly used
radius 300, density 0.1 (densest), height 2, geometry LOD 2, sun details on, and
Extreme's remaining settings. These values were confirmed through stock
`cfg_save` output. The test remains a different camera angle from the historical
user traces; no direct speedup ratio between those scenes is claimed.

At the stationary starting-location view, a 20-second trace recorded 62.44 FPS,
frame median 19.18 ms, p95 22.68 ms, p99 24.96 ms and zero validation errors.
Average diagnostics were CPU render 14.40 ms, simulation 1.74 ms, GPU 6.61 ms,
and detail preparation 10.73 ms. It repacked 194,834 instances per frame despite
reusing 76.44 of 88 batches: 11.56 batches changed from content, with zero
membership-change batches. A subsequent same-view measurement without the Chrome
trace yielded 69.93 FPS, median 17.22 ms, p95 22.18 ms, p99 25.81 ms. Percentiles
are actual presentation intervals; FPS is total frames divided by elapsed time.
Bimodal intervals mean median duration is not the reciprocal of average FPS.

Artifacts are in `/tmp/zone-terrain-live/`: `max-detail-trace.json.gz`,
`max-detail-result.json`, `untraced-result.json`, effective settings and screenshots.
The isolated profile contains a `perfbench` checkpoint for subsequent same-view
measurements. Published engine/symbols are archived at
`mechanics-test/detail-selective-release.r3sbxdah`.

This measurement justified incremental slot-span packing and uploads. Batch
snapshots now retain each slot's packed offset/count. When identities, order and
counts remain unchanged, only changed slots are repacked; neighboring dirty
ranges are coalesced. Membership or count changes retain full rebuilds.

A dedicated native detail patch API updates only those shadow/GPU byte ranges.
It validates the complete range transaction before mutation. Queue writes are
allowed in-place only if the buffer has no use in the current unsubmitted command
encoder. Otherwise the existing full snapshot mechanism preserves the previous
draw's data. Exact encoder identity is recorded on every direct instance draw;
submitted command buffers precede subsequent writes in queue order. Generic
buffer-update semantics are unchanged. Diagnostics adds patched instances/batches,
actual patch bytes and safety fallback counts.

Validation before gameplay remeasurement: 60 renderer tests pass. Actual GPU
readback checks 780 pixels across three 130-instance draws, verifying both the
pending-draw snapshot fallback and a half-buffer patch after submission preserving
the unchanged half. All 16 packaged detail shader variants compile and draw with
zero validation errors. A changed slot count/order rejects the partial path.

### Incremental-upload results and camera-motion limit

Release `4385394a44b5287cea6af94bbd944b70f9615abb881bcd4a0366f670d14526b0`
restored the saved starting-location checkpoint at the same camera, with settings
confirmed again using `cfg_save`: radius300/density0.1/height2/geometry2, sun
details on,1920×1080,vsync off. Extracted stock Advanced UI XML confirms density
is an inverted slider, so0.1 is its maximum. Radius/height are additional console
limits, absent from stock Advanced UI; this is deliberately heavier than simply
maxing the visible grass-density slider. Remaining preset settings include high
sun/shafts/SSAO, anisotropy16,detail bump on; MSAA remains Extreme's off value.

| Same checkpoint,20seconds | Before span updates | After span updates |
| --- | ---: | ---: |
| Untraced average FPS | 69.93 | 163.05 |
| Median interval | 17.22ms | 3.44ms |
| p95 interval | 22.18ms | 11.03ms |
| p99 interval | 25.81ms | 78.59ms |
| Traced average FPS | 62.44 | 161.72 |
| Traced mean CPU detail preparation | 10.73ms | 0.64ms |
| Traced mean instances repacked/frame | 194,834 | 1,259 |
| Traced mean GPU time | 6.61ms | 6.21ms |

Zero validation errors. The uncapped throughput improvement does not imply
smoother tails: long traced callbacks concentrate in GPU API calls (`writeBuffer`,
`finish`,`createView`), consistent with GPU queue backpressure. At a100FPS cap the
same scene measured89.22FPS,median11.20ms,p9515.47ms,p9918.47ms. Browser timers and
pacing mean the nominal cap is not achieved exactly.

A6second continuous camera turn still measured28.82FPS,p9550.02ms: visibility
membership churn repacked about289k instances/frame and cost21.8ms preparation.
This justified the next storage design, rather than declaring the performance
work complete from the stationary result.

### Rejected vertex-fetch experiment

Keep packed records per native slot/wind class, invalidated by the existing exact
source revisions. The renderer maintains stable ranges in up to8 read-only GPU
storage pages. Ordered uint32 references select page+record; only these4-byte
references change when visibility changes, instead of uploading64-byte records.
The vertex shader retrieves the original four rows and retains all existing
wind,lighting and shadow equations. Every offline/runtime variant gets a new
layout-specific shader cache key.

All8pages bind together, so indices remain in exactly the engine's original
order, even when adjacent instances use different pages. There is no regrouping
by page. Per-batch signatures compare exact source identity,allocation offset
and count. Content changes upload only that slot; membership/allocation changes
rebuild the compact index stream. The index array reuses its CPU capacity.

Pages respect the device storage-binding limit (maximum128MiB/page). A256MiB
soft budget triggers LRU range reuse outside the current batch's protected
source set; the hard bound is8pages. Before overwriting a range referenced by
an unsubmitted draw, submit that encoder. Page growth copies oldGPUdata and
submits any encoder retaining the oldpage; oldresources are destroyed only after
submission. Pooled source identities also compare both32-bit revision words.
Level unload releases the arena when its last detail set is deleted. Storage and
extra uniform bind-group caches invalidate one another when sharing a group
index. No visibility,detail density,quality or shader-pass reduction is involved.


The first implementation above was functionally correct but regressed to roughly
35FPS. Two costs dominated: walking about175k source lists in JavaScript every
frame, and indexed storage fetches in the vertex shader increasing GPUtime from
about6ms to19ms. Release `ddd502` was removed from the local default; the validated
span-update release `4385394` remains active while the replacement is measured.

### Compute gather replacement

Keep persistent slot/class records, but perform the indexed gather in a compute
pass only when a batch's content or visibility changes. Compute writes the same
contiguous four-row instance vertex buffer consumed by the validated original
instancing shader. This retains its GPU vertex path and every stock wind,
lighting and shadow variant, with no shader-cache/layout change from v1.

Native slot lists cache their allocated GPU index and uploaded revision. Native
code sends only dirty/new source descriptors to JavaScript; exact ordered
(slot identity,index,count) signatures determine index-stream changes. Eviction
invalidates the native index field, and renderer generation invalidates all
cached allocations after reset/unload. Revisions cover scale,class,transform,
sun and hemi. Only dirty slots repack64-byte source records; membership changes
upload4-byte indices and encode a GPU gather, preserving original order.

Six source pages plus index/output bindings fit the portable eight-storage-buffer
compute limit. Pages respect maxStorageBufferBindingSize, with a256MiB soft
budget and six-page hard bound. Gather dispatches split output and index binding
ranges when necessary. Native-visible slot IDs are protected from eviction during
that batch. Reusing a source range or changing an index buffer first submits any
encoder still reading it; page growth submits pending readers and copies old
content before retirement. Output writes are encoded in compute order between
render passes. Level unload clears the arena after its last detail set releases.

Regression checks cover exact revision updates, unchanged slots, mixed-page
ordering, pool reuse and eviction, page growth, pending compute/render passes,
all16 actual stock detail shader variants and1300 checked pixels on hardware
WebGPU. The isolated gameplay benchmark uses the same saved checkpoint and
maximal grass settings; results follow below once measured without a concurrent
compiler process.

### Compute gather hardware measurement

Measured against the private immutable stage
`mechanics-test/detail-gather-private.hgio6ao2` on port8142, after the parent's
native compiler/linker finished. Same Apple metal_3 hardware adapter, saved
checkpoint,1920×1080 and verified radius300/density0.1/height2/geometry2,
sun details on,vsync0,cap501. This is a comparison with the retained earlier
span measurements, not a newly rerun disabled control. Simulation and weather
continue while the game runs, so a few-percent stationary difference should not
be treated as a precise regression estimate.

| Measurement | Span updates | Compute gather |
| --- | ---: | ---: |
| Stationary untraced20s FPS | 163.05 | 156.47 |
| Stationary median/p95/p99 | 3.44/11.03/78.59ms | 4.85/11.38/42.40ms |
| Stationary traced20s FPS | 161.72 | 147.84 |
| Stationary traced p99 | — | 14.06ms |
| Six-second continuous turn FPS | 28.82 | 101.21 |
| Turn median/p95/p99 | 34.62/50.02/56.64ms | 9.13/15.88/18.43ms |

Turning throughput improves about3.5× while stationary throughput stays close
to the preceding build; neither means every scene sustains100FPS. New traced
stationary averages: GPU6.43ms, CPU render5.05ms, CPU detail preparation1.98ms,
about1339repacked instances/frame, zero index uploads. New turning telemetry
averages: GPU7.71ms, CPU render8.24ms, detail preparation3.78ms,
about2124repacked instances/frame and19.6membership-changing batches/frame.
The new preparation scope includes all native cache checks; earlier span timing
excluded those checks. Full rendering duration is the fairer CPU comparison.

Persistent source storage stayed128MiB with175680slot/class entries and zero
evictions throughout both captures. No WebGPU validation errors occurred.
Turning still uploads substantial compact index data (about830MB between the
first/last telemetry samples over6seconds) and gathers it on GPU; this is the
remaining cost of exact visibility/order changes. CPU visibility processing,
other scene rendering, GPU workload and uncapped queue pacing remain. No quality
or distance setting was reduced.

Artifacts: `/tmp/zone-terrain-live/gather-untraced-result.json`,
`gather-detail-result.json`,`gather-detail-trace.json.gz`,
`gather-turning-result.json`,`gather-game.png`. The local default stays on the
validated span release until the cleaned gather build passes final checks and
is published as a fresh immutable release. No production deployment performed.

Final cleaned build passed63renderer regressions and the hardware fixture again.
It is now published locally as
`94dddce88ca36f7dcdec8a2b12fc4384b509e437ea39bbf2b41a6656fdd9e415`, with
all2177content blobs verified and HTTP hashes checked for WASM,engineJS,
engine manifest,backend,detail-storage and detail-instancing modules. Exact
artifacts/symbols: `mechanics-test/detail-gather-release.3h77ryfe`. Cleanup only
removed the superseded span-upload path and extracted the tested exact native
signature helper; no quality,shader or algorithm change from the measured trial.
