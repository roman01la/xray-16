# Six additional renderer experiments — 2026-11-10

Scope: draw ordering, object LOD, shader workload, particles/decals, texture
residency and frame pacing. Preserve earlier five-path candidates. Retain safe
work reductions even without an established FPS improvement; do not trade visual
quality for an unlabelled speedup.

## Evidence and limitations

Installed original `game-data/cop/bin/xrRender_R4.dll` (same hash recorded in the
previous audits), current DX11/OpenXRay source and optimized browser build.
No native Windows runtime capture is available; these experiments do not claim
native/browser timing parity. New original-binary anchors and a texture-policy
assembly excerpt are in workspace `mechanics-test/six-area-results/`.
The `reduce_lod_texture_list` reference at 0x1000425f identifies the original
texture policy routine at 0x10004250; comparisons against 1/3 for listed textures
and 2/4 otherwise are visible through 0x10004305. There is also a hardware-dependent
branch at maximum quality for listed textures; do not claim exact parity for that
branch. Current DX11 `texture_load` actually skips selected mips. Browser loading
previously used the quality setting only for estimated memory reporting.

## Retained candidates

### Draw ordering

The opaque graph already groups by pass and sorts by screen-space area (SSA).
Replace the browser pass comparator's deep pass equality check plus `>=` with a
strict `>` SSA comparison. Distinct equal-SSA entries previously compared true in
both directions, violating the sorting contract. No changes to transparent,
HUD-sorted, decal or distortion ordering. This reduces comparator work and fixes
tied-key behavior; it is not a new global front-to-back rendering strategy.
Compiled production comparator test covers equal/self keys and descending order.

### Object LOD

Short-circuit fully saturated LOD values before division and square root, using
the existing thresholds. Keep the original expression for intermediate values
and unusual/reversed thresholds. Test compiles the production function and
compares results for 110,000 sample inputs; square roots fall from 110,000 to
8,999 in that synthetic distribution. This is not the actual game's LOD histogram.
No thresholds, geometry quality, draw distance or actual selected LODs changed.

### Particles / decals

Particle rendering requested `p_cnt * 16` vertices but generates and unlocks only
`p_cnt * 4`. Reserve four vertices per sprite. The production vertex stream probe
with 100 draws of 1,024 sprites and 65,536-vertex capacity discards/wraps 8 times
before versus 6 after; reservation size is 75% smaller. Uploaded bytes were already
limited by Unlock, so **do not claim a 75% reduction in uploaded particle data**.
Particle simulation, sprite geometry, alpha ordering and update frequency are
unchanged. No separate decal batching change: the transparent ordering must be
preserved, and no measured decal bottleneck justifies changing it.

### Texture residency

Honor `texture_lod` for ordinary 2D textures by allocating/uploading the selected
base mip and its descendants. Rebase upload mip indices and report exact uploaded
payload bytes rather than a heuristic based on whole-file size. Cubes, arrays and
volumes retain their full chains. BC-compressed textures keep a larger mip if
necessary for block-aligned base dimensions (avoids padding that changes UVs).
Single-mip textures cannot be reduced. Maximum quality (`texture_lod 0`) is
unchanged. Lower quality now actually lowers texture detail as that setting
requests; this is a setting-correctness fix, not a quality-preserving speedup at
identical texture detail. Disk/download assets are unchanged.

Production upload-block tests cover mip index rebasing, exact memory accounting,
BC alignment, cubes, single-mip and uncompressed textures. A 1024² BC1 full chain
loses 524,288 upload bytes by skipping its first mip, approximately 75% of its
payload. This is a texture-level probe, not a whole-game memory saving estimate.

## Experimental, not enabled as rendering changes

### Shader workload

The shared runtime/offline shaderc compiler already uses performance optimization.
A 40-program corpus experiment changed unused vertex outputs into private globals,
letting the existing optimizer eliminate them. All 40 variants compile; only two
change, removing two outputs and 514 WGSL characters in total. Source length is
not an instruction count or GPU-time measurement. The WebGPU pipeline compiler
may already remove unused inter-stage outputs. Do not ship a new shader-cache
version/rebuild based on this evidence alone. Prototype and per-program results
are preserved for a future pipeline-level comparison; production compiler and
shader cache identity remain unchanged.

