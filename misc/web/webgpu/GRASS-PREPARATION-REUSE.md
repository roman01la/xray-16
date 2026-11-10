# Grass preparation and gather reuse experiment

Measured 2026-11-10 in an optimized Release browser build, private headless
Chrome profile at 1920×1080. Extreme grass: spacing 0.1, radius 300, scale 2,
grass shadows enabled; VSync off and FPS cap 501. No public deployment or
replacement of the localhost:8132 release was performed for this experiment.

## Changes retained

1. Reuse completed per-batch grass output within a frame. Cache validity includes
   frame, visibility generation and storage generation. Later passes retain their
   own shader, wind, transforms and lighting. Source-page indices are not treated
   as permanent: preparation is revisited on the next frame or invalidation.
2. Put gather parameters in the existing uniform arena and retain bind groups
   while resource identities/ranges remain valid. Dynamic offsets select immutable
   parameter slices. The shader explicitly bounds active range count, avoiding
   stale ranges in spare capacity. Reserve arena capacity before starting compute;
   invalidate cached groups on source-page or output/input buffer replacement.

## Measurements

Same checkpoint and settings, 20-second stationary and turning windows after
warm-up. Baseline is the retained immediately preceding run, including earlier
stream/material work. Live simulation and weather mean these are not identical
frame replays; no repeated control run was requested.

| Variant | Stationary FPS | Turning FPS | Stationary p99 ms | Turning p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Previous baseline | 157.04 | 99.63 | 35.32 | 17.77 |
| Preparation reuse | 156.93 | 115.18 | 67.54 | 17.47 |
| Both changes | 158.36 | 120.74 | 62.97 | 15.33 |

Turning throughput improved about 21.2% versus the retained baseline, and 4.8%
versus preparation reuse alone. Stationary average throughput is effectively
unchanged. Stationary median frame time fell from 5.09 to 4.03 ms, but p99 was
worse; the origin of these tail spikes is not established by this experiment.
This is not evidence of a general stall fix or a guaranteed gain in other scenes.

Stationary grass submissions remained 1,045,080 per frame, summed across passes.
No density, distance, shadow or quality reduction was used. During both combined
measurement windows, gather created zero new parameter GPU buffers and zero new
bind groups after warm-up, compared with about 10.5 and 23 of each per frame in
the baseline stationary and turning windows. Small parameter slices still use
and upload through the reusable arena; compute gathers themselves still run.

## Validation and evidence

- Optimized web-multiplayer-release build completed successfully.
- 38 targeted tests passed: detail storage/cache/instancing, stream/material and
  backend tests. Includes frame/visibility/storage invalidation, parameter slice
  lifetime, arena rollover and resource replacement.
- Actual WebGPU compute/readback checked 211,168 float values across five cases:
  changing active count, multiple dispatch windows, arena rollover, source-page
  growth and input/output growth. All matched; no validation errors.
- Browser benchmarks reported no GPU validation errors.

Repository GPU fixture: `detail-storage.browser-test.mjs` (test only).
Workspace evidence: `mechanics-test/grass-reuse-results/` contains preparation
and combined JSON/screen captures, pre-change sources, harness and validation logs.
Baseline: `mechanics-test/original-parity-results/extreme.json`.

These checks do not replace broad gameplay/reload testing under allocation
pressure, or investigation of the stationary tail spikes.
