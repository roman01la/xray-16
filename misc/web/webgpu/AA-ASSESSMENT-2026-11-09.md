# WebGPU anti-aliasing and DX10.1 assessment (2026-11-09)


## Implementation follow-up (2026-11-09)

The assessment below records the starting implementation. Work subsequently authorized and implemented:

- `r2_aa` now preserves DOF, corrected neutral distortion offset, foreground depth rejection, complete distortion displacement, bloom and distortion blur.
- The pinned Naga 26.0.0 SPIR-V frontend now translates constant-component sampled gathers and comparison gathers, preserving constant offsets. Dynamic offsets remain explicitly unsupported. Offline and runtime compilation use the same shipped WASM toolchain.
- Ultra sun shadows use a constant-offset, 16-comparison-gather implementation of the original 7×7 filter, using the already bound depth texture. This does not enable DirectX, nor does it replace the separate Extreme shadow algorithm. Both Ultra and Extreme sun settings are now recognized by the browser console.
- HBAO and HDAO mode flags are enabled for WebGPU. Broken GL HBAO position reconstruction/vector operations are repaired. HDAO executes the original valley algorithm instead of returning unoccluded light. Its four depth/normal taps use two gathers with explicit ordering preservation.
- Ultra AO uses the original 48-valley HDAO **pixel shader**, with signed/clamped pixel addressing and proper vector comparisons. A follow-up capture exposed a remaining target-construction clamp to High; that guard has now been corrected in source, and a fresh quality-4 gameplay capture now verifies visible terrain/HUD with zero GPU errors after warmup. As in the stock selection logic, Ultra quality selects this HDAO algorithm regardless of the lower-quality mode selector; it does not claim to use the desktop compute implementation.
- Texture mip LOD bias is passed from `ps_r__tf_Mipbias` through a native shader constant. The shared compiler applies it to implicit and gradient sampling without changing explicit LOD/integer fetches or shadow comparison semantics. Three unit/compiler tests pass; real GPU readbacks select the expected three solid-colour mip levels for biases −1/0/+1. Ninety representative engine shader pairs compile with the new path.
- 4× deferred MSAA allocation, resolves, per-sample texture loads, alpha-to-coverage (Standard) and original alpha sample masks (High) now pass separate optimized full-game runs with zero exceptions/GPU errors. The original non-edge combine pass is restored, and dormant LOD/particle/sample-mask shader issues are repaired. Actual compiled sample masks produce the expected half-coverage readback. 385 unique shader requests captured from these runs are compiled and packaged offline.
- Volumetric smoke now has the native volume/profile/visibility/lifetime/obstacle adapter and GPU solver/raymarch implementation. Eleven compute stages and single/multisample raymarch shaders compile; simulation density remains finite and nonzero, and real GPU image readback confirms scene-depth occlusion. All five stock CoP maps contain zero authored fluid volumes, so native validation uses an explicit isolated fixture. Optimized native Fog/Fire fixtures now render visibly and pass twelve combined resolution resets, same-level quickload and native disconnect cleanup, with zero GPU errors.

Validation completed: six gather compilation tests plus a multisample-load test; 22 backend tests; optimized AA/DOF gameplay toggles (7,972 frames, zero exceptions/GPU validation errors); independent fresh-start HBAO and HDAO High gameplay runs with captured mode-tagged shader sources and zero exceptions/GPU validation errors. The earlier requested-Ultra run actually compiled SSAO_QUALITY 3 and cannot count as Ultra acceptance. The first true quality-4 screenshot was premature and black; repeating with 45 seconds of GPU warmup produced visible terrain/HUD, 528 frames and zero GPU errors. This original pixel path is expensive (about 180 ms GPU telemetry in this isolated 1080p scene), so functional acceptance is not a performance endorsement. Offscreen real GPU readback verifies four sample-index colours average to 128, hardware alpha-to-coverage reduces full red 255 to 128, and reading all four samples matches the hardware resolve exactly.

AO mode flags are currently restart-scoped in the original renderer. A `vid_restart` alone does not switch HBAO/HDAO flags, so validation used fresh engine starts; do not treat a successful config load alone as proof that the selected algorithm executed. Capture artifacts and test results are in `/tmp/zone-ao2-hbao-st_opt_high`, `/tmp/zone-ao2-hdao-st_opt_high`, `/tmp/zone-ao2-hdao-st_opt_ultra`, `/tmp/zone-aa-gather-validation`, and `/tmp/zone-multisample-gpu-test.log`.

