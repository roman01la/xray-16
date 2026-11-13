# Autonomous game profiling

Use this harness for repeatable performance investigations in CoP, SoC and Clear
Sky. It starts an isolated headless Chrome process, restores a checkpoint,
loads the actual game, measures ordinary frame times, then records CPU profiles
and Chrome's GPU trace. It closes Chrome on success, failure or interruption.

The trace uses Chrome DevTools Protocol `Tracing`, the recording engine behind
`chrome://tracing`. Both page and worker CPU profiles are collected. Nested
workers are attached automatically. Hardware information, effective settings,
engine hash, scene screenshots, logs and raw results stay beside the capture.

## Start a local release

Existing local game servers work. For an immutable publication, serve its static
assets and the original local pack chunks with

```sh
node misc/web/perf/serve.mjs \
  --assets /path/to/staged-assets \
  --publication /path/to/cop-publication \
  --publication /path/to/soc-publication \
  --publication /path/to/cs-publication \
  --port 8396
```

Use the selected game's full `/releases/HASH/index.html?stream=/packs/HASH/pack.json`
URL from its publication manifest. A direct development URL works too. The root
game-selection page is outside the benchmark route.

## Capture a baseline

```sh
node misc/web/perf/run.mjs \
  --url 'http://127.0.0.1:8396/releases/HASH/index.html?stream=/packs/HASH/pack.json' \
  --game cop \
  --checkpoint /path/to/checkpoint.json \
  --scenario /path/to/scenario.json \
  --profile ../perf-profile \
  --output ../perf/baseline \
  --symbols /path/to/matching/xr_3da.js.symbols
```

`--game` accepts `cop`, `soc` or `cs`. A checkpoint is the existing private harness
format containing `config` (user.ltx text) and `save` (base64 save bytes).
Alternatively use `--save checkpoint.scop --config user.ltx`. SoC uses `.sav`,
while CoP and CS use `.scop`. Fixtures must belong to the selected
game. They stay outside Git and are never uploaded.

`--new-game` starts a new game and exports a reusable `checkpoint.json` after
setup. `--saved-slot NAME` reads that slot from the harness-owned profile and
exports it as a checkpoint. These modes are alternatives to `--checkpoint`
and `--save`. `--config` can override the configuration for a checkpoint.

`--profile` must be empty on its first run. The harness marks it as its own and
reuses it later, retaining installed data and shaders. It refuses unrelated
Chrome profiles and locks out a second run using the same profile. To reset this
cache, delete that dedicated directory while the harness is stopped. Its disk
usage includes the downloaded game. Reuse it across experiments.

Example scenario

```json
{
  "game": "cop",
  "viewport": {"width": 1920, "height": 1080},
  "setupLua": "db.actor:set_actor_direction(3.14159265)\nlevel.set_time_factor(0)",
  "settings": ["r__detail_density 0.1", "r__detail_radius 300"]
}
```

The harness restores the actor's initial position before each interval and runs
`setupLua`. Choose a fixed camera direction explicitly. Game simulation and NPCs
continue unless the scenario changes them. Keeping game time fixed only fixes
weather/time-of-day progression. A scenario can hold a key throughout each
interval using an `action` object

```json
{"type":"holdKey","key":"ArrowRight","code":"ArrowRight","keyCode":39}
```

For movement routes, make `setupLua` restore position and heading to the same
starting point. Add scenarios for dense vegetation, NPC-heavy areas, indoor
combat and transitions as an investigation requires them.

Defaults are three 15-second benchmark windows, 10-second warmup and a separate
15-second trace. Adjust with `--repeats`, `--duration`, `--warmup` and `--trace`.
The harness disables VSync and sets the existing 501 FPS limit for workload
measurements. Use `--keep-cap` for player-facing capped-frame pacing tests.
Screenshots and `effective-settings.ltx` allow those conditions to be checked.
`--engine-args=-no_grass_shadow_filter` measures the shared filter disabled.
`--verify-grass-filter` also runs its real-GPU correctness fixture after the
ordinary measurements. Shadow indirect-argument counts and filter state are
saved with the run when available.
A software GPU fails the capture. Actual canvas dimensions must match the
requested viewport.

Every individual entry in the scenario's `settings` array is checked against
the configuration saved by the running engine. The preset label itself is
excluded because changing individual settings can relabel it as Default.
Distinguish maximum settings exposed by a game's menu from additional
console-only renderer features, and record both explicitly.

