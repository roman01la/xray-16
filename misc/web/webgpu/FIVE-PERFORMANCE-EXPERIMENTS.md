# Five performance experiments — 2026-11-11

Optimized Release, private headless Chrome, existing forest perfbench save,
1920×1080, density 0.1 / radius 300 / height 2. The clock is frozen, but simulation
and wind remain active. Existing partial uploads and fused preparation remain.
The separate GPU shadow-compaction experiment is retained but **not enabled** in
these runs. User Chrome, normal local website and public deployment are untouched.
No new baseline control was run. Previous reference throughput was 109–114 FPS;
separate-run differences are not a statistically established speedup.

## 1. Batch grass GPU preparation — retained

Prepare all three grass classes/materials before their first draw. Detail range
expansions now share an open compute pass until a consuming draw, copy, flush,
resource mutation or other pass requires it to end. Existing source/output
allocation protections and ordering remain; rendering keeps its original order.

Reference: 17.01 gathers/frame use 0.84 compute passes/frame, rather than one pass
per gather. Some frames have no dirty output. Reference/turned/repeated-reference
throughput: **118.46 / 118.13 / 117.96 FPS**. Main/shadow geometry is unchanged.
The compute-pass reduction is directly counted; the throughput comparison against
older runs is provisional. The extra preparation traversal is over object batches,
not a second scan of every visible slot.

## 2. Exact producer-side visibility reuse — retained

While UpdateVisibleM already visits slots, retain the ordered pointer/content
revision sequence and advance a per-object/class epoch only when it changes.
Unchanged gathered output bypasses the render-thread upload/signature scan.
Visible-slot LRU marks still update in the producer; pointer reuse, revisions,
order, removals and empty lists invalidate exactly. Storage resets invalidate
prepared output, and unload clears producer state. No probabilistic hash.

On top of batching, reference/turned/repeat: **118.79 / 118.13 / 118.38 FPS**.
This is essentially neutral throughput; retained because unchanged output avoids
redundant preparation. Producer comparisons remain necessary, so it is not a claim
that all visibility work disappeared. Compiled helper tests exercise unchanged
lists, content changes, reordering, shrinking, empties and repopulation.

## 3. Terrain zero-weight layer sampling — retained

The stock four-layer terrain shader samples four diffuse and four normal layers.
The linker transform skips a layer only when its normalized weight is exactly
zero. Derivatives are evaluated outside branches and explicit gradients preserve
mip selection, including bias where the recognized variant uses it. All remaining
normal/gloss/material/output arithmetic stays intact. Unknown layouts fail open
without partial mutation. The transformed pipeline key has a version suffix.

The **complete stock fragment shader**, not the earlier reduced blend fixture,
was tested with single-layer, fully blended and alternating masks plus spatially
varying, mipmapped textures. All **6,144 float output values matched exactly**.
This does not establish every material/driver combination; bias variants and
other GPUs remain manual coverage targets.

Ten packaged variants match the supported transform. The game capture exercised
one transformed variant at **198 terrain draws/frame**. Reference/turned/repeat:
**118.33 / 118.07 / 118.22 FPS**, effectively neutral. Exact zero weights avoid
sampling by construction, but actual fragment invocation/texture-sample savings
were not measured in this scene. No claim of a quantified real-world sampling
reduction. Reference screenshots show no obvious gross visual change; moving
foliage prevents pixel-identical whole-scene comparison.

## 4. Non-grass sun shadows — diagnostic experiment only

Added an opt-in `-web_shadow_audit` cascade marker, flushing queued draw records
at marker boundaries. The private diagnostic uses this explicit marker rather
than guessing from render-target dimensions. Normal production does not enable it.

The reference view submits about **455 non-skinned draws / 98,986 triangles** and
**9 skinned draws / 15,178 triangles** to sun shadows, versus 93 grass draws /
10,007,286 grass triangles. Class labels follow shader bone uniforms; they are
not a semantic census of NPCs versus trees.

