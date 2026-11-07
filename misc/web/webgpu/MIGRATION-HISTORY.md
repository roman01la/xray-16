# Historical renderer migration measurements

These notes describe superseded builds and are not current runtime documentation.

## Historical migration results

The sections below through “Native resources, queries, submission and copies”
record earlier stages. References to compatibility modes and shared GL tables
describe those earlier builds, not the current native-only runtime.

### Initial verification and performance

Chrome on this Mac, Jupiter `online-stash` checkpoint, 1280×720. Sequential
30-second samples used the same checkpoint and camera, after warm-up, without
per-call profiling or concurrent builds:

| Metric | Previous mirrored backend | GPU-only backend |
| --- | ---: | ---: |
| Average FPS | 43.08 | 61.46 |
| Median frame time | 21.30 ms | 15.52 ms |
| 95th percentile frame time | 34.50 ms | 21.49 ms |
| 99th percentile frame time | 42.52 ms | 23.83 ms |
| Validation errors | 0 | 0 |

FPS improved **42.7%**; p95 frame time decreased **37.7%**. These are comparisons
against the previous WebGPU implementation, not the original WebGL renderer.
Raw results are `webgpu-baseline-benchmark.json` and
`webgpu-optimized-benchmark.json` in the enclosing workspace. Queue submissions
were reduced from about 66 per frame to one in the profiled scene.

Level rendering, weapon/HUD, movement, inventory and native screenshot persistence
were verified in the initial GPU-only work. The screenshot command wrote a 1,004,162-byte JPEG into the game's
OPFS screenshot directory. The engine rebuild and eight regression tests passed:

```sh
node --test xray-16-wasm/misc/web/webgpu/*.test.mjs
```

Tests cover shader translation/reflection, matrix uploads, command-context state,
integer vertex conversion and occlusion-query lifecycle. Other levels and graphics
settings still require testing; the upstream port's asset warnings remain. The
frontend implements the operations needed by this renderer, not every GLES API.

## Browser-readiness checks (2026-11-07)

- With compiler stopped: Jupiter checkpoint and imported backup loaded successfully.
- A fresh Zaton campaign, weapon firing/reload, Zaton-to-Pripyat console transition,
  and NPC dialogue progression were exercised in developer capture mode. This added
  two shader programs to the static package.
- Save export produced a verified 4,346,321-byte JSON backup of six files. A separate
  backup was imported through the native file picker and loaded after restart.
- Storage persistence was declined by Chrome; the UI reports this and backup works.
- Regression tests include binary backup validation, same-size asset updates, corrupt
  download rejection, and synchronous shader key compatibility with offline SHA-256.

Run all tests from the workspace:

```sh
node --test xray-16-wasm/misc/web/webgpu/*.test.mjs xray-16-wasm/misc/web/tests/*.test.mjs
```

Remaining qualification: full quest completion/trading/combat encounters, long
sessions, all graphics settings, audio/focus recovery, and other hardware/browsers.
Save thumbnails remain unimplemented in the upstream GL screenshot path. The test
console transitions verify loading/unloading, not normal quest-gated travel.

### Standalone release

`bash package-browser.sh` creates `browser-release.tar.gz` and its SHA-256 checksum.
The archive contains the engine, launcher, shaders and engine support assets;
players import their own game data. It requires a static host with the isolation
headers described above, but no shader server. Release packaging excludes macOS
metadata and materializes staging symlinks.

The clean Zaton campaign and save `browser-fresh-start` were verified with the
compiler stopped. Native fullscreen entry/exit works; use Escape to release mouse
capture before clicking the toolbar. Chrome reports game audio playback, though
sound quality and audio recovery have not been audited.

**Known save compatibility failure:** the downloaded `online-stash` checkpoint
(and copies of it) loads in Jupiter but aborts on a test return to Zaton because
it references missing `dynamics\weapons\wpn_pm\wpn_pa.ogf`. Its precise origin is
not established. Keep the original save; use a fresh campaign for qualification.
This is a game-content/save compatibility failure, not a missing shader. No model
substitution or save-file modification was applied.

### 1080p Extreme optimization (2026-11-07)

The clean `browser-fresh-start` Zaton checkpoint was measured in stationary
outdoor gameplay at 1920×1080, Extreme preset, profiling disabled, compiler stopped.
Thirty-second samples improved from 34.17 FPS (p95 34.28 ms) to 110.90 FPS
(p95 11.66 ms, p99 14.52 ms), with zero WebGPU validation errors. This is
presentation-submission throughput, not a guaranteed displayed-frame rate or
minimum across all locations/combat. MSAA remains disabled by the upstream GL path.

