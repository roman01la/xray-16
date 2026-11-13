# SoC outdoor profiling, 13 November 2026

## Conditions

Apple M2 Max, Chrome 157.0.8103.51, hardware Metal backend, release Wasm
`54969f1f91a5b842d78463d0f482d3697ce244161bae824a88e024a459b08e84`.
The harness checked a visible 1920×1080 canvas and effective configuration.
Each regular measurement used two 10-second windows, with detailed timers,
CPU sampling and GPU tracing collected afterward. The background browser was
closed before analysis or editing.

Maximum exposed SoC menu settings were applied explicitly. These included
visibility 1, geometry LOD 2, detail density 0.1, detail radius 300, detail height
2, texture LOD 0, anisotropy 16, sunlight and grass shadows enabled, and maximum
lighting/shadow-distance controls. The supersample setting was 8, although the
current renderer does not consume this legacy setting. VSync was disabled and
the cap set to 501 for measurement. The persisted preset name is insufficient
to verify every setting, so individual values were checked.

The menu does not expose the newer console-only HDAO, MSAA and Extreme sun
variants. Earlier runs forcing those additional features produced a different,
problematic rendering configuration and are excluded from these results.

The primary scene restores the Cordon actor to (-205, -19, -145), heading 0,
fixes game time and holds ArrowRight to turn the camera. A-Life and wind remain
active, so independent runs can differ. The private checkpoint and all raw
captures are in the sibling `performance-work` directory.

## Retained upload change

SoC still bypasses the persistent GPU slot cache and compute gather in
`glDetailManager_VS.cpp`, preserving the workaround for maximum-settings
stretched triangles. It uploads contiguous instance rows.

The frontend now preserves the allocation of a directly uploaded detail
buffer after its previous consuming encoder has been submitted. It compares
256-byte blocks against the CPU shadow and merges changed blocks into upload
ranges. More than 128 disjoint ranges use a full upload. Changed logical counts
can reuse existing capacity. Pending draw readers retain snapshot semantics.
GPU-written detail buffers also retain the original path because their CPU
shadow cannot establish unchanged GPU contents.

| Metric per frame | Original | Changed |
| --- | ---: | ---: |
| Buffer snapshots | 35.61 | 2.00 |
| New stream-buffer allocations | 0.845 | 0.001 |
| Uploaded bytes | 11.85 MB | 10.91 MB |
| Mean FPS across windows | 41.78 | 42.95 |
| FPS window range | 40.59–42.97 | 42.47–43.43 |
| Median frame time | 16.06 ms | 15.69 ms |
| p95 frame time | 65.45 ms | 66.68 ms |

Allocation and snapshot reductions are substantial. Uploads avoided in the
changed run equal 6.1% of requested bytes. The cross-run byte difference also
includes scene variation. FPS ranges overlap and the slow tail persists, so
these measurements do not establish a frame-rate or frame-pacing improvement.

A second view at the same valid actor position, heading π/2, exercised the final
code at 104.3 FPS with 5.07 MB uploaded per frame, 2 snapshots and no new stream
allocations. This is a different view and serves as validation, not a speedup
comparison. Screenshots showed intact geometry in both views, and every valid
capture reported zero WebGPU validation errors. Full gameplay and level-travel
regression testing remains outstanding.

An attempted additional position (-130, -12, -35) placed the actor beneath the
terrain. That capture, `soc-village-delta`, is excluded.

## Isolation results

These switches were used only in separate diagnostic scenarios. They are not
retained quality changes.

| Rotating-view configuration | FPS | Average frame interval | Uploads per frame |
| --- | ---: | ---: | ---: |
| Maximum menu settings, changed upload path | 42.95 | 23.28 ms | 10.91 MB |
| Grass shadows disabled | 70.67 | 14.15 ms | 11.34 MB |
| All detail grass disabled | 240.92 | 4.15 ms | 0.023 MB |

The result implicates both shadow rendering and the remaining grass path.
These differences are end-to-end costs, including interactions and scheduling.
They cannot be assigned directly to exclusive CPU or GPU time.

