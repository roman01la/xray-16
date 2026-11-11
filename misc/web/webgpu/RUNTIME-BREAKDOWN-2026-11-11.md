# Runtime breakdown, current single-player release

Measured release `c2390ff00d93267bd4b57b967b8d6333d8fbb91d927f83d2589114cee245771c`
(commit `04318a73`) on 2026-11-11. No production code/settings changes.

## Method

Private headless Chrome 157, Apple Metal GPU, optimized wasm64 engine, 1920×1080.
Reused the forest perfbench save, fixed camera direction, frozen game clock;
simulation and wind remained active. Extreme saved configuration, grass density
0.1, radius 300, height 2, 2048 shadow map. This is a dense-grass stress scene,
not the default medium preset or a representative average of the whole game.
VSync off, cap 501 to avoid masking workload. User's browser/profile untouched.

Sequence: all grass → no grass sun shadows → no grass → no grass repeat →
no grass sun shadows repeat → all grass repeat. Each condition settled for five
seconds, then captured detailed telemetry for 15 seconds and ordinary telemetry
for 10 seconds. First two one-second reports excluded. Values below are medians
within each interval. Original built-in `rs_detail` and `r2_sun_details` controls
were used; the latter leaves other sun-shadow casters enabled. Screenshots and
script phase logs verify the conditions. Zero WebGPU validation errors.

## Ordinary telemetry (detailed profiling disabled)

| Condition | Frame interval | FPS | CPU simulation | CPU rendering |
|---|---:|---:|---:|---:|
| All grass | 8.44 ms | 118 | 1.25 ms | 7.12 ms |
| Grass sun shadows off | 7.33 ms | 136 | 1.25 ms | 5.90 ms |
| Grass off | 4.69 ms | 213 | 0.86 ms | 3.70 ms |
| Grass off, repeat | 4.59 ms | 218 | 0.85 ms | 3.64 ms |
| Grass sun shadows off, repeat | 7.32 ms | 137 | 1.19 ms | 6.00 ms |
| All grass, repeat | 10.39 ms | 96 | 1.31 ms | 9.00 ms |

Disabling grass saves 3.8–5.8 ms versus the full-grass endpoints (roughly 45–56%
of their frame intervals). The full-grass repeat slowed substantially; the cause
was not isolated. Do not attribute that drift specifically to thermals or treat
the endpoints as a precise constant cost. The no-shadow and no-grass repeats
were considerably more stable. Grass without its sun shadows still adds about
2.7 ms relative to grass off. Removing shadows saves 1.1–3.1 ms relative to the
full-grass endpoints. These are whole-frame effects, not isolated shader costs.

CPU simulation is FrameMove plus camera update. CPU rendering includes task
dispatch, DoRender and submission/presentation; it is not GPU execution time.
The explicitly timed final parallel-task join is below 0.001 ms, but this does
not exclude waits inside rendering or browser scheduling/presentation costs.

## Detailed telemetry

| Counter | All grass, first/repeat | Shadows off, first/repeat | Grass off, first/repeat |
|---|---:|---:|---:|
| GPU timestamp span | 8.36 / 9.72 ms | 5.71 / 5.77 ms | 3.62 / 3.57 ms |
| Grass preparation | 1.51 / 1.53 ms | 1.18 / 1.33 ms | 0 / 0 ms |
| All native draw submission, inclusive | 3.14 / 3.74 ms | 2.90 / 3.00 ms | 2.76 / 2.75 ms |

Full-grass draw-submission subcategories: vertex layout 0.22–0.27 ms, pipeline
selection 0.38–0.45 ms, uniform copying 0.47–0.56 ms, resource setup 0.64–0.75 ms,
draw encoding 0.99–1.18 ms. These are subsets of submission, not additional costs.
Grass preparation includes instance/cache inspection and gather/upload work; it
does not encompass all worker visibility calculations. The very small native
detail submission timer (0.03 ms) measures enqueueing, not later queue consumption.

Detailed instrumentation increases frame intervals by roughly 0.4–1.9 ms here.
Use ordinary telemetry for FPS comparisons, detailed telemetry for attribution.
GPU timestamps span the first timed render pass through presentation; they can
include gaps between submissions and are not a sum of isolated GPU busy periods.
CPU and GPU overlap, so their durations must not be added into a frame budget.

## Chrome trace and sampled CPU profiles

Separate captures recorded Chrome timeline traces and 1 ms CPU samples for the
page and 19 workers, with grass on and off. Each trace lasted about 20 seconds;
CPU profiles include capture setup/readout (about 24.4 seconds). Symbolized using
the matching release's `xr_3da.js.symbols`. Instrumented FPS was approximately
99 with grass and 187 without. This is a separate, higher-overhead experiment.

Approximate sampled CPU work per frame, normalized by profile duration and median
reported FPS (not exact frame-correlated timers):

| Work | Grass on | Grass off |
|---|---:|---:|
| Grass visibility/update subtree, across workers | 2.47 ms | absent |
| Grass rendering/preparation subtree | 1.43 ms | absent |
| `writeBuffer` self samples, whole renderer | 1.10 ms | 0.10 ms |
| `encodeDraw` self samples | 0.50 ms | 0.33 ms |
| `setBindGroup` self samples | 0.36 ms | 0.15 ms |
| `consumeUniformBatch` self samples | 0.34 ms | 0.27 ms |

