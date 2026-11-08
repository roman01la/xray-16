# Rust multiplayer foundation

Opt-in STALKER CoP browser multiplayer development mode. Rust owns the Zaton
simulation; the optimized browser engine renders map assets and presentation
actors. The existing single-player entry, saves and deployed engine artifacts
remain separate. See [PLAN.md](PLAN.md) for acceptance evidence and outstanding
work, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership boundaries.

This is a prototype, not a complete survival game. It has static-map movement,
shared WASM prediction, replication, a fixed test weapon and a stationary NPC.
Stable development identities and a durable versioned test record are available
when `ZONE_DATABASE` is configured, together with durable ownership, trusted
persistent scene fixtures and operational recovery tools. Inventory mechanics,
active NPC AI, dynamic cover and production account management remain future work.
See [deployment and recovery](deploy/README.md) for the operational baseline.

## Run the synthetic network harness

From the repository root:

```sh
cargo +1.93.1 run --release --locked --manifest-path server/Cargo.toml --bin zone-server
```

Open <http://127.0.0.1:8082/>. Without a collision manifest the server uses the
synthetic flat test world. This harness does not load game assets or an engine.
Its target-only melee action is retained solely for synthetic integration tests;
map sessions reject that command.

## Run the isolated Zaton engine

Extract collision from an owned game installation into a private directory
outside the repository. The exporter honors archive patch precedence and writes
content-addressed geometry, materials and a manifest. Compressed CFORM entries
currently fail explicitly; the tested CoP Zaton archive is uncompressed.

```sh
node server/tools/export-collision.mjs /path/to/cop /private/collision zaton
```

With the existing Emscripten environment configured:

```sh
emcmake cmake --preset web-multiplayer-release
cmake --build --preset web-multiplayer-release --parallel 6
cargo +1.93.1 build --release --locked --target wasm32-unknown-unknown --manifest-path server/prediction/Cargo.toml
cargo +1.93.1 build --release --locked --manifest-path server/Cargo.toml
node misc/web/multiplayer/stage.mjs build/web-multiplayer-release/artifacts ../multiplayer-preview
```

Link your privately prepared immutable streaming pack at
`../multiplayer-preview/pack`, then run these in separate terminals:

```sh
ZONE_COLLISION_MANIFEST=/private/collision/zaton.json \
  ZONE_HTTP_ADDR=127.0.0.1:8087 ZONE_UDP_ADDR=127.0.0.1:50001 \
  ZONE_ORIGIN=http://localhost:8086 ./server/target/release/zone-server

node misc/web/multiplayer/serve-preview.mjs ../multiplayer-preview
```

Open `http://localhost:8086/engine-preview/?stream=/pack/pack.json&map=zaton`.
For a second engine, append `&slot=b`. Each slot has a separate writable OPFS
root, including settings and saves; immutable asset cache entries are shared.
Close extra engine tabs after testing.

Controls include WASD movement, Shift sprint, Space jump, C crouch, J to toggle
first-person view, V for launcher mode, mouse aim in first person, left-click
fire, R reload and Enter respawn.
The development page displays authoritative ammo and action results.
Survival mode uses the original inventory screen and item-backed HUD.

The separately staged `load-test.html` supports anonymous and persistent modes.
It runs 200 moving WebRTC peers for one minute by default; `seconds=600` enables
a ten-minute run and `layout=spread` disperses the population. Persistent runs
resume stable identities, recover durable outboxes, commit records and audit owned
state. `ownership=1` additionally tests transfers using trusted seeded fixtures;
see the deployment runbook. These are single-browser transport load tests. `load-test.html?players=199&existing=1` runs alongside one already-open
engine. `combat-test.html` runs the weapon scenario without rendering; the
engine's **Test combat cycle** button runs the same scenario with rendered
proxies. Start combat tests in the spawn safe zone. These are explicit development
tests, not production launcher flows.