The rotating-view CPU trace attributes 4.59 seconds of 9.39 sampled seconds to
`writeBuffer`, 0.85 seconds to the native detail submission function, and 0.38
seconds to frontend `bufferData`. Browser backpressure can appear inside
`writeBuffer`; its samples do not establish that all this time executes CPU
instructions. The original trace had 5.28 of 9.44 sampled seconds in
`writeBuffer`. Different frame throughput prevents a direct total-time speedup
claim from those samples.

GPU frame spans and pass-query data were captured separately. On this Metal
backend, some empty passes leave unwritten timestamps, and other pass intervals
overlap extensively. The analyzer excludes invalid values and flags the
remaining intervals as diagnostic spans. Adding their durations would
misrepresent GPU execution time.

## Further work

1. Investigate how SoC can reduce contiguous instance rebuilds and transfers
   while preserving the cache-corruption workaround. Most bytes still change
   position when visible membership changes.
2. Investigate spot-light grass draws. A subsequent sunny-scene audit confirmed
   that the default SoC renderer already uses the shared CoP cascade filter.
   The original captures recorded zero filtered jobs because their weather
   disabled direct sunlight. See the follow-up below.
3. Validate any filtering with off-camera casters, wind, low sun, moving lights,
   maximum density and level travel. Keep original draws when required data is
   unavailable.
4. Investigate the remaining slow frame tail with matched routes and traces.
   Keep CPU samples, GPU spans, transfer volume and draw/instance work separate.

The source change and profiling tools are local and uncommitted. Production
has not been changed by this investigation.


## Sunny shadow-filter verification

The earlier inference that SoC's default sun rendering bypassed the shared
filter was incorrect. Fixed default weather at 14:00 exercises two shared sun
cascades. The original overcast checkpoint had zero direct sunlight. A new
legacy-path hookup was tried and removed after forcing that renderer exposed
an independent depth-texture binding failure. The working default renderer
remains selected.

The retained changes make the shared filter safe with SoC's contiguous direct
uploads. They protect pending compute reads from in-place replacement, release
filter resources when direct-upload buffers are deleted, reject mismatched
main/shadow draw descriptions and verify source-buffer bounds. The persistent
slot-cache bypass remains intact. The filter kernel and visible grass density
are preserved.

The final paired capture uses the same checkpoint, warm browser profile,
1920×1080 canvas, maximum exposed SoC settings, fixed 14:00 weather and heading
π/2. The comparison flag is `-no_grass_shadow_filter`. Each side has two
10-second untraced windows, followed by detailed timers, CPU profiles and a
Chrome GPU trace. Frame-rate limits and VSync were disabled for measurement.

| Metric | Filter disabled | Filter enabled |
| --- | ---: | ---: |
| FPS range | 62.07–62.61 | 96.18–96.58 |
| Mean FPS across windows | 62.34 | 96.38 |
| p95 frame time | 41.26 ms | 14.38 ms |
| CPU-side render wall time | 14.79 ms | 10.73 ms |
| GPU timestamp timeline span | 16.86 ms | 8.60 ms |

CPU and GPU timer values are means of four detailed sampling intervals after
the ordinary benchmark windows. CPU render wall time includes time spent in
browser calls and GPU backpressure. The GPU span includes submission gaps.
These values must be interpreted as elapsed pipeline measurements, and their
sum is not a CPU/GPU utilization budget. The filter adds compute dispatch/setup
work while substantially reducing shadow geometry.

An indirect-argument readback from the filtered fixed view measured 335,866
requested grass instances and 8,899,740 requested triangles across two sun
cascades. The GPU retained 11,321 instances and 225,728 triangles, a 96.6%
instance reduction and 97.5% triangle reduction. The normal camera draw keeps
its original instances. Local-light shadow maps continue using their existing
path.

