# Five further renderer investigations

2026-11-10. Research only: no renderer changes, build replacement or deployment.
Scope: visibility, shadow reuse, animated characters, render-target/pass lifetime,
and allocation/synchronization. All five were inspected. No new FPS gain is
claimed. Do not conflate current OpenXRay source with proven original-binary behavior.

## Evidence and limits

Inspected the installed original `game-data/cop/bin/xrRender_R4.dll`, SHA256
`fab787bca9e7a847ab96009c9882eddf2b0c4964e4328cb5d041e196d8c83df3`.
Addresses below use preferred VA base 0x10000000. Binary provenance caveats from
ORIGINAL-RENDERER-FOLLOWUP.md still apply. No stock Windows runtime capture exists.

New binary anchors/excerpts are in workspace
`mechanics-test/original-grass-disassembly/five-path-anchors.json`,
`five-path-imports.txt`, `R4-smapvis-flush.asm`, `R4-query-get.asm`, and
`original-frame-queries.asm`. Scripts are retained beside those files (the import
extraction script is copied into the new audit evidence directory).

The production-JS probe in `mechanics-test/five-path-renderer-audit/probe.mjs`
passed. It uses a mocked GPU to establish query ordering, generation invalidation
and clear-pass counts; it is not a hardware/FPS benchmark.

Reused the latest combined grass benchmark instead of rerunning a control.
In its final 255-frame turning sample interval: zero native occlusion queries,
2,224 named clears (8.72/frame), 12,682 render passes (49.73/frame), zero new
native texture allocations, zero new stream-buffer allocations, and about
195.5 KB/frame of uniform bytes copied. These are one interval's cumulative
counter deltas, not a whole-game distribution or GPU timings. Source:
`mechanics-test/grass-reuse-results/combined.json`.

## 1. Visibility and occlusion

**Existing:** sector/portal traversal and CPU HOM rejection remain active in
`r2_R_render.cpp` and `r__dsgraph_build.cpp`. Main traversal requests HOM, SSA and
portal fade; static/dynamic visual paths call HOM.visible. HOM is dispatched as
a task; its temporal reuse still exists. There is no evidence of a browser-wide
removal of building/room culling. The original HOM loader is anchored by
`* Loading HOM: %s` at 0x1005926f, but that alone does not establish exact parity
of all thresholds or traversal policies; those are not fully reconstructed.

**Confirmed gap: asynchronous light-query lifetime.**

- `light::vis_prepare` issues queries, and pending lights are consumed by
  `render_lights(LP_pending)` within the same render call. `vis_update` reads them.
- WebGPU's `nativeQueryResult` returns -1 until asynchronous readback completes.
  `blit` resolves occlusion queries and starts readback at presentation, later
  than these same-frame reads.
- Web `R_occlusion::occq_get` treats S_FALSE as visible, then still pools the
  query, clears the used entry, and resets the ID. `vis_update` clears pending
  and schedules a visible retest 10–19 frames later.
- Reuse increments the JS token generation, deliberately rejecting the old
  result. This generation guard is correct; callers discard the pending work
  too early. Same-frame light queries consequently cannot provide their new
  result to that consumption path.
- Original routine called at 0x1003a56e is 0x10029210. Its GetData path calls the
  DX11 context slot +0x74, retries S_FALSE with SwitchToThread/Sleep around
  0x100292e1–0x1002932f, and falls back after 500 ms (cmp 0x1f4). The browser must
  not restore that blocking behavior.

Proposed experiment: retain pending query IDs across frames, consume only ready
results, and conservatively keep lights visible while pending. Add invalidation
for camera/light changes and deletion; bound query age and pool/readback growth.
Separate ready/pending/result in the API rather than turning pending into a final
visible result. Instrument issued/ready/discarded/age and culled lights first.
Use an indoor/night scene with actual queried lights: the terrain baseline has
zero queries, so this is not a demonstrated terrain FPS win.

Boolean query results are NOT a threshold bug: QueryHelper.h converts true to
maximum integer, so `fragments > 4` still works. The port is conservative for
1–4 samples compared with the original sample-count cutoff.

## 2. Shadow reuse