The experimental preset writes only beneath its build tree. The normal
single-player preset and deployed files remain unchanged. Capability metadata
still says `actorAdapter: false`: full native actor/weapon gameplay adaptation
is incomplete. The local build creates a native CActor and original item objects
for inventory presentation, while world actors remain proxies. It does not run
native ALife/server or local actor simulation.

## Simulation and movement

- Fixed 30 Hz authoritative simulation; clients provide input, never positions
  or elapsed time. Expired input becomes neutral while gravity continues.
- Original CFORM v4 and gamemtl.xr bytes are SHA-256 validated. Parry 0.31.1 is
  pinned for BVH, rays and capsule queries. Actor collision interprets
  `!flPassable || flActorObstacle`; unknown/dynamic material references fail.
- Standing/crouched capsules, gravity, bounded slide/step, jump-edge handling,
  stand-up clearance and validated spawns. Walkable idle support does not drift.
- `zaton-static-v1` content identity binds geometry, materials and
  `capsule-motor-v4`. The engine verifies its actual asset bytes before displaying
  actors and uses server XYZ directly.
- A roughly 544 KB wasm32 sidecar compiles the exact server motor modules and
  reuses verified engine bytes. It has a separate memory/BVH from the wasm64
  engine, without another asset download. Local replay is bounded to eight steps;
  stale/backlogged state falls back to authority.

Actual terrain, crouch, jump, landing, mutual movement and despawn have passed
browser checks. Native/WASM route and idle probes match exactly. This is not
complete map/controller acceptance: dynamic doors/props, player collision,
moving platforms, water/hazards, broad stairs/corners and WAN testing remain.

## Replication and transport

`str0m` sans-I/O WebRTC runs in one simulation/network task with one UDP socket.
Axum handles HTTP separately. State channel ID 0 uses protocol `zone-v3`,
`ordered:false`, `maxRetransmits:0`; control ID 2 is ordered/reliable. Both share
SCTP/DTLS/ICE congestion control. No media permission or WebSocket fallback.

A spatial grid selects the nearest 512 entities within 100 m, always including
self. Samples update at 15 Hz within 25 m, 5 Hz within 60 m and 3 Hz farther away.
Local state, new/removing membership, health and stance changes bypass tier delay.
State payload is bounded to 96 KiB/s per peer with a 32 KiB burst. Frames are
charged as a whole before queueing; queue pressure is measured separately.

Only ACKs of retained complete frames establish a delta baseline. Sixteen server
ACK candidates and 32 browser baselines are retained; an old/unknown baseline
recovers through a keyframe. Lost chunks never partially apply membership.
The internal engine bridge receives complete reconstructed frames, with one
in-flight and one latest pending frame, so a paused engine cannot queue a backlog.

Reliable lifecycle batches carry at most 16 ordered kind/model upserts/removals.
They defer under queue pressure and update a separate capped metadata registry;
metadata arrival cannot resurrect an actor absent from complete state membership.
The current model descriptor is the generic stalker presenter.

`/metrics` exposes simulation/replication times, payload/UDP bytes, keyframes,
deltas, state budget skips, queue skips, reliable metadata and shot counters.
A one-minute loopback with one rendered engine plus 199 moving peers sustained
29.98 Hz with no sampled stale clients, UDP drops, late ticks or movement errors.
It had 39 snapshot queue skips, used 17.10 MiB/s UDP and 15.26 MiB/s state payload,
and sampled p95 replication+transport was 15.71 ms. An earlier run failed
freshness; details and recovery evidence remain in PLAN.md. This is not a WAN,
prolonged-soak or 200-independent-machine capacity claim.

## Wire v3

Binary fields are little endian, magic `0x5a58`, version 3. Inputs are 20 bytes:
magic:u16, version:u8, type=1:u8, sequence:u32, x:i16, z:i16, yaw:f32,
flags:u16 (sprint/jump/crouch bits 0/1/2), reserved:u16=0.

