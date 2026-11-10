# Original renderer comparison: four follow-up investigations

2026-11-10. Research and private profiling only. Earlier retained dynamic-buffer
and material-cache changes remain intact. No settings changed on local port 8132
or production; no new rendering optimization enabled by this investigation.

## Method and limits

Static analysis of installed game-data/cop/bin/xrRender_R4.dll, SHA256
fab787bca9e7a847ab96009c9882eddf2b0c4964e4328cb5d041e196d8c83df3.
Addresses below use preferred image base 0x10000000 (subtract for RVA).
No independent pristine-binary hash validation. Disassembly describes this
installed DX11 renderer; it does not measure native Windows runtime performance.

Browser measurements: optimized Release with the retained buffer/material changes,
headless Chrome on Apple Metal, 1920×1080, same perfbench save, VSync off, FPS limit
501. One isolated game instance. Each run collected a separate 12-second phase
profile, followed by 20-second stationary and 20-second camera-turn benchmarks
with detailed profiling disabled. Simulation/weather are live; camera-turn paths
are time-driven and not frame-identical. All runs had zero WebGPU validation
errors. Comparison of settings below deliberately changes visual workload.

Evidence is retained outside the repository in
mechanics-test/original-grass-disassembly (assembly excerpts, annotations, scripts)
and mechanics-test/original-parity-results (JSON, config, screenshots, harness).

## 1. Original grass-shadow coverage

Confirmed cascade route, not a near-shadow-only optimization:

- Original main renderer chooses between cascade and legacy sun routes near
  0x1001fe12–0x1001fe2e. Cascade route calls 0x1000da10; legacy route calls
  0x1000b5b0 followed by 0x10008700. The inspected image initializes the route
  flag word at 0x100f4c58 without bit 0x200; runtime configuration can alter it.
- 0x1000da10 iterates a vector of 0x58-byte cascade records and calls
  0x1000db20 for each at 0x1000dab2, looping at 0x1000dad9.
- Cascade function calls DetailManager::Render at 0x100102c7, gated by
  r2_sun_details bit 8. Console registration at 0x10002b85–0x10002b96 independently
  identifies that bit. There is no cascade-index==0 condition at this call.
- Legacy near-sun route has the other shadow detail call at 0x1000d7cc.
  It is an alternative route, not proof that the cascade route draws only near grass.
- Initialization 0x1000d940 resizes the vector to three entries through
  0x10012fb0 (count-three checks at 0x10012fd2 and 0x10013008). It assigns cascade
  sizes 9, 40, 160 at 0x1000d981, 0x1000d9ae, 0x1000d9dd. Current
  src/Layers/xrRender_R2/render_phase_sun.cpp initializes 20, 40, 160.

Current source similarly draws grass inside the three-cascade loop. Original
camera-visible grass lists feed its submission path; no independently filtered
per-cascade grass list was identified. The two remaining direct Render call
sites, 0x1001fc89/0x1001fd68, are alternative main-render branches, not two
additional shadow cascades.

Decision: no evidence supports removing two grass shadow draws as an original-game
parity fix. Changing the near cascade from 20 to 9 changes shadow distribution
and quality; it is not a demonstrated performance optimization. Earlier measured
shadow-off speedups show shadow cost, not permission to remove shadows.

## 2. Visibility and preparation reuse across passes

Original Render wrapper 0x1002ae90 compares its stored frame at object+0xab36c
with imported Device+0x18 at 0x1002aec4, then calls calculation only if needed.
Calculation 0x1002b0e0 enters xrCriticalSection, repeats frame checks, calls
visibility routine 0x1002a740 at 0x1002b2c2, then stores Device's frame at
0x1002b2d0. Import names confirm Device and xrCriticalSection::Enter.

Current DetailManager.cpp already computes visibility through DispatchMTCalc and
waits for the task before rendering. It also preserves staggered per-slot scale/
LOD refreshes. Original visibility code at 0x1002a9c6–0x1002a9f8 schedules a
15–29-frame offset; current source uses Random.randI(15,30). Recomputing all
visibility every shadow pass is NOT the browser problem.

Original submission repacks instance constant rows per draw batch. The browser
already improves on this with persistent records and reusable compacted outputs.
However, glDetailManager_VS.cpp traverses visible slots to find dirty records and
then updateSignature traverses them again on every Render pass, even when the
same completed batch is consumed repeatedly in the same frame.

Extreme stationary phase profile: mean detail-preparation scope 2.360 ms/frame,
engine render 5.088 ms/frame; about 77.6 reused and 10.3 changed batches/frame,
with zero membership changes during the profile. This scope includes packing,
upload/gather calls and their queued-work drains, not only slot scanning.
It is an upper bound on relevant work, NOT an achievable saving estimate.

Candidate: prepare each model/wind-variant batch once per visibility frame,
retaining its completed output buffer and instance count for subsequent passes.
Continue binding each pass's shaders, transforms, wind and lighting constants.
Invalidate on manager/buffer reset, visibility generation, and any event which
changes the completed output. Reusing completed outputs is safer than reusing
raw source indices: source pages can be evicted/reallocated after gathering
without invalidating an already produced independent output buffer. Never skip
next-frame allocation/revision checks; handle manager reloads and future
pass-specific visibility explicitly. Mark slots visible for eviction policy on
first preparation. Review thread ownership before sharing prepared records.

