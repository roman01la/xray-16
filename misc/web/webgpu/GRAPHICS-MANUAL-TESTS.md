# Browser graphics manual test plan

Updated 2026-11-09. This tracks the new WebGPU graphics features separately from gameplay-mechanics testing. Never infer success just because the frame counter advances: diagnostics must show zero GPU validation errors, and the scene must actually render.

## Current evidence and unfinished work

- Legacy edge AA, DOF parity, gather-based Ultra shadows, HBAO and HDAO High: optimized isolated game tests passed. The earlier requested-Ultra test was clamped to High; a follow-up clamp fix and actual quality-4 capture now render correctly, but the pixel path is expensive (~180 ms GPU telemetry in this isolated 1080p scene). Broader scenes/GPU vendors still need manual checks.
- Mip LOD bias: native constant and compiler path implemented; unit tests and actual GPU mip-colour readback passed. Gameplay commands were applied during reset tests; broader visual-quality and persistence checks remain manual.
- 4× deferred MSAA and alpha-tested geometry: GPU coverage/readback fixtures and separate optimized full-game runs passed for alpha-test Off, Standard and High, with zero GPU errors. Twelve alternating 720p/1080p reset cycles also passed across native Fog and Fire. Broader-scene/vendor acceptance remains pending.
- Volumetric smoke: original solver stages, Fog/Fire raymarch and native loader/profile/obstacle bridge are implemented. GPU density readback and depth-occlusion tests passed; optimized Fog and Fire fixture runs passed, including twelve resolution resets, same-level quickload and native volume teardown. All five original CoP maps contain zero authored fluid volumes. Ordinary particles and volumetric lighting are separate features.
- 385 unique shader requests captured from the three MSAA alpha modes are compiled and packaged offline (stage total 1,672). Runtime compilation remains available for unobserved combinations. Production publication and broader visual/vendor acceptance are not part of these isolated tests.
- Tessellation is tracked separately in `TESSELLATION-ASSESSMENT-2026-11-09.md` and its implementation follow-up.

## Repeat for single player and multiplayer

1. Start a fresh engine for each AO/MSAA selection. These are renderer-creation options; `vid_restart` alone is not evidence that an AO algorithm changed. Confirm captured shader mode/diagnostics when investigating discrepancies.
2. Load an exterior save with grass, trees, NPCs, sky and distant geometry. Then test interiors, water, rain, muzzle flashes, particles and level travel. Keep the same save/camera when comparing settings.
3. Toggle `r2_aa` off/on with DOF on. Focus/blur, bloom, heat distortion and foreground silhouettes must remain coherent; the filter should soften edges without dropping those effects.
4. Compare High/Ultra/Extreme sun shadows on fences, grass and terrain. Ultra uses the gather filter; Extreme uses its own algorithm. Check shadow acne, light leakage, stable penumbrae and motion.
5. Start separately with default AO, HBAO, HDAO High and HDAO Ultra. Check contact shading near rocks/walls, silhouettes against sky and screen borders. Ultra is the original 48-valley HDAO pixel shader. Compare visual quality and GPU frame time; do not assume an automatic speedup.
6. Test Off and 4×, then alpha-test Off/Standard/High-quality. Inspect thin fences and moving foliage. Verify HUD/menu text, water refraction and transparent particles, and that no detached duplicate view or black frame appears.
7. With MSAA enabled, change resolution and reset graphics several times, load another save, travel, and return to the main menu. Check memory stabilizes, resize uses matching sample counts, and no validation error appears.
8. Change `r2_tf_mipbias` between −1, 0 and +1 while looking obliquely at textured ground. Positive should blur texture detail; negative should sharpen it and may shimmer more. Verify normal/detail textures stay aligned and the saved setting persists after reopening.
9. Repeat on at least Windows/NVIDIA and macOS, with 720p and 1080p. Record browser/GPU, build ID, settings, errors and representative screenshots. Leave visual-quality and performance judgments pending where only compilation or an offscreen fixture has been checked.

## Result log