Live snapshot type 3 has a 28-byte header: magic/version/type, tick:u32,
self:u32, input-ack:u32, part:u16, parts:u16, count:u16, flags:u16
(bit 0 keyframe), baseline-tick:u32. Variable records:

- Type 0: id:u32 removal (5 bytes including type).
- Type 1: id:u32, xyz:3xi24 centimetres, velocity:3xi16 cm/s, yaw:i16
  scaled by pi/32767, health:u16, kind:u8, flags:u8 (26 bytes).
- Type 2: id:u32, xyz/velocity/yaw:7xf32, health:u16, kind:u8, flags:u8
  (37 bytes). Local state always uses this full precision.

Entity kinds are player=1/NPC=2. Flags encode safe, grounded, crouched and held
jump in bits 0–3. A retained corpse is a dead character with a distinct entity
ID. Every packet is at most 1100 bytes. Type 4 ACK and type 5 resync feedback are
8 bytes: magic/version/type plus tick:u32 (zero for resync). The old full-record
codec is retained for fixtures, not used by live replication.

Signaling `POST /offer` supplies `{version:3,contract,offer:{type:"offer",sdp}}`.
World, content, authority and rates must match exactly. `/world.json` exposes the
selected contract. Every WebRTC message is binary; JSON remains only in HTTPS
APIs and internal structured values. There is no dual-format compatibility path.

Reliable control starts with magic:u16, version:u8, opcode:u8. Client commands
then carry sequence:u32: attack=1 adds target:u32 (12 bytes total); reload=2
and leave=5 are 8 bytes. Respawn=3 adds a 16-byte request ID and life:u32
(28 bytes); fire=4 adds tick:u32, yaw:f32, pitch:f32 (20 bytes).
Inventory_list=6 carries a 16-byte cursor and generation:u64 (32 bytes total;
all-zero cursor starts a view, all-one generation means unspecified).
Inventory_move=7 carries request ID:16 bytes, life:u32, item ID:16 bytes,
revision:u32, action:u8, placement:u8 and source ID:16 bytes (66 bytes total).
Unknown opcodes, extra bytes, wrong versions and nonfinite aim fail closed.
All commands use session sequence protection; inventory mutations and survival
respawn additionally use durable request IDs and recorded transaction outcomes.

Server event opcodes and positional fields are: welcome=16 (version, contract,
playerId, principalId, tickHz, safeZones); ownership_dirty=17 (no fields);
weapon=18 (state); lifecycle=19 (revision, tick, upsert, remove); action_result=20
(sequence, result); inventory_dirty=21 (no fields). Fields use binary tags:
0=null, 1=false, 2=true, 3=u32, 4=f64,
5=UTF-8 string, 6=array, 7=map. Strings and collection counts have u16 lengths;
map keys are length-prefixed UTF-8. Nested field names remain strings, while
common envelope names and action names are replaced by opcodes/positions.
Decoding bounds event size to 16 KiB, nesting to eight, and collection size to
1024; malformed UTF-8, duplicate/prototype map keys and trailing bytes reject the
message. Rust/JS acceptance fixtures exercise both directions with actual codecs.

One UDP socket serves all sessions. An address-to-peer hash map routes established
traffic, revalidated by `Rtc::accepts`; cache misses search sessions (O(N)) for ICE
negotiation or address changes. Each peer owns separate ICE/DTLS/SCTP state and
replication baselines. Outbound datagrams use the same socket with each peer's
address. The simulation/network task is serial, with 30-Hz simulation and a
10-ms WebRTC timer scan; HTTP and persistence work are separate. Dense encounters
still require individual encrypted snapshots for every recipient, not multicast.
The important scaling limits are packet processing/crypto, per-recipient AOI and
delta work, queue pressure and egress, rather than a need for one socket per user.

## Prototype weapon and lifecycle

