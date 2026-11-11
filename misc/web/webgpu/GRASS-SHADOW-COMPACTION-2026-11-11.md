# Grass shadow compaction integration

The GPU per-cascade grass compaction prototype from
`GRASS-SHADOW-PIXELS.md` / `experiments/grass-gpu-filter.js` is now integrated
into the production renderer as `detail-shadow-filter.js`, addressing that
document's integration checklist. The experiment file remains unchanged as
history.

## Integration

The engine marks each sun cascade explicitly: `render_phase_sun.cpp` flushes
native draws and sets `nativeShadowCascade` around every cascade's draw range
(cascades render serially on web; `mt_render` is 0). `backend.js` registers
main-pass detail batches (bounds, draw range, wind amplitude) and, per cascade,
runs one compute pass that conservatively culls instances against the cascade's
four XY clip planes — light depth stays unbounded, so casters outside the
camera view still shadow. Surviving rows are consumed via `drawIndexedIndirect`
through an explicit parameter on `encodePreparedDraw`; there are no wrapper
proxies. Spot shadow maps and the legacy cascade path are never marked and keep
their original draws. Oversized batches, unreadable uniforms or mesh copies and
non-uint16 draws fall back to the original path. Filter state releases with the
detail arena and purges entries unseen for 512 frames. Launching with
`-no_grass_shadow_filter` disables the marker and the whole mechanism.

Invariant to preserve: each cascade index renders at most once per frame on the
marked path; a same-index re-render with a different light matrix would reuse
the first compaction. Per-cascade compacted outputs cost GPU memory (up to
roughly twice the visible instance bytes per cascade; on the order of 100 MB in
the extreme-density stress scene).

## Validation (2026-11-11, perfbench forest, density 0.1, radius 300)

Real-WebGPU fixture `detail-shadow-filter.browser-test.mjs` (GPU vs CPU
reference, 900 instances, rotations, negative scales, wind, translated
volumes): passed. Two full-game runs (filter on / `-no_grass_shadow_filter`)
across reference view, low sun (19:00), turned view and forward movement, plus
an interleaved on/off/on/off/on toggle run: zero WebGPU validation errors in
every interval.

Indirect-argument readback, reference view: 65 effective shadow draws,
215,715 instances / 1,673,950 triangles versus 1,255,971 / 10,007,286
submitted — 83.3% less shadow geometry; main view unchanged at 418,657
instances. At low sun the cut was ~88% of a larger requested set. The low-sun
run also exercised the split path: ~51 unfiltered depth-only grass draws per
frame (spot shadow maps via `r2_R_lights.cpp`) coexisted with 93 filtered
cascade draws and zero fallbacks.

Interleaved toggle in one session (same world state, 12 s intervals):
135.5 / 136.7 / 136.4 FPS median with compaction versus 119.7 / 120.3 without
— about 1.0 ms/frame, with non-overlapping sample ranges. Cross-run phase
comparisons are weaker evidence: A-life simulation diverges between sessions
(dynamic lights, NPCs), which produced misleading per-phase FPS pairs until the
interleaved protocol was used.

Caveats: wind stays active, so screenshot pairs are visually equivalent but not
pixel-identical; a frozen-wind image comparison and explicit minmax-SM
scenarios remain for the manual regression pass before a hosted release.

Evidence: sibling `mechanics-test/grass-shadow-compaction-2026-11-11/`
(fixture output in run logs, per-phase telemetry and screenshots for both
runs, `toggle/toggle-results.json`, capture and analysis scripts).
