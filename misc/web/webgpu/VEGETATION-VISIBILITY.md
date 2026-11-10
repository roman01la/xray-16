# Vegetation experiment — reverted

Reverted at the user's request on 2026-11-09 because the experiment did not
improve measured performance. GPU visibility/compaction, Hi-Z, deferred detail
submission, adaptive sampling and the experimental mesh-LOD generator have
been removed, including their dependency and runtime switches.

The compact slot-upload improvement is retained. It uses the original detail
meshes and direct instanced draws; density, draw distance and shadows remain
at the selected settings. The previous optimized Release measurements were
approximately 158 FPS stationary and 106 FPS during a camera turn at 1080p
with extreme grass. These are scene-specific measurements, not an FPS guarantee.

The experimental paths measured roughly 104–115 FPS in the same saved scene.
Batching and coarser visibility checks reduced some submission work but did
not recover the lost GPU time. The tested stock meshes produced no reductions
under the conservative LOD error limit. No experimental version was deployed
to production.

The revert passed 35 renderer/storage/native-queue tests. Original measurement
artifacts remain in `mechanics-test/vegetation-results-20261109` beside the
repository for reference. Do not use the experimental captures as evidence of
an enabled performance improvement.