Server-derived eye origin and nearest historical capsule hit are tested against
a conservative raw static-map ray. Aim timestamps are bounded to six ticks
(200 ms), with both historical and current safe-zone checks. The weapon starts
with 30 rounds and 90 reserve, does 35 damage, permits one shot per six ticks and
reloads over 90 server ticks. Clients cannot specify target, damage or shot origin.

The spawn safe zone is an explicit 10 m sphere around the validated spawn, not
an authored Skadovsk building zone. Respawn requires 90 dead ticks, resets at a
validated server-selected location, retains input sequence ordering and removes
the previous life from rewind. A separate non-lootable corpse expires after
900 ticks. Current corpses use a static death animation, not local ragdoll physics.

These are prototype rules for exercising the authority boundary. There is no
projectile flight, penetration, bone hitbox damage, dynamic cover, loot economy
or persistent equipment. Reconnect/restart identity and generic anti-duplication
are implemented separately below; this build is not a public survival server.

## Configuration and checks

| Variable | Default | Meaning |
|---|---|---|
| `ZONE_HTTP_ADDR` | `127.0.0.1:8082` | HTTP signaling/harness bind |
| `ZONE_UDP_ADDR` | `127.0.0.1:50000` | Shared gameplay socket |
| `ZONE_PUBLIC_ADDR` | UDP bind | Reachable ICE host candidate |
| `ZONE_ORIGIN` | HTTP bind origin | Exact browser Origin accepted |
| `ZONE_DEV_TOKEN` | unset | Dev Bearer gate; required off loopback |
| `ZONE_MAX_PLAYERS` | `200` | Includes pending connections, max 4096 |
| `ZONE_COLLISION_MANIFEST` | unset | Enables pinned Zaton map simulation |
| `ZONE_SPAWN_X`, `ZONE_SPAWN_Z` | `87.599976`, `115` | Validated map spawn |
| `ZONE_SPAWN_Y` | unset | Optional floor-height anchor for map spawn and respawn |

The dev token is not player authentication. Internet deployment still needs
HTTPS/signaling proxy, reachable UDP/TURN, account/session authentication,
admission protection, monitoring and recovery work. Game assets stay private.

```sh
cargo +1.93.1 test --locked --manifest-path server/Cargo.toml
cargo +1.93.1 clippy --locked --manifest-path server/Cargo.toml --all-targets -- -D warnings
node --test misc/web/multiplayer/*.test.mjs
node misc/web/multiplayer/test-engine-abi-wasm.mjs
cargo +1.93.1 run --release --manifest-path server/Cargo.toml --bin idle_probe -- /private/collision/zaton.json
```

Rust 1.93.1 is pinned separately from the engine shader toolchain. Server-embedded
harness files require a rebuild; the isolated preview is staged separately.

## Identity and persistence foundation

Set `ZONE_DATABASE=/private/path/zone.sqlite` to enable durable identities and
records. The parent directory must already exist. Without it, the existing
anonymous development harness remains unchanged; with it, every WebRTC offer
requires an enrolled identity credential. Do not expose this development setup
as a production account service. Non-loopback signaling still requires the
existing development access token; use HTTPS at deployment boundaries.