Remaining manual acceptance: level travel and broader scenes/vendors; close visual comparison with desktop smoke and other authored mod volumes; mip-bias quality/persistence. MSAA reset, native Fog/Fire lifetime, and ±1 mip-bias commands have been exercised in optimized gameplay. Unobserved shader combinations retain the shared runtime compiler fallback. Smoke currently raymarches at full resolution rather than the original reduced-resolution edge-aware optimization; no performance equivalence is claimed. No production deployment or replacement of local 8132 has been performed by this work.

Real-game MSAA evidence: `/tmp/zone-msaa-game-validation6.log` (Off, 3,744 frames), `/tmp/zone-msaa-standard-game2.log` (Standard), `/tmp/zone-msaa-high-game.log` (High, 2,712 frames). All report zero exceptions and zero GPU validation errors. Solver and depth-occlusion evidence: `/tmp/zone-fluid-render-gpu.log`; final regression suite 50/50: `/tmp/zone-final-graphics-regression.log`.

## Original implementation assessed

The visible DX10.1 checkbox maps to `r3_use_dx10_1`, and the 2×/4×/8× anti-aliasing dropdown maps to `r3_msaa`. Neither drives working browser MSAA. The shared renderer's `USE_OGL` branch hard-disables MSAA (`r2.cpp`, around lines 402–430); the browser WebGPU frontend creates single-sample textures and render pipelines without a multisample descriptor or resolve attachment (`backend.js`, texture allocation and draw pipeline creation). The browser build still uses this shared renderer branch; this does not mean it submits through OpenGL.

DX10.1 is a desktop API feature level, not a WebGPU graphics-quality mode. In the desktop code its switch selects Shader Model 4.1 and different MSAA paths. A separate browser exclusion in `rgl_shaders.cpp` (around line 422) prevents emitting `SM_4_1`, retaining the old WebGL2 texture-gather restriction even though rendering is now WebGPU. That affects stock gather-based shadow-filter variants and HDAO sample positioning. It is therefore useful to investigate those algorithms individually; restoring a checkbox labelled DX10.1 would remain misleading.

## Concrete shader-compiler blocker

Minimal fragment shaders were compiled through the actual shipped WASM shaderc/Naga toolchain, without modifying production code:

- Constant-offset `textureGatherOffset`: fails with `Naga: unsupported instruction ImageGather at Function`.
- Dynamic-offset `textureGatherOffset`: fails with `Naga: unsupported capability ImageGatherExtended`.

Probe: `/tmp/zone-aa-gather-probe.mjs`; result: `/tmp/zone-aa-gather-probe.json`. The sidecar pins Naga 26.0.0 with SPIR-V input and WGSL output. Removing the browser `SM_4_1` guard alone is not a valid implementation. The stock high-quality shadow shader also supplies loop variables as gather offsets; WGSL gather offsets require constant expressions, so that algorithm needs explicit constant-offset taps/unrolling or a mathematically verified coordinate reformulation as well as a compatible translation path.

WebGPU supports multisampled resources, sample masks and alpha-to-coverage, but the current frontend does not implement them. Portable core WebGPU texture sample counts are 1 and 4, so the old 2×/4×/8× menu cannot simply be exposed unchanged. Full deferred MSAA requires consistent multisampled G-buffer/depth attachments, matching pipeline counts, per-sample shader/resource bindings, explicit resolve paths and reset/travel coverage. It is a larger renderer feature, not a checkbox fix.

## Original X-Ray edge filter

`r2_aa` controls `R2FLAG_AA`, selecting `combine_2_AA` / `combine_2_AA_D` in the existing final combine pass. It is X-Ray's depth/normal discontinuity filter, not FXAA, SMAA or TAA:

1. Read the center and neighbouring G-buffer values (nine logical G-buffer samples in the shader).
2. Detect normal discontinuities and second differences in depth using `e_barrier` and `e_weights`.
3. Use the result and `e_kernel` to blend four nearby colour samples, then run motion blur/bloom combination.

