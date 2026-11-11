# Grass density reset: detail calculation task lifetime

The reported worker trap happened after pausing, changing grass density and
resuming. The archived optimized release
`94dddce88ca36f7dcdec8a2b12fc4384b509e437ea39bbf2b41a6656fdd9e415`
contains the exact matching function boundaries and symbols:

| WASM offset | Function |
| --- | --- |
| `0x133712` | `CDetailManager::cache_Decompress` (function 2378) |
| `0xc6e96a`, `0xc6e747` | `DispatchMTCalc` task dispatcher (function 36344) |
| `0x633c05` | `TaskManager::ExecuteOneTask` |
| `0xc6cc0b` | `TaskManager::TaskWorkerStart` |
| `0x40ec07` | worker thread entry wrapper |

At the faulting instruction, decompression loads the next pointer from the
`poolSI.create()` free list. This is CPU cache construction, before WebGPU draw
submission.

`DispatchMTCalc` captured the manager's `this` and replaced its saved task handle
on every dispatch. It only joined that task when details were rendered. A skipped
render frame could therefore leave a task running when the next calculation
started. Both tasks mutate the same non-thread-safe slot-item pool. A density,
height or radius reset also unloaded and deleted the manager without joining the
calculation, freeing its models, mapped detail data and caches beneath the worker.
The worker's check of the global `Details` pointer did not protect the captured
manager: the task could already be executing, or the global could identify a new
manager by the time it ran.

The owner now joins and retires the previous calculation before redispatch,
unload and destruction. Rendering checks for a task before waiting, including
when details are disabled; concurrent render passes only read/wait on the handle.
Only the owner clears it. Eligibility checks happen before dispatch, and the
unsafe global-pointer lifetime check has been removed. Grass generation and
instancing algorithms are unchanged.

## Validation

- Optimized `web-release` build passed, including final relink after
  keeping render-pass waits read-only.
- Eight detail cache, instancing and storage regressions passed.
- Isolated headless Chrome exercises alternate density `0.6` and `0.1`, each
  through `main_menu on`, `vid_restart`, and `main_menu off`, on a loaded Zaton
  single-player checkpoint. This changes settings through the actual console
  commands used by the engine, not mocked renderer resources.
- Preliminary fixed-interval input runs produced no captured exceptions but
  dropped commands while resets were busy and initially retained the stock
  press-any-key loading screen. They are not counted as completed-reset evidence.
  The final harness disables only that startup key prompt in its disposable
  config, waits for each successfully loaded config acknowledgement plus 30
  subsequent frames, and waits ten seconds after the final reset. Its result and
  local publication are recorded below when complete.

Manual coverage remains: changing settings through the actual options widgets,
long paused intervals, detail radius/height changes, disabling and re-enabling
grass, save/load and level travel and other browsers/GPUs. The
headless stress run does not establish those untested cases.

## Completed validation and local publication

The final run completed all 16 acknowledged resets (8 sparse, 8 dense). Every
reset was followed by at least 30 rendered frames; after the last reset the
counter continued through 2514, 2607 and 2694 during the settling interval. The
final screenshot visibly shows resumed gameplay and terrain. There were zero
captured runtime exceptions and zero WebGPU validation errors. The 87 FPS final
sample is a liveness observation, not a controlled performance comparison.

Evidence and exact optimized artifacts/symbols are archived at
`../mechanics-test/grass-reset-release._jxql67v/`: `reset-test.mjs`,
`reset-browser.log`, `reset-result.json`, `reset-before.png`, `reset-final.png`,
`renderer-tests.log`, `build.log`, and `publish-verification.log`.

Local preview `http://localhost:8132/` and `http://127.0.0.1:8132/` now serve release
`d02651c67b48a2d522315fc54cd74056608aa09606dcedaaf17621ce5a03464c`.
WASM SHA-256:
`a87cca32d959ef16d6f883740ac5b29493d8e39adf5bf18fbb3e40338400f507`.
Publication verified all 2177 content blobs, uploaded only the two changed engine
blobs, and checked served WASM/JavaScript/engine-manifest hashes on both origins.
The isolated test Chrome and port 8142 server were closed. Production was not
changed. Reload the local page before manual options-menu retesting.
