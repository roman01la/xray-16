# STALKER browser survival multiplayer implementation plan

Build an open-world survival mode in the STALKER world with PvP, PvE, safe zones,
persistent characters and custom survival mechanics. Target 100–200 players per
server, including crowded encounters. Rust owns gameplay simulation; browsers
connect using unordered WebRTC state channels with zero retransmits and a
separate reliable control channel.

The current delivery target is a working multiplayer foundation, independently
of the concrete survival mechanics the user will specify later. The existing
weapon, safe zone, death/respawn and stationary NPC are integration fixtures.
They demonstrate authority and presentation; they do not define final game rules.

## Constraints

- Preserve the existing single-player browser port, renderer, local AI, launch
  behavior and saves. Multiplayer must be explicit and separately staged.
- Multiplayer state must never write to single-player save storage. Share only
  immutable asset data. Runtime settings and saves require separate namespaces.
- Use community implementations as concrete references, with exact revisions
  and reasons for adopting or rejecting their assumptions recorded in README.md.
  Revisit the relevant community implementation at subsystem boundaries and when
  integration failures expose a design assumption; record revision, decision and
  the local validation needed. A reference is guidance, not acceptance evidence.
- Never give client and server simultaneous gameplay authority over an entity.
- Measure optimized builds. Existing benchmark results serve as baselines;
  do not rerun disabled-feature controls without a specific need.
- A passing synthetic test is not completion of an engine integration milestone.

## Milestones and acceptance gates

| Milestone | Work | Acceptance gate | Status |
|---|---|---|---|
| 1. Ownership and integration contract | Define authority, identity, versioning, coordinates, mode separation, engine interface and community hook mapping | Contract documented; incompatible sessions fail closed; mode/bridge tests pass | Complete |
| 2. Two players in a CoP level | Separate entry/build; main-thread WebRTC to engine-worker bridge; remote actor lifecycle, transforms, stance/animation and interpolation | Two browsers join Zaton, see each other move, and remove disconnected actors without affecting single player | Rendering, stance and lifecycle gates passed |
| 3. Authoritative movement | Collision export; server character movement; shared movement rules; prediction and reconciliation; terrain/stairs/crouch/jump | Movement behaves correctly under latency/loss and the server rejects impossible movement | Live map motor, shared WASM prediction and stance implemented; application delay/loss combat route passed; broad traversal and real WAN gates open |
| 4. Replication performance | Acknowledged deltas; reliable lifecycle metadata; distance tiers; quantization; byte budgets and metrics | Sustained 100–200-client tests in spread/crowded scenes meet documented CPU, bandwidth and freshness budgets | Deltas, tiers, budgets and metadata implemented; persistent 200-peer spread and ten-minute crowded transfer runs passed; actual WAN gate open |
| 5. PvP slice | Weapon/equipment state; server shot validation and lag compensation; damage, death, corpses, respawn and verified safe-zone geometry | Consistent combat outcomes across clients, including adversarial inputs and safe-zone boundaries | Integration fixture passed, including application delay/loss; concrete PvP/equipment mechanics deferred |
| 6. Persistence foundation; survival mechanics later | Stable identity, durable ownership, atomic mutations, replay protection and crash recovery; concrete inventory/loot/survival rules deferred | Authorized test state survives reconnect/restart; concurrent/replayed mutations cannot duplicate ownership | Stable identity, durable records and generic entity ownership/transfers implemented; bounded browser recovery, live invalidation and consistent owned-state reconciliation implemented; trusted scene materialization, live policy and rendered transfer/restart/AOI gates passed |
| 7. Operations foundation; PvE later | Access control, deployment, monitoring, backups and recovery; concrete NPC behavior deferred | Reproducible deployment, backup/restore and prolonged load/recovery gates pass | Backup/restore, graceful shutdown, credential lifecycle, Linux container recovery and local soak passed; target-host/WAN gates open; PvE deferred |

Performance and single-player regression checks run throughout, not only in
milestone 4. If integration exposes a necessary prerequisite, record it here and
implement it before proceeding to dependent gameplay work.

## Current checkpoint (2026-11-07, integrated foundation acceptance)

The persistent database-to-world-to-rendered-scene path is now implemented and
verified in two optimized Zaton engine clients. A trusted descriptor becomes one
server-owned proxy with a stable persistent ID and a transient network ID.
Ownership remains separate from visibility. Client-owned JSON never creates actors.