There is no temporal history/reprojection. It can soften geometric edges but is not a complete solution for moving foliage, subpixel geometry, texture or specular shimmer. It does not require MSAA. The package already contains 16 WGSL programs with active `e_kernel`, `e_barrier` and `e_weights`, establishing offline compile coverage for existing filter variants. An isolated headless gameplay run accepted both toggle states and continued rendering without validation errors; quality and cost still need the broader validation described below.

A significant behavior difference: `combine_2_NAA.ps` includes and executes `dof()`, while `combine_2_AA.ps` does not. Enabling the original filter can therefore bypass depth-of-field even when that graphics setting is enabled. It should not be presented as a polished independent AA option without resolving that interaction. The engine default flag excludes `R2FLAG_AA`, and the current performance-test saved configuration explicitly has `r2_aa off`.

## Recommendation

1. Remove the inert DX10.1 and 2×/4×/8× MSAA browser controls rather than relabeling them as implemented features.
2. Validate the already compiled legacy filter on actual gameplay, with separate correctness checks for distortion, DOF, scopes, UI, resize and travel. If retained, expose accurately as an optional edge-smoothing toggle after fixing DOF composition. Do not switch it on globally based on shader existence alone.
3. For a general browser AA feature, evaluate an independent colour-based postprocess separately from the old combine filter; choose from measured quality/cost, especially dense moving grass. Temporal AA would be a substantially larger motion/history integration task.
4. Investigate gather-based shadow filtering as an independent WebGPU optimization. First solve/replace the failing SPIR-V gather translation and constant-offset restrictions, then compare GPU time and shadow quality with current PCF. No speedup is established by this assessment.
5. Treat 4× deferred MSAA with alpha-to-coverage as a later feature with explicit memory/bandwidth budgets and browser/GPU coverage. It is not a prerequisite for useful postprocess AA.

## Primary API references

- [Microsoft: Direct3D 10.1 features](https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-10-1): Shader Model 4.1 and multisample feature changes.
- [WebGPU specification](https://www.w3.org/TR/webgpu/): multisample pipeline/texture constraints, alpha-to-coverage and resolves.
- [WGSL textureGather](https://www.w3.org/TR/WGSL/#texturegather): gather semantics and constant-expression offset restrictions.

## Validation status

Code inspection, packaged-AA shader inventory, actual sidecar gather compilation probes, and isolated background gameplay toggles completed. No production settings, renderer code or release was changed. The user's Chrome and local 8132 game were not touched.

The optimized grass-fix stage was served privately on 8142, using the disposable performance profile and a saved Zaton scene at 1920×1080 with dense/tall grass. Four successive `r2_aa` states (off/on/off/on) each logged successful configuration loading and continued rendering; frame counters advanced from 1662 through 7843. All samples reported zero WebGPU validation errors and the runner collected no runtime exceptions. DOF was disabled in both states to avoid its code-path difference confounding the AA comparison. The on-state screenshot shows a rendered game/HUD, not a loading screen. Headless mouse capture failed, leaving the dimmed click-to-capture overlay; the stationary game continued rendering.

The 12-second sampling blocks produced these medians:

| State | Samples | FPS | GPU ms | CPU render ms |
| --- | ---: | ---: | ---: | ---: |
| Off, first | 12 | 91.6 | 12.01 | 8.76 |
| On, first | 11 | 93.7 | 12.48 | 9.30 |
| Off, second | 12 | 87.7 | 11.70 | 9.64 |
| On, second | 12 | 158.2 | 6.31 | 5.13 |

These are exploratory observations, **not a reliable AA cost or speedup result**: timing changed substantially during the last block, other work was active on the machine, the scene contains animated close foliage, and headless rendering/pointer lock differs from normal play. The initial pair suggests a small GPU cost but cannot establish it statistically. Do not infer that AA improves FPS from the final block. Correctness across other scenes, visual quality in motion, DOF composition, and a controlled cost measurement remain unvalidated.

Reproduction script: `/tmp/zone-aa-assessment.mjs`; results: `/tmp/zone-aa-assessment/aa-result.json`; screenshots: `aa-0-false.png` through `aa-3-true.png` in that directory. The runner closed its own Chrome and preview server after completion.