**Existing:** `smapvis` is an incremental invisible-static-caster cache, not a
cache of a rendered shadow texture. It tests a caster, retains invisible visuals,
and marks them to skip future traversal. Light spatial movement invalidates it.

Original 0x1003a540 matches this behavior: tests scheduled frame against
Device+0x18, checks working state/test visual, obtains the query at 0x1003a56e,
appends invisible visuals for zero samples at 0x1003a57b–0x1003a585, advances
otherwise, then enters terminal state after testing the list. The frame renderer
calls it at 0x1001fd2e, in the loop associated with the failed-flush diagnostic.
Current `light_smapvis.cpp` preserves the same conceptual solver.

**Gap:** its next-frame result handling also uses occq_get and can mistake a
late result for visible, permanently advancing the solver past that caster until
invalidation. It requires the same pending-result lifetime fix as path 1;
`testQ_frame == Device.dwFrame` must become a robust readiness/age policy, not
just retaining the ID while keeping the one-frame-only condition.

Local shadow maps are atlas-packed, cleared and redrawn in `r2_R_lights.cpp` /
`r2_rendertarget_phase_smap_S.cpp`. Moving actors, vegetation wind, transparent
casters and atlas placement affect validity. We have not established that the
original generally reuses complete shadow maps for stationary lights. Do not
claim that as a missing original feature.

After query repair, whole-map caching would be a new design requiring explicit
caster/light/atlas generations or separate static/dynamic layers. Lower priority
than retaining the original caster solver. Earlier grass cascade-filter trials
already regressed; do not repeat them without addressing their preparation cost.

## 3. Animated characters

**Existing:** `SkeletonRigid.cpp::CalculateBones` skips when game time matches
UCalc_Time and also respects UCalc_Interval unless exact work is requested.
Bounding-box updates are staggered. `SkeletonAnimated.cpp::UpdateTracks` has a
same-time guard and blends carry frame guards. Recalculating a full skeleton for
every shadow draw is therefore not the default behavior in current source.
Hardware skinning exists for 1–4 weights. Soft skinning caches stream discard ID,
vertex count and offset. The retained appendable-stream optimization already
avoids invalidating that cache merely on every dynamic allocation.

**Concrete candidate:** `SkeletonX.cpp::_Render` still packs three vec4 rows per
bone into a thread-local vector on every hardware-skinned draw, then supplies
that palette through set_ca. The vector retains capacity, so this is repeated
packing/copying, not necessarily an allocation. Main/shadow passes and mesh parts
may share a pose. Existing uniform caching can avoid downstream uploads but
does not remove this C++ packing traversal.

Experiment: count palette pack calls/rows by skeleton and pose revision, then
cache packed palettes across passes with an explicit bone-pose generation.
Invalidate on CalculateBones, manual bone changes/callbacks, visibility changes,
reload and object destruction; a frame number alone is insufficient. Reusing
packed rows does not require changing per-pass shader layouts. A subsequent
shared GPU palette needs separate binding/layout work.

Use NPC-heavy scenes, multiple NPCs sharing a model but different poses, weapons,
ragdolls, HUD and exact bone updates. Do not reduce animation rate as an alleged
quality-preserving optimization. Original skeleton/blend routines were not
confidently identified in this audit; this is a current-source opportunity, not
proof of a regression from the shipped binary.

## 4. Render targets and pass ordering

**Confirmed:** `GPUFrontend.clearNativeTarget` ends the current pass, creates a
standalone clear/store pass and immediately ends it. The next normal draw opens
a load/store pass on its targets. Two consecutive color/depth named clears
produce two passes in the production-method probe. The actual turning interval
contains 8.72 named clear passes/frame within 49.73 total passes/frame.

Experiment: defer full-target clears as pending per-resource/subresource records,
then fold compatible clears into the first attachment use's loadOp. Materialize
before sampling, copies, readback, incompatible subresource/target usage,
deallocation, presentation or other observable access. Keep partial clears
explicit. Preserve independent named-target semantics, depth/stencil aspects,
MSAA resolves and clears of targets not currently bound. Record eligible versus
forced clears: 8.72 is an opportunity ceiling, not a promise to remove them all.