The grass update work is distributed over four task workers and overlaps the
rendering worker. Its 2.47 ms is aggregate CPU consumption, not an extra 2.47 ms
added serially to every frame. Inclusive subtree samples and self samples also
overlap; do not total the rows. Lua-bound call trees include native callees and
are not a clean measurement of interpreter/GC-only cost.

Chrome also records long RunTask slices on waiting/background threads; their
duration alone is not evidence of gameplay stalls. Idle/futex waits were excluded
from the useful-work interpretation.

## Conclusions and next measurements

Dense grass remains a major runtime cost in this scene. Both CPU preparation and
GPU/shadow work matter. CPU draw submission remains significant even without
grass. Highest-value follow-ups: inspect why grass visibility still scans so much
with a stationary camera; attribute grass-related buffer writes by buffer/bytes
and dirty range; add isolated GPU pass timings before deciding whether another
shadow/geometry change or CPU upload change is the best next optimization.

Evidence lives in `mechanics-test/runtime-breakdown-2026-11-11` beside the repo:
`analysis.json`, six paired raw telemetry captures and screenshots,
`cpu-analysis.json`, `scene0-trace.json` (grass), `scene1-trace.json` (grass off),
worker `.cpuprofile.json` files, and copies of the capture/analysis scripts.

## Follow-up: visibility calculations and upload attribution

Source inspection and a private instrumented copy of the same release were used
to separate writeBuffer callers. Production code and game settings remain unchanged.
Evidence: sibling `mechanics-test/grass-upload-investigation`, including raw
telemetry, `upload-analysis.json`, screenshots and the measurement wrapper.
Counters are cumulative deltas divided by actual rendered frame counts; initial
two telemetry reports excluded. The wrapper times synchronous writeBuffer calls,
not GPU transfer completion, and adds its own measurement overhead.

### Visibility

`DispatchMTCalc` runs `cache_Update` and `UpdateVisibleM` each frame. At radius 300,
the configured grid has 301×301 slots and 75×75 coarse visibility cells. Empty
and out-of-frustum coarse cells are rejected before slot-level work; this is not
a claim that all 90,601 slots or all instances are processed every frame.

For surviving slots, the current code performs frustum/HOM checks and rebuilds
the ordered visible lists each frame. Every 15–29 scheduled frames it clears and
rebuilds the slot's instance groups, recomputes distance fade, screen-size
classification and scale, even if those inputs have not changed. Revision checks
prevent reupload when values compare equal, but do not eliminate that CPU scan.
The high-level producer version similarly avoids some consumer work only after
the producer has already traversed the lists.

The maximum density setting is spacing 0.1, not a percentage. Decompression uses
`ceil(slot_size/density)` per axis, so density cost grows roughly quadratically
as spacing decreases, before terrain/palette rejection. Radius increases the
grid area roughly quadratically as well.

An exact per-slot cache of the inputs to fade/classification is a promising first
experiment: skip only that recomputation when position-dependent distance,
thresholds and slot contents are unchanged. Preserve scheduled refresh behavior
when inputs change, invalidate on slot recycling/settings/device reset, and
continue current frustum/HOM tests. A broader visibility cache needs explicit
frustum, occlusion, cache and settings invalidation; merely checking camera
position would be incorrect. This capture does not establish why the small
remaining dirty subset changes in the standing scene (e.g. exact camera drift).

### Uploads per frame

| Category | Calls | Bytes | Synchronous call time |
|---|---:|---:|---:|
| Dirty grass instance records | 243–269 | 113–125 KB | 0.12–0.15 ms |
| Grass gather ranges | 15–16 | 3.9–4.3 KB | 0.008–0.009 ms |
| Shared renderer uniform arena | 1 | 429–430 KB | 0.14–0.70 ms |
| Other renderer buffer writes | 62 | 132 KB | 0.07–0.22 ms |

Almost every grass-record write is at most 4 KB, and about half are at most
256 bytes; average size is approximately 465 bytes. The persistent record cache
is working: roughly 1,800–2,000 64-byte records are refreshed per frame, not all
418,657 submitted main-view instances. This is not a bulk-bandwidth bottleneck.
Coalescing small dirty ranges can reduce calls but has a small directly measured
CPU-time ceiling here. It must preserve untouched records and command ordering.

Without grass: no grass writes, one 369 KB uniform write (~0.11 ms) and the same
62 other writes (~0.07 ms). The prior CPU sampling result of ~1.1 ms in
writeBuffer is whole-renderer time, not proof that grass record writes cost that
much. The larger uniform-call fluctuation could involve scheduling or queue
pressure; its cause was not isolated, so do not claim a bandwidth or backpressure
diagnosis from these timings alone.

### Instancing and GPU geometry

The private draw counter confirms 31 main-view grass draws submitting 418,657
instances / 3,335,762 triangles. Three sun cascades add 93 draws / 1,255,971
instances / 10,007,286 triangles. Instancing already removes per-blade draw-call
overhead, but retains vertex processing, alpha testing and repeated shadow work.
These are submitted triangles, not final rasterized triangles or unique plants.

The previously retained GPU shadow-compaction experiment remains under
`experiments/` and is not wired into this release's normal rendering path.
Its documented ~83% shadow-geometry reduction is a separate experimental result,
not the behavior of this capture. Promoting it requires the outstanding shadow
correctness checks described in GRASS-SHADOW-PIXELS.md and GRAPHICS-MANUAL-TESTS.md.

Priority: measure an exact fade/classification cache first; then assess safe
small-write batching with realistic expected savings. Treat GPU shadow-compaction
validation as a separate potentially larger GPU-work reduction. None of these
follow-up optimizations was implemented or deployed by this investigation.