Optimizations cache uniform offsets, vertex layouts, pipeline/pass state,
framebuffer attachments and texture views, and batch vegetation array uploads.
VSync-off now uses yielding immediate tasks rather than adaptive rAF pacing;
VSync-on retains the existing display pacer. `rs_fps_limit` still applies.
The debug toolbar's **Profile CPU** also reports optional GPU timestamp duration.
Benchmarking disables profiling to avoid per-command timer overhead.
The shader package now contains 506 programs, including tested Extreme variants.

### Native Retina resolution

On the M2 Max (38 GPU cores), the built-in display reports 3456×2234 native
pixels. The game is saved at this resolution, Extreme, VSync off. The launcher
now derives the game-only canvas aspect ratio from its actual render dimensions.

At native resolution, reusing unchanged texture/sampler bind groups improved the
same Zaton 30-second sample from 91.89 to 104.16 FPS (p95 14.05 to 12.24 ms,
zero validation errors). Bind groups invalidate on changed textures, samplers,
sampler parameters, sampler uniforms, or recreated texture storage. Regression
tests verify texture rebinding alongside vertex-buffer and pipeline invalidation.
A separate direct-constant-lookup experiment had no measurable benefit at 1080p
(109.53 versus 110.90 FPS) and was reverted. These are scene samples, not a
campaign-wide minimum FPS guarantee.


## CPU profiling and populated-scene validation (2026-11-07)

M2 Max, native 3456×2234, Extreme, VSync off, original Lua GC step 100.
Thirty-second unprofiled runs from saved checkpoints:

| Scene | Before FPS | After FPS | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Quiet Zaton spawn | 100.80 | 112.41 | 13.04 ms | 11.49 ms |
| Skadovsk populated bar | 61.39 | 68.15 | 19.97 ms | 18.11 ms |

The final NPC comparison explicitly reloaded `browser-cpu-skadovsk` with both
renderers and verified active gameplay before and after measurement. Measurements
are engine presentation intervals, not physical display refresh or campaign-wide
minimums. The NPC scene remains below 100 FPS.

The main changes avoid globally rebuilding every vertex layout after unrelated
GPU buffer allocations, cache pipelines within each vertex layout, and remove
per-draw viewport/scissor string allocation. Tests cover affected/unaffected
buffer changes, pipeline state, viewport/depth/scissor changes, and texture binding.
The animated-menu YUV shader is now packaged, bringing the shader count to 507.

`?debug=1` exposes **Profile CPU** and **Benchmark 30 s**. CPU profiling keeps ten
recent per-frame samples in `#webgpu-profile-samples`; benchmarks disable profiling.
Engine simulation, render, and parallel-wait timings accompany the renderer
substeps. With `rs_stats on`, `#webgpu-subsystems` also shows existing engine object,
AI thinking/vision and Lua GC counters. These engine counters are decaying peaks,
not additive averages. Disable `rs_stats` before benchmarking.

Instrumentation has significant per-command overhead. In the final ten-sample
profiles, simulation averaged 1.37 ms in the quiet scene and 4.34 ms at Skadovsk;
render CPU time was 12.06 and 19.24 ms respectively, including profiling overhead.
Parallel wait was negligible. Draw layout/lookup, command encoding, and uniform
copies remain material costs. AI and Lua GC warrant deeper investigation; no
AI frequency or GC policy changes were shipped. A GC experiment measured the
menu accidentally and was discarded. Final benchmark files supersede exploratory
or interrupted runs. Full machine-readable results are in the workspace's
`cpu-profile-result.json`.


### Rendering CPU investigation at 720p

The `Profile phases` control records the existing engine phase timestamps without
per-command timers. At the populated Skadovsk checkpoint, ten recent samples
averaged 3.14 ms simulation, 11.98 ms rendering and 0.023 ms task wait. The
render bracket includes engine work, Emscripten glue and WebGPU submission.
Detailed instrumentation slows this scene to about 41 FPS, so its nested
timings are rankings, not additive estimates of uninstrumented frame cost.

The engine now uses its existing base-vertex draw path: the compatibility ABI
forwards baseVertex and firstInstance directly to WebGPU drawIndexed, avoiding
attribute re-pointing for base offsets. wasm64 index byte offsets are converted
from BigInt. A 30-second 720p comparison measured 67.91 FPS with the old path and
71.32 FPS with the direct base-vertex path, both with zero validation errors.
NPC activity varies, so the roughly 5% difference is provisional.

The served Wasm matches the Release artifact: compile and link use -O3 -DNDEBUG,
SIMD and pthreads; LTO is off. The debug URL only shows diagnostic UI.