The rotating sunny view measured 38.63–38.73 FPS with filtering disabled and
43.24–44.55 FPS with it enabled. The benefit depends on the camera view and
other rendering work. A-Life remains active, so these independent runs include
world-state variation.

Both valid final fixed-view runs completed with zero WebGPU validation errors.
The real-GPU fixture checked 900 instances across 10 cases including negative
scales, rotation, wind and translated light volumes. It matched the CPU
reference and preserved retained rows and indirect draw arguments. Reviewed
screenshots showed equivalent visible scene geometry with wind differences.
33 related unit tests passed. Full campaign travel is outside this capture.

Evidence is stored under sibling `performance-work` directories
`soc-shadow-final-still-on`, `soc-shadow-final-still-off`,
`soc-shadow-sunny-retry`, and `soc-shadow-sunny-off`. The combined figures are in
`soc-shadow-comparison.json`. One sunny attempt lost its Chrome connection and
is excluded. The forced legacy attempt failed texture validation and is also
excluded. All test browsers were closed before analysis.

The final private local publication is
`c78e7471b512933824179694fdfee9a6766cac94da6250d8b5b8396c99361229`.
These source changes and measurements have not been committed or deployed.


## Restored persistent storage

SoC now uses the same persistent grass-record cache and partial gather path as
CoP. The temporary direct-upload bypass has been removed. This restores the
separation between changed source records and ordered visible ranges.

The native bridge had truncated slot identities, record addresses and native
writeback addresses to 32 bits. These descriptors now use 64-bit words, while
JavaScript converts supported heap addresses exactly to Number. Visibility
signatures include both pointer words, and eviction protection reconstructs
complete wasm64 pointers. Tests cover colliding low words, high addresses and
forced eviction using a sparse heap. The captured game used a 2 GiB heap, so
this demonstrates a real address-width defect without establishing it as the
precise cause of the old reported bridge corruption.

At 1080p and maximum exposed SoC settings, the retained cache measured
approximately 46.7 KB of changed records and 303.4 KB of range metadata per
turning frame, plus 25.4 KB in the existing dynamic-stream counter. The earlier
direct path uploaded about 10.9 MB in that counter. In the fixed view, changed
record uploads reached zero, with 123.6–140.8 KB of range metadata and about
17.4 KB in other dynamic streams per frame. These figures exclude uniform
buffer traffic and GPU-internal gather copies.

FPS is not established as an improvement. The original fixed-view pair was
96.4 FPS for direct uploads and 92.4 FPS for persistent storage, with p95 frame
time increasing from 14.4 to 28.3 ms. A fresh direct control later varied from
65.5 to 77.1 FPS, followed by a persistent run at 92.7–93.4 FPS. Turning runs
measured 43.9 FPS for direct uploads and 41.9 FPS for persistent storage, with
p95 increasing from 65.7 to 97.5 ms. The reproducible reduction is in upload
volume and native packing work. Visibility metadata and GPU gathers remain
optimization targets, particularly for the slow frame tail.

An experiment packing eight slots into each GPU workgroup passed the GPU
fixture but did not improve the measured frame-time tail and was discarded.
The original CoP gather kernel is retained.

Validation included 35 related unit/compiled-helper tests and the real-GPU
storage fixture, which checked 371,168 float values across seven readbacks.
An explicit `-web_detail_audit` mode periodically copies gathered GPU output
back and compares it byte-for-byte with native packed records. It is disabled
in ordinary performance captures. The regression route checked 2,264 outputs
and 549,304,448 bytes with no mismatches, including density 0.5→0.1 resets,
the Cordon bridge area and travel to Garbage and back. No WebGPU validation
errors were reported. Runtime eviction counters remained zero in this route;
forced-eviction coverage comes from the focused storage tests.

The private captures are `soc-cache-turning`, `soc-cache-still`,
`soc-cache-control-still`, `soc-cache-final-still`, `soc-cache-audit3` and
`soc-cache-regression4` in the sibling `performance-work` directory. Earlier
regression attempts used conflicting or incorrect key bindings and were
excluded. All test browsers were closed after capture.

