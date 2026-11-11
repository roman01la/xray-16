# Incremental grass output updates — 2026-11-11

## Finding and change

The existing persistent source records only uploaded changed slots, but a change
to any slot caused compute expansion of the entire batch's vertex output. Stable
visibility membership was therefore still rebuilding hundreds of thousands of
records per frame for a few thousand modified records.

Native submission now sends dirty source/destination ranges when the exact ordered
membership, allocation and count signature is unchanged. WebGPU patches those
ranges into the existing complete output. Membership/allocation/count changes use
the existing full rebuild. No density, distance, wind, LOD, shader or shadow quality
settings change. GPU output remains contiguous vertex input; this does not restore
the previously reverted vertex storage-fetch or global visibility experiments.

Partial updates require a complete, sufficiently large output with the same total
count. Source bounds, ordered non-overlapping destination ranges and output bounds
are validated. Existing submission barriers protect earlier users of range/source
buffers; changed range buffers and uniform slices retain their lifetime guarantees.

## Evidence

Optimized release build, 1920×1080, density 0.1, radius 300, height 2, grass shadows
on. Same private forest view as the grass cost investigation. Initial separate
runs slowed overall, so they do not demonstrate a regression or gain against the
earlier 90–100 FPS baseline. A private same-session full-gather override isolates
the gathering change without rebuilding/reloading. It is not in production code.

| Alternating mode | Frame time | FPS | Expanded records/frame |
| --- | ---: | ---: | ---: |
| Partial | 12.58 ms | 79.50 | 1,465 |
| Full | 13.04 ms | 76.68 | 284,309 |
| Partial | 13.03 ms | 76.75 | 2,364 |
| Full | 13.24 ms | 75.54 | 295,112 |

Mean frame-time improvement is 0.34 ms (2.6%) in this short comparison; run-to-run
drift prevents a strong general FPS claim. The robust work reduction is 99.3%
fewer expanded records. Partial range metadata adds about 3–5 KB/frame. All four
intervals submit exactly 124 detail draws / 1,674,628 instances per frame summed
across passes. This is not a count of unique visible plants.

104 unit/compiled-helper tests passed. The real-GPU fixture checks 371,168 floats
across seven readbacks, including patches crossing 1,024-record windows and
successive disjoint patches. Optimized build succeeded. Dense outdoor on/off/on
captures reported no GPU validation errors, and visual inspection found no obvious
missing grass. A four-direction camera-turn run exercised membership changes with zero GPU
validation errors; the inspected final view retained dense grass. Broad walking/reset/travel checks remain in GRAPHICS-MANUAL-TESTS.md.

Evidence: workspace mechanics-test/grass-partial-results and grass-partial-stage;
original measurements: mechanics-test/grass-cost. No deployment in this task.

## Remaining cost and next experiments

This is a useful work reduction, not the solution to the entire 5–6 ms grass cost.
Native preparation still scans each visible list for dirty records and again for
signatures; visibility/HOM work remains. Next investigate combining these scans
without missing source allocation changes during uploads.

Grass is also submitted in main and shadow passes. Shadow rendering calls the same
Details::Render path with a shadow transform, retaining the camera-derived instance
lists. Conservative filtering against each light's caster volume is a promising
next experiment; camera-only or distance-only shadow culling is not safe. Measure
pass GPU timing before changing it. Alpha-tested pixel overdraw is another remaining
candidate; a depth prepass can add more work than it saves and needs measurement.

## Preparation follow-up

The second full visible-list traversal has been removed from production submission.
The upload scan now compares exact identity/allocation/count entries; only dirty
slots are revisited after upload, since upload may allocate or relocate their GPU
ranges. The current batch's other visible source allocations are protected from
eviction by DetailStorage.upload. Unchanged signature entries are not rewritten.
Total instance count is accumulated by the existing destination-offset scan.

The JavaScript upload path also reuses one growable unshared staging allocation
instead of allocating an ArrayBuffer per modified slot. writeBuffer snapshots
its input synchronously, so later reuse cannot modify already queued writes.
The necessary copy out of shared Wasm memory is retained.

Reference-view preparation measured 1.82 ms/frame versus 2.13 ms in the preceding
partial-gather build capture (about 0.31 ms lower). These are separate runs with
noticeable overall timing variation, not a controlled causal estimate or an FPS
claim. The reference view still submitted 124 draws / 1,674,628 instances per frame.
A second, turned view was checked for rendering correctness and GPU errors; its
performance data is excluded because the test runner overlapped that capture.

105 tests passed, including 2,000 randomized signature/allocation transition rounds
and staging snapshot/growth checks. Optimized build and real-GPU gather fixture
passed. Both views reported zero GPU validation errors; the turned screenshot
showed no obvious missing vegetation. Artifacts: mechanics-test/grass-prep-results.

Future preparation work: producer-side dirty/membership generations could avoid
scanning unchanged batches altogether, but must account for GPU eviction/reset and
synchronization with the visibility task. This is not implemented. Visibility and
shadow rendering behavior remain unchanged. These follow-up changes are local.