This is different from the reverted fused-scan trial: it avoids repeated work
across passes rather than merely combining two scans within every pass.

## 3. WebGPU compute-resource reuse

Current detail-storage.js gatherRanges creates a 16-byte mapped parameter buffer
and a fresh bind group for every dispatch window. It ends the current render pass
and creates a compute pass; command ordering is needed because later renders
consume the gathered output. Existing persistent source/output buffers do not
eliminate these transient parameters or bind groups.

Measured with lightweight counters in the private stage:

| Settings / camera | Gather dispatch windows per frame | New parameter buffers | New bind groups |
| --- | ---: | ---: | ---: |
| Extreme / stationary | 10.49 | 10.49 | 10.49 |
| Extreme / turning | 23.05 | 23.05 | 23.05 |
| Original-like / stationary | 3.56 | 3.56 | 3.56 |
| Original-like / turning | 8.54 | 8.54 | 8.54 |

Candidate: allocate parameter slices from a submission-safe uniform arena and
cache bind groups for stable page/input/output buffers and bound ranges. Use
dynamic offsets for per-dispatch parameters; invalidate groups on page growth,
input/output replacement, range-size changes and release. Bound cache growth.
Never overwrite parameter slices referenced by an unsubmitted command buffer.
Reuse the renderer's arena only after verifying its overflow/submission behavior.

Do not reorder gathers merely to combine compute passes: writes may depend on
prior reads, and source/output allocations can change between batches. Pooling
and caching can be evaluated independently of scheduling or shader changes.
This path has confirmed allocation churn, but no FPS gain has been measured.

## 4. LOD, density, distance and scale parity

Important finding: our extreme grass controls are substantially beyond the
original renderer's registered controls and fixed distance.

| Property | Inspected original R4 | Current extreme test |
| --- | --- | --- |
| Density spacing | registered 0.2–0.6; image default 0.3 | 0.1 |
| Fade limit | fixed 47.5 world units | 299.5 world units (radius control 300) |
| Extra plant scale multiplier | absent in inspected scale path | 2 |
| Near/middle/far cascade sizes | initialized 9 / 40 / 160 | 20 / 40 / 160 |

Evidence: density registration 0x10001ee6–0x10001f11 pushes maximum 0.6,
minimum 0.2 and storage pointer 0x100f4be8 into imported CCC_Float; storage
initial value is 0.3. Decompression reads it at 0x1002c86f and divides slot
size 2 by spacing at 0x1002c890. Visibility rejects squared distance >2256.25
(47.5 squared) at 0x1002a979. Fade reciprocal at 0x1002a99f corresponds to
1/(2256.25-1). No radius/height console strings were found in R4.
Original scale sequence 0x1002ce76–0x1002ceec samples between authored min×0.5
and max×0.9 and stores directly; current Decompress.cpp adds the height multiplier.

The basic grass SSA cutoff matches: original derives 12.25/screen at
0x10005ced–0x10005cf5, equivalent to current 3.5 squared/screen. Both use
16 times that cutoff to switch to cheap/still grass. Original has 12×12 coarse
cache cells; current radius 300 expands to 75×75. Current placement visits
(ceil(2/spacing)+1)^2 grid candidates: 121 at spacing 0.2 versus 441 at 0.1.
These are theoretical candidate/cache sizes, not visible-instance predictions.
Full all-object LOD/occlusion parity has not been proven by these grass findings.

### Browser workload comparison

Changed ONLY grass spacing/radius/height to 0.2 / 49 / 1 in the private profile.
This approximates the original's densest allowed grass, fixed fade distance and
unmultiplied scale; it is not a stock-native benchmark or complete original-renderer
visual parity. Kept browser cascade sizes and all other settings unchanged.

| Browser settings | Stationary FPS | Turning FPS | Grass submissions/frame stationary | Turning |
| --- | ---: | ---: | ---: | ---: |
| Extreme 0.1 / 300 / 2 | 157.04 | 99.63 | 1,045,080 | 1,383,681 |
| Original-like 0.2 / 49 / 1 | 423.81 | 315.72 | 11,064 | 14,869 |

Submission counts sum all passes, not unique plants. Original-like preparation
scope averaged 0.118 ms versus 2.360 ms; engine render 1.654 versus 5.088 ms in
the separate phase-profile windows. The quality/workload change is substantial;
this must not be presented as an implementation speedup at unchanged settings.
No defaults or user settings were changed.

## Follow-up status

Items 1 and 2 below were subsequently implemented and measured; see
[grass preparation and gather reuse](GRASS-PREPARATION-REUSE.md). Earlier findings
above describe the pre-experiment implementation.

## Experiment roadmap

1. Same-frame reuse of completed grass preparation, with explicit generation and
   lifetime rules. Measure skipped slot visits and preparation time; retain draw
   counts and rendered output. Test turns, resets, allocation pressure and reloads.
2. Pool gather parameters and cache stable bind groups. Measure allocations and
   CPU time separately from any frame-rate effect. Validate queue ordering and
   resource replacement on actual GPU hardware.
3. Offer/document a stock-like grass reference preset only if desired. Keep the
   extended high-density/long-distance controls available. Do not silently reduce
   quality and label it an optimization.
4. Treat near-cascade size parity as a separate visual/shadow study. No evidence
   currently supports changing shadow-pass count as a missing original optimization.