The private staged release is
`e464b67db7d30f6774a156085a578e8e3dde3f7c730319efb01d71b1b3f04b1f`.
The changes are local and have not been committed or deployed.


## Camera-motion stalls and range coalescing (2026-11-13)

The repeat capture used the existing persistent-cache release, the same Cordon
checkpoint, 1920×1080 and maximum exposed settings. In its ten-second traced
interval, queue.writeBuffer stalled for up to 192.69 ms. The GPU process spent
8.47 seconds inside IOSurfaceImageBacking::WaitForCommandsToBeScheduled::Dawn;
the rendering worker spent 5.69 seconds inside WaitForToken. These nested waits
identify browser/GPU queue backpressure, but do not establish exclusive GPU
execution cost. An earlier run had a 508 ms write stall and substantially lower
throughput, illustrating the variation between runs.

SoC now bounds outstanding frame submissions to two completion promises. When
full, its engine main loop pauses and resumes from the oldest completion. It
continues processing worker events while waiting. Completion rejection retires
the entry and resumes the loop. This operates before the next simulation/render
frame. Completion includes browser scheduling as well as GPU work. Loading and
reset paths can submit within one engine callback, so the bound applies between
ordinary frames. The CoP/CS loops do not activate this policy. Earlier CoP tests
had shown a throughput cost for a polling gate; this version resumes from a
promise and was measured in SoC.

Adjacent grass source ranges with adjacent destinations on the same storage page
now coalesce before upload. One compute workgroup expands each merged range,
reducing metadata and dispatch work. Ordered output, all transforms, grass
settings and visual coverage are preserved. Sparse updates retain their gaps.

| Cordon turning, uncapped | Baseline repeat | Two-frame limit | Limit plus coalescing |
| --- | ---: | ---: | ---: |
| Mean FPS | 40.38 | 41.44 | 44.69 |
| Window FPS range | 40.33–40.42 | 40.94–41.94 | 43.89–45.49 |
| Median frame interval | 10.45 ms | 19.64 ms | 16.46 ms |
| p95 frame interval | 95.16 ms | 53.92 ms | 52.81 ms |
| p99 frame interval | 125.52 ms | 66.88 ms | 66.01 ms |
| Largest traced writeBuffer call | 192.69 ms | 0.44 ms | 0.51 ms |
| Grass range bytes/frame | 308,835 | 311,388 | 229,644 |

The final capped 60 FPS/VSync case averaged 35.83 FPS versus 38.62 FPS for the
capped baseline, with p99 68.25 ms versus 111.79 ms. The stationary limit-only
case averaged 88.73 FPS versus the earlier 93.02 FPS cache capture. These costs
are retained for smoother scheduling; this is not a general throughput gain.
Game simulation remains live, and source record updates and draw counts vary
between captures. Coalescing reduces range metadata by about 24–26% in the
observed runs. The direct causal guarantee is that adjacent compatible ranges
use fewer descriptors and workgroups. No image-quality setting was reduced.
Long frame intervals around 50–70 ms remain even after large synchronous buffer
write stalls disappear. The remaining work includes GPU workload/scheduling and
frame pacing; the captures do not establish that all gameplay stalls are fixed.

Reviewed CoP commits 0331ab35, 1c17b143, 7bedfc49, d03f589f, 63c13a5a and
17a9b3b8. Preparation reuse, partial gathers, shared compute passes, exact
visibility epochs, unchanged fade/classification reuse, cached materials,
zero-weight terrain-layer skipping and cascade grass filtering already reach SoC
through the shared code. The previous SoC upload bypass had been the major
exception and was removed in the preceding work. The range-coalescing change
also uses the shared cache code.

31 targeted tests passed, including randomized exact range expansion comparisons,
page-boundary and sparse-gap cases, queue completion and rejected completion.
The optimized release build passed a live GPU-data audit with 2,432 sampled
comparisons / 641,145,536 bytes and zero mismatches. That route exercised the
Cordon bridge, sparse/max density resets, Garbage and the return to Cordon.
No GPU validation errors or crashes occurred. Runtime evictions remained zero.
All owned test browsers closed after their captures.