| Foundation area | Current evidence | Remaining acceptance |
|---|---|---|
| Mode separation | Separate entry/build/storage; production SP JS/WASM checksum unchanged | Continue regression checks as mechanics are added |
| Persistent scene integration | Both engines rendered one shared persistent fixture; transfer retained visibility; AOI exit/re-entry, unpublish/republish and process restart recovered without duplicates | New presentation classes await mechanics |
| Generic action policy | Transactional ownership/revision checks plus expiring simulation-issued principal/session/world context; retry after missing context and replay after expiry tested | Distance, safe-zone and game-specific policies await specifications |
| Identity/access lifecycle | Admin revoke/rotate; durable auth epoch disconnects persistent sessions; queued admissions cannot cross observed revocation | Production accounts and remote deployment policy |
| Durable recovery | Online backup/restore, ownership/replay recovery, browser outbox and coherent owned views | Backup schedule/retention on actual host |
| Operations | Bounded worker metrics, health, single-server database lock, graceful SIGTERM and configuration/runbook | Systemd installation on the target host and actual WAN acceptance |
| Capacity and movement | 200-peer persistent crowded soak and spread/transfer test passed; 25-route native/WASM terrain parity passed | Real WAN, longer endurance and special traversal coverage |

Concrete PvP/PvE, inventory/equipment UX, loot and survival mechanics remain
deferred. Existing combat/NPC behavior and persistent actors are integration
fixtures. Dynamic doors/props, moving platforms, player collision and water
behavior are not implemented by the static capsule controller; these cannot be
claimed as covered by terrain or synthetic stair tests.

The remote-network gate requires a reachable host and an independent client
network. No remote target has been supplied. Loopback and application impairment
results must not be relabeled WAN evidence. Deployment templates are reviewable
source, not a claim that a production service is deployed.

The previous 200-peer result predates persistence and remains only a baseline.
Current tests use the optimized server and existing separately optimized engine.
No disabled-feature control benchmark is required. The source checkpoint includes the implementation, tests, runbooks and acceptance
records, excluding private assets and databases.

## Existing foundation

Completed before this plan: independent Rust 30 Hz synthetic world, 15 Hz full
snapshots with spatial filtering, server movement/damage/safe-zone rules, browser
WebRTC client and a separate test harness. Nine Rust tests, seven browser-protocol
tests and 48 existing renderer/storage tests passed.

Release-build two-peer integration passed. A short 200-peer loopback test reached
29.62 ticks/s with all peers receiving fresh snapshots, but skipped 5,472 snapshot
sends under backpressure and used 19.09 MiB/s server UDP payload egress. This is a
baseline, not evidence that production 200-player gameplay is ready. Full
snapshots need replacement before dense scenes scale. See README.md for details.

## Execution order

1. Finish the ownership contract and enforce world/protocol compatibility.
2. Establish a bounded browser-to-engine bridge with deterministic tests.
3. Add the opt-in, separately staged multiplayer browser entry and verify storage
   isolation before enabling it to boot an engine.
4. Add a separately compiled engine adapter, map load and remote actor presenter.
5. Validate two real engine clients before declaring milestone 2 complete.
6. Follow the current foundation priorities above across milestones 3–7; defer
   concrete mechanics until specified by the user and update acceptance evidence.

## Execution log

- 2026-11-07: Plan saved. Confirmed the current browser build links stub networking
  under `src/xrNetServer/empty/`; the Rust protocol is not an X-Ray session protocol.
  Integration requires an explicit adapter and mode boundary, not just a socket
  replacement. Existing single-player uses local direct-connect simulation.

- 2026-11-07: Milestone 1 completed. Added ARCHITECTURE.md and a shared strict
  contract checked at signaling, welcome and worker attachment. The Rust server
  rejects a Zaton contract against the synthetic world before joining.
- 2026-11-07: Milestone 2 started. Implemented a bounded MessagePort bridge with
  one in-flight plus one latest pending snapshot/input, session epochs, action
  results and disconnect cleanup. Real Chrome worker verification passed: after
  a one-second pause, snapshot tick advanced from 372 to 402 without replaying
  the intermediate backlog; worker input moved the server player 0.80 m; reliable
  action rejection returned through both bridge directions.
- 2026-11-07: Added separately generated multiplayer filesystem configuration
  and tests verifying that preparation never opens single-player save/config
  files for writing. This helper is not yet wired into a game launcher.
- 2026-11-07: Added the opt-in `web-multiplayer-release` preset and isolated engine
  artifact staging. Capability metadata explicitly says `actorAdapter: false`.
  Normal single-player launch modules and deployed engine JS/WASM remain unchanged.
- Validation: 11 Rust tests, Clippy with warnings denied, 65 JavaScript tests
  including existing renderer/storage regressions, optimized server build, real
  browser worker test and existing two-peer integration scenario passed.

## Next executable checkpoint

The opt-in map server now uses validated Zaton geometry/materials and original
world coordinates. Shared Rust/WASM movement predicts the local presentation;
crouch, jump, landing and delta membership lifecycle have passed live browser
checks. Continue milestone 4 transport load/budget work, then reliable entity
metadata and the weapon slice. Broader movement acceptance (actual stairs,
doors, water, moving objects and WAN impairment) remains open.

