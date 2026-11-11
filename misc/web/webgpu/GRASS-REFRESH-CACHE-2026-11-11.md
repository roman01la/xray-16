# Grass refresh cache and quantized fade eye

Follow-up to `RUNTIME-BREAKDOWN-2026-11-11.md`. Two web-only producer changes in
`src/Layers/xrRender/DetailManager.*` and a diagnostics line in
`src/Layers/xrRenderGL/glDetailManager_VS.cpp`. Non-web builds are unchanged.

## Why records went dirty while standing still

Instrumented counters (emitted as `WEB_GRASS` log lines while detail profiling
is enabled) show the camera position changing in 28–33% of frames by one or two
float32 ULPs (at most 0.12 mm) in the stationary perfbench scene. Every
invalidation was a `scale_calculated` exact-compare failure; zero were
screen-size class changes. Sub-millimeter eye drift therefore re-dirtied every
slot scheduled for its 15–29-frame refresh, producing the previously measured
243–269 grass record writes per frame without any visible change.

## Change 1: exact-input refresh cache

Each slot stores the squared fade distance and a fade/ssa threshold epoch from
its last scheduled refresh. A refresh whose inputs match skips the rebuild;
`r_items`, revisions and `scale_calculated` stay untouched, so skipping cannot
change uploads or rendering. Invalidated on slot recycling (`cache_Task`),
re-decompression (`cache_Decompress`, which also moves the slot sphere) and
threshold changes. Classification state is CPU-side; GPU resets keep their
existing `storageGeneration` handling. Frustum/HOM tests and per-frame visible
list assembly are unchanged.

Measured alone (same harness as the upload investigation): 88.8% of scheduled
refreshes skipped (597 of 672 per frame); remaining rebuilds took ~0.09 ms per
frame, implying roughly 0.85 ms/frame of task-worker CPU for the uncached
rebuild. Uploads and draw counts matched the baseline; zero validation errors.

## Change 2: fade/classification reads a quantized eye

Fade and classification compute distance from the camera snapped to a 1/1024 m
grid. ULP-level jitter then yields bit-identical inputs, while real movement
(far above 1 mm per refresh interval) recomputes as before. Worst-case input
shift is under 1.7 mm against a 300 m fade range (alpha shift ~1e-5). Frustum,
occlusion and cache/decompress ordering keep the exact camera.

Measured with both changes: zero grass record and gather-range writes per frame
in the stationary scene (previously 243–319 calls, 113–150 KB, ~0.12–0.27 ms
synchronous write time), zero rebuilds (671 scheduled refreshes per frame all
skipped), identical main/shadow draw and instance counts, zero validation
errors, visually identical screenshots.

## Cautions and follow-ups

FPS stayed within this scene's run-to-run drift (118–121 median); the
demonstrated effect is eliminated producer CPU and upload work, not a proven
frame-rate win. Measurements are stationary-camera only: counters prove
movement still triggers refreshes, but a moving-camera manual pass (grass
fade-in/out while walking) belongs in the next manual regression round.
The ULP camera jitter itself remains unexplained at the source and may tax
other camera-keyed caches; auditing those consumers is a candidate follow-up,
as are the previously listed shadow-compaction validation and isolated GPU
pass timings.

Evidence: sibling `mechanics-test/grass-refresh-cache-2026-11-11/`
(`analysis.json`, per-change telemetry, screenshots, capture/analysis scripts),
compared against `mechanics-test/grass-upload-investigation/`.
