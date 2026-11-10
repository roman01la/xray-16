# JS/Wasm boundary submission

The November 10 investigation found approximately 1.3–1.5 JS-to-Wasm calls
per frame; the larger traffic was in the other direction. In the profiled
dense-grass checkpoint, Wasm-to-JS traffic was approximately 607 calls per
stationary frame and 741 while turning. Most were detailed grass timing
reads, followed by direct grass submissions and buffer uploads.

Grass now uses the same ordered shared-memory draw queue as other geometry.
The record is 16 words: the existing 14 fields, then an instance-buffer
handle and instance count (zero handle / one instance for ordinary draws).
Upload, deletion, query and render-target boundaries still drain pending
records before mutating resources. Both the engine and JavaScript must ship
together because this changes the internal record format.

Detailed grass clocks run only when explicit CPU or phase profiling is
active. A registered heap flag conveys enablement without a per-frame JS
call; its callback obtains the current heap view after memory growth.
The ordinary diagnostics graph still receives overall engine timings.
Detail submission timing now measures native enqueue work; use overall
render time to compare performance, since queue replay happens later.

Validation: optimized Release build, 37 renderer/storage/queue tests, and a
real WebGPU fixture checking 1,300 pixels across storage mutation/growth
and 22 packaged grass shader variants. The fixture can exercise queued
submission via its fourth argument. No gameplay, grass density, draw
distance, shadow coverage or mesh simplification changes are involved.

Buffer-upload batching remains a separate investigation. A lower crossing
count alone is not evidence of improved FPS.

The uninstrumented optimized release measured 158.5 FPS stationary (5.05 ms
CPU render) and 102.8 FPS while turning (8.12 ms CPU render), at 1080p in
the existing extreme-grass checkpoint. Previous results were approximately
158/106 FPS. This does not establish an FPS improvement. Zero WebGPU
validation errors were reported. Results are retained beside the repository
in `mechanics-test/boundary-batch-results-20261110`.

Instrumented verification with detailed profiling off measured 154.4
Wasm-to-JS calls/frame stationary and 201.1 while turning, compared with
606.7/741.0 in the original capture (whose grass clocks ran unconditionally).
The high-resolution timer imports dropped to exactly 5/frame, and direct
grass submission imports disappeared. Enabling explicit profiling restored
the detailed grass measurements. Call-count runs are not used for FPS results.
The verified local release on port 8132 is
`9522fbcd36e0ded50db359638782837a9cb0bd89c39b57dce74075cf1959ccd5`.
Production was not updated.
