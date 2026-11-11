# Browser tessellation assessment — 2026-11-09

Implementation in progress following user approval. Native draw submission and GPU geometry generation are implemented and built; complete game visual/performance acceptance remains outstanding. No production deployment.

## Recommendation

Implement an optional GPU geometry-generation path for the game's authored PN-triangle and height-map materials. Do not enable every material, subdivide all terrain, or describe the feature as hardware tessellation. Start with a small deterministic reference harness, then static eligible meshes, then skinned models and all shadow passes. Preserve the original material selection and surface formulas. This is a visual-quality feature; there is no evidence it will increase FPS, and it can substantially increase GPU work.

WebGPU is modern but intentionally does not expose every native graphics-pipeline stage. Its render pipeline offers vertex/fragment stages and point/line/triangle topologies, without patch primitives or hull/domain stages. WGSL has vertex, fragment, and compute entry points. Existing HLSL tessellation stages therefore cannot simply be translated and attached to a WebGPU render pipeline. Compute-generated vertices/indices followed by ordinary triangle draws are viable with the standard API. Sources checked 2026-11-09: [WebGPU pipeline specification](https://www.w3.org/TR/webgpu/#render-pipelines), [WGSL shader stages](https://www.w3.org/TR/WGSL/#shader-stages).

## What this game's original implementation does

Source inspected:

- `src/Layers/xrRender_R2/r2.cpp`: `o.tessellation` is set only under `USE_DX11`; `triLOD` binding is also DX11-only.
- `src/Layers/xrRender/blenders/uber_deffer.cpp`: main deferred tessellation requires bump, HQ, enabled renderer option, and nonzero material `TessMethod`. Shadow path separately selects `tess_shadow.ds`.
- `blender_deffer_flat.cpp`, `blender_deffer_model.cpp`: authored method propagation is gated by `RENDER == R_R4`. Enabling only the renderer flag leaves this missing.
- `src/Layers/xrRenderPC_R4/R_Backend_LOD.cpp`: factor is `clamp(ceil(LOD^5 * 8), 1, 7)`. This feeds a triangular `pow2` hull shader, not a continuous screen-space factor.

The actual shipped CoP archive was read with the existing `server/tools/game-configs.mjs` archive decoder. Original sources are `shaders/r3/dx11/tess.hs`, `tess.ds`, `tess.h`, and `tess_shadow.ds` (the asset folder is r3 even for this DX11 path). Resource archives are overlaid by patches. Research extracts remain outside the repository in `/tmp/xray-tess-research`; no proprietary shader sources were added to git.

The hull stage receives three already-transformed control points, constructs cubic PN position and quadratic normal control data, and supplies one common edge/interior subdivision factor. For PN without HM it also culls certain distant back-facing patches. The domain stage interpolates texture, tangent basis, lightmap/hemi and detail coordinates. PN evaluates the curved patch; HM displaces its position.

Important fidelity details that a generic subdivision implementation would miss:

- The main color domain shader snaps some near-edge interior barycentrics, and restores *original linear triangle-edge positions* for samples originally on an edge. Removing these protections changes silhouettes/seams.
- The shadow domain shader does not contain that same edge clamp/snap. Blindly sharing one generated position buffer for color and shadows would change original behavior. Initially keep distinct pass variants; reconcile only with explicit visual evidence.
- Height displacement in this shipped helper is inside `USE_TDETAIL`, samples `s_tbumpX` alpha at explicit mip0, adds `(detailBumpX.alpha - 0.5) * 0.2` when detail bump is enabled, then offsets along its computed normal by `height * 0.07`. HM without the detail define does not displace in this asset version.
- The PN normal is used for displacement, but the main domain shader's writes back into the interpolated tangent basis are commented out. “Fixing” that while porting changes shading.
- The normal control-point formula divides by edge length squared. Degenerate source triangles need a defined finite fallback, tested separately.

`shaders.xr` was parsed by its chunk boundaries and packed blender descriptions. Of 205 blender records, 29 have the Tessellation property: 20 disabled, three PN, three HM, three PN+HM. Enabled families are `default_{pn,hm,pn_hm}`, `def_shaders/def_vertex_{pn,hm,pn_hm}`, and `models/model_{pn,hm,pn_hm}` (archive names use backslashes). This proves authored support exists; it does **not** establish which meshes are visible in Zaton or how often they draw. Add material/triangle counters before predicting benefit or cost. Temporary inventory evidence: `/tmp/xray-tess-research/materials.json`.

Asset hashes for reproducibility:

| Asset | SHA-256 |
|---|---|
| tess.hs | 8c4df3462f1c4587a297d49aee9f3a4dc06e47e04a48af8d946216219078f0e3 |
| tess.ds | 75a7be72fc4e36286a0b2ae69321ea99e2030e65ee7ddf04c29c0cbb6f28b096 |
| tess.h | d3c552e8f2a48374f1f1d36b12a58b83a654940693fc6bf6395805410955e551 |
| tess_shadow.ds | cedda76a6c5e4fcac433a789e3874d85beb781c745b62116888b8da13b79e8a1 |

## Proposed implementation

1. **Reference and inventory.** Preserve authored `TessMethod` in native prepared draw/material records for WebGPU. Count eligible draws/triangles by static/skinned, method, factor and pass. Obtain deterministic native DX11 barycentric/output captures for factors 1–7. Microsoft documents fixed-function domain sampling and topology as a separate stage; matching a regular grid visually is not proof of matching that topology. See [D3D11 tessellation stages](https://learn.microsoft.com/en-us/windows/desktop/direct3d11/direct3d-11-advanced-stages-tessellation) and [D3D11 functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm).
2. **Reusable sampling patterns.** Generate small immutable barycentric/index tables for the effective power-of-two levels (1, 2, 4, 8 for the stock factor range). Confirm rounding, orientation, connectivity and interior sampling against the reference before calling this parity. A compute pass evaluates PN/HM for each source patch and table point. Port the exact shader math and feature defines into small purpose-built WGSL kernels; automatic hull/domain translation is not required.
3. **Native geometry inputs.** Upload decoded triangle indices and necessary attributes once per immutable mesh generation. Use `STORAGE|VERTEX` generated vertices and `STORAGE|INDEX` indices, or vertex pulling over immutable source data for an experimental comparison. Handle packed formats, baseVertex/firstIndex, 16/32-bit indices, coordinate handedness, UV/detail/hemi, tangent basis and skinning explicitly. Do not run the existing skin transform again on already skinned generated vertices. Add a generated-geometry shader/pipeline variant with the correct input contract.
4. **Cache and scheduling.** Cache static output by source-buffer generation, draw range, tessellation method/factor, relevant material texture generations/defines, and pass variant. Start with faithful view-space evaluation; object-space cache reuse needs equivalence tests for rigid and nonuniform transforms and displacement directions. Skinned output must be regenerated for changed bone pose; include pose identity. Split back-face visibility from reusable surface data where safe. Batch generation before the consuming render pass to avoid a compute/render transition for every draw.
5. **Submission and bounded resources.** Extend prepared native draws with generated geometry handles, retaining cached pipeline/material handles. Current `backend.js` uses direct indexed draws; counts are deterministic for uniform subdivision, so no readback is needed. Optional GPU compaction can later produce indirect arguments; WebGPU supports `drawIndexedIndirect`. Keep firstInstance zero unless the optional capability is requested. Use per-device limits and bounded pages; current `detail-storage.js` demonstrates compute-to-vertex buffers and pass separation, but its grass record layout is not tessellation infrastructure. Keep independent budgets and avoid evicting buffers referenced by submitted/in-flight draws. [WebGPU buffers, limits and indirect draws](https://www.w3.org/TR/webgpu/).
6. **Pass completeness.** Cover main deferred, depth/shadow cascades, spots, skinned/HUD variants as applicable, alpha-tested materials and LOD switches. Reuse output only where math truly matches. Frustum bounds must include curved/displaced extents.

For parity, retain stock per-draw factor and edge protections first. A later adaptive mode needs canonical shared-edge factors and deterministic boundary evaluation across material/UV seams; independent per-triangle LOD creates cracks. Do not silently average across hard normals or incompatible displacement seams. If memory budget requires lower factors, choose coherently for the connected draw/mesh and expose a diagnostic counter. Avoid alternating independently selected factors every frame; hysteresis is a later explicit quality policy, not stock parity.

## Cost and validation gates

For an illustrative uniform triangular grid with N segments per edge, each source triangle produces N² triangles and `(N+1)(N+2)/2` vertices when shared only within that patch. N=8 means 64 triangles and 45 vertices. At an illustrative 64-byte generated vertex plus 32-bit indices this is 3,648 bytes per source triangle: 10,000 source triangles need about 34.8 MiB for one output, before source/control data, separate shadow variants and multiple frames. Exact native tessellator topology may differ; measure actual counts. Full-scene subdivision is inappropriate. Static caching reduces repeated computation but not rasterization, bandwidth or resident geometry cost; skinned objects and shadow variants multiply work.

Required evidence before shipping:

- CPU/reference and real GPU output checks for PN/HM/combined, all factors, winding, UV seams, hard normals, degenerate edges and nonuniform transforms.
- Fixed camera/weather/pose captures against desktop DX11: silhouettes, displaced shadows, near-edge behavior, bump/detail parity, alpha test, LOD changes. Screenshots of different live game runs are too noisy.
- Assert feature-on really increases generated vertex/primitive counts and changes eligible surfaces, while disabled/unmarked materials remain unchanged.
- Optimized browser runs on Apple/Metal and Windows NVIDIA/AMD, plus a lower-limit adapter. Validate storage limits and device-loss/reload/reset cleanup.
- Measure generation GPU time separately from rendering, CPU submission time, p50/p95/p99 frame time, memory, cache hit/eviction rate, uploaded bytes and pass count. Compare fixed recorded scenes using existing baselines where valid. Keep background/headless tests separate from users' Chrome.

No implementation or FPS gain is claimed here. The immediate recommended deliverable is the material inventory plus deterministic PN/HM GPU harness; a complete port is a multi-stage renderer feature, not a flag change.


## Implementation evidence — 2026-11-09

The browser now carries authored material methods and stock `triLOD` through a native draw record (now 16 words, including the instance buffer and count). The engine and frontend must be staged together; older record layouts are incompatible. The existing tessellation checkbox is exposed for browser builds. Color and shadow tags select separate kernels. The original skinned vertex shader runs once per source control point inside compute, preserving skin0–4 transforms; a pass-through render shader consumes generated geometry through prepared draws. Stock model shadow behavior is retained (the native model blender does not use its tessellated color path for shadows).

The generated sampling patterns were obtained from Microsoft's D3D11 reference tessellator, with uniform effective power-of-two factors and original triangle ordering. The reference code itself is not vendored. `tools/tessellation-patterns.py` reproduces the data given a locally downloaded reference implementation. These actual counts supersede illustrative regular-grid estimates above:

| Factor | Vertices per source triangle | Output triangles | Output bytes (128-byte vertices + uint32 indices) |
|---|---:|---:|---:|
| 1 | 3 | 1 | 396 |
| 2 | 7 | 6 | 968 |
| 4 | 19 | 24 | 2,720 |
| 8 | 61 | 96 | 8,960 |

The LRU cache is bounded to 128 MiB / 1,024 entries, plus tiny shared sampling tables and pipeline resources. It tracks source GPU identity **and upload revision**, draw range, method/pass plan, and subdivision factor; exact uniform snapshots and material identity determine reuse. This handles pooled stream-buffer reuse. Large draws reduce factor to remain within the cache and device storage-binding limits; unsupported draws retain the original surface and increment a diagnostic counter. Output positions are currently view-space, so camera/pose changes regenerate them. There is no GPU-to-CPU geometry readback.

Validation completed:

- Optimized Emscripten engine build (`xr_3da`, Release): passed.
- Node renderer/native runtime/native queue/surface tests: 39 passed.
- Real Apple Metal 3 GPU evaluation: 4,860 vertex samples, all three methods, factors 1/2/4/8, color/shadow, detail flags and degenerate cases; maximum position error against CPU stock-equation oracle 2.21e-7.
- Real generated original-VS adapter execution with packed attributes and nonzero firstIndex/baseVertex: maximum position error 9.95e-8; generated indices match reference.
- Real frontend draw/readback: 1,352 colored pixels, cache generation/reuse and bounded eviction verified, no WebGPU validation errors.
- Twenty-one stock shader variants (18 static and skin0–4 × PN/HM/combined, plus three separate shadow variants) compile into valid compute pipelines, including actual detail/displacement bindings. Pipeline compilation alone is **not** visual parity evidence.
- Asset scan: 1,030 OGF/map-level files, 216,060,568 bytes inspected after archive patch precedence; 134 meshes reference enabled authored families (132 PN, one HM, one PN+HM). Examples include `actors/stalker_bandit/stalker_bandit_1.ogf`, `monsters/snork/snork.ogf`, and the supplied `stalker_nebo_2_face_*` variants. No matching map-level materials were found by this string inventory. This proves substantial character coverage, not visible draw coverage in a particular checkpoint.

Run isolated GPU tests with `node misc/web/webgpu/tools/tessellation-gpu-check.mjs`. Optional private compiled stock fixtures can be supplied through `TESS_STOCK_DIR`; they are not distributable test assets. Test browser is headless and uses a temporary profile.

Remaining acceptance / optimization work:

- Full-game stock character draws, animated poses and material switches must be captured and inspected; compare color/shadow silhouettes across PN/HM/combined, geometry LOD transitions, and renderer restart. Confirm no cracks or clipping beyond the original's edge rules.
- Measure populated-scene CPU/GPU time and cache pressure at actual authored triangle counts. The synthetic memory checks above are not game FPS evidence.
- Batch generation across adjacent draws where safe; current implementation inserts compute before each changed draw. Object-space cache reuse and shared skinned-control transforms need equivalence proof before adoption.
- Verify alpha-tested authored material coverage, all native shadow paths and conservative bounds. Browser support across Windows/NVIDIA/AMD and integrated GPUs still requires manual/hardware coverage.
- No claim of full native tessellation parity or performance improvement is justified until these checks pass. Tessellation increases visual geometry quality and can be expensive; it is not a grass/terrain FPS optimization.

### Manual acceptance checklist (not yet signed off)

- [ ] Start an optimized browser build, enable Tessellation in advanced graphics, apply/restart, and load a populated save. Confirm native gameplay and menu rendering remain usable.
- [ ] Inspect an authored PN stalker and a mutant close-up while idle, walking, running, firing and dying. Confirm there are no detached faces, inverted triangles, frozen poses or new seams; inspect distant LOD changes as well.
- [ ] Inspect supplied HM and PN+HM character variants in a controlled asset fixture. Check both detail-bump modes and the original linear boundary behavior. Ordinary PN NPCs do not demonstrate HM correctness.
- [ ] Inspect sun cascades, flashlight/spot shadows, and color silhouettes while walking around the same actors. Record differences against native DX11 rather than assuming all color/shadow output should match each other.
- [ ] Change geometry detail, reload the save, restart the renderer and revisit the actor. Watch diagnostics for errors, stale geometry, growing memory or repeated budget fallbacks.
- [ ] Record a populated-scene trace at the intended resolution/settings, including `tessellation.draws/generated/reused/bytes/peakBytes/evictions/budgetDowngrades/unsupported/levels/methods/shadowDraws`. Record CPU/GPU frame times separately. This checklist has not established a performance target yet.

Packaging note: build the artifact-copy target (or explicitly copy the completed `bin/Release/xr_3da.js` and `.wasm` to the artifact directory) before staging. A successfully linked engine followed by staging stale artifacts produces a mismatched draw ABI. The initial `webgpu-msaa-tess-stage` was rejected by startup for this reason; the corrected joint `webgpu-msaa-mip-stage` is the next test candidate. Do not publish the rejected stage.

### Isolated geometry throughput

On this machine's Apple Metal 3 adapter, the production generated compute shader was measured with WebGPU timestamp queries (five samples after two warmups). Factor 8 PN generation took a median **0.130 ms** for 1,000 source triangles → 96,000 output triangles / 8.96 MB, and **0.759 ms** for 10,000 → 960,000 / 89.6 MB. The ranges were 0.122–0.131 ms and 0.755–0.760 ms. This fixture repeats a small packed source triangle and a simple source vertex transform. It excludes original character skinning, height-map sampling, material changes, rasterization, scene traversal and cache churn, and must not be presented as a full-game frame-time prediction. Its purpose is to establish compute-output cost and the high memory amplification at maximum factor.

Compute parameters now use the existing batched uniform ring. A real GPU regression check changes projection for a second draw of the same cached mesh, verifies regenerated output, and verifies the command encoder is retained rather than forcing an extra submission. The 21 stock pipeline checks also use the production renderer's explicit bind-group layouts, not only automatic layouts.


The corrected optimized joint build also loaded the stock saved game and rendered normal gameplay with MSAA disabled: zero WebGPU validation errors, 68 authored tessellation draws, 131,620 cumulative source/output triangles (factor 1 in this view), 4,621,896 peak cache bytes, no evictions/downgrades/fallbacks. This confirms end-to-end native material/draw integration but does **not** establish visible high-factor surface quality. Screenshot and private capture are under `/tmp/zone-tess-game`; six distinct WEB_TESS shader requests were observed. Close-range animated NPC acceptance remains open.


Original static HM and PN+HM material shaders now also execute through the production frontend with real 1×1 displacement/detail texture bindings. Readback of all 61 generated vertices matches the stock-equation oracle within 3e-5, with interior displacement and the original linear color-edge positions verified. The source triangle and white textures are controlled fixtures; this verifies resource binding and sampling behavior, not the artistic appearance of the shipped HM character assets.


### Authored animated NPC execution

The private close-range probe selected living stock NPC `sim_default_stalker_26525`, visual `actors\\stalker_neutral\\stalker_neutral_2_mask`, and moved the test actor within 3 m. Native draw submission exercised factor 8 continuously: between two telemetry samples, 342,516 source triangles generated 32,881,536 output triangles (exactly 96×). At the final sample the cache held 47,723,728 bytes, with zero evictions, budget downgrades, unsupported fallbacks or GPU validation errors. Overall frame samples were approximately 67–68 FPS; these are workload observations, not an isolated tessellation overhead comparison. All draw generation and animated skinning ran through the original game's material/pose data.

The screenshot is substantially occluded by maximum-density foliage. It confirms a normal playable world and NPC interaction label, but is **not** sufficient to sign off detailed character silhouettes, cracks or animation appearance. The manual visual checklist remains pending. Test files are `/tmp/zone-tess-game/result.json`, `capture.json` and `npc.png`; no user profile or save was modified. A private-script issue encountered during setup was an unsupported Lua userdata equality operator; it was corrected to compare object IDs and is unrelated to renderer behavior.


Inventory correction: the final scan includes `resources`, separate `levels`, then `patches` archives (not just resources/patches). It covers 1,030 unique mesh/map files, still finds 134 enabled character meshes, and no enabled family strings in map-level files. Cached displaced geometry also tracks height-texture content revisions; real GPU tests replace the contents of the same texture handle and verify regenerated HM/PN+HM output rather than stale cache reuse.
