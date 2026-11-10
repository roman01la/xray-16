# Further original-renderer experiments — 2026-11-11

Areas: animation scheduling, static geometry organization, lighting work, terrain
materials and frame scheduling. Optimized Release, isolated headless Chrome,
1920×1080, retained perfbench checkpoint, extreme grass and uncapped/VSync-off
unless stated. Live weather and simulation remain nondeterministic. User Chrome,
local 8132 and public deployment are untouched. No native Windows frame capture
was obtained; native/browser timing parity remains unmeasured.

## Animation: retain cheaper bounds, preserve scheduling

`CKinematics::CalculateBones` already has same-time and slow-update guards;
`UpdateTracks` also guards its timestamp, while individual blends guard their
frame. Reducing update rates further would affect callbacks, attachments and
animation behavior. Do not skip them based only on visual distance.

The bounds update instead performed eight corner transforms and eight box
expansions for every visible bone. The retained browser path computes the exact
linear box extents `abs(basis) * halfSize`, then expands the box with its minimum
and maximum. Conservative outward floating-point padding prevents false culling
from rounding differences. This reduces matrix arithmetic and changes eight box
expansions to two without changing animation timing, callbacks or bone matrices.
It does not change physics hitboxes. The render bounds can be marginally larger.

The test compiles the production helper and checks containment of all eight
corners across 100,000 randomized transforms, including shear, nonuniform scale
and large coordinates. This is correctness evidence, not an in-game CPU timing
claim or a completed NPC visual comparison.

## Static geometry: do not add another batching system

The port still loads the game's mesh-container vertex/index buffers and fast
shadow geometry (`Fvisual::Load`, `FProgressive::Render`); sector/HOM traversal and
pass grouping remain active. An opt-in submission audit tested a necessary
condition for coalescing adjacent single-instance indexed draws: identical pass,
pipeline, material, uniforms, geometry buffers, viewport/scissor/depth/blend state
and contiguous index ranges/base vertex. It found **zero candidates among
264,750 sampled draws** after the terrain turning run. The probe is an upper
bound (it does not prove query/barrier safety), so zero is sufficient to reject
this particular simple coalescing idea in this workload.

No static mesh repacking or draw reordering retained. The probe's per-draw string
construction was profiling only and has been removed from production code.

## Lighting: retain exact-input setup reuse

`compute_xf_spot` normalizes the basis, evaluates adaptive shadow resolution and
builds view/projection matrices. Cache its actual inputs per light: transform,
range/cone/virtual size, RGB intensity, spatial sphere, camera position/direction,
shadow quality/size limits, light type and current size (hysteresis). When all
inputs match exactly, reuse the setup but reset atlas coordinates and translucent
state exactly as the original function does. Changes recalculate normally. Type
changes invalidate even if the light changes type and later changes back, because
the transform storage is a union. Shadow textures are still rendered normally;
this is not a whole-shadow-map cache or lower shadow resolution.

In one retained Skadovsk/night log interval, reused setups advanced 49,287 → 62,871
while rebuilt setups advanced 105,004 → 115,586: **56.2% of setup calls avoided**.
No matched before/after interior FPS comparison is claimed. Teleporting near an
NPC produced an obstructed/dark view, so that screenshot is not NPC visual
validation. Counters show the light-heavy path executed without GPU errors.

The compiled production-function probe covers unchanged calls, required atlas
resets, every float input, camera changes, size changes and light type round trips.
`-web_work_audit` exposes cumulative `WEB_SPOT_WORK` counts; off by default.

## Frame scheduling: tested and reverted two-frame gate

Original binary evidence from the earlier audit includes frame-query polling;
copying a synchronous wait into a browser worker would prevent callbacks from
making progress. Tested an asynchronous two-frame submission budget instead:
completion promises track queued presents, and the main loop yields while full.
No blocking GPU wait was used. Errors fail open. Loading presents can bypass the
normal frame gate, so the observed maximum pending count was three, not strictly
two throughout the run.

| Variant | Stationary FPS | Turning FPS | Stationary p99 ms | Turning p99 ms |
|---|---:|---:|---:|---:|
| Previous deployed six-area run | 157.26 | 119.35 | 75.41 | 15.94 |
| Bounds + light setup candidates | 157.10 | 116.95 | 61.55 | 15.88 |
| Two-frame queue experiment | 130.89 | 97.07 | 15.74 | 18.96 |

The bounded variant shortened completion delays and stationary tail frames, but
lost roughly 17% throughput and introduced many skipped main-loop callbacks.
**Reverted the frame gate and its runtime code.** Existing VSync/FPS options and
queue-audit diagnostics remain unchanged. No new default pacing policy is enabled.
A future experiment should wake on completion without periodic main-loop retries,
and measure real input-to-photon latency rather than infer it from completion
promises. Completion times include worker scheduling and are not pure GPU timings.

## Terrain materials

The existing terrain detail shader samples four diffuse and four normal layers,
weighted by a mask (`deffer_impl_flat.ps`). A standalone GPU prototype compares
that work to conditional omission of exact-zero-weight layers. Derivatives are
computed before branching and explicit gradients used, so diverging branches do
not select invalid mip gradients. Tests cover full blending, one active layer and
alternating per-pixel layers, checking equal output pixels.

This is a synthetic prototype, not a modification to packaged game shaders or
proof of the real mask distribution. Shader-cache identity and production shader
sources remain unchanged. Four alternating-order rounds of 100 draws at 1280×720 gave median batch times:

| Synthetic mask | Eight samples always | Skip zero layers |
|---|---:|---:|
| All four layers blended | 23.55 ms | 23.12 ms |
| One active layer | 22.70 ms | 7.28 ms |
| Alternating active layer per pixel | 22.40 ms | 10.18 ms |

All compared output pixels matched and GPU validation passed. This prototype uses
constant-color single-mip textures and a reduced weighted-blend shader; it does
not validate real terrain normal maps, mip selection, cache pressure or mask
coverage. Timings include command submission/completion, not isolated shader
instruction time. The first non-alternating run showed a warm-up/order artifact
and is superseded by these repeated measurements. Keep this as a promising
prototype; do not replace production terrain shaders from synthetic timing alone.

## Validation and artifacts

104 tests passed with experimental frame-queue coverage; all **103 retained tests**
pass after removing that experiment. Optimized build and terrain/interior game runs
reported zero GPU validation errors. The final build also includes type-change
cache invalidation, added after the live runs and covered by the compiled test.

Workspace artifacts: `mechanics-test/next-five-results` contains benchmark JSON,
screenshots, batch audit, terrain GPU fixture results and experimental-source
snapshots. The private stage retains the trial build.

The final optimized build completed successfully with only bounds and light-setup
changes retained. All private browser/server runs closed. Broad visual checks
remain in the manual test document; no native Windows performance claim is made.

Visual review (2026-11-11): captured matching 1920×1080 maximum-setting views
from the deployed baseline and final retained build. Outdoor vegetation and the
Skadovsk bar showed no obvious geometry, lighting or NPC-model regressions.
Wind and NPC poses differ between runs; these are spot checks, not exhaustive
animation or culling validation. Evidence: `mechanics-test/visual-review`.