| Feature | Automated evidence | Manual status |
|---|---|---|
| Edge AA + DOF | 7,972 gameplay frames, no exceptions/GPU errors | Pending broader scenes |
| HBAO, HDAO High | Separate fresh-start gameplay runs, captured mode shaders, zero GPU errors | Pending broader scenes/vendors |
| HDAO Ultra | Actual quality-4 shader and visible terrain/HUD after warmup; 528 frames, zero GPU errors | Very expensive pixel path (~180 ms GPU telemetry); broader scenes/vendors pending |
| Gather/sample compiler | Eight compiler tests | Not a separate UI feature |
| 4× resolve/A2C/sample loads | GPU readbacks match expected coverage and resolve | Three alpha modes passed in full game; twelve resize cycles passed; travel/vendor checks pending |
| Mip bias | Three tests, real GPU mip selection; ±1 commands applied during gameplay reset runs | Visual quality/persistence checks pending |
| Volumetric smoke | 11 compute kernels; finite emitted density; raymarch/depth-occlusion readback | Fog/Fire fixtures, twelve resets, quickload and teardown passed; broader visual/vendor checks pending |

## Tessellation

See [the tessellation acceptance checklist and implementation evidence](TESSELLATION-ASSESSMENT-2026-11-09.md#manual-acceptance-checklist-not-yet-signed-off). The optimized browser engine now routes authored PN/HM/combined materials through bounded compute-generated geometry. GPU equations, packed input, draw/cache behavior and 21 stock color/shadow pipeline variants pass automated checks; a real saved game and an authored animated NPC exercised factor 8 without GPU errors (47.72 MB cache peak). Real HM/combined texture displacement readbacks also pass. The NPC screenshot is obscured by foliage, so close-range visual inspection, shipped HM appearance, shadow silhouettes, populated-scene performance and cross-vendor acceptance remain pending. This is a visual-quality feature, not a promised FPS improvement.

## Automated acceptance artifacts

Final regression suite: 50/50 tests, `/tmp/zone-final-graphics-regression.log`. Final isolated engine/frontend stage: `../mechanics-test/webgpu-fluid-final-stage`; no production deployment or local 8132 replacement. Smoke details and exact limitations: [FLUID-IMPLEMENTATION.md](FLUID-IMPLEMENTATION.md). Fog/Fire screenshots were inspected after disabling detail foliage only in the disposable fixture profile. Actual native cleanup reports zero live volumes after disconnect.

## Five-path rendering work reductions (2026-11-10)

Pending manual visual checks (not claimed complete by automated probes):

- Enter/leave Skadovsk at day and night; turn rapidly around occluded lights.
  Lights must not remain missing after a camera move or flicker persistently.
- Move/disable a flashlight; reload a save and change graphics settings using
  `vid_restart`. Delayed visibility queries must not affect a new renderer.
- Watch nearby stalkers and mutants animate, attack, die and cast shadows.
  Their shadows and visible poses must agree, including animation transitions.
- Exercise scope, rain, water, inventory/menu and save preview rendering; no
  stale contents should survive a folded clear or texture resize.
- After a level transition, repeat the above and check for validation errors.

Automated coverage and measured performance are recorded in
[the five-path experiment report](ORIGINAL-RENDERER-FIVE-PATHS.md).

## Six-area renderer follow-up

See [experiment details](ORIGINAL-RENDERER-SIX-AREAS.md). Pending manual checks:

- Compare maximum texture quality after reload with the previous build; change
  texture quality down and reload. Ordinary 2D textures should get less detailed;
  sky/cubemaps, UI positioning and texture UVs must remain correct.
- Walk through object LOD transitions and turn around overlapping opaque models;
  transitions should match previous behavior without new holes or sorting errors.
- Trigger fire, smoke and several simultaneous particle effects; no missing
  sprites, broken transparency, corrupt geometry or stream-size assertions.
- Confirm save/load and level travel remain correct after these checks.

## Animation bounds and light setup reuse (2026-11-11)

See [scheduling/work experiments](ORIGINAL-RENDERER-SCHEDULING.md).
Pending manual visual checks:

- Observe NPCs and mutants near frustum edges, including death/ragdoll and
  attachment changes. No new disappearance or mismatched animation/shadow poses.
- Move and rotate a flashlight; enter interiors and vary shadow quality. Lights
  and shadows must update immediately. Revisit after save/load and level travel.
- Check moving/flickering lights and spot/point light transitions. Cached setup
  must not retain an earlier transform or stale shadow resolution.

Animation update rates and production frame pacing have not changed. The terrain
shader prototype is not enabled in the game.