Private captures are `soc-motion-probe-repeat`, `soc-frame-gate-turning`,
`soc-frame-gate-still`, `soc-frame-gate-capped`, `soc-motion-baseline-capped`,
`soc-motion-final-turning`, `soc-motion-final-capped` and
`soc-motion-final-regression`. Profiling and GPU readback audits run outside the
ordinary benchmark windows. The optional `--queue-probe` measures queue API call
latency only during the traced interval, and does not ship in the game.

Final local release is
`e7aa62c7c22c32f7ac1a2e2a5d5ef50d0295ea815a849240cc73c7b55fdcf462` in
`performance-work/soc-motion-final-publication`. Changes remain uncommitted and
undeployed.


## Rendering CPU follow-up (2026-11-13)

Retained changes reduce repeated work in draw submission and grass preparation.
Draw replay uses scalar state-stream positions instead of allocating two arrays
and a callback per draw. Each geometry/layout caches its most recent prepared
pipeline record with exact state, target-compatibility and draw-kind guards.
Programs retain their uniform reservation size, and unchanged extra-uniform
bindings retain their descriptor objects.

The grass visibility worker now tracks an exact ordered pointer/count membership
epoch separately from content revisions. The rendering thread consumes that
epoch instead of comparing a second per-slot identity/allocation/count signature.
It still scans visible sources for stale uploads, including evicted sources.
Source reallocation with unchanged membership patches the affected output ranges
at their existing destinations. Membership/order/count changes and storage resets
still rebuild the full output. Native pointer comparison remains full-width.
This supersedes the per-slot allocation signatures described earlier in this file.

Initial separate captures drifted across nearly all timing categories and were
not used to claim a speedup. A private comparison build then alternated old/new
encodeDraw methods in one session, retaining the same draw replay in both. Pipeline
lookup time averaged roughly 0.656 ms with the old method and 0.620 ms with the
candidate, while total rendering time was effectively unchanged. Private alternate
methods are absent from repository source and the final build.

With the membership change, the latest separate turning capture measured:

| Mean of detailed samples | Previous retained build | CPU follow-up |
| --- | ---: | ---: |
| CPU rendering | 11.779 ms | 11.547 ms |
| Direct draw submission | 4.809 ms | 4.603 ms |
| Pipeline lookup/setup | 0.635 ms | 0.563 ms |
| Grass preparation | 2.155 ms | 1.988 ms |
| CPU simulation | 1.859 ms | 1.840 ms |

The untraced run measured 45.28–46.17 FPS versus the previous 43.89–45.49 FPS.
These small timing differences remain subject to live-scene and machine variation.
The retained work reductions are the eliminated signature comparison pass,
per-draw temporary objects and repeated cache/reservation lookups. This does not
establish a large rendering speedup. CPU rendering remains around 11–12 ms in
these detailed samples.

32 targeted checks passed, including randomized ordered membership/content/count
changes, full-width native identities, source eviction, partial output updates,
state replay and queue completion. The optimized build completed. A live GPU
readback audit compared 2,400 outputs / 645,860,672 bytes without mismatches through
the bridge, sparse/max density resets and Cordon–Garbage–Cordon travel. No crashes
or validation errors occurred. Runtime eviction counters stayed zero on this route;
forced eviction remains unit-test coverage. Inspected screenshots retained dense
grass without stretched geometry. Owned Chrome test processes were closed.

Private evidence directories are `soc-cpu-render-turning`, `soc-cpu-comparison`,
`soc-cpu-membership-turning` and `soc-cpu-membership-regression`. Final local release
is `348d3f16dbe1b115599266b22cd381b800a717d0da6673aaa6c7c78d2047fb53` in
`performance-work/soc-cpu-membership-publication`. The source changes are included in the performance commit accompanying this
report. The final build remains local and undeployed.
