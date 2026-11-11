# Browser JavaScript and WASM boundaries — 2026-11-11

The review measured the preceding release at 71 JavaScript modules, 721,537 raw
bytes (about 220 KB with separate gzip). File count alone was not a major
bandwidth cost compared with the engine and game assets. The current cleanup
removes unused network/replication modules and the prediction WASM sidecar;
the new manifest contains 46 JS modules / 539,176 raw bytes. The measured release
is about 909 KB smaller overall, including the smaller engine and removed sidecar.

## Priorities

1. Audit worker initialization. Source inspection found the backend initialization
   path invoked in every prewarmed pthread, including GPU adapter/device requests.
   Verify live device counts before restricting initialization to the canvas-owning
   thread. Avoid breaking worker callbacks that legitimately share browser bridges.
2. Minify shipped modules. A trial suggested about 44 KB additional gzip savings
   on the preceding release; actual savings must be remeasured after cleanup.
   Bundle selectively: large bundles invalidate more cached content on updates.
3. Profile uniform packing and remaining upload commands before moving work into
   native code. Shared-memory draw/state batching already removes many crossings;
   fewer calls do not by themselves prove a frame-time improvement.

Keep browser API orchestration and GPU handle ownership in JavaScript. Moving
these wholesale to WASM still requires host calls and may introduce marshaling.
Use WASM for measured bulk numeric work, with one batched operation rather than
small bidirectional calls per draw. Record startup time/memory separately from
steady-state frame-time and CPU/GPU timing before deciding to retain a change.

This is a source-based review, not a measured live GPU-device count or a promise
of improved FPS. No renderer/worker initialization changes were made by the review.
