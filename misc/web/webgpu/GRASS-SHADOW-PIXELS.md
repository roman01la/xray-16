# Grass shadow and pixel-work investigation — 2026-11-11

## Method

Private headless Chrome, optimized engine with retained partial-gather and fused
preparation changes, perfbench forest view, 1920×1080, density 0.1, radius 300,
height 2, normal shadow quality. Game clock frozen; simulation/wind remain active.
No builds or test suites ran concurrently with this capture. Six 20-second
intervals with 5-second transitions; first two telemetry samples excluded.

A private backend wrapper counts detail draws, submitted instances and triangles
by shader/attachment class. Native r2_sun_details disables grass shadows only;
all other shadow casters stay enabled. With grass shadows disabled, a private
scissor override restricts only the two-target main-view detail draws to the
central 25% or 6.25% of the screen. All original grass geometry is still submitted.
This is a destructive diagnostic image change, not a proposed quality setting.
Screenshots confirm the restricted grass region. The last interval restores
normal full-area grass and shadows. No production renderer/settings changes.

## Results

| Condition | Frame time | FPS | Whole-frame GPU timestamp median |
| --- | ---: | ---: | ---: |
| Normal | 8.78 ms | 113.9 | 8.75 ms |
| Grass shadows off | 7.58 ms | 131.9 | 5.21 ms |
| Shadows off, 25% raster area | 7.56 ms | 132.3 | 4.88 ms |
| Shadows off, 6.25% raster area | 7.45 ms | 134.3 | 4.76 ms |
| Grass shadows off, repeat | 7.68 ms | 130.3 | 5.19 ms |
| Normal, repeat | 9.16 ms | 109.1 | 9.13 ms |

Mean normal frame time is 8.97 ms versus 7.63 ms with grass shadows disabled:
about 1.34 ms/frame or 15% of frame time in this view. This combines CPU command
submission and GPU shadow rendering effects; it is not a pure GPU execution timer.

Reducing main-view grass raster coverage by 93.75% saves only about 0.18 ms versus
the mean no-shadow reference. The GPU timestamp span changes by about 0.44 ms.
Those are whole-frame spans, not isolated grass shader busy times. Scissoring also
changes the G-buffer and downstream scene, and does not measure an exact overdraw
factor or fragment-invocation count. The result supports deprioritizing main-view
pixel overdraw in this view; it does not prove overdraw is absent or cheap in every
scene, resolution or GPU. Remaining CPU work can hide GPU improvements.

## Geometry audit

| Pass class | Draws/frame | Instances/frame | Submitted triangles/frame |
| --- | ---: | ---: | ---: |
| Main view, 1920×1080, two color targets | 31 | 418,657 | 3,335,762 |
| Shadows, 2048×2048 | 93 | 1,255,971 | 10,007,286 |
| Total | 124 | 1,674,628 | 13,343,048 |

The shadow counters are exactly three copies of the main detail set. Source review
confirms render_phase_sun.cpp loops over shadow cascades and calls Details::Render
with each light transform. CDetailManager::hw_Render_dump uses the same m_visibles
lists derived by UpdateVisibleM from the camera, with no cascade-specific slot
filter. Geometry outside a cascade is still submitted and rejected later by GPU
clipping. Counts are submitted work, not visible plants or rasterized triangles.

The captured detail fragment shaders perform one biased texture sample, discard
alpha below approximately 0.7843, and pack normals/material/color into the G-buffer.
The same shader identities appear in shadow and main passes. A depth-only alpha
variant is worth checking later, but unused work may already be eliminated by the
driver, and these measurements do not establish a benefit from that change.

## Recommendation

Prioritize conservative per-cascade grass-slot filtering before shadow submission.
Use each shadow caster volume and bounds that include maximum scale, grass height,
and wind displacement; retain any intersecting/uncertain slot. Do not simply use
camera distance or omit far/offscreen casters. Maintain independent main/shadow
membership caches so rendering one pass cannot overwrite another pass's output.
Validate low sun, cascade boundaries, slopes, movement, wind and spotlights; compare
shadow images and draw counts before enabling it. CPU culling cost must be measured
against the GPU work saved. The CPU-side prototype below tested this recommendation; it is not enabled in the retained build.