The log below is chronological; earlier limitations describe those checkpoints,
not the current implementation.

- Build isolation verification: both CMake configurations succeeded. Generated
  Ninja commands place experimental JS/WASM only inside its build tree and omit
  the single-player packager; the default build retains its original paths.
  Existing deployed JS/WASM SHA-256 hashes match their pre-change values. This
  verifies configuration and staging commands, not a compiled C++ actor adapter.
  Experimental configuration reused the working build's cached LZO/Theora/Lua
  sources to avoid redundant downloads.

- 2026-11-07: Added the experimental C++ frame-boundary snapshot adapter, gated
  by `XRAY_WEB_MULTIPLAYER`. Its portable parser atomically validates complete
  frames, finite floats, unique entity IDs, local-player identity, and wrapping
  tick order. Disconnect clears the registry; no native gameplay actors are
  spawned. Both affected optimized wasm64 unity objects compiled successfully.
- Added the worker-to-WASM binary writer and dormant pthread attachment helper.
  Only the pthread executing the C++ frame hook claims the session; prewarmed
  pool workers remain inactive. A second claimant is rejected without closing
  the first session. Loader/staging attachment is still pending.
- Cross-language tests compile the actual C++ parser with AddressSanitizer and
  UndefinedBehaviorSanitizer and feed JavaScript-produced frames, including
  tick wraparound, duplicate IDs, truncation, non-finite coordinates and despawn.
  This validates the boundary, not map rendering or two-client gameplay.
- Follow-up validation: full optimized experimental engine linked and staged
  successfully (21 MiB WASM), with the frame hook present in generated JS. The
  production deployed JS/WASM checksums remain unchanged. An additional `-O3`
  wasm64 executable using the same parser passed JavaScript BigInt-pointer ABI,
  tick wrapping, membership removal and reset checks. Seventy JS/native tests
  passed before the separate asset-streaming work was integrated.

- Parallel user-requested asset-loading work: implemented opt-in coarse-chunk
  game archive streaming with bundled startup metadata, verified integrity and
  persistent caching. An isolated optimized engine reached playable Zaton after
  2.51 GB of 4.73 GB game data was downloaded; original deployed JS/WASM stayed
  unchanged. See `misc/web/streaming/README.md` for scope and limitations. This
  verifies single-player asset streaming, not multiplayer milestone 2.

- 2026-11-07: Loading work committed separately as `7350233b`. Multiplayer work
  remains outside that commit.
- Dedicated capability-checked engine preview now stages the experimental
  engine with dormant pthread ports and boots with isolated writable state.
  Real Chrome verification: Rust snapshots passed through WebRTC and MessagePort
  into the optimized engine's C++ parser; accepted tick reports advanced. A
  second peer changed C++ membership from 2 to 3 entities, then back to 2 on
  disconnect. No synthetic worker stands in for the engine in this check.
- The bridge-only preview prevents level start before local level allocation or
  prefetch. The production single-player artifact checksums remain unchanged.
  This closes the launcher-to-engine integration checkpoint; map loading, player
  input adaptation, remote actor presentation and two rendered players remain
  required before milestone 2 can be completed.
- Preview guard verification: attempted a new game in Chrome; the engine
  rejected it before prefetch and stayed in the menu while C++ snapshots kept
  advancing. Disconnect verification returned the isolated Rust server to zero
  sessions/players. The extra engine test tab was closed after collecting proof.
- Final validation for this checkpoint: 88 combined JS/native regression tests
  passed; optimized experimental engine build succeeded. Production deployed
  JS/WASM hashes remain unchanged. Follow-up loading/update cache work was
  committed separately as `3f94fd49`; multiplayer changes remain uncommitted.

- 2026-11-07: Zaton rendering gate passed in two actual optimized engine tabs.
  Map-only loading bypasses native server, ALife, quests and actor simulation.
  Render-only proxies use server IDs, idle/walk cycles, position interpolation
  and shortest-path yaw interpolation. WASD crosses the pthread bridge to Rust;
  both clients showed each other's movement. Closing client B removed proxy 12
  in client A, reducing accepted membership from 3 to 2 (including test NPC).
- The map view explicitly retains the synthetic world contract. Client-side
  downward raycasts are visual ground projection, not authoritative collision;
  walls, roofs and multi-storey movement are not yet supported. This passes the
  two-client rendering gate, not the playable survival or movement gates.
- Validation: optimized wasm64 build and 89 JS/native regression tests passed.
  Two clients used separate writable OPFS roots; immutable chunks were shared.
  Evidence: workspace `multiplayer-zaton-two-clients.png`.