Current color/depth/stencil storeOp is generally store. Selective discard requires
proven last use; blindly changing it breaks later sampling and depth/stencil
consumers. Cross-pass lifetime annotations could enable discard for genuinely
transient attachments, but start with clear folding, not a full frame-graph rewrite.

The original DX11 API has no direct equivalent to WebGPU attachment load/store
contracts. Original dirty binding caches were confirmed in the earlier audit;
there is no demonstrated missing original render-target cache here. This path
is a WebGPU adaptation opportunity, not an instruction to copy DX11 calls.
Earlier per-pass timestamps were invalid; use corrected non-overlapping query
slots before attributing GPU time to these passes.

## 5. Allocation and synchronization

**Existing / original comparison:** original frame-sync polling at
0x1001f89f–0x1001f8f0 also calls GetData, SwitchToThread/Sleep with a 500 ms cap.
Web `r__sync_point.cpp` deliberately submits without waiting. Do not reintroduce
blocking polls: promise completion requires returning to the worker event loop.
The historical `command-context.js` fence implementation is test-reference code,
not evidence of active production GPU waits.

Dynamic buffers already have a bounded reuse pool (64 MB / at most 256 slots per
size class), and retired versions are reclaimed after ordered submission. Do not
add a GPU completion wait merely to recycle buffers: later queue writes already
follow earlier submitted reads. The measured interval had no new stream GPU
buffers or texture allocations, so steady-state churn there is not the next
proven bottleneck. CPU temporary allocations and other GPU allocations are not
covered by those counters.

**Candidates:**

- Track submitted-minus-completed batches/frames and outstanding readbacks along
  with long frames. The port removed the original CPU/GPU pacing point; uncapped
  queuing/backpressure is a plausible tail-latency source, not a proven diagnosis.
  If confirmed, test asynchronous frame-in-flight limits at frame scheduling;
  never block the render worker. Compare input latency and p95/p99, not only FPS.
- `TaskManager::Wait` repeatedly executes/steals work until its dependency ends.
  If no work is found, it retries without parking. Measure useful work versus
  empty polls and dependency duration before adding a bounded yield/notification
  path. An idle-wait fix must preserve progress and avoid lost wakeups.
- The shadow-light path creates a fresh `refactored` vector and reserves each
  invocation, while other queues reuse static capacity. This is a small concrete
  allocation candidate in light-heavy scenes, not a demonstrated hundred-ms
  stall cause. Measure counts/bytes before changing ownership or concurrency.
- Occlusion readback slots grow when all are busy. Measure peak depth and bound
  outstanding readbacks after fixing query lifetime; do not drop required results.

No measured stall cause is assigned to these paths yet. A new stall trace needs
CPU stacks, task wait time, queue depth and memory-growth events correlated to
its actual long frames. Existing stationary p99 regression is still unresolved.

## Recommended order and acceptance

1. Deferred full-target clear folding: applies to the measured terrain scene;
   compare pass count, CPU submission time and correct GPU timestamps.
2. Persistent asynchronous light/caster queries: strongest original-policy gap;
   validate in queried-light scenes, camera transitions and light destruction.
3. Packed bone palette reuse: measure in NPC-heavy scenes before implementation.
4. Frame queue/task-wait instrumentation: target p95/p99 and input responsiveness.
5. General shadow-map caching / attachment discard only after lifecycle evidence.

For every experiment preserve settings, keep a separate headless profile and
reuse retained baselines when comparable. Require unchanged rendering and
correct reset/growth/deletion handling. Do not infer FPS gains from avoided calls
alone. Native Windows frame captures remain necessary to claim quantitative
original-engine versus browser parity.

## Experiments completed — 2026-11-10

Acceptance includes less work at essentially unchanged throughput. Tests used an
isolated headless Chrome profile, optimized `web-release`, 1920×1080,
extreme grass (density 0.1, radius 300, height 2), grass shadows enabled, VSync off.
The existing retained grass-reuse baseline was reused rather than rerunning a
control. Live weather/simulation and tail spikes limit conclusions from one run.

