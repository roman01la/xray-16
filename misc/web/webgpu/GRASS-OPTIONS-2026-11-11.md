# Grass reduction options: cascade limit, still LOD, compaction reuse

Follow-up to `GRASS-REMAINING-COST-2026-11-11.md`, which ranked four options.
Measured in the perfbench stress scene (density 0.1, radius 300, height 2).
Because that scene thermally drifts over a session, only adjacent interleaved
A/B intervals within one session are compared; cross-interval absolute FPS is
not. Evidence: sibling `mechanics-test/grass-options-2026-11-11/`.

## 1. Sun-detail cascade limit — ADOPTED (web default)

New console variable `r2_sun_details_cascades` (1..3) gates
`Details->Render` per cascade in `render_phase_sun.cpp`. The web build defaults
to 2 (near+mid); the desktop default stays 3 (vanilla). Runtime-adjustable.

Interleaved reference-view pairs (near+mid vs all three): 147 vs 125 and
136 vs 121 FPS — about 0.8-1.0 ms/frame. At low sun (19:00) the gain held
(155 vs 130). Screenshots show no structural shadow loss: near-field grass
shadows are intact; only a subtle mid/far brightness change where the far
cascade's ~8 cm+ shadow texels were already coarser than a grass blade. Zero
WebGPU validation errors. This is the best gain-to-complexity ratio of the set.

## 2. Still-class geometric LOD — REJECTED

Measured the "still" class first: it is 55.5% of main-view instances
(232,260 of ~418k; new per-class WEB_GRASS counters). A prototype appended a
decimated half-area index range per mesh and drew the still pass from it,
gated by `r__detail_still_lod`.

Rejected on both axes. Visuals: dropping half of each billboard's triangles
left obvious holes and detached floating quads in near grass (the "still"
class is not only distant grass — small/steep nearby blades also land in it at
this distance scaling), so it is not a safe silent quality change. Performance:
interleaved on/off pairs showed no reliable FPS gain (e.g. 57 vs 72, 78 vs 78,
80 vs 77 — noise-dominated and often negative). The frame is not bound by
still-class vertex throughput here. Reverted; the per-class counter is kept as
cheap diagnostics.

## 3. Shadow compaction-output reuse — REJECTED

Prototype skipped the per-cascade compute pass when a signature (light matrix,
per-batch draw range, source-buffer identity, a gather content epoch and an
upward-quantized wind envelope) was unchanged. Interleaved on/off pairs showed
no FPS benefit (110 vs 108, 106 vs 97 — within noise/negative), and the reuse
counter stayed ~1.8/frame in both states, so the A/B toggle could not be shown
to take effect. With no demonstrable gain and an added per-frame signature cost
plus a correctness surface (every compaction input must be in the signature),
it failed the "demonstrably reduces work" bar. Reverted.

## 4. fp16 instance records — NOT PURSUED (closed by evidence)

Option 3 effectively bounded this: reuse skips the entire compaction step,
including all its argument/parameter uploads, yet moved FPS by ~0. The shadow
path is therefore not upload/bandwidth bound in this scene, so halving record
bandwidth cannot help. Not worth the record-ABI change, three WGSL kernels and
a shader-cache namespace bump.

## Net result of this round

One shipping change: grass sun shadows default to the near+mid cascades on web
(~1 ms/frame), console-overridable. The remaining ~1.2-1.4 ms of grass cost is
main-view vertex/submission work with no cheap, visually-safe reduction found.