- 2026-11-07: Milestone 3 collision prerequisite implemented. The private exporter
  extracts original CFORM v4 geometry with archive patch precedence and a SHA-256
  manifest. Rust validates bytes/counts/bounds/indices before building Parry's BVH;
  ray queries and continuous standing-capsule sweeps retain original coordinates.
- Actual Zaton: 1,096,233 vertices / 1,875,581 triangles / 43,164,128 bytes.
  Optimized import+BVH build took 683 ms; Rust anchor ground Y
  -7.055725 agrees with X-Ray's -7.055702 within 0.03 mm. Thirty batches of
  200 rays + 200 capsule sweeps had median 0.895 ms, p95 1.123 ms, max 1.237 ms.
  This measures collision queries only, not complete movement or player capacity.
- Validation: 14 Rust tests and Clippy with warnings denied pass; exporter test
  covers exact bytes, patch override and rejected compressed/truncated input.
  Geometry tests cover corruption, invalid indices/counts/vertices, separate
  bridge/ground heights, and swept-capsule thin-wall tunnelling prevention.
- Next: import game-material flags (flPassable/flActorObstacle) before using
  geometry for character collision; add slope/step/slide/gravity response,
  validated spawns and a pinned Zaton session contract. Then connect server Y to
  the presenter and implement prediction/reconciliation. The running browser
  preview still deliberately uses the synthetic world. Single player unchanged.

- 2026-11-07: Imported SHA-256-pinned gamemtl.xr and resolved CFORM material IDs
  using the native GameMtlLib/Level_load layout. Actor geometry excludes passable
  surfaces while retaining actor obstacles; Zaton has 1,760,614 blocking faces
  versus 1,875,581 raw faces. Unknown/dynamic materials fail closed.
- Added a 30 Hz capsule motor with gravity, bounded sweep/slide, a 45-degree
  walkable threshold, 35 cm auto-step with overhead and landing checks, and
  collision-checked terrain-contact clearance recovery. It is integrated into
  opt-in World::with_collision; validated capsule spawns and stale-input handling
  use this path. Live sessions are not switched yet.
- Real-map regression caught terrain-seam sticking after only 5–8 metres. A
  collision-checked clearance recovery fixed the tested path; the optimized
  300-tick Zaton route now travels 31.6 m without falling through the map. The
  probe requires more than 25 m to prevent that regression returning. This is
  one route, not complete map/controller validation.
- Validation: 21 Rust tests including material precedence, malformed records,
  wall sliding, floor landing, stairs, headroom, high obstacles, input limits,
  validated spawns and geometry-backed World behavior; exporter test and Clippy.
- Next executable integration: negotiate combined geometry/material content
  identity, enable the map-backed server mode and send original world-space Y
  to the presenter. Remove client-side ground projection in that mode. Then
  verify two real engine clients on terrain/stairs/doors before adding client
  prediction/reconciliation, crouch/jump and latency/loss acceptance tests.

- 2026-11-07: Enabled `ZONE_COLLISION_MANIFEST` map sessions, SHA-256-bound
  geometry/material/motor contracts, actual engine-byte verification and original
  authoritative XYZ. Two optimized engine clients rendered server-driven terrain
  movement. Synthetic mode remains available; production single-player unchanged.
- Added a preloaded wasm32 sidecar compiling the exact Rust collision/material/
  movement modules. It reuses the verified engine assets, resets to server state
  and replays at most eight unacknowledged inputs. Stale/backlogged states fall
  back to authority. Native/WASM 300-tick Zaton parity is exact; deterministic
  loss/delay/reordering tests reconcile exactly but are not live WAN tests.
- Added grounded jump-edge handling, 1.2 m crouch, blocked-stand clearance and
  stance flags/animations. Live browser confirmed crouch pose, jump/landing and
  movement with prediction ready. Synthetic curb/ceiling tests caught a support
  edge-normal bug; support now uses original face normals. Dynamic collision and
  complete game movement semantics remain unimplemented.
- Wire v2 now uses acknowledged deltas, centimetre remote transforms, full-f32
  local motor state, atomic chunk assembly, repeated membership removals until
  ACK, and bounded keyframe recovery. Sixteen ACK candidates and 32 client
  baselines are retained. Rust-produced packets are decoded in JS tests.
- Removed per-entity encoding allocations with contiguous fixed-size records.
  Crowded 200-player encoding p95 fell from 11.90 to 2.18 ms for the same delta
  workload. Distance tiers (25 m: 15 Hz; 60 m: 5 Hz; farther: 3 Hz) preserve
  immediate health/stance/membership updates. Offline map benchmark with 133 ms
  ACK delay and 10% ACK loss: crowded 14.01 MiB/s, replication p95 3.24 ms;
  spread 4.92 MiB/s, replication p95 2.29 ms. These are payload/CPU measurements,
  not a production capacity claim. All-moving full snapshots previously used
  21.08 / 11.54 MiB/s respectively.