### Frame pacing

Added opt-in `queue-audit` diagnostics with at most one outstanding
`onSubmittedWorkDone` promise. It records submissions, observed backlog and
completion delay without blocking the worker or changing frame pacing. Promise
completion includes worker scheduling delay; backlog is a conservative upper
bound because completion is sampled, **not exact GPU frames in flight**. Device
loss/rejected completion is counted. Disabled by default. A test verifies bounded
promise allocation, completion accounting and error recovery. No new frame cap,
wait or GPU pacing algorithm is enabled; earlier task-sleep regression remains
reverted.

## Validation / manual follow-up

Optimized WASM build succeeds. Renderer suite and new compiled C++ probes pass.
The live harness uses a private headless Chrome profile, 1920×1080, extreme grass,
VSync disabled and retained perfbench save. One instance at a time; user Chrome,
local 8132 server and production deployment are untouched. Its staging produced
the developer launcher rather than the public overlay: the harness was unblocked
with a dummy start button and full-window canvas CSS. Record this limitation when
comparing to earlier public-overlay runs, together with the additional warm-up.

Manual checks still needed: smoke/fire bursts, opaque geometry at LOD transitions,
texture-quality reloads (UI atlases, terrain, NPCs, sky/cubemaps), transparency and
level changes. Automated correctness probes and zero GPU validation errors are
not a substitute for these visual checks.

## Combined terrain benchmark

Previous retained five-path result: 158.93 FPS stationary / 118.35 turning.
Current candidates: **157.26 / 119.35 FPS**; no demonstrated throughput gain.
Stationary median/p95/p99: 4.09 / 10.95 / 75.41 ms. Turning: 8.24 / 12.36 /
15.94 ms. Zero GPU validation errors. These results support retaining the reduced
work, not a claim of eliminating stalls. Source/tests and raw JSON are retained;
no commit, push or deployment was requested.

After the benchmark, 20 seconds of opt-in queue observation recorded 3,393
submissions, 50 completion samples, mean 376.57 ms and maximum 669.17 ms to
completion notification; maximum observed backlog 195 submissions. This is a
significant pacing investigation lead, **not 195 proven GPU frames in flight**:
sampling and worker callback delays both inflate that count. No queue wait was
added to the renderer.

### Lower texture-quality live check

The same retained save launched at `texture_lod 2` with no engine errors or GPU
validation errors. Reported loaded texture payload fell from **752,568 KiB to
250,475 KiB** (about 735 to 245 MiB; 66.7% less). These counters exclude render
targets, driver allocations and other GPU buffers. This run intentionally lowers
texture detail; it is not evidence of equal-quality FPS improvement. No user's
settings changed. Screenshot and logs: `texture-lod2.png/json`.

All 100 tests in the full renderer-suite run passed; the subsequently added
particle-stream test also passed (101 total). Focused tests compile actual C++
implementation excerpts with fake resource APIs so failures exercise the real
sorting/LOD/upload/stream logic rather than a duplicate implementation.

### Existing 60 FPS cap comparison

A separate headless run with original maximum texture quality and only
`rs_fps_limit 60` changed delivered approximately 56 FPS. In 20 seconds of queue
observation: 1,080 submissions, 573 completion samples, mean **18.17 ms**, maximum
**38.96 ms**, maximum observed backlog **5** submissions; zero GPU validation
errors. Compare uncapped observation above (376.57 ms mean / 669.17 ms max / 195
maximum backlog). This supports avoiding unbounded submission when low latency
matters. It is not an input-to-photon measurement or a matched GPU-time test: the
capped run was stationary, the uncapped observation followed the turning test,
and the developer canvas CSS differed. The existing cap substantially reduced
observed completion delays in this exercise; no default setting or new throttle
was introduced. User-selected VSync/FPS controls remain in charge.

All private Chrome/server runs finished and closed. Final build includes the
retained sorting/LOD/particle/texture changes; production and local 8132 were not
replaced. The shader-output prototype remains an experiment; queue observation
is opt-in and does no work while disabled apart from its optional hook check.