For a larger reduction, introduce a native CBackend draw-record interface with
cached pipeline/material handles and batched uniform blocks, then migrate one
opaque pass and A/B it before expanding. Reuse WebGPU resources, WGSL and offline
reflection. A one-for-one API replacement would retain most draw and data costs.
The workspace render-cpu-investigation.json contains measurements and priorities.


### Direct engine draw submission

The WebGPU build defaults to a direct CBackend submission path. Both indexed and
non-indexed CBackend::Render overloads call SubmitWebGPUDraw. An EM_JS bridge
resolves existing resource IDs and passes geometry, program, stride, topology,
count, first index/vertex and base vertex to GPUFrontend.submitDraw. It does not
call GLES draw wrappers, the command proxy, SetBaseVertex or GetVertexArray.

Vertex declarations are registered once as packed uint32 descriptors and copied
out of Wasm memory. Geometry/layout caches use declaration and buffer object
identity plus stride; GPU buffer replacement still invalidates dependent layouts.
The shared encodeDraw implementation consumes explicit geometry/program inputs,
so direct draws do not mutate compatibility VAO state. Submission is synchronous,
preserving clear, upload, query and draw ordering. This is not a deferred command
stream; uniform batching is described below.

Resource creation and the remaining render-state setters use the compatibility ABI.
Common CBackend states now use native batches, described below.
The default uniform path now uses the packed batch described below. The WebGL build falls back
automatically when no WebGPU backend exists. In the diagnostic toolbar, `Use GLES
submission` and `Use direct submission` switch paths live for A/B measurements.
`#webgpu-submission` and completed benchmark JSON expose direct and legacy draw
counts, making the active path verifiable. Normal game-only mode hides controls
and defaults to direct submission on each launch.

Fresh-load 720p Skadovsk validation measured 68.33 FPS through GLES and
73.77 FPS directly (8.0% higher). Both runs warmed for 20 seconds
after entering gameplay and measured for 30 seconds without profiling. The direct
run submitted 5,604,427 direct draws and zero GLES draws, with zero
validation errors. Live NPC activity still varies. A later exploratory run with
roughly 3,323 draws/frame fell to 66.74 FPS, so this does not establish a 100 FPS
guarantee. Inventory and animated main-menu rendering were verified. All 14
renderer/storage tests pass. Raw results and limitations are recorded in the
workspace direct-submission-result.json.


### Prepared records and uniform batches

The direct renderer caches prepared draw records by geometry layout, pipeline
state identity, render-target compatibility and topology/index format. Records
contain resolved WebGPU pipelines and material bind-group handles. Material
handles are cached by GPU resource identity, including reuse after A/B/A changes.
The native bridge still supplies geometry/program/draw arguments; GPU handles
are resolved and cached inside the JavaScript renderer.

Dirty engine uniforms (including samplers) are packed into a bounded Wasm queue
and consumed before submission, on capacity overflow, or when switching modes.
Unchanged uniform blocks reuse their arena offset within an epoch. Changes,
frame resets and arena wraparound allocate a new snapshot, preserving earlier
draws. GPU upload batching remains at submission boundaries.

The diagnostic `Use previous updates` button disables prepared records, native
uniform batching and uniform allocation reuse for comparison while retaining
direct draw submission. `#webgpu-prepared` and benchmark `work` counters expose
cache hits, batches, records, copied bytes and allocation reuse. Both paths use
the current shared encoder, so this is not an old-binary comparison.

All 17 renderer/storage tests pass, including matrix shapes, array offsets,
integer/sampler updates, unchanged-data reuse and arena wraparound.

At 720p Extreme in populated Skadovsk, 30-second Release runs measured
75.10 FPS with previous updates and 86.53 FPS with prepared updates (+15.2%).
Prepared lookup hit rate was 96.9%; uniform bytes copied per frame fell 37.6%.
Both had zero validation errors and zero legacy draws. NPC activity varied
(2,204 vs 2,319 draws/frame), so this is a provisional comparison, not a fixed
speedup or a 100 FPS guarantee. See prepared-submission-result.json in the workspace.


### Native render-state batches

CBackend depth, stencil, blend, color-write, cull and scissor setters now append
fixed six-word native records. The WebGPU renderer consumes these engine enum
values directly before draw submission, clears, compatibility state overrides,
and state queries. No GLES function dispatch or enum conversion is needed for
these engine updates. CPU state caches still suppress unchanged setters.

