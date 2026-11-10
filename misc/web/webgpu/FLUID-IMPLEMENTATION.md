# WebGPU volumetric smoke

This ports X-Ray's volume subsystem rather than substituting particle sprites. Native `WebGPUFluidVolume` reads the original version-3 `level.fog_vol` records and profiles, participates in sector visibility/sorting, retains the fire transfer texture, calculates original ambient/local lighting, and supplies static and moving rigid-body obstacles. Solver pipelines compile at first registration during level loading; texture resources allocate lazily when a volume becomes visible and are released with the native volume.

The GPU update retains the original sequence: obstacle rasterization, forward/backward density advection with BFECC (fog) or bounded MacCormack (fire), velocity advection/buoyancy, curl and confinement, Gaussian density/impulse emitters, divergence, six Jacobi pressure iterations, and projection. The original grid draws only cells 1 through dimension−2; compute writes a zero outer voxel layer to preserve that boundary condition. It preserves the original emitter falloff, draught modulation, fire cooling and voxel-space obstacle velocities. Static obstacles override moving obstacles. Obstacle interiors carry occupancy 0.5 and boundaries 1, using the original 1.73-voxel face-distance threshold. The browser uses a deterministic uniform hash for the original randomized ±2.5-voxel impulse-center jitter; it does not consume the game's global C random generator.

Persistent fields use core-WebGPU `rgba16float` 3D storage textures. Density and pressure occupy one channel, trading memory for portable filterable storage support. Intermediate fields are shared between sequential updates of identically sized volumes. With 70³ grids, each field uses approximately 2.62 MiB; five persistent fields per initialized volume plus eight shared fields total approximately 34 MiB for one volume. No GPU readback or synchronization is needed during gameplay updates.

The compositor raymarches fog front-to-back and fire back-to-front with the original transfer/opacity equations, twice-per-voxel sampling and fractional final-sample weighting. Native position-buffer depth clips rays against scene geometry; single-sample and 4× position textures are supported. It preserves the renderer's framebuffer and cached engine state and uses the current color target's sample count. The first implementation raymarches at full resolution; the desktop reduced-resolution/edge-aware acceleration is not implemented. No cost or visual-parity claim is based only on successful compilation.

## Important campaign limitation

All five shipped Call of Pripyat maps (`zaton`, `jupiter`, `pripyat`, `jupiter_underground`, `labx8`) contain version-3 `level.fog_vol` files with **zero volumes**. Enabling volumetric smoke alone therefore does not change vanilla campaign visuals. Authored mod volumes or an explicit test fixture are needed to exercise the feature. This is separate from particles and volumetric lighting.

## Validation

`fluid-gpu.mjs` compiles all eleven solver entry points and both position-texture raymarch variants on the actual GPU. Numerical readbacks verify finite, nonzero density after four updates; a moving obstacle's expected voxel velocity; original interior/boundary occupancy; static obstacle precedence; visible composited smoke; and complete scene-depth occlusion. Results: `/tmp/zone-fluid-obstacle-readback.log`, no GPU errors.

Native optimized Fog fixture passed 2,762 updates/draws with zero exceptions or GPU errors. Fire also rendered visibly, then passed six alternating 720p/1080p resets with 4× MSAA, checked configuration acknowledgements, actual canvas dimensions, and continued rendered frames. The first run exposed a WASM64 string-pointer conversion, which was corrected; Fire now refreshes its retained native texture handle per draw to survive reset. Final Fog also passed six resets, for twelve total across both types. Same-level save loading uses X-Ray QuickLoad and correctly retains the renderer volume; simulation continued afterward with zero errors. A separate corrected disconnect test verified native volume count 1→0, with no exceptions or GPU errors. The first lifetime harness incorrectly expected quickload to recreate the volume and was corrected; its assertion failure was a test expectation, not an engine trap. Procedural fixture overrides were removed and private test Chrome/server closed. Evidence: `/tmp/zone-fluid-fog-game2.log`, `/tmp/zone-fluid-fire-reset.log`, `/tmp/zone-fluid-Fire/reset-result.json`, `/tmp/zone-fluid-Fog/reset-result.json`, `/tmp/zone-fluid-Fog/teardown-final.json`. Broader visual parity, travel/mod scenarios and other GPU vendors remain manual acceptance.

## Isolated manual fixture

`tools/fluid-fixture.mjs` creates redistributable procedural v3 placement/profile data and exports `seedFluidFixture(page, fixture)` for a disposable OPFS profile. It never edits original archives. The default fixture is a four-metre cube in Zaton, with two emitters and one static obstacle. Its End binding teleports the test camera nearby. Use a fresh engine for Fog and Fire, and remove the loose fixture files before ordinary campaign tests.

Check smoke shape and flow over time, clipping against nearby geometry, moving actors displacing the volume, Fog/Fire differences, camera entry/exit, toggling the setting, save reload, level teardown/travel, resolution reset, and MSAA Off/4×. Verify diagnostics `fluid.updates`/`fluid.draws` advance, counters and GPU memory stabilize, and GPU validation remains clean. Cross-vendor quality and performance acceptance remains manual.

### Native adapter and fixture reproduction

`src/Layers/xrRenderGL/WebGPUFluidVolume.cpp` contains the browser-only adapter; desktop DX11 code is unchanged. World-to-grid transforms retain the original inverted Y axis. Authored world-position emitters scale normalized coordinates by 69, while moving-obstacle velocities scale by 70 after the original timestep compensation. The adapter computes the original ambient, hemisphere and local-light contribution before each draw. Registry-owned volumes detach from linked sector roots before level teardown, then release their GPU registration and fire texture.

Generate a placement without redistributing game assets:

```sh
node misc/web/webgpu/tools/fluid-fixture.mjs /tmp/fluid-fixture.json --type=Fog
```

For an isolated browser harness, import `createFluidFixture` and `seedFluidFixture` from that module. Seed the checkpoint and `user.ltx` first, then call `seedFluidFixture(page, createFluidFixture({type: 'Fog'}))` before launching the engine. The helper's `page.evaluate(expression, true)` interface matches the existing private CDP harness. Press End after gameplay starts to move to the fixture. Repeat from a fresh engine with `type: 'Fire'`; do not run this against a normal player profile. The seed helper adds loose placement/profile/script overrides to private OPFS only, and enables the original `r3_volumetric_smoke` setting.