The engine preview keeps a separate 256-bit random credential per multiplayer
`slot` in origin-local browser storage, written before enrollment so a lost
response can be retried. An exclusive [Web Lock](https://developer.mozilla.org/en-US/docs/Web/API/LockManager/request)
serializes first-use enrollment across tabs for the same slot. The server stores only a domain-separated SHA-256 hash,
assigns a stable principal ID and repeats that ID in the private welcome.
Transport entity IDs remain ephemeral. A second active connection for the same
principal is rejected, including during negotiation; a dropped connection must
expire (currently up to 20 seconds) before resuming. This is explicit rejection,
not automatic takeover. Losing browser storage loses this development credential;
account recovery and multi-server leases are not implemented. Trusted administrative
rotation/revocation is available; the durable authorization epoch invalidates live
sessions and stale queued admissions. Unknown resume credentials never silently create a new identity.

The pinned `rusqlite` 0.41.1 binding (bundled SQLite) runs on a dedicated
thread with a 32-job queue. WAL + FULL synchronous commits precede successful
mutation responses. Schema version 4 includes per-principal ownership generations,
trusted scene descriptors and credential lifecycle state. Earlier supported
versions migrate transactionally without changing identities,
entities, records or replay outcomes. Newer
unknown versions fail startup. No disk work is added to the simulation tick.
The database and its WAL/SHM sidecars are private runtime data, never game assets.

The authenticated `/identity/state` endpoint exposes one bounded 4 KiB JSON test
record per principal, **not gameplay state or an inventory API**. Writes supply
`requestId`, `expectedRevision` and `value`. One transaction changes the record
and retains its result. Replays return that original result; changed payloads
under an existing ID are rejected. Stale revisions produce durable conflicts.
Callers must retain the original request ID/payload when a response is lost;
a timeout means outcome unknown. The prototype caps its ledger at 10,000 requests
per principal and rejects further new requests rather than silently forgetting
replay protection. Ledger compaction remains future work; browser recovery uses the bounded
outbox described below.

Open `/identity-test.html` on the Rust server to exercise real WebRTC enrollment,
duplicate-session rejection, reconnect, a durable mutation, replay and conflict.
Restart the server with the same database and use **Verify stored record after
restart**. Tests use an isolated browser credential and generic record. Core tests
also race eight SQLite connections and abruptly terminate a child process with
both committed and uncommitted work before reopening its database.

SQLite durability follows its documented [WAL and synchronous behavior](https://www.sqlite.org/wal.html).
IX-Ray's persistence hooks informed state-boundary review below; this foundation
uses explicit transaction outcomes rather than disconnect-only saves.

## Durable entity ownership

The durable schema provides generic entities with server-assigned stable IDs, one principal
owner, a revision and an immutable bounded JSON payload. Trusted server code can
provision them through `Database::provision_entity`; no client mint or payload
editing endpoint exists. These records do not yet instantiate scene actors.

- `GET /identity/entities` returns only the credential holder's entities, up to
  100 per page, with `generation` and `nextCursor`. Subsequent pages must send
  `?after=<id>&generation=<first-generation>`. Any intervening ownership/data
  change returns a conflict with no partial entity page; restart from page one.
  Schema triggers update both owners' generations in the same transaction as a
  transfer, and also cover trusted inserts, updates and deletes. Replaying a
  previously committed command does not advance the generation.
- `POST /identity/transfer` accepts `requestId`, `entityId`, `expectedRevision`,
  and `recipient` (a stable principal ID). The authenticated principal must own
  the entity at that revision; the recipient must exist and differ from the owner.
  Sender identity cannot be supplied in the body.
- The owner change, revision increment and request outcome share one transaction.
  Both success and rejection/conflict outcomes are retained. An old sender can
  replay its successful command after losing ownership and receive the original
  response without moving the entity again. Reusing the ID with changed arguments
  fails. A new command with a stale revision fails even if ownership has since
  returned to the original sender. The request ledger is shared with test-record
  writes, including its cap; IDs cannot be reused across operation types.

These are foundation operations, not trading or loot rules. Scene-bound transfers
require a live server-issued principal/session/world context and unchanged durable
ownership/revision. Additional mechanics-specific policy, container hierarchies
and multi-entity exchanges remain future work. No item classes, equipment slots,
prices, loot tables or gifting UX are selected here.

`identity.mjs` exports `listEntities` and `transferEntity` for the browser adapter.
As with test-record writes, retain command IDs and payloads across uncertain
outcomes. Do not treat an HTTP success alone as a committed transfer: inspect
its `status`, which can also be `rejected`.

Run native concurrency/migration/crash tests with `cargo +1.93.1 test --manifest-path
server/Cargo.toml`. After an optimized build, `python3 server/tools/ownership-smoke.py`
starts an isolated synthetic server, seeds only a disposable fixture database,
checks authorization and competing transfers through HTTP, forcibly restarts its
own process and checks owner/outcome recovery. It stops its server on completion.

## Durable browser command recovery and live invalidation

`outbox.mjs` persists record/transfer commands before sending them. Each principal
has an isolated localStorage record protected across tabs by an exclusive Web
Lock. The queue is bounded to 32 entries / 192 KiB, including completed results.
Quota/parse errors fail closed; pending work is never silently evicted. Credentials
are not copied into the outbox. Browser storage deletion loses pending commands;
this is reload recovery, not a guarantee against browser storage eviction.

`DurableOutbox.enqueue(kind, command)` saves an immutable JSON copy and assigns a
request ID once if absent. `flush()` sends saved requests verbatim, retains unknown
outcomes after errors, and persists committed/conflict/rejection results. Reload
creates a new instance for the same principal and retries the same IDs. Two tabs
serialize each send/result write. A response lost after server commit therefore
recovers the original outcome instead of executing a second mutation.

`entries()` exposes pending/completed work. The consumer must handle a saved result
before calling `acknowledge(requestId)`; unresolved requests cannot be forgotten
through that API. Completed entries are not automatically discarded. Conflicts
require a newly evaluated command and a new ID, not mutation of saved arguments.
The identity-enabled engine entry resumes its outbox on connect and logs recovered
outcomes, retaining them for the eventual gameplay consumer. No mechanic submits
commands automatically.

Committed transfers also publish a bounded worker-to-simulation invalidation for
the sender and recipient. The simulation coalesces each peer to one pending hint
and sends `ownership_dirty` through its reliable control channel, retrying under
backpressure. Broadcast overflow invalidates every connected persistent peer;
new connections always start dirty. The browser emits `ownership-invalidated`
and advances a local `ownershipVersion`. These are refresh hints, not entity deltas
or durable mutation acknowledgements. Consumers still query authenticated owned
state; the owned-state reconciler below performs those reads. Successful replay may repeat a hint safely. Trusted offline provisioning
is seen on reconnect/read; it does not yet publish a live event.

The `/outbox-test.html` fixture verifies a committed transfer with a deliberately
lost client response, notifications on both real WebRTC sessions, page/server
restart, recovery without a second revision increment, and explicit result
acknowledgement. It needs two prepared test identities and one entity provisioned
by trusted server test setup for the displayed principal A; it exposes no mint API.

## Consistent owned-state reconciliation

`owned-state.mjs` fetches all pages at one ownership generation and publishes a
single complete replacement. A conflict, generation mismatch, malformed cursor,
invalidation during a fetch or capacity violation cannot publish partial state.
The previous complete view remains explicitly stale on errors. Consumers receive
`snapshot`, `stale` and `cleared` events and can obtain a copied view with
`snapshot()`. These events do not authorize gameplay commands.

The default limit is 4,096 records / 16 MiB. Refresh uses a single in-flight task,
up to three conflict restarts, ten-second deadlines per attempt and exponential
retry from one to ten seconds. Healthy sessions also audit every 30 seconds to
recover from missed hints or trusted offline provisioning. Disconnect aborts the
fetch, cancels timers and clears the view; a late response cannot restore it.

The identity-enabled engine entry binds this view to the live session. It exposes
`client.ownedState` and logs completed generations, but does not create scene actors
from generic JSON payloads. Explicit trusted scene descriptors map stable IDs to
server-owned transient actors; the snapshot/AOI lifecycle controls rendering.

This follows the same complete-state publication principle as the existing
snapshot assembler. Each database page has its own transaction; generation checks
bridge those transactions without holding one database snapshot open across HTTP
requests. See SQLite's [isolation documentation](https://www.sqlite.org/isolation.html).

## Delivery impairment tests

The separate combat test and engine preview accept `&delay=50&loss=.1` (or
`?delay=50&loss=.1` without other query parameters). This adds 50 ms of application
queue delay in each direction, up to 10 ms jitter, and independently drops 10%
of unreliable state messages. Reliable control stays ordered and is never
randomly dropped. Each direction caps pending data at 128 messages / 128 KiB;
disconnect clears its timer and backlog. Defaults create no impairment queues.

This exercises application reconciliation and combat under delayed delivery,
not actual WAN RTT, ICE behavior or SCTP congestion. The test log records queue
loss/overflow counters. Keep real WAN and prolonged soak gates open.

## Inventory mechanics backend

`src/inventory.rs` adds schema v7 durable item/container transactions to the bounded
SQLite worker. Binary WebRTC commands expose inventory paging, pickup/drop/equip
and durable respawn when `ZONE_ITEM_CATALOG` enables survival mode. Death is an
internal simulation operation. Session identity, authorization epoch, life and
position are validated at commit; clients cannot mint items or supply item state.
Original catalog definitions govern equipment and per-instance state. The browser
adapter journals commands before sending and reconciles coherent inventory pages.

`ZONE_SURVIVAL_RULES` selects configurable development defaults, including the
per-life starter kit, respawn delay and corpse/drop expiry. Loot refill and logout
policy fields are defined but their simulation enforcement is still pending.
The complete actor-backed inventory UI acceptance remains an integration gate. These local
mechanics changes have not been deployed.

`inventory-abi.mjs` and `multiplayer/InventoryState.h` connect coherent inventory
views to the application pthread. Native state includes stable IDs/revisions,
placement, condition, upgrades, cartridge order, launcher cartridges, attachments
and remaining consumable/ammo quantities. Whole-view validation precedes atomic
replacement; malformed or older views cannot partially change native state.
Worker intents carry the displayed life and item revision, then enter the same
durable journal as other inventory actions. The bridge retains one in-flight view
plus the latest replacement when rendering pauses. This store does not itself
spawn native actors/items. `InventoryPresentation` now supplies that binding,
retaining original item factories and menu UI without starting local gameplay.
Browser verification covers menu opening, one server-authoritative Drop,
reconnect, rifle equip, drag between weapon slots and return to the rucksack;
real-map pickup, outfit/belt interactions, batch drops, corpse/storage search and complete
weapon state remain open. Pending journaled commands retry after lost replies
with capped exponential backoff; session closure cancels retries.

Two real browser WebRTC clients passed pickup contention, equip/drop/re-loot,
full-loss death, reconnect and respawn on the optimized server. Restart verification
preserved both identities, life counters and exact item state. Evidence:
[`inventory-transport.png`](acceptance/inventory-transport.png),
[`inventory-restart.png`](acceptance/inventory-restart.png), and
[`inventory-transport-metrics.json`](acceptance/inventory-transport-metrics.json).
This is transport/persistence acceptance, not original game UI or capacity acceptance.

See [MECHANICS.md](MECHANICS.md#implementation-checkpoint--2026-11-08) for the
implemented boundary and remaining playable acceptance. Run its transaction suite:

```sh
cargo +1.93.1 test --locked --manifest-path server/Cargo.toml --test inventory
cargo +1.93.1 test --release --locked --manifest-path server/Cargo.toml --test inventory
```

## Community references and decisions

Sources reviewed on 2026-11-07, pinned to exact revisions:

- [IX-Ray FreeMP](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/FreeMP/game_sv_freemp.cpp):
  connect/spawn, `RespawnPlayer`, `SpawnItemToActor` and death/time hooks guide
  lifecycle boundaries. Our Rust server owns those decisions; native gameplay
  authority is not imported into browser presentation. Revisited its optional
  SQL disconnect/restore path before milestone 6: condition, ammo, attachments
  and survival stats are useful persistence fields. Display-name lookup and a
  disconnect-time sequence of inventory delete/save calls are not our identity
  or crash-recovery contract. The caller alone does not establish transaction
  guarantees in its DB service. Revisited `OnTransferMoney`: server-side sender,
  recipient and available-balance checks guide authorization boundaries. Our
  generic ownership transfers commit owner/revision/outcome atomically, verified
  independently with concurrency and crash/replay tests; no economy is imported.
  Revisited `OnPlayerDisconnect` at the same revision on 2026-11-08 for the
  inventory boundary: retain explicit per-instance condition, ammunition and
  attachment state. Reject its PDA/bolt/binocular/backpack exclusions for this
  game's full-loss rule. Our death transaction moves every carried placement;
  tests cover equipped/belt items, private storage, retry after looting and
  all-or-nothing rollback. The reference's disconnect-time delete/save loop is
  not adopted. Original catalog, equip/use behaviour and engine UI acceptance
  remain pending; preserving fields is not proof of gameplay equivalence.
- [IX-Ray FreeMP client](https://github.com/ixray-team/ixray-1.6-stcop/blob/f1188825e86774a488489f043f8aeee9ca4fbfb2/src/xrGame/FreeMP/game_cl_freemp.cpp),
  revisited on 2026-11-08: `createGameUI`/`SetGameUI` retain a native game UI;
  `TranslateGameMessage` resolves a native item from the object registry before
  updating its actor menu. Retain that actor/item-backed presentation boundary.
  Our worker bridge supplies Rust-owned coherent state and durable intents;
  importing the native server's authority or replacing the inventory with HTML
  is not part of the implementation. The native actor/menu binding now opens the
  original screen and routes a single-item Drop; broader UI acceptance is open.
- [Zone authority](https://github.com/AnarchadiaMC/Zone/blob/1eb99802b41e525f3896d710dee881f67c7e8fa9/docs/AUTHORITY_MODEL.md),
  [AOI](https://github.com/AnarchadiaMC/Zone/blob/1eb99802b41e525f3896d710dee881f67c7e8fa9/zone-server/internal/game/aoi_manager.go),
  [safe zones](https://github.com/AnarchadiaMC/Zone/blob/1eb99802b41e525f3896d710dee881f67c7e8fa9/zone-server/internal/game/safezone.go):
  adopted reliable enter/leave metadata separation and spatial filtering;
  rejected client-owned transforms and unverified Anomaly coordinates.
- Native engine sources `GameMtlLib`, `PHSimpleCharacterInline`,
  `PHActorCharacter`, `ActorAnimation`, `Actor_Network` and
  `Level_Bullet_Manager` guide material interpretation, capsule behavior,
  death poses and static/dynamic ray boundaries. The prototype hitscan rules
  are not claimed to reproduce native CoP ballistics.

These references are implementation guidance, not proof of this port's capacity.
Revisit and record the relevant implementation when adding each subsystem.

### Persistent scene and operations boundary

See [deployment and recovery](deploy/README.md) for schema v4/v5 administration,
backups, shutdown, credential lifecycle, bounded worker metrics and deployment
configuration. Mechanics databases use schema v7; deployed databases remain on
their deployed image's schema until an explicit upgrade. Stable entity IDs are replicated as reliable lifecycle metadata;
trusted scene descriptors materialize authoritative, noninteractive proxy actors.
Ownership stays private and independent of spatial visibility.

At this boundary we revisited the pinned IX-Ray FreeMP `OnTransferMoney` sender /
recipient checks and Zone's reliable AOI-enter implementation above. We retain
simulation-issued session/world authorization and reliable descriptor lifecycle,
but add transactional revision/replay checks and snapshot-authoritative presence.
Neither reference establishes crash safety or capacity for this implementation;
those remain local acceptance gates. The policy context has a bounded two-second
issuance-to-commit window; disconnect is not a cancellation of accepted work.