Use the symbols from the exact Wasm build. A neighboring `xr_3da.wasm` is checked
against the loaded engine hash. `--symbols-wasm` can specify another path. Omit
symbols when unavailable and keep the raw Wasm function indices. Do not apply
symbols from a different build.

## Analyze and improve

The run writes `report.json` automatically. Reanalyze or compare with

```sh
node misc/web/perf/analyze.mjs ../perf/baseline
node misc/web/perf/analyze.mjs ../perf/baseline ../perf/candidate
```

1. Verify the scene screenshots, render dimensions, settings, hardware GPU and
   absence of crashes/validation errors.
2. Read untraced FPS, median/p95/p99 frame times and per-frame work counters.
3. Inspect page/worker sampled CPU self time and call-tree inclusive time. Use
   `trace.json.gz` in Chrome tracing or Perfetto to inspect scheduling, GPU/Dawn
   events and stalls. Individual `.cpuprofile.json` files include target metadata
   and a standard `profile` object.
4. Choose a specific expensive path and make a focused change. Build the
   optimized candidate and publish it to a separate local staging directory.
5. Run the same checkpoint, scenario, browser, dimensions and warm cache against
   the candidate. The comparison rejects mismatched conditions. A valid saved
   baseline can be reused without disabling the new code for another control.
6. Check screenshots and additional affected scenes before keeping the change.
   Retain changes that measurably reduce work even when FPS is unchanged, and
   record the actual outcome without attributing unrelated run-to-run variation.

Detailed renderer timers and CPU/GPU tracing run after ordinary benchmarks.
Their overhead is excluded from headline FPS comparisons. CPU inclusive samples
can overlap each other and parallel worker work. Chrome trace spans can include
waiting and scheduling. GPU events can describe CPU-side submission. The
renderer's timestamp-query span includes gaps between GPU submissions. These
measurements must be interpreted together rather than added into one frame budget.

An isolated pass-timestamp probe also records raw GPU query values. Empty
passes can leave unwritten timestamps on Metal and are excluded from the
summary. Valid pass intervals can overlap substantially on this backend, so
their sums cannot establish exclusive GPU execution time. Use matched feature
isolation runs, upload/draw counts and native frame spans alongside them.

Finish each capture and close its browser before analysis, builds or edits.
The command's cleanup runs before report generation. Do not keep a game
rendering in the background during other work.

Repeated windows report their FPS range. Large drift calls for another controlled
capture after checking load and power conditions. The harness records available
hardware information but cannot guarantee stable temperature or exclusive access
to the machine.

Cloud save, analytics and crash-report requests are blocked in the isolated test
browser. Personal profiles and saves are untouched. Installation, shader warmup
and engine startup happen before measurement. The harness makes no deployment
or source changes itself.

## Checks

```sh
node --test misc/web/perf/analyze.test.mjs
```


`--engine-args=-web_detail_audit` enables periodic byte comparisons between
native grass records and gathered GPU output. It creates readback stalls, so
use separate runs for correctness and performance. Audit state and persistent
record/range byte counters are recorded in `run.json`.

For regression runs, `bindings` can add private console-key bindings to the
fixture configuration. `validationSteps` runs those keys after the measured
capture, waits for a new matching engine log line, allows `settleMs`, checks
GPU audit errors and takes a screenshot. Each step contains `label`, `key`,
`code`, `keyCode` and `waitForLog`. An optional `rendererExpression` configures
an explicit stress condition in the isolated renderer. Use native key names
such as `kPGUP` and avoid keys assigned to save/load actions.


`--queue-probe` records queue write/submit counts, bytes and synchronous call
durations during the traced interval only. Calls longer than 5 ms include their
stack, up to 200 entries. Results are stored in `run.json` under `queueProbe`.
This instrumentation runs after ordinary FPS windows and is absent from shipped
runtime bundles.


For private same-session experiments, a scenario can provide `benchmarkVariants`
with `label` and `rendererExpression` fields. The harness cycles these local
JavaScript expressions before successive benchmark windows and then records a
separate short detailed-timing interval for each variant. This timing interval
is excluded from that window's ordinary FPS results. Inspect the labeled
`run.json` entries individually; the combined report aggregates all variants.
Private alternate renderer implementations must be staged separately from the
normal release.
