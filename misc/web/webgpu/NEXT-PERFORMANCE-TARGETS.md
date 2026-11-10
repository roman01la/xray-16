# Next performance targets — 2026-11-10

Investigation only; no new rendering experiment enabled. Evidence: latest
boundary-batch-results-20261110 capture, current source, and historical
TERRAIN-PERFORMANCE-2026-11-09 measurements. Historical detailed timing scopes
are not a new profile of the current build.

Latest stationary/turning counters per frame: 482/908 draws, 36/50 render
passes, 1.045/1.390 million grass instances summed across passes, 63/63 buffer
uploads, 67/127 KB changed grass records, 0/774 KB compact range uploads.
CPU render averages: 5.05/8.12 ms. Instance totals are not unique visible plants.

1. Incremental GPU gather. glDetailManager_VS calls GatherWebGPUDetailRanges
   for any dirty content even when membership is unchanged; gatherRanges then
   expands every slot in the batch. Keep the current contiguous vertex input,
   patch only dirty destination spans when membership is unchanged, and retain
   full expansion for membership changes. Track allocation changes, count
   changes, eviction and source generations. This avoids the previously failed
   vertex-storage-fetch design. Measure copied bytes and GPU gather duration.
2. Native preparation reuse. hw_Render_dump scans every visible list for dirty
   records, then updateSignature scans it again and rewrites the signature even
   when unchanged. First combine these traversals; then investigate exact
   visibility generations at the producer so unchanged lists can bypass them.
   Reuse between passes only when visibility and storage generations match.
   Historical preparation cost was roughly 2 ms stationary / 3.8 ms turning;
   that is the entire scope, not an achievable saving estimate.
3. Grass shadow workload. The sun-near pass renders Details with the shadow
   transform. Audit which grass can actually contribute to that shadow map,
   and filter conservatively against its caster volume. Camera visibility
   alone is not safe: offscreen grass can cast visible shadows. Add pass-level
   GPU timestamps first to distinguish shadow geometry from color overdraw.
   Do not repeat the reverted global Hi-Z/compaction experiment blindly.
4. Gather scheduling and allocation. Each gather creates a compute pass,
   parameter buffer and bind group, interrupting rendering. Pool parameter
   storage and cache bindings by allocation generation. Investigate preparing
   dependency-independent gathers together before their first consuming draw.
   Never move writes across readers of the same output or source allocation.
5. Alpha-tested vegetation pixel cost. Measure depth/fragment-heavy passes
   separately before considering an alpha-tested depth prepass. It doubles
   geometry work and texture sampling in the prepass and can regress; no
   recommendation to enable it without a measured win.

Recommended order: incremental gather, native preparation reuse, then shadow
pass attribution. Start with diagnostic counters/timestamps, change one path,
compare to retained baseline, keep only demonstrated wins. Use the same saved
scene, production optimization, 1080p and extreme grass; include camera turning.
Validate unchanged geometry/order and mutation/growth/eviction handling with
hardware pixel tests. Test shadow coverage separately before shipping any caster
filter. No FPS gain is established by this investigation.

## Implementation trial — reverted

Implemented native dirty offsets for partial GPU copies and fused the dirty
scan with exact signature checks. Both versions passed 38 tests and the
1,300-pixel hardware fixture with 22 shader variants. The initial JS destination
map version measured 157 FPS stationary / 69 turning. Removing that map and
sending destination offsets from C++ measured 158.4 / 93.1 FPS, CPU render
5.05 / 9.35 ms. Retained baseline: 158.5 / 102.8 FPS, 5.05 / 8.12 ms.
Neither established a gain. Both optimizations were reverted together; their
individual contributions are not isolated by these measurements. Local port
8132 and production were not updated. Experimental sources and measurements
are retained in mechanics-test/incremental-grass-native-offset-results.
The next investigation should attribute GPU time by render pass before making
shadow or overdraw changes; do not treat the recommendations above as proven wins.

## Pass attribution investigation

A private baseline build sampled render/compute passes every 16 frames, recording
pipeline labels, draws, instances and GPU timestamps. Captures contain 68
stationary and 39 turning samples. Timestamp results include negative durations
and implausible cumulative intervals; they are invalid for quantitative ranking.
Do not sum or publish them as GPU costs. Instrumentation remains private.