- Revisited pinned Zone AOI and IX-Ray FreeMP sources while implementing this
  slice. Zone reliably sends enter/leave metadata; our transform membership is
  already loss-safe through acknowledged baselines, but richer equipment/model
  metadata still needs a reliable lifecycle channel. FreeMP respawn/item hooks
  remain the reference for presentation lifecycle, not a second authority.

- Moving transport gate: 200 real browser WebRTC clients on the optimized Zaton
  server sustained 60.11 seconds at 30.00 ticks/s. No stale clients (>1 s), skipped
  snapshots, UDP drops, late ticks or movement errors. UDP egress 17.17 MiB/s;
  sampled simulation p95 2.24 ms and replication+transport p95 14.94 ms. This is
  loopback without 200 rendered engines, not Internet or prolonged-soak proof.
- Added per-peer state payload budget 96 KiB/s with 32 KiB burst. Frames are
  charged atomically; budget skips never intentionally send partial chunks or
  establish ACK candidates. AOI is bounded to 512 nearest entities, always
  including the local player, so maximum keyframes fit the burst. Reliable
  metadata batches contain at most 16 changes and defer above 8 KiB queued.
  Ordered metadata revisions are validated atomically in a separate client
  registry; this registry cannot override snapshot membership. Current model
  descriptor is the generic stalker presenter; equipment descriptors are future.
- Validation after replication changes: 100 JS/native/render/storage/exporter
  regressions pass, including actual Rust codec to JS decoding; native Rust
  tests and Clippy pass. Production engine JS/WASM hashes remain unchanged.

- Metadata-enabled load first exposed a freshness failure with 10,115 snapshot
  backpressure skips. Added browser scheduling/queue/resync diagnostics and fixed
  a resync-needed flag surviving successful keyframe recovery. Subsequent moving
  200-peer run passed freshness with zero resync requests, but had 524 skips and
  up to 1.41 s between browser test-loop samples. Root cause of every transient
  stall is not established; do not discard this failed-run evidence.
- Rendered-crowd gate: one actual optimized engine plus 199 moving WebRTC test
  peers sustained 61.5 s at 29.98 Hz. The engine rendered 201 entities (200 players
  + test NPC), received all 201 metadata records and returned to two on teardown.
  No stale clients, UDP drops, late ticks, resync requests or movement errors;
  39 backpressure skips. UDP 17.10 MiB/s; state payload 15.26 MiB/s; sampled p95
  simulation 2.27 ms and replication+transport 15.71 ms. This is one rendered
  engine and loopback traffic, not 200 independent machines or a WAN soak.
- Milestone 5 started: fixed prototype hitscan weapon with authoritative eye
  origin, nearest capsule hit, static-geometry occlusion, ammo, 6-tick fire
  interval, 6-tick rewind limit and current/historical safe-zone checks. Clients
  send aim/tick, never target/position/damage. Legacy target-only melee is disabled
  in map sessions. Native tests cover thin-wall blocking, death, cooldown,
  finite ammunition, nearest targets, invalid inputs, rewind and tick wrapping.
  This is conservative no-penetration hitscan, not CoP ballistic parity.
- The live weapon route caught idle drift before reaching hit assertions: gravity
  projected onto walkable slopes caused 0.63 m of motion over ten seconds with
  no input. A generic slope regression reproduces it. Supported idle capsules
  now discard residual fall rather than converting gravity into downhill motion.
  Shared movement contract and predictor revision bumped to v4.

- PvP lifecycle verified in the optimized engine: server-timed reload with finite
  reserve, death input rejection, delayed respawn, independent corpse identity,
  expiry and safe-spawn protection. Keyboard fire/reload/respawn routes exercised.
  Native whole-skeleton death animation now holds its final pose; the initial
  upright corpse presentation was corrected and visually checked. Revisited
  IX-Ray FreeMP spawn/death hooks and native ActorAnimation/SkeletonAnimated;
  browser visuals remain presentation and Rust remains gameplay authority.
- Added opt-in bounded application delivery impairment (`delay` and `loss` query
  parameters), with independent uplink/downlink queues, unreliable state loss,
  ordered reliable control, queue caps and cleanup. This does not emulate SCTP
  congestion or actual WAN RTT. First browser attempt exposed a DOM timer receiver
  binding issue in the harness; callbacks now invoke browser timers directly.