Pipeline keys are invalidated only when pipeline-relevant values change; stencil
reference and scissor-only updates keep the cached key. Compatibility query
mirrors are updated so UI save/restore operations see the current native state.
The bounded queue flushes on capacity and before toggling modes. WebGL retains
its original fallback path. In diagnostics, `Use legacy states` disables only
this feature; prepared records and uniform batching remain enabled.

Some pass-specific state calls and resource creation remain on the compatibility
ABI. Viewport/depth range and engine texture/sampler bindings now use native
records as described below. This is a migration of
common engine state updates, not removal of the entire ABI. Tests compare all
supported enum values with the compatibility implementation and cover dynamic
pipeline reuse, query visibility and mixed-path clear/override ordering.

Release 720p Extreme Skadovsk runs measured 82.51 FPS with legacy states
and 95.68 FPS with native batches, zero validation errors and zero legacy
draws. The native run consumed 5,779,583 records in
883,684 batches (6.54 records/batch). It had
2170 draws/frame versus 2352 in the control; NPC activity
varied, so the full FPS difference cannot be attributed to batching. Follow-up
phase samples averaged 7.70 ms rendering and
2.84 ms simulation. All 19 tests pass. Raw results are
in the workspace state-batches-result.json.


### Native texture/sampler bindings and viewport

Engine texture application (normal, sequence and video), sampler binding, and
clearing unused pixel/vertex texture stages now emit packed four-word records.
Each record names an explicit texture unit and resource ID; the WebGPU renderer
resolves object identity from the existing resource tables without calling GLES
binding wrappers. Resource changes invalidate cached material selection; repeated
bindings retain it. Clear-stage records preserve other units and sampler bindings.

Pending records are consumed before draws and compatibility binding overrides,
texture uploads/copies, parameter access, state queries, and resource deletion.
This preserves active-unit queries, video texture updates and UI save/restore.
Deletion clears matching live bindings and invalidates materials; earlier draws
are submitted before texture destruction. Resource creation/upload APIs still
use the compatibility ABI. Startup binds before bridge registration also fall back.

Viewport and float depth-range records now use the native state queue. Unchanged
arrays retain identity to avoid redundant WebGPU setViewport calls. They do not
invalidate pipeline keys. The `Use legacy bindings` diagnostic control switches
only the binding queue; native state and prepared/uniform paths stay enabled.
`#webgpu-binding-batches` and benchmark counters expose batches and records.

Release 720p Extreme Skadovsk validation measured 93.68 FPS using legacy
bindings and 99.20 FPS using native bindings, with zero validation errors
and zero GLES draws. Both modes retained the new native viewport path. The native
run consumed 3,537,842 binding records in 1,017,675 batches.
Draw counts were 2159 versus 2098 per frame; live NPC variation means
the measured gain is provisional. All 22 tests pass. Machine-readable results
are in native-bindings-result.json in the workspace.


### Native framebuffer/pass setup, clears and presentation

CBackend framebuffer selection and color/depth attachment updates now append
native records to the ordered state queue. Draw-buffer lists from u_setrt,
CBackend target setup and CRT resolve use native records too. Repeated attachment
and draw-buffer descriptions retain the cached WebGPU target descriptor.

Full-target ClearRT/ClearZB use one direct bridge call that consumes pending
state, installs the target, updates clear/write-mask state and begins a WebGPU
render pass with clear load operations. CHW::Present calls a native presentation
entry point, bypassing read/draw framebuffer binding wrappers and GLES blit.
It reuses the existing WebGPU presentation shader, queries and submission logic.

The diagnostic `Use legacy passes` control disables this migration independently
of native state/binding queues and prepared draws/uniforms. Counters in
`#webgpu-native-passes` and benchmark JSON report native pass records, clears and
presentations. Compatibility framebuffer operations, queries, texture deletion,
copy/readback and occlusion-query begin consume pending pass state first.

This does not remove the entire compatibility ABI. Resource creation/uploads,
shader/program setup, rectangular-clear fallback, some pass-specific operations,
and copy/readback wrappers still use it. Native and compatibility paths share
resource identity and query-visible state. Tests compare framebuffer targets,
sparse MRTs, attachment cache invalidation, clear state and mixed-path ordering.


Program and vertex-array selection also bypass GLES wrappers when native passes
are enabled. Program selection updates both the renderer program and Emscripten's
query/uniform-mapping currentProgram pointer. Vertex selection preserves per-VAO
element buffers and the default VAO. Direct draw geometry remains independent of
this compatibility state. The optimized generated Emscripten wrappers were
checked to confirm these are their only state side effects in this build.
The selection change is covered by the 25-test renderer/storage suite.

Benchmark policy: reuse the previous optimized run as the baseline; do not run
an additional feature-disabled control unless a specific unresolved regression
requires it. Record scene workload differences alongside FPS.