Draw records remain useful: stationary samples contain roughly 261k grass
instances in each of several repeated passes, matching the roughly 1.045M
aggregate instances/frame. render_phase_sun.cpp calls Details->Render inside
its cascade loop with the cascade transform. This supports investigating
cascade-specific grass caster bounds next. It does not establish how many
instances can safely be removed or how much time that saves.

Before implementing a quality-preserving shadow filter, measure the upper bound
with a diagnostic shadow-detail toggle and inspect cascade visibility. Include
wind displacement in conservative bounds and offscreen shadow casters; retain
the stock path when bounds are uncertain. No shadow quality change was shipped.
Evidence is in mechanics-test/pass-profile-results-20261110. Local port 8132
and production remain unchanged.

## Grass-shadow cost ceiling

With only r2_sun_details disabled in the private profile, the retained release
measured 222.3 FPS stationary / 135.7 turning, versus 158.5 / 102.8 with shadows.
CPU render measured 3.33 / 6.21 ms versus 5.05 / 8.12 ms. Grass submissions
fell from 1.045M to 261k instances/frame stationary and from roughly 1.390M to
349k turning, consistent with three additional shadow submissions. Zero WebGPU
validation errors. This is a deliberate quality reduction for diagnosis only;
it is not an optimization to ship. Baseline is the retained previous run,
not a fresh paired measurement. Weather/simulation remain live.

Conservative cascade filtering is not implemented or validated yet. Implementation
must cache bounds per slot (including authored scale and wind), filter against
light-space caster volume rather than camera frustum, and preserve the main
visible list. Use separate per-cascade instance outputs/signatures to avoid
regathering one shared buffer four times. Reusing existing slot bounds requires
verifying their wind/height coverage. Preserve uploaded-revision invalidation
across all consumers: one cascade updating a shared source must also invalidate
other cached outputs that reference it. That cross-output dependency is important
when adding filtered lists. Verify near/middle/far transitions with sun motion,
wind, camera turns and offscreen casters before enabling by default.

No local/public build or user settings changed. Artifacts are in
mechanics-test/shadow-cost-results-20261110.

## Conservative cascade filter trial — reverted

Implemented slot spheres including wind pivots, expanded by the stock maximum
wind displacement; rejection used each shadow projection's six-plane frustum.
Kept separate per-cascade outputs and tracked source revisions across consumers.
Color rendering retained its original list. Optimized Release compiled, 37
renderer tests passed and the live capture reported zero WebGPU validation errors.
This does not constitute complete visual validation across weather/maps.

At the same checkpoint, submissions fell to 468k instances/frame stationary
and 550k turning, versus 1.045M / 1.390M. However throughput regressed to
130.1 / 72.6 FPS, CPU render 6.27 / 12.35 ms, versus 158.5 / 102.8 FPS and
5.05 / 8.12 ms. Filtering plus separate preparation of cascade outputs outweighed
the saved geometry work. The trial was reverted; local port 8132 and production
were not changed. Experimental sources/screenshots/results are retained in
mechanics-test/shadow-filter-results-20261110.

Further cascade work must avoid rebuilding separate compacted instance buffers
on camera changes. Merely adding more accurate culling is not enough. Consider
stable spatial batches with reusable instance storage only after measuring the
added draw-command cost; previous generic GPU compaction also regressed.


## Original-renderer-inspired buffer/material changes — retained (2026-11-10)

Compared the original DX11 append/discard stream policy with our WebGPU path.
Implemented appendable vertex/index GPU buffers, uploading only unwritten aligned
ranges; overlapping writes and wrap retain old GPU-buffer versions for queued
draws. Separately implemented texture-unit-dependent material invalidation while
retaining global invalidation for resource mutations/deletion and sampler changes.

Optimized Release, 1920×1080, same perfbench save, grass density 0.1, height 2,
radius 300, grass shadows enabled, VSync off and FPS limit 501. Separate headless
Chrome profile, one benchmark game at a time. Twenty seconds stationary then
twenty seconds holding camera-turn-right per variant; simulation/weather remain
live, so small differences are not statistically established improvements.
Detailed CPU instrumentation disabled during throughput measurements. All runs
reported zero WebGPU validation errors. The first attempted baseline failed
before gameplay because staged JS and engine ABI differed; rebuilding matching
Release artifacts fixed it, and that failed attempt is excluded.