- Application impairment gate passed in both the standalone two-peer harness
  and optimized rendered engine: 50 ms delay each direction, +/-10 ms jitter,
  10% independently dropped state messages. Hits, cooldown, reload, death,
  respawn, corpse expiry and disconnect cleanup passed. Rendered run dropped
  321/107 uplink/downlink messages for the engine client and 204/58 for its peer;
  neither queue overflowed and neither client requested resync. This is not a
  WAN test or proof of continuous prediction. The HUD now distinguishes motor
  readiness from active prediction / authority fallback, and stale replay counts
  are cleared when reconciliation declines to predict. 41 JS tests pass; native
  and WASM prediction checks and optimized server build pass. Single-player
  production JS/WASM checksums remain unchanged.
- Reference review before persistence: IX-Ray FreeMP's optional SQL path exposes
  ammo/condition/attachments and survival-state fields, but its caller's
  display-name lookup and disconnect-time inventory delete/save sequence are
  not sufficient evidence for our identity or crash-recovery guarantees. Our
  acceptance gate requires stable identities, atomic ownership changes and
  durable replay outcomes, independently validated.

- Scope clarification: prioritize working reusable foundations. Existing gameplay
  scenarios remain integration fixtures; further concrete mechanics are deferred.
  Stable identity/session recovery and durable authoritative state are next,
  followed by generic integration, load/recovery acceptance and operations.

- First persistence foundation slice: opt-in `ZONE_DATABASE`, SQLite schema v1,
  WAL/FULL commits and a dedicated bounded 32-job worker. A browser-generated
  256-bit credential is stored before enrollment; only its hash is retained on
  the server. Stable principal IDs are separate from ephemeral transport/entity
  IDs. Duplicate live sessions are rejected; unknown resume fails closed.
- A principal-scoped 4 KiB test record exercises revision checks and durable
  request/result replay. Updates and outcomes commit atomically; changed payload
  under an existing request ID is rejected. This is not inventory or persistent
  movement. Ledger cap rejects new requests at 10,000 per principal rather than
  discarding deduplication history. Account recovery/revocation, durable client
  command outbox, multi-server leases, ownership transfers, backup/restore and
  persistence-inclusive capacity tests remain open.
- Native validation: eight concurrent writers yield one CAS winner. Abrupt child
  exit preserves committed state/outcome and rolls back an unfinished write.
  42 Rust tests and 45 JS tests pass; Clippy passes and optimized server builds.
  Real browser WebRTC validation passed enrollment, duplicate-session rejection,
  reconnect, commit/replay and stale-revision conflict. A forced server process
  kill and restart preserved the principal, record and original replay result.
- Revisited IX-Ray FreeMP disconnect persistence boundaries and SQLite's official
  WAL/FULL durability documentation. Writes are acknowledged after commit and
  never depend on a clean gameplay disconnect. Mechanics remain test fixtures.
- Optimized rendered-engine integration with `ZONE_DATABASE` also passed on
  Zaton: stable principal handshake, active shared prediction and authenticated
  peer spawn/removal through the C++ registry. The test used a separate loopback
  server/preview and isolated browser slot; its game tab was closed afterward.
  Single-player production JS/WASM checksums remain unchanged.
- Browser enrollment is serialized per slot with Web Locks, preventing two
  first-use tabs from storing/enrolling different credentials for the same slot.
  A concurrent-enrollment regression covers this in addition to server-side
  duplicate-session rejection. This does not add gameplay mechanics.

- Ownership foundation: schema v2 migration preserves v1 identity/record/outcome
  data and adds stable, revisioned entities with one principal owner. Trusted
  provisioning only; no client mint endpoint. Owner-only cursor listings are
  bounded to 100 records. Transfer requests authenticate their sender and commit
  owner/revision/result together; rejected outcomes are durable too. Replay is
  checked before present ownership so a previous sender can recover a lost result.
- Validation: 47 Rust tests and 46 JS tests pass, including competing transfers,
  stale commands after ownership returns, cross-principal authorization, replay
  argument changes, pagination, migration and abrupt-process rollback/recovery.
  Clippy passes. Optimized HTTP integration passed authorization, malformed/spoofed
  fields, concurrent one-winner transfer and owner/outcome recovery after a forced
  server restart. Revisited pinned IX-Ray FreeMP `OnTransferMoney` as a reference
  for server-side sender/recipient validation, not as a persistent transaction model.
- Next foundation work: durable browser command outbox, authoritative policy hooks,
  and mapping persistent entities into the live replication/presentation lifecycle.
  Multi-entity exchanges and container hierarchies remain separate infrastructure
  work. Concrete inventory, trading, loot and survival mechanics remain deferred.

- Browser command recovery implemented: principal-scoped, Web-Lock serialized
  outbox with 32-entry/192-KiB limits. Commands persist before transport; unknown
  outcomes retain their exact request IDs/payloads. Completed outcomes persist
  until explicit consumer acknowledgement. Storage failure, reload, conflicting
  commands and concurrent flushers are covered. Engine startup resumes recovery;
  no concrete mechanic is attached to it.