Privately skipping only non-grass sun-shadow backend draws gave **118.90 FPS**,
versus **118.22** before and **116.69** after restoration. That is small compared
with run variability. The diagnostic removes backend submission/GPU work while
X-Ray still builds/traverses its shadow graphs; it does not bound savings from
eliminating graph construction. It also does not cover light-heavy interiors.

No shadow omission or whole-map cache retained. Existing caster visibility and
spotlight setup caches remain. A reusable shadow map needs invalidation for sun/
camera coverage, geometry and caster changes, animated vegetation, actors, alpha
textures, terrain material/LOD changes and atlas ownership. These measurements do
not justify introducing that complexity or unsafe static-scene reuse here.

## 5. Frame-time spikes and queueing — measured, defaults unchanged

Low-overhead present-interval samples captured camera-change spikes of **112–132
ms** despite average throughput near 118 FPS. GPU queue completion is measured by
asynchronous promises: it includes worker scheduling and submission backlog,
not pure GPU busy time, exact frames in flight or input-to-photon latency.

The existing 100 FPS cap was tested privately, then restored before profiling:

| Condition | Actual FPS | p99 present interval | Maximum interval | Mean queue completion |
| --- | ---: | ---: | ---: | ---: |
| Uncapped, restored reference | 116.69 | 31.71 ms | 61.35 ms | 206.76 ms |
| Cap 100 | 88.85 | 17.28 ms | 26.12 ms | 15.73 ms |

Pacing materially reduces backlog and tail intervals in this view, but delivers
less throughput. No new cap or frame gate is enabled. The earlier two-frame gate
was not reintroduced. Cap behavior on other GPUs/scene loads remains unmeasured.

A separate 30-second continuous-turn CPU capture sampled 16 workers at 1 ms.
Throughput under profiling was about 114 FPS. Aggregate self samples include:

- Grass visibility task: 5.70 s.
- JavaScript gatherRanges: 5.41 s.
- Native grass preparation/submission: 3.87 s.
- writeBuffer: 1.79 s.
- Lua sweeplist / propagatemark: 0.63 / 0.45 s.

These are sampled CPU times across workers, not additive frame-critical costs.
Idle/futex wait dominates spare workers and is not evidence that the main frame
is blocked for that aggregate duration. CPU sampling can attribute browser/native
boundary waits to the calling JS function, so gatherRanges self time is not a
pure arithmetic cost. Profiles include 3.78 s of inclusive Lua work, including
native callbacks; that is not all GC.

**The profiled interval did not reproduce the >100 ms spikes** (maximum present
interval 21.4 ms). Therefore no exact cause or stall fix is claimed. Profiling/
pacing changes the workload. The next diagnostic should retain low-overhead
per-frame task-wait, membership-change and upload markers around a reproduced
spike, rather than treat this sampled average as proof of its cause.

## Validation, artifacts and remaining checks

108 retained renderer tests pass. Real GPU gather readbacks match 371,168 floats
across seven growth/window/partial-update cases. Full terrain output fixture
passes. All game intervals report zero WebGPU validation errors. Final optimized
Release rebuild succeeds; no commit/push/deployment was requested or performed.

Evidence: `mechanics-test/five-work-{batch,producer,terrain}-results`, including
raw telemetry, screenshots, analysis, harnesses and logs. Terrain results also
contain worker CPU profiles and the matching symbol map. Detailed instrumentation
and destructive shadow toggles are private-stage-only.

Pending manual coverage: walking across slot boundaries, detail-quality changes,
reset/travel/unload, split-scene rendering, terrain transitions/mips/LOD bias,
NPC-heavy areas and Windows/NVIDIA. The three retained changes are in source and
release artifacts; the normal local serving directory has not been republished.
The GPU shadow-compaction experiment remains separate pending its own lifecycle
and shadow-boundary validation. Keep claims for these experiments separate.