| Candidate | Decision / evidence |
|---|---|
| Visibility queries | Retain asynchronous pending results rather than immediately recycle an unread query. Camera/light changes invalidate results; delayed hidden-light results fall back to visible. No GPU-thread blocking added. |
| Shadow caster visibility reuse | Keep the original incremental invisible-caster solver's pending query until ready, so its existing cache can advance. Cancel on invalidation/timeout and reject queries from a destroyed renderer generation. This is **not** caching whole shadow maps. |
| Bone palette packing | Retain bounded per-thread matrix/packed-row cache. Compare actual matrices, including same-frame changes, before reusing three packed rows per bone. Still reads and compares matrices and still uses existing uniform upload rules. |
| Render-target clears | Retain deferred clear folding into the next matching attachment pass. Drain on sampling, cached material use, copy/readback, upload, deletion and submit. Exactly three standalone passes removed per measured terrain frame. |
| Allocation / synchronization | Retain shadow-light sorting scratch capacity. Production sorting-block allocation probe: 100 allocations before versus 0 after across 100 warmed invocations, identical ordering. Reject bounded task sleeping: turning throughput fell to 107 FPS. TaskManager source restored; no new wait/pacing policy retained. |

### Measured terrain results

| Run | Stationary FPS | Turning FPS | Stationary p99 ms | Turning p99 ms |
|---|---:|---:|---:|---:|
| Previous retained baseline | 158.36 | 120.74 | 62.97 | 15.33 |
| Retained candidates | 158.93 | 118.35 | 70.60 | 16.39 |
| Rejected task parking variant | 155.25 | 107.30 | 44.56 | 19.55 |

Stationary throughput +0.4%, turning -2.0%: **no demonstrated FPS improvement**.
The retained work reductions are the justification, not a claim that these
changes solve long-frame stalls. Final stationary median 4.035 ms, turning
8.215 ms. Final average render passes/frame 34.55 stationary and 47.36 turning;
three clears folded per frame in each interval. No GPU validation errors.

A subsequent Skadovsk interior/light-heavy exercise processed asynchronous
results and animated palettes. In the retained log interval the query completion
counter advanced 16,756 → 23,983 (pending polls 110,464 → 166,336; these are polls,
not simultaneous outstanding queries). Packed bones advanced 3,133,277 →
4,850,974 and reused bones 4,977,668 → 8,603,598: **67.9% of packing operations
avoided** in that interval. This is not a matched scene FPS comparison, and the
screenshot does not establish a close-up NPC animation correctness comparison.
The scenario script reloaded its local phase, so it teleported to Skadovsk twice
and advanced time twice; do not describe it as a verified nearest-NPC/night test.
The interior completed with zero GPU validation errors.

### Validation and artifacts

- Optimized WASM build; 97 tests pass (96 passed in the final full-suite run,
  and the new sorting test passed after correcting its fixture; the query tests
  were rerun with it). Production C++ query/palette/sorting probes and renderer
  JavaScript tests. Query tests cover delayed results, explicit cancellation,
  timeout and renderer generation changes.
- Actual GPU clear/readback fixture: five cases / 1,280 bytes checked (folded
  color, copy, sample, submit and repeated clear). Unit tests additionally cover
  depth/stencil and mismatched mip behavior.
- Research artifacts: workspace `mechanics-test/five-path-results/` contains
  `all.json`, `parked.json`, `final.json`, screenshots and `npc-night.json`
  (historical filename; see scenario limitation above).
- `-web_work_audit` enables cumulative query and bone packing counters; disabled
  by default. Final run used the flag. The final generation/reset guard was added
  after the live run and verified by compiled regression tests and rebuild.
- No changes to production deployment or the user's local 8132 test server.

### Remaining experiments, not shipped claims

Full shadow-map texture reuse, attachment discard/store elimination, GPU
frame-in-flight limits and bounded readback growth remain unimplemented: current
experiments do not establish safe resource lifetimes or show those are the
bottleneck. A native Windows frame capture is still needed for original-versus-
browser quantitative parity. Broader light transition/reset and NPC visual checks
remain manual validation, not evidence inferred from zero GPU errors.