- Committed ownership changes now invalidate sender/recipient live sessions via
  a bounded broadcast and coalesced reliable control hint. Backpressure retains
  the hint; broadcast lag invalidates all persistent peers; reconnect starts dirty.
  Hints are not state deltas or acknowledgements, and replay may repeat them.
  Revisited pinned Zone AOI's reliable enter/leave signaling as a reference for
  lifecycle reliability while keeping authoritative ownership in SQLite.
- Verification: 47 Rust tests, 50 JS tests and Clippy passed; optimized server built.
  Two real browser WebRTC sessions received post-commit invalidation. The explicit
  browser test lost a reply after a committed transfer, survived forced server
  termination plus page reload, recovered the original result with unchanged
  entity revision, and acknowledged it. The isolated test tab was closed.
- Next: consistent owned-state reconciliation across paginated reads, authoritative
  policy hooks and mapping persistent entity IDs to live scene/replication IDs.
  Persistent actor materialization is not claimed by the notification test.

- Consistent owned-state foundation: schema v3 adds transactional per-principal
  generations. Cursor reads must carry the first page generation; intervening
  changes return conflict without an entity page. Trusted insert/update/delete
  and transfers update generations through triggers, while replay does not.
  Migrations from v1/v2 preserve existing state and outcomes.
- Browser reconciler publishes complete same-generation views only. It bounds
  capacity to 4,096 records / 16 MiB, coalesces invalidations, limits conflict
  retries/deadlines, backs off on errors and audits healthy views every 30 seconds.
  Failed reads retain an explicitly stale last-good view; disconnect aborts and
  clears it. Engine entry binds the reconciler but does not materialize arbitrary
  owned JSON as actors.
- Validation: 49 Rust tests, 56 JS tests and Clippy pass; optimized server built.
  HTTP integration rejected mixed-generation pagination and restarted successfully.
  A real two-peer WebRTC browser fixture with 103 sender-owned records reconciled
  a committed transfer, retaining durable lost-reply recovery. Unit tests cover
  invalidation mid-fetch, malformed pages, bounded retries/capacity, late responses
  after disconnect and periodic refresh timers. Reviewed SQLite isolation and
  reused the snapshot assembler's complete-publication design principle.
- Next foundation boundary: explicit persistent-entity presentation descriptors,
  stable-to-transient ID mapping and live scene replication lifecycle, with
  authoritative policy hooks. No item classes or survival mechanics selected.

- Integrated scene foundation: schema v4 trusted descriptors, stable persistent
  IDs in reliable lifecycle metadata, server-owned world proxies and generic
  principal/session/world policy. Committed ownership changes never speculatively
  alter the scene; missing context can retry the same command, completed commands
  replay across context expiry. Persistent fixtures are noninteractive.
- Two optimized Zaton engines rendered the same persistent fixture. Authorized
  transfer updated both owned views while preserving scene visibility. A 200 m
  descriptor move removed both proxies through AOI; returning it restored one each.
  Server restart preserved principal/owner/persistent ID while rebuilding network
  identity. Unpublish removed both proxies; republish allocated a new network ID.
  The first development-button attempt preceded the 30-second owned-state audit
  after trusted provisioning and correctly reported no owned fixture; retry after
  coherent refresh passed. No silent stale-view assumption was used.
- Operations implemented: bounded persistence metrics, health, canonical-path
  single-server file lock, SIGINT/SIGTERM drain, SQLite online backup and new-path
  restore, administrative provision/publish/unpublish/revoke/rotate, systemd and
  container templates. Optimized isolated smoke tests passed backup integrity,
  overwrite refusal, duplicate-process rejection, old credential rejection,
  rotation preserving principal, graceful exit and restored identity/ownership/
  scene. Ownership concurrency and forced-process-restart replay checks still pass.
- Credential lifecycle review found and closed a queued-offer revocation race:
  authentication returns its database epoch transactionally; simulation admission
  requires the same observed epoch. Revocation/rotation disconnects persistent
  sessions conservatively. Transfers reject revoked recipients.
- Broader static traversal validation: 25 Zaton starts across a 64 x 64 m grid,
  15,000 walk/sprint/jump/crouch ticks and 1,000 native-versus-WASM checkpoints.
  Maximum position difference was zero; grounded/crouched states also matched.
  Native checks observed 9,480 grounded, 5,520 airborne and 3,750 crouched ticks.
  This expands terrain coverage but does not implement dynamic-world interaction
  or claim parity for every stair, door, ladder or water surface.