| Variant | Stationary FPS | Turning FPS | Stationary median / p95 ms | Turning median / p95 ms |
| --- | ---: | ---: | --- | --- |
| Baseline | 158.40 | 100.54 | 5.055 / 11.030 | 9.455 / 14.960 |
| Material invalidation only | 157.47 | 100.35 | 5.065 / 11.275 | 9.555 / 14.785 |
| Material + dynamic stream reuse | 158.22 | 98.72 | 4.965 / 10.655 | 9.665 / 15.100 |

Stationary buffer snapshots fell from 62 to 2/frame. Uploaded dynamic bytes fell
from 34,732 to 33,748/frame (only 2.8%); material binding rebuilds fell from about
112 to 99/frame. Baseline already reused pooled buffers (zero new stream buffer
allocations during stationary measurement). The synthetic 32×64-byte append
probe improved from 33,792 to 2,048 uploaded bytes and 33 to 1 allocation, but
this amplification was not representative of the measured game workload.

The candidates passed 36 focused renderer tests, including overlap/wrap,
alignment, and binding invalidation. These tests and the gameplay captures are
not full all-scenes visual validation. Both candidates were initially reverted for lack of a demonstrated FPS gain,
then restored at the user’s request to retain the measured reduction in redundant
work. The byte/rebuild counters remain. This is a work-reduction improvement,
not a demonstrated frame-rate improvement. Local port 8132 and production
were not updated. Source patch, test fixture, screenshots, harness, and JSON
results are retained in mechanics-test/stream-material-results outside the repo.

Conclusion: these two inefficiencies are measurable but not high-gain targets in
this terrain scene. Do not extrapolate synthetic upload amplification into an FPS
prediction. Revisit only if another workload shows material dynamic upload cost.


## Original-renderer follow-up investigations

See [the four-path investigation](ORIGINAL-RENDERER-FOLLOWUP.md). The original
cascade route also draws grass per cascade. Its fixed 47.5-unit fade and 0.2
minimum spacing are much less demanding than our extreme 299.5 / 0.1 / scale-2
workload. A private browser comparison measured 423.8/315.7 FPS with original-like
grass versus 157.0/99.6 at extreme settings; this is a quality/workload difference,
not an implementation speedup. No settings were changed outside the test profile.

Both quality-preserving candidates are now implemented and retained. See
[the grass reuse experiment](GRASS-PREPARATION-REUSE.md): turning throughput rose
from 99.6 to 120.7 FPS, stationary average stayed around 158 FPS, and warmed gather
buffer/bind-group creation dropped to zero. Stationary p99 was worse, so this
is not a general stall fix.

## Further original-renderer audit

[All five follow-up paths](ORIGINAL-RENDERER-FIVE-PATHS.md) are investigated.
Concrete next candidates are folding standalone clears into attachment loadOps,
retaining asynchronous light/caster queries until ready, and reusing packed bone
palettes. Existing portal/HOM culling, pose guards and invisible-caster caching
are present. No whole-shadow-map-cache parity claim or new FPS gain is established.
Queue-depth/task-wait instrumentation is needed to diagnose remaining tail stalls.

## Six-area follow-up experiments

See [the six-area report](ORIGINAL-RENDERER-SIX-AREAS.md). Retained cheaper opaque
pass comparisons, saturated LOD evaluation, correctly sized particle reservations
and texture-quality mip selection. Terrain throughput remains roughly neutral.
The existing 60 FPS cap reduced observed queue-completion delays substantially in
a private test; those delays include worker scheduling and are not GPU timestamps.
Unused shader output pruning remains experimental pending actual pipeline benefit.

## Animation, geometry, lighting, terrain and pacing follow-up

[Further experiments](ORIGINAL-RENDERER-SCHEDULING.md) retain cheaper conservative
bone bounds and exact-input spotlight setup reuse. No adjacent geometry merge
opportunities appeared in the sampled draws. The two-frame submission gate was
reverted for throughput regression. Conditional terrain-layer sampling is
promising in a standalone GPU fixture but still requires real game mask/full-
shader validation; it is not enabled in production.