Final production validation: 97.29 FPS over 2,919 frames at 1280×720 Extreme
in populated Skadovsk, zero validation errors and zero legacy draws. The previous
optimized baseline was 99.20 FPS; this does not establish an FPS improvement,
and live NPC workloads differ. Native counters recorded 983,716 pass records,
30,150 clears, 2,919 presents, 1,246,113 program selections and 730,167 VAO selections.
The final detailed profile averaged about 214 compatibility calls/frame and
0.301 ms/frame inside compatibility calls (including profiling overhead), with
bufferData around 0.203 ms as the largest remaining compatibility operation.
Gameplay, inventory and menu rendering were checked. All 25 tests pass.
Workspace artifacts: native-passes-final-benchmark.json,
native-passes-final-profile.json and native-passes-result.json.

### Native resources, queries, submission and copies

Geometry buffers now allocate, replace, update and delete through explicit native
handles. Stream uploads no longer bind buffers or enter Emscripten GLES wrappers.
Replacement allocations retain resources referenced by earlier draws; sub-buffer
updates retain ordered staging-buffer copies and 4-byte alignment. Converted
vertex allocations are retired when their source storage is replaced.

DDS textures (including compressed mip chains, cube faces and 3D data) and render
targets allocate through native handles. Uploads preserve source channel conversion,
format, extent and engine texture metadata. Video frame uploads and texture deletion
also bypass GLES. Resource IDs still live in shared Emscripten tables for compatibility
with remaining startup operations; this is not removal of the whole GLES ABI.

Occlusion query creation, begin/end, availability/results and deletion use direct
bridges. Queries retain asynchronous readback and generation protection; deleted
queries cannot receive late results. The browser never waited on frame fences,
so its sync point now submits the ordered WebGPU queue without allocating unused
fence objects/completion promises. Framebuffer texture copies use explicit source
and destination textures. Screenshot capture was already native and asynchronous;
failed mapping now also destroys its readback allocation.

Production validation: 99.60 FPS across 2,988 frames at 720p Extreme in populated
Skadovsk, zero validation errors and zero legacy draws. The saved previous run was
97.29 FPS; scene workload differs (2,034 vs 2,130 draws/frame), so the 2.4% difference
is not a controlled causal speedup. No feature-disabled benchmark was rerun.
The captured detailed profile reports zero compatibility calls/frame, versus about
214 in the previous capture. This excludes native WebGPU work, which still costs
CPU time. All 30 renderer/storage tests pass.

Remaining compatibility code includes startup shader compilation/reflection, sampler
setup, VAO/framebuffer token creation, capability queries, video texture allocation,
and rectangular-clear/other fallback paths. Workspace artifacts are
native-resources-benchmark.json, native-resources-profile.json and
native-resources-result.json.

## Native-only verification (2026-11-07)

Release engine built with `-O3 -DNDEBUG`. The 36 Node tests pass. Live Skadovsk
gameplay and the F10 ImGui editor run with zero lifetime GLES compatibility calls
and zero WebGPU validation errors. GPU readback checks verify partial color/depth
clears preserve surrounding pixels and native ImGui geometry, texture, projection
and clipping (48 pixels checked). Single-sample rendering is supported; MSAA
remains unsupported. The compatibility interpreter is retained only as a test
reference and is not staged. Earlier benchmark sections document migration history.

The final 30-second 720p Extreme Skadovsk sample measured **25.73 FPS**,
773 frames, zero legacy draws and zero GPU validation errors. The previous
optimized sample was 99.60 FPS. This is an observed regression, not a demonstrated
speedup: the machine reported 3% battery and discharging despite AC power, and
both engine simulation and JavaScript CPU time were substantially slower. Power
throttling was not confirmed. Reassess performance under normal power conditions;
no feature-disabled control was rerun. See `native-only-result.json` and
`native-only-benchmark.json` in the enclosing workspace.

### Charged rerun (2026-11-07)

With battery at 96%, charging on AC power, the unchanged Release build achieved
**104.56 FPS** over 30 seconds (3,137 frames) in the same 720p Extreme Skadovsk
checkpoint. Median frame time was 9.25 ms, p95 12.295 ms and p99 15.31 ms.
There was one game tab, profiling off, zero legacy draws, zero lifetime GLES
compatibility calls and zero validation errors. This is 4.98% above the saved
99.60 FPS baseline; normal run-to-run scene variation still applies. The earlier
25.73 FPS slowdown recovered without code changes after charging. Raw evidence:
`native-only-charged-benchmark.json` in the enclosing workspace.