An alpha-tested depth prepass remains lower priority: it adds geometry and texture
sampling, while the main-view coverage test shows a small frame-time benefit.

All intervals reported zero GPU validation errors. Private browser/server closed.
Artifacts: mechanics-test/grass-pixels-results contains raw telemetry, WGSL,
screenshots and analysis.json; private stage is grass-pixels-stage. Diagnostic
wrapper and harness are saved with the evidence, not added to production code.


## Cascade-filter experiment

Implemented conservative per-slot filtering against each sun cascade's four XY
clip planes (unbounded along the light direction). Bounds include full generated
geometry, instance anchors for fade-to-zero scaling, and outward-rounded maximum
configured/current wind displacement. Main-view geometry is unchanged. Each
cascade has its own output buffer and content revisions, so shared source uploads
cannot leave a later pass stale. Spotlights retain their existing path.

The initial prototype submitted 1.74 million shadow triangles instead of 10.01
million, but reached only 78.7 FPS / 12.70 ms in the reference view. A second version
cached slot classification by light matrix/wind bounds and filtered memberships by
source membership, bounds generation and volume epoch. Its results:

| Condition | Frame time | FPS | Whole-frame GPU timestamp median |
| --- | ---: | ---: | ---: |
| Reference | 10.00 ms | 100.0 | 6.92 ms |
| Turned view | 8.72 ms | 114.7 | 6.87 ms |
| Reference repeat | 10.03 ms | 99.7 | 6.88 ms |

Both reference intervals submit 96 grass draws total: the unchanged 31 main draws
and 65 shadow draws. Shadow work is 230,709 instances / 1,789,832 triangles,
**82.1% fewer submitted shadow triangles** than the earlier 10,007,286 reference.
The slightly more conservative cached wind envelope explains the difference from
the first prototype. Source uploads stay about 140 KB/frame, but expanded output
records increase from about 2,187 to 3,257/frame and range descriptors from 301 to
476/frame because the passes now have independent outputs.

Despite less GPU geometry, mean reference frame time is 10.01 ms versus the earlier
8.97 ms (about 12% slower). These are separate runs, not an interleaved control;
the repeated reference intervals agree. GPU timestamp spans decline, but are not
pure GPU busy-time measurements. The result supports extra preparation/output
maintenance as a bottleneck rather than a useful overall frame-time improvement.
No builds/tests ran during the cached run. Only the initial reference capture of
the first prototype is clean timing evidence; its later intervals overlapped a
build and are excluded from performance conclusions.

All cached intervals reported zero GPU validation errors. The optimized build and
105 renderer tests passed, including 100,000 randomized wind/fade bound samples,
filter epoch invalidation and independent output revision checks. Reference
screenshots were inspected with no obvious gross scene disappearance. Wind is
not frozen, so these are not pixel-identical comparisons or complete visual proof.
Low sun, moving cascade edges, slopes and gameplay movement remain unvalidated.

**Decision:** keep the earlier partial GPU updates, fused preparation scan and
reusable upload staging. The CPU prototype and its staged builds were deleted at the user’s request: reducing GPU work does not justify the observed
CPU/frame-time regression. No rollout or deployment was performed.
Raw captures/screenshots are in mechanics-test/grass-cascade-cached-results;
first-prototype evidence is in grass-cascade-results.

Next candidate: GPU-side per-cascade slot filtering/compaction with indirect
instance counts, using the existing source records and conservative bounds.
It should avoid CPU filtered-list scans and repeated output bookkeeping. Measure
compute/gather overhead and CPU savings before enabling it; retain low-sun and
boundary correctness checks. The follow-up GPU experiment is recorded below.


## GPU-side filtering experiment

The expensive CPU prototype and both of its staged builds have been deleted.
The existing shared-record uploads and preparation changes remain intact.