- Latest native/JS checkpoint: 55 Rust tests, 58 JavaScript/exporter tests, Clippy,
  optimized server and wasm32 predictor build passed. Production single-player
  JS/WASM checksum verification passed. Reference review revisited pinned IX-Ray
  FreeMP sender/recipient validation and Zone reliable AOI-enter signaling;
  authorization, durability and performance still require our own evidence.
- The first persistence-inclusive 200-peer ten-minute loopback run FAILED its
  freshness gate: 600.16 s, 30.000 Hz, zero movement errors/UDP drops/persistence
  rejections, but one 14.60 s browser sample gap made all 200 clients stale.
  It recorded 117,512 backpressure snapshot skips, 13.30 MiB/s UDP and sampled
  p95 simulation/replication 2.39/16.01 ms. Retain this failed result; the server
  maintaining tick rate does not make browser freshness pass.
- Investigation found redundant client decoder allocation: rebuilding a complete
  membership Map after already assembling one, per-record temporary number arrays,
  and decoding superseded datagrams. Removed these allocations while retaining
  immutable acknowledged baselines, finite checks and complete-frame membership.
  Added baseline immutability/non-finite regression checks and bounded browser
  long-task, timer-gap, heap and mutation timing diagnostics. Allocation reduction
  is concrete; the 14.6-second stall's full cause is not yet established.
- Final-server 200-peer spread/reconnect/transfer test passed for 120.18 s at
  29.996 Hz: 2,040 record commits and 2,040 transfers with both owner views
  checked, no stale network clients/rejections/UDP drops/movement errors,
  33 snapshot skips, final visibility range 1–92 entities, 2.36 MiB/s UDP.
  Existing identities resumed with record revision at least 45 after restart.
  Browser long-task maximum 87 ms, timer gap 415 ms, final JS heap 37.7 MiB.
  Up to 24 owned views were transiently marked stale during background audits /
  invalidations; each exercised transfer explicitly awaited and validated both
  coherent views. This spread result does not replace the failed crowded soak.
- Live revocation initially exposed stale client presentation: server sessions
  were removed immediately, but browser ICE did not close promptly. Added a
  five-second authoritative-snapshot silence timeout and history cleanup.
  Regression and real WebRTC revocation tests now pass; old credentials cannot
  resume. This is separate from short prediction fallback during packet loss.

- Linux deployment validation passed: the Dockerfile built from the locked source
  using Rust 1.93.1/Bookworm, and the non-root container passed health, durable
  commit/replay and volume-backed restart with clean exit. The test removed its
  own containers/volume; Docker was restored to its prior stopped state. Systemd
  installation and remote-network behavior still require the target host.
- Snapshot-silence handling also reached the actual engine bridge: a live Zaton
  engine changed to Disconnected following an administrative epoch change.
  The bridge closes and its invalid snapshot path clears native proxy state;
  the development HUD now clears stale actor/health/weapon diagnostics as well.

- Final crowded transfer soak PASSED: 200 moving peers for 600.54 s at 29.998 Hz,
  9,600 record commits and 9,600 transfers, zero stale network clients, late ticks,
  UDP drops, movement errors or persistence rejections. Sampled p95 simulation /
  replication were 3.13 / 15.71 ms, UDP 8.19 MiB/s, 7,569 backpressure snapshot
  skips. Final AOI membership ranged 127–202 entities, so this run is not an
  identical-population throughput comparison with the earlier failed run.
- Final browser diagnostics: maximum long task 246 ms, timer gap 824 ms, longest
  complete loop 4.17 s (mostly awaited mutation/refresh work, with snapshots still
  arriving). Heap samples fluctuated 101–559 MiB and ended at 151 MiB; no monotonic
  growth was observed over this interval. Max age of a completed owned refresh
  was 17.21 s, below the 45-second audit gate. Transient stale markers occurred
  during refresh; every exercised transfer validated both coherent owner views.
- Database audit after both transfer runs retained exactly 220 trusted load
  fixtures and summed their revisions to 11,640, matching all committed transfers.
  No fixture was lost or duplicated. Restarted load identities resumed records at
  revision 55 or higher. The initial failed soak remains under `acceptance/`.
- Limits: these are one-browser, loopback WebRTC load tests, not 200 rendered
  clients or a production-duration/WAN soak. Two real rendered engines separately
  verified the persistent scene path. Actual WAN acceptance and target-host
  deployment require infrastructure not supplied in this session. Dynamic doors,
  platforms, player collision and water behavior remain outside the static motor;
  concrete mechanics are still deferred. Do not mark the entire product complete.

- Final source checkpoint checks: 55 Rust tests, 60 JavaScript/exporter tests,
  Clippy and optimized release build passed. Both final-release HTTP recovery
  suites passed. Production single-player JS/WASM checksums remain unchanged.
  Acceptance browser tabs and isolated test servers were closed; the existing
  game tab/services were preserved. No private assets/databases enter the commit.
