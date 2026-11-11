# Remaining grass cost after the 2026-11-11 optimizations

Research only; no production rendering changes. Builds on
`GRASS-REFRESH-CACHE-2026-11-11.md` and `GRASS-SHADOW-COMPACTION-2026-11-11.md`.
Same perfbench stress scene (density 0.1, radius 300, height 2 — the maximum
the video options allow; the default radius 49 covers about 1/37 of the slot
area, so these are worst-legal-case numbers).

## Current breakdown (stationary reference view)

Grass on 137.4 FPS (7.28 ms), grass off 213.9 FPS (4.68 ms): grass costs about
2.6 ms/frame. Detailed telemetry shows the stationary producer side is now
effectively free: detail preparation 0.0005 ms/frame, zero packed instances,
zero membership/content changes, zero record or range uploads, 100% of
scheduled slot refreshes skipped, zero scale/class churn. The remaining cost is
GPU rasterization plus draw submission; aggregate task-worker visibility scans
overlap rendering and no longer bound the frame.

Interleaved attribution (harness-only zeroing of compacted cascade draws in one
session, 12 s intervals, zero validation errors): zeroing the far cascade's
grass draws recovers roughly 0.8–1.2 ms/frame; zeroing all three cascades
roughly 1.1–1.5 ms. The far cascade is therefore 75–85% of the remaining
shadow cost even after compaction (it holds ~186K of ~216K surviving
instances). By subtraction the main view costs about 1.2–1.4 ms (418,657
instances / 3.34M submitted triangles; the earlier scissor test showed pixel
overdraw is minor at 1080p, so this is mostly vertex/submission work).
Screenshots with the far cascade zeroed are visually indistinguishable at the
reference view: far-cascade shadow-map texels (~8 cm or coarser) exceed grass
blade width, so distant grass self-shadowing is sub-texel noise.

## Ranked options

1. Limit grass sun shadows to the near+mid cascades (skip the far cascade),
   measured ceiling ~1 ms/frame here. One-line gate around `Details->Render`
   in `render_phase_sun.cpp` behind a console variable; stays vanilla when the
   variable allows all cascades. Validate under low sun with long shadows
   across open fields — the one case where the visual argument could weaken.
2. Geometric LOD for the "still" class: class-0 grass already draws in its own
   pass but reuses the full mesh with a cheaper shader; a decimated variant
   (crossed quads) would cut main-view vertex work. Prerequisite: add a
   per-class instance counter to size the ceiling before building decimation.
3. Reuse compaction outputs while the cascade matrix and a quantized wind
   envelope are unchanged (skip 3 compute passes/frame when idle). Small,
   unmeasured; pairs naturally with the existing exact-input philosophy.
4. Instance record compression (mixed fp16 rows): bandwidth-bound win
   uncertain; world-space translations need fp32. Low priority.
5. Producer CPU work beyond this point only matters for low-core devices;
   the frame is render-bound.

Evidence: sibling `mechanics-test/grass-remaining-cost-2026-11-11/`
(current-baseline telemetry with per-frame profile counters, attribution
telemetry, per-interval screenshots, capture script).