The replacement proof of concept is
[experiments/grass-gpu-filter.js](experiments/grass-gpu-filter.js). It observes the
main pass's prepared instance buffers, extracts immutable mesh bounds once, and
runs **one compute pass per shadow cascade** across all grass material batches.
Each GPU workgroup tests 64 transformed instance bounds against the four light XY
planes, compacts survivors, and updates an indirect instance count. One global
atomic reservation per workgroup avoids one global atomic per retained instance.
Normal shadow draws consume the compacted rows with drawIndexedIndirect. The
camera grass list and stock vertex/fragment shading are unchanged. There is no
CPU per-instance/per-slot visibility traversal or synchronous count readback in
the rendering path. Diagnostic count readback happens only when requested after
each capture interval.

Bounds use the actual packed mesh height fraction and current wind amplitude,
with outward padding; light depth is deliberately unbounded. Original rows are
copied exactly, including lighting. Instance order can change, which is suitable
for these depth-tested, alpha-tested shadow draws. Per-cascade output/argument
buffers prevent later cascades overwriting earlier draw inputs.

### Measurements

Same optimized retained engine, private headless Chrome, 1920×1080, maximum grass,
frozen game clock and the existing forest save. No builds or test suites ran
during performance captures. The previous baseline was reused, not rerun.

| Condition | Frame time | FPS | Whole-frame GPU timestamp median |
| --- | ---: | ---: | ---: |
| GPU filtering, reference | 8.38 ms | 119.3 | 7.27 ms |
| GPU filtering, turned view | 7.91 ms | 126.4 | 7.71 ms |
| GPU filtering, reference repeat | 8.87 ms | 112.8 | 7.88 ms |

Mean reference frame time is 8.62 ms versus the earlier 8.97 ms: approximately
0.35 ms / 4% lower, but the separate-run ranges overlap. Treat throughput as a
modest, provisional improvement rather than a guaranteed FPS gain. GPU timestamp
spans include dependencies/idle time and are not isolated shader busy time.

The reference indirect-argument readback reports approximately 1.672 million
shadow triangles and 215,426 shadow instances, versus the earlier 10.007 million
triangles and 1,255,971 instances: **about 83% less submitted shadow geometry**.
Main-view submission remains 418,657 instances / 3,335,762 triangles. There are
still 93 indirect shadow draw commands; some have zero surviving instances.
The old wrapper counts requested instance counts before compaction, so use
`indirect-counts.json` for actual shadow counts, not its `grassProbe` counters.
Only the first completed reference readback is used; later telemetry snapshots
repeat that value without a request-completion identifier, so their freshness
is unverified and they are not used as turned/repeated-view count measurements.

### Validation and status

The real WebGPU fixture in
[experiments/grass-gpu-filter.browser-test.mjs](experiments/grass-gpu-filter.browser-test.mjs)
compares GPU output with CPU bounds tests for 900 instances across ten cases:
partial workgroups, rotations, negative scales, wind expansion and translated
light volumes. It verifies every retained row and untouched indirect draw fields.
All cases passed. All three game intervals reported zero WebGPU validation errors.
Reference and turned screenshots were captured; no gross scene disappearance was
observed. Wind is active, so these are not pixel-identical image comparisons.

An initial run had a diagnostic listener error on the non-renderer thread when
requesting counters. The helper was guarded and the entire capture repeated.
Use only `mechanics-test/grass-gpu-results` for the results above; the initial
helper-error run is excluded. Raw samples, indirect counts, screenshots, harness,
analysis and log are saved with the clean evidence.

**Retained as an isolated experiment, not enabled in the normal local build or
production.** It uses instrumentation wrappers to exercise indirect submission.
Before normal integration: use explicit sun-cascade metadata rather than attachment
classification, integrate indirect draws without wrappers, bound/clean up caches
on unload/reset/travel, handle resource revision changes, and test split-scene
rendering, low sun, camera movement, cascade boundaries, slopes and spotlights.
The current fallback leaves unsupported buffer sizes/draws on the original path.
No commit or deployment was performed.
